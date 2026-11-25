import { parseRedisUrl, redisProbeOptions } from './redis.config.js';

describe('Redis connection policies', () => {
  it('decodes credentials and enables verified TLS for rediss', () => {
    expect(parseRedisUrl('rediss://app:p%40ss@example.com:6380/0')).toEqual({
      host: 'example.com',
      port: 6380,
      db: 0,
      username: 'app',
      password: 'p@ss',
      tls: {},
    });
  });
  it('supports an explicit IPv6 loopback target', () => {
    expect(parseRedisUrl('redis://[::1]:6380/0').host).toBe('::1');
  });
  it('disables buffering and resends and bounds probe operations', () => {
    const options = redisProbeOptions('redis://127.0.0.1:6380/0');
    expect(options).toMatchObject({
      lazyConnect: true,
      connectTimeout: 2000,
      commandTimeout: 1000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
    });
    for (const attempt of [1, 5, 100000]) {
      const delay = options.retryStrategy?.(attempt);
      expect(typeof delay).toBe('number');
      expect(delay).toBeGreaterThanOrEqual(200);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });
});
