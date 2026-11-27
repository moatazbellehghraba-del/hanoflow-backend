import type { PrismaClient } from '../../generated/prisma/client.js';

export class DatabaseSecurityConfigurationError extends Error {
  constructor() {
    super('Unsafe database runtime identity or privileges');
    this.name = 'DatabaseSecurityConfigurationError';
  }
}

export function isDatabaseUnavailable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 6) return false;
  for (const key of ['code', 'errorCode', 'originalCode', 'kind']) {
    if (
      key in error &&
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'P1001',
        'P1002',
        'P1017',
        '57P01',
        '57P02',
        '57P03',
        '08006',
        'ConnectionError',
        'DatabaseNotReachable',
        'ConnectionClosed',
        'SocketTimeout',
      ].includes(String(Reflect.get(error, key)))
    )
      return true;
  }
  return ['cause', 'meta', 'driverAdapterError'].some(
    (key) =>
      key in error && isDatabaseUnavailable(Reflect.get(error, key), depth + 1),
  );
}

// Query metadata using the actual connection, never infer authority from a URL.
export async function verifyRuntimeIdentity(db: PrismaClient): Promise<void> {
  try {
    const rows = await db.$queryRaw<Array<{ safe: boolean }>>`
    SELECT current_user='hanoflow_runtime' AND session_user='hanoflow_runtime'
      AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
      AND NOT r.rolcreaterole AND NOT r.rolreplication
      AND NOT EXISTS (SELECT 1 FROM pg_roles p WHERE p.oid<>r.oid AND
        (pg_has_role(r.oid,p.oid,'SET') OR pg_has_role(r.oid,p.oid,'USAGE')))
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','hf_security') AND c.relowner=r.oid)
      AND NOT has_schema_privilege(current_user,'public','CREATE')
      AND NOT has_schema_privilege(current_user,'hf_security','CREATE')
      AND NOT has_database_privilege(current_user,current_database(),'CREATE')
      AND NOT has_database_privilege(current_user,current_database(),'TEMP')
      AND NOT has_parameter_privilege(current_user,'session_replication_role','SET')
      AND NOT has_table_privilege(current_user,'public."_prisma_migrations"','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_table_privilege(current_user,'public."PasswordCredential"','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege(current_user,'public."AuditEvent"','SELECT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_table_privilege(current_user,'public."Permission"','INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege(current_user,'public."_prisma_migrations"','SELECT,INSERT,UPDATE,REFERENCES')
      AND NOT has_any_column_privilege(current_user,'public."PasswordCredential"','SELECT,INSERT,UPDATE,REFERENCES')
      AND NOT has_any_column_privilege(current_user,'public."AuditEvent"','SELECT,UPDATE,REFERENCES')
      AND NOT has_any_column_privilege(current_user,'public."Permission"','INSERT,UPDATE,REFERENCES')
      AND NOT has_column_privilege(current_user,'public."User"','email','SELECT')
      AND NOT has_column_privilege(current_user,'public."User"','canonicalEmail','SELECT')
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('User','Tenant','Membership','Role','RolePermission')
        AND has_any_column_privilege(current_user,c.oid,'INSERT'))
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns a WHERE a.table_schema='public' AND a.table_name='User'
        AND a.column_name NOT IN ('id','status','emailVerifiedAt')
        AND has_column_privilege(current_user,'public."User"',a.column_name,'SELECT'))
      AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','hf_security') AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE'))
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns a
        WHERE a.table_schema='public' AND a.table_name IN ('User','Tenant','Membership','Session','AccessToken','RefreshToken','Role','RolePermission','MembershipRole')
        AND has_column_privilege(current_user,format('%I.%I',a.table_schema,a.table_name),a.column_name,'UPDATE')
        AND NOT ((a.table_name IN ('User','Tenant') AND a.column_name='id')
          OR (a.table_name='Membership' AND a.column_name IN ('status','removedAt','updatedAt'))
          OR (a.table_name='Session' AND a.column_name IN ('scope','tenantId','membershipId','contextVersion','lastActivityAt','idleExpiresAt','revokedAt','revocationReason'))
          OR (a.table_name='RefreshToken' AND a.column_name='consumedAt')
          OR (a.table_name='MembershipRole' AND a.column_name IN ('removedAt','removedByUserId'))))
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
        AND (has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(current_user,c.oid,'REFERENCES')
          OR (c.relname<>'_prisma_migrations' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity))))
      AS safe FROM pg_roles r WHERE r.rolname=current_user`;
    if (rows.length !== 1 || rows[0]?.safe !== true)
      throw new DatabaseSecurityConfigurationError();
  } catch (error) {
    if (
      isDatabaseUnavailable(error) ||
      error instanceof DatabaseSecurityConfigurationError
    )
      throw error;
    throw new DatabaseSecurityConfigurationError();
  }
}
