import 'reflect-metadata';
import './setup-database-env.js';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import {
  verifyRuntimeIdentity,
  DatabaseSecurityConfigurationError,
} from '../src/infrastructure/database/runtime-identity.js';
import {
  tenantContext,
  identityContext,
  sessionLookup,
} from '../src/infrastructure/database/database-context.js';
import { getTestDatabaseUrl } from './helpers/database-target.js';
import { createFixtureClient } from './helpers/database-fixture.js';

type Tx = Prisma.TransactionClient;
const rollback = new Error('Owned test transaction rollback');
const tables = [
  'AccessToken',
  'AuditEvent',
  'Membership',
  'MembershipRole',
  'PasswordCredential',
  'Permission',
  'RefreshToken',
  'Role',
  'RolePermission',
  'Session',
  'Tenant',
  'User',
];

describe('Restricted PostgreSQL role and RLS acceptance', () => {
  let runtime: PrismaClient;
  let fixture: PrismaClient;
  const users = [randomUUID(), randomUUID(), randomUUID()];
  const tenants = [randomUUID(), randomUUID(), randomUUID()];
  const members = [randomUUID(), randomUUID()];
  const roles = [randomUUID(), randomUUID()];
  const grants = [randomUUID(), randomUUID()];
  const correlation = randomUUID();
  beforeAll(async () => {
    runtime = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: getTestDatabaseUrl(process.env),
        max: 1,
        connectionTimeoutMillis: 2000,
        statement_timeout: 2000,
        query_timeout: 3000,
      }),
      log: [],
    });
    fixture = await createFixtureClient();
    await verifyRuntimeIdentity(runtime);
    for (let i = 0; i < 3; i++) {
      const userId = users[i];
      const tenantId = tenants[i];
      if (!userId || !tenantId)
        throw new Error('Missing owned fixture identity');
      await fixture.user.create({
        data: {
          id: userId,
          email: `rls-${userId}@example.test`,
          canonicalEmail: `rls-${userId}@example.test`,
          status: 'ACTIVE',
          emailVerifiedAt: new Date('2026-01-01'),
        },
      });
      await fixture.tenant.create({
        data: {
          id: tenantId,
          name: 'Isolated RLS fixture',
          slug: `rls-${tenantId}`,
          status: 'ACTIVE',
        },
      });
      if (i < 2) {
        await fixture.membership.create({
          data: { id: members[i], tenantId, userId },
        });
        await fixture.role.create({
          data: { id: roles[i], tenantId, code: 'OWNER', name: 'OWNER' },
        });
        const roleId = roles[i];
        const membershipId = members[i];
        if (!roleId || !membershipId)
          throw new Error('Missing owned relationship');
        await fixture.rolePermission.create({
          data: { tenantId, roleId, permissionCode: 'tenant.ownership.manage' },
        });
        await fixture.membershipRole.create({
          data: { id: grants[i], tenantId, roleId, membershipId },
        });
      }
    }
  });
  afterAll(async () => {
    if (fixture) {
      await fixture.auditEvent.deleteMany({
        where: { correlationId: correlation },
      });
      await fixture.membershipRole.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await fixture.rolePermission.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await fixture.role.deleteMany({ where: { tenantId: { in: tenants } } });
      await fixture.membership.deleteMany({
        where: { tenantId: { in: tenants } },
      });
      await fixture.tenant.deleteMany({ where: { id: { in: tenants } } });
      await fixture.user.deleteMany({ where: { id: { in: users } } });
      await fixture.$disconnect();
    }
    await runtime?.$disconnect();
  });
  async function scope<T>(
    work: (tx: Tx) => Promise<T>,
    index = 0,
    client = runtime,
  ): Promise<T> {
    const uid = users[index],
      tid = tenants[index],
      mid = members[index] ?? randomUUID();
    if (!uid || !tid) throw new Error('Missing fixture');
    return client.$transaction(
      async (tx) => {
        await identityContext(tx, uid);
        await tenantContext(tx, tid, mid);
        return work(tx);
      },
      { maxWait: 1000, timeout: 5000 },
    );
  }
  async function undone(work: (tx: Tx) => Promise<unknown>) {
    try {
      await scope(async (tx) => {
        await work(tx);
        throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }
  }
  async function denied(work: Promise<unknown>) {
    try {
      await work;
      return false;
    } catch {
      return true;
    }
  }

  it('uses an actual restricted login and rejects the actual fixture identity as runtime', async () => {
    await verifyRuntimeIdentity(runtime);
    await expect(verifyRuntimeIdentity(fixture)).rejects.toBeInstanceOf(
      DatabaseSecurityConfigurationError,
    );
    const r = await runtime.$queryRaw<
      Array<{ login: string; role: string }>
    >`SELECT session_user login,current_user role`;
    expect(r).toEqual([
      { login: 'hanoflow_runtime', role: 'hanoflow_runtime' },
    ]);
  });
  it('has no privileged role membership or fixture development CONNECT', async () => {
    const r = await fixture.$queryRaw<
      Array<{ safe: boolean }>
    >`SELECT NOT has_database_privilege('hanoflow_test_fixture','hanoflow','CONNECT') AND NOT EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.member WHERE r.rolname IN ('hanoflow_runtime','hanoflow_test_fixture')) safe`;
    expect(r[0]?.safe).toBe(true);
  });
  it.each([
    'hanoflow',
    'hanoflow_migrator',
    'hanoflow_bootstrap',
    'hanoflow_test_fixture',
  ])('cannot switch runtime into %s', async (role) => {
    // Closed reviewed literal cases; no dynamic raw SQL API.
    const attempt = () =>
      runtime.$transaction(async (tx) => {
        if (role === 'hanoflow') await tx.$executeRaw`SET LOCAL ROLE hanoflow`;
        if (role === 'hanoflow_migrator')
          await tx.$executeRaw`SET LOCAL ROLE hanoflow_migrator`;
        if (role === 'hanoflow_bootstrap')
          await tx.$executeRaw`SET LOCAL ROLE hanoflow_bootstrap`;
        if (role === 'hanoflow_test_fixture')
          await tx.$executeRaw`SET LOCAL ROLE hanoflow_test_fixture`;
      });
    expect(await denied(attempt())).toBe(true);
  });
  it('enables and forces RLS on exactly twelve application tables with migration ownership', async () => {
    const r = await runtime.$queryRaw<
      Array<{ name: string; enabled: boolean; forced: boolean; owner: string }>
    >`SELECT c.relname name,c.relrowsecurity enabled,c.relforcerowsecurity forced,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'_prisma_migrations' ORDER BY c.relname COLLATE "C"`;
    expect(r.map((x) => x.name)).toEqual(tables);
    expect(
      r.every((x) => x.enabled && x.forced && x.owner === 'hanoflow_migrator'),
    ).toBe(true);
  });
  it('has explicit role/command/predicate policies and no SECURITY DEFINER helper', async () => {
    const p = await runtime.$queryRaw<
      Array<{
        name: string;
        cmd: string;
        roles: string[];
        qual: string | null;
        check: string | null;
      }>
    >`SELECT policyname name,cmd,roles::text[] roles,qual,with_check "check" FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`;
    expect(p.filter((x) => x.name === 'fixture_test_only')).toHaveLength(12);
    expect(p.filter((x) => x.roles.includes('public'))).toHaveLength(0);
    expect(
      p
        .filter((x) => x.roles.includes('hanoflow_runtime'))
        .every((x) => x.cmd !== 'ALL' && (x.qual !== null || x.check !== null)),
    ).toBe(true);
    expect(
      p.find((x) => x.name === 'membership_role_runtime_insert')?.check,
    ).toContain('tenant()');
    expect(
      p.find((x) => x.name === 'membership_runtime_update')?.check,
    ).toContain('tenant()');
    const f = await runtime.$queryRaw<
      Array<{
        name: string;
        definer: boolean;
        config: string[];
        source: string;
      }>
    >`SELECT proname name,prosecdef definer,proconfig config,prosrc source FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='hf_security' ORDER BY proname`;
    expect(f).toHaveLength(4);
    expect(
      f.every((x) => !x.definer && x.config.includes('search_path=pg_catalog')),
    ).toBe(true);
    expect(f.filter((x) => x.source.includes('FROM public.'))).toHaveLength(0);
  });
  it.each(['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000'])(
    'denies invalid/unrelated tenant context %s',
    async (value) => {
      const n = await runtime.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.access_path','tenant',true),set_config('app.tenant_id',${value},true)`;
        return tx.role.count();
      });
      expect(n).toBe(0);
    },
  );
  it('denies missing context and unscoped identity/session/tenant records', async () => {
    expect(await runtime.role.count()).toBe(0);
    expect(await runtime.membership.count()).toBe(0);
    expect(await runtime.session.count()).toBe(0);
    expect(await runtime.accessToken.count()).toBe(0);
    expect(await runtime.refreshToken.count()).toBe(0);
    expect(await runtime.tenant.count()).toBe(0);
  });
  it('scopes unfiltered reads, aggregates, pagination and nested Prisma relations', async () => {
    await scope(async (tx) => {
      expect((await tx.role.findMany()).map((r) => r.tenantId)).toEqual([
        tenants[0],
      ]);
      expect(await tx.role.count()).toBe(1);
      expect((await tx.membership.aggregate({ _count: true }))._count).toBe(1);
      expect(await tx.role.findMany({ skip: 1, take: 1 })).toEqual([]);
      const rows = await tx.membershipRole.findMany({
        include: {
          role: { include: { permissions: true } },
          membership: {
            select: {
              user: {
                select: { id: true, status: true, emailVerifiedAt: true },
              },
            },
          },
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.membership.user.id).toBe(users[0]);
      expect(
        (
          await tx.$queryRaw<
            Array<{ tenantId: string }>
          >`SELECT "tenantId" FROM "Role"`
        ).every((r) => r.tenantId === tenants[0]),
      ).toBe(true);
    });
  });
  it('keeps session-path membership discovery restricted to its identity', async () => {
    await runtime.$transaction(async (tx) => {
      await sessionLookup(tx);
      const id = users[0];
      if (!id) throw rollback;
      await identityContext(tx, id);
      expect((await tx.membership.findMany()).map((m) => m.userId)).toEqual([
        id,
      ]);
      expect(await tx.role.count()).toBe(0);
      expect(await tx.rolePermission.count()).toBe(0);
    });
  });
  it('accepts same-tenant assignment inserts and rejects cross-tenant and nested inserts', async () => {
    await undone(async (tx) => {
      const tenantId = tenants[0],
        membershipId = members[0],
        roleId = roles[0],
        actor = users[0];
      if (!tenantId || !membershipId || !roleId || !actor) throw rollback;
      await tx.membershipRole.updateMany({
        where: { id: grants[0] },
        data: { removedAt: new Date(), removedByUserId: actor },
      });
      await tx.membershipRole.create({
        data: { tenantId, membershipId, roleId, grantedByUserId: actor },
        select: { id: true },
      });
    });
    expect(
      await denied(
        scope((tx) =>
          tx.membershipRole.create({
            data: {
              tenantId: tenants[1] ?? '',
              membershipId: members[1] ?? '',
              roleId: roles[1] ?? '',
              grantedByUserId: users[0],
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      await denied(
        scope((tx) =>
          tx.membership.update({
            where: { id: members[0] },
            data: {
              roles: {
                create: {
                  tenantId: tenants[1] ?? '',
                  roleId: roles[1] ?? '',
                  grantedByUserId: users[0],
                },
              },
            },
          }),
        ),
      ),
    ).toBe(true);
  });
  it('scopes bulk status updates and prevents tenant reassignment, deletion and unauthorized upsert', async () => {
    await undone(async (tx) => {
      expect(
        (await tx.membership.updateMany({ data: { status: 'SUSPENDED' } }))
          .count,
      ).toBe(1);
    });
    expect(
      await denied(
        scope((tx) =>
          tx.membership.update({
            where: { id: members[0] },
            data: { tenantId: tenants[1] },
          }),
        ),
      ),
    ).toBe(true);
    expect(await denied(scope((tx) => tx.membership.deleteMany()))).toBe(true);
    expect(
      await denied(
        scope((tx) =>
          tx.role.upsert({
            where: {
              tenantId_code: { tenantId: tenants[1] ?? '', code: 'OWNER' },
            },
            create: {
              tenantId: tenants[1] ?? '',
              code: 'OWNER',
              name: 'Rejected',
            },
            update: { name: 'Rejected' },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      (
        await fixture.membership.findUniqueOrThrow({
          where: { id: members[1] },
        })
      ).status,
    ).toBe('ACTIVE');
  });
  it.each([0, 2])(
    'locks User/Tenant but prevents primary identifier changes (fixture %i)',
    async (i) => {
      await scope(async (tx) => {
        const uid = users[i],
          tid = tenants[i];
        expect(
          await tx.$queryRaw`SELECT id FROM "User" WHERE id=${uid}::uuid FOR UPDATE`,
        ).toHaveLength(1);
        expect(
          await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${tid}::uuid FOR SHARE`,
        ).toHaveLength(1);
        await tx.$executeRaw`UPDATE "User" SET id=id WHERE id=${uid}::uuid`;
        await tx.$executeRaw`UPDATE "Tenant" SET id=id WHERE id=${tid}::uuid`;
      }, i);
      expect(
        await denied(
          scope(
            (tx) =>
              tx.$executeRaw`UPDATE "User" SET id=${randomUUID()}::uuid WHERE id=${users[i]}::uuid`,
            i,
          ),
        ),
      ).toBe(true);
      expect(
        await denied(
          scope(
            (tx) =>
              tx.$executeRaw`UPDATE "Tenant" SET id=${randomUUID()}::uuid WHERE id=${tenants[i]}::uuid`,
            i,
          ),
        ),
      ).toBe(true);
      expect(await fixture.user.count({ where: { id: users[i] } })).toBe(1);
      expect(await fixture.tenant.count({ where: { id: tenants[i] } })).toBe(1);
    },
  );
  it('rejects conflicting tenant bindings in the same transaction', async () => {
    await expect(
      scope(async (tx) => {
        await tenantContext(tx, tenants[1] ?? '', members[1] ?? '');
      }),
    ).rejects.toThrow('Conflicting database context');
  });
  it.each(['commit', 'rollback', 'exception', 'timeout'])(
    'clears context on the same backend after %s',
    async (end) => {
      const first = await runtime.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() pid`;
      try {
        await runtime.$transaction(
          async (tx) => {
            await identityContext(tx, users[0] ?? '');
            await tenantContext(tx, tenants[0] ?? '', members[0] ?? '');
            expect(
              (
                await tx.$queryRaw<
                  Array<{ pid: number }>
                >`SELECT pg_backend_pid() pid`
              )[0]?.pid,
            ).toBe(first[0]?.pid);
            expect(await tx.role.count()).toBe(1);
            if (end === 'rollback' || end === 'exception') throw rollback;
            if (end === 'timeout') await tx.$queryRaw`SELECT pg_sleep(0.3)`;
          },
          { maxWait: 1000, timeout: end === 'timeout' ? 100 : 5000 },
        );
        expect(end).toBe('commit');
      } catch (e) {
        if (end === 'commit') throw e;
      }
      const next = await runtime.$transaction(async (tx) => ({
        pid: (
          await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() pid`
        )[0]?.pid,
        count: await tx.role.count(),
      }));
      expect(next.pid).toBe(first[0]?.pid);
      expect(next.count).toBe(0);
      expect(await scope((tx) => tx.role.findMany(), 1)).toEqual([
        expect.objectContaining({ tenantId: tenants[1] }),
      ]);
    },
  );
  it('supports concurrent tenants without mutable shared context', async () => {
    const other = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: getTestDatabaseUrl(process.env),
        max: 1,
        connectionTimeoutMillis: 2000,
        statement_timeout: 2000,
        query_timeout: 3000,
      }),
      log: [],
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timer = setTimeout(() => release?.(), 2000);
    let entered = 0;
    async function read(tx: Tx) {
      entered++;
      if (entered === 2) release?.();
      await gate;
      expect(entered).toBe(2);
      return {
        pid: (
          await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() pid`
        )[0]?.pid,
        rows: await tx.role.findMany(),
      };
    }
    try {
      await verifyRuntimeIdentity(other);
      const [a, b] = await Promise.all([scope(read, 0), scope(read, 1, other)]);
      expect(a.pid).not.toBe(b.pid);
      expect(a.rows.every((r) => r.tenantId === tenants[0])).toBe(true);
      expect(b.rows.every((r) => r.tenantId === tenants[1])).toBe(true);
    } finally {
      clearTimeout(timer);
      await other.$disconnect();
    }
  });
  it('allows scoped audit insert without RETURNING and denies global/cross-tenant reads and mutations', async () => {
    await scope((tx) =>
      tx.auditEvent.createMany({
        data: {
          scope: 'TENANT',
          tenantId: tenants[0],
          actorUserId: users[0],
          action: 'tenant.role_assigned',
          targetType: 'Membership',
          targetId: members[0],
          outcome: 'SUCCESS',
          correlationId: correlation,
        },
      }),
    );
    expect(
      await fixture.auditEvent.count({ where: { correlationId: correlation } }),
    ).toBe(1);
    expect(await denied(scope((tx) => tx.auditEvent.findMany()))).toBe(true);
    expect(
      await denied(
        scope((tx) =>
          tx.auditEvent.updateMany({
            where: { correlationId: correlation },
            data: { action: 'Rejected' },
          }),
        ),
      ),
    ).toBe(true);
    expect(
      await denied(
        scope((tx) =>
          tx.auditEvent.deleteMany({ where: { correlationId: correlation } }),
        ),
      ),
    ).toBe(true);
    expect(
      await denied(
        scope((tx) =>
          tx.auditEvent.createMany({
            data: {
              scope: 'TENANT',
              tenantId: tenants[1],
              actorUserId: users[0],
              action: 'tenant.role_assigned',
              targetType: 'Membership',
              outcome: 'SUCCESS',
              correlationId: correlation,
            },
          }),
        ),
      ),
    ).toBe(true);
  });
  it('denies DDL, migration writes, credential access, catalog mutation and TRUNCATE', async () => {
    expect(
      await denied(
        runtime.$transaction(async (tx) => {
          await tx.$executeRaw`ALTER TABLE "Role" DISABLE ROW LEVEL SECURITY`;
          throw rollback;
        }),
      ),
    ).toBe(true);
    expect(
      await denied(
        runtime.$transaction(async (tx) => {
          await tx.$executeRaw`DROP POLICY role_runtime_select ON "Role"`;
          throw rollback;
        }),
      ),
    ).toBe(true);
    expect(
      await denied(
        runtime.$transaction(async (tx) => {
          await tx.$executeRaw`CREATE TABLE public.rls_rejected_probe (id uuid)`;
          throw rollback;
        }),
      ),
    ).toBe(true);
    expect(
      await denied(
        runtime.$transaction(async (tx) => {
          await tx.$executeRaw`TRUNCATE "Role"`;
          throw rollback;
        }),
      ),
    ).toBe(true);
    expect(
      await denied(runtime.$queryRaw`SELECT * FROM "_prisma_migrations"`),
    ).toBe(true);
    expect(await denied(runtime.passwordCredential.count())).toBe(true);
    expect(
      await denied(
        runtime.permission.updateMany({ data: { description: 'Rejected' } }),
      ),
    ).toBe(true);
    expect(await runtime.permission.count()).toBe(5);
  });
});
