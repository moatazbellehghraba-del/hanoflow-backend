import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { getTestDatabaseUrl } from './database-target.js';

// Explicit out-of-application boundary. Never provide this client to feature DI.
export async function createFixtureClient(): Promise<PrismaClient> {
  const runtime = new URL(getTestDatabaseUrl(process.env));
  const raw =
    process.env.TEST_DATABASE_FIXTURE_URL ??
    parse(readFileSync('.env.test-fixture')).TEST_DATABASE_FIXTURE_URL;
  if (!raw) throw new Error('Missing isolated fixture configuration');
  const u = new URL(raw);
  if (
    u.protocol !== runtime.protocol ||
    u.hostname !== runtime.hostname ||
    u.port !== runtime.port ||
    u.pathname !== '/hanoflow_test' ||
    decodeURIComponent(u.username) !== 'hanoflow_test_fixture'
  )
    throw new Error('Unsafe fixture target');
  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: raw,
      max: 1,
      connectionTimeoutMillis: 2000,
      statement_timeout: 2000,
      query_timeout: 3000,
    }),
    log: [],
  });
  try {
    const rows = await client.$queryRaw<Array<{ safe: boolean }>>`
      SELECT current_database()='hanoflow_test' AND current_user='hanoflow_test_fixture'
      AND session_user='hanoflow_test_fixture' AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT has_database_privilege(current_user,'hanoflow','CONNECT')
      AND NOT EXISTS (SELECT 1 FROM pg_roles p WHERE p.oid<>r.oid AND
        (pg_has_role(r.oid,p.oid,'SET') OR pg_has_role(r.oid,p.oid,'USAGE')))
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relowner=r.oid)
      AS safe FROM pg_roles r WHERE r.rolname=current_user`;
    if (rows[0]?.safe !== true) throw new Error('Unsafe fixture identity');
    return client;
  } catch {
    await client.$disconnect();
    throw new Error('Isolated fixture verification failed');
  }
}
