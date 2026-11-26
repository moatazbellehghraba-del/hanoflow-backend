BEGIN;

-- CreateEnum
CREATE TYPE "SessionScope" AS ENUM ('IDENTITY');

-- CreateEnum
CREATE TYPE "SessionClient" AS ENUM ('BROWSER', 'MOBILE');

-- CreateEnum
CREATE TYPE "SessionRevocationReason" AS ENUM ('EXPLICIT', 'REVOKE_ALL', 'REFRESH_REPLAY');

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "scope" "SessionScope" NOT NULL DEFAULT 'IDENTITY',
    "client" "SessionClient" NOT NULL,
    "contextVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMPTZ(3) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revocationReason" "SessionRevocationReason",

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL,
    "digest" BYTEA NOT NULL,
    "contextVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sessionId" UUID NOT NULL,
    "digest" BYTEA NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "predecessorId" UUID,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_id_idx" ON "Session"("userId", "revokedAt", "id");

-- CreateIndex
CREATE INDEX "Session_idleExpiresAt_idx" ON "Session"("idleExpiresAt");

-- CreateIndex
CREATE INDEX "Session_absoluteExpiresAt_idx" ON "Session"("absoluteExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccessToken_digest_key" ON "AccessToken"("digest");

-- CreateIndex
CREATE INDEX "AccessToken_sessionId_idx" ON "AccessToken"("sessionId");

-- CreateIndex
CREATE INDEX "AccessToken_expiresAt_idx" ON "AccessToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_digest_key" ON "RefreshToken"("digest");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_predecessorId_key" ON "RefreshToken"("predecessorId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_sessionId_id_key" ON "RefreshToken"("sessionId", "id");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_sessionId_predecessorId_fkey" FOREIGN KEY ("sessionId", "predecessorId") REFERENCES "RefreshToken"("sessionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Reviewed SQL-only invariants (Prisma cannot represent CHECKs/partial indexes).
ALTER TABLE "Session" ADD CONSTRAINT "Session_context_check" CHECK ("contextVersion" > 0);
ALTER TABLE "Session" ADD CONSTRAINT "Session_time_check" CHECK (
  "createdAt" <= "lastActivityAt" AND "lastActivityAt" < "idleExpiresAt" AND "idleExpiresAt" <= "absoluteExpiresAt"
);
ALTER TABLE "Session" ADD CONSTRAINT "Session_revocation_check" CHECK (
  ("revokedAt" IS NULL) = ("revocationReason" IS NULL) AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
);
ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_digest_check" CHECK (octet_length("digest") = 32);
ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_context_check" CHECK ("contextVersion" > 0);
ALTER TABLE "AccessToken" ADD CONSTRAINT "AccessToken_time_check" CHECK ("createdAt" < "expiresAt");
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_digest_check" CHECK (octet_length("digest") = 32);
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_time_check" CHECK ("createdAt" < "expiresAt");
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_consumption_check" CHECK (
  "consumedAt" IS NULL OR ("consumedAt" >= "createdAt" AND "consumedAt" < "expiresAt")
);
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_lineage_check" CHECK ("predecessorId" IS NULL OR "predecessorId" <> "id");
CREATE UNIQUE INDEX "RefreshToken_one_unconsumed_per_session" ON "RefreshToken"("sessionId") WHERE "consumedAt" IS NULL;

COMMIT;
