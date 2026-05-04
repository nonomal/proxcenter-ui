-- CreateTable
CREATE TABLE "migration_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
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

-- CreateIndex
CREATE INDEX "migration_jobs_status_idx" ON "migration_jobs"("status");

-- CreateIndex
CREATE INDEX "migration_jobs_source_connection_id_idx" ON "migration_jobs"("source_connection_id");

-- CreateIndex
CREATE INDEX "migration_jobs_target_connection_id_idx" ON "migration_jobs"("target_connection_id");
