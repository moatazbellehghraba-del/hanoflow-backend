import 'reflect-metadata';
import './setup-database-env.js';
import { createFixtureClient } from './helpers/database-fixture.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { AuthorizationModule } from '../src/modules/authorization/authorization.module.js';
import {
  AuthorizationService,
  AuthorizationDenied,
  AuthorizationOperationError,
} from '../src/modules/authorization/authorization.service.js';
import { RoleProvisioner } from '../src/modules/authorization/role-provisioner.service.js';
import {
  ROLE_MATRIX,
  PERMISSIONS,
  type TemplateCode,
} from '../src/modules/authorization/permission.catalog.js';
import {
  SessionsService,
  SessionOperationError,
  type IssuedSession,
} from '../src/modules/sessions/sessions.service.js';
import { TenantAuditWriter } from '../src/modules/audit/tenant-audit.writer.js';
import { getTestDatabaseUrl } from './helpers/database-target.js';

describe('RBAC and trusted tenant context (guarded real PostgreSQL)', () => {
  let app: TestingModule;
  let otherApp: TestingModule;
  let db: PrismaClient;
  let secondDb: PrismaClient;
  let auth: AuthorizationService;
  let otherAuth: AuthorizationService;
  let sessions: SessionsService;
  let otherSessions: SessionsService;
  let provision: RoleProvisioner;
  const users = new Set<string>();
  const tenants = new Set<string>();
  const correlations = new Set<string>();
  const correlation = () => {
    const id = randomUUID();
    correlations.add(id);
    return id;
  };
  beforeAll(async () => {
    const url = getTestDatabaseUrl(process.env);
    async function application() {
      const module = await Test.createTestingModule({
        imports: [AuthorizationModule],
      })
        .overrideProvider(ConfigService)
        .useValue(new ConfigService({ DATABASE_URL: url }))
        .compile();
      await module.init();
      return module;
    }
    app = await application();
    otherApp = await application();
    db = await createFixtureClient();
    secondDb = await createFixtureClient();
    auth = app.get(AuthorizationService);
    otherAuth = otherApp.get(AuthorizationService);
    sessions = app.get(SessionsService);
    otherSessions = otherApp.get(SessionsService);
    provision = app.get(RoleProvisioner);
    expect(
      await db.$queryRaw<
        Array<{ name: string }>
      >`SELECT current_database() AS name`,
    ).toEqual([{ name: 'hanoflow_test' }]);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const owned = [...users];
    const tenantIds = [...tenants];
    const ownedSessions = await db.session.findMany({
      where: { userId: { in: owned } },
      select: { id: true },
    });
    const ids = ownedSessions.map((row) => row.id);
    await db.$transaction([
      db.auditEvent.deleteMany({
        where: { correlationId: { in: [...correlations] } },
      }),
      db.accessToken.deleteMany({ where: { sessionId: { in: ids } } }),
      db.refreshToken.updateMany({
        where: { sessionId: { in: ids } },
        data: { predecessorId: null },
      }),
      db.refreshToken.deleteMany({ where: { sessionId: { in: ids } } }),
      db.session.deleteMany({ where: { id: { in: ids } } }),
      db.membershipRole.deleteMany({ where: { tenantId: { in: tenantIds } } }),
      db.rolePermission.deleteMany({ where: { tenantId: { in: tenantIds } } }),
      db.role.deleteMany({ where: { tenantId: { in: tenantIds } } }),
      db.membership.deleteMany({ where: { tenantId: { in: tenantIds } } }),
      db.tenant.deleteMany({ where: { id: { in: tenantIds } } }),
      db.user.deleteMany({ where: { id: { in: owned } } }),
    ]);
    users.clear();
    tenants.clear();
    correlations.clear();
  });
  afterAll(async () => {
    await secondDb?.$disconnect();
    await db?.$disconnect();
    await otherApp?.close();
    await app?.close();
  });
  function user(data: Partial<Prisma.UserUncheckedCreateInput> = {}) {
    const id = randomUUID();
    users.add(id);
    const email = `task25-${id}@example.test`;
    return db.user.create({
      data: {
        id,
        email,
        canonicalEmail: email,
        status: 'ACTIVE',
        emailVerifiedAt: new Date('2026-01-01'),
        ...data,
      },
    });
  }
  async function fixture() {
    const owner = await user();
    const id = randomUUID();
    tenants.add(id);
    const corr = correlation();
    const member = await db.$transaction(async (tx) => {
      await tx.tenant.create({
        data: { id, name: 'Synthetic RBAC tenant', slug: `task25-${id}` },
      });
      await provision.provisionIn(tx, id, corr);
      const member = await tx.membership.create({
        data: { tenantId: id, userId: owner.id },
      });
      const role = await tx.role.findUniqueOrThrow({
        where: { tenantId_code: { tenantId: id, code: 'OWNER' } },
      });
      await tx.membershipRole.create({
        data: { tenantId: id, membershipId: member.id, roleId: role.id },
      });
      await tx.tenant.update({ where: { id }, data: { status: 'ACTIVE' } });
      await auth.assertOwnerInvariantIn(tx, id);
      return member;
    });
    return { id, owner, member };
  }
  async function addMember(
    tenantId: string,
    role: TemplateCode = 'DISPATCHER',
  ) {
    const person = await user();
    const member = await db.membership.create({
      data: { tenantId, userId: person.id },
    });
    const storedRole = await roleFor(tenantId, role);
    await db.membershipRole.create({
      data: { tenantId, membershipId: member.id, roleId: storedRole.id },
    });
    return { person, member };
  }
  function roleFor(tenantId: string, code: TemplateCode) {
    return db.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code } },
    });
  }
  function issuance(
    value: Awaited<ReturnType<SessionsService['establish']>>,
  ): IssuedSession {
    if (value.status !== 'issued')
      throw new Error('Expected synthetic issuance');
    return value;
  }
  async function selected(
    userId: string,
    tenantId: string,
    service = sessions,
  ) {
    const initial = issuance(
      await service.establish({ userId }, 'BROWSER', correlation()),
    );
    return {
      initial,
      selected: issuance(
        await service.selectTenant(
          initial.accessToken,
          initial.refreshToken,
          tenantId,
          correlation(),
        ),
      ),
    };
  }
  async function context(
    userId: string,
    tenantId: string,
    service = sessions,
    authorization = auth,
  ) {
    const tokens = await selected(userId, tenantId, service);
    const context = await authorization.resolve(
      tokens.selected.accessToken,
      tenantId,
    );
    if (!context) throw new Error('Expected trusted context');
    return { context, ...tokens };
  }
  async function code(operation: Promise<unknown>) {
    try {
      await operation;
      return 'SUCCESS';
    } catch (error) {
      return error instanceof Prisma.PrismaClientKnownRequestError
        ? error.code
        : 'REJECTED';
    }
  }

  it('uses independent actual PostgreSQL backend connections', async () => {
    const firstRuntime = app.get(PrismaService);
    const secondRuntime = otherApp.get(PrismaService);
    const [a, b] = await Promise.all([
      firstRuntime.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`,
      secondRuntime.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid() AS pid`,
    ]);
    expect(a[0]?.pid !== b[0]?.pid).toBe(true);
  });
  it('persists exactly the system permission catalog and deterministic tenant templates', async () => {
    const f = await fixture();
    expect(
      (
        await db.permission.findMany({
          orderBy: { code: 'asc' },
          select: { code: true },
        })
      ).map((row) => row.code),
    ).toEqual([...PERMISSIONS].sort());
    const rows = await db.role.findMany({
      where: { tenantId: f.id },
      include: { permissions: true },
    });
    expect(rows.length).toBe(7);
    for (const role of rows)
      expect(role.permissions.map((row) => row.permissionCode).sort()).toEqual(
        [...ROLE_MATRIX[role.code]].sort(),
      );
  });
  it('provisions idempotently without overwriting semantics or repeating audit', async () => {
    const f = await fixture();
    expect(
      await db.$transaction((tx) =>
        provision.provisionIn(tx, f.id, correlation()),
      ),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { tenantId: f.id, action: 'tenant.roles_provisioned' },
      }),
    ).toBe(1);
  });
  it('detects predefined mapping drift rather than silently repairing it', async () => {
    const f = await fixture();
    const role = await roleFor(f.id, 'ADMIN');
    await db.rolePermission.deleteMany({
      where: {
        tenantId: f.id,
        roleId: role.id,
        permissionCode: 'tenant.roles.read',
      },
    });
    expect(
      await code(
        db.$transaction((tx) => provision.provisionIn(tx, f.id, correlation())),
      ),
    ).not.toBe('SUCCESS');
    expect(
      await db.rolePermission.count({
        where: {
          tenantId: f.id,
          roleId: role.id,
          permissionCode: 'tenant.roles.read',
        },
      }),
    ).toBe(0);
  });
  it('allows same role code across tenants but rejects duplicate codes within one', async () => {
    const a = await fixture();
    const b = await fixture();
    expect(
      (await roleFor(a.id, 'OWNER')).id !== (await roleFor(b.id, 'OWNER')).id,
    ).toBe(true);
    expect(
      await code(
        db.role.create({
          data: { tenantId: a.id, code: 'OWNER', name: 'Duplicate' },
        }),
      ),
    ).toBe('P2002');
  });
  it('enforces cross-tenant membership/role and role/permission foreign keys', async () => {
    const a = await fixture();
    const b = await fixture();
    const role = await roleFor(b.id, 'ADMIN');
    expect(
      await code(
        db.membershipRole.create({
          data: { tenantId: a.id, membershipId: a.member.id, roleId: role.id },
        }),
      ),
    ).toBe('P2003');
    expect(
      await code(
        db.rolePermission.create({
          data: {
            tenantId: a.id,
            roleId: role.id,
            permissionCode: 'tenant.roles.read',
          },
        }),
      ),
    ).toBe('P2003');
  });
  it('rejects duplicate mappings, active grants and unsafe permission scope', async () => {
    const f = await fixture();
    const role = await roleFor(f.id, 'OWNER');
    expect(
      await code(
        db.membershipRole.create({
          data: { tenantId: f.id, membershipId: f.member.id, roleId: role.id },
        }),
      ),
    ).toBe('P2002');
    expect(
      await code(
        db.rolePermission.create({
          data: {
            tenantId: f.id,
            roleId: role.id,
            permissionCode: 'tenant.roles.read',
          },
        }),
      ),
    ).toBe('P2002');
    expect(
      await code(
        db.permission.create({
          data: {
            code: 'platform.admin',
            description: 'Rejected synthetic permission',
          },
        }),
      ),
    ).not.toBe('SUCCESS');
    expect(
      await code(
        db.$executeRaw`INSERT INTO "Permission" (code,scope,description) VALUES (${'tenant.fake'},${'PLATFORM'}::"PermissionScope",${'Rejected'})`,
      ),
    ).not.toBe('SUCCESS');
  });
  it('prevents owner-role deactivation and destructive deletion of referenced roles', async () => {
    const f = await fixture();
    const role = await roleFor(f.id, 'OWNER');
    expect(
      await code(
        db.role.update({
          where: { id: role.id },
          data: { status: 'INACTIVE' },
        }),
      ),
    ).not.toBe('SUCCESS');
    expect(await code(db.role.delete({ where: { id: role.id } }))).toBe(
      'P2003',
    );
  });
  it('preserves identity-only sessions and requires explicit authorized tenant selection', async () => {
    const f = await fixture();
    const initial = issuance(
      await sessions.establish(
        { userId: f.owner.id },
        'BROWSER',
        correlation(),
      ),
    );
    expect((await sessions.validateAccess(initial.accessToken)).status).toBe(
      'valid',
    );
    expect(await auth.resolve(initial.accessToken, f.id)).toBeUndefined();
    const result = issuance(
      await sessions.selectTenant(
        initial.accessToken,
        initial.refreshToken,
        f.id,
        correlation(),
      ),
    );
    const verified = await sessions.validateAccess(result.accessToken);
    expect(verified.status).toBe('valid');
    if (verified.status !== 'valid') throw new Error('Expected validation');
    expect(verified.scope).toBe('TENANT');
    expect(verified.tenantId).toBe(f.id);
    expect(verified.membershipId).toBe(f.member.id);
    expect(verified.contextVersion).toBe(2);
  });
  it('requires both current credentials from the same eligible session', async () => {
    const f = await fixture();
    const a = issuance(
      await sessions.establish(
        { userId: f.owner.id },
        'BROWSER',
        correlation(),
      ),
    );
    const b = issuance(
      await sessions.establish(
        { userId: f.owner.id },
        'BROWSER',
        correlation(),
      ),
    );
    expect(
      (
        await sessions.selectTenant(
          a.accessToken,
          b.refreshToken,
          f.id,
          correlation(),
        )
      ).status,
    ).toBe('invalid');
    expect(
      (
        await sessions.selectTenant(
          a.accessToken,
          'malformed',
          f.id,
          correlation(),
        )
      ).status,
    ).toBe('invalid');
    expect((await sessions.validateAccess(a.accessToken)).status).toBe('valid');
  });
  it('does not reveal non-member tenants or accept arbitrary selectors', async () => {
    const a = await fixture();
    const b = await fixture();
    const initial = issuance(
      await sessions.establish(
        { userId: a.owner.id },
        'BROWSER',
        correlation(),
      ),
    );
    expect(
      (
        await sessions.selectTenant(
          initial.accessToken,
          initial.refreshToken,
          b.id,
          correlation(),
        )
      ).status,
    ).toBe('invalid');
    expect(
      (
        await sessions.selectTenant(
          initial.accessToken,
          initial.refreshToken,
          randomUUID(),
          correlation(),
        )
      ).status,
    ).toBe('invalid');
    expect(
      (
        await sessions.selectTenant(
          initial.accessToken,
          initial.refreshToken,
          'invalid',
          correlation(),
        )
      ).status,
    ).toBe('invalid');
    expect(await auth.resolve(initial.accessToken, b.id)).toBeUndefined();
  });
  it('invalidates previous access and preserves strict consumed refresh replay', async () => {
    const f = await fixture();
    const value = await selected(f.owner.id, f.id);
    expect(
      (await sessions.validateAccess(value.initial.accessToken)).status,
    ).toBe('invalid');
    expect(
      (await sessions.refresh(value.initial.refreshToken, correlation()))
        .status,
    ).toBe('replay');
    expect(
      (await sessions.validateAccess(value.selected.accessToken)).status,
    ).toBe('invalid');
  });
  it('preserves absolute lifetime and increments version on each selected context', async () => {
    const a = await fixture();
    const b = await fixture();
    await db.membership.create({
      data: { tenantId: b.id, userId: a.owner.id },
    });
    const value = await selected(a.owner.id, a.id);
    const before = await db.session.findUniqueOrThrow({
      where: { id: value.selected.sessionId },
    });
    const next = issuance(
      await sessions.selectTenant(
        value.selected.accessToken,
        value.selected.refreshToken,
        b.id,
        correlation(),
      ),
    );
    const after = await db.session.findUniqueOrThrow({
      where: { id: next.sessionId },
    });
    expect(after.absoluteExpiresAt).toEqual(before.absoluteExpiresAt);
    expect(after.contextVersion).toBe(3);
    expect(after.tenantId).toBe(b.id);
    expect(
      (await sessions.validateAccess(value.selected.accessToken)).status,
    ).toBe('invalid');
  });
  it('rolls back context and credential changes if transactional audit fails', async () => {
    const f = await fixture();
    const initial = issuance(
      await sessions.establish(
        { userId: f.owner.id },
        'BROWSER',
        correlation(),
      ),
    );
    jest
      .spyOn(app.get(TenantAuditWriter), 'write')
      .mockRejectedValue(new Error('Synthetic audit failure'));
    await expect(
      sessions.selectTenant(
        initial.accessToken,
        initial.refreshToken,
        f.id,
        correlation(),
      ),
    ).rejects.toBeInstanceOf(SessionOperationError);
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: initial.sessionId } }))
        .scope,
    ).toBe('IDENTITY');
    expect(
      await db.refreshToken.count({
        where: { sessionId: initial.sessionId, consumedAt: null },
      }),
    ).toBe(1);
    expect((await sessions.validateAccess(initial.accessToken)).status).toBe(
      'valid',
    );
  });
  it('rejects inconsistent session membership/user/tenant and partial context fields', async () => {
    const a = await fixture();
    const b = await fixture();
    const initial = issuance(
      await sessions.establish(
        { userId: a.owner.id },
        'BROWSER',
        correlation(),
      ),
    );
    expect(
      await code(
        db.session.update({
          where: { id: initial.sessionId },
          data: { scope: 'TENANT', tenantId: a.id, membershipId: b.member.id },
        }),
      ),
    ).toBe('P2003');
    expect(
      await code(
        db.session.update({
          where: { id: initial.sessionId },
          data: { scope: 'TENANT', tenantId: a.id },
        }),
      ),
    ).not.toBe('SUCCESS');
    expect(
      await code(
        db.session.update({
          where: { id: initial.sessionId },
          data: { tenantId: a.id },
        }),
      ),
    ).not.toBe('SUCCESS');
  });
  it('mints frozen runtime-proven contexts and rejects forged/cross-tenant objects', async () => {
    const f = await fixture();
    const value = await context(f.owner.id, f.id);
    expect(
      Object.isFrozen(value.context) &&
        Object.isFrozen(value.context.permissions),
    ).toBe(true);
    expect(Reflect.set(value.context, 'tenantId', randomUUID())).toBe(false);
    expect(
      await auth.has({ ...value.context }, f.id, 'tenant.roles.read'),
    ).toBe(false);
    expect(
      await auth.has(value.context, randomUUID(), 'tenant.roles.read'),
    ).toBe(false);
    expect(
      await auth.has(
        { userId: f.owner.id, permissions: PERMISSIONS },
        f.id,
        'tenant.roles.read',
      ),
    ).toBe(false);
    expect(
      JSON.stringify(value.context).includes(value.selected.accessToken),
    ).toBe(false);
  });
  it('resolves role unions, deduplicates and supports explicit all-of/any-of', async () => {
    const f = await fixture();
    const member = await addMember(f.id, 'ADMIN');
    const role = await roleFor(f.id, 'DISPATCHER');
    await db.membershipRole.create({
      data: { tenantId: f.id, membershipId: member.member.id, roleId: role.id },
    });
    const value = await context(member.person.id, f.id);
    expect((await auth.resolveEffective(value.context, f.id)).length).toBe(4);
    expect(
      await auth.checkSet(
        value.context,
        f.id,
        ['tenant.roles.read', 'tenant.ownership.manage'],
        'all',
      ),
    ).toBe(false);
    expect(
      await auth.checkSet(
        value.context,
        f.id,
        ['tenant.roles.read', 'tenant.ownership.manage'],
        'any',
      ),
    ).toBe(true);
    expect(await auth.checkSet(value.context, f.id, [], 'all')).toBe(false);
    expect(await auth.has(value.context, f.id, '*')).toBe(false);
    await expect(
      auth.require(value.context, f.id, 'tenant.ownership.manage'),
    ).rejects.toBeInstanceOf(AuthorizationDenied);
  });
  it('gives future business templates no implicit operational or financial authority', async () => {
    const f = await fixture();
    const member = await addMember(f.id, 'FINANCE_OFFICER');
    const value = await context(member.person.id, f.id);
    expect(await auth.resolveEffective(value.context, f.id)).toEqual([]);
    expect(await auth.has(value.context, f.id, 'finance.settle')).toBe(false);
  });
  it('does not trust role names or tampered mappings as universal grants', async () => {
    const f = await fixture();
    const member = await addMember(f.id, 'ADMIN');
    const role = await roleFor(f.id, 'ADMIN');
    await db.rolePermission.create({
      data: {
        tenantId: f.id,
        roleId: role.id,
        permissionCode: 'tenant.ownership.manage',
      },
    });
    const value = await context(member.person.id, f.id);
    expect(await auth.has(value.context, f.id, 'tenant.ownership.manage')).toBe(
      false,
    );
    await db.rolePermission.deleteMany({
      where: {
        tenantId: f.id,
        roleId: role.id,
        permissionCode: 'tenant.roles.read',
      },
    });
    expect(await auth.has(value.context, f.id, 'tenant.roles.read')).toBe(
      false,
    );
  });
  it.each(['SUSPENDED', 'REMOVED'] as const)(
    'denies current %s membership',
    async (status) => {
      const f = await fixture();
      const member = await addMember(f.id, 'ADMIN');
      const value = await context(member.person.id, f.id);
      await db.membership.update({
        where: { id: member.member.id },
        data: { status, removedAt: status === 'REMOVED' ? new Date() : null },
      });
      expect(await auth.has(value.context, f.id, 'tenant.roles.read')).toBe(
        false,
      );
      expect(
        (await sessions.refresh(value.selected.refreshToken, correlation()))
          .status,
      ).toBe('invalid');
    },
  );
  it('denies suspended user, ineligible tenant, inactive role and revoked session', async () => {
    const f = await fixture();
    const member = await addMember(f.id, 'ADMIN');
    const value = await context(member.person.id, f.id);
    const role = await roleFor(f.id, 'ADMIN');
    await db.role.update({
      where: { id: role.id },
      data: { status: 'INACTIVE' },
    });
    expect(await auth.has(value.context, f.id, 'tenant.roles.read')).toBe(
      false,
    );
    await db.role.update({
      where: { id: role.id },
      data: { status: 'ACTIVE' },
    });
    await db.user.update({
      where: { id: member.person.id },
      data: { status: 'SUSPENDED' },
    });
    expect(await auth.has(value.context, f.id, 'tenant.roles.read')).toBe(
      false,
    );
    await db.user.update({
      where: { id: member.person.id },
      data: { status: 'ACTIVE' },
    });
    await db.tenant.update({
      where: { id: f.id },
      data: { status: 'SUSPENDED' },
    });
    expect(await auth.has(value.context, f.id, 'tenant.roles.read')).toBe(
      false,
    );
    await db.tenant.update({ where: { id: f.id }, data: { status: 'ACTIVE' } });
    await sessions.revoke(
      { userId: member.person.id },
      value.selected.sessionId,
      correlation(),
    );
    expect(await auth.has(value.context, f.id, 'tenant.roles.read')).toBe(
      false,
    );
  });
  it('keeps different tenant roles separate for one global user', async () => {
    const a = await fixture();
    const b = await fixture();
    await db.membership.create({
      data: { tenantId: b.id, userId: a.owner.id },
    });
    const first = await context(a.owner.id, a.id);
    const second = await context(a.owner.id, b.id);
    expect(await auth.has(first.context, a.id, 'tenant.ownership.manage')).toBe(
      true,
    );
    expect(await auth.has(second.context, b.id, 'tenant.roles.read')).toBe(
      false,
    );
  });
  it('assigns/removes/reassigns with preserved history and deliberate idempotence', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    const target = await addMember(f.id);
    const role = await roleFor(f.id, 'ADMIN');
    expect(
      (
        await auth.changeRole(
          actor.context,
          f.id,
          target.member.id,
          role.id,
          'assign',
          correlation(),
        )
      ).status,
    ).toBe('changed');
    const targetContext = await context(target.person.id, f.id);
    expect(
      await auth.has(targetContext.context, f.id, 'tenant.roles.read'),
    ).toBe(true);
    expect(
      (
        await auth.changeRole(
          actor.context,
          f.id,
          target.member.id,
          role.id,
          'assign',
          correlation(),
        )
      ).status,
    ).toBe('unchanged');
    expect(
      (
        await auth.changeRole(
          actor.context,
          f.id,
          target.member.id,
          role.id,
          'remove',
          correlation(),
        )
      ).status,
    ).toBe('changed');
    expect(
      await auth.has(targetContext.context, f.id, 'tenant.roles.read'),
    ).toBe(false);
    expect(
      (
        await auth.changeRole(
          actor.context,
          f.id,
          target.member.id,
          role.id,
          'remove',
          correlation(),
        )
      ).status,
    ).toBe('unchanged');
    await auth.changeRole(
      actor.context,
      f.id,
      target.member.id,
      role.id,
      'assign',
      correlation(),
    );
    const history = await db.membershipRole.findMany({
      where: {
        tenantId: f.id,
        membershipId: target.member.id,
        roleId: role.id,
      },
    });
    expect(history.length).toBe(2);
    expect(history.filter((row) => row.removedAt === null).length).toBe(1);
    expect(history.every((row) => row.grantedByUserId === f.owner.id)).toBe(
      true,
    );
  });
  it('prevents self-promotion, cross-tenant management and ordinary ADMIN ownership delegation', async () => {
    const f = await fixture();
    const b = await fixture();
    const admin = await addMember(f.id, 'ADMIN');
    const target = await addMember(f.id);
    const actor = await context(admin.person.id, f.id);
    const ownerRole = await roleFor(f.id, 'OWNER');
    const adminRole = await roleFor(f.id, 'ADMIN');
    expect(
      (
        await auth.changeRole(
          actor.context,
          f.id,
          target.member.id,
          ownerRole.id,
          'assign',
          correlation(),
        )
      ).status,
    ).toBe('denied');
    expect(
      (
        await auth.changeRole(
          actor.context,
          f.id,
          admin.member.id,
          adminRole.id,
          'assign',
          correlation(),
        )
      ).status,
    ).toBe('denied');
    expect(
      (
        await auth.changeRole(
          actor.context,
          b.id,
          b.member.id,
          (await roleFor(b.id, 'ADMIN')).id,
          'assign',
          correlation(),
        )
      ).status,
    ).toBe('denied');
    expect(
      (
        await auth.changeRole(
          { ...actor.context, userId: f.owner.id },
          f.id,
          target.member.id,
          ownerRole.id,
          'assign',
          correlation(),
        )
      ).status,
    ).toBe('denied');
  });
  it('rechecks delegation and actor authority from the database inside the transaction', async () => {
    const f = await fixture();
    const admin = await addMember(f.id, 'ADMIN');
    const target = await addMember(f.id);
    const actor = await context(admin.person.id, f.id);
    const role = await roleFor(f.id, 'ADMIN');
    await db.membershipRole.updateMany({
      where: { tenantId: f.id, membershipId: admin.member.id, removedAt: null },
      data: {
        removedAt: new Date(Date.now() + 100),
        removedByUserId: f.owner.id,
      },
    });
    expect(
      (
        await auth.changeRole(
          actor.context,
          f.id,
          target.member.id,
          role.id,
          'assign',
          correlation(),
        )
      ).status,
    ).toBe('denied');
  });
  it('supports multiple owners and prevents removal of the final eligible owner', async () => {
    const f = await fixture();
    const another = await addMember(f.id, 'OWNER');
    const ownerRole = await roleFor(f.id, 'OWNER');
    const first = await context(f.owner.id, f.id);
    const second = await context(another.person.id, f.id);
    expect(
      (
        await auth.changeRole(
          first.context,
          f.id,
          f.member.id,
          ownerRole.id,
          'remove',
          correlation(),
        )
      ).status,
    ).toBe('changed');
    expect(
      (
        await auth.changeRole(
          second.context,
          f.id,
          another.member.id,
          ownerRole.id,
          'remove',
          correlation(),
        )
      ).status,
    ).toBe('denied');
  });
  it.each(['suspended-user', 'unverified', 'suspended-membership'] as const)(
    'excludes %s from eligible owner count',
    async (scenario) => {
      const f = await fixture();
      const another = await addMember(f.id, 'OWNER');
      const actor = await context(f.owner.id, f.id);
      if (scenario === 'suspended-user')
        await db.user.update({
          where: { id: another.person.id },
          data: { status: 'SUSPENDED' },
        });
      if (scenario === 'unverified')
        await db.user.update({
          where: { id: another.person.id },
          data: { emailVerifiedAt: null },
        });
      if (scenario === 'suspended-membership')
        await db.membership.update({
          where: { id: another.member.id },
          data: { status: 'SUSPENDED' },
        });
      expect(
        (
          await auth.changeRole(
            actor.context,
            f.id,
            f.member.id,
            (await roleFor(f.id, 'OWNER')).id,
            'remove',
            correlation(),
          )
        ).status,
      ).toBe('denied');
    },
  );
  it('protects owner membership suspension/removal without globally suspending the user', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    expect(
      (
        await auth.changeMembershipStatus(
          actor.context,
          f.id,
          f.member.id,
          'SUSPENDED',
          correlation(),
        )
      ).status,
    ).toBe('denied');
    expect(
      (
        await auth.changeMembershipStatus(
          actor.context,
          f.id,
          f.member.id,
          'REMOVED',
          correlation(),
        )
      ).status,
    ).toBe('denied');
    const another = await addMember(f.id, 'OWNER');
    expect(
      (
        await auth.changeMembershipStatus(
          actor.context,
          f.id,
          another.member.id,
          'SUSPENDED',
          correlation(),
        )
      ).status,
    ).toBe('changed');
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: another.person.id } }))
        .status,
    ).toBe('ACTIVE');
  });
  it('retains removal history and does not resurrect grants on same-row reactivation', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    const target = await addMember(f.id, 'ADMIN');
    expect(
      (
        await auth.changeMembershipStatus(
          actor.context,
          f.id,
          target.member.id,
          'REMOVED',
          correlation(),
        )
      ).status,
    ).toBe('changed');
    expect(
      (
        await auth.changeMembershipStatus(
          actor.context,
          f.id,
          target.member.id,
          'SUSPENDED',
          correlation(),
        )
      ).status,
    ).toBe('denied');
    expect(
      (
        await auth.changeMembershipStatus(
          actor.context,
          f.id,
          target.member.id,
          'ACTIVE',
          correlation(),
        )
      ).status,
    ).toBe('changed');
    expect(
      await db.membershipRole.count({
        where: {
          tenantId: f.id,
          membershipId: target.member.id,
          removedAt: null,
        },
      }),
    ).toBe(0);
  });
  it('serializes simultaneous owner removals across independent app connections', async () => {
    const f = await fixture();
    const another = await addMember(f.id, 'OWNER');
    const a = await context(f.owner.id, f.id);
    const b = await context(another.person.id, f.id, otherSessions, otherAuth);
    const role = await roleFor(f.id, 'OWNER');
    const results = await Promise.all([
      auth.changeRole(
        a.context,
        f.id,
        f.member.id,
        role.id,
        'remove',
        correlation(),
      ),
      otherAuth.changeRole(
        b.context,
        f.id,
        another.member.id,
        role.id,
        'remove',
        correlation(),
      ),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual([
      'changed',
      'denied',
    ]);
    expect(
      await db.membershipRole.count({
        where: { tenantId: f.id, roleId: role.id, removedAt: null },
      }),
    ).toBe(1);
  });
  it('serializes owner removal versus owner membership suspension', async () => {
    const f = await fixture();
    const another = await addMember(f.id, 'OWNER');
    const a = await context(f.owner.id, f.id);
    const b = await context(another.person.id, f.id, otherSessions, otherAuth);
    const role = await roleFor(f.id, 'OWNER');
    const results = await Promise.all([
      auth.changeRole(
        a.context,
        f.id,
        f.member.id,
        role.id,
        'remove',
        correlation(),
      ),
      otherAuth.changeMembershipStatus(
        b.context,
        f.id,
        another.member.id,
        'SUSPENDED',
        correlation(),
      ),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual([
      'changed',
      'denied',
    ]);
  });
  it('serializes role assignment versus membership removal without surviving active grants', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    const otherActor = await otherAuth.resolve(
      actor.selected.accessToken,
      f.id,
    );
    if (!otherActor) throw new Error('Expected other actor');
    const target = await addMember(f.id);
    const role = await roleFor(f.id, 'ADMIN');
    const results = await Promise.all([
      auth.changeRole(
        actor.context,
        f.id,
        target.member.id,
        role.id,
        'assign',
        correlation(),
      ),
      otherAuth.changeMembershipStatus(
        otherActor,
        f.id,
        target.member.id,
        'REMOVED',
        correlation(),
      ),
    ]);
    expect(['changed', 'denied'].includes(results[0]?.status ?? '')).toBe(true);
    expect(results[1]?.status).toBe('changed');
    expect(
      await db.membershipRole.count({
        where: {
          tenantId: f.id,
          membershipId: target.member.id,
          removedAt: null,
        },
      }),
    ).toBe(0);
  });
  it('does not allow stale actor authority to survive a concurrent role removal', async () => {
    const f = await fixture();
    const admin = await addMember(f.id, 'ADMIN');
    const target = await addMember(f.id);
    const owner = await context(f.owner.id, f.id);
    const actor = await context(
      admin.person.id,
      f.id,
      otherSessions,
      otherAuth,
    );
    const role = await roleFor(f.id, 'ADMIN');
    const results = await Promise.all([
      auth.changeRole(
        owner.context,
        f.id,
        admin.member.id,
        role.id,
        'remove',
        correlation(),
      ),
      otherAuth.changeRole(
        actor.context,
        f.id,
        target.member.id,
        role.id,
        'assign',
        correlation(),
      ),
    ]);
    expect(results[0]?.status).toBe('changed');
    expect(
      await db.membershipRole.count({
        where: {
          tenantId: f.id,
          membershipId: target.member.id,
          roleId: role.id,
          removedAt: null,
        },
      }),
    ).toBe(results[1]?.status === 'changed' ? 1 : 0);
    expect(
      await otherAuth.has(actor.context, f.id, 'tenant.roles.assign'),
    ).toBe(false);
  });
  it('handles simultaneous tenant transitions with strict single-winner replay revocation', async () => {
    const f = await fixture();
    const initial = issuance(
      await sessions.establish(
        { userId: f.owner.id },
        'BROWSER',
        correlation(),
      ),
    );
    const results = await Promise.all([
      sessions.selectTenant(
        initial.accessToken,
        initial.refreshToken,
        f.id,
        correlation(),
      ),
      otherSessions.selectTenant(
        initial.accessToken,
        initial.refreshToken,
        f.id,
        correlation(),
      ),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual([
      'issued',
      'replay',
    ]);
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: initial.sessionId } }))
        .revocationReason,
    ).toBe('REFRESH_REPLAY');
  });
  it('serializes context transition versus refresh without stale restoration', async () => {
    const f = await fixture();
    const initial = issuance(
      await sessions.establish(
        { userId: f.owner.id },
        'BROWSER',
        correlation(),
      ),
    );
    const results = await Promise.all([
      sessions.selectTenant(
        initial.accessToken,
        initial.refreshToken,
        f.id,
        correlation(),
      ),
      otherSessions.refresh(initial.refreshToken, correlation()),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual([
      'issued',
      'replay',
    ]);
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: initial.sessionId } }))
        .revokedAt !== null,
    ).toBe(true);
  });
  it('serializes context transition versus revocation', async () => {
    const f = await fixture();
    const initial = issuance(
      await sessions.establish(
        { userId: f.owner.id },
        'BROWSER',
        correlation(),
      ),
    );
    const results = await Promise.all([
      sessions.selectTenant(
        initial.accessToken,
        initial.refreshToken,
        f.id,
        correlation(),
      ),
      otherSessions.revoke(
        { userId: f.owner.id },
        initial.sessionId,
        correlation(),
      ),
    ]);
    expect(['issued', 'invalid'].includes(results[0]?.status ?? '')).toBe(true);
    expect((await sessions.validateAccess(initial.accessToken)).status).toBe(
      'invalid',
    );
    const selected = results[0];
    if (selected?.status === 'issued')
      expect((await sessions.validateAccess(selected.accessToken)).status).toBe(
        'invalid',
      );
  });
  it('rolls back role changes and history when audit writing fails', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    const target = await addMember(f.id);
    const role = await roleFor(f.id, 'ADMIN');
    jest
      .spyOn(app.get(TenantAuditWriter), 'write')
      .mockRejectedValue(new Error('Synthetic audit failure'));
    await expect(
      auth.changeRole(
        actor.context,
        f.id,
        target.member.id,
        role.id,
        'assign',
        correlation(),
      ),
    ).rejects.toBeInstanceOf(AuthorizationOperationError);
    expect(
      await db.membershipRole.count({
        where: {
          tenantId: f.id,
          membershipId: target.member.id,
          roleId: role.id,
        },
      }),
    ).toBe(0);
  });
  it('bounds real tenant lock waiting without changing authorization data', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    const target = await addMember(f.id);
    const role = await roleFor(f.id, 'ADMIN');
    let release = () => {};
    let signal = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const hold = secondDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${f.id}::uuid FOR UPDATE`;
      signal();
      await gate;
    });
    await entered;
    const start = performance.now();
    try {
      await expect(
        auth.changeRole(
          actor.context,
          f.id,
          target.member.id,
          role.id,
          'assign',
          correlation(),
        ),
      ).rejects.toBeInstanceOf(AuthorizationOperationError);
      expect(performance.now() - start < 2500).toBe(true);
    } finally {
      release();
      await hold;
    }
    expect(
      await db.membershipRole.count({
        where: {
          tenantId: f.id,
          membershipId: target.member.id,
          roleId: role.id,
        },
      }),
    ).toBe(0);
  });
  it('allows unrelated tenant operations to progress independently', async () => {
    const a = await fixture();
    const b = await fixture();
    const ownerA = await context(a.owner.id, a.id);
    const ownerB = await context(b.owner.id, b.id, otherSessions, otherAuth);
    const targetA = await addMember(a.id);
    const targetB = await addMember(b.id);
    const results = await Promise.all([
      auth.changeRole(
        ownerA.context,
        a.id,
        targetA.member.id,
        (await roleFor(a.id, 'ADMIN')).id,
        'assign',
        correlation(),
      ),
      otherAuth.changeRole(
        ownerB.context,
        b.id,
        targetB.member.id,
        (await roleFor(b.id, 'ADMIN')).id,
        'assign',
        correlation(),
      ),
    ]);
    expect(results.map((row) => row.status)).toEqual(['changed', 'changed']);
  });
  it('rejects expired and stale trusted contexts after a committed context change', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    const next = issuance(
      await sessions.selectTenant(
        actor.selected.accessToken,
        actor.selected.refreshToken,
        f.id,
        correlation(),
      ),
    );
    expect(await auth.has(actor.context, f.id, 'tenant.roles.read')).toBe(
      false,
    );
    const current = await auth.resolve(next.accessToken, f.id);
    if (!current) throw new Error('Expected current context');
    const rows = await db.$queryRaw<
      Array<{ now: Date }>
    >`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    const at = rows[0]?.now;
    if (!at) throw new Error('Missing database time');
    await db.accessToken.updateMany({
      where: { sessionId: next.sessionId, contextVersion: 3 },
      data: {
        createdAt: new Date(at.getTime() - 2000),
        expiresAt: new Date(at.getTime() - 1000),
      },
    });
    expect(await auth.has(current, f.id, 'tenant.roles.read')).toBe(false);
  });
  it('rejects unconsumed refresh credentials from a stale context version', async () => {
    const f = await fixture();
    const value = await selected(f.owner.id, f.id);
    await db.refreshToken.updateMany({
      where: { sessionId: value.selected.sessionId, consumedAt: null },
      data: { contextVersion: 1 },
    });
    expect(
      (await sessions.refresh(value.selected.refreshToken, correlation()))
        .status,
    ).toBe('invalid');
    expect(
      (
        await sessions.selectTenant(
          value.selected.accessToken,
          value.selected.refreshToken,
          f.id,
          correlation(),
        )
      ).status,
    ).toBe('invalid');
    expect(
      (
        await db.session.findUniqueOrThrow({
          where: { id: value.selected.sessionId },
        })
      ).contextVersion,
    ).toBe(2);
  });

  it('refuses new grants to ineligible target users without global user mutations', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    const target = await addMember(f.id);
    const role = await roleFor(f.id, 'OWNER');
    await db.user.update({
      where: { id: target.person.id },
      data: { emailVerifiedAt: null },
    });
    expect(
      (
        await auth.changeRole(
          actor.context,
          f.id,
          target.member.id,
          role.id,
          'assign',
          correlation(),
        )
      ).status,
    ).toBe('denied');
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: target.person.id } }))
        .emailVerifiedAt,
    ).toBeNull();
  });

  it('composes current authorization with a caller transaction without trusting snapshots', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    await expect(
      db.$transaction(
        (tx) => auth.requireIn(tx, actor.context, f.id, 'tenant.roles.read'),
        { maxWait: 1000, timeout: 5000 },
      ),
    ).resolves.toBeUndefined();
    await expect(
      db.$transaction(
        (tx) =>
          auth.requireIn(tx, { ...actor.context }, f.id, 'tenant.roles.read'),
        { maxWait: 1000, timeout: 5000 },
      ),
    ).rejects.toBeInstanceOf(AuthorizationDenied);
  });

  it('writes only scoped constructed audit metadata without credentials or unrelated tenant targets', async () => {
    const f = await fixture();
    const actor = await context(f.owner.id, f.id);
    const target = await addMember(f.id);
    await auth.changeRole(
      actor.context,
      f.id,
      target.member.id,
      (await roleFor(f.id, 'ADMIN')).id,
      'assign',
      correlation(),
    );
    const events = await db.auditEvent.findMany({ where: { tenantId: f.id } });
    expect(
      events.every(
        (event) =>
          event.scope === 'TENANT' && correlations.has(event.correlationId),
      ),
    ).toBe(true);
    const serialized = JSON.stringify(events);
    expect(
      serialized.includes(actor.selected.accessToken) ||
        serialized.includes(actor.selected.refreshToken),
    ).toBe(false);
    expect(
      events.every(
        (event) =>
          event.metadata === null ||
          Object.keys(event.metadata).every((key) =>
            ['role', 'status', 'count'].includes(key),
          ),
      ),
    ).toBe(true);
  });
});
