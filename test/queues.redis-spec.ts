import 'reflect-metadata';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from '../src/app.module.js';
import { setupApplication } from '../src/config/setup-application.js';
import { validateEnvironment } from '../src/config/environment.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { QueueRuntime } from '../src/infrastructure/queues/queue-runtime.service.js';
import { InfrastructureQueueModule } from './fixtures/infrastructure-queue.module.js';
import {
  InfrastructureProcessor,
  INFRASTRUCTURE_QUEUE,
  INFRASTRUCTURE_JOB,
  type InfrastructurePayload,
  type InfrastructureResult,
} from './fixtures/infrastructure.processor.js';
import {
  getRedisTestTarget,
  verifyRedisTestIdentity,
} from './helpers/redis-target.js';

@Module({ imports: [AppModule, InfrastructureQueueModule] })
class RedisApplicationFixture {}

type TestJob = Job<
  InfrastructurePayload,
  InfrastructureResult,
  typeof INFRASTRUCTURE_JOB
>;
type TestQueue = Queue<
  InfrastructurePayload,
  InfrastructureResult,
  typeof INFRASTRUCTURE_JOB
>;
type TestWorker = Worker<
  InfrastructurePayload,
  InfrastructureResult,
  typeof INFRASTRUCTURE_JOB
>;
interface Context {
  app: INestApplication;
  queue: TestQueue;
  worker: TestWorker;
  runtime: QueueRuntime;
  processor: InfrastructureProcessor;
  prefix: string;
  closed: boolean;
}

describe('isolated real Redis and BullMQ foundation (no Redis mocks)', () => {
  const target = getRedisTestTarget(process.env);
  const runId = randomUUID().slice(0, 8);
  const exec = promisify(execFile);
  const admin = new Redis({
    host: '127.0.0.1',
    port: 6381,
    db: 0,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: 1000,
    connectTimeout: 2000,
    retryStrategy: () => 100,
  });
  admin.on('error', () => undefined);
  let containerId: string | undefined;
  let contexts: Context[] = [];
  const prefixes = new Set<string>();

  async function lifecycle(
    action: 'inspect' | 'stop' | 'start' | 'restart',
  ): Promise<void> {
    const result = await exec(
      process.execPath,
      ['scripts/redis-test.mjs', action],
      {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 50000,
        env: {
          ...process.env,
          TEST_REDIS_URL: target.url,
          TEST_REDIS_INSTANCE_ID: target.instanceId,
          ...(containerId ? { TEST_REDIS_CONTAINER_ID: containerId } : {}),
        },
      },
    );
    const value: unknown = JSON.parse(result.stdout.trim());
    if (
      typeof value !== 'object' ||
      value === null ||
      !('containerId' in value) ||
      typeof value.containerId !== 'string'
    )
      throw new Error('Invalid verified lifecycle response');
    if (containerId && value.containerId !== containerId)
      throw new Error('Test container changed');
    containerId = value.containerId;
  }

  async function until(
    label: string,
    probe: () => boolean | Promise<boolean>,
    budget = 15000,
  ): Promise<void> {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const observed = await Promise.race([
          Promise.resolve().then(probe),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Probe deadline')),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
        if (observed) return;
      } catch {
        /* Transient outage/state transition only. */
      } finally {
        clearTimeout(timer);
      }
      await delay(25);
    }
    throw new Error('Timed out waiting for ' + label);
  }

  async function identity(): Promise<void> {
    await until('test Redis connection', () => admin.status === 'ready');
    await verifyRedisTestIdentity(admin, target);
  }

  async function createApp(): Promise<Context> {
    // Marker verification occurred before any container outage and is repeated
    // before each test. No queue is ever constructed for an unverified target.
    const prefix = `hanoflow-test-${runId}-${randomUUID()}`;
    prefixes.add(prefix);
    const config = new ConfigService(
      validateEnvironment({
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: target.url,
        QUEUE_PREFIX: prefix,
      }),
    );
    const runtime = new QueueRuntime(config);
    try {
      const module = await Test.createTestingModule({
        imports: [RedisApplicationFixture],
      })
        .overrideProvider(ConfigService)
        .useValue(config)
        .overrideProvider(QueueRuntime)
        .useValue(runtime)
        // PostgreSQL remains covered by its separate real four-test suite.
        .overrideProvider(PrismaService)
        .useValue({
          verifyIdentity: () => Promise.resolve(),
          $queryRaw: jest
            .fn<() => Promise<unknown>>()
            .mockResolvedValue([{ value: 1 }]),
        })
        .compile();
      const app = module.createNestApplication({ logger: false });
      setupApplication(app);
      const context: Context = {
        app,
        runtime,
        prefix,
        closed: false,
        queue: module.get<TestQueue>(getQueueToken(INFRASTRUCTURE_QUEUE)),
        worker: module.get<TestWorker>(
          `HanoFlowWorker:${INFRASTRUCTURE_QUEUE}`,
        ),
        processor: module.get(InfrastructureProcessor),
      };
      contexts.push(context);
      await app.init();
      return context;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  async function ready(ctx: Context): Promise<void> {
    await until(
      'application readiness',
      async () =>
        (
          await request(ctx.app.getHttpServer() as Server)
            .get('/api/v1/health/ready')
            .timeout(4000)
        ).status === 200,
    );
    await until('queue readiness', async () => {
      const client = await ctx.queue.getBackend().connection.client;
      return client.status === 'ready';
    });
  }
  async function publish(
    ctx: Context,
    data: Partial<InfrastructurePayload> = {},
    jobId = randomUUID(),
  ): Promise<TestJob> {
    return ctx.runtime.publish(INFRASTRUCTURE_QUEUE, INFRASTRUCTURE_JOB, () =>
      ctx.queue.add(
        INFRASTRUCTURE_JOB,
        { nonce: randomUUID(), requestId: randomUUID(), ...data },
        { jobId },
      ),
    );
  }
  async function completed(job: TestJob): Promise<void> {
    await until(
      'completed job',
      async () => (await job.getState()) === 'completed',
    );
  }
  async function names(): Promise<string[]> {
    const result: unknown = await admin.client('LIST');
    if (typeof result !== 'string')
      throw new Error('Unexpected Redis client inventory');
    return result.trim().split('\n').filter(Boolean);
  }
  async function clean(prefix: string): Promise<void> {
    await identity();
    if (!prefixes.has(prefix) || !prefix.startsWith(`hanoflow-test-${runId}-`))
      throw new Error('Refusing unrelated queue cleanup');
    let cursor = '0';
    do {
      const [next, keys] = await admin.scan(
        cursor,
        'MATCH',
        prefix + ':*',
        'COUNT',
        100,
      );
      if (keys.some((key) => !key.startsWith(prefix + ':')))
        throw new Error('Refusing unrelated key cleanup');
      if (keys.length) await admin.unlink(...keys);
      cursor = next;
    } while (cursor !== '0');
  }

  beforeAll(async () => {
    await admin.connect();
    await identity();
    await lifecycle('inspect');
  });
  beforeEach(async () => {
    contexts = [];
    await identity();
  });
  afterEach(async () => {
    // Recovery occurs before teardown, and only the verified isolated container
    // can be touched. Failed assertions must not leave Redis stopped or gates held.
    await lifecycle('start');
    await identity();
    for (const ctx of contexts) {
      ctx.processor.releaseAll();
      if (!ctx.closed) {
        await ctx.app.close();
        ctx.closed = true;
      }
      await clean(ctx.prefix);
    }
    await until(
      'all application clients disconnected',
      async () => (await names()).length === 1,
      5000,
    );
    for (const prefix of contexts.map((ctx) => ctx.prefix)) {
      const [, keys] = await admin.scan(
        '0',
        'MATCH',
        prefix + ':*',
        'COUNT',
        1000,
      );
      expect(keys).toHaveLength(0);
    }
  });
  afterAll(() => {
    admin.disconnect();
  });

  it('connects only to the marked instance with expected durability and memory settings', async () => {
    await expect(
      verifyRedisTestIdentity(admin, {
        ...target,
        marker: 'unrelated-instance',
      }),
    ).rejects.toThrow('marker mismatch');
    await expect(
      exec(process.execPath, ['scripts/redis-test.mjs', 'stop'], {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 10000,
        env: { ...process.env, TEST_REDIS_CONTAINER_ID: 'f'.repeat(64) },
      }),
    ).rejects.toThrow();
    expect(await admin.ping()).toBe('PONG');
    const config = await admin.config(
      'GET',
      'appendonly',
      'appendfsync',
      'maxmemory',
      'maxmemory-policy',
    );
    expect(config).toEqual(
      expect.arrayContaining([
        'appendonly',
        'yes',
        'appendfsync',
        'everysec',
        'maxmemory',
        '268435456',
        'maxmemory-policy',
        'noeviction',
      ]),
    );
    expect(await admin.info('server')).toContain('redis_version:8.2.11');
  });

  it('publishes, runs and completes a real job with state and correlation preservation', async () => {
    const ctx = await createApp();
    await ready(ctx);
    await ctx.queue.pause();
    const nonce = randomUUID();
    const requestId = randomUUID();
    const job = await publish(ctx, { nonce, requestId, hold: true });
    expect(await job.getState()).toBe('waiting');
    await ctx.queue.resume();
    await until('active held job', () => ctx.processor.isWaiting(nonce));
    expect(await job.getState()).toBe('active');
    const stored = await ctx.queue.getJob(job.id ?? '');
    expect(stored?.data.requestId).toBe(requestId);
    ctx.processor.release(nonce);
    await completed(job);
    const finished = await ctx.queue.getJob(job.id ?? '');
    expect(finished?.returnvalue).toEqual({ nonce, verified: true });
    expect(finished?.data.requestId).toBe(requestId);
  });

  it('executes two real failures and succeeds on attempt three with exponential backoff', async () => {
    const ctx = await createApp();
    await ready(ctx);
    const times: number[] = [];
    ctx.worker.on('active', () => {
      times.push(Date.now());
    });
    const job = await publish(ctx, { failUntilAttempt: 2 });
    await completed(job);
    expect((await ctx.queue.getJob(job.id ?? ''))?.attemptsMade).toBe(3);
    expect(times).toHaveLength(3);
    const gaps = [
      Number(times[1]) - Number(times[0]),
      Number(times[2]) - Number(times[1]),
    ];
    expect(gaps[0]).toBeGreaterThanOrEqual(850);
    expect(gaps[0]).toBeLessThan(4000);
    expect(gaps[1]).toBeGreaterThanOrEqual(1800);
    expect(gaps[1]).toBeLessThan(6000);
    expect(Number(gaps[1])).toBeGreaterThan(Number(gaps[0]) * 1.3);
    console.info('Redis retry gaps (ms):', gaps);
  });

  it('ends permanent failure after exactly three real attempts', async () => {
    const ctx = await createApp();
    await ready(ctx);
    let starts = 0;
    ctx.worker.on('active', () => {
      starts += 1;
    });
    const job = await publish(ctx, { alwaysFail: true });
    await until(
      'terminal failure',
      async () => (await job.getState()) === 'failed',
    );
    const stored = await ctx.queue.getJob(job.id ?? '');
    expect(stored?.attemptsMade).toBe(3);
    expect(starts).toBe(3);
    expect(stored?.failedReason).toBe(
      'Controlled permanent infrastructure failure',
    );
  });

  it('isolates identical queue/job IDs between unique prefixes', async () => {
    const first = await createApp();
    const second = await createApp();
    await ready(first);
    await ready(second);
    const jobId = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    const jobA = await publish(first, { nonce: a }, jobId);
    const jobB = await publish(second, { nonce: b }, jobId);
    await completed(jobA);
    await completed(jobB);
    expect(first.prefix).not.toBe(second.prefix);
    expect((await first.queue.getJob(jobId))?.data.nonce).toBe(a);
    expect((await second.queue.getJob(jobId))?.data.nonce).toBe(b);
    await first.app.close();
    first.closed = true;
    await clean(first.prefix);
    expect((await second.queue.getJob(jobId))?.data.nonce).toBe(b);
  });

  it('preserves liveness, bounds producers and reconnects workers/readiness after an outage', async () => {
    const ctx = await createApp();
    await ready(ctx);
    await completed(await publish(ctx));
    await lifecycle('stop');
    try {
      await request(ctx.app.getHttpServer() as Server)
        .get('/api/v1/health')
        .expect(200, { status: 'ok' });
      await request(ctx.app.getHttpServer() as Server)
        .post('/graphql')
        .send({ query: '{ health { status } }' })
        .expect(200, { data: { health: { status: 'ok' } } });
      const response = await request(ctx.app.getHttpServer() as Server)
        .get('/api/v1/health/ready')
        .expect(503);
      expect(response.body).toMatchObject({
        statusCode: 503,
        message: 'Service unavailable',
      });
      const start = Date.now();
      await expect(publish(ctx)).rejects.toThrow('Queue unavailable');
      expect(Date.now() - start).toBeLessThan(2500);
    } finally {
      await lifecycle('start');
    }
    await ready(ctx);
    await completed(await publish(ctx));
  });

  it('initializes while Redis is unavailable and recovers on the same application', async () => {
    await lifecycle('stop');
    let ctx: Context;
    try {
      const start = Date.now();
      ctx = await createApp();
      expect(Date.now() - start).toBeLessThan(7000);
      await request(ctx.app.getHttpServer() as Server)
        .get('/api/v1/health')
        .expect(200);
      await request(ctx.app.getHttpServer() as Server)
        .get('/api/v1/health/ready')
        .expect(503);
      await expect(publish(ctx)).rejects.toThrow('Queue unavailable');
    } finally {
      await lifecycle('start');
    }
    await ready(ctx);
    await completed(await publish(ctx));
  });

  it('persists a waiting job and marker across a normal isolated Redis restart', async () => {
    const ctx = await createApp();
    await ready(ctx);
    await ctx.queue.pause();
    const nonce = randomUUID();
    const job = await publish(ctx, { nonce });
    expect(await job.getState()).toBe('waiting');
    await lifecycle('restart');
    await identity();
    await ready(ctx);
    expect((await ctx.queue.getJob(job.id ?? ''))?.data.nonce).toBe(nonce);
    expect(await job.getState()).toBe('waiting');
    await ctx.queue.resume();
    await completed(job);
  });

  it('rejects new publication, drains active work and closes real owned connections', async () => {
    const ctx = await createApp();
    await ready(ctx);
    const nonce = randomUUID();
    const job = await publish(ctx, { nonce, hold: true });
    await until('held active job', () => ctx.processor.isWaiting(nonce));
    const shutdown = ctx.app.close();
    await until('runtime shutdown gate', async () => {
      try {
        await ctx.runtime.publish(
          INFRASTRUCTURE_QUEUE,
          INFRASTRUCTURE_JOB,
          () => Promise.resolve(),
        );
        return false;
      } catch {
        return true;
      }
    });
    ctx.processor.release(nonce);
    await shutdown;
    ctx.closed = true;
    expect(ctx.worker.getBackend().connection.status).toBe('closed');
    expect(ctx.queue.getBackend().connection.status).toBe('closed');
    expect(
      await admin.hget(
        ctx.prefix + ':' + INFRASTRUCTURE_QUEUE + ':' + job.id,
        'returnvalue',
      ),
    ).toBe(JSON.stringify({ nonce, verified: true }));
    expect(
      (await names()).some((line) => line.includes('name=' + ctx.prefix)),
    ).toBe(false);
  });

  it('enforces the real 30-second budget and cooperatively cancels an active job', async () => {
    const ctx = await createApp();
    await ready(ctx);
    const nonce = randomUUID();
    await publish(ctx, { nonce, hold: true });
    await until('cancellable held job', () => ctx.processor.isWaiting(nonce));
    const start = Date.now();
    await ctx.app.close();
    ctx.closed = true;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(28500);
    expect(elapsed).toBeLessThan(32000);
    await until(
      'cooperative cancellation',
      () => ctx.processor.wasCancelled(nonce),
      2000,
    );
    expect(ctx.worker.getBackend().connection.status).toBe('closed');
    expect(ctx.queue.getBackend().connection.status).toBe('closed');
    console.info('Redis active shutdown budget (ms):', elapsed);
  });

  it('closes real workers and clients while isolated Redis is unavailable', async () => {
    const ctx = await createApp();
    await ready(ctx);
    await completed(await publish(ctx));
    await lifecycle('stop');
    try {
      const start = Date.now();
      await ctx.app.close();
      ctx.closed = true;
      expect(Date.now() - start).toBeLessThan(32000);
      expect(ctx.worker.getBackend().connection.status).toBe('closed');
      expect(ctx.queue.getBackend().connection.status).toBe('closed');
    } finally {
      await lifecycle('start');
    }
  });
});
