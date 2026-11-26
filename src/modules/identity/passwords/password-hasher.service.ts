import { Inject, Injectable } from '@nestjs/common';
import {
  PasswordPolicy,
  isSafeVerificationInput,
} from './password-policy.service.js';
import { PasswordCapacity } from './password-capacity.service.js';
import { PASSWORD_ENGINE, type PasswordEngine } from './password-engine.js';
import { inspectPasswordHash } from './password-hash-format.js';
import {
  PasswordHashRejectedError,
  PasswordOperationError,
} from './password.errors.js';

export type PasswordVerification =
  | { status: 'match'; needsUpgrade: boolean }
  | {
      status:
        'mismatch' | 'invalid-hash' | 'unsupported-hash' | 'invalid-input';
    };

@Injectable()
export class PasswordHasher {
  constructor(
    private readonly policy: PasswordPolicy,
    private readonly capacity: PasswordCapacity,
    @Inject(PASSWORD_ENGINE) private readonly engine: PasswordEngine,
  ) {}

  async hash(password: string): Promise<string> {
    this.policy.assertNewPassword(password);
    return this.capacity.run(async () => {
      try {
        const encoded = await this.engine.hash(password);
        const inspected = inspectPasswordHash(encoded);
        if (inspected.status !== 'supported' || inspected.needsUpgrade)
          throw new PasswordOperationError();
        return encoded;
      } catch {
        // No raw error/cause/arguments retained; native exceptions may be sensitive.
        throw new PasswordOperationError();
      }
    });
  }

  async verify(
    password: string,
    encoded: string,
  ): Promise<PasswordVerification> {
    if (!isSafeVerificationInput(password)) return { status: 'invalid-input' };
    const inspected = inspectPasswordHash(encoded);
    if (inspected.status !== 'supported') return inspected;
    return this.capacity.run(async () => {
      try {
        return (await this.engine.verify(encoded, password))
          ? { status: 'match', needsUpgrade: inspected.needsUpgrade }
          : { status: 'mismatch' };
      } catch {
        throw new PasswordOperationError();
      }
    });
  }

  needsUpgrade(encoded: string): boolean {
    const inspected = inspectPasswordHash(encoded);
    if (inspected.status !== 'supported')
      throw new PasswordHashRejectedError(
        inspected.status === 'invalid-hash'
          ? 'PASSWORD_HASH_INVALID'
          : 'PASSWORD_HASH_UNSUPPORTED',
      );
    return inspected.needsUpgrade;
  }
}
