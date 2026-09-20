-- AlterTable
ALTER TABLE "machine_facts" ADD COLUMN "pending" JSONB NOT NULL DEFAULT '[]';
