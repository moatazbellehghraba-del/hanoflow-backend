import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { IdentityModule } from '../identity.module.js';
import { PasswordHasher } from './password-hasher.service.js';
import { PASSWORD_ENGINE, type PasswordEngine } from './password-engine.js';
import { PASSWORD_HASH_OPTIONS } from './password.config.js';
import {
  PasswordHashRejectedError,
  PasswordOperationError,
} from './password.errors.js';

// Synthetic runtime-only inputs. Assertions never print password/hash values.
const input = ' Synthetic 😀 password with spaces ';

describe('PasswordHasher with real native Argon2', () => {
  let module: TestingModule;
  let hasher: PasswordHasher;
  let encoded: string;
  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [IdentityModule],
    }).compile();
    await module.init();
    hasher = module.get(PasswordHasher);
    encoded = await hasher.hash(input);
  });
  afterAll(async () => {
    await module.close();
  });

  it('encodes the explicit Argon2id v19 profile and random salt', () => {
    expect(
      /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(
        encoded,
      ),
    ).toBe(true);
    expect(hasher.needsUpgrade(encoded)).toBe(false);
  });

  it('verifies the exact password through the library', async () => {
    expect(await hasher.verify(input, encoded)).toEqual({
      status: 'match',
      needsUpgrade: false,
    });
  });

  it('rejects a wrong password without throwing operational errors', async () => {
    expect(await hasher.verify('wrong', encoded)).toEqual({
      status: 'mismatch',
    });
  });

  it('generates different hashes for identical inputs', async () => {
    const other = await hasher.hash(input);
    expect(other === encoded).toBe(false);
    expect(await hasher.verify(input, other)).toEqual({
      status: 'match',
      needsUpgrade: false,
    });
  });

  it('does not trim, normalize Unicode or transform significant spaces', async () => {
    expect(await hasher.verify(input.trim(), encoded)).toEqual({
      status: 'mismatch',
    });
    const decomposed = 'long enough cafe\u0301 phrase';
    const value = await hasher.hash(decomposed);
    expect(await hasher.verify(decomposed, value)).toEqual({
      status: 'match',
      needsUpgrade: false,
    });
    expect(await hasher.verify(decomposed.normalize('NFC'), value)).toEqual({
      status: 'mismatch',
    });
  });

  it('verifies a supported older profile and short historical password without creation policy', async () => {
    const historical = await argon2.hash('short', {
      ...PASSWORD_HASH_OPTIONS,
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
    });
    expect(hasher.needsUpgrade(historical)).toBe(true);
    expect(await hasher.verify('short', historical)).toEqual({
      status: 'match',
      needsUpgrade: true,
    });
  });

  it('handles malformed hashes safely', async () => {
    expect(await hasher.verify(input, 'not-a-hash')).toEqual({
      status: 'invalid-hash',
    });
    expect(() => hasher.needsUpgrade('not-a-hash')).toThrow(
      PasswordHashRejectedError,
    );
  });

  it.each([
    ['algorithm', () => encoded.replace('argon2id', 'argon2i')],
    ['version', () => encoded.replace('v=19', 'v=16')],
    ['memory', () => encoded.replace('m=65536', 'm=999999999')],
    ['time', () => encoded.replace('t=3', 't=999999999')],
    ['parallelism', () => encoded.replace('p=1', 'p=64')],
    ['below supported memory', () => encoded.replace('m=65536', 'm=1024')],
    ['below supported time', () => encoded.replace('t=3', 't=1')],
  ])(
    'rejects unsupported %s before expensive verification',
    async (_label, mutate) => {
      if (typeof mutate !== 'function') throw new Error('Invalid test case');
      expect(await hasher.verify(input, mutate())).toEqual({
        status: 'unsupported-hash',
      });
    },
  );

  it('rejects oversized and ill-formed verification input safely', async () => {
    expect(await hasher.verify('a'.repeat(1025), encoded)).toEqual({
      status: 'invalid-input',
    });
    expect(await hasher.verify('\ud800', encoded)).toEqual({
      status: 'invalid-input',
    });
  });
});

describe('PasswordHasher operational failures', () => {
  it('sanitizes native failures, skips invalid inputs and releases capacity', async () => {
    let calls = 0;
    const engine: PasswordEngine = {
      hash: () => {
        calls++;
        return Promise.reject(new Error(input));
      },
      verify: () => Promise.reject(new Error(input)),
    };
    const module = await Test.createTestingModule({ imports: [IdentityModule] })
      .overrideProvider(PASSWORD_ENGINE)
      .useValue(engine)
      .compile();
    const hasher = module.get(PasswordHasher);
    try {
      await expect(hasher.hash(input)).rejects.toBeInstanceOf(
        PasswordOperationError,
      );
      await expect(hasher.hash(input)).rejects.toMatchObject({
        code: 'PASSWORD_OPERATION_FAILED',
        message: 'Password processing failed',
      });
      expect(calls).toBe(2);
      expect(await hasher.verify(input, 'invalid')).toEqual({
        status: 'invalid-hash',
      });
      expect(calls).toBe(2);
      const encoded = await argon2.hash(input, {
        ...PASSWORD_HASH_OPTIONS,
        type: argon2.argon2id,
      });
      await expect(hasher.verify(input, encoded)).rejects.toBeInstanceOf(
        PasswordOperationError,
      );
    } finally {
      await module.close();
    }
  });
});
