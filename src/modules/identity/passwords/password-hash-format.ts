import { PASSWORD_HASH_OPTIONS } from './password.config.js';

export type HashInspection =
  | { status: 'supported'; needsUpgrade: boolean }
  | { status: 'invalid-hash' | 'unsupported-hash' };

// Strict bounded PHC subset. Never pass arbitrary encoded costs to native code.
// Only Argon2id v19, m=19456..65536 KiB, t=2..3, p=1, 32-byte output,
// and 16..32-byte salts are supported. Unknown algorithms/versions fail closed.
export function inspectPasswordHash(encoded: string): HashInspection {
  if (encoded.length > 512) return { status: 'invalid-hash' };
  const match =
    /^\$([a-z0-9]+)\$v=([1-9][0-9]{0,2})\$m=([1-9][0-9]{0,8}),t=([1-9][0-9]{0,8}),p=([1-9][0-9]{0,8})\$([A-Za-z0-9+/]{1,86})\$([A-Za-z0-9+/]{1,86})$/.exec(
      encoded,
    );
  if (!match) return { status: 'invalid-hash' };
  const [, algorithm, version, memory, time, parallelism, salt, digest] = match;
  if (
    !algorithm ||
    !version ||
    !memory ||
    !time ||
    !parallelism ||
    !salt ||
    !digest
  )
    return { status: 'invalid-hash' };
  const saltBytes = Buffer.from(salt, 'base64');
  const hashBytes = Buffer.from(digest, 'base64');
  const canonical = (bytes: Buffer) =>
    bytes.toString('base64').replace(/=+$/, '');
  if (canonical(saltBytes) !== salt || canonical(hashBytes) !== digest)
    return { status: 'invalid-hash' };
  const m = Number(memory);
  const t = Number(time);
  if (
    algorithm !== 'argon2id' ||
    Number(version) !== 19 ||
    m < 19456 ||
    m > 65536 ||
    t < 2 ||
    t > 3 ||
    Number(parallelism) !== 1 ||
    saltBytes.length < 16 ||
    saltBytes.length > 32 ||
    hashBytes.length !== 32
  )
    return { status: 'unsupported-hash' };
  return {
    status: 'supported',
    needsUpgrade:
      m !== PASSWORD_HASH_OPTIONS.memoryCost ||
      t !== PASSWORD_HASH_OPTIONS.timeCost,
  };
}
