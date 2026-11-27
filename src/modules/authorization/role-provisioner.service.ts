import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { TenantAuditWriter } from '../audit/tenant-audit.writer.js';
import { ROLE_CODES, ROLE_MATRIX, PERMISSIONS } from './permission.catalog.js';

export class RoleProvisioningError extends Error {
  readonly code = 'ROLE_PROVISIONING_FAILED';
  constructor() {
    super('Role provisioning failed');
    this.name = 'RoleProvisioningError';
  }
}

@Injectable()
export class RoleProvisioner {
  constructor(private readonly audit: TenantAuditWriter) {}
  // Bootstrap-only transaction API, never ordinary tenant administration. Future
  // onboarding must create membership/first owner + activate in this SAME tx.
  async provisionIn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    correlationId: string,
  ): Promise<number> {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(tenantId) || !uuid.test(correlationId))
      throw new RoleProvisioningError();
    try {
      await tx.$queryRaw`SELECT set_config('app.bootstrap_tenant_id',${tenantId},true)`;
      return await this.perform(tx, tenantId, correlationId);
    } catch {
      throw new RoleProvisioningError();
    }
  }

  private async perform(
    tx: Prisma.TransactionClient,
    tenantId: string,
    correlationId: string,
  ): Promise<number> {
    await tx.$executeRaw`SET LOCAL lock_timeout='750ms'`;
    const tenants = await tx.$queryRaw<
      Array<{ status: string }>
    >`SELECT status::text FROM "Tenant" WHERE id=${tenantId}::uuid FOR UPDATE`;
    if (!tenants[0]) throw new Error('Role provisioning unavailable');
    if (
      (await tx.permission.count({
        where: { scope: 'TENANT', code: { in: [...PERMISSIONS] } },
      })) !== PERMISSIONS.length
    )
      throw new Error('Permission catalog mismatch');
    let created = 0;
    for (const code of ROLE_CODES) {
      const role = await tx.role.findUnique({
        where: { tenantId_code: { tenantId, code } },
        include: {
          permissions: { select: { permissionCode: true, scope: true } },
        },
      });
      if (role) {
        if (
          role.templateVersion !== 1 ||
          role.permissions.some((row) => row.scope !== 'TENANT') ||
          JSON.stringify(
            role.permissions.map((row) => row.permissionCode).sort(),
          ) !== JSON.stringify([...ROLE_MATRIX[code]].sort())
        )
          throw new Error('Predefined role mapping mismatch');
        continue;
      }
      if (tenants[0].status !== 'PENDING')
        throw new Error('Active tenant requires provisioning review');
      const added = await tx.role.create({
        data: { tenantId, code, name: code },
        select: { id: true },
      });
      if (ROLE_MATRIX[code].length)
        await tx.rolePermission.createMany({
          data: ROLE_MATRIX[code].map((permissionCode) => ({
            tenantId,
            roleId: added.id,
            permissionCode,
            scope: 'TENANT',
          })),
        });
      created++;
    }
    if (created)
      await this.audit.write(tx, {
        kind: 'roles_provisioned',
        tenantId,
        userId: null,
        targetId: tenantId,
        correlationId,
        count: created,
      });
    return created;
  }
}
