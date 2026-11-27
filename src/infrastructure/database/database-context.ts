import type { Prisma } from '../../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tenants = new WeakMap<object, string>();

// Internal persistence mechanism, not an authentication API. Only services that
// validate credentials/current state may bind tenant authority. PostgreSQL does
// not authenticate custom settings; arbitrary SQL execution is outside this model.
export async function sessionLookup(
  tx: Tx,
  digest?: Uint8Array,
): Promise<void> {
  await tx.$queryRaw`SELECT set_config('app.access_path','session',true)`;
  if (digest)
    await tx.$queryRaw`SELECT set_config('app.token_digest',${Buffer.from(digest).toString('hex')},true)`;
}

export async function identityContext(tx: Tx, userId: string): Promise<void> {
  if (!uuid.test(userId)) throw new Error('Invalid database context');
  await tx.$queryRaw`SELECT set_config('app.user_id',${userId},true)`;
}

export async function sessionContext(tx: Tx, sessionId: string): Promise<void> {
  if (!uuid.test(sessionId)) throw new Error('Invalid database context');
  await tx.$queryRaw`SELECT set_config('app.session_id',${sessionId},true)`;
}

export async function tenantContext(
  tx: Tx,
  tenantId: string,
  membershipId: string,
): Promise<void> {
  if (!uuid.test(tenantId) || !uuid.test(membershipId))
    throw new Error('Invalid database context');
  const binding = `${tenantId}:${membershipId}`;
  const bound = tenants.get(tx);
  if (bound && bound !== binding)
    throw new Error('Conflicting database context');
  tenants.set(tx, binding);
  await tx.$queryRaw`SELECT set_config('app.tenant_id',${tenantId},true),set_config('app.membership_id',${membershipId},true),set_config('app.access_path','tenant',true)`;
}
