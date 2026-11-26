import { Injectable } from '@nestjs/common';
import type { Prisma, Session } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { SessionAuditWriter } from '../audit/session-audit.writer.js';
import { TokenSecrets } from './token-secrets.js';
import {
  activityTimes,
  isExpired,
  policyFor,
  type SessionClientKind,
} from './session.policy.js';

// Internal trust contract; an arbitrary caller-supplied userId is NOT proof.
// Future Auth must construct this only after actual authentication, never a DTO.
export interface AuthenticatedIdentity {
  readonly userId: string;
}
export interface IssuedSession {
  status: 'issued';
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}
export type SessionIssuance = IssuedSession | { status: 'invalid' | 'replay' };
export type SessionValidation =
  | {
      status: 'valid';
      userId: string;
      sessionId: string;
      scope: 'IDENTITY';
      contextVersion: number;
    }
  | { status: 'invalid' };
export class SessionOperationError extends Error {
  readonly code = 'SESSION_OPERATION_FAILED';
  constructor() {
    super('Session operation failed');
    this.name = 'SessionOperationError';
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Tx = Prisma.TransactionClient;

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenSecrets,
    private readonly audit: SessionAuditWriter,
  ) {}

  private async transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '750ms'`;
          return operation(tx);
        },
        { isolationLevel: 'ReadCommitted', maxWait: 1000, timeout: 5000 },
      );
    } catch {
      // Never retry ambiguous commits or preserve secret-bearing diagnostics.
      throw new SessionOperationError();
    }
  }

  private async lockUser(tx: Tx, userId: string, read = false) {
    const rows = read
      ? await tx.$queryRaw<
          Array<{ id: string; status: string; emailVerifiedAt: Date | null }>
        >`SELECT id, status::text, "emailVerifiedAt" FROM "User" WHERE id=${userId}::uuid FOR SHARE`
      : await tx.$queryRaw<
          Array<{ id: string; status: string; emailVerifiedAt: Date | null }>
        >`SELECT id, status::text, "emailVerifiedAt" FROM "User" WHERE id=${userId}::uuid FOR UPDATE`;
    return rows[0];
  }

  private async lockSession(
    tx: Tx,
    sessionId: string,
    read = false,
  ): Promise<Session | undefined> {
    const rows = read
      ? await tx.$queryRaw<
          Session[]
        >`SELECT * FROM "Session" WHERE id=${sessionId}::uuid FOR SHARE`
      : await tx.$queryRaw<
          Session[]
        >`SELECT * FROM "Session" WHERE id=${sessionId}::uuid FOR UPDATE`;
    return rows[0];
  }

  private async now(tx: Tx): Promise<Date> {
    const rows = await tx.$queryRaw<
      Array<{ now: Date }>
    >`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
    const now = rows[0]?.now;
    if (!now) throw new SessionOperationError();
    return now;
  }

  private eligible(
    user: { status: string; emailVerifiedAt: Date | null } | undefined,
  ): boolean {
    return user?.status === 'ACTIVE' && user.emailVerifiedAt !== null;
  }
  private relevant(session: Session, now: Date): boolean {
    return (
      session.revokedAt === null &&
      !isExpired(session.idleExpiresAt, now) &&
      !isExpired(session.absoluteExpiresAt, now)
    );
  }

  private async issue(
    tx: Tx,
    session: Session,
    now: Date,
    predecessorId?: string,
  ): Promise<IssuedSession> {
    const times = activityTimes(
      now,
      session.absoluteExpiresAt,
      policyFor(session.client),
    );
    const access = this.tokens.issue('access');
    const refresh = this.tokens.issue('refresh');
    await tx.accessToken.create({
      data: {
        sessionId: session.id,
        digest: access.digest,
        contextVersion: session.contextVersion,
        createdAt: now,
        expiresAt: times.accessExpiresAt,
      },
      select: { id: true },
    });
    await tx.refreshToken.create({
      data: {
        sessionId: session.id,
        digest: refresh.digest,
        createdAt: now,
        expiresAt: times.refreshExpiresAt,
        predecessorId,
      },
      select: { id: true },
    });
    return {
      status: 'issued',
      sessionId: session.id,
      accessToken: access.raw,
      refreshToken: refresh.raw,
      accessExpiresAt: times.accessExpiresAt,
      refreshExpiresAt: times.refreshExpiresAt,
    };
  }

  async establish(
    identity: AuthenticatedIdentity,
    client: SessionClientKind,
    correlationId: string,
  ): Promise<SessionIssuance> {
    if (
      !uuid.test(identity.userId) ||
      !uuid.test(correlationId) ||
      !['BROWSER', 'MOBILE'].includes(client)
    )
      return { status: 'invalid' };
    return this.transaction(async (tx) => {
      const user = await this.lockUser(tx, identity.userId);
      if (!this.eligible(user)) return { status: 'invalid' };
      const now = await this.now(tx);
      const policy = policyFor(client);
      const absoluteExpiresAt = new Date(now.getTime() + policy.absoluteMs);
      const times = activityTimes(now, absoluteExpiresAt, policy);
      const session = await tx.session.create({
        data: {
          userId: identity.userId,
          client,
          createdAt: now,
          lastActivityAt: now,
          idleExpiresAt: times.idleExpiresAt,
          absoluteExpiresAt,
        },
      });
      const issued = await this.issue(tx, session, now);
      await this.audit.write(tx, {
        kind: 'established',
        userId: identity.userId,
        sessionId: session.id,
        client,
        correlationId,
      });
      return issued;
    });
  }

  async validateAccess(raw: string): Promise<SessionValidation> {
    const digest = this.tokens.digest(raw, 'access');
    if (!digest) return { status: 'invalid' };
    return this.transaction(async (tx) => {
      const token = await tx.accessToken.findUnique({
        where: { digest },
        select: {
          sessionId: true,
          contextVersion: true,
          expiresAt: true,
          session: { select: { userId: true } },
        },
      });
      if (!token) return { status: 'invalid' };
      const user = await this.lockUser(tx, token.session.userId, true);
      const session = await this.lockSession(tx, token.sessionId, true);
      const now = await this.now(tx);
      if (
        !session ||
        !this.eligible(user) ||
        !this.relevant(session, now) ||
        isExpired(token.expiresAt, now) ||
        token.contextVersion !== session.contextVersion ||
        session.scope !== 'IDENTITY'
      )
        return { status: 'invalid' };
      return {
        status: 'valid',
        userId: session.userId,
        sessionId: session.id,
        scope: 'IDENTITY',
        contextVersion: session.contextVersion,
      };
    });
  }

  async refresh(raw: string, correlationId: string): Promise<SessionIssuance> {
    const digest = this.tokens.digest(raw, 'refresh');
    if (!digest || !uuid.test(correlationId)) return { status: 'invalid' };
    return this.transaction(async (tx) => {
      const located = await tx.refreshToken.findUnique({
        where: { digest },
        select: {
          id: true,
          sessionId: true,
          session: { select: { userId: true } },
        },
      });
      if (!located) return { status: 'invalid' };
      const user = await this.lockUser(tx, located.session.userId);
      const session = await this.lockSession(tx, located.sessionId);
      const rows = await tx.$queryRaw<
        Array<{ id: string; consumedAt: Date | null; expiresAt: Date }>
      >`SELECT id,"consumedAt","expiresAt" FROM "RefreshToken" WHERE id=${located.id}::uuid FOR UPDATE`;
      const token = rows[0];
      const now = await this.now(tx);
      if (!session || !token || !this.relevant(session, now))
        return { status: 'invalid' };
      if (token.consumedAt !== null) {
        await tx.session.update({
          where: { id: session.id },
          data: { revokedAt: now, revocationReason: 'REFRESH_REPLAY' },
          select: { id: true },
        });
        await this.audit.write(tx, {
          kind: 'refresh_replay',
          userId: session.userId,
          sessionId: session.id,
          correlationId,
        });
        // Return commits revocation/audit before reporting replay; do NOT throw here.
        return { status: 'replay' };
      }
      if (!this.eligible(user) || isExpired(token.expiresAt, now))
        return { status: 'invalid' };
      await tx.refreshToken.update({
        where: { id: token.id },
        data: { consumedAt: now },
        select: { id: true },
      });
      const times = activityTimes(
        now,
        session.absoluteExpiresAt,
        policyFor(session.client),
      );
      await tx.session.update({
        where: { id: session.id },
        data: { lastActivityAt: now, idleExpiresAt: times.idleExpiresAt },
        select: { id: true },
      });
      const issued = await this.issue(tx, session, now, token.id);
      await this.audit.write(tx, {
        kind: 'rotated',
        userId: session.userId,
        sessionId: session.id,
        correlationId,
      });
      return issued;
    });
  }

  async revoke(
    identity: AuthenticatedIdentity,
    sessionId: string,
    correlationId: string,
  ): Promise<{ status: 'revoked' | 'unchanged' | 'invalid' }> {
    if (
      !uuid.test(identity.userId) ||
      !uuid.test(sessionId) ||
      !uuid.test(correlationId)
    )
      return { status: 'invalid' };
    return this.transaction(async (tx) => {
      if (!(await this.lockUser(tx, identity.userId)))
        return { status: 'invalid' };
      const session = await this.lockSession(tx, sessionId);
      if (!session || session.userId !== identity.userId)
        return { status: 'invalid' };
      if (session.revokedAt) return { status: 'unchanged' };
      await tx.session.update({
        where: { id: session.id },
        data: { revokedAt: await this.now(tx), revocationReason: 'EXPLICIT' },
        select: { id: true },
      });
      await this.audit.write(tx, {
        kind: 'revoked',
        userId: identity.userId,
        sessionId,
        correlationId,
      });
      return { status: 'revoked' };
    });
  }

  async revokeAll(
    identity: AuthenticatedIdentity,
    correlationId: string,
  ): Promise<{ status: 'revoked' | 'invalid'; count: number }> {
    if (!uuid.test(identity.userId) || !uuid.test(correlationId))
      return { status: 'invalid', count: 0 };
    return this.transaction(async (tx) => {
      if (!(await this.lockUser(tx, identity.userId)))
        return { status: 'invalid', count: 0 };
      await tx.$queryRaw`SELECT id FROM "Session" WHERE "userId"=${identity.userId}::uuid AND "revokedAt" IS NULL ORDER BY id FOR UPDATE`;
      const result = await tx.session.updateMany({
        where: { userId: identity.userId, revokedAt: null },
        data: { revokedAt: await this.now(tx), revocationReason: 'REVOKE_ALL' },
      });
      if (result.count)
        await this.audit.write(tx, {
          kind: 'revoked_all',
          userId: identity.userId,
          count: result.count,
          correlationId,
        });
      return { status: 'revoked', count: result.count };
    });
  }
}
