BEGIN;

-- CreateEnum
CREATE TYPE "RoleTemplate" AS ENUM ('OWNER', 'ADMIN', 'DISPATCHER', 'WAREHOUSE_OPERATOR', 'FINANCE_OFFICER', 'COURIER', 'MERCHANT');

-- CreateEnum
CREATE TYPE "RoleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('TENANT');

-- AlterEnum
ALTER TYPE "SessionScope" ADD VALUE 'TENANT';

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "membershipId" UUID,
ADD COLUMN     "tenantId" UUID;

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "contextVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "code" "RoleTemplate" NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "templateVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "RoleStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "code" VARCHAR(80) NOT NULL,
    "scope" "PermissionScope" NOT NULL DEFAULT 'TENANT',
    "description" VARCHAR(200) NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "MembershipRole" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId" UUID,
    "removedAt" TIMESTAMPTZ(3),
    "removedByUserId" UUID,

    CONSTRAINT "MembershipRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "tenantId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionCode" VARCHAR(80) NOT NULL,
    "scope" "PermissionScope" NOT NULL DEFAULT 'TENANT',

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("tenantId","roleId","permissionCode")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_code_key" ON "Role"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_id_key" ON "Role"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_code_scope_key" ON "Permission"("code", "scope");

-- CreateIndex
CREATE INDEX "MembershipRole_tenantId_membershipId_removedAt_idx" ON "MembershipRole"("tenantId", "membershipId", "removedAt");

-- CreateIndex
CREATE INDEX "MembershipRole_tenantId_roleId_removedAt_idx" ON "MembershipRole"("tenantId", "roleId", "removedAt");

-- CreateIndex
CREATE INDEX "MembershipRole_grantedByUserId_idx" ON "MembershipRole"("grantedByUserId");

-- CreateIndex
CREATE INDEX "MembershipRole_removedByUserId_idx" ON "MembershipRole"("removedByUserId");

-- CreateIndex
CREATE INDEX "RolePermission_permissionCode_scope_idx" ON "RolePermission"("permissionCode", "scope");

-- CreateIndex
CREATE INDEX "Session_tenantId_membershipId_idx" ON "Session"("tenantId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_id_userId_key" ON "Membership"("tenantId", "id", "userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_tenantId_membershipId_userId_fkey" FOREIGN KEY ("tenantId", "membershipId", "userId") REFERENCES "Membership"("tenantId", "id", "userId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_tenantId_membershipId_fkey" FOREIGN KEY ("tenantId", "membershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionCode_scope_fkey" FOREIGN KEY ("permissionCode", "scope") REFERENCES "Permission"("code", "scope") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Custom invariants not expressible in Prisma. Text scope comparison avoids use
-- of a newly added enum literal before this transaction commits.
ALTER TABLE "Session" ADD CONSTRAINT "Session_tenant_context_check" CHECK (
 ("scope"::text='IDENTITY' AND "tenantId" IS NULL AND "membershipId" IS NULL) OR
 ("scope"::text='TENANT' AND "tenantId" IS NOT NULL AND "membershipId" IS NOT NULL)
);
UPDATE "RefreshToken" r SET "contextVersion"=s."contextVersion" FROM "Session" s WHERE s.id=r."sessionId";
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_context_check" CHECK ("contextVersion">0);
ALTER TABLE "Role" ADD CONSTRAINT "Role_template_check" CHECK ("templateVersion"=1 AND btrim("name")<>'');
ALTER TABLE "Role" ADD CONSTRAINT "Role_owner_active_check" CHECK ("code"<>'OWNER' OR "status"='ACTIVE');
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_catalog_check" CHECK ("scope"='TENANT' AND "code" IN ('tenant.memberships.read','tenant.memberships.manage','tenant.roles.read','tenant.roles.assign','tenant.ownership.manage'));
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_scope_check" CHECK ("scope"='TENANT');
ALTER TABLE "MembershipRole" ADD CONSTRAINT "MembershipRole_removal_check" CHECK (("removedAt" IS NULL)=("removedByUserId" IS NULL) AND ("removedAt" IS NULL OR "removedAt">="grantedAt"));
CREATE UNIQUE INDEX "MembershipRole_active_key" ON "MembershipRole"("tenantId","membershipId","roleId") WHERE "removedAt" IS NULL;

-- System catalog only: no tenants, users, memberships, roles or owners are seeded.
INSERT INTO "Permission" ("code","scope","description") VALUES
 ('tenant.memberships.read','TENANT','Read memberships in the current tenant only'),
 ('tenant.memberships.manage','TENANT','Manage current tenant membership status, never global user state'),
 ('tenant.roles.read','TENANT','Read predefined current tenant roles'),
 ('tenant.roles.assign','TENANT','Delegate eligible non-owner roles within current authority'),
 ('tenant.ownership.manage','TENANT','Manage owner assignments subject to last-owner protection');
COMMIT;
