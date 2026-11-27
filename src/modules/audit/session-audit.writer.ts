import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

export type SessionAuditEvent = {
  userId: string;
  correlationId: string;
} & (
  | { kind: 'established'; sessionId: string; client: 'BROWSER' | 'MOBILE' }
  | { kind: 'rotated' | 'revoked' | 'refresh_replay'; sessionId: string }
  | { kind: 'revoked_all'; count: number }
);

@Injectable()
export class SessionAuditWriter {
  async write(
    tx: Prisma.TransactionClient,
    event: SessionAuditEvent,
  ): Promise<void> {
    await tx.auditEvent.createMany({
      data: {
        // A consumed token does not authenticate its presenter; record system
        // detection, not a fabricated human actor. Session target retains context.
        actorUserId: event.kind === 'refresh_replay' ? null : event.userId,
        scope: 'PLATFORM',
        action: `session.${event.kind}`,
        targetType: event.kind === 'revoked_all' ? 'User' : 'Session',
        targetId: event.kind === 'revoked_all' ? event.userId : event.sessionId,
        outcome: event.kind === 'refresh_replay' ? 'DENIED' : 'SUCCESS',
        correlationId: event.correlationId,
        metadata:
          event.kind === 'established'
            ? { client: event.client }
            : event.kind === 'revoked_all'
              ? { count: event.count }
              : undefined,
      },
    });
  }
}
