import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { parse } from 'dotenv';
import pg from 'pg';

const tables = [
  'User',
  'Tenant',
  'Membership',
  'AuditEvent',
  'PasswordCredential',
  'Session',
  'AccessToken',
  'RefreshToken',
  'Role',
  'Permission',
  'MembershipRole',
  'RolePermission',
  '_prisma_migrations',
];
const roles = [
  'hanoflow_migrator',
  'hanoflow_runtime',
  'hanoflow_bootstrap',
  'hanoflow_test_fixture',
];
const files = [
  '.env.runtime',
  '.env.migrations',
  '.env.test-runtime',
  '.env.test-migrations',
  '.env.test-fixture',
];
const action = process.argv[2];
const emptyTargets =
  process.argv.includes('--empty') ||
  (process.env.CI === 'true' &&
    process.env.HANOFLOW_EMPTY_CI_DATABASES === '1');
function fail() {
  throw new Error('Unsafe or unexpected database security configuration');
}
function values(path) {
  return parse(readFileSync(path));
}
function target(raw, name, user) {
  const u = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    u.hostname !== '127.0.0.1' ||
    u.port !== '5434' ||
    u.pathname !== `/${name}` ||
    decodeURIComponent(u.username) !== user
  )
    fail();
  return u;
}
async function client(raw, name, user) {
  target(raw, name, user);
  const c = new pg.Client({
    connectionString: raw,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
  });
  await c.connect();
  const r = (
    await c.query(
      'SELECT current_database() db,current_user role,session_user login',
    )
  ).rows[0];
  if (r.db !== name || r.role !== user || r.login !== user) {
    await c.end();
    fail();
  }
  return c;
}
function writeIgnored(path, text) {
  execFileSync('git', ['check-ignore', '--quiet', '--', path]);
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
}
function roleUrl(base, user, password) {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  return u.toString();
}
async function snapshot(c) {
  if (emptyTargets) {
    const objects = (
      await c.query(
        "SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','hf_security') AND c.relkind IN ('r','v','m','S','f')",
      )
    ).rows[0].n;
    const types = (
      await c.query(
        "SELECT count(*)::int n FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('public','hf_security') AND t.typtype='e'",
      )
    ).rows[0].n;
    const routines = (
      await c.query(
        "SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','hf_security')",
      )
    ).rows[0].n;
    if (objects !== 0 || types !== 0 || routines !== 0) fail();
    return;
  }
  const rows = (
    await c.query(
      'SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
    )
  ).rows;
  if (rows.length !== 4) fail();
  for (const r of rows)
    if (
      !r.finished_at ||
      r.rolled_back_at ||
      createHash('sha256')
        .update(
          readFileSync(`prisma/migrations/${r.migration_name}/migration.sql`),
        )
        .digest('hex') !== r.checksum
    )
      fail();
  for (const t of tables.filter((t) => t !== '_prisma_migrations')) {
    const n = Number(
      (await c.query(`SELECT count(*) n FROM public."${t}"`)).rows[0].n,
    );
    if (n !== (t === 'Permission' ? 5 : 0)) fail();
  }
}
async function harden(c, name) {
  await c.query('BEGIN');
  try {
    await c.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await c.query(
      `GRANT CONNECT ON DATABASE ${name} TO hanoflow_runtime,hanoflow_migrator`,
    );
    if (name === 'hanoflow_test')
      await c.query(
        'GRANT CONNECT ON DATABASE hanoflow_test TO hanoflow_test_fixture',
      );
    await c.query('ALTER SCHEMA public OWNER TO hanoflow_migrator');
    await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await c.query(
      'GRANT USAGE ON SCHEMA public TO hanoflow_runtime,hanoflow_bootstrap',
    );
    await c.query('CREATE SCHEMA hf_security AUTHORIZATION hanoflow_migrator');
    await c.query('REVOKE ALL ON SCHEMA hf_security FROM PUBLIC');
    await c.query(
      'ALTER DEFAULT PRIVILEGES FOR ROLE hanoflow_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
    );
    for (const t of tables) {
      if (
        emptyTargets &&
        !(await c.query('SELECT to_regclass($1) object', [`public."${t}"`]))
          .rows[0].object
      )
        continue;
      await c.query(`ALTER TABLE public."${t}" OWNER TO hanoflow_migrator`);
    }
    const types = (
      await c.query(
        "SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e' ORDER BY typname",
      )
    ).rows;
    for (const t of types) {
      if (!/^[A-Za-z]+$/.test(t.typname)) fail();
      await c.query(
        `ALTER TYPE public."${t.typname}" OWNER TO hanoflow_migrator`,
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}

async function main() {
  if (!['prepare-test', 'test-fixtures', 'development'].includes(action))
    fail();
  // Original Compose/admin configuration is parsed locally, never exported into
  // process.env or loaded by the NestJS runtime/migration/fixture processes.
  const admin = values('.env');
  const dev = await client(admin.DATABASE_URL, 'hanoflow', 'hanoflow');
  const test = await client(
    admin.TEST_DATABASE_URL,
    'hanoflow_test',
    'hanoflow',
  );
  try {
    const publicConnect = (
      await dev.query(
        "SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(datacl,acldefault('d',datdba))) a WHERE datname='hanoflow' AND a.grantee=0 AND a.privilege_type='CONNECT'",
      )
    ).rowCount;
    if (publicConnect) fail(); // Approved sequencing exception must already hold.
    if (action === 'prepare-test') {
      await snapshot(dev);
      await snapshot(test);
      const existing = (
        await dev.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1)', [
          roles,
        ])
      ).rows;
      if (existing.length || files.some(existsSync)) fail();
      for (const f of files)
        execFileSync('git', ['check-ignore', '--quiet', '--', f]);
      const passwords = new Map(
        roles.map((r) => [r, randomBytes(48).toString('base64url')]),
      );
      await dev.query('BEGIN');
      try {
        for (const r of roles) {
          const p = passwords.get(r);
          if (!p || !/^[A-Za-z0-9_-]{64}$/.test(p)) fail();
          await dev.query(
            `CREATE ROLE ${r} ${r === 'hanoflow_bootstrap' ? 'NOLOGIN' : 'LOGIN'} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD '${p}'`,
          );
        }
        await dev.query(
          'GRANT hanoflow_bootstrap TO hanoflow_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE',
        );
        await dev.query('COMMIT');
      } catch (e) {
        await dev.query('ROLLBACK');
        throw e;
      }
      const runtime = roleUrl(
        admin.DATABASE_URL,
        'hanoflow_runtime',
        passwords.get('hanoflow_runtime'),
      );
      const testRuntime = roleUrl(
        admin.TEST_DATABASE_URL,
        'hanoflow_runtime',
        passwords.get('hanoflow_runtime'),
      );
      // Preserve .env verbatim for Compose/admin; copy only noncredential runtime
      // configuration. Each privileged URL is in its own ignored, scoped file.
      const plain = Object.entries(admin).filter(
        ([k]) => !/(?:DATABASE|POSTGRES|PASSWORD|SECRET|TOKEN)/i.test(k),
      );
      writeIgnored(
        '.env.runtime',
        plain.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') +
          `\nDATABASE_URL=${runtime}\nDATABASE_RUNTIME_USER=hanoflow_runtime\n`,
      );
      writeIgnored(
        '.env.test-runtime',
        `DATABASE_URL=${runtime}\nTEST_DATABASE_URL=${testRuntime}\nDATABASE_RUNTIME_USER=hanoflow_runtime\nPOSTGRES_PORT=5434\n`,
      );
      writeIgnored(
        '.env.migrations',
        `DATABASE_MIGRATION_URL=${roleUrl(admin.DATABASE_URL, 'hanoflow_migrator', passwords.get('hanoflow_migrator'))}\n`,
      );
      writeIgnored(
        '.env.test-migrations',
        `DATABASE_MIGRATION_URL=${roleUrl(admin.TEST_DATABASE_URL, 'hanoflow_migrator', passwords.get('hanoflow_migrator'))}\n`,
      );
      writeIgnored(
        '.env.test-fixture',
        `TEST_DATABASE_FIXTURE_URL=${roleUrl(admin.TEST_DATABASE_URL, 'hanoflow_test_fixture', passwords.get('hanoflow_test_fixture'))}\n`,
      );
      await harden(test, 'hanoflow_test');
      const fixture = values('.env.test-fixture').TEST_DATABASE_FIXTURE_URL;
      const denied = new URL(fixture);
      denied.pathname = '/hanoflow';
      let forbidden;
      try {
        forbidden = await client(
          denied.toString(),
          'hanoflow',
          'hanoflow_test_fixture',
        );
      } catch (e) {
        if (e.code !== '42501') throw e;
      }
      if (forbidden) {
        await forbidden.end();
        fail();
      }
      const allowed = await client(
        fixture,
        'hanoflow_test',
        'hanoflow_test_fixture',
      );
      await allowed.end();
      console.log(
        'Test preparation completed; fixture development CONNECT denied; test CONNECT verified. Development objects unchanged.',
      );
    } else if (action === 'test-fixtures') {
      const fixtureRoles = (
        await test.query(
          "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='hanoflow_test_fixture'",
        )
      ).rows;
      if (
        fixtureRoles.length !== 1 ||
        fixtureRoles[0].rolsuper ||
        fixtureRoles[0].rolbypassrls
      )
        fail();
      await test.query('BEGIN');
      try {
        await test.query(
          'GRANT USAGE ON SCHEMA public,hf_security TO hanoflow_test_fixture',
        );
        await test.query(
          'GRANT EXECUTE ON FUNCTION hf_security.immutable_id() TO hanoflow_test_fixture',
        );
        for (const t of tables.filter((t) => t !== '_prisma_migrations')) {
          await test.query(
            `CREATE POLICY fixture_test_only ON public."${t}" FOR ALL TO hanoflow_test_fixture USING (current_database()='hanoflow_test') WITH CHECK (current_database()='hanoflow_test')`,
          );
          await test.query(
            `GRANT SELECT,INSERT${t === 'Permission' ? '' : ',UPDATE,DELETE'} ON public."${t}" TO hanoflow_test_fixture`,
          );
        }
        await test.query(
          'GRANT SELECT ON public."_prisma_migrations" TO hanoflow_test_fixture',
        );
        await test.query('COMMIT');
      } catch (e) {
        await test.query('ROLLBACK');
        throw e;
      }
      console.log(
        'Exact test database fixture policies provisioned; no fixture DDL or RLS bypass.',
      );
    } else {
      // Require a separately produced successful restricted-role acceptance file.
      const approval = JSON.parse(
        readFileSync('.env.rls-test-acceptance', 'utf8'),
      );
      const migration = readFileSync(
        'prisma/migrations/20261127210000_restricted_runtime_rls/migration.sql',
      );
      if (
        approval.migrationSha256 !==
          createHash('sha256').update(migration).digest('hex') ||
        approval.accepted !== true
      )
        fail();
      await snapshot(dev);
      await harden(dev, 'hanoflow');
      console.log(
        'Development ownership/ACL preparation completed after test acceptance. Apply reviewed migration with the migration identity.',
      );
    }
  } finally {
    await test.end();
    await dev.end();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({
      event: 'database_security_operation_failed',
      code: typeof e.code === 'string' ? e.code : 'SAFEGUARD',
    }),
  );
  process.exitCode = 1;
});
