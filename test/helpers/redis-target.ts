export const REDIS_TEST_MARKER_KEY = 'hanoflow:test-instance';
export interface RedisTestTarget {
  url: string;
  instanceId: string;
  marker: string;
}

export function getRedisTestTarget(
  env: Record<string, string | undefined>,
): RedisTestTarget {
  if (env.TEST_REDIS_URL !== 'redis://127.0.0.1:6381/0') {
    throw new Error(
      'TEST_REDIS_URL must explicitly target the dedicated loopback endpoint',
    );
  }
  const instanceId = env.TEST_REDIS_INSTANCE_ID;
  if (
    !instanceId ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(instanceId)
  ) {
    throw new Error(
      'TEST_REDIS_INSTANCE_ID must identify the dedicated test instance',
    );
  }
  return {
    url: env.TEST_REDIS_URL,
    instanceId,
    marker: 'hanoflow-redis-test:' + instanceId,
  };
}

export async function verifyRedisTestIdentity(
  client: { get(key: string): Promise<string | null> },
  target: RedisTestTarget,
): Promise<void> {
  if ((await client.get(REDIS_TEST_MARKER_KEY)) !== target.marker) {
    throw new Error('Dedicated Redis test-instance marker mismatch');
  }
}
