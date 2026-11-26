BEGIN;

-- CreateTable
CREATE TABLE "PasswordCredential" (
    "userId" UUID NOT NULL,
    "passwordHash" VARCHAR(512) NOT NULL,
    "passwordChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordCredential_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "PasswordCredential" ADD CONSTRAINT "PasswordCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- PHC algorithm/parameter validation belongs to the bounded hashing service.
ALTER TABLE "PasswordCredential" ADD CONSTRAINT "PasswordCredential_hash_check" CHECK (btrim("passwordHash") <> '');

COMMIT;
