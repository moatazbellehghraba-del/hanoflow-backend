export const PERMISSIONS = Object.freeze([
  'tenant.memberships.read',
  'tenant.memberships.manage',
  'tenant.roles.read',
  'tenant.roles.assign',
  'tenant.ownership.manage',
] as const);
export type PermissionCode = (typeof PERMISSIONS)[number];
export const ROLE_CODES = Object.freeze([
  'OWNER',
  'ADMIN',
  'DISPATCHER',
  'WAREHOUSE_OPERATOR',
  'FINANCE_OFFICER',
  'COURIER',
  'MERCHANT',
] as const);
export type TemplateCode = (typeof ROLE_CODES)[number];
export const ROLE_MATRIX: Readonly<
  Record<TemplateCode, readonly PermissionCode[]>
> = Object.freeze({
  OWNER: PERMISSIONS,
  ADMIN: Object.freeze(
    PERMISSIONS.filter((code) => code !== 'tenant.ownership.manage'),
  ),
  DISPATCHER: Object.freeze([]),
  WAREHOUSE_OPERATOR: Object.freeze([]),
  FINANCE_OFFICER: Object.freeze([]),
  COURIER: Object.freeze([]),
  MERCHANT: Object.freeze([]),
});
export function isPermission(value: unknown): value is PermissionCode {
  return (
    typeof value === 'string' && PERMISSIONS.some((code) => code === value)
  );
}
export function permissionSet(
  value: unknown,
): value is readonly PermissionCode[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every((entry: unknown) => isPermission(entry))
  );
}
export function templateAllows(
  role: TemplateCode,
  permission: string,
): boolean {
  return isPermission(permission) && ROLE_MATRIX[role].includes(permission);
}
export function canDelegate(
  actorPermissions: readonly PermissionCode[],
  role: TemplateCode,
): boolean {
  return (
    actorPermissions.includes(
      role === 'OWNER' ? 'tenant.ownership.manage' : 'tenant.roles.assign',
    ) &&
    ROLE_MATRIX[role].every((permission) =>
      actorPermissions.includes(permission),
    )
  );
}
