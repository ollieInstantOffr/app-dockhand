-- CreateTable
CREATE TABLE "registry_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "server" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_enc" TEXT NOT NULL,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registry_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'pull',
    "system" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registry_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "registry_credentials_server_key" ON "registry_credentials"("server");

-- CreateIndex
CREATE UNIQUE INDEX "registry_tokens_hash_key" ON "registry_tokens"("hash");
