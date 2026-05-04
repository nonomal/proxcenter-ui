-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
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
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "locationLabel" TEXT,
    "country" TEXT,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedHost" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedHost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DashboardLayout" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL DEFAULT 'custom',
    "widgets" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "frontend_alerts" (
    "id" TEXT NOT NULL,
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
    "current_value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'active',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "frontend_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_silences" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "fingerprint" TEXT NOT NULL,
    "silenced_by" TEXT NOT NULL,
    "silenced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "silenced_until" TIMESTAMP(3),
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_silences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_images" (
    "id" TEXT NOT NULL,
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
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprints" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_slug" TEXT NOT NULL,
    "hardware" TEXT NOT NULL,
    "cloud_init" TEXT,
    "tags" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blueprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
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
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "migration_jobs" (
    "id" TEXT NOT NULL,
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
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "migration_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "email" TEXT NOT NULL,
    "password" TEXT,
    "name" TEXT,
    "avatar" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "auth_provider" TEXT NOT NULL DEFAULT 'credentials',
    "ldap_dn" TEXT,
    "oidc_sub" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "timestamp" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT,
    "user_email" TEXT,
    "action" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "resource_name" TEXT,
    "details" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'success',
    "error_message" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ldap_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT NOT NULL,
    "bind_dn" TEXT,
    "bind_password_enc" TEXT,
    "base_dn" TEXT NOT NULL,
    "user_filter" TEXT NOT NULL DEFAULT '(uid={{username}})',
    "email_attribute" TEXT NOT NULL DEFAULT 'mail',
    "name_attribute" TEXT NOT NULL DEFAULT 'cn',
    "tls_insecure" BOOLEAN NOT NULL DEFAULT false,
    "start_tls" BOOLEAN NOT NULL DEFAULT false,
    "group_attribute" TEXT DEFAULT 'memberOf',
    "group_role_mapping" JSONB NOT NULL DEFAULT '{}',
    "default_role" TEXT DEFAULT 'role_viewer',
    "require_group" BOOLEAN NOT NULL DEFAULT false,
    "allowed_groups" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ldap_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oidc_config" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider_name" TEXT NOT NULL DEFAULT 'SSO',
    "issuer_url" TEXT NOT NULL DEFAULT '',
    "client_id" TEXT NOT NULL DEFAULT '',
    "client_secret_enc" TEXT,
    "scopes" TEXT NOT NULL DEFAULT 'openid profile email',
    "authorization_url" TEXT,
    "token_url" TEXT,
    "userinfo_url" TEXT,
    "claim_email" TEXT NOT NULL DEFAULT 'email',
    "claim_name" TEXT NOT NULL DEFAULT 'name',
    "claim_groups" TEXT DEFAULT 'groups',
    "auto_provision" BOOLEAN NOT NULL DEFAULT true,
    "default_role" TEXT NOT NULL DEFAULT 'viewer',
    "group_role_mapping" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oidc_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_tenants" (
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_tenants_pkey" PRIMARY KEY ("user_id","tenant_id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key","tenant_id")
);

-- CreateTable
CREATE TABLE "rbac_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT DEFAULT '#6366f1',
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rbac_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rbac_permissions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "is_dangerous" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rbac_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rbac_role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "rbac_role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "rbac_user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL DEFAULT 'global',
    "scope_target" TEXT,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "granted_by" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "rbac_user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rbac_user_permissions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL DEFAULT 'global',
    "scope_target" TEXT,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "granted_by" TEXT,
    "granted_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "rbac_user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdcs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "pve_pool_name" TEXT NOT NULL,
    "enabled" BOOLEAN DEFAULT true,
    "primary_storage" TEXT,
    "sdn_zone_name" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vdcs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_nodes" (
    "id" TEXT NOT NULL,
    "vdc_id" TEXT NOT NULL,
    "node_name" TEXT NOT NULL,

    CONSTRAINT "vdc_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_storages" (
    "id" TEXT NOT NULL,
    "vdc_id" TEXT NOT NULL,
    "storage_id" TEXT NOT NULL,

    CONSTRAINT "vdc_storages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_quotas" (
    "id" TEXT NOT NULL,
    "vdc_id" TEXT NOT NULL,
    "max_vcpus" INTEGER,
    "max_ram_mb" INTEGER,
    "max_storage_mb" INTEGER,
    "max_vms" INTEGER,
    "max_snapshots" INTEGER,
    "max_backups" INTEGER,
    "max_vnets" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vdc_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_usage_cache" (
    "id" TEXT NOT NULL,
    "vdc_id" TEXT NOT NULL,
    "used_vcpus" INTEGER NOT NULL DEFAULT 0,
    "used_ram_mb" INTEGER NOT NULL DEFAULT 0,
    "used_storage_mb" INTEGER NOT NULL DEFAULT 0,
    "used_vms" INTEGER NOT NULL DEFAULT 0,
    "used_snapshots" INTEGER NOT NULL DEFAULT 0,
    "used_backups" INTEGER NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMP(3),

    CONSTRAINT "vdc_usage_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_shared_bridges" (
    "id" TEXT NOT NULL,
    "vdc_id" TEXT NOT NULL,
    "bridge" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vdc_shared_bridges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_vnets" (
    "id" TEXT NOT NULL,
    "vdc_id" TEXT NOT NULL,
    "pve_name" TEXT NOT NULL,
    "display_name" TEXT,
    "description" TEXT,
    "vxlan_tag" INTEGER NOT NULL,
    "firewall" BOOLEAN DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vdc_vnets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_subnets" (
    "id" TEXT NOT NULL,
    "vnet_id" TEXT NOT NULL,
    "cidr" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "dns_servers" TEXT,
    "ipam_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vdc_subnets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_ipam_allocations" (
    "id" TEXT NOT NULL,
    "vdc_id" TEXT NOT NULL,
    "subnet_id" TEXT NOT NULL,
    "vnet_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "ip_int" BIGINT NOT NULL,
    "mac" TEXT NOT NULL,
    "vmid" INTEGER,
    "hostname" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vdc_ipam_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_pbs_namespaces" (
    "id" TEXT NOT NULL,
    "vdc_id" TEXT NOT NULL,
    "pbs_connection_id" TEXT NOT NULL,
    "datastore" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "pbs_token_id" TEXT,
    "pbs_token_secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vdc_pbs_namespaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vdc_pbs_pve_storages" (
    "id" TEXT NOT NULL,
    "vdc_pbs_namespace_id" TEXT NOT NULL,
    "pve_connection_id" TEXT NOT NULL,
    "pve_storage_name" TEXT NOT NULL,
    "managed" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vdc_pbs_pve_storages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "scope_type" TEXT NOT NULL DEFAULT 'all',
    "scope_target" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_instances" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "rule_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "entity_name" TEXT,
    "node" TEXT,
    "connection_id" TEXT,
    "connection_name" TEXT,
    "metric" TEXT NOT NULL,
    "current_value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "triggered_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" TEXT,

    CONSTRAINT "alert_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rule_owners" (
    "rule_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_rule_owners_pkey" PRIMARY KEY ("rule_id")
);

-- CreateTable
CREATE TABLE "favorites" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "user_id" TEXT NOT NULL,
    "vm_key" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    "vm_type" TEXT NOT NULL,
    "vmid" TEXT NOT NULL,
    "vm_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_score_history" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "date" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "cpu_pct" DOUBLE PRECISION,
    "ram_pct" DOUBLE PRECISION,
    "storage_pct" DOUBLE PRECISION,
    "details" JSONB,
    "connection_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "health_score_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_policies" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "password_min_length" INTEGER NOT NULL DEFAULT 8,
    "password_require_uppercase" BOOLEAN NOT NULL DEFAULT false,
    "password_require_lowercase" BOOLEAN NOT NULL DEFAULT false,
    "password_require_numbers" BOOLEAN NOT NULL DEFAULT false,
    "password_require_special" BOOLEAN NOT NULL DEFAULT false,
    "session_timeout_minutes" INTEGER NOT NULL DEFAULT 43200,
    "session_max_concurrent" INTEGER NOT NULL DEFAULT 0,
    "login_max_failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "login_lockout_duration_minutes" INTEGER NOT NULL DEFAULT 15,
    "audit_retention_days" INTEGER NOT NULL DEFAULT 90,
    "audit_auto_cleanup" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "security_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_profiles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "framework_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "connection_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_profile_checks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "profile_id" TEXT NOT NULL,
    "check_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "control_ref" TEXT,
    "category" TEXT,

    CONSTRAINT "compliance_profile_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "datacenters" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "location_label" TEXT,
    "country" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "pue" DOUBLE PRECISION NOT NULL DEFAULT 1.4,
    "electricity_price" DOUBLE PRECISION NOT NULL DEFAULT 0.18,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "co2_factor" DOUBLE PRECISION NOT NULL DEFAULT 0.052,
    "co2_country_preset" TEXT,
    "tdp_per_core_w" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "watts_per_gb_ram" DOUBLE PRECISION NOT NULL DEFAULT 0.375,
    "overhead_per_node_w" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "comment" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "datacenters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_green_config" (
    "connection_id" TEXT NOT NULL,
    "datacenter_id" TEXT,
    "tdp_per_core_w" DOUBLE PRECISION,
    "watts_per_gb_ram" DOUBLE PRECISION,
    "overhead_per_node_w" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_green_config_pkey" PRIMARY KEY ("connection_id")
);

-- CreateTable
CREATE TABLE "node_green_config" (
    "connection_id" TEXT NOT NULL,
    "node_name" TEXT NOT NULL,
    "datacenter_id" TEXT,
    "tdp_per_core_w" DOUBLE PRECISION,
    "watts_per_gb_ram" DOUBLE PRECISION,
    "overhead_per_node_w" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_green_config_pkey" PRIMARY KEY ("connection_id","node_name")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedHost_connectionId_node_key" ON "ManagedHost"("connectionId", "node");

-- CreateIndex
CREATE UNIQUE INDEX "DashboardLayout_userId_name_key" ON "DashboardLayout"("userId", "name");

-- CreateIndex
CREATE INDEX "frontend_alerts_status_idx" ON "frontend_alerts"("status");

-- CreateIndex
CREATE INDEX "frontend_alerts_severity_idx" ON "frontend_alerts"("severity");

-- CreateIndex
CREATE INDEX "frontend_alerts_source_idx" ON "frontend_alerts"("source");

-- CreateIndex
CREATE INDEX "frontend_alerts_last_seen_at_idx" ON "frontend_alerts"("last_seen_at");

-- CreateIndex
CREATE INDEX "frontend_alerts_status_severity_last_seen_at_idx" ON "frontend_alerts"("status", "severity", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "frontend_alerts_tenant_id_fingerprint_key" ON "frontend_alerts"("tenant_id", "fingerprint");

-- CreateIndex
CREATE INDEX "alert_silences_silenced_until_idx" ON "alert_silences"("silenced_until");

-- CreateIndex
CREATE UNIQUE INDEX "alert_silences_tenant_id_fingerprint_key" ON "alert_silences"("tenant_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "custom_images_tenant_id_slug_key" ON "custom_images"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "deployments_status_idx" ON "deployments"("status");

-- CreateIndex
CREATE INDEX "deployments_connection_id_idx" ON "deployments"("connection_id");

-- CreateIndex
CREATE INDEX "migration_jobs_status_idx" ON "migration_jobs"("status");

-- CreateIndex
CREATE INDEX "migration_jobs_source_connection_id_idx" ON "migration_jobs"("source_connection_id");

-- CreateIndex
CREATE INDEX "migration_jobs_target_connection_id_idx" ON "migration_jobs"("target_connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_token_idx" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_category_idx" ON "audit_logs"("category");

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_idx" ON "audit_logs"("tenant_id");

-- CreateIndex
CREATE INDEX "ldap_config_tenant_id_idx" ON "ldap_config"("tenant_id");

-- CreateIndex
CREATE INDEX "oidc_config_tenant_id_idx" ON "oidc_config"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_slug_idx" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "user_tenants_user_id_idx" ON "user_tenants"("user_id");

-- CreateIndex
CREATE INDEX "user_tenants_tenant_id_idx" ON "user_tenants"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_settings_key_tenant" ON "settings"("key", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "rbac_roles_name_key" ON "rbac_roles"("name");

-- CreateIndex
CREATE INDEX "rbac_roles_name_idx" ON "rbac_roles"("name");

-- CreateIndex
CREATE INDEX "rbac_roles_is_system_idx" ON "rbac_roles"("is_system");

-- CreateIndex
CREATE UNIQUE INDEX "rbac_permissions_name_key" ON "rbac_permissions"("name");

-- CreateIndex
CREATE INDEX "rbac_permissions_category_idx" ON "rbac_permissions"("category");

-- CreateIndex
CREATE INDEX "rbac_user_roles_user_id_idx" ON "rbac_user_roles"("user_id");

-- CreateIndex
CREATE INDEX "rbac_user_roles_role_id_idx" ON "rbac_user_roles"("role_id");

-- CreateIndex
CREATE INDEX "rbac_user_roles_scope_type_scope_target_idx" ON "rbac_user_roles"("scope_type", "scope_target");

-- CreateIndex
CREATE INDEX "rbac_user_roles_tenant_id_idx" ON "rbac_user_roles"("tenant_id");

-- CreateIndex
CREATE INDEX "rbac_user_permissions_user_id_idx" ON "rbac_user_permissions"("user_id");

-- CreateIndex
CREATE INDEX "rbac_user_permissions_scope_type_scope_target_idx" ON "rbac_user_permissions"("scope_type", "scope_target");

-- CreateIndex
CREATE INDEX "rbac_user_permissions_tenant_id_idx" ON "rbac_user_permissions"("tenant_id");

-- CreateIndex
CREATE INDEX "vdcs_tenant_id_idx" ON "vdcs"("tenant_id");

-- CreateIndex
CREATE INDEX "vdcs_connection_id_idx" ON "vdcs"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "vdcs_tenant_id_connection_id_slug_key" ON "vdcs"("tenant_id", "connection_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "idx_vdcs_sdn_zone_name" ON "vdcs"("connection_id", "sdn_zone_name");

-- CreateIndex
CREATE INDEX "vdc_nodes_vdc_id_idx" ON "vdc_nodes"("vdc_id");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_nodes_vdc_id_node_name_key" ON "vdc_nodes"("vdc_id", "node_name");

-- CreateIndex
CREATE INDEX "vdc_storages_vdc_id_idx" ON "vdc_storages"("vdc_id");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_storages_vdc_id_storage_id_key" ON "vdc_storages"("vdc_id", "storage_id");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_quotas_vdc_id_key" ON "vdc_quotas"("vdc_id");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_usage_cache_vdc_id_key" ON "vdc_usage_cache"("vdc_id");

-- CreateIndex
CREATE INDEX "vdc_shared_bridges_vdc_id_idx" ON "vdc_shared_bridges"("vdc_id");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_shared_bridges_vdc_id_bridge_key" ON "vdc_shared_bridges"("vdc_id", "bridge");

-- CreateIndex
CREATE INDEX "vdc_vnets_vdc_id_idx" ON "vdc_vnets"("vdc_id");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_vnets_vdc_id_pve_name_key" ON "vdc_vnets"("vdc_id", "pve_name");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_vnets_vdc_id_vxlan_tag_key" ON "vdc_vnets"("vdc_id", "vxlan_tag");

-- CreateIndex
CREATE UNIQUE INDEX "idx_vdc_vnets_display_name" ON "vdc_vnets"("vdc_id", "display_name");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_subnets_vnet_id_key" ON "vdc_subnets"("vnet_id");

-- CreateIndex
CREATE INDEX "vdc_subnets_vnet_id_idx" ON "vdc_subnets"("vnet_id");

-- CreateIndex
CREATE INDEX "vdc_ipam_allocations_vdc_id_idx" ON "vdc_ipam_allocations"("vdc_id");

-- CreateIndex
CREATE INDEX "vdc_ipam_allocations_subnet_id_idx" ON "vdc_ipam_allocations"("subnet_id");

-- CreateIndex
CREATE INDEX "vdc_ipam_allocations_connection_id_vmid_idx" ON "vdc_ipam_allocations"("connection_id", "vmid");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_ipam_allocations_subnet_id_ip_key" ON "vdc_ipam_allocations"("subnet_id", "ip");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_ipam_allocations_subnet_id_mac_key" ON "vdc_ipam_allocations"("subnet_id", "mac");

-- CreateIndex
CREATE INDEX "vdc_pbs_namespaces_vdc_id_idx" ON "vdc_pbs_namespaces"("vdc_id");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_pbs_namespaces_pbs_connection_id_datastore_namespace_key" ON "vdc_pbs_namespaces"("pbs_connection_id", "datastore", "namespace");

-- CreateIndex
CREATE INDEX "vdc_pbs_pve_storages_vdc_pbs_namespace_id_idx" ON "vdc_pbs_pve_storages"("vdc_pbs_namespace_id");

-- CreateIndex
CREATE UNIQUE INDEX "vdc_pbs_pve_storages_pve_connection_id_pve_storage_name_key" ON "vdc_pbs_pve_storages"("pve_connection_id", "pve_storage_name");

-- CreateIndex
CREATE INDEX "alert_rules_enabled_idx" ON "alert_rules"("enabled");

-- CreateIndex
CREATE INDEX "alert_rules_metric_idx" ON "alert_rules"("metric");

-- CreateIndex
CREATE INDEX "alert_rules_tenant_id_idx" ON "alert_rules"("tenant_id");

-- CreateIndex
CREATE INDEX "alert_instances_status_idx" ON "alert_instances"("status");

-- CreateIndex
CREATE INDEX "alert_instances_rule_id_idx" ON "alert_instances"("rule_id");

-- CreateIndex
CREATE INDEX "alert_instances_triggered_at_idx" ON "alert_instances"("triggered_at");

-- CreateIndex
CREATE INDEX "alert_instances_entity_type_entity_id_idx" ON "alert_instances"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "alert_instances_tenant_id_idx" ON "alert_instances"("tenant_id");

-- CreateIndex
CREATE INDEX "alert_rule_owners_tenant_id_idx" ON "alert_rule_owners"("tenant_id");

-- CreateIndex
CREATE INDEX "favorites_user_id_idx" ON "favorites"("user_id");

-- CreateIndex
CREATE INDEX "favorites_vm_key_idx" ON "favorites"("vm_key");

-- CreateIndex
CREATE INDEX "favorites_tenant_id_idx" ON "favorites"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_user_id_vm_key_key" ON "favorites"("user_id", "vm_key");

-- CreateIndex
CREATE UNIQUE INDEX "health_score_history_date_key" ON "health_score_history"("date");

-- CreateIndex
CREATE INDEX "health_score_history_date_idx" ON "health_score_history"("date");

-- CreateIndex
CREATE INDEX "health_score_history_tenant_id_idx" ON "health_score_history"("tenant_id");

-- CreateIndex
CREATE INDEX "security_policies_tenant_id_idx" ON "security_policies"("tenant_id");

-- CreateIndex
CREATE INDEX "compliance_profiles_is_active_idx" ON "compliance_profiles"("is_active");

-- CreateIndex
CREATE INDEX "compliance_profiles_connection_id_idx" ON "compliance_profiles"("connection_id");

-- CreateIndex
CREATE INDEX "compliance_profiles_tenant_id_idx" ON "compliance_profiles"("tenant_id");

-- CreateIndex
CREATE INDEX "compliance_profile_checks_profile_id_idx" ON "compliance_profile_checks"("profile_id");

-- CreateIndex
CREATE INDEX "compliance_profile_checks_tenant_id_idx" ON "compliance_profile_checks"("tenant_id");

-- CreateIndex
CREATE INDEX "datacenters_tenant_id_idx" ON "datacenters"("tenant_id");

-- AddForeignKey
ALTER TABLE "ManagedHost" ADD CONSTRAINT "ManagedHost_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "rbac_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rbac_role_permissions" ADD CONSTRAINT "rbac_role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "rbac_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "rbac_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rbac_user_roles" ADD CONSTRAINT "rbac_user_roles_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rbac_user_permissions" ADD CONSTRAINT "rbac_user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rbac_user_permissions" ADD CONSTRAINT "rbac_user_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "rbac_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rbac_user_permissions" ADD CONSTRAINT "rbac_user_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdcs" ADD CONSTRAINT "vdcs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_nodes" ADD CONSTRAINT "vdc_nodes_vdc_id_fkey" FOREIGN KEY ("vdc_id") REFERENCES "vdcs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_storages" ADD CONSTRAINT "vdc_storages_vdc_id_fkey" FOREIGN KEY ("vdc_id") REFERENCES "vdcs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_quotas" ADD CONSTRAINT "vdc_quotas_vdc_id_fkey" FOREIGN KEY ("vdc_id") REFERENCES "vdcs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_usage_cache" ADD CONSTRAINT "vdc_usage_cache_vdc_id_fkey" FOREIGN KEY ("vdc_id") REFERENCES "vdcs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_shared_bridges" ADD CONSTRAINT "vdc_shared_bridges_vdc_id_fkey" FOREIGN KEY ("vdc_id") REFERENCES "vdcs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_vnets" ADD CONSTRAINT "vdc_vnets_vdc_id_fkey" FOREIGN KEY ("vdc_id") REFERENCES "vdcs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_subnets" ADD CONSTRAINT "vdc_subnets_vnet_id_fkey" FOREIGN KEY ("vnet_id") REFERENCES "vdc_vnets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_ipam_allocations" ADD CONSTRAINT "vdc_ipam_allocations_vdc_id_fkey" FOREIGN KEY ("vdc_id") REFERENCES "vdcs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_ipam_allocations" ADD CONSTRAINT "vdc_ipam_allocations_subnet_id_fkey" FOREIGN KEY ("subnet_id") REFERENCES "vdc_subnets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_ipam_allocations" ADD CONSTRAINT "vdc_ipam_allocations_vnet_id_fkey" FOREIGN KEY ("vnet_id") REFERENCES "vdc_vnets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_pbs_namespaces" ADD CONSTRAINT "vdc_pbs_namespaces_vdc_id_fkey" FOREIGN KEY ("vdc_id") REFERENCES "vdcs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vdc_pbs_pve_storages" ADD CONSTRAINT "vdc_pbs_pve_storages_vdc_pbs_namespace_id_fkey" FOREIGN KEY ("vdc_pbs_namespace_id") REFERENCES "vdc_pbs_namespaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_instances" ADD CONSTRAINT "alert_instances_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_profile_checks" ADD CONSTRAINT "compliance_profile_checks_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "compliance_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_green_config" ADD CONSTRAINT "connection_green_config_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_green_config" ADD CONSTRAINT "connection_green_config_datacenter_id_fkey" FOREIGN KEY ("datacenter_id") REFERENCES "datacenters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_green_config" ADD CONSTRAINT "node_green_config_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_green_config" ADD CONSTRAINT "node_green_config_datacenter_id_fkey" FOREIGN KEY ("datacenter_id") REFERENCES "datacenters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial UNIQUE index: at most one default datacentre per tenant.
-- Mirrors `CREATE UNIQUE INDEX idx_datacenters_default ON datacenters(tenant_id) WHERE is_default = 1`
-- from lib/db/sqlite.ts. Prisma cannot express partial unique indexes today,
-- so the constraint is added here by hand. Keep this section in sync with the
-- schema if the rule changes.
CREATE UNIQUE INDEX "idx_datacenters_default" ON "datacenters"("tenant_id") WHERE "is_default" = true;
