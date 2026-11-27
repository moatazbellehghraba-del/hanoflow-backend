import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { tenantContext } from '../../infrastructure/database/database-context.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TenantAuditWriter } from '../audit/tenant-audit.writer.js';
import {
  canDelegate,
  isPermission,
  permissionSet,
  templateAllows,
  type PermissionCode,
} from './permission.catalog.js';

export interface TrustedTenantContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly contextVersion: number;
  readonly permissions: readonly PermissionCode[];
}
export class AuthorizationDenied extends Error {
  constructor() {
    super('Authorization denied');
    this.name = 'AuthorizationDenied';
  }
}
export class AuthorizationOperationError extends Error {
  constructor() {
    super('Authorization operation failed');
    this.name = 'AuthorizationOperationError';
  }
}
type Tx = Prisma.TransactionClient;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthorizationService {
  readonly #contexts = new WeakMap<
    object,
    { raw: string; context: TrustedTenantContext }
  >();
  constructor(
    private readonly db: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: TenantAuditWriter,
  ) {}
  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      await this.db.verifyIdentity();
      return await this.db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout='750ms'`;
          return work(tx);
        },
        { isolationLevel: 'ReadCommitted', maxWait: 1000, timeout: 5000 },
      );
    } catch (error) {
      if (error instanceof AuthorizationDenied) throw error;
      throw new AuthorizationOperationError();
    }
  }
  private proof(context: unknown, tenantId: string) {
    if (!context || typeof context !== 'object' || !uuid.test(tenantId))
      throw new AuthorizationDenied();
    const proof = this.#contexts.get(context);
    if (!proof || proof.context.tenantId !== tenantId)
      throw new AuthorizationDenied();
    return proof;
  }
  private async effective(
    tx: Tx,
    membershipId: string,
    tenantId: string,
  ): Promise<readonly PermissionCode[]> {
    const rows = await tx.membershipRole.findMany({
      where: {
        tenantId,
        membershipId,
        removedAt: null,
        role: { status: 'ACTIVE', templateVersion: 1 },
      },
      select: {
        role: {
          select: {
            code: true,
            permissions: {
              where: { scope: 'TENANT' },
              select: { permissionCode: true },
            },
          },
        },
      },
    });
    const allowed = new Set<PermissionCode>();
    for (const row of rows)
      for (const permission of row.role.permissions)
        if (
          isPermission(permission.permissionCode) &&
          templateAllows(row.role.code, permission.permissionCode)
        )
          allowed.add(permission.permissionCode);
    return Object.freeze([...allowed].sort());
  }
  private async current(
    tx: Tx,
    proof: { raw: string; context: TrustedTenantContext },
    write = false,
  ) {
    const identity = await this.sessions.validateAccessIn(tx, proof.raw, write);
    if (
      identity.status !== 'valid' ||
      identity.scope !== 'TENANT' ||
      identity.tenantId !== proof.context.tenantId ||
      identity.membershipId !== proof.context.membershipId ||
      identity.contextVersion !== proof.context.contextVersion
    )
      throw new AuthorizationDenied();
    await tenantContext(tx, proof.context.tenantId, proof.context.membershipId);
    return this.effective(
      tx,
      proof.context.membershipId,
      proof.context.tenantId,
    );
  }
  async resolve(
    raw: string,
    tenantId: string,
  ): Promise<TrustedTenantContext | undefined> {
    if (!uuid.test(tenantId)) return undefined;
    return this.transaction(async (tx) => {
      const identity = await this.sessions.validateAccessIn(tx, raw);
      if (
        identity.status !== 'valid' ||
        identity.scope !== 'TENANT' ||
        identity.tenantId !== tenantId ||
        !identity.membershipId
      )
        return undefined;
      await tenantContext(tx, tenantId, identity.membershipId);
      const context = Object.freeze({
        userId: identity.userId,
        sessionId: identity.sessionId,
        tenantId,
        membershipId: identity.membershipId,
        contextVersion: identity.contextVersion,
        permissions: await this.effective(tx, identity.membershipId, tenantId),
      });
      this.#contexts.set(context, { raw, context });
      return context;
    });
  }
  async resolveEffective(
    context: unknown,
    tenantId: string,
  ): Promise<readonly PermissionCode[]> {
    try {
      const proof = this.proof(context, tenantId);
      return await this.transaction((tx) => this.current(tx, proof));
    } catch (error) {
      if (error instanceof AuthorizationDenied) return Object.freeze([]);
      throw error;
    }
  }
  async has(
    context: unknown,
    tenantId: string,
    permission: unknown,
  ): Promise<boolean> {
    return (
      isPermission(permission) &&
      (await this.resolveEffective(context, tenantId)).includes(permission)
    );
  }
  async checkSet(
    context: unknown,
    tenantId: string,
    requirements: unknown,
    mode: 'all' | 'any',
  ): Promise<boolean> {
    if (!permissionSet(requirements) || !['all', 'any'].includes(mode))
      return false;
    const permissions = await this.resolveEffective(context, tenantId);
    return mode === 'all'
      ? requirements.every((value) => permissions.includes(value))
      : requirements.some((value) => permissions.includes(value));
  }
  async require(
    context: unknown,
    tenantId: string,
    permission: unknown,
  ): Promise<void> {
    if (!(await this.has(context, tenantId, permission)))
      throw new AuthorizationDenied();
  }

  // Compose with future resource policies and writes in the caller's real
  // transaction. Its caller must use the reviewed maxWait/timeout settings.
  async requireIn(
    tx: Tx,
    context: unknown,
    tenantId: string,
    permission: unknown,
  ): Promise<void> {
    if (!isPermission(permission)) throw new AuthorizationDenied();
    const proof = this.proof(context, tenantId);
    await tx.$executeRaw`SET LOCAL lock_timeout='750ms'`;
    if (!(await this.current(tx, proof)).includes(permission))
      throw new AuthorizationDenied();
  }

  // Caller must already hold Tenant FOR UPDATE; future global user/role/email
  // lifecycle writers must lock all affected tenants before changing eligibility.
  async assertOwnerInvariantIn(tx: Tx, tenantId: string): Promise<void> {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (tenant?.status !== 'ACTIVE') return;
    const owners = await tx.membershipRole.count({
      where: {
        tenantId,
        removedAt: null,
        membership: {
          status: 'ACTIVE',
          user: { status: 'ACTIVE', emailVerifiedAt: { not: null } },
        },
        role: {
          code: 'OWNER',
          status: 'ACTIVE',
          templateVersion: 1,
          permissions: {
            some: {
              permissionCode: 'tenant.ownership.manage',
              scope: 'TENANT',
            },
          },
        },
      },
    });
    if (!owners) throw new AuthorizationDenied();
  }
  private async timestamp(tx: Tx) {
    const rows = await tx.$queryRaw<
      Array<{ now: Date }>
    >`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    if (!rows[0]) throw new AuthorizationOperationError();
    return rows[0].now;
  }

  async changeRole(
    context: unknown,
    tenantId: string,
    membershipId: string,
    roleId: string,
    operation: 'assign' | 'remove',
    correlationId: string,
  ): Promise<{ status: 'changed' | 'unchanged' | 'denied' }> {
    try {
      if (
        !uuid.test(membershipId) ||
        !uuid.test(roleId) ||
        !uuid.test(correlationId) ||
        !['assign', 'remove'].includes(operation)
      )
        throw new AuthorizationDenied();
      const proof = this.proof(context, tenantId);
      return await this.transaction(async (tx) => {
        const permissions = await this.current(tx, proof, true);
        const members = await tx.$queryRaw<
          Array<{ id: string; status: string }>
        >`SELECT id,status::text FROM "Membership" WHERE id=${membershipId}::uuid AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
        const member = members[0];
        const targetUser = member
          ? await tx.membership.findUnique({
              where: { id: member.id },
              select: {
                user: { select: { status: true, emailVerifiedAt: true } },
              },
            })
          : null;
        const role = await tx.role.findUnique({
          where: { tenantId_id: { tenantId, id: roleId } },
          select: { code: true, status: true, templateVersion: true },
        });
        if (
          !member ||
          member.status !== 'ACTIVE' ||
          !role ||
          role.status !== 'ACTIVE' ||
          role.templateVersion !== 1 ||
          !canDelegate(permissions, role.code) ||
          (operation === 'assign' &&
            (targetUser?.user.status !== 'ACTIVE' ||
              targetUser.user.emailVerifiedAt === null)) ||
          (operation === 'assign' &&
            membershipId === proof.context.membershipId)
        )
          throw new AuthorizationDenied();
        const active = await tx.membershipRole.findFirst({
          where: { tenantId, membershipId, roleId, removedAt: null },
          select: { id: true },
        });
        if (
          (operation === 'assign' && active) ||
          (operation === 'remove' && !active)
        )
          return { status: 'unchanged' };
        const now = await this.timestamp(tx);
        if (operation === 'assign')
          await tx.membershipRole.create({
            data: {
              tenantId,
              membershipId,
              roleId,
              grantedAt: now,
              grantedByUserId: proof.context.userId,
            },
            select: { id: true },
          });
        else if (active)
          await tx.membershipRole.update({
            where: { id: active.id },
            data: { removedAt: now, removedByUserId: proof.context.userId },
            select: { id: true },
          });
        await this.assertOwnerInvariantIn(tx, tenantId);
        await this.audit.write(tx, {
          kind: operation === 'assign' ? 'role_assigned' : 'role_removed',
          tenantId,
          userId: proof.context.userId,
          targetId: membershipId,
          role: role.code,
          correlationId,
        });
        return { status: 'changed' };
      });
    } catch (error) {
      if (error instanceof AuthorizationDenied) return { status: 'denied' };
      throw error;
    }
  }

  async changeMembershipStatus(
    context: unknown,
    tenantId: string,
    membershipId: string,
    status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED',
    correlationId: string,
  ): Promise<{ status: 'changed' | 'unchanged' | 'denied' }> {
    try {
      if (
        !uuid.test(membershipId) ||
        !uuid.test(correlationId) ||
        !['ACTIVE', 'SUSPENDED', 'REMOVED'].includes(status)
      )
        throw new AuthorizationDenied();
      const proof = this.proof(context, tenantId);
      return await this.transaction(async (tx) => {
        const permissions = await this.current(tx, proof, true);
        if (!permissions.includes('tenant.memberships.manage'))
          throw new AuthorizationDenied();
        const members = await tx.$queryRaw<
          Array<{ id: string; status: string }>
        >`SELECT id,status::text FROM "Membership" WHERE id=${membershipId}::uuid AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
        const member = members[0];
        if (!member || (member.status === 'REMOVED' && status === 'SUSPENDED'))
          throw new AuthorizationDenied();
        const owner = await tx.membershipRole.count({
          where: {
            tenantId,
            membershipId,
            removedAt: null,
            role: { code: 'OWNER', status: 'ACTIVE' },
          },
        });
        if (owner && !permissions.includes('tenant.ownership.manage'))
          throw new AuthorizationDenied();
        if (member.status === status) return { status: 'unchanged' };
        const now = await this.timestamp(tx);
        await tx.membership.update({
          where: { id: membershipId },
          data: { status, removedAt: status === 'REMOVED' ? now : null },
          select: { id: true },
        });
        if (status === 'REMOVED')
          await tx.membershipRole.updateMany({
            where: { tenantId, membershipId, removedAt: null },
            data: { removedAt: now, removedByUserId: proof.context.userId },
          });
        await this.assertOwnerInvariantIn(tx, tenantId);
        await this.audit.write(tx, {
          kind: 'membership_status_changed',
          tenantId,
          userId: proof.context.userId,
          targetId: membershipId,
          status,
          correlationId,
        });
        return { status: 'changed' };
      });
    } catch (error) {
      if (error instanceof AuthorizationDenied) return { status: 'denied' };
      throw error;
    }
  }
}
