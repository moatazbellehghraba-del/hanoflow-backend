-- New objects only. PostgreSQL transactional DDL keeps this migration atomic.
BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "AuditScope" AS ENUM ('PLATFORM', 'TENANT');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(254) NOT NULL,
    "canonicalEmail" VARCHAR(254) COLLATE "C" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorUserId" UUID,
    "tenantId" UUID,
    "scope" "AuditScope" NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "targetType" VARCHAR(80) NOT NULL,
    "targetId" VARCHAR(128),
    "outcome" "AuditOutcome" NOT NULL,
    "correlationId" UUID NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_canonicalEmail_key" ON "User"("canonicalEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "Membership_userId_status_idx" ON "Membership"("userId", "status");

-- CreateIndex
CREATE INDEX "Membership_tenantId_status_id_idx" ON "Membership"("tenantId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_userId_key" ON "Membership"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_id_key" ON "Membership"("tenantId", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_id_idx" ON "AuditEvent"("tenantId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_id_idx" ON "AuditEvent"("actorUserId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma cannot express these checks or column collations. Keep them in reviewed
-- migrations and catalog tests. ASCII outer whitespace: SP HT LF CR FF VT.
-- PostgreSQL 18's built-in Unicode full lowercasing is independent of LC_CTYPE.
ALTER TABLE "User" ADD CONSTRAINT "User_canonicalEmail_check" CHECK (
    "canonicalEmail" <> '' AND
    "canonicalEmail" = (lower(btrim("email", E' \t\n\r\f\013') COLLATE "pg_unicode_fast") COLLATE "C")
);

ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_name_check" CHECK (btrim("name", E' \t\n\r\f\013') <> '');
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_slug_check" CHECK ("slug" COLLATE "C" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_removedAt_check" CHECK (
    ("status" = 'REMOVED') = ("removedAt" IS NOT NULL)
);
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_removal_chronology_check" CHECK (
    "removedAt" IS NULL OR "removedAt" >= "joinedAt"
);

ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_scope_check" CHECK (
    ("scope" = 'TENANT') = ("tenantId" IS NOT NULL)
);
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_identifiers_check" CHECK (
    btrim("action", E' \t\n\r\f\013') <> '' AND
    btrim("targetType", E' \t\n\r\f\013') <> '' AND
    ("targetId" IS NULL OR btrim("targetId", E' \t\n\r\f\013') <> '')
);
-- Size bound applies to PostgreSQL's JSONB text representation, in UTF-8 bytes.
-- Content allowlisting/redaction must precede future audit writes.
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_metadata_check" CHECK (
    "metadata" IS NULL OR
    (jsonb_typeof("metadata") = 'object' AND octet_length("metadata"::text) <= 4096)
);

COMMIT;
