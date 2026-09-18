-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "theme" TEXT NOT NULL DEFAULT 'system',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "user_agent" TEXT NOT NULL DEFAULT '',
    "ip" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "hosts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "ssh_user" TEXT NOT NULL DEFAULT 'root',
    "method" TEXT NOT NULL DEFAULT 'key',
    "password_enc" TEXT,
    "host_key" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#2f6fed',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "os" TEXT NOT NULL DEFAULT '',
    "kernel" TEXT NOT NULL DEFAULT '',
    "docker_version" TEXT NOT NULL DEFAULT '',
    "cpu_cores" INTEGER NOT NULL DEFAULT 0,
    "uptime_sec" BIGINT NOT NULL DEFAULT 0,
    "cpu" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mem_used" BIGINT NOT NULL DEFAULT 0,
    "mem_total" BIGINT NOT NULL DEFAULT 0,
    "disk_used" BIGINT NOT NULL DEFAULT 0,
    "disk_total" BIGINT NOT NULL DEFAULT 0,
    "last_seen_at" TIMESTAMPTZ,
    "last_error" TEXT NOT NULL DEFAULT '',
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "monitored" BOOLEAN NOT NULL DEFAULT true,
    "mcp_exposed" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "host_metrics" (
    "id" BIGSERIAL NOT NULL,
    "host_id" UUID NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpu" DOUBLE PRECISION NOT NULL,
    "mem" DOUBLE PRECISION NOT NULL,
    "disk" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "host_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "container_events" (
    "id" BIGSERIAL NOT NULL,
    "host_id" UUID NOT NULL,
    "container" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'docker',
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "container_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stacks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "host_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "compose_file" TEXT NOT NULL DEFAULT 'docker-compose.yml',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "git_account_id" UUID,
    "repo_full_name" TEXT,
    "branch" TEXT,
    "sha" TEXT,
    "auto_deploy" BOOLEAN NOT NULL DEFAULT false,
    "env" JSONB NOT NULL DEFAULT '[]',
    "last_deploy_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "host_id" UUID,
    "stack_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'running',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "log" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB NOT NULL DEFAULT '{}',
    "actor" TEXT NOT NULL DEFAULT '',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "login" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'user',
    "method" TEXT NOT NULL DEFAULT 'pat',
    "server_url" TEXT NOT NULL DEFAULT 'https://github.com',
    "api_url" TEXT NOT NULL DEFAULT 'https://api.github.com',
    "token_enc" TEXT NOT NULL DEFAULT '',
    "installation_id" BIGINT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "repo_access" TEXT NOT NULL DEFAULT 'all',
    "selected_repos" JSONB NOT NULL DEFAULT '[]',
    "webhook" BOOLEAN NOT NULL DEFAULT true,
    "color" TEXT NOT NULL DEFAULT '#7a5cf0',
    "last_sync_at" TIMESTAMPTZ,
    "last_error" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "git_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_repos" (
    "id" BIGINT NOT NULL,
    "account_id" UUID NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "compose_files" JSONB NOT NULL DEFAULT '[]',
    "pushed_at" TIMESTAMPTZ,
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "git_repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "host_id" UUID,
    "target" TEXT NOT NULL DEFAULT '',
    "expect" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "last_check_at" TIMESTAMPTZ,
    "last_latency" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_results" (
    "id" BIGSERIAL NOT NULL,
    "monitor_id" UUID NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "check_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "monitor_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'down',
    "message" TEXT NOT NULL DEFAULT '',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dedupe_key" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "host_id" UUID,
    "action" TEXT NOT NULL DEFAULT 'Open',
    "href" TEXT NOT NULL DEFAULT '/',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ,
    "snoozed_until" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "client" TEXT NOT NULL DEFAULT 'claude',
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'read',
    "groups" JSONB NOT NULL DEFAULT '[]',
    "host_ids" JSONB NOT NULL DEFAULT '[]',
    "expires_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_activity" (
    "id" BIGSERIAL NOT NULL,
    "api_key_id" UUID,
    "client" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "update_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" TEXT NOT NULL,
    "from_version" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "update_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "hosts_name_key" ON "hosts"("name");

-- CreateIndex
CREATE INDEX "host_metrics_host_id_at_idx" ON "host_metrics"("host_id", "at");

-- CreateIndex
CREATE INDEX "container_events_host_id_container_at_idx" ON "container_events"("host_id", "container", "at");

-- CreateIndex
CREATE UNIQUE INDEX "stacks_host_id_name_key" ON "stacks"("host_id", "name");

-- CreateIndex
CREATE INDEX "deployments_started_at_idx" ON "deployments"("started_at");

-- CreateIndex
CREATE INDEX "git_repos_account_id_idx" ON "git_repos"("account_id");

-- CreateIndex
CREATE INDEX "monitors_host_id_idx" ON "monitors"("host_id");

-- CreateIndex
CREATE INDEX "check_results_monitor_id_at_idx" ON "check_results"("monitor_id", "at");

-- CreateIndex
CREATE INDEX "incidents_started_at_idx" ON "incidents"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_dedupe_key_key" ON "alerts"("dedupe_key");

-- CreateIndex
CREATE INDEX "alerts_created_at_idx" ON "alerts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");

-- CreateIndex
CREATE INDEX "mcp_activity_at_idx" ON "mcp_activity"("at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "host_metrics" ADD CONSTRAINT "host_metrics_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "container_events" ADD CONSTRAINT "container_events_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stacks" ADD CONSTRAINT "stacks_git_account_id_fkey" FOREIGN KEY ("git_account_id") REFERENCES "git_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_stack_id_fkey" FOREIGN KEY ("stack_id") REFERENCES "stacks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_repos" ADD CONSTRAINT "git_repos_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "git_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_results" ADD CONSTRAINT "check_results_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "hosts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_activity" ADD CONSTRAINT "mcp_activity_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

