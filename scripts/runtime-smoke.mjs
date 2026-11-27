import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

const mode = process.argv[2];
if (!mode) {
  const runtime = parse(readFileSync('.env.runtime'));
  const fixture = parse(readFileSync('.env.test-fixture'));
  for (const test of ['healthy', 'unavailable', 'wrong-identity']) {
    const env = { ...process.env, ...runtime, NODE_ENV: 'production' };
    for (const key of [
      'DATABASE_MIGRATION_URL',
      'TEST_DATABASE_MIGRATION_URL',
      'TEST_DATABASE_FIXTURE_URL',
      'POSTGRES_PASSWORD',
    ])
      delete env[key];
    if (test === 'unavailable') {
      const u = new URL(env.DATABASE_URL);
      u.port = '1';
      env.DATABASE_URL = u.toString();
    }
    if (test === 'wrong-identity')
      env.DATABASE_URL = fixture.TEST_DATABASE_FIXTURE_URL;
    const r = spawnSync(process.execPath, ['scripts/runtime-smoke.mjs', test], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    if (r.status !== 0) {
      console.error(
        JSON.stringify({ event: 'compiled_runtime_smoke_failed', case: test }),
      );
      process.exit(1);
    }
    const line = r.stdout
      .split(/\r?\n/)
      .find((l) => l.startsWith('{"event":"compiled_runtime_smoke"'));
    if (!line) {
      console.error('Missing compiled smoke evidence');
      process.exit(1);
    }
    console.log(line);
  }
} else {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../dist/app.module.js');
  const { setupApplication } =
    await import('../dist/config/setup-application.js');
  const { PrismaService } =
    await import('../dist/infrastructure/database/prisma.service.js');
  let app;
  try {
    app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    setupApplication(app);
    let rejected = false;
    try {
      await app.listen(0, '127.0.0.1');
    } catch {
      rejected = true;
    }
    if (mode === 'wrong-identity') {
      if (!rejected) throw new Error('Unsafe runtime started');
      console.log(
        JSON.stringify({
          event: 'compiled_runtime_smoke',
          case: mode,
          startupRejected: true,
        }),
      );
    } else {
      if (rejected) throw new Error('Expected live startup');
      const address = app.getHttpServer().address();
      if (!address || typeof address === 'string')
        throw new Error('Missing owned listen address');
      const base = `http://127.0.0.1:${address.port}`;
      const l = await fetch(base + '/api/v1/health', {
        signal: AbortSignal.timeout(3000),
      });
      const ready = await fetch(base + '/api/v1/health/ready', {
        signal: AbortSignal.timeout(5000),
      });
      const gql = await fetch(base + '/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ health { status } }' }),
        signal: AbortSignal.timeout(3000),
      });
      const body = await gql.json();
      if (
        l.status !== 200 ||
        ready.status !== (mode === 'healthy' ? 200 : 503) ||
        gql.status !== 200 ||
        body.data?.health?.status !== 'ok'
      )
        throw new Error('Health contract failed');
      let role;
      if (mode === 'healthy') {
        const rows = await app.get(PrismaService)
          .$queryRaw`SELECT current_user role`;
        role = rows[0]?.role;
        if (role !== 'hanoflow_runtime')
          throw new Error('Wrong actual runtime role');
      }
      console.log(
        JSON.stringify({
          event: 'compiled_runtime_smoke',
          case: mode,
          liveness: l.status,
          readiness: ready.status,
          graphql: gql.status,
          role,
          privilegedEnvAbsent: ![
            'DATABASE_MIGRATION_URL',
            'TEST_DATABASE_MIGRATION_URL',
            'TEST_DATABASE_FIXTURE_URL',
            'POSTGRES_PASSWORD',
          ].some((k) => k in process.env),
        }),
      );
    }
  } catch {
    console.error(
      JSON.stringify({ event: 'compiled_smoke_child_failed', case: mode }),
    );
    process.exitCode = 1;
  } finally {
    if (app) {
      const start = Date.now();
      await app.close();
      if (Date.now() - start > 5000) process.exitCode = 1;
    }
  }
}
