import 'reflect-metadata';
import './setup-database-env.js';
import { createFixtureClient } from './helpers/database-fixture.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/infrastructure/database/database.module.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { argon2Engine } from '../src/modules/identity/passwords/password-engine.js';
import { getTestDatabaseUrl } from './helpers/database-target.js';

describe('PasswordCredential (guarded real PostgreSQL)', () => {
  let module: TestingModule;
  let prisma: PrismaClient;
  let encoded: string;
  const users = new Set<string>();
  const credentials = new Set<string>();

  beforeAll(async () => {
    const url = getTestDatabaseUrl(process.env);
    module = await Test.createTestingModule({ imports: [DatabaseModule] })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ DATABASE_URL: url }))
      .compile();
    await module.init();
    prisma = await createFixtureClient();
    expect(
      await prisma.$queryRaw<
        Array<{ name: string }>
      >`SELECT current_database() AS name`,
    ).toEqual([{ name: 'hanoflow_test' }]);
    // Hash outside any database transaction; synthetic runtime-only fixture.
    encoded = await argon2Engine.hash('Synthetic credential fixture only');
  });

  afterEach(async () => {
    await prisma.$transaction([
      prisma.passwordCredential.deleteMany({
        where: { userId: { in: [...credentials] } },
      }),
      prisma.user.deleteMany({ where: { id: { in: [...users] } } }),
    ]);
    credentials.clear();
    users.clear();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await module?.close();
  });

  function user() {
    const id = randomUUID();
    users.add(id);
    const email = `task23-${id}@example.test`;
    return prisma.user.create({ data: { id, email, canonicalEmail: email } });
  }
  function credential(
    userId: string,
    data: Partial<Prisma.PasswordCredentialUncheckedCreateInput> = {},
  ) {
    credentials.add(userId);
    return prisma.passwordCredential.create({
      data: { passwordHash: encoded, ...data, userId },
      select: {
        userId: true,
        passwordChangedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
  async function resultCode(operation: Promise<unknown>): Promise<string> {
    // Never print Prisma errors: their messages may contain credential arguments.
    try {
      await operation;
      return 'SUCCESS';
    } catch (error) {
      return error instanceof Prisma.PrismaClientKnownRequestError
        ? error.code
        : 'DATABASE_REJECTED';
    }
  }

  it('allows a global user without a password credential', async () => {
    const person = await user();
    expect(
      await prisma.passwordCredential.count({ where: { userId: person.id } }),
    ).toBe(0);
  });

  it('persists a valid encoded credential under the existing UUID user primary key', async () => {
    const person = await user();
    const created = await credential(person.id);
    expect(created.userId).toBe(person.id);
    const stored = await prisma.passwordCredential.findUnique({
      where: { userId: person.id },
      select: { passwordHash: true },
    });
    expect(stored?.passwordHash === encoded).toBe(true);
  });

  it('enforces one credential per user at the database level', async () => {
    const person = await user();
    await credential(person.id);
    expect(await resultCode(credential(person.id))).toBe('P2002');
  });

  it('rejects a nonexistent user reference', async () => {
    expect(await resultCode(credential(randomUUID()))).toBe('P2003');
  });

  it('restricts user deletion and primary-key updates while preserving the credential', async () => {
    const person = await user();
    await credential(person.id);
    expect(
      await resultCode(prisma.user.delete({ where: { id: person.id } })),
    ).toBe('P2003');
    expect(
      await resultCode(
        prisma.user.update({
          where: { id: person.id },
          data: { id: randomUUID() },
        }),
      ),
    ).toBe('P2039'); // Immutable identifier CHECK precedes the restricted FK.
    expect(
      await prisma.passwordCredential.count({ where: { userId: person.id } }),
    ).toBe(1);
  });

  it('persists explicit timezone-aware credential timestamps', async () => {
    const person = await user();
    const timestamp = new Date('2026-01-01T12:34:56.789Z');
    const created = await credential(person.id, {
      passwordChangedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(created.passwordChangedAt).toEqual(timestamp);
    expect(created.createdAt).toEqual(timestamp);
    expect(created.updatedAt).toEqual(timestamp);
  });

  it('does not conflate internal hash replacement with a password change', async () => {
    const person = await user();
    const changed = new Date('2026-01-01T00:00:00.000Z');
    await credential(person.id, {
      passwordChangedAt: changed,
      updatedAt: changed,
    });
    // Persistence support only: no change/rehash workflow is exposed.
    const updated = await prisma.passwordCredential.update({
      where: { userId: person.id },
      data: { passwordHash: encoded },
      select: { passwordChangedAt: true, updatedAt: true },
    });
    expect(updated.passwordChangedAt).toEqual(changed);
    expect(updated.updatedAt.getTime() > changed.getTime()).toBe(true);
  });

  it('supports a future compare-and-swap without overwriting a newer credential', async () => {
    const person = await user();
    await credential(person.id);
    const result = await prisma.passwordCredential.updateMany({
      where: {
        userId: person.id,
        passwordHash: 'stale synthetic comparison only',
      },
      data: { passwordHash: encoded },
    });
    expect(result.count).toBe(0);
    expect(
      await prisma.passwordCredential.count({ where: { userId: person.id } }),
    ).toBe(1);
  });

  it('rejects empty or oversized stored values without disclosing their contents', async () => {
    const person = await user();
    expect(
      await resultCode(credential(person.id, { passwordHash: ' ' })),
    ).not.toBe('SUCCESS');
    expect(
      await resultCode(
        credential(person.id, { passwordHash: 'x'.repeat(513) }),
      ),
    ).not.toBe('SUCCESS');
  });

  it('does not change global user lifecycle when a credential is created', async () => {
    const person = await user();
    await credential(person.id);
    const after = await prisma.user.findUnique({
      where: { id: person.id },
      select: { status: true, updatedAt: true },
    });
    expect(after).toEqual({
      status: person.status,
      updatedAt: person.updatedAt,
    });
  });
});
