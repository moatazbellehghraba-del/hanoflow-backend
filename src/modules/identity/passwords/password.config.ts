// Fixed reviewed profile. No environment overrides or test-only weakened defaults.
export const PASSWORD_HASH_OPTIONS = Object.freeze({
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
  version: 19,
});

export const PASSWORD_CAPACITY = Object.freeze({
  active: 1,
  waiting: 2,
  waitTimeoutMs: 1000,
});

export const NEW_PASSWORD_LIMITS = Object.freeze({
  minCodePoints: 15,
  maxCodePoints: 128,
  maxBytes: 512,
});

// Historical verification does not apply the current creation policy.
export const MAX_VERIFICATION_BYTES = 1024;
