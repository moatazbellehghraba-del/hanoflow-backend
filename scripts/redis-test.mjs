import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import { Redis } from 'ioredis';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.env.redis-test');
const project = 'hanoflow-redis-test';
const service = 'redis-test';
const markerKey = 'hanoflow:test-instance';
const action = process.argv[2];
if (!['up', 'inspect', 'stop', 'start', 'restart'].includes(action)) {
  throw new Error('Supported actions: up, inspect, stop, start, restart');
}
if (action === 'up' && !existsSync(envFile)) {
  writeFileSync(
    envFile,
    'TEST_REDIS_URL=redis://127.0.0.1:6381/0\nTEST_REDIS_INSTANCE_ID=' +
      randomUUID() +
      '\n',
    { flag: 'wx' },
  );
}
const values = {
  ...(existsSync(envFile) ? parse(readFileSync(envFile)) : {}),
  ...process.env,
};
if (
  values.TEST_REDIS_URL !== 'redis://127.0.0.1:6381/0' ||
  !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
    values.TEST_REDIS_INSTANCE_ID ?? '',
  )
) {
  throw new Error('Explicit isolated Redis URL and instance ID are required');
}
const marker = project + ':' + values.TEST_REDIS_INSTANCE_ID;
const run = promisify(execFile);
async function docker(args) {
  const result = await run('docker', args, {
    cwd: root,
    env: { ...process.env, ...values },
    timeout: 45000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}
const compose = [
  'compose',
  '-p',
  project,
  '--env-file',
  envFile,
  '-f',
  resolve(root, 'compose.redis-test.yaml'),
];
async function inspect() {
  const id = await docker([...compose, 'ps', '-a', '-q', service]);
  if (!/^[0-9a-f]{64}$/.test(id))
    throw new Error('Expected exactly one dedicated test container');
  const [container] = JSON.parse(await docker(['inspect', id]));
  const labels = container.Config?.Labels ?? {};
  const binding = container.HostConfig?.PortBindings?.['6379/tcp'];
  const env = container.Config?.Env ?? [];
  if (
    labels['com.docker.compose.project'] !== project ||
    labels['com.docker.compose.service'] !== service ||
    container.Config?.Image !== 'redis:8.2.11-bookworm' ||
    binding?.length !== 1 ||
    binding[0]?.HostIp !== '127.0.0.1' ||
    binding[0]?.HostPort !== '6381' ||
    !container.Mounts?.some(
      (mount) =>
        mount.Type === 'volume' &&
        mount.Name === project + '_redis-test-data' &&
        mount.Destination === '/data',
    ) ||
    !env.includes(
      'HANOFLOW_TEST_INSTANCE_ID=' + values.TEST_REDIS_INSTANCE_ID,
    ) ||
    (values.TEST_REDIS_CONTAINER_ID && values.TEST_REDIS_CONTAINER_ID !== id)
  ) {
    throw new Error('Dedicated test container identity/configuration mismatch');
  }
  return { id, running: container.State.Running };
}
async function identity(seed = false) {
  const client = new Redis({
    host: '127.0.0.1',
    port: 6381,
    db: 0,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    commandTimeout: 1000,
    connectTimeout: 2000,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    if (seed) await client.set(markerKey, marker, 'NX');
    if ((await client.get(markerKey)) !== marker)
      throw new Error('Test-instance marker mismatch');
  } finally {
    client.disconnect();
  }
}
async function waitHealthy() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      await identity();
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error('Dedicated Redis did not recover with the expected marker');
}

try {
  if (action === 'up') {
    // Never recreate an existing mismatched container or change its identity.
    const existing = await docker([...compose, 'ps', '-a', '-q', service]);
    if (existing) await inspect();
    await docker([...compose, 'up', '-d', '--no-deps', '--wait', service]);
    const container = await inspect();
    await identity(true);
    console.log(
      JSON.stringify({
        project,
        service,
        containerId: container.id,
        status: 'healthy',
      }),
    );
  } else {
    const container = await inspect();
    if (container.running) await identity();
    if (action === 'stop' && container.running)
      await docker(['stop', '--time', '30', container.id]);
    if (action === 'start' && !container.running)
      await docker(['start', container.id]);
    if (action === 'restart') {
      if (!container.running)
        throw new Error('Restart requires a running verified test container');
      await docker(['restart', '--time', '30', container.id]);
    }
    if (action === 'start' || action === 'restart') await waitHealthy();
    console.log(
      JSON.stringify({ project, service, containerId: container.id, action }),
    );
  }
} catch {
  console.error(
    'Isolated Redis operation failed: check Docker access, dedicated container labels/binding, and test-instance marker.',
  );
  process.exitCode = 1;
}
