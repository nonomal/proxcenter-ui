/*
  Warnings:

  - You are about to drop the column `uiUrl` on the `Connection` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "alert_silences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "fingerprint" TEXT NOT NULL,
    "silenced_by" TEXT NOT NULL,
    "silenced_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "silenced_until" DATETIME,
    "reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Connection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'pve',
    "sub_type" TEXT,
    "vmware_datacenter" TEXT,
    "hyperv_share_name" TEXT,
    "baseUrl" TEXT NOT NULL,
    "behindProxy" BOOLEAN NOT NULL DEFAULT false,
    "insecureTLS" BOOLEAN NOT NULL DEFAULT false,
    "hasCeph" BOOLEAN NOT NULL DEFAULT false,
    "latitude" REAL,
    "longitude" REAL,
    "locationLabel" TEXT,
    "apiTokenEnc" TEXT NOT NULL,
    "fingerprint" TEXT,
    "tags" TEXT,
    "sshEnabled" BOOLEAN NOT NULL DEFAULT false,
    "sshPort" INTEGER NOT NULL DEFAULT 22,
    "sshUser" TEXT NOT NULL DEFAULT 'root',
    "sshAuthMethod" TEXT,
    "sshKeyEnc" TEXT,
    "sshPassEnc" TEXT,
    "sshUseSudo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Connection" ("apiTokenEnc", "baseUrl", "createdAt", "hasCeph", "id", "insecureTLS", "latitude", "locationLabel", "longitude", "name", "sshAuthMethod", "sshEnabled", "sshKeyEnc", "sshPassEnc", "sshPort", "sshUseSudo", "sshUser", "type", "updatedAt") SELECT "apiTokenEnc", "baseUrl", "createdAt", "hasCeph", "id", "insecureTLS", "latitude", "locationLabel", "longitude", "name", "sshAuthMethod", "sshEnabled", "sshKeyEnc", "sshPassEnc", "sshPort", "sshUseSudo", "sshUser", "type", "updatedAt" FROM "Connection";
DROP TABLE "Connection";
ALTER TABLE "new_Connection" RENAME TO "Connection";
CREATE TABLE "new_DashboardLayout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL DEFAULT 'custom',
    "widgets" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_DashboardLayout" ("createdAt", "id", "isActive", "name", "sort_order", "updatedAt", "userId", "widgets") SELECT "createdAt", "id", "isActive", "name", "sort_order", "updatedAt", "userId", "widgets" FROM "DashboardLayout";
DROP TABLE "DashboardLayout";
ALTER TABLE "new_DashboardLayout" RENAME TO "DashboardLayout";
CREATE UNIQUE INDEX "DashboardLayout_userId_name_key" ON "DashboardLayout"("userId", "name");
CREATE TABLE "new_ManagedHost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "connectionId" TEXT,
    "node" TEXT NOT NULL,
    "ip" TEXT,
    "sshAddress" TEXT,
    "displayName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "description" TEXT,
    "tags" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManagedHost_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ManagedHost" ("connectionId", "createdAt", "description", "displayName", "enabled", "id", "ip", "node", "notes", "sshAddress", "tags", "updatedAt") SELECT "connectionId", "createdAt", "description", "displayName", "enabled", "id", "ip", "node", "notes", "sshAddress", "tags", "updatedAt" FROM "ManagedHost";
DROP TABLE "ManagedHost";
ALTER TABLE "new_ManagedHost" RENAME TO "ManagedHost";
CREATE UNIQUE INDEX "ManagedHost_connectionId_node_key" ON "ManagedHost"("connectionId", "node");
CREATE TABLE "new_alerts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_type" TEXT NOT NULL DEFAULT 'pve',
    "entity_type" TEXT,
    "entity_id" TEXT,
    "entity_name" TEXT,
    "metric" TEXT,
    "current_value" REAL,
    "threshold" REAL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" DATETIME,
    "acknowledged_by" TEXT,
    "resolved_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_alerts" ("acknowledged_at", "acknowledged_by", "created_at", "current_value", "entity_id", "entity_name", "entity_type", "fingerprint", "first_seen_at", "id", "last_seen_at", "message", "metric", "occurrences", "resolved_at", "severity", "source", "source_type", "status", "threshold", "updated_at") SELECT "acknowledged_at", "acknowledged_by", "created_at", "current_value", "entity_id", "entity_name", "entity_type", "fingerprint", "first_seen_at", "id", "last_seen_at", "message", "metric", "occurrences", "resolved_at", "severity", "source", "source_type", "status", "threshold", "updated_at" FROM "alerts";
DROP TABLE "alerts";
ALTER TABLE "new_alerts" RENAME TO "alerts";
CREATE INDEX "alerts_status_idx" ON "alerts"("status");
CREATE INDEX "alerts_severity_idx" ON "alerts"("severity");
CREATE INDEX "alerts_source_idx" ON "alerts"("source");
CREATE INDEX "alerts_last_seen_at_idx" ON "alerts"("last_seen_at");
CREATE INDEX "alerts_status_severity_last_seen_at_idx" ON "alerts"("status", "severity", "last_seen_at");
CREATE UNIQUE INDEX "alerts_tenant_id_fingerprint_key" ON "alerts"("tenant_id", "fingerprint");
CREATE TABLE "new_blueprints" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_slug" TEXT NOT NULL,
    "hardware" TEXT NOT NULL,
    "cloud_init" TEXT,
    "tags" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_blueprints" ("cloud_init", "created_at", "created_by", "description", "hardware", "id", "image_slug", "is_public", "name", "tags", "updated_at") SELECT "cloud_init", "created_at", "created_by", "description", "hardware", "id", "image_slug", "is_public", "name", "tags", "updated_at" FROM "blueprints";
DROP TABLE "blueprints";
ALTER TABLE "new_blueprints" RENAME TO "blueprints";
CREATE TABLE "new_custom_images" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" TEXT NOT NULL DEFAULT 'custom',
    "version" TEXT NOT NULL DEFAULT '',
    "arch" TEXT NOT NULL DEFAULT 'amd64',
    "format" TEXT NOT NULL DEFAULT 'qcow2',
    "source_type" TEXT NOT NULL DEFAULT 'url',
    "download_url" TEXT,
    "checksum_url" TEXT,
    "volume_id" TEXT,
    "default_disk_size" TEXT NOT NULL DEFAULT '20G',
    "min_memory" INTEGER NOT NULL DEFAULT 512,
    "recommended_memory" INTEGER NOT NULL DEFAULT 2048,
    "min_cores" INTEGER NOT NULL DEFAULT 1,
    "recommended_cores" INTEGER NOT NULL DEFAULT 2,
    "ostype" TEXT NOT NULL DEFAULT 'l26',
    "tags" TEXT,
    "created_by" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_custom_images" ("arch", "checksum_url", "created_at", "created_by", "default_disk_size", "download_url", "format", "id", "min_cores", "min_memory", "name", "ostype", "recommended_cores", "recommended_memory", "slug", "source_type", "tags", "updated_at", "vendor", "version", "volume_id") SELECT "arch", "checksum_url", "created_at", "created_by", "default_disk_size", "download_url", "format", "id", "min_cores", "min_memory", "name", "ostype", "recommended_cores", "recommended_memory", "slug", "source_type", "tags", "updated_at", "vendor", "version", "volume_id" FROM "custom_images";
DROP TABLE "custom_images";
ALTER TABLE "new_custom_images" RENAME TO "custom_images";
CREATE UNIQUE INDEX "custom_images_tenant_id_slug_key" ON "custom_images"("tenant_id", "slug");
CREATE TABLE "new_deployments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "blueprint_id" TEXT,
    "blueprint_name" TEXT,
    "connection_id" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    "vmid" INTEGER NOT NULL,
    "vm_name" TEXT,
    "image_slug" TEXT,
    "config" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "current_step" TEXT,
    "error" TEXT,
    "task_upid" TEXT,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_deployments" ("blueprint_id", "blueprint_name", "completed_at", "config", "connection_id", "created_at", "current_step", "error", "id", "image_slug", "node", "started_at", "status", "task_upid", "updated_at", "vm_name", "vmid") SELECT "blueprint_id", "blueprint_name", "completed_at", "config", "connection_id", "created_at", "current_step", "error", "id", "image_slug", "node", "started_at", "status", "task_upid", "updated_at", "vm_name", "vmid" FROM "deployments";
DROP TABLE "deployments";
ALTER TABLE "new_deployments" RENAME TO "deployments";
CREATE INDEX "deployments_status_idx" ON "deployments"("status");
CREATE INDEX "deployments_connection_id_idx" ON "deployments"("connection_id");
CREATE TABLE "new_migration_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "source_connection_id" TEXT NOT NULL,
    "source_vm_id" TEXT NOT NULL,
    "source_vm_name" TEXT,
    "source_host" TEXT,
    "target_connection_id" TEXT NOT NULL,
    "target_node" TEXT NOT NULL,
    "target_storage" TEXT NOT NULL,
    "target_vmid" INTEGER,
    "config" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "current_step" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total_disks" INTEGER,
    "current_disk" INTEGER,
    "bytes_transferred" BIGINT,
    "total_bytes" BIGINT,
    "transfer_speed" TEXT,
    "error" TEXT,
    "logs" TEXT,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "created_by" TEXT
);
INSERT INTO "new_migration_jobs" ("bytes_transferred", "completed_at", "config", "created_at", "created_by", "current_disk", "current_step", "error", "id", "logs", "progress", "source_connection_id", "source_host", "source_vm_id", "source_vm_name", "started_at", "status", "target_connection_id", "target_node", "target_storage", "target_vmid", "total_bytes", "total_disks", "transfer_speed", "updated_at") SELECT "bytes_transferred", "completed_at", "config", "created_at", "created_by", "current_disk", "current_step", "error", "id", "logs", "progress", "source_connection_id", "source_host", "source_vm_id", "source_vm_name", "started_at", "status", "target_connection_id", "target_node", "target_storage", "target_vmid", "total_bytes", "total_disks", "transfer_speed", "updated_at" FROM "migration_jobs";
DROP TABLE "migration_jobs";
ALTER TABLE "new_migration_jobs" RENAME TO "migration_jobs";
CREATE INDEX "migration_jobs_status_idx" ON "migration_jobs"("status");
CREATE INDEX "migration_jobs_source_connection_id_idx" ON "migration_jobs"("source_connection_id");
CREATE INDEX "migration_jobs_target_connection_id_idx" ON "migration_jobs"("target_connection_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "alert_silences_silenced_until_idx" ON "alert_silences"("silenced_until");

-- CreateIndex
CREATE UNIQUE INDEX "alert_silences_tenant_id_fingerprint_key" ON "alert_silences"("tenant_id", "fingerprint");
