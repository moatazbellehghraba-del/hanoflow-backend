import { ConfigService } from '@nestjs/config';
import {
  defaultJobOptions,
  producerQueueOptions,
  workerQueueOptions,
  queueConnectionOptions,
} from './queue.config.js';
import { validateQueueName, validateJobName } from './queue.constants.js';

describe('queue configuration', () => {
  const config = new ConfigService({
    REDIS_URL: 'redis://127.0.0.1:1/0',
    QUEUE_PREFIX: 'hanoflow-unit',
  });
  it('uses the approved attempt/backoff and retention defaults', () => {
    expect(defaultJobOptions()).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 604800, count: 5000 },
    });
    expect(defaultJobOptions()).not.toBe(defaultJobOptions());
  });
  it('gives producers a finite command budget with no offline buffering or replay', () => {
    expect(queueConnectionOptions(config, 'producer')).toMatchObject({
      connectTimeout: 2000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
    });
  });
  it('keeps worker connections retrying without short command timeouts', () => {
    const options = queueConnectionOptions(config, 'worker');
    expect(options).toMatchObject({
      connectTimeout: 2000,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
    expect(options.commandTimeout).toBeUndefined();
  });
  it('uses BullMQ prefixes and delays worker processing until bootstrap', () => {
    expect(producerQueueOptions(config)).toMatchObject({
      prefix: 'hanoflow-unit',
      defaultJobOptions: defaultJobOptions(),
    });
    expect(workerQueueOptions(config)).toMatchObject({
      prefix: 'hanoflow-unit',
      concurrency: 1,
      autorun: false,
    });
    expect(queueConnectionOptions(config, 'producer')).not.toHaveProperty(
      'keyPrefix',
    );
  });
  it.each(['hanoflow-dev', 'hanoflow-test-123', 'hanoflow-production'])(
    'respects the configured environment prefix %s',
    (QUEUE_PREFIX) => {
      expect(
        producerQueueOptions(
          new ConfigService({
            REDIS_URL: 'redis://127.0.0.1:1/0',
            QUEUE_PREFIX,
          }),
        ).prefix,
      ).toBe(QUEUE_PREFIX);
    },
  );
  it('rejects an invalid prefix without echoing configuration', () => {
    expect(() =>
      producerQueueOptions(
        new ConfigService({
          REDIS_URL: 'redis://127.0.0.1:1/0',
          QUEUE_PREFIX: 'secret:value',
        }),
      ),
    ).toThrow('Invalid environment configuration: QUEUE_PREFIX');
  });
  it('caps jittered reconnection delay', () => {
    const retry = queueConnectionOptions(config, 'worker').retryStrategy;
    for (const attempt of [1, 10, 100000]) {
      expect(retry?.(attempt)).toBeGreaterThanOrEqual(200);
      expect(retry?.(attempt)).toBeLessThanOrEqual(5000);
    }
  });
  it('retains verified TLS settings', () => {
    expect(
      queueConnectionOptions(
        new ConfigService({
          REDIS_URL: 'rediss://app:p%40ss@example.com:6380/0',
        }),
        'worker',
      ),
    ).toMatchObject({
      host: 'example.com',
      username: 'app',
      password: 'p@ss',
      tls: {},
    });
  });
  it.each(['', 'Bad', 'has:colon', 'two--hyphens', 'a'.repeat(65)])(
    'rejects queue name %s',
    (name) => {
      expect(() => validateQueueName(name)).toThrow('Invalid queue name');
    },
  );
  it.each(['operation', 'operation.v0', 'has:colon.v1', 'Operation.v1'])(
    'rejects job name %s',
    (name) => {
      expect(() => validateJobName(name)).toThrow('Invalid job name');
    },
  );
  it('accepts stable capability and versioned operation names', () => {
    expect(() =>
      validateQueueName('infrastructure-verification'),
    ).not.toThrow();
    expect(() => validateJobName('verify.v1')).not.toThrow();
  });
});
