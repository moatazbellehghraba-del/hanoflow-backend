import { Injectable } from '@nestjs/common';
import type { Prisma, Session } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import {
  identityContext,
  sessionContext,
  sessionLookup,
  tenantContext,
} from '../../infrastructure/database/database-context.js';
import { SessionAuditWriter } from '../audit/session-audit.writer.js';
import { TenantAuditWriter } from '../audit/tenant-audit.writer.js';
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
      scope: 'IDENTITY' | 'TENANT';
      tenantId?: string;
      membershipId?: string;
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
    private readonly tenantAudit: TenantAuditWriter,
  ) {}

  private async transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      await this.prisma.verifyIdentity();
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
    await identityContext(tx, userId);
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
    await sessionContext(tx, session.id);
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
        contextVersion: session.contextVersion,
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
      await sessionLookup(tx);
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
    if (!this.tokens.digest(raw, 'access')) return { status: 'invalid' };
    return this.transaction((tx) => this.validateAccessIn(tx, raw));
  }

  // Public internal transaction boundary for Authorization; callers cannot bypass
  // credential checks by supplying a fabricated SessionValidation object.
  async validateAccessIn(
    tx: Tx,
    raw: string,
    tenantWrite = false,
  ): Promise<SessionValidation> {
    const digest = this.tokens.digest(raw, 'access');
    if (!digest) return { status: 'invalid' };
    await sessionLookup(tx, digest);
    const token = await tx.accessToken.findUnique({
      where: { digest },
      select: {
        sessionId: true,
        contextVersion: true,
        expiresAt: true,
      },
    });
    if (!token) return { status: 'invalid' };
    await sessionContext(tx, token.sessionId);
    const locatedSession = await tx.session.findUnique({
      where: { id: token.sessionId },
      select: { userId: true },
    });
    if (!locatedSession) return { status: 'invalid' };
    const user = await this.lockUser(tx, locatedSession.userId, true);
    const session = await this.lockSession(tx, token.sessionId, true);
    const contextEligible = session
      ? await this.contextEligible(tx, session, tenantWrite)
      : false;
    const now = await this.now(tx);
    if (
      !session ||
      !this.eligible(user) ||
      !this.relevant(session, now) ||
      isExpired(token.expiresAt, now) ||
      token.contextVersion !== session.contextVersion ||
      !contextEligible
    )
      return { status: 'invalid' };
    return {
      status: 'valid',
      userId: session.userId,
      sessionId: session.id,
      scope: session.scope,
      ...(session.scope === 'TENANT' && session.tenantId && session.membershipId
        ? { tenantId: session.tenantId, membershipId: session.membershipId }
        : {}),
      contextVersion: session.contextVersion,
    };
  }

  async refresh(raw: string, correlationId: string): Promise<SessionIssuance> {
    const digest = this.tokens.digest(raw, 'refresh');
    if (!digest || !uuid.test(correlationId)) return { status: 'invalid' };
    return this.transaction(async (tx) => {
      await sessionLookup(tx, digest);
      const located = await tx.refreshToken.findUnique({
        where: { digest },
        select: {
          id: true,
          sessionId: true,
        },
      });
      if (!located) return { status: 'invalid' };
      await sessionContext(tx, located.sessionId);
      const locatedSession = await tx.session.findUnique({
        where: { id: located.sessionId },
        select: { userId: true },
      });
      if (!locatedSession) return { status: 'invalid' };
      const user = await this.lockUser(tx, locatedSession.userId);
      const session = await this.lockSession(tx, located.sessionId);
      const contextEligible = session
        ? await this.contextEligible(tx, session)
        : false;
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          consumedAt: Date | null;
          expiresAt: Date;
          contextVersion: number;
        }>
      >`SELECT id,"consumedAt","expiresAt","contextVersion" FROM "RefreshToken" WHERE id=${located.id}::uuid FOR UPDATE`;
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
      if (
        !this.eligible(user) ||
        !contextEligible ||
        token.contextVersion !== session.contextVersion ||
        isExpired(token.expiresAt, now)
      )
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

  private async contextEligible(
    tx: Tx,
    session: Session,
    write = false,
  ): Promise<boolean> {
    if (session.scope === 'IDENTITY')
      return session.tenantId === null && session.membershipId === null;
    if (!session.tenantId || !session.membershipId) return false;
    const tenants = write
      ? await tx.$queryRaw<
          Array<{ status: string }>
        >`SELECT status::text FROM "Tenant" WHERE id=${session.tenantId}::uuid FOR UPDATE`
      : await tx.$queryRaw<
          Array<{ status: string }>
        >`SELECT status::text FROM "Tenant" WHERE id=${session.tenantId}::uuid FOR SHARE`;
    const members = await tx.$queryRaw<
      Array<{ status: string }>
    >`SELECT status::text FROM "Membership" WHERE id=${session.membershipId}::uuid AND "tenantId"=${session.tenantId}::uuid AND "userId"=${session.userId}::uuid FOR SHARE`;
    return tenants[0]?.status === 'ACTIVE' && members[0]?.status === 'ACTIVE';
  }

  async selectTenant(
    accessRaw: string,
    refreshRaw: string,
    tenantId: string,
    correlationId: string,
  ): Promise<SessionIssuance> {
    const accessDigest = this.tokens.digest(accessRaw, 'access');
    const refreshDigest = this.tokens.digest(refreshRaw, 'refresh');
    if (
      !accessDigest ||
      !refreshDigest ||
      !uuid.test(tenantId) ||
      !uuid.test(correlationId)
    )
      return { status: 'invalid' };
    return this.transaction(async (tx) => {
      await sessionLookup(tx, accessDigest);
      const access = await tx.accessToken.findUnique({
        where: { digest: accessDigest },
        select: { sessionId: true, contextVersion: true, expiresAt: true },
      });
      await sessionLookup(tx, refreshDigest);
      const refresh = await tx.refreshToken.findUnique({
        where: { digest: refreshDigest },
        select: {
          id: true,
          sessionId: true,
        },
      });
      if (!access || !refresh || access.sessionId !== refresh.sessionId)
        return { status: 'invalid' };
      await sessionContext(tx, refresh.sessionId);
      const locatedSession = await tx.session.findUnique({
        where: { id: refresh.sessionId },
        select: { userId: true },
      });
      if (!locatedSession) return { status: 'invalid' };
      const user = await this.lockUser(tx, locatedSession.userId);
      const session = await this.lockSession(tx, refresh.sessionId);
      if (!session) return { status: 'invalid' };
      for (const id of [
        ...new Set([tenantId, ...(session.tenantId ? [session.tenantId] : [])]),
      ].sort())
        await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id=${id}::uuid FOR SHARE`;
      const currentEligible = await this.contextEligible(tx, session);
      const candidates = await tx.$queryRaw<
        Array<{ id: string; status: string }>
      >`SELECT id,status::text FROM "Membership" WHERE "tenantId"=${tenantId}::uuid AND "userId"=${session.userId}::uuid FOR SHARE`;
      const tenants = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { status: true },
      });
      const rows = await tx.$queryRaw<
        Array<{
          consumedAt: Date | null;
          expiresAt: Date;
          contextVersion: number;
        }>
      >`SELECT "consumedAt","expiresAt","contextVersion" FROM "RefreshToken" WHERE id=${refresh.id}::uuid FOR UPDATE`;
      const token = rows[0];
      const now = await this.now(tx);
      if (
        !token ||
        !this.eligible(user) ||
        !this.relevant(session, now) ||
        isExpired(access.expiresAt, now)
      )
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
        return { status: 'replay' };
      }
      const member = candidates[0];
      if (
        !currentEligible ||
        !member ||
        member.status !== 'ACTIVE' ||
        tenants?.status !== 'ACTIVE' ||
        access.contextVersion !== session.contextVersion ||
        token.contextVersion !== session.contextVersion ||
        isExpired(token.expiresAt, now)
      )
        return { status: 'invalid' };
      await tx.refreshToken.update({
        where: { id: refresh.id },
        data: { consumedAt: now },
        select: { id: true },
      });
      const times = activityTimes(
        now,
        session.absoluteExpiresAt,
        policyFor(session.client),
      );
      const selected = await tx.session.update({
        where: { id: session.id },
        data: {
          scope: 'TENANT',
          tenantId,
          membershipId: member.id,
          contextVersion: { increment: 1 },
          lastActivityAt: now,
          idleExpiresAt: times.idleExpiresAt,
        },
      });
      const issued = await this.issue(tx, selected, now, refresh.id);
      await tenantContext(tx, tenantId, member.id);
      await this.tenantAudit.write(tx, {
        kind: 'context_selected',
        tenantId,
        userId: session.userId,
        targetId: session.id,
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
      await sessionLookup(tx);
      if (!(await this.lockUser(tx, identity.userId)))
        return { status: 'invalid' };
      const session = await this.lockSession(tx, sessionId);
      if (!session || session.userId !== identity.userId)
        return { status: 'invalid' };
      if (session.revokedAt) return { status: 'unchanged' };
      await sessionContext(tx, session.id);
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
      await sessionLookup(tx);
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
