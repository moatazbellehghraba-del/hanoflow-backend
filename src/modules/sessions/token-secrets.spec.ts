import { TokenSecrets } from './token-secrets.js';

describe('Opaque token secrets', () => {
  const utility = new TokenSecrets();
  it.each(['access', 'refresh'] as const)(
    'issues canonical 32-byte %s credentials',
    (purpose) => {
      const token = utility.issue(purpose);
      expect(token.raw.length).toBe(47);
      expect(Buffer.from(token.raw.slice(4), 'base64url').length).toBe(32);
      expect(token.digest.length).toBe(32);
      expect(
        utility
          .digest(token.raw, purpose)
          ?.every((byte, index) => byte === token.digest[index]),
      ).toBe(true);
    },
  );
  it('generates independent values and distinct digests', () => {
    const issued = Array.from({ length: 32 }, () => utility.issue('access'));
    expect(new Set(issued.map((value) => value.raw)).size).toBe(32);
    expect(
      new Set(issued.map((value) => Buffer.from(value.digest).toString('hex')))
        .size,
    ).toBe(32);
  });
  it('rejects purpose substitution at the syntax boundary', () => {
    expect(
      utility.digest(utility.issue('refresh').raw, 'access') === undefined,
    ).toBe(true);
    expect(
      utility.digest(utility.issue('access').raw, 'refresh') === undefined,
    ).toBe(true);
  });
  it.each([
    '',
    'hfa_short',
    'hfa_' + 'A'.repeat(42),
    'hfa_' + 'A'.repeat(44),
    'hfa_' + 'A'.repeat(42) + 'B',
    'hfa_' + '+'.repeat(43),
    'hfa_' + 'A'.repeat(42) + '=',
    ' hfa_' + 'A'.repeat(43),
  ])('rejects malformed case %#', (value) => {
    expect(utility.digest(value, 'access') === undefined).toBe(true);
  });
});
