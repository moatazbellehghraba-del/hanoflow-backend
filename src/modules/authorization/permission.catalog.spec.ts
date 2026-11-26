import {
  PERMISSIONS,
  ROLE_CODES,
  ROLE_MATRIX,
  isPermission,
  permissionSet,
  canDelegate,
  templateAllows,
} from './permission.catalog.js';
describe('Closed permission and predefined role catalogs', () => {
  it('has exactly the stable identity permission codes', () => {
    expect([...PERMISSIONS]).toEqual([
      'tenant.memberships.read',
      'tenant.memberships.manage',
      'tenant.roles.read',
      'tenant.roles.assign',
      'tenant.ownership.manage',
    ]);
    expect(new Set(PERMISSIONS).size).toBe(5);
  });
  it('defines seven deterministic templates without operational or financial grants', () => {
    expect(ROLE_CODES.length).toBe(7);
    for (const role of ROLE_CODES)
      expect(ROLE_MATRIX[role].every(isPermission)).toBe(true);
    for (const role of [
      'DISPATCHER',
      'WAREHOUSE_OPERATOR',
      'FINANCE_OFFICER',
      'COURIER',
      'MERCHANT',
    ] as const)
      expect(ROLE_MATRIX[role]).toEqual([]);
  });
  it('keeps owner powers separate from ordinary administration', () => {
    expect(ROLE_MATRIX.OWNER.length).toBe(5);
    expect(ROLE_MATRIX.ADMIN.length).toBe(4);
    expect(templateAllows('ADMIN', 'tenant.ownership.manage')).toBe(false);
    expect(canDelegate(ROLE_MATRIX.ADMIN, 'OWNER')).toBe(false);
    expect(canDelegate(ROLE_MATRIX.OWNER, 'OWNER')).toBe(true);
    expect(canDelegate(ROLE_MATRIX.ADMIN, 'ADMIN')).toBe(true);
    expect(canDelegate(['tenant.roles.assign'], 'ADMIN')).toBe(false);
  });
  it.each(['*', 'tenant.*', 'platform.admin', 'shipment.read', '', null, 42])(
    'denies unknown permission %#',
    (value) => expect(isPermission(value)).toBe(false),
  );
  it.each([
    [],
    ['*'],
    ['tenant.roles.read', 42],
    null,
    {},
    'tenant.roles.read',
  ])('rejects empty or malformed requirements %#', (value) =>
    expect(permissionSet(value)).toBe(false),
  );
  it('accepts only explicit nonempty permission requirements', () =>
    expect(permissionSet(['tenant.roles.read'])).toBe(true));
});
