-- CreateTable
CREATE TABLE "machine_facts" (
    "host_id" UUID NOT NULL,
    "os" TEXT NOT NULL DEFAULT '',
    "release" TEXT NOT NULL DEFAULT '',
    "kernel" TEXT NOT NULL DEFAULT '',
    "arch" TEXT NOT NULL DEFAULT '',
    "pkg_manager" TEXT NOT NULL DEFAULT '',
    "uptime_sec" INTEGER NOT NULL DEFAULT 0,
    "load" TEXT NOT NULL DEFAULT '',
    "temp_c" DOUBLE PRECISION,
    "reboot" BOOLEAN NOT NULL DEFAULT false,
    "reboot_pkgs" JSONB NOT NULL DEFAULT '[]',
    "packages" JSONB NOT NULL DEFAULT '[]',
    "services" JSONB NOT NULL DEFAULT '[]',
    "ports" JSONB NOT NULL DEFAULT '[]',
    "checks" JSONB NOT NULL DEFAULT '[]',
    "sudo" BOOLEAN NOT NULL DEFAULT false,
    "last_patch_at" TIMESTAMPTZ,
    "apt_update_at" TIMESTAMPTZ,
    "error" TEXT NOT NULL DEFAULT '',
    "collected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_facts_pkey" PRIMARY KEY ("host_id")
);

-- CreateTable
CREATE TABLE "baselines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#2f6fed',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "host_ids" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baselines_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "machine_facts" ADD CONSTRAINT "machine_facts_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
