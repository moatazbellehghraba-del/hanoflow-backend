import type { ConfigService } from '@nestjs/config';
import type { DefaultJobOptions, QueueOptions, WorkerOptions } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { parseRedisUrl } from '../redis/redis.config.js';
import {
  QUEUE_CONNECTION_TIMEOUT_MS,
  QUEUE_PRODUCER_BUDGET_MS,
  QUEUE_WORKER_CONCURRENCY,
} from './queue.constants.js';

export function defaultJobOptions(): DefaultJobOptions {
  return {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 604800, count: 5000 },
  };
}

export function queuePrefix(config: ConfigService): string {
  const prefix = config.getOrThrow<string>('QUEUE_PREFIX');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(prefix)) {
    throw new Error('Invalid environment configuration: QUEUE_PREFIX');
  }
  return prefix;
}

export type QueueRedisOptions = Pick<
  RedisOptions,
  | 'host'
  | 'port'
  | 'db'
  | 'username'
  | 'password'
  | 'tls'
  | 'lazyConnect'
  | 'connectionName'
  | 'connectTimeout'
  | 'commandTimeout'
  | 'maxRetriesPerRequest'
  | 'enableOfflineQueue'
  | 'autoResendUnfulfilledCommands'
> & { retryStrategy: (attempt: number) => number };

export function queueConnectionOptions(
  config: ConfigService,
  role: 'producer' | 'worker',
): QueueRedisOptions {
  return {
    ...parseRedisUrl(config.getOrThrow<string>('REDIS_URL')),
    lazyConnect: true,
    connectionName: `${queuePrefix(config)}:${role}`,
    connectTimeout: QUEUE_CONNECTION_TIMEOUT_MS,
    retryStrategy: (attempt) =>
      Math.min(250 * 2 ** Math.min(attempt - 1, 5), 5000) *
      (0.8 + Math.random() * 0.2),
    ...(role === 'producer'
      ? {
          maxRetriesPerRequest: 0,
          commandTimeout: QUEUE_PRODUCER_BUDGET_MS,
          enableOfflineQueue: false,
          autoResendUnfulfilledCommands: false,
        }
      : { maxRetriesPerRequest: null, enableOfflineQueue: true }),
  };
}

export function producerQueueOptions(config: ConfigService): QueueOptions {
  return {
    connection: queueConnectionOptions(config, 'producer'),
    prefix: queuePrefix(config),
    defaultJobOptions: defaultJobOptions(),
    // A new producer must initialize normally; publication has its own outer
    // deadline/readiness check and must never await initialization indefinitely.
    skipWaitingForReady: false,
  };
}

export function workerQueueOptions(config: ConfigService): WorkerOptions {
  return {
    connection: queueConnectionOptions(config, 'worker'),
    prefix: queuePrefix(config),
    concurrency: QUEUE_WORKER_CONCURRENCY,
    autorun: false,
  };
}
