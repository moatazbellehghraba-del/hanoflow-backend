import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { createHash } from 'node:crypto';
import pg from 'pg';

const admin = parse(readFileSync('.env'));
const report = { generatedAt: new Date().toISOString(), databases: [] };
try {
  for (const [key, name] of [
    ['DATABASE_URL', 'hanoflow'],
    ['TEST_DATABASE_URL', 'hanoflow_test'],
  ]) {
    const u = new URL(admin[key]);
    if (
      u.hostname !== '127.0.0.1' ||
      u.port !== '5434' ||
      u.pathname !== `/${name}` ||
      u.username !== 'hanoflow'
    )
      throw new Error('Unsafe report target');
    const c = new pg.Client({
      connectionString: u.toString(),
      connectionTimeoutMillis: 2000,
      statement_timeout: 2000,
    });
    await c.connect();
    try {
      await c.query('BEGIN READ ONLY');
      if ((await c.query('SELECT current_database() db')).rows[0].db !== name)
        throw new Error('Wrong report database');
      const data = { database: name };
      data.roles = (
        await c.query(
          "SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname LIKE 'hanoflow%' ORDER BY rolname",
        )
      ).rows;
      data.memberships = (
        await c.query(
          "SELECT r.rolname role,m.rolname member,a.admin_option,a.inherit_option,a.set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE r.rolname LIKE 'hanoflow%' OR m.rolname LIKE 'hanoflow%'",
        )
      ).rows;
      data.databaseAcl = (
        await c.query(
          'SELECT pg_get_userbyid(datdba) owner,datacl FROM pg_database WHERE datname=current_database()',
        )
      ).rows;
      data.tables = (
        await c.query(
          "SELECT c.relname,pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname COLLATE \"C\"",
        )
      ).rows;
      data.policies = (
        await c.query(
          "SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname",
        )
      ).rows;
      data.grants = (
        await c.query(
          "SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('hanoflow_runtime','hanoflow_bootstrap','hanoflow_test_fixture') ORDER BY grantee,table_name,privilege_type",
        )
      ).rows;
      data.columnGrants = (
        await c.query(
          "SELECT grantee,table_name,column_name,privilege_type FROM information_schema.column_privileges WHERE table_schema='public' AND grantee='hanoflow_runtime' ORDER BY table_name,column_name,privilege_type",
        )
      ).rows;
      data.fixtureDevelopmentConnect = (
        await c.query(
          "SELECT has_database_privilege('hanoflow_test_fixture','hanoflow','CONNECT') allowed",
        )
      ).rows[0].allowed;
      data.schemas = (
        await c.query(
          "SELECT nspname,pg_get_userbyid(nspowner) owner,nspacl FROM pg_namespace WHERE nspname IN ('public','hf_security') ORDER BY nspname",
        )
      ).rows;
      data.functions = (
        await c.query(
          "SELECT proname,pg_get_userbyid(proowner) owner,prosecdef,proconfig,proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hf_security' ORDER BY proname",
        )
      ).rows;
      data.triggers = (
        await c.query(
          "SELECT tgname,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY tgname",
        )
      ).rows;
      data.constraints = (
        await c.query(
          "SELECT conname,pg_get_constraintdef(c.oid) definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='c' ORDER BY conname",
        )
      ).rows;
      data.defaultPrivileges = (
        await c.query(
          "SELECT pg_get_userbyid(defaclrole) role,n.nspname,defaclobjtype,defaclacl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE pg_get_userbyid(defaclrole)='hanoflow_migrator'",
        )
      ).rows;
      data.migrations = (
        await c.query(
          'SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name,started_at',
        )
      ).rows;
      for (const m of data.migrations.filter((m) => m.rolled_back_at === null))
        if (
          !m.finished_at ||
          m.checksum !==
            createHash('sha256')
              .update(
                readFileSync(
                  `prisma/migrations/${m.migration_name}/migration.sql`,
                ),
              )
              .digest('hex')
        )
          throw new Error('Migration checksum mismatch');
      data.counts = {};
      for (const t of data.tables.filter(
        (t) => t.relname !== '_prisma_migrations',
      ))
        data.counts[t.relname] = Number(
          (await c.query(`SELECT count(*) n FROM public."${t.relname}"`))
            .rows[0].n,
        );
      await c.query('ROLLBACK');
      report.databases.push(data);
    } finally {
      await c.end();
    }
  }
  writeFileSync(
    'docs/development/TASK-2.6-VERIFICATION.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    'Sanitized actual-role/policy/grant/checksum/count report written. No credentials or application rows exported.',
  );
} catch (e) {
  console.error(
    JSON.stringify({
      event: 'security_report_failed',
      code: typeof e.code === 'string' ? e.code : 'SAFEGUARD',
    }),
  );
  process.exitCode = 1;
}
