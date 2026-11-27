import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import pg from 'pg';
import {
  verifyRuntimeIdentity,
  DatabaseSecurityConfigurationError,
} from '../dist/infrastructure/database/runtime-identity.js';

// Deliberate isolated fault injection. Grants and SET SESSION AUTHORIZATION stay
// in one uncommitted test-only admin transaction and are always rolled back.
// No other connection ever acquires the injected privilege.
const admin = parse(readFileSync('.env'));
const u = new URL(admin.TEST_DATABASE_URL);
if (
  u.hostname !== '127.0.0.1' ||
  u.port !== '5434' ||
  u.pathname !== '/hanoflow_test' ||
  u.username !== 'hanoflow'
)
  throw new Error('Unsafe negative-check target');
const c = new pg.Client({
  connectionString: u.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 2000,
});
let checked = 0;
try {
  await c.connect();
  if (
    (
      await c.query(
        "SELECT current_database()='hanoflow_test' AND current_user='hanoflow' ok",
      )
    ).rows[0].ok !== true
  )
    throw new Error('Unsafe actual target');
  const adapter = {
    $queryRaw: async (strings, ...args) => {
      if (args.length) throw new Error('Unexpected identity query parameter');
      return (await c.query(strings.join(''))).rows;
    },
  };
  for (const grant of [
    'GRANT INSERT ON public."Permission" TO hanoflow_runtime',
    'GRANT UPDATE(status) ON public."User" TO hanoflow_runtime',
    'GRANT SELECT ON public."AuditEvent" TO hanoflow_runtime',
    'GRANT SELECT(id) ON public."AuditEvent" TO hanoflow_runtime',
    'GRANT SELECT("createdAt") ON public."User" TO hanoflow_runtime',
    'GRANT INSERT(code) ON public."Permission" TO hanoflow_runtime',
  ]) {
    await c.query('BEGIN');
    try {
      await c.query(grant);
      await c.query('SET SESSION AUTHORIZATION hanoflow_runtime');
      let denied = false;
      try {
        await verifyRuntimeIdentity(adapter);
      } catch (e) {
        if (!(e instanceof DatabaseSecurityConfigurationError)) throw e;
        denied = true;
      }
      if (!denied) throw new Error('Unsafe actual runtime privileges accepted');
      checked++;
    } finally {
      await c.query('ROLLBACK');
    }
  }
  let ownerRejected = false;
  try {
    await verifyRuntimeIdentity(adapter);
  } catch (e) {
    if (!(e instanceof DatabaseSecurityConfigurationError)) throw e;
    ownerRejected = true;
  }
  if (!ownerRejected) throw new Error('Owner/superuser accepted');
  console.log(
    JSON.stringify({
      event: 'actual_runtime_privilege_faults_rejected',
      transactionalCases: checked,
      ownerRejected,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      event: 'negative_identity_check_failed',
      code: typeof e.code === 'string' ? e.code : 'SAFEGUARD',
    }),
  );
  process.exitCode = 1;
} finally {
  await c.end();
}
