export type SessionClientKind = 'BROWSER' | 'MOBILE';
export interface LifetimePolicy {
  readonly accessMs: number;
  readonly idleMs: number;
  readonly absoluteMs: number;
}

export function validateLifetimePolicy(policy: LifetimePolicy): LifetimePolicy {
  if (
    [policy.accessMs, policy.idleMs, policy.absoluteMs].some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    policy.accessMs > policy.idleMs ||
    policy.idleMs > policy.absoluteMs ||
    policy.accessMs > 600000 ||
    policy.absoluteMs > 30 * 86400000
  )
    throw new Error('Invalid session lifetime policy');
  return Object.freeze({ ...policy });
}

const browser = validateLifetimePolicy({
  accessMs: 600000,
  idleMs: 1800000,
  absoluteMs: 43200000,
});
const mobile = validateLifetimePolicy({
  accessMs: 600000,
  idleMs: 7 * 86400000,
  absoluteMs: 30 * 86400000,
});

export function policyFor(client: SessionClientKind): LifetimePolicy {
  if (client === 'BROWSER') return browser;
  if (client === 'MOBILE') return mobile;
  throw new Error('Invalid session client');
}

export function activityTimes(
  now: Date,
  absoluteExpiresAt: Date,
  policy: LifetimePolicy,
) {
  const idleExpiresAt = new Date(
    Math.min(now.getTime() + policy.idleMs, absoluteExpiresAt.getTime()),
  );
  return {
    lastActivityAt: now,
    idleExpiresAt,
    accessExpiresAt: new Date(
      Math.min(
        now.getTime() + policy.accessMs,
        idleExpiresAt.getTime(),
        absoluteExpiresAt.getTime(),
      ),
    ),
    refreshExpiresAt: idleExpiresAt,
  };
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
