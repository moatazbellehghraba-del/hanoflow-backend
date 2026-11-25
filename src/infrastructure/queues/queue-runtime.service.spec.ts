import 'reflect-metadata';
import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];
  readonly run = jest.fn<() => Promise<void>>().mockResolvedValue();
  readonly pause = jest
    .fn<(skipActive: boolean) => Promise<void>>()
    .mockResolvedValue();
  readonly close = jest
    .fn<(force: boolean) => Promise<void>>()
    .mockResolvedValue();
  readonly duplicate: Redis;
  constructor(
    readonly name: string,
    readonly process: (job: unknown) => Promise<unknown>,
    readonly options: { connection: Redis },
  ) {
    super();
    this.duplicate = options.connection.duplicate();
    FakeWorker.instances.push(this);
  }
}

jest.unstable_mockModule('bullmq', () => ({ Worker: FakeWorker }));
const { QueueRuntime } = await import('./queue-runtime.service.js');

class FakeQueue extends EventEmitter {
  readonly name = 'infrastructure-verification';
  readonly close = jest.fn<() => Promise<void>>().mockResolvedValue();
}

describe('queue runtime ownership and shutdown (offline)', () => {
  const config = new ConfigService({
    REDIS_URL: 'redis://127.0.0.1:1/0',
    QUEUE_PREFIX: 'hanoflow-unit',
  });
  let runtime: InstanceType<typeof QueueRuntime>;
  let warn = jest.fn<Logger['warn']>();
  let log = jest.fn<Logger['log']>();
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(Redis.prototype, 'connect').mockImplementation(function (
      this: Redis,
    ) {
      this.status = 'connecting';
      return Promise.resolve();
    });
    FakeWorker.instances = [];
    warn = jest.fn<Logger['warn']>();
    log = jest.fn<Logger['log']>();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(warn);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(log);
    runtime = new QueueRuntime(config);
  });
  afterEach(async () => {
    const shutdown = runtime.close();
    await jest.advanceTimersByTimeAsync(30000);
    await shutdown;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function registerWorker() {
    const processor = {
      process: jest
        .fn<(job: unknown, signal: AbortSignal) => Promise<unknown>>()
        .mockResolvedValue('ok'),
    };
    runtime.registerWorker('infrastructure-verification', processor);
    const worker = FakeWorker.instances.at(-1);
    if (!worker) throw new Error('Worker was not constructed');
    return { worker, processor };
  }

  it('initializes without any queue, worker or Redis connection', () => {
    const connect = jest.spyOn(Redis.prototype, 'connect');
    runtime.onApplicationBootstrap();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
  });
  it('rejects publication immediately while the producer is unavailable', async () => {
    runtime.createProducerConnection('infrastructure-verification');
    const operation = jest.fn<() => Promise<void>>();
    await expect(
      runtime.publish('infrastructure-verification', 'verify.v1', operation),
    ).rejects.toThrow('Queue unavailable');
    expect(operation).not.toHaveBeenCalled();
  });
  it('starts owned clients before handing them to BullMQ without awaiting Redis', () => {
    const connect = jest.spyOn(Redis.prototype, 'connect');
    const client = runtime.createProducerConnection(
      'infrastructure-verification',
    );
    expect(client.status).toBe('connecting');
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('publishes only on a ready owned connection', async () => {
    const client = runtime.createProducerConnection(
      'infrastructure-verification',
    );
    client.status = 'ready';
    await expect(
      runtime.publish('infrastructure-verification', 'verify.v1', () =>
        Promise.resolve('accepted'),
      ),
    ).resolves.toBe('accepted');
  });
  it('bounds pending producer operations at two seconds', async () => {
    const client = runtime.createProducerConnection(
      'infrastructure-verification',
    );
    client.status = 'ready';
    const result = expect(
      runtime.publish(
        'infrastructure-verification',
        'verify.v1',
        () => new Promise(() => undefined),
      ),
    ).rejects.toThrow('Queue unavailable');
    await jest.advanceTimersByTimeAsync(2000);
    await result;
    expect(jest.getTimerCount()).toBe(0);
  });
  it('sanitizes producer errors and validates operation names', async () => {
    const client = runtime.createProducerConnection(
      'infrastructure-verification',
    );
    client.status = 'ready';
    await expect(
      runtime.publish('infrastructure-verification', 'verify.v1', () =>
        Promise.reject(new Error('redis://private:secret@internal/0')),
      ),
    ).rejects.toThrow('Queue unavailable');
    expect(warn).toHaveBeenCalledWith({
      event: 'queue_publish_unavailable',
      queue: 'infrastructure-verification',
    });
    await expect(
      runtime.publish('infrastructure-verification', 'unversioned', () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('Invalid job name');
  });
  it('rejects duplicate producer ownership', () => {
    runtime.createProducerConnection('infrastructure-verification');
    expect(() =>
      runtime.createProducerConnection('infrastructure-verification'),
    ).toThrow('Queue registration unavailable');
  });
  it('starts workers at bootstrap after handlers are attached', () => {
    const { worker } = registerWorker();
    expect(worker.run).not.toHaveBeenCalled();
    expect(worker.listenerCount('error')).toBe(1);
    runtime.onApplicationBootstrap();
    expect(worker.run).toHaveBeenCalledTimes(1);
  });
  it('starts workers registered after bootstrap', () => {
    runtime.onApplicationBootstrap();
    const { worker } = registerWorker();
    expect(worker.run).toHaveBeenCalledTimes(1);
  });
  it('sanitizes resource error events', () => {
    const { worker } = registerWorker();
    const queue = new FakeQueue();
    runtime.registerQueue(queue);
    worker.emit('error', new Error('private-password SELECT secret'));
    queue.emit('error', new Error('private-password'));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /private-password|SELECT/,
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it('logs safe correlation and job metadata without payloads or raw errors', () => {
    const { worker } = registerWorker();
    const job = {
      id: 'job-123',
      name: 'verify.v1',
      attemptsMade: 2,
      data: {
        requestId: '7e67337b-c120-43dc-a538-a4c8756e3351',
        private: 'secret-value',
      },
    };
    worker.emit('failed', job, new Error('private-password'));
    expect(log).toHaveBeenCalledWith({
      event: 'queue_job_failed',
      queue: 'infrastructure-verification',
      jobId: 'job-123',
      operation: 'verify.v1',
      attempt: 2,
      requestId: job.data.requestId,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /secret-value|private-password/,
    );
  });
  it('pauses and drains active work before closing workers and queues', async () => {
    const { worker } = registerWorker();
    const queue = new FakeQueue();
    runtime.registerQueue(queue);
    worker.emit('active', { id: 'active-1' });
    const shutdown = runtime.close();
    await jest.advanceTimersByTimeAsync(0);
    expect(worker.pause).toHaveBeenCalledWith(true);
    expect(worker.close).not.toHaveBeenCalled();
    expect(queue.close).not.toHaveBeenCalled();
    worker.emit('completed', {
      id: 'active-1',
      name: 'verify.v1',
      attemptsMade: 0,
      data: {},
    });
    await shutdown;
    expect(worker.close).toHaveBeenCalledWith(true);
    expect(queue.close).toHaveBeenCalledTimes(1);
  });
  it('forces cleanup of originals and blocking duplicates after the drain deadline', async () => {
    const { worker, processor } = registerWorker();
    await worker.process({});
    const signal = processor.process.mock.calls[0]?.[1];
    const client = runtime.createProducerConnection(
      'infrastructure-verification',
    );
    const producerDisconnect = jest.spyOn(client, 'disconnect');
    const workerDisconnect = jest.spyOn(
      worker.options.connection,
      'disconnect',
    );
    const duplicateDisconnect = jest.spyOn(worker.duplicate, 'disconnect');
    worker.emit('active', { id: 'stuck-1' });
    const shutdown = runtime.close();
    await jest.advanceTimersByTimeAsync(29000);
    await shutdown;
    expect(warn).toHaveBeenCalledWith({
      event: 'queue_shutdown_drain_deadline',
    });
    expect(worker.close).toHaveBeenCalledWith(true);
    expect(producerDisconnect).toHaveBeenCalled();
    expect(workerDisconnect).toHaveBeenCalled();
    expect(duplicateDisconnect).toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
  });
  it('enforces one 30-second budget when resource cleanup never settles', async () => {
    const queue = new FakeQueue();
    queue.close.mockImplementation(() => new Promise(() => undefined));
    runtime.registerQueue(queue);
    const client = runtime.createProducerConnection(
      'infrastructure-verification',
    );
    const disconnect = jest.spyOn(client, 'disconnect');
    const shutdown = runtime.close();
    await jest.advanceTimersByTimeAsync(30000);
    await shutdown;
    expect(disconnect).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({
      event: 'queue_shutdown_cleanup_deadline',
    });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('continues cleanup when a resource close rejects', async () => {
    const { worker } = registerWorker();
    worker.close.mockRejectedValue(new Error('private'));
    const client = runtime.createProducerConnection(
      'infrastructure-verification',
    );
    const disconnect = jest.spyOn(client, 'disconnect');
    await runtime.onModuleDestroy();
    expect(disconnect).toHaveBeenCalled();
  });
  it('makes shutdown idempotent and rejects new resources/publications', async () => {
    const queue = new FakeQueue();
    runtime.registerQueue(queue);
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    await first;
    expect(queue.close).toHaveBeenCalledTimes(1);
    expect(() => runtime.createProducerConnection('another-queue')).toThrow(
      'Queue registration unavailable',
    );
    await expect(
      runtime.publish('infrastructure-verification', 'verify.v1', () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('Queue unavailable');
  });
});
