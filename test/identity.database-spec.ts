import 'reflect-metadata';
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/infrastructure/database/database.module.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  MembershipStatus,
  TenantStatus,
  UserStatus,
} from '../src/generated/prisma/enums.js';
import { getTestDatabaseUrl } from './helpers/database-target.js';

const migrationName = '20261126190000_core_identity';

describe('Core identity schema (guarded real PostgreSQL)', () => {
  let module: TestingModule | undefined;
  let prisma: PrismaService;
  const ids = {
    users: new Set<string>(),
    tenants: new Set<string>(),
    memberships: new Set<string>(),
    events: new Set<string>(),
  };

  beforeAll(async () => {
    const url = getTestDatabaseUrl(process.env);
    module = await Test.createTestingModule({ imports: [DatabaseModule] })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ DATABASE_URL: url }))
      .compile();
    await module.init();
    prisma = module.get(PrismaService);
    const identity = await prisma.$queryRaw<Array<{ database: string }>>`
      SELECT current_database() AS database
    `;
    expect(identity).toEqual([{ database: 'hanoflow_test' }]);
  });

  afterEach(async () => {
    // Exact IDs allocated by this test only, including failed insert attempts.
    // No broad predicates, truncate, reset or unrelated fixture deletion.
    await prisma.$transaction([
      prisma.auditEvent.deleteMany({ where: { id: { in: [...ids.events] } } }),
      prisma.membership.deleteMany({
        where: { id: { in: [...ids.memberships] } },
      }),
      prisma.tenant.deleteMany({ where: { id: { in: [...ids.tenants] } } }),
      prisma.user.deleteMany({ where: { id: { in: [...ids.users] } } }),
    ]);
    for (const values of Object.values(ids)) values.clear();
  });

  afterAll(async () => {
    await module?.close();
  });

  function user(data: Partial<Prisma.UserUncheckedCreateInput> = {}) {
    const id = randomUUID();
    ids.users.add(id);
    const email = `Task22-${id}@Example.test`;
    return prisma.user.create({
      data: { email, canonicalEmail: email.toLowerCase(), ...data, id },
    });
  }

  function tenant(data: Partial<Prisma.TenantUncheckedCreateInput> = {}) {
    const id = randomUUID();
    ids.tenants.add(id);
    return prisma.tenant.create({
      data: { name: 'Task 2.2 fixture', slug: `task22-${id}`, ...data, id },
    });
  }

  function membership(userId: string, tenantId: string) {
    const id = randomUUID();
    ids.memberships.add(id);
    return prisma.membership.create({ data: { id, userId, tenantId } });
  }

  function event(data: Partial<Prisma.AuditEventUncheckedCreateInput> = {}) {
    const id = randomUUID();
    ids.events.add(id);
    return prisma.auditEvent.create({
      data: {
        scope: 'PLATFORM',
        action: 'identity.fixture',
        targetType: 'InfrastructureTest',
        outcome: 'SUCCESS',
        correlationId: randomUUID(),
        ...data,
        id,
      },
    });
  }

  it('creates a pending global user with native UUIDv4 and UTC-capable timestamps', async () => {
    const created = await user();
    expect(created.id).toMatch(
      /^[0-9a-f-]{14}4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(created.status).toBe('PENDING');
    expect(created.emailVerifiedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  it('uses the same database UUID default for direct SQL and Prisma inserts', async () => {
    const email = `task22-${randomUUID()}@example.test`;
    // Transaction rollback owns this direct SQL fixture even if an assertion fails.
    class FixtureRollback extends Error {}
    await expect(
      prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "User" ("email", "canonicalEmail") VALUES (${email}, ${email}) RETURNING id
      `;
        expect(rows[0]?.id).toMatch(
          /^[0-9a-f-]{14}4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        throw new FixtureRollback();
      }),
    ).rejects.toBeInstanceOf(FixtureRollback);
  });

  it('preserves display email and enforces trimming plus Unicode lowercase canonicalization', async () => {
    const suffix = randomUUID();
    const created = await user({
      email: ` \tİ-${suffix}@EXAMPLE.TEST\r\n`,
      canonicalEmail: `i\u0307-${suffix}@example.test`,
    });
    expect(created.email.startsWith(' \tİ-')).toBe(true);
    expect(created.canonicalEmail.startsWith('i\u0307-')).toBe(true);
  });

  it('rejects duplicate canonical email globally, including deactivated identities', async () => {
    const existing = await user({ status: 'DEACTIVATED' });
    await expect(
      user({ email: existing.email, canonicalEmail: existing.canonicalEmail }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it.each(['Different@example.test', '', ' mismatch@example.test '])(
    'rejects inconsistent canonical email %j',
    async (canonicalEmail) => {
      await expect(user({ canonicalEmail })).rejects.toThrow();
    },
  );

  it('rejects whitespace-only email', async () => {
    await expect(
      user({ email: ' \t\r\n', canonicalEmail: '' }),
    ).rejects.toThrow();
  });

  it.each(Object.values(UserStatus))(
    'persists user lifecycle %s',
    async (status) => {
      const verified = new Date('2026-01-01T00:00:00.000Z');
      const created = await user({ status, emailVerifiedAt: verified });
      expect(created.status).toBe(status);
      expect(created.emailVerifiedAt).toEqual(verified);
    },
  );

  it('rejects invalid lifecycle enum values at the database boundary', async () => {
    const created = await user();
    await expect(prisma.$executeRaw`
      UPDATE "User" SET status = ${'UNKNOWN'}::"UserStatus" WHERE id = ${created.id}::uuid
    `).rejects.toThrow();
    const company = await tenant();
    await expect(prisma.$executeRaw`
      UPDATE "Tenant" SET status = ${'UNKNOWN'}::"TenantStatus" WHERE id = ${company.id}::uuid
    `).rejects.toThrow();
    const link = await membership(created.id, company.id);
    await expect(prisma.$executeRaw`
      UPDATE "Membership" SET status = ${'UNKNOWN'}::"MembershipStatus" WHERE id = ${link.id}::uuid
    `).rejects.toThrow();
  });

  it('creates a pending tenant and retains slug uniqueness after closure', async () => {
    const created = await tenant();
    expect(created.status).toBe('PENDING');
    await prisma.tenant.update({
      where: { id: created.id },
      data: { status: 'CLOSED' },
    });
    await expect(tenant({ slug: created.slug })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it.each(Object.values(TenantStatus))(
    'persists tenant lifecycle %s',
    async (status) => {
      expect((await tenant({ status })).status).toBe(status);
    },
  );

  it.each(['UPPER', '-leading', 'trailing-', 'double--dash', 'space slug', ''])(
    'rejects non-normalized slug %j',
    async (slug) => {
      await expect(tenant({ slug })).rejects.toThrow();
    },
  );

  it('rejects blank company names', async () => {
    await expect(tenant({ name: ' \t\n' })).rejects.toThrow();
  });

  it('supports multiple tenants per user and multiple users per tenant', async () => {
    const [first, second] = await Promise.all([user(), user()]);
    const [a, b] = await Promise.all([tenant(), tenant()]);
    await membership(first.id, a.id);
    await membership(first.id, b.id);
    await membership(second.id, a.id);
    expect(await prisma.membership.count({ where: { userId: first.id } })).toBe(
      2,
    );
    expect(await prisma.membership.count({ where: { tenantId: a.id } })).toBe(
      2,
    );
  });

  it('rejects duplicate memberships', async () => {
    const person = await user();
    const company = await tenant();
    await membership(person.id, company.id);
    await expect(membership(person.id, company.id)).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('rejects nonexistent user and tenant references', async () => {
    const person = await user();
    const company = await tenant();
    await expect(membership(randomUUID(), company.id)).rejects.toMatchObject({
      code: 'P2003',
    });
    await expect(membership(person.id, randomUUID())).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  it('exposes a tenant-aware unique reference key without authorizing access', async () => {
    const person = await user();
    const [company, other] = await Promise.all([tenant(), tenant()]);
    const link = await membership(person.id, company.id);
    expect(
      await prisma.membership.findUnique({
        where: { tenantId_id: { tenantId: company.id, id: link.id } },
      }),
    ).toEqual(link);
    expect(
      await prisma.membership.findUnique({
        where: { tenantId_id: { tenantId: other.id, id: link.id } },
      }),
    ).toBeNull();
  });

  it.each(Object.values(MembershipStatus))(
    'persists consistent membership lifecycle %s',
    async (status) => {
      const person = await user();
      const company = await tenant();
      const link = await membership(person.id, company.id);
      const updated = await prisma.membership.update({
        where: { id: link.id },
        data: { status, removedAt: status === 'REMOVED' ? new Date() : null },
      });
      expect(updated.status).toBe(status);
      expect(
        await prisma.user.findUnique({ where: { id: person.id } }),
      ).toEqual(person);
      expect(
        await prisma.tenant.findUnique({ where: { id: company.id } }),
      ).toEqual(company);
    },
  );

  it('enforces removal timestamps and permits same-row reactivation', async () => {
    const person = await user();
    const company = await tenant();
    const link = await membership(person.id, company.id);
    await expect(
      prisma.membership.update({
        where: { id: link.id },
        data: { status: 'REMOVED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.membership.update({
        where: { id: link.id },
        data: { removedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.membership.update({
        where: { id: link.id },
        data: {
          status: 'REMOVED',
          removedAt: new Date(link.joinedAt.getTime() - 1),
        },
      }),
    ).rejects.toThrow();
    await prisma.membership.update({
      where: { id: link.id },
      data: { status: 'REMOVED', removedAt: new Date() },
    });
    await expect(membership(person.id, company.id)).rejects.toMatchObject({
      code: 'P2002',
    });
    const restored = await prisma.membership.update({
      where: { id: link.id },
      data: { status: 'ACTIVE', removedAt: null },
    });
    expect(restored.id).toBe(link.id);
    expect(restored.joinedAt).toEqual(link.joinedAt);
    expect(restored.removedAt).toBeNull();
  });

  it('restricts deletion and key updates of membership parents', async () => {
    const person = await user();
    const company = await tenant();
    await membership(person.id, company.id);
    await expect(
      prisma.user.delete({ where: { id: person.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.tenant.delete({ where: { id: company.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.user.update({
        where: { id: person.id },
        data: { id: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('persists tenant audit events, correlation and bounded metadata', async () => {
    const person = await user();
    const company = await tenant();
    const correlationId = randomUUID();
    const recorded = await event({
      scope: 'TENANT',
      tenantId: company.id,
      actorUserId: person.id,
      targetType: 'Tenant',
      targetId: company.id,
      correlationId,
      metadata: { reasonCode: 'TEST_FIXTURE' },
    });
    expect(
      await prisma.auditEvent.findUnique({ where: { id: recorded.id } }),
    ).toEqual(recorded);
    expect(recorded.correlationId).toBe(correlationId);
  });

  it('supports platform human events and system events in either scope', async () => {
    const person = await user();
    const company = await tenant();
    expect((await event({ actorUserId: person.id })).tenantId).toBeNull();
    expect((await event()).actorUserId).toBeNull();
    expect(
      (await event({ scope: 'TENANT', tenantId: company.id })).actorUserId,
    ).toBeNull();
  });

  it('rejects contradictory scope and tenant combinations', async () => {
    const company = await tenant();
    await expect(event({ scope: 'TENANT' })).rejects.toThrow();
    await expect(
      event({ scope: 'PLATFORM', tenantId: company.id }),
    ).rejects.toThrow();
  });

  it('rejects missing audit parents and restricts deletion of referenced history', async () => {
    await expect(event({ actorUserId: randomUUID() })).rejects.toMatchObject({
      code: 'P2003',
    });
    await expect(
      event({ scope: 'TENANT', tenantId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'P2003' });
    const person = await user();
    const company = await tenant();
    const recorded = await event({
      scope: 'TENANT',
      tenantId: company.id,
      actorUserId: person.id,
    });
    await expect(
      prisma.user.delete({ where: { id: person.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.tenant.delete({ where: { id: company.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect(
      await prisma.auditEvent.findUnique({ where: { id: recorded.id } }),
    ).toEqual(recorded);
  });

  it('requires nonblank audit identifiers and valid UUID correlation', async () => {
    await expect(event({ action: ' \t' })).rejects.toThrow();
    await expect(event({ targetType: '' })).rejects.toThrow();
    await expect(event({ targetId: ' ' })).rejects.toThrow();
    await expect(event({ correlationId: 'invalid' })).rejects.toThrow();
  });

  it('enforces object-only metadata and a 4096-byte JSONB text limit', async () => {
    await expect(event({ metadata: ['invalid'] })).rejects.toThrow();
    await expect(event({ metadata: Prisma.JsonNull })).rejects.toThrow();
    await expect(
      event({ metadata: { reasonCode: 'é'.repeat(2100) } }),
    ).rejects.toThrow();
    expect(
      (await event({ metadata: { reasonCode: 'x'.repeat(4078) } })).metadata,
    ).toBeDefined();
  });

  it('records the exact reviewed migration checksum with no failed or pending rows', async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        migration_name: string;
        checksum: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }>
    >`
      SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name
    `;
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      migration_name: migrationName,
      checksum: createHash('sha256')
        .update(
          readFileSync(`prisma/migrations/${migrationName}/migration.sql`),
        )
        .digest('hex'),
      rolled_back_at: null,
    });
    expect(rows[0]?.finished_at).toBeInstanceOf(Date);
    expect(rows[1]).toMatchObject({
      migration_name: '20261126200000_password_credential',
      checksum: createHash('sha256')
        .update(
          readFileSync(
            'prisma/migrations/20261126200000_password_credential/migration.sql',
          ),
        )
        .digest('hex'),
      rolled_back_at: null,
    });
    expect(rows[1]?.finished_at).toBeInstanceOf(Date);
    expect(rows[2]).toMatchObject({
      migration_name: '20261126210000_sessions_and_tokens',
      checksum: createHash('sha256')
        .update(
          readFileSync(
            'prisma/migrations/20261126210000_sessions_and_tokens/migration.sql',
          ),
        )
        .digest('hex'),
      rolled_back_at: null,
    });
    expect(rows[2]?.finished_at).toBeInstanceOf(Date);
    expect(rows[3]).toMatchObject({
      migration_name: '20261126220000_rbac_tenant_context',
      checksum: createHash('sha256')
        .update(
          readFileSync(
            'prisma/migrations/20261126220000_rbac_tenant_context/migration.sql',
          ),
        )
        .digest('hex'),
      rolled_back_at: null,
    });
    expect(rows[3]?.finished_at).toBeInstanceOf(Date);
  });

  it('contains exactly the approved tables, checks, indexes and restricted foreign keys', async () => {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename COLLATE "C"
    `;
    expect(tables.map((row) => row.tablename)).toEqual([
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
      '_prisma_migrations',
    ]);
    const checks = await prisma.$queryRaw<
      Array<{ conname: string; convalidated: boolean }>
    >`
      SELECT conname, convalidated FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND contype='c' ORDER BY conname COLLATE "C"
    `;
    expect(checks).toEqual(
      [
        'AccessToken_context_check',
        'AccessToken_digest_check',
        'AccessToken_time_check',
        'AuditEvent_identifiers_check',
        'AuditEvent_metadata_check',
        'AuditEvent_scope_check',
        'Membership_removal_chronology_check',
        'Membership_removedAt_check',
        'PasswordCredential_hash_check',
        'RefreshToken_consumption_check',
        'RefreshToken_digest_check',
        'RefreshToken_lineage_check',
        'RefreshToken_time_check',
        'Session_context_check',
        'Session_revocation_check',
        'Session_time_check',
        'Tenant_name_check',
        'Tenant_slug_check',
        'User_canonicalEmail_check',
        'MembershipRole_removal_check',
        'Permission_catalog_check',
        'RefreshToken_context_check',
        'Role_template_check',
        'Role_owner_active_check',
        'RolePermission_scope_check',
        'Session_tenant_context_check',
      ]
        .sort()
        .map((conname) => ({ conname, convalidated: true })),
    );
    const foreignKeys = await prisma.$queryRaw<
      Array<{ conname: string; confdeltype: string; confupdtype: string }>
    >`
      SELECT conname, confdeltype::text, confupdtype::text FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND contype='f' ORDER BY conname COLLATE "C"
    `;
    expect(foreignKeys).toEqual(
      [
        'AccessToken_sessionId_fkey',
        'AuditEvent_actorUserId_fkey',
        'AuditEvent_tenantId_fkey',
        'Membership_tenantId_fkey',
        'Membership_userId_fkey',
        'PasswordCredential_userId_fkey',
        'RefreshToken_sessionId_fkey',
        'RefreshToken_sessionId_predecessorId_fkey',
        'Session_userId_fkey',
        'Session_tenantId_fkey',
        'Session_tenantId_membershipId_userId_fkey',
        'Role_tenantId_fkey',
        'MembershipRole_tenantId_membershipId_fkey',
        'MembershipRole_tenantId_roleId_fkey',
        'MembershipRole_grantedByUserId_fkey',
        'MembershipRole_removedByUserId_fkey',
        'RolePermission_tenantId_roleId_fkey',
        'RolePermission_permissionCode_scope_fkey',
      ]
        .sort()
        .map((conname) => ({ conname, confdeltype: 'r', confupdtype: 'r' })),
    );
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename <> '_prisma_migrations' ORDER BY indexname COLLATE "C"
    `;
    expect(indexes.map((row) => row.indexname)).toEqual(
      [
        'Role_pkey',
        'Role_tenantId_code_key',
        'Role_tenantId_id_key',
        'Permission_pkey',
        'Permission_code_scope_key',
        'MembershipRole_pkey',
        'MembershipRole_active_key',
        'MembershipRole_grantedByUserId_idx',
        'MembershipRole_removedByUserId_idx',
        'MembershipRole_tenantId_membershipId_removedAt_idx',
        'MembershipRole_tenantId_roleId_removedAt_idx',
        'RolePermission_pkey',
        'RolePermission_permissionCode_scope_idx',
        'Session_tenantId_membershipId_idx',
        'Membership_tenantId_id_userId_key',
        'AccessToken_digest_key',
        'AccessToken_expiresAt_idx',
        'AccessToken_pkey',
        'AccessToken_sessionId_idx',
        'AuditEvent_actorUserId_createdAt_id_idx',
        'AuditEvent_correlationId_idx',
        'AuditEvent_pkey',
        'AuditEvent_tenantId_createdAt_id_idx',
        'Membership_pkey',
        'Membership_tenantId_id_key',
        'Membership_tenantId_status_id_idx',
        'Membership_tenantId_userId_key',
        'Membership_userId_status_idx',
        'PasswordCredential_pkey',
        'RefreshToken_digest_key',
        'RefreshToken_expiresAt_idx',
        'RefreshToken_one_unconsumed_per_session',
        'RefreshToken_pkey',
        'RefreshToken_predecessorId_key',
        'RefreshToken_sessionId_id_key',
        'Session_absoluteExpiresAt_idx',
        'Session_idleExpiresAt_idx',
        'Session_pkey',
        'Session_userId_revokedAt_id_idx',
        'Tenant_pkey',
        'Tenant_slug_key',
        'User_canonicalEmail_key',
        'User_pkey',
      ].sort(),
    );
    const collations = await prisma.$queryRaw<Array<{ collname: string }>>`
      SELECT c.collname FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname='User' AND a.attname='canonicalEmail'
    `;
    expect(collations).toEqual([{ collname: 'C' }]);
  });
});
