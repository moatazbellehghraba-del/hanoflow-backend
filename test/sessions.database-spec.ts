import 'reflect-metadata';
import 'dotenv/config';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { SessionsModule } from '../src/modules/sessions/sessions.module.js';
import {
  SessionsService,
  SessionOperationError,
  type IssuedSession,
} from '../src/modules/sessions/sessions.service.js';
import { TokenSecrets } from '../src/modules/sessions/token-secrets.js';
import { SessionAuditWriter } from '../src/modules/audit/session-audit.writer.js';
import { getTestDatabaseUrl } from './helpers/database-target.js';

describe('Sessions and rotation (real PostgreSQL, independent app pools)', () => {
  let first: TestingModule;
  let second: TestingModule;
  let db: PrismaService;
  let otherDb: PrismaService;
  let sessions: SessionsService;
  let other: SessionsService;
  let secrets: TokenSecrets;
  const users = new Set<string>();
  const correlations = new Set<string>();
  function correlation() {
    const id = randomUUID();
    correlations.add(id);
    return id;
  }
  beforeAll(async () => {
    const url = getTestDatabaseUrl(process.env);
    async function application() {
      const module = await Test.createTestingModule({
        imports: [SessionsModule],
      })
        .overrideProvider(ConfigService)
        .useValue(new ConfigService({ DATABASE_URL: url }))
        .compile();
      await module.init();
      return module;
    }
    first = await application();
    second = await application();
    db = first.get(PrismaService);
    otherDb = second.get(PrismaService);
    sessions = first.get(SessionsService);
    other = second.get(SessionsService);
    secrets = first.get(TokenSecrets);
    expect(
      await db.$queryRaw<
        Array<{ name: string }>
      >`SELECT current_database() AS name`,
    ).toEqual([{ name: 'hanoflow_test' }]);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    const owned = [...users];
    const rows = await db.session.findMany({
      where: { userId: { in: owned } },
      select: { id: true },
    });
    const sessionIds = rows.map((row) => row.id);
    await db.$transaction([
      db.auditEvent.deleteMany({
        where: {
          correlationId: { in: [...correlations] },
        },
      }),
      db.accessToken.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      db.refreshToken.updateMany({
        where: { sessionId: { in: sessionIds } },
        data: { predecessorId: null },
      }),
      db.refreshToken.deleteMany({ where: { sessionId: { in: sessionIds } } }),
      db.session.deleteMany({ where: { id: { in: sessionIds } } }),
      db.user.deleteMany({ where: { id: { in: owned } } }),
    ]);
    users.clear();
    correlations.clear();
  });
  afterAll(async () => {
    await second?.close();
    await first?.close();
  });
  function user(data: Partial<Prisma.UserUncheckedCreateInput> = {}) {
    const id = randomUUID();
    users.add(id);
    const email = `task24-${id}@example.test`;
    return db.user.create({
      data: {
        id,
        email,
        canonicalEmail: email,
        status: 'ACTIVE',
        emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
        ...data,
      },
    });
  }
  async function issued(
    userId: string,
    service = sessions,
    client: 'BROWSER' | 'MOBILE' = 'BROWSER',
  ): Promise<IssuedSession> {
    const value = await service.establish({ userId }, client, correlation());
    if (value.status !== 'issued')
      throw new Error('Expected successful synthetic session issuance');
    return value;
  }
  async function now() {
    const rows = await db.$queryRaw<
      Array<{ now: Date }>
    >`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`;
    if (!rows[0]) throw new Error('Missing database time');
    return rows[0].now;
  }
  async function bareSession(
    userId: string,
    data: Partial<Prisma.SessionUncheckedCreateInput> = {},
  ) {
    const at = await now();
    return db.session.create({
      data: {
        userId,
        client: 'BROWSER',
        createdAt: at,
        lastActivityAt: at,
        idleExpiresAt: new Date(at.getTime() + 1800000),
        absoluteExpiresAt: new Date(at.getTime() + 43200000),
        ...data,
      },
    });
  }
  function access(
    sessionId: string,
    data: Partial<Prisma.AccessTokenUncheckedCreateInput> = {},
  ) {
    return db.accessToken.create({
      data: {
        sessionId,
        digest: secrets.issue('access').digest,
        contextVersion: 1,
        expiresAt: new Date(Date.now() + 600000),
        ...data,
      },
      select: { id: true },
    });
  }
  function refreshToken(
    sessionId: string,
    data: Partial<Prisma.RefreshTokenUncheckedCreateInput> = {},
  ) {
    return db.refreshToken.create({
      data: {
        sessionId,
        digest: secrets.issue('refresh').digest,
        expiresAt: new Date(Date.now() + 600000),
        ...data,
      },
      select: { id: true },
    });
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
  async function root(sessionId: string) {
    const token = await db.refreshToken.findFirst({
      where: { sessionId, predecessorId: null },
      select: { id: true, consumedAt: true, expiresAt: true },
    });
    if (!token) throw new Error('Missing synthetic refresh root');
    return token;
  }

  it('uses distinct real PostgreSQL backend connections', async () => {
    const [a, b] = await Promise.all([
      db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`,
      otherDb.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`,
    ]);
    expect(a[0]?.pid !== b[0]?.pid).toBe(true);
  });
  it('establishes atomically with digest-only storage and minimal trusted validation', async () => {
    const person = await user();
    const value = await issued(person.id);
    const result = await sessions.validateAccess(value.accessToken);
    expect(result).toEqual({
      status: 'valid',
      userId: person.id,
      sessionId: value.sessionId,
      scope: 'IDENTITY',
      contextVersion: 1,
    });
    const stored = await db.accessToken.findFirst({
      where: { sessionId: value.sessionId },
      select: { digest: true },
    });
    expect(stored?.digest.length).toBe(32);
    expect(
      stored?.digest.every(
        (byte, index) =>
          byte === secrets.digest(value.accessToken, 'access')?.[index],
      ),
    ).toBe(true);
    const columns = await db.$queryRaw<
      Array<{ column_name: string }>
    >`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('Session','AccessToken','RefreshToken')`;
    expect(
      columns.some((row) => /raw|secret|password/i.test(row.column_name)),
    ).toBe(false);
  });
  it('supports independent browser and mobile sessions with approved lifetimes', async () => {
    const person = await user();
    await issued(person.id);
    await issued(person.id, sessions, 'MOBILE');
    const rows = await db.session.findMany({
      where: { userId: person.id },
      orderBy: { client: 'asc' },
    });
    expect(rows.length).toBe(2);
    expect(
      rows.map(
        (row) => row.absoluteExpiresAt.getTime() - row.createdAt.getTime(),
      ),
    ).toEqual([43200000, 2592000000]);
    expect(
      rows.map((row) => row.idleExpiresAt.getTime() - row.createdAt.getTime()),
    ).toEqual([1800000, 604800000]);
  });
  it.each(['PENDING', 'SUSPENDED', 'DEACTIVATED'] as const)(
    'rejects %s users without partial records',
    async (status) => {
      const person = await user({ status });
      expect(
        (
          await sessions.establish(
            { userId: person.id },
            'BROWSER',
            correlation(),
          )
        ).status,
      ).toBe('invalid');
      expect(await db.session.count({ where: { userId: person.id } })).toBe(0);
      expect(
        await db.auditEvent.count({ where: { actorUserId: person.id } }),
      ).toBe(0);
    },
  );
  it('rejects active users with unverified email and nonexistent identities', async () => {
    const person = await user({ emailVerifiedAt: null });
    expect(
      (
        await sessions.establish(
          { userId: person.id },
          'BROWSER',
          correlation(),
        )
      ).status,
    ).toBe('invalid');
    expect(
      (
        await sessions.establish(
          { userId: randomUUID() },
          'BROWSER',
          correlation(),
        )
      ).status,
    ).toBe('invalid');
  });
  it('rolls back establishment if safe audit persistence fails', async () => {
    const person = await user();
    jest
      .spyOn(first.get(SessionAuditWriter), 'write')
      .mockRejectedValue(new Error('synthetic audit failure'));
    await expect(
      sessions.establish({ userId: person.id }, 'BROWSER', correlation()),
    ).rejects.toBeInstanceOf(SessionOperationError);
    expect(await db.session.count({ where: { userId: person.id } })).toBe(0);
    expect(
      await db.accessToken.count({ where: { session: { userId: person.id } } }),
    ).toBe(0);
  });
  it('does not update activity or append audit events on access validation', async () => {
    const person = await user();
    const value = await issued(person.id);
    const before = await db.session.findUnique({
      where: { id: value.sessionId },
    });
    await sessions.validateAccess(value.accessToken);
    await sessions.validateAccess(value.accessToken);
    expect(
      await db.session.findUnique({ where: { id: value.sessionId } }),
    ).toEqual(before);
    expect(
      await db.auditEvent.count({ where: { actorUserId: person.id } }),
    ).toBe(1);
  });
  it('rejects unknown, malformed and substituted access/refresh credentials without audit floods', async () => {
    const person = await user();
    const value = await issued(person.id);
    for (const raw of [
      'invalid',
      secrets.issue('access').raw,
      value.refreshToken,
    ])
      expect((await sessions.validateAccess(raw)).status).toBe('invalid');
    expect(
      (await sessions.refresh(value.accessToken, correlation())).status,
    ).toBe('invalid');
    expect(
      (await sessions.refresh(secrets.issue('refresh').raw, correlation()))
        .status,
    ).toBe('invalid');
    expect(
      await db.auditEvent.count({ where: { actorUserId: person.id } }),
    ).toBe(1);
    expect((await sessions.validateAccess(value.accessToken)).status).toBe(
      'valid',
    );
  });
  it('rejects expired access tokens', async () => {
    const person = await user();
    const value = await issued(person.id);
    const at = await now();
    await db.accessToken.updateMany({
      where: { sessionId: value.sessionId },
      data: {
        createdAt: new Date(at.getTime() - 2000),
        expiresAt: new Date(at.getTime() - 1000),
      },
    });
    expect((await sessions.validateAccess(value.accessToken)).status).toBe(
      'invalid',
    );
  });
  it.each(['idle', 'absolute'] as const)(
    'rejects %s-expired sessions for access and refresh',
    async (kind) => {
      const person = await user();
      const value = await issued(person.id);
      const at = await now();
      await db.session.update({
        where: { id: value.sessionId },
        data: {
          createdAt: new Date(at.getTime() - 4000),
          lastActivityAt: new Date(at.getTime() - 3000),
          idleExpiresAt: new Date(at.getTime() - 2000),
          ...(kind === 'absolute'
            ? { absoluteExpiresAt: new Date(at.getTime() - 1000) }
            : {}),
        },
      });
      expect((await sessions.validateAccess(value.accessToken)).status).toBe(
        'invalid',
      );
      expect(
        (await sessions.refresh(value.refreshToken, correlation())).status,
      ).toBe('invalid');
    },
  );
  it.each(['SUSPENDED', 'DEACTIVATED'] as const)(
    'rechecks current %s user on access and refresh',
    async (status) => {
      const person = await user();
      const value = await issued(person.id);
      await db.user.update({ where: { id: person.id }, data: { status } });
      expect((await sessions.validateAccess(value.accessToken)).status).toBe(
        'invalid',
      );
      expect(
        (await sessions.refresh(value.refreshToken, correlation())).status,
      ).toBe('invalid');
    },
  );
  it('rejects current email verification removal and context-version mismatch', async () => {
    const person = await user();
    const value = await issued(person.id);
    await db.user.update({
      where: { id: person.id },
      data: { emailVerifiedAt: null },
    });
    expect((await sessions.validateAccess(value.accessToken)).status).toBe(
      'invalid',
    );
    await db.user.update({
      where: { id: person.id },
      data: { emailVerifiedAt: new Date() },
    });
    await db.session.update({
      where: { id: value.sessionId },
      data: { contextVersion: 2 },
    });
    expect((await sessions.validateAccess(value.accessToken)).status).toBe(
      'invalid',
    );
  });
  it('rotates exactly one successor, extends idle and preserves absolute expiry and older access', async () => {
    const person = await user();
    const value = await issued(person.id);
    const before = await db.session.findUniqueOrThrow({
      where: { id: value.sessionId },
    });
    const parent = await root(value.sessionId);
    const result = await sessions.refresh(value.refreshToken, correlation());
    expect(result.status).toBe('issued');
    if (result.status !== 'issued') throw new Error('Expected rotation');
    expect(result.refreshToken === value.refreshToken).toBe(false);
    const after = await db.session.findUniqueOrThrow({
      where: { id: value.sessionId },
    });
    expect(after.absoluteExpiresAt).toEqual(before.absoluteExpiresAt);
    expect(
      after.idleExpiresAt.getTime() >= before.idleExpiresAt.getTime(),
    ).toBe(true);
    expect(
      after.lastActivityAt.getTime() >= before.lastActivityAt.getTime(),
    ).toBe(true);
    expect(
      (
        await db.refreshToken.findUniqueOrThrow({
          where: { id: parent.id },
          select: { consumedAt: true },
        })
      ).consumedAt !== null,
    ).toBe(true);
    expect(
      await db.refreshToken.count({ where: { predecessorId: parent.id } }),
    ).toBe(1);
    expect(
      await db.refreshToken.count({
        where: { sessionId: value.sessionId, consumedAt: null },
      }),
    ).toBe(1);
    expect((await sessions.validateAccess(value.accessToken)).status).toBe(
      'valid',
    );
    expect((await sessions.validateAccess(result.accessToken)).status).toBe(
      'valid',
    );
  });
  it('clips rotation credentials and idle to imminent absolute expiry', async () => {
    const person = await user();
    const value = await issued(person.id);
    const at = await now();
    const absolute = new Date(at.getTime() + 60000);
    await db.session.update({
      where: { id: value.sessionId },
      data: { idleExpiresAt: absolute, absoluteExpiresAt: absolute },
    });
    const result = await sessions.refresh(value.refreshToken, correlation());
    expect(result.status).toBe('issued');
    if (result.status !== 'issued')
      throw new Error('Expected clipped rotation');
    expect(result.accessExpiresAt).toEqual(absolute);
    expect(result.refreshExpiresAt).toEqual(absolute);
  });
  it('rejects an expired unconsumed refresh token', async () => {
    const person = await user();
    const value = await issued(person.id);
    const at = await now();
    await db.refreshToken.updateMany({
      where: { sessionId: value.sessionId },
      data: {
        createdAt: new Date(at.getTime() - 2000),
        expiresAt: new Date(at.getTime() - 1000),
      },
    });
    expect(
      (await sessions.refresh(value.refreshToken, correlation())).status,
    ).toBe('invalid');
  });
  it('rolls back consumption, successor and activity on rotation audit failure', async () => {
    const person = await user();
    const value = await issued(person.id);
    const before = await db.session.findUniqueOrThrow({
      where: { id: value.sessionId },
    });
    jest
      .spyOn(first.get(SessionAuditWriter), 'write')
      .mockRejectedValue(new Error('synthetic audit failure'));
    await expect(
      sessions.refresh(value.refreshToken, correlation()),
    ).rejects.toBeInstanceOf(SessionOperationError);
    expect((await root(value.sessionId)).consumedAt).toBeNull();
    expect(
      await db.refreshToken.count({ where: { sessionId: value.sessionId } }),
    ).toBe(1);
    expect(
      await db.accessToken.count({ where: { sessionId: value.sessionId } }),
    ).toBe(1);
    expect(
      await db.session.findUnique({ where: { id: value.sessionId } }),
    ).toEqual(before);
  });
  it('commits replay revocation and its audit before reporting replay', async () => {
    const person = await user();
    const value = await issued(person.id);
    const rotated = await sessions.refresh(value.refreshToken, correlation());
    if (rotated.status !== 'issued') throw new Error('Expected first rotation');
    expect(
      (await sessions.refresh(value.refreshToken, correlation())).status,
    ).toBe('replay');
    const persisted = await otherDb.session.findUniqueOrThrow({
      where: { id: value.sessionId },
    });
    expect(persisted.revocationReason).toBe('REFRESH_REPLAY');
    expect(persisted.revokedAt !== null).toBe(true);
    expect(
      await otherDb.auditEvent.count({
        where: {
          targetId: value.sessionId,
          action: 'session.refresh_replay',
          outcome: 'DENIED',
          actorUserId: null,
        },
      }),
    ).toBe(1);
    expect((await other.validateAccess(rotated.accessToken)).status).toBe(
      'invalid',
    );
    expect(
      (await other.refresh(rotated.refreshToken, correlation())).status,
    ).toBe('invalid');
  });
  it('does not report replay when its audit/revocation transaction cannot commit', async () => {
    const person = await user();
    const value = await issued(person.id);
    await sessions.refresh(value.refreshToken, correlation());
    const spy = jest
      .spyOn(first.get(SessionAuditWriter), 'write')
      .mockRejectedValue(new Error('synthetic audit failure'));
    await expect(
      sessions.refresh(value.refreshToken, correlation()),
    ).rejects.toBeInstanceOf(SessionOperationError);
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: value.sessionId } }))
        .revokedAt,
    ).toBeNull();
    spy.mockRestore();
    expect(
      (await sessions.refresh(value.refreshToken, correlation())).status,
    ).toBe('replay');
  });
  it('detects a consumed replay even if that old token expired while the session remains relevant', async () => {
    const person = await user();
    const value = await issued(person.id);
    await sessions.refresh(value.refreshToken, correlation());
    const at = await now();
    await db.refreshToken.updateMany({
      where: { sessionId: value.sessionId, predecessorId: null },
      data: {
        createdAt: new Date(at.getTime() - 3000),
        consumedAt: new Date(at.getTime() - 2000),
        expiresAt: new Date(at.getTime() - 1000),
      },
    });
    expect(
      (await sessions.refresh(value.refreshToken, correlation())).status,
    ).toBe('replay');
  });
  it('serializes two simultaneous real refreshes to one winner and durable replay revocation', async () => {
    const person = await user();
    const value = await issued(person.id);
    const parent = await root(value.sessionId);
    const results = await Promise.all([
      sessions.refresh(value.refreshToken, correlation()),
      other.refresh(value.refreshToken, correlation()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'issued',
      'replay',
    ]);
    expect(
      await db.refreshToken.count({ where: { predecessorId: parent.id } }),
    ).toBe(1);
    expect(
      (await db.session.findUniqueOrThrow({ where: { id: value.sessionId } }))
        .revocationReason,
    ).toBe('REFRESH_REPLAY');
    const winner = results.find((result) => result.status === 'issued');
    if (!winner || winner.status !== 'issued')
      throw new Error('Missing winner');
    expect((await sessions.validateAccess(winner.accessToken)).status).toBe(
      'invalid',
    );
  });
  it('serializes refresh versus revocation and leaves every credential unusable', async () => {
    const person = await user();
    const value = await issued(person.id);
    const [rotation] = await Promise.all([
      sessions.refresh(value.refreshToken, correlation()),
      other.revoke({ userId: person.id }, value.sessionId, correlation()),
    ]);
    expect(['issued', 'invalid'].includes(rotation.status)).toBe(true);
    expect((await sessions.validateAccess(value.accessToken)).status).toBe(
      'invalid',
    );
    if (rotation.status === 'issued')
      expect((await sessions.validateAccess(rotation.accessToken)).status).toBe(
        'invalid',
      );
  });
  it('makes concurrent revocations idempotent and writes one event', async () => {
    const person = await user();
    const value = await issued(person.id);
    const results = await Promise.all([
      sessions.revoke({ userId: person.id }, value.sessionId, correlation()),
      other.revoke({ userId: person.id }, value.sessionId, correlation()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'revoked',
      'unchanged',
    ]);
    expect(
      await db.auditEvent.count({
        where: { targetId: value.sessionId, action: 'session.revoked' },
      }),
    ).toBe(1);
  });
  it('rotates independent users/sessions without cross-session effects', async () => {
    const a = await user();
    const b = await user();
    const firstValue = await issued(a.id);
    const secondValue = await issued(b.id);
    const results = await Promise.all([
      sessions.refresh(firstValue.refreshToken, correlation()),
      other.refresh(secondValue.refreshToken, correlation()),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'issued',
      'issued',
    ]);
    expect((await sessions.validateAccess(firstValue.accessToken)).status).toBe(
      'valid',
    );
    expect(
      (await sessions.validateAccess(secondValue.accessToken)).status,
    ).toBe('valid');
  });
  it('linearizes revoke-all versus creation using the user lock', async () => {
    const person = await user();
    const old = await issued(person.id);
    const [revoked, created] = await Promise.all([
      sessions.revokeAll({ userId: person.id }, correlation()),
      issued(person.id, other),
    ]);
    expect([1, 2].includes(revoked.count)).toBe(true);
    expect((await sessions.validateAccess(old.accessToken)).status).toBe(
      'invalid',
    );
    expect((await sessions.validateAccess(created.accessToken)).status).toBe(
      revoked.count === 1 ? 'valid' : 'invalid',
    );
  });
  it('revokes one or all owned sessions while preserving unrelated sessions/users', async () => {
    const a = await user();
    const b = await user();
    const one = await issued(a.id);
    const two = await issued(a.id);
    const otherUser = await issued(b.id);
    expect(
      (await sessions.revoke({ userId: b.id }, one.sessionId, correlation()))
        .status,
    ).toBe('invalid');
    await sessions.revoke({ userId: a.id }, one.sessionId, correlation());
    expect((await sessions.validateAccess(two.accessToken)).status).toBe(
      'valid',
    );
    expect(
      (await sessions.refresh(one.refreshToken, correlation())).status,
    ).toBe('invalid');
    expect(
      (await sessions.revokeAll({ userId: a.id }, correlation())).count,
    ).toBe(1);
    expect(
      (await sessions.revokeAll({ userId: a.id }, correlation())).count,
    ).toBe(0);
    expect((await sessions.validateAccess(two.accessToken)).status).toBe(
      'invalid',
    );
    expect((await sessions.validateAccess(otherUser.accessToken)).status).toBe(
      'valid',
    );
  });
  it('records only bounded safe audit fields and valid correlation without token/digest metadata', async () => {
    const person = await user();
    const value = await issued(person.id);
    await sessions.refresh(value.refreshToken, correlation());
    await sessions.refresh(value.refreshToken, correlation());
    const events = await db.auditEvent.findMany({
      where: { correlationId: { in: [...correlations] } },
    });
    const serialized = JSON.stringify(events);
    expect(
      serialized.includes(value.accessToken) ||
        serialized.includes(value.refreshToken),
    ).toBe(false);
    expect(
      events.every(
        (event) =>
          event.scope === 'PLATFORM' &&
          event.tenantId === null &&
          correlations.has(event.correlationId),
      ),
    ).toBe(true);
    expect(
      events.every(
        (event) =>
          event.metadata === null ||
          Object.keys(event.metadata).every((key) =>
            ['client', 'count'].includes(key),
          ),
      ),
    ).toBe(true);
  });
  it('rejects invalid session user references and preserves referenced parents', async () => {
    const nonexistent = randomUUID();
    users.add(nonexistent);
    expect(await code(bareSession(nonexistent))).toBe('P2003');
    const person = await user();
    const value = await issued(person.id);
    expect(await code(db.user.delete({ where: { id: person.id } }))).toBe(
      'P2003',
    );
    expect(
      await code(db.session.delete({ where: { id: value.sessionId } })),
    ).toBe('P2003');
  });
  it('enforces unique access/refresh digests and exact binary lengths', async () => {
    const person = await user();
    const session = await bareSession(person.id);
    const a = secrets.issue('access').digest;
    const r = secrets.issue('refresh').digest;
    await access(session.id, { digest: a });
    expect(await code(access(session.id, { digest: a }))).toBe('P2002');
    await refreshToken(session.id, { digest: r });
    const duplicateAt = await now();
    expect(
      await code(
        refreshToken(session.id, {
          digest: r,
          createdAt: duplicateAt,
          consumedAt: duplicateAt,
        }),
      ),
    ).toBe('P2002');
    expect(
      await code(access(session.id, { digest: new Uint8Array(31) })),
    ).not.toBe('SUCCESS');
    expect(
      await code(refreshToken(session.id, { digest: new Uint8Array(33) })),
    ).not.toBe('SUCCESS');
  });
  it('enforces one unconsumed refresh token per session', async () => {
    const person = await user();
    const value = await issued(person.id);
    expect(await code(refreshToken(value.sessionId))).toBe('P2002');
  });
  it('rejects invalid session/access/refresh timestamps and context values', async () => {
    const person = await user();
    const at = await now();
    expect(await code(bareSession(person.id, { idleExpiresAt: at }))).not.toBe(
      'SUCCESS',
    );
    expect(await code(bareSession(person.id, { contextVersion: 0 }))).not.toBe(
      'SUCCESS',
    );
    expect(await code(bareSession(person.id, { revokedAt: at }))).not.toBe(
      'SUCCESS',
    );
    const session = await bareSession(person.id);
    expect(
      await code(access(session.id, { createdAt: at, expiresAt: at })),
    ).not.toBe('SUCCESS');
    expect(await code(access(session.id, { contextVersion: 0 }))).not.toBe(
      'SUCCESS',
    );
    expect(
      await code(refreshToken(session.id, { createdAt: at, expiresAt: at })),
    ).not.toBe('SUCCESS');
    expect(
      await code(
        refreshToken(session.id, {
          createdAt: at,
          consumedAt: new Date(at.getTime() - 1),
        }),
      ),
    ).not.toBe('SUCCESS');
  });
  it('rejects cross-session lineage, self-reference and duplicate successors', async () => {
    const person = await user();
    const value = await issued(person.id);
    const parent = await root(value.sessionId);
    const secondSession = await bareSession(person.id);
    await db.refreshToken.update({
      where: { id: parent.id },
      data: { consumedAt: await now() },
      select: { id: true },
    });
    expect(
      await code(refreshToken(secondSession.id, { predecessorId: parent.id })),
    ).toBe('P2003');
    const self = randomUUID();
    expect(
      await code(
        refreshToken(secondSession.id, { id: self, predecessorId: self }),
      ),
    ).not.toBe('SUCCESS');
    await refreshToken(value.sessionId, { predecessorId: parent.id });
    const at = await now();
    expect(
      await code(
        refreshToken(value.sessionId, {
          predecessorId: parent.id,
          createdAt: at,
          consumedAt: at,
        }),
      ),
    ).toBe('P2002');
  });
  it('withholds issued credentials until the real transaction commits', async () => {
    const person = await user();
    const value = await issued(person.id);
    let release: () => void = () => undefined;
    let signal: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const writer = first.get(SessionAuditWriter);
    const original = writer.write.bind(writer);
    jest.spyOn(writer, 'write').mockImplementation(async (tx, event) => {
      await original(tx, event);
      if (event.kind === 'rotated') {
        signal();
        await gate;
      }
    });
    let returned = false;
    const pending = sessions
      .refresh(value.refreshToken, correlation())
      .then((result) => {
        returned = true;
        return result;
      });
    try {
      await entered;
      expect(returned).toBe(false);
      expect(
        await otherDb.refreshToken.count({
          where: { sessionId: value.sessionId },
        }),
      ).toBe(1);
      expect((await root(value.sessionId)).consumedAt).toBeNull();
    } finally {
      release();
    }
    expect((await pending).status).toBe('issued');
  });

  it('bounds real PostgreSQL lock waiting and does not consume credentials after timeout', async () => {
    const person = await user();
    const value = await issued(person.id);
    let release: () => void = () => undefined;
    let signal: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${person.id}::uuid FOR UPDATE`;
      signal();
      await gate;
    });
    await locked;
    const started = performance.now();
    try {
      await expect(
        other.refresh(value.refreshToken, correlation()),
      ).rejects.toBeInstanceOf(SessionOperationError);
      expect(performance.now() - started < 2500).toBe(true);
    } finally {
      release();
      await holder;
    }
    expect((await root(value.sessionId)).consumedAt).toBeNull();
    expect(
      await db.refreshToken.count({ where: { sessionId: value.sessionId } }),
    ).toBe(1);
    expect((await sessions.validateAccess(value.accessToken)).status).toBe(
      'valid',
    );
  });

  it('does not emit raw credentials or digests in session operation logs', async () => {
    const logged: unknown[][] = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    const person = await user();
    const value = await issued(person.id);
    await sessions.refresh(value.refreshToken, correlation());
    await sessions.refresh(value.refreshToken, correlation());
    const serialized = JSON.stringify(logged);
    const digest = secrets.digest(value.refreshToken, 'refresh');
    expect(
      serialized.includes(value.accessToken) ||
        serialized.includes(value.refreshToken),
    ).toBe(false);
    expect(
      digest !== undefined &&
        serialized.includes(Buffer.from(digest).toString('hex')),
    ).toBe(false);
  });

  it('retains the reviewed partial unique index and matching composite FK', async () => {
    const rows = await db.$queryRaw<
      Array<{ definition: string }>
    >`SELECT indexdef AS definition FROM pg_indexes WHERE schemaname='public' AND indexname='RefreshToken_one_unconsumed_per_session'`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.definition.includes('WHERE ("consumedAt" IS NULL)')).toBe(
      true,
    );
    const keys = await db.$queryRaw<
      Array<{ definition: string }>
    >`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='RefreshToken_sessionId_predecessorId_fkey'`;
    expect(
      keys[0]?.definition.includes(
        'FOREIGN KEY ("sessionId", "predecessorId") REFERENCES "RefreshToken"("sessionId", id)',
      ),
    ).toBe(true);
  });
});
