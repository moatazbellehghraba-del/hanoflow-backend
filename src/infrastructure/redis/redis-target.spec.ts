import { jest } from '@jest/globals';
import {
  getRedisTestTarget,
  verifyRedisTestIdentity,
  REDIS_TEST_MARKER_KEY,
} from '../../../test/helpers/redis-target.js';
describe('isolated Redis test guard (offline)', () => {
  const env = {
    TEST_REDIS_URL: 'redis://127.0.0.1:6381/0',
    TEST_REDIS_INSTANCE_ID: '7e67337b-c120-43dc-a538-a4c8756e3351',
  };
  it.each([
    undefined,
    '',
    'redis://127.0.0.1:6380/0',
    'redis://127.0.0.1:6379/0',
    'redis://example.com:6381/0',
    'redis://localhost:6381/0',
    'redis://127.0.0.1:6381/1',
    'redis://127.0.0.1:6381/0?keyPrefix=bad',
    'redis://user:password@127.0.0.1:6381/0',
  ])('rejects unsafe/missing target %s', (TEST_REDIS_URL) => {
    expect(() =>
      getRedisTestTarget({
        ...env,
        TEST_REDIS_URL,
        REDIS_URL: env.TEST_REDIS_URL,
      }),
    ).toThrow('TEST_REDIS_URL must explicitly');
  });
  it.each([undefined, '', 'wrong-instance'])(
    'requires explicit instance identity %s',
    (TEST_REDIS_INSTANCE_ID) => {
      expect(() =>
        getRedisTestTarget({ ...env, TEST_REDIS_INSTANCE_ID }),
      ).toThrow('TEST_REDIS_INSTANCE_ID');
    },
  );
  it('accepts only the dedicated endpoint and verifies its marker', async () => {
    const target = getRedisTestTarget(env);
    const get = jest
      .fn<(key: string) => Promise<string | null>>()
      .mockResolvedValue(target.marker);
    await verifyRedisTestIdentity({ get }, target);
    expect(get).toHaveBeenCalledWith(REDIS_TEST_MARKER_KEY);
  });
  it('rejects missing or incorrect remote markers before queue creation', async () => {
    const target = getRedisTestTarget(env);
    for (const value of [null, 'other-instance']) {
      await expect(
        verifyRedisTestIdentity({ get: () => Promise.resolve(value) }, target),
      ).rejects.toThrow('marker mismatch');
    }
  });
});
