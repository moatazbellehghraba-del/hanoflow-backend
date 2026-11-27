import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';
import { RoleProvisioningModule } from '../dist/modules/authorization/role-provisioning.module.js';
import { RoleProvisioner } from '../dist/modules/authorization/role-provisioner.service.js';

// CLI only. No AppModule, runtime PrismaService or global config loader.
export async function provisionRoles(tenantId, test = false) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      tenantId,
    )
  )
    throw new Error('Invalid provisioning target');
  const raw = parse(
    readFileSync(test ? '.env.test-migrations' : '.env.migrations'),
  ).DATABASE_MIGRATION_URL;
  const u = new URL(raw);
  if (
    u.hostname !== '127.0.0.1' ||
    u.port !== '5434' ||
    u.pathname !== (test ? '/hanoflow_test' : '/hanoflow') ||
    u.username !== 'hanoflow_migrator'
  )
    throw new Error('Unsafe provisioning target');
  const module = await NestFactory.createApplicationContext(
    RoleProvisioningModule,
    { logger: false },
  );
  const db = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: raw,
      max: 1,
      connectionTimeoutMillis: 2000,
      statement_timeout: 2000,
      query_timeout: 3000,
    }),
    log: [],
  });
  try {
    return await db.$transaction(
      async (tx) => {
        const who =
          await tx.$queryRaw`SELECT current_database() db,current_user role,session_user login`;
        if (
          who[0]?.role !== 'hanoflow_migrator' ||
          who[0]?.login !== 'hanoflow_migrator' ||
          who[0]?.db !== (test ? 'hanoflow_test' : 'hanoflow')
        )
          throw new Error('Unexpected provisioning identity');
        await tx.$executeRaw`SET LOCAL ROLE hanoflow_bootstrap`;
        return module
          .get(RoleProvisioner)
          .provisionIn(tx, tenantId, randomUUID());
      },
      { maxWait: 1000, timeout: 5000 },
    );
  } finally {
    await db.$disconnect();
    await module.close();
  }
}
if (
  process.argv[1]?.replaceAll('\\', '/').endsWith('/provision-tenant-roles.mjs')
) {
  provisionRoles(process.argv[2] ?? '', process.argv.includes('--test'))
    .then((created) =>
      console.log(
        JSON.stringify({ event: 'tenant_roles_provisioned', created }),
      ),
    )
    .catch(() => {
      console.error('Controlled role provisioning failed');
      process.exitCode = 1;
    });
}
