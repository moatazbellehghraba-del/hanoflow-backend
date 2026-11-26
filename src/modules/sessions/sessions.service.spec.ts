import 'reflect-metadata';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { SessionsService, SessionOperationError } from './sessions.service.js';
import { TokenSecrets } from './token-secrets.js';

describe('Session boundary offline', () => {
  let module: TestingModule;
  let sessions: SessionsService;
  const transaction = jest.fn<() => Promise<never>>();
  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [SessionsModule] })
      .overrideProvider(PrismaService)
      .useValue({ $transaction: transaction })
      .compile();
    sessions = module.get(SessionsService);
  });
  beforeEach(() => transaction.mockReset());
  afterAll(async () => {
    await module.close();
  });
  it('rejects malformed credentials without database work', async () => {
    expect((await sessions.validateAccess('invalid')).status).toBe('invalid');
    expect((await sessions.refresh('invalid', randomUUID())).status).toBe(
      'invalid',
    );
    expect(transaction.mock.calls.length).toBe(0);
  });
  it('rejects substituted purposes without database work', async () => {
    const tokens = module.get(TokenSecrets);
    expect(
      (await sessions.validateAccess(tokens.issue('refresh').raw)).status,
    ).toBe('invalid');
    expect(
      (await sessions.refresh(tokens.issue('access').raw, randomUUID())).status,
    ).toBe('invalid');
    expect(transaction.mock.calls.length).toBe(0);
  });
  it('rejects invalid command identifiers without database work', async () => {
    expect(
      (await sessions.establish({ userId: 'invalid' }, 'BROWSER', randomUUID()))
        .status,
    ).toBe('invalid');
    expect(
      (await sessions.revoke({ userId: randomUUID() }, 'invalid', randomUUID()))
        .status,
    ).toBe('invalid');
    expect(
      (await sessions.revokeAll({ userId: randomUUID() }, 'invalid')).status,
    ).toBe('invalid');
    expect(transaction.mock.calls.length).toBe(0);
  });
  it('sanitizes ambiguous transaction failures without automatic retry', async () => {
    const token = module.get(TokenSecrets).issue('refresh').raw;
    transaction.mockRejectedValue(new Error(token));
    let captured: unknown;
    try {
      await sessions.refresh(token, randomUUID());
    } catch (error) {
      captured = error;
    }
    expect(captured instanceof SessionOperationError).toBe(true);
    if (!(captured instanceof Error))
      throw new Error('Expected sanitized failure');
    expect(captured.message === 'Session operation failed').toBe(true);
    expect(Object.hasOwn(captured, 'cause')).toBe(false);
    expect(transaction.mock.calls.length).toBe(1);
  });
});
