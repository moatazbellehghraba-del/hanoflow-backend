import { writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import pg from 'pg';

if (process.env.CI !== 'true' || !process.env.HF_CI_DB_PASSWORD)
  throw new Error('CI-only provisioning');
execFileSync('git', ['check-ignore', '--quiet', '--', '.env']);
const u = new URL('postgresql://hanoflow@127.0.0.1:5434/hanoflow');
u.password = process.env.HF_CI_DB_PASSWORD;
const t = new URL(u);
t.pathname = '/hanoflow_test';
writeFileSync(
  '.env',
  `DATABASE_URL=${u.toString()}\nTEST_DATABASE_URL=${t.toString()}\n`,
  { flag: 'wx', mode: 0o600 },
);
const c = new pg.Client({
  connectionString: u.toString(),
  connectionTimeoutMillis: 2000,
});
try {
  await c.connect();
  if (
    (
      await c.query(
        "SELECT current_database()='hanoflow' AND current_user='hanoflow' ok",
      )
    ).rows[0].ok !== true
  )
    throw new Error('CI target mismatch');
  await c.query('REVOKE CONNECT ON DATABASE hanoflow FROM PUBLIC');
} finally {
  await c.end();
}
const result = spawnSync(
  process.execPath,
  ['scripts/database-security.mjs', 'prepare-test'],
  {
    stdio: 'inherit',
    env: { ...process.env, HANOFLOW_EMPTY_CI_DATABASES: '1' },
  },
);
process.exitCode = result.status ?? 1;
