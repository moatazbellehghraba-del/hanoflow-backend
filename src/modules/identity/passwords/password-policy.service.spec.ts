import {
  PasswordPolicy,
  isSafeVerificationInput,
} from './password-policy.service.js';
import { PasswordPolicyError } from './password.errors.js';

describe('Password creation policy', () => {
  const policy = new PasswordPolicy();

  it.each([
    ['minimum', 'a'.repeat(15)],
    ['maximum', 'a'.repeat(128)],
    ['spaces', ' '.repeat(15)],
    ['manager generated', 'uPz+2_6@R!L-bx$yJ'],
    ['Unicode code points', '😀'.repeat(15)],
    ['UTF8 512-byte boundary', '😀'.repeat(128)],
    ['combining marks count separately', 'a\u0301'.repeat(8)],
  ])('accepts %s without composition rules', (_label, value) => {
    expect(policy.validateNewPassword(value ?? '').valid).toBe(true);
  });

  it.each([
    ['below minimum', 'a'.repeat(14)],
    ['above maximum', 'a'.repeat(129)],
    ['14 astral code points', '😀'.repeat(14)],
    ['beyond UTF8 bound', '😀'.repeat(128) + 'a'],
    ['unpaired high surrogate', 'a'.repeat(15) + '\ud800'],
    ['unpaired low surrogate', 'a'.repeat(15) + '\udc00'],
    ['oversized input', 'a'.repeat(2000)],
  ])('rejects %s safely', (_label, value) => {
    expect(policy.validateNewPassword(value ?? '').valid).toBe(false);
    expect(() => policy.assertNewPassword(value ?? '')).toThrow(
      PasswordPolicyError,
    );
  });

  it('counts significant leading and trailing spaces', () => {
    expect(policy.validateNewPassword(' ' + 'a'.repeat(13) + ' ').valid).toBe(
      true,
    );
    expect(policy.validateNewPassword('a'.repeat(13)).valid).toBe(false);
  });

  it('keeps existing-password input safety separate from creation policy', () => {
    expect(isSafeVerificationInput('short')).toBe(true);
    expect(policy.validateNewPassword('short').valid).toBe(false);
    expect(isSafeVerificationInput('😀'.repeat(256))).toBe(true);
    expect(isSafeVerificationInput('😀'.repeat(256) + 'a')).toBe(false);
  });
});
