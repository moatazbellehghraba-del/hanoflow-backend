import type { RedisOptions } from 'ioredis';
export const REDIS_PROBE_CLIENT = Symbol('REDIS_PROBE_CLIENT');

export const REDIS_CONNECT_TIMEOUT_MS = 2000;
export const REDIS_READINESS_TIMEOUT_MS = 1000;

// Parse an explicit allowlist rather than passing URL query options to ioredis.
export function parseRedisUrl(value: unknown): RedisOptions {
  const invalid = () =>
    new Error('Invalid environment configuration: REDIS_URL');
  if (typeof value !== 'string' || value.trim() !== value) throw invalid();
  try {
    const url = new URL(value);
    if (
      !['redis:', 'rediss:'].includes(url.protocol) ||
      !url.hostname ||
      url.search ||
      url.hash ||
      !/^\/(0|[1-9]\d*)$/.test(url.pathname) ||
      (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))
    )
      throw invalid();
    const db = Number(url.pathname.slice(1));
    if (!Number.isSafeInteger(db) || db > 15) throw invalid();
    return {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 6379),
      db,
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    };
  } catch {
    throw invalid();
  }
}

export function redisProbeOptions(url: string): RedisOptions {
  return {
    ...parseRedisUrl(url),
    lazyConnect: true,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_READINESS_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    autoResendUnfulfilledCommands: false,
    retryStrategy: (attempt: number) =>
      Math.min(250 * 2 ** Math.min(attempt - 1, 5), 5000) *
      (0.8 + Math.random() * 0.2),
  };
}
