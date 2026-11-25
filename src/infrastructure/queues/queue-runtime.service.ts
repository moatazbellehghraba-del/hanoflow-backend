import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { OwnedRedis } from './owned-redis.js';
import { queueConnectionOptions, workerQueueOptions } from './queue.config.js';
import {
  QUEUE_PRODUCER_BUDGET_MS,
  QUEUE_SHUTDOWN_BUDGET_MS,
  QUEUE_SHUTDOWN_CLEANUP_MS,
  validateQueueName,
  validateJobName,
} from './queue.constants.js';

export interface QueueJobMetadata {
  requestId: string;
}

export interface QueueProcessor<Data, Result, Name extends string> {
  process(job: Job<Data, Result, Name>, signal: AbortSignal): Promise<Result>;
}

interface QueueResource {
  name: string;
  close(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

interface WorkerResource {
  start(): void;
  pause(): Promise<void>;
  close(): Promise<void>;
  abort(): void;
  active: Set<string>;
}

@Injectable()
export class QueueRuntime implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(QueueRuntime.name);
  private readonly clients = new Set<Redis>();
  private readonly producers = new Map<string, Redis>();
  private readonly queues: QueueResource[] = [];
  private readonly workers: WorkerResource[] = [];
  private readonly idleListeners = new Set<() => void>();
  private started = false;
  private closing = false;
  private shutdown: Promise<void> | undefined;

  constructor(private readonly config: ConfigService) {}

  createProducerConnection(name: string): Redis {
    validateQueueName(name);
    if (this.closing || this.producers.has(name))
      throw new Error('Queue registration unavailable');
    const client = this.createConnection('producer', name);
    this.producers.set(name, client);
    return client;
  }

  registerQueue(queue: QueueResource): void {
    if (this.closing) throw new Error('Queue registration unavailable');
    queue.on('error', this.errorListener('queue', queue.name));
    this.queues.push(queue);
  }

  registerWorker<Data, Result, Name extends string>(
    name: string,
    processor: QueueProcessor<Data, Result, Name>,
  ): Worker<Data, Result, Name> {
    validateQueueName(name);
    if (this.closing) throw new Error('Queue registration unavailable');
    const controller = new AbortController();
    const active = new Set<string>();
    const startedAt = new Map<string, number>();
    const worker = new Worker<Data, Result, Name>(
      name,
      (job) => processor.process(job, controller.signal),
      {
        ...workerQueueOptions(this.config),
        connection: this.createConnection('worker', name),
      },
    );
    worker.on('error', this.errorListener('worker', name));
    worker.on('active', (job) => {
      active.add(job.id ?? '');
      startedAt.set(job.id ?? '', Date.now());
    });
    const finished = (
      job: Job<Data, Result, Name> | undefined,
      outcome: 'completed' | 'failed',
    ) => {
      active.delete(job?.id ?? '');
      const start = startedAt.get(job?.id ?? '');
      startedAt.delete(job?.id ?? '');
      this.logger.log({
        event: 'queue_job_' + outcome,
        queue: name,
        ...(start === undefined
          ? {}
          : { durationMs: Math.max(0, Date.now() - start) }),
        ...this.safeJobMetadata(job),
      });
      for (const notify of this.idleListeners) notify();
    };
    worker.on('completed', (job) => finished(job, 'completed'));
    worker.on('failed', (job) => finished(job, 'failed'));
    const resource: WorkerResource = {
      active,
      start: () => {
        void worker.run().catch(this.errorListener('worker_run', name));
      },
      pause: () => worker.pause(true),
      // Drain is managed before close. Never start close(false), then attempt to
      // upgrade it to close(true): BullMQ memoizes the first close promise.
      close: () => worker.close(true),
      abort: () => controller.abort(),
    };
    this.workers.push(resource);
    if (this.started) resource.start();
    return worker;
  }

  async publish<T>(
    queue: string,
    job: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    validateQueueName(queue);
    validateJobName(job);
    const client = this.producers.get(queue);
    if (this.closing || client?.status !== 'ready')
      throw new Error('Queue unavailable');
    try {
      return await this.withDeadline(operation(), QUEUE_PRODUCER_BUDGET_MS);
    } catch {
      this.logger.warn({ event: 'queue_publish_unavailable', queue });
      // A timeout may have an ambiguous outcome. Callers need stable job IDs and
      // idempotent handling; never claim cancellation or exactly-once delivery.
      throw new Error('Queue unavailable');
    }
  }

  onApplicationBootstrap(): void {
    this.started = true;
    for (const worker of this.workers) worker.start();
  }

  onModuleDestroy(): Promise<void> {
    return this.close();
  }

  close(): Promise<void> {
    this.shutdown ??= this.shutdownResources();
    return this.shutdown;
  }

  private async shutdownResources(): Promise<void> {
    this.closing = true;
    // Reserve the last second for terminating resources. One deadline covers
    // all workers/queues, rather than allowing 30s per resource.
    const deadline = Date.now() + QUEUE_SHUTDOWN_BUDGET_MS;
    try {
      await this.withDeadline(
        (async () => {
          await Promise.all(this.workers.map((worker) => worker.pause()));
          await this.whenIdle();
        })(),
        QUEUE_SHUTDOWN_BUDGET_MS - QUEUE_SHUTDOWN_CLEANUP_MS,
      );
    } catch {
      this.logger.warn({ event: 'queue_shutdown_drain_deadline' });
    }
    try {
      await this.withDeadline(
        (async () => {
          const workers = await Promise.allSettled(
            this.workers.map((worker) => worker.close()),
          );
          const queues = await Promise.allSettled(
            this.queues.map((queue) => queue.close()),
          );
          if (
            [...workers, ...queues].some(
              (result) => result.status === 'rejected',
            )
          ) {
            this.logger.warn({ event: 'queue_shutdown_resource_failure' });
          }
        })(),
        Math.max(1, deadline - Date.now()),
      );
    } catch {
      this.logger.warn({ event: 'queue_shutdown_cleanup_deadline' });
    } finally {
      // Abort cooperative processors and forcibly disconnect every owned client,
      // including blocking duplicates. This is effective cleanup, not just a
      // timeout around a still-reconnecting driver. JavaScript cannot terminate
      // arbitrary non-cooperative user code; future handlers must honor signal.
      for (const worker of this.workers) worker.abort();
      for (const client of this.clients) client.disconnect();
      this.idleListeners.clear();
    }
  }

  private whenIdle(): Promise<void> {
    if (this.workers.every((worker) => worker.active.size === 0))
      return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.workers.every((worker) => worker.active.size === 0)) {
          this.idleListeners.delete(check);
          resolve();
        }
      };
      this.idleListeners.add(check);
      check();
    });
  }

  private createConnection(role: 'producer' | 'worker', queue: string): Redis {
    return new OwnedRedis(
      queueConnectionOptions(this.config, role),
      (client) => {
        this.clients.add(client);
        client.on('error', this.errorListener('redis_' + role, queue));
        if (this.closing) {
          client.disconnect();
        } else if (client.status === 'wait') {
          // Start only after our error listener is attached, before handing the
          // client to BullMQ. Its lazy-client path caches connect()'s first
          // rejection forever; the already-connecting path instead waits across
          // reconnects for ready/end. Do not await this attempt during startup.
          void client
            .connect()
            .catch(this.errorListener('redis_' + role, queue));
        }
      },
    );
  }

  private errorListener(
    resource: string,
    queue: string,
  ): (_error: unknown) => void {
    return () => {
      if (!this.closing)
        this.logger.warn({
          event: 'queue_resource_unavailable',
          resource,
          queue,
        });
    };
  }

  private safeJobMetadata(
    job: Job<unknown, unknown, string> | undefined,
  ): Record<string, string | number> {
    const metadata: Record<string, string | number> = {};
    if (!job) return metadata;
    if (job.id && /^[a-zA-Z0-9_-]{1,128}$/.test(job.id))
      metadata.jobId = job.id;
    if (/^[a-z][a-z0-9-]*\.v[1-9]\d*$/.test(job.name))
      metadata.operation = job.name;
    metadata.attempt = job.attemptsMade;
    const data: unknown = job.data;
    if (
      typeof data === 'object' &&
      data !== null &&
      'requestId' in data &&
      typeof data.requestId === 'string' &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(data.requestId)
    ) {
      metadata.requestId = data.requestId;
    }
    return metadata;
  }

  private async withDeadline<T>(
    operation: Promise<T>,
    budget: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Queue deadline exceeded')),
            budget,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
