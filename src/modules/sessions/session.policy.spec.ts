import {
  activityTimes,
  isExpired,
  policyFor,
  validateLifetimePolicy,
} from './session.policy.js';

describe('Session lifetime policy', () => {
  it('uses approved browser lifetimes', () => {
    expect(policyFor('BROWSER')).toEqual({
      accessMs: 600000,
      idleMs: 1800000,
      absoluteMs: 43200000,
    });
  });
  it('uses approved mobile lifetimes', () => {
    expect(policyFor('MOBILE')).toEqual({
      accessMs: 600000,
      idleMs: 604800000,
      absoluteMs: 2592000000,
    });
  });
  it('clips new idle, access and refresh expiry to fixed absolute expiry', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const absolute = new Date(now.getTime() + 1000);
    const times = activityTimes(now, absolute, policyFor('BROWSER'));
    expect(times.idleExpiresAt).toEqual(absolute);
    expect(times.accessExpiresAt).toEqual(absolute);
    expect(times.refreshExpiresAt).toEqual(absolute);
  });
  it('extends idle on activity while preserving absolute boundary', () => {
    const first = new Date('2026-01-01T00:00:00Z');
    const absolute = new Date(first.getTime() + 43200000);
    const times = activityTimes(
      new Date(first.getTime() + 600000),
      absolute,
      policyFor('BROWSER'),
    );
    expect(times.idleExpiresAt.getTime()).toBe(first.getTime() + 2400000);
    expect(absolute.getTime()).toBe(first.getTime() + 43200000);
  });
  it('treats exact expiration as invalid', () => {
    const boundary = new Date('2026-01-01T00:00:00Z');
    expect(isExpired(boundary, boundary)).toBe(true);
    expect(isExpired(boundary, new Date(boundary.getTime() - 1))).toBe(false);
    expect(isExpired(boundary, new Date(boundary.getTime() + 1))).toBe(true);
  });
  it.each([
    { accessMs: 0, idleMs: 1000, absoluteMs: 2000 },
    { accessMs: 1001, idleMs: 1000, absoluteMs: 2000 },
    { accessMs: 100, idleMs: 2001, absoluteMs: 2000 },
    { accessMs: 600001, idleMs: 700000, absoluteMs: 900000 },
    { accessMs: 100, idleMs: 200, absoluteMs: Infinity },
    { accessMs: 1.5, idleMs: 200, absoluteMs: 300 },
  ])('rejects invalid reviewed configuration %#', (profile) => {
    expect(() => validateLifetimePolicy(profile)).toThrow(
      'Invalid session lifetime policy',
    );
  });
});
