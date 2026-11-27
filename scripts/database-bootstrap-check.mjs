import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import pg from 'pg';
import { provisionRoles } from './provision-tenant-roles.mjs';

const raw = parse(readFileSync('.env.test-fixture')).TEST_DATABASE_FIXTURE_URL;
const u = new URL(raw);
if (
  u.hostname !== '127.0.0.1' ||
  u.port !== '5434' ||
  u.pathname !== '/hanoflow_test' ||
  u.username !== 'hanoflow_test_fixture'
)
  throw new Error('Unsafe bootstrap test target');
const c = new pg.Client({
  connectionString: raw,
  connectionTimeoutMillis: 2000,
  statement_timeout: 2000,
});
const id = randomUUID();
let connected = false;
try {
  await c.connect();
  connected = true;
  if (
    (
      await c.query(
        "SELECT current_database()='hanoflow_test' AND current_user='hanoflow_test_fixture' ok",
      )
    ).rows[0].ok !== true
  )
    throw new Error('Wrong fixture identity');
  await c.query('INSERT INTO "Tenant" (id,name,slug) VALUES ($1,$2,$3)', [
    id,
    'Owned bootstrap test',
    `bootstrap-${id}`,
  ]);
  if (
    (await provisionRoles(id, true)) !== 7 ||
    (await provisionRoles(id, true)) !== 0
  )
    throw new Error('Provisioning idempotence failed');
  if (
    Number(
      (await c.query('SELECT count(*) n FROM "Role" WHERE "tenantId"=$1', [id]))
        .rows[0].n,
    ) !== 7
  )
    throw new Error('Role count');
  await c.query('UPDATE "Tenant" SET status=\'ACTIVE\' WHERE id=$1', [id]);
  if ((await provisionRoles(id, true)) !== 0)
    throw new Error('Active matching provisioning failed');
  await c.query(
    'DELETE FROM "RolePermission" WHERE "tenantId"=$1 AND "permissionCode"=$2',
    [id, 'tenant.roles.read'],
  );
  let rejected = false;
  try {
    await provisionRoles(id, true);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('Mapping drift accepted');
  console.log(
    JSON.stringify({
      event: 'controlled_bootstrap_verified',
      created: 7,
      idempotent: true,
      activeMatching: true,
      driftRejected: true,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      event: 'bootstrap_acceptance_failed',
      code: typeof e.code === 'string' ? e.code : 'SAFEGUARD',
    }),
  );
  process.exitCode = 1;
} finally {
  if (connected) {
    await c.query('DELETE FROM "AuditEvent" WHERE "tenantId"=$1', [id]);
    await c.query('DELETE FROM "RolePermission" WHERE "tenantId"=$1', [id]);
    await c.query('DELETE FROM "Role" WHERE "tenantId"=$1', [id]);
    await c.query('DELETE FROM "Tenant" WHERE id=$1', [id]);
  }
  await c.end();
}
