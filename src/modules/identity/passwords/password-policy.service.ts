import { Injectable } from '@nestjs/common';
import {
  MAX_VERIFICATION_BYTES,
  NEW_PASSWORD_LIMITS,
} from './password.config.js';
import { PasswordPolicyError } from './password.errors.js';

export type PasswordPolicyResult =
  | { valid: true }
  | {
      valid: false;
      reason: 'encoding' | 'too-short' | 'too-long' | 'too-many-bytes';
    };

// Reject unpaired UTF-16 surrogates: UTF-8 replacement would silently transform
// the input. No trim, normalization or case conversion occurs.
export function isSafeVerificationInput(password: string): boolean {
  if (password.length > MAX_VERIFICATION_BYTES) return false;
  const bytes = Buffer.from(password, 'utf8');
  return (
    bytes.length <= MAX_VERIFICATION_BYTES &&
    bytes.toString('utf8') === password
  );
}

@Injectable()
export class PasswordPolicy {
  validateNewPassword(password: string): PasswordPolicyResult {
    if (password.length > NEW_PASSWORD_LIMITS.maxCodePoints * 2)
      return { valid: false, reason: 'too-long' };
    if (!isSafeVerificationInput(password))
      return { valid: false, reason: 'encoding' };
    const length = [...password].length;
    if (length < NEW_PASSWORD_LIMITS.minCodePoints)
      return { valid: false, reason: 'too-short' };
    if (length > NEW_PASSWORD_LIMITS.maxCodePoints)
      return { valid: false, reason: 'too-long' };
    if (Buffer.byteLength(password, 'utf8') > NEW_PASSWORD_LIMITS.maxBytes)
      return { valid: false, reason: 'too-many-bytes' };
    return { valid: true };
  }

  assertNewPassword(password: string): void {
    if (!this.validateNewPassword(password).valid)
      throw new PasswordPolicyError();
  }
}
