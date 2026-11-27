import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { TemplateCode } from '../authorization/permission.catalog.js';

type TenantEvent = {
  tenantId: string;
  userId: string | null;
  correlationId: string;
  targetId: string;
} & (
  | { kind: 'roles_provisioned'; count: number }
  | { kind: 'role_assigned' | 'role_removed'; role: TemplateCode }
  | {
      kind: 'membership_status_changed';
      status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
    }
  | { kind: 'context_selected' }
);
@Injectable()
export class TenantAuditWriter {
  async write(tx: Prisma.TransactionClient, event: TenantEvent): Promise<void> {
    await tx.auditEvent.createMany({
      data: {
        scope: 'TENANT',
        tenantId: event.tenantId,
        actorUserId: event.userId,
        action: `tenant.${event.kind}`,
        targetType:
          event.kind === 'context_selected'
            ? 'Session'
            : event.kind === 'roles_provisioned'
              ? 'Tenant'
              : 'Membership',
        targetId: event.targetId,
        correlationId: event.correlationId,
        outcome: 'SUCCESS',
        metadata:
          event.kind === 'roles_provisioned'
            ? { count: event.count }
            : event.kind === 'role_assigned' || event.kind === 'role_removed'
              ? { role: event.role }
              : event.kind === 'membership_status_changed'
                ? { status: event.status }
                : undefined,
      },
    });
  }
}
