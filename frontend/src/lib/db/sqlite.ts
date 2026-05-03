// src/lib/db/sqlite.ts
import path from "path"
import fs from "fs"

import Database from "better-sqlite3"

let db: Database.Database | null = null

export function getDb() {
  if (db) return db

  const dir = path.join(process.cwd(), "data")

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const file = path.join(dir, "proxcenter.db")

  db = new Database(file)

  // NOTE: La table des connexions (Connection) est gérée par Prisma
  // Ne pas créer pve_connections ici pour éviter les doublons

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password TEXT,
      name TEXT,
      avatar TEXT,
      role TEXT NOT NULL DEFAULT 'viewer',
      auth_provider TEXT NOT NULL DEFAULT 'credentials',
      ldap_dn TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `)

  // Migration pour ajouter la colonne avatar si elle n'existe pas
  try {
    const userColumns = db.pragma('table_info(users)') as any[]
    const hasAvatarColumn = userColumns.some((col: any) => col.name === 'avatar')

    if (!hasAvatarColumn) {
      db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT`)
    }
  } catch (e) {
    // Ignore si erreur
  }

  // Migration pour ajouter la colonne oidc_sub si elle n'existe pas
  try {
    const userColumns2 = db.pragma('table_info(users)') as any[]
    const hasOidcSub = userColumns2.some((col: any) => col.name === 'oidc_sub')

    if (!hasOidcSub) {
      db.exec(`ALTER TABLE users ADD COLUMN oidc_sub TEXT`)
    }
  } catch (e) {
    // Ignore si erreur
  }

  // Migration pour ajouter la colonne start_tls sur ldap_config
  try {
    const ldapColsTls = db.pragma('table_info(ldap_config)') as any[]
    if (!ldapColsTls.some((c: any) => c.name === 'start_tls')) {
      db.exec(`ALTER TABLE ldap_config ADD COLUMN start_tls INTEGER NOT NULL DEFAULT 0`)
    }
  } catch {}

  // Migration pour ajouter les colonnes de group mapping LDAP
  try {
    const ldapCols = db.pragma('table_info(ldap_config)') as any[]
    if (!ldapCols.some((c: any) => c.name === 'group_attribute')) {
      db.exec(`ALTER TABLE ldap_config ADD COLUMN group_attribute TEXT DEFAULT 'memberOf'`)
    }
    if (!ldapCols.some((c: any) => c.name === 'group_role_mapping')) {
      db.exec(`ALTER TABLE ldap_config ADD COLUMN group_role_mapping TEXT DEFAULT '{}'`)
    }
    if (!ldapCols.some((c: any) => c.name === 'default_role')) {
      db.exec(`ALTER TABLE ldap_config ADD COLUMN default_role TEXT DEFAULT 'role_viewer'`)
    }
  } catch {}

  // Migration: add require_group and allowed_groups columns to ldap_config
  try {
    const ldapColsReq = db.pragma('table_info(ldap_config)') as any[]
    if (!ldapColsReq.some((c: any) => c.name === 'require_group')) {
      db.exec(`ALTER TABLE ldap_config ADD COLUMN require_group INTEGER NOT NULL DEFAULT 0`)
    }
    if (!ldapColsReq.some((c: any) => c.name === 'allowed_groups')) {
      db.exec(`ALTER TABLE ldap_config ADD COLUMN allowed_groups TEXT DEFAULT '[]'`)
    }
  } catch {}

  // Migration: add missing columns to Prisma-managed tables
  const prismaMigrations: [string, string, string][] = [
    ['Connection', 'tags', 'TEXT'],
    ['Connection', 'sub_type', 'TEXT'],
    ['Connection', 'vmware_datacenter', 'TEXT'],
    ['Connection', 'hyperv_share_name', 'TEXT'],
    ['ManagedHost', 'tags', 'TEXT'],
    ['custom_images', 'tags', 'TEXT'],
    ['blueprints', 'tags', 'TEXT'],
  ]

  for (const [table, col, type] of prismaMigrations) {
    try {
      const cols = db.pragma(`table_info(${table})`) as any[]

      if (cols.length > 0 && !cols.some((c: any) => c.name === col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
      }
    } catch {}
  }

  db.exec(`
    -- Table des sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    -- Table des logs d'audit
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      user_id TEXT,
      user_email TEXT,
      action TEXT NOT NULL,
      category TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      resource_name TEXT,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs(category);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

    -- Table de configuration LDAP
    CREATE TABLE IF NOT EXISTS ldap_config (
      id TEXT PRIMARY KEY DEFAULT 'default',
      enabled INTEGER NOT NULL DEFAULT 0,
      url TEXT NOT NULL,
      bind_dn TEXT,
      bind_password_enc TEXT,
      base_dn TEXT NOT NULL,
      user_filter TEXT NOT NULL DEFAULT '(uid={{username}})',
      email_attribute TEXT NOT NULL DEFAULT 'mail',
      name_attribute TEXT NOT NULL DEFAULT 'cn',
      tls_insecure INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Table de configuration OIDC / SSO
    CREATE TABLE IF NOT EXISTS oidc_config (
      id TEXT PRIMARY KEY DEFAULT 'default',
      enabled INTEGER NOT NULL DEFAULT 0,
      provider_name TEXT NOT NULL DEFAULT 'SSO',
      issuer_url TEXT NOT NULL DEFAULT '',
      client_id TEXT NOT NULL DEFAULT '',
      client_secret_enc TEXT,
      scopes TEXT NOT NULL DEFAULT 'openid profile email',
      authorization_url TEXT,
      token_url TEXT,
      userinfo_url TEXT,
      claim_email TEXT NOT NULL DEFAULT 'email',
      claim_name TEXT NOT NULL DEFAULT 'name',
      claim_groups TEXT DEFAULT 'groups',
      auto_provision INTEGER NOT NULL DEFAULT 1,
      default_role TEXT NOT NULL DEFAULT 'viewer',
      group_role_mapping TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Table des règles d'alertes
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      metric TEXT NOT NULL,
      operator TEXT NOT NULL,
      threshold REAL NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      severity TEXT NOT NULL DEFAULT 'warning',
      scope_type TEXT NOT NULL DEFAULT 'all',
      scope_target TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_metric ON alert_rules(metric);

    -- Table des alertes déclenchées par les règles (distinct de la table Prisma "alerts")
    CREATE TABLE IF NOT EXISTS alert_instances (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_name TEXT,
      node TEXT,
      connection_id TEXT,
      connection_name TEXT,
      metric TEXT NOT NULL,
      current_value REAL,
      threshold REAL NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      resolved_at TEXT,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_alert_instances_status ON alert_instances(status);
    CREATE INDEX IF NOT EXISTS idx_alert_instances_rule_id ON alert_instances(rule_id);
    CREATE INDEX IF NOT EXISTS idx_alert_instances_triggered_at ON alert_instances(triggered_at);
    CREATE INDEX IF NOT EXISTS idx_alert_instances_entity ON alert_instances(entity_type, entity_id);

    -- Maps an orchestrator alert rule to the tenant that authored it.
    -- The orchestrator (Go) doesn't track tenant ownership on its rules,
    -- so we record it here at POST time and use it at GET time to scope
    -- both the rule list and the resulting alerts.
    CREATE TABLE IF NOT EXISTS alert_rule_owners (
      rule_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alert_rule_owners_tenant ON alert_rule_owners(tenant_id);
  `)

  // Migration pour créer la table favorites si elle n'existe pas
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS favorites (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        vm_key TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        node TEXT NOT NULL,
        vm_type TEXT NOT NULL,
        vmid TEXT NOT NULL,
        vm_name TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, vm_key)
      );
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_favorites_vm_key ON favorites(vm_key);`)
  } catch (e) {
    // Migration error is non-critical, table may already exist
  }

  // Health score history (Resource Planner F8)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS health_score_history (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL UNIQUE,
        score INTEGER NOT NULL,
        cpu_pct REAL,
        ram_pct REAL,
        storage_pct REAL,
        details TEXT,
        connection_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_health_score_date ON health_score_history(date);
    `)
  } catch (e) {
    // Migration error is non-critical
  }

  // ========================================
  // Table security_policies (singleton, like ldap_config)
  // ========================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS security_policies (
        id TEXT PRIMARY KEY DEFAULT 'default',
        password_min_length INTEGER NOT NULL DEFAULT 8,
        password_require_uppercase INTEGER NOT NULL DEFAULT 0,
        password_require_lowercase INTEGER NOT NULL DEFAULT 0,
        password_require_numbers INTEGER NOT NULL DEFAULT 0,
        password_require_special INTEGER NOT NULL DEFAULT 0,
        session_timeout_minutes INTEGER NOT NULL DEFAULT 43200,
        session_max_concurrent INTEGER NOT NULL DEFAULT 0,
        login_max_failed_attempts INTEGER NOT NULL DEFAULT 0,
        login_lockout_duration_minutes INTEGER NOT NULL DEFAULT 15,
        audit_retention_days INTEGER NOT NULL DEFAULT 90,
        audit_auto_cleanup INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
      INSERT OR IGNORE INTO security_policies (id, updated_at) VALUES ('default', datetime('now'));
    `)
  } catch (e) {
    // Migration error is non-critical
  }

  // ========================================
  // Tables compliance profiles
  // ========================================
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS compliance_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        framework_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        connection_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compliance_profiles_active ON compliance_profiles(is_active);
      CREATE INDEX IF NOT EXISTS idx_compliance_profiles_connection ON compliance_profiles(connection_id);

      CREATE TABLE IF NOT EXISTS compliance_profile_checks (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        check_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        weight REAL NOT NULL DEFAULT 1.0,
        control_ref TEXT,
        category TEXT,
        FOREIGN KEY (profile_id) REFERENCES compliance_profiles(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_compliance_profile_checks_profile ON compliance_profile_checks(profile_id);
    `)
  } catch (e) {
    // Migration error is non-critical
  }

  // ========================================
  // Multi-tenancy tables
  // ========================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      settings TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);

    CREATE TABLE IF NOT EXISTS user_tenants (
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (user_id, tenant_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_tenants_user ON user_tenants(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant ON user_tenants(tenant_id);

    CREATE TABLE IF NOT EXISTS vdcs (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL REFERENCES tenants(id),
      connection_id   TEXT NOT NULL,
      name            TEXT NOT NULL,
      slug            TEXT NOT NULL,
      description     TEXT,
      pve_pool_name   TEXT NOT NULL,
      enabled         INTEGER DEFAULT 1,
      -- Single shared storage backing the vDC VM disks. Local storages
      -- and ISO/backup-only storages are excluded by the admin form. The
      -- legacy vdc_storages table kept a multi-row whitelist; it now
      -- serves only PBS pseudo-storage bindings (see pbsOrchestrator).
      primary_storage TEXT,
      created_by      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, connection_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_vdcs_tenant ON vdcs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_vdcs_connection ON vdcs(connection_id);

    CREATE TABLE IF NOT EXISTS vdc_nodes (
      id              TEXT PRIMARY KEY,
      vdc_id          TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      node_name       TEXT NOT NULL,
      UNIQUE(vdc_id, node_name)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_nodes_vdc ON vdc_nodes(vdc_id);

    CREATE TABLE IF NOT EXISTS vdc_storages (
      id              TEXT PRIMARY KEY,
      vdc_id          TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      storage_id      TEXT NOT NULL,
      UNIQUE(vdc_id, storage_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_storages_vdc ON vdc_storages(vdc_id);

    CREATE TABLE IF NOT EXISTS vdc_quotas (
      id              TEXT PRIMARY KEY,
      vdc_id          TEXT NOT NULL UNIQUE REFERENCES vdcs(id) ON DELETE CASCADE,
      max_vcpus       INTEGER,
      max_ram_mb      INTEGER,
      max_storage_mb  INTEGER,
      max_vms         INTEGER,
      max_snapshots   INTEGER,
      max_backups     INTEGER,
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vdc_usage_cache (
      id              TEXT PRIMARY KEY,
      vdc_id          TEXT NOT NULL UNIQUE REFERENCES vdcs(id) ON DELETE CASCADE,
      used_vcpus      INTEGER DEFAULT 0,
      used_ram_mb     INTEGER DEFAULT 0,
      used_storage_mb INTEGER DEFAULT 0,
      used_vms        INTEGER DEFAULT 0,
      used_snapshots  INTEGER DEFAULT 0,
      used_backups    INTEGER DEFAULT 0,
      last_synced_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS vdc_shared_bridges (
      id         TEXT PRIMARY KEY,
      vdc_id     TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      bridge     TEXT NOT NULL,
      label      TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(vdc_id, bridge)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_shared_bridges_vdc ON vdc_shared_bridges(vdc_id);

    CREATE TABLE IF NOT EXISTS vdc_vnets (
      id            TEXT PRIMARY KEY,
      vdc_id        TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      pve_name      TEXT NOT NULL,                 -- 8-char unique ID sent to PVE (hash-based)
      display_name  TEXT,                          -- friendly name shown to the tenant; unique per vDC
      description   TEXT,
      vxlan_tag     INTEGER NOT NULL,
      firewall      INTEGER DEFAULT 1,
      created_by    TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(vdc_id, pve_name),
      UNIQUE(vdc_id, vxlan_tag)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_vnets_vdc ON vdc_vnets(vdc_id);

    -- One L3 subnet attached to a VNet. MVP supports a single subnet per
    -- VNet (UNIQUE on vnet_id) — multi-subnet (e.g. dual-stack v4/v6) can
    -- relax the constraint later. ipam_enabled is reserved for a future
    -- "bridge-only without IPAM" mode; today it is always 1 when a row
    -- exists. Subnet is mandatory: VNets without one cannot allocate IPs
    -- (PVE-native IPAM/DHCP are broken on VXLAN zones in PVE 9.x).
    CREATE TABLE IF NOT EXISTS vdc_subnets (
      id                TEXT PRIMARY KEY,
      vnet_id           TEXT NOT NULL UNIQUE REFERENCES vdc_vnets(id) ON DELETE CASCADE,
      cidr              TEXT NOT NULL,
      gateway           TEXT NOT NULL,
      dns_servers       TEXT,                      -- comma-separated, optional
      ipam_enabled      INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_subnets_vnet ON vdc_subnets(vnet_id);

    -- IPAM allocations owned by ProxCenter. We don't rely on PVE's built-in
    -- IPAM because (a) it is opaque on VXLAN zones in PVE 9.x — the
    -- allocations endpoint returns 200 but writes nothing readable in
    -- /cluster/sdn/ipams/pve/status — and (b) we need multi-tenant queries
    -- that the PVE API never exposes. Each row pins a single IP to a MAC
    -- inside one subnet; (subnet_id, ip) and (subnet_id, mac) are unique so
    -- re-allocating with the same MAC returns the same IP idempotently.
    -- vmid is denormalised so the VM-delete hook can release in one query.
    -- ip_int holds the IP as a uint32 to make next-free / range queries
    -- trivial without parsing strings on every row.
    CREATE TABLE IF NOT EXISTS vdc_ipam_allocations (
      id          TEXT PRIMARY KEY,
      vdc_id      TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      subnet_id   TEXT NOT NULL REFERENCES vdc_subnets(id) ON DELETE CASCADE,
      vnet_id     TEXT NOT NULL REFERENCES vdc_vnets(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL,                -- denormalised for the VM-delete hook
      ip          TEXT NOT NULL,
      ip_int      INTEGER NOT NULL,
      mac         TEXT NOT NULL,
      vmid        INTEGER,
      hostname    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (subnet_id, ip),
      UNIQUE (subnet_id, mac)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_ipam_allocations_vdc ON vdc_ipam_allocations(vdc_id);
    CREATE INDEX IF NOT EXISTS idx_vdc_ipam_allocations_subnet ON vdc_ipam_allocations(subnet_id);
    CREATE INDEX IF NOT EXISTS idx_vdc_ipam_allocations_vmid ON vdc_ipam_allocations(connection_id, vmid);

    CREATE TABLE IF NOT EXISTS vdc_pbs_namespaces (
      id                 TEXT PRIMARY KEY,
      vdc_id             TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
      pbs_connection_id  TEXT NOT NULL,
      datastore          TEXT NOT NULL,
      namespace          TEXT NOT NULL,
      mode               TEXT NOT NULL DEFAULT 'auto',
      pbs_token_id       TEXT,
      pbs_token_secret   TEXT,
      created_at         TEXT DEFAULT (datetime('now')),
      UNIQUE (pbs_connection_id, datastore, namespace)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_pbs_namespaces_vdc ON vdc_pbs_namespaces(vdc_id);

    CREATE TABLE IF NOT EXISTS vdc_pbs_pve_storages (
      id                    TEXT PRIMARY KEY,
      vdc_pbs_namespace_id  TEXT NOT NULL REFERENCES vdc_pbs_namespaces(id) ON DELETE CASCADE,
      pve_connection_id     TEXT NOT NULL,
      pve_storage_name      TEXT NOT NULL,
      managed               INTEGER NOT NULL DEFAULT 1,
      created_at            TEXT DEFAULT (datetime('now')),
      UNIQUE (pve_connection_id, pve_storage_name)
    );
    CREATE INDEX IF NOT EXISTS idx_vdc_pbs_pve_storages_binding ON vdc_pbs_pve_storages(vdc_pbs_namespace_id);

    -- Multi-DC Green-IT (Phase A) — provider-managed datacentre catalogue,
    -- per-cluster and per-node green configuration.
    CREATE TABLE IF NOT EXISTS datacenters (
      id                  TEXT PRIMARY KEY,
      tenant_id           TEXT NOT NULL DEFAULT 'default',
      name                TEXT NOT NULL,
      location_label      TEXT,
      country             TEXT,
      latitude            REAL,
      longitude           REAL,
      pue                 REAL NOT NULL DEFAULT 1.4,
      electricity_price   REAL NOT NULL DEFAULT 0.18,
      currency            TEXT NOT NULL DEFAULT 'EUR',
      co2_factor          REAL NOT NULL DEFAULT 0.052,
      co2_country_preset  TEXT,
      tdp_per_core_w      REAL NOT NULL DEFAULT 10,
      watts_per_gb_ram    REAL NOT NULL DEFAULT 0.375,
      overhead_per_node_w REAL NOT NULL DEFAULT 50,
      comment             TEXT,
      is_default          INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_datacenters_default
      ON datacenters(tenant_id) WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS connection_green_config (
      connection_id        TEXT PRIMARY KEY REFERENCES "Connection"(id) ON DELETE CASCADE,
      datacenter_id        TEXT REFERENCES datacenters(id) ON DELETE SET NULL,
      tdp_per_core_w       REAL,
      watts_per_gb_ram     REAL,
      overhead_per_node_w  REAL,
      updated_at           TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS node_green_config (
      connection_id        TEXT NOT NULL REFERENCES "Connection"(id) ON DELETE CASCADE,
      node_name            TEXT NOT NULL,
      datacenter_id        TEXT REFERENCES datacenters(id) ON DELETE SET NULL,
      tdp_per_core_w       REAL,
      watts_per_gb_ram     REAL,
      overhead_per_node_w  REAL,
      updated_at           TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (connection_id, node_name)
    );
  `)

  // Phase 4a migration: vdc_quotas.max_vnets (nullable = unlimited)
  try {
    db.prepare('ALTER TABLE vdc_quotas ADD COLUMN max_vnets INTEGER').run()
  } catch (e: any) {
    if (!String(e?.message || '').includes('duplicate column')) {
      throw e
    }
  }

  // Phase 4a migration: vdcs.sdn_zone_name + unique index per connection
  try {
    db.prepare('ALTER TABLE vdcs ADD COLUMN sdn_zone_name TEXT').run()
  } catch (e: any) {
    if (!String(e?.message || '').includes('duplicate column')) {
      throw e
    }
  }
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_vdcs_sdn_zone_name ON vdcs(connection_id, sdn_zone_name)'
  ).run()

  // Single primary storage per vDC. Replaces the legacy `vdc_storages`
  // multi-row whitelist for VM disk storage. Backfill takes the first
  // existing storage_id from vdc_storages for each vDC that doesn't
  // already have one — admin will need to re-pick a shared one if the
  // backfilled value turns out to be local. New vDCs go through the
  // shared-only filter at creation time.
  try {
    db.prepare('ALTER TABLE vdcs ADD COLUMN primary_storage TEXT').run()
  } catch (e: any) {
    if (!String(e?.message || '').includes('duplicate column')) {
      throw e
    }
  }
  db.prepare(`
    UPDATE vdcs
    SET primary_storage = (
      SELECT storage_id FROM vdc_storages
      WHERE vdc_storages.vdc_id = vdcs.id
        AND vdc_storages.storage_id NOT LIKE 'pbs:%'
      LIMIT 1
    )
    WHERE primary_storage IS NULL
  `).run()

  // SDN VNet display_name decoupling — PVE caps VNet IDs at 8 chars and
  // requires them to be unique cluster-wide, which makes "lan" / "dmz" / etc.
  // unusable in a multi-tenant MSP setup. We now hash a unique 8-char pve_name
  // per VNet and let the user pick a free-form display_name scoped to their
  // vDC. Backfill: pre-existing rows had pve_name double as the display name,
  // so set display_name = pve_name for them.
  try {
    db.prepare('ALTER TABLE vdc_vnets ADD COLUMN display_name TEXT').run()
  } catch (e: any) {
    if (!String(e?.message || '').includes('duplicate column')) {
      throw e
    }
  }
  db.prepare(
    'UPDATE vdc_vnets SET display_name = pve_name WHERE display_name IS NULL OR display_name = ""'
  ).run()
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_vdc_vnets_display_name ON vdc_vnets(vdc_id, display_name)'
  ).run()

  // Cleanup migration: vdc_vnets.isolate_ports / vlan_aware were UI-exposed
  // toggles whose underlying PVE flags either had no real tenant use case
  // (isolate-ports) or required a niche networking-savvy audience that
  // we don't target (vlan-aware). Same for vdc_subnets.dhcp_range_*: the
  // dnsmasq-on-VXLAN flow is broken on PVE 9.x (the IPAM=pve backend is
  // broken, and dhcp=dnsmasq depends on it), so the column described a
  // capability we never actually delivered. Drop them all so they stop
  // surfacing in queries / SELECTs / type-checks.
  for (const drop of [
    'ALTER TABLE vdc_vnets DROP COLUMN isolate_ports',
    'ALTER TABLE vdc_vnets DROP COLUMN vlan_aware',
    'ALTER TABLE vdc_subnets DROP COLUMN dhcp_range_start',
    'ALTER TABLE vdc_subnets DROP COLUMN dhcp_range_end',
  ]) {
    try {
      db.prepare(drop).run()
    } catch (e: any) {
      const msg = String(e?.message || '').toLowerCase()
      // SQLite: "no such column: X" once the column is already gone.
      if (!msg.includes('no such column')) throw e
    }
  }

  // Multi-DC Phase A — datacentres now own server specs (TDP/core, W/GB RAM,
  // overhead) so the inheritance chain is self-contained: node → cluster →
  // DC → constants. ADD COLUMN is wrapped in try/catch for installs that
  // already have the table from the initial CREATE.
  for (const colDef of [
    'ALTER TABLE datacenters ADD COLUMN tdp_per_core_w REAL NOT NULL DEFAULT 10',
    'ALTER TABLE datacenters ADD COLUMN watts_per_gb_ram REAL NOT NULL DEFAULT 0.375',
    'ALTER TABLE datacenters ADD COLUMN overhead_per_node_w REAL NOT NULL DEFAULT 50',
    'ALTER TABLE datacenters ADD COLUMN comment TEXT',
  ]) {
    try {
      db.prepare(colDef).run()
    } catch (e: any) {
      if (!String(e?.message || '').includes('duplicate column')) throw e
    }
  }

  // Auto-create DEFAULT tenant
  {
    const now = new Date().toISOString()
    db.prepare(
      "INSERT OR IGNORE INTO tenants (id, slug, name, description, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('default', 'default', 'Default', 'Default tenant for all existing data', 1, now, now)
  }

  // Safety net: ensure every user belongs to at least one tenant.
  // Only attaches orphan users (no membership anywhere) to 'default' — users
  // already scoped to another tenant stay put, so we don't fight the
  // provider-admin who moved them out of 'default' on purpose.
  try {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT OR IGNORE INTO user_tenants (user_id, tenant_id, is_default, joined_at)
       SELECT u.id, 'default', 1, ?
       FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = u.id)`
    ).run(now)
  } catch {}

  // Add tenant_id column to tenant-scoped tables
  const tenantScopedTables = [
    'users', 'audit_logs', 'favorites', 'alert_rules', 'alert_instances',
    'health_score_history', 'security_policies', 'compliance_profiles',
    'compliance_profile_checks',
    'ldap_config', 'oidc_config', 'rbac_user_roles', 'rbac_user_permissions',
    'settings'
  ]

  for (const table of tenantScopedTables) {
    try {
      const cols = db.pragma(`table_info(${table})`) as any[]
      if (!cols.some((c: any) => c.name === 'tenant_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`)
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`)
      }
    } catch {}
  }

  // ========================================
  // Table Settings (per-tenant)
  // ========================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (key, tenant_id)
    )
  `)

  // Migrate old settings table: if it exists with single-column PK, migrate data
  try {
    const cols = db.pragma('table_info(settings)') as any[]
    const hasTenantCol = cols.some((c: any) => c.name === 'tenant_id')
    if (cols.length > 0 && !hasTenantCol) {
      // Old schema without tenant_id — add column
      db.exec(`ALTER TABLE settings ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`)
    }
    // Ensure UNIQUE index on (key, tenant_id) exists for ON CONFLICT to work
    // (new DBs get this from PRIMARY KEY, old DBs need the explicit index)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_key_tenant ON settings(key, tenant_id)`)
  } catch {}

  // ========================================
  // Tables RBAC
  // ========================================
  
  db.exec(`
    -- Table des rôles personnalisés
    CREATE TABLE IF NOT EXISTS rbac_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      is_system INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT '#6366f1',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rbac_roles_name ON rbac_roles(name);
    CREATE INDEX IF NOT EXISTS idx_rbac_roles_system ON rbac_roles(is_system);

    -- Table des permissions disponibles
    CREATE TABLE IF NOT EXISTS rbac_permissions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      description TEXT,
      is_dangerous INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_rbac_permissions_category ON rbac_permissions(category);

    -- Table de liaison rôles <-> permissions
    CREATE TABLE IF NOT EXISTS rbac_role_permissions (
      role_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES rbac_roles(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES rbac_permissions(id) ON DELETE CASCADE
    );

    -- Table des assignations de rôles aux utilisateurs avec scope
    -- scope_type: 'global', 'connection', 'node', 'vm'
    -- scope_target: null (global), connection_id, node, ou vmid (format: connection_id:node:vmtype:vmid)
    CREATE TABLE IF NOT EXISTS rbac_user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_target TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      granted_by TEXT,
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES rbac_roles(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rbac_user_roles_user ON rbac_user_roles(user_id);
    CREATE INDEX IF NOT EXISTS idx_rbac_user_roles_role ON rbac_user_roles(role_id);
    CREATE INDEX IF NOT EXISTS idx_rbac_user_roles_scope ON rbac_user_roles(scope_type, scope_target);

    -- Table des permissions directes (sans passer par un rôle)
    CREATE TABLE IF NOT EXISTS rbac_user_permissions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_target TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      granted_by TEXT,
      granted_at TEXT NOT NULL,
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES rbac_permissions(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rbac_user_perms_user ON rbac_user_permissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_rbac_user_perms_scope ON rbac_user_permissions(scope_type, scope_target);
  `)

  // Liste complète des permissions - utilise INSERT OR IGNORE pour ajouter les nouvelles sans dupliquer
  const allPermissions = [
    // VM/CT Operations
    { id: 'vm.view', name: 'vm.view', category: 'vm', description: 'View VMs and their details' },
    { id: 'vm.console', name: 'vm.console', category: 'vm', description: 'Access VNC/SPICE console' },
    { id: 'vm.start', name: 'vm.start', category: 'vm', description: 'Start a VM' },
    { id: 'vm.stop', name: 'vm.stop', category: 'vm', description: 'Stop a VM' },
    { id: 'vm.restart', name: 'vm.restart', category: 'vm', description: 'Restart a VM' },
    { id: 'vm.suspend', name: 'vm.suspend', category: 'vm', description: 'Suspend/Resume a VM' },
    { id: 'vm.snapshot', name: 'vm.snapshot', category: 'vm', description: 'Create/Delete snapshots' },
    { id: 'vm.backup', name: 'vm.backup', category: 'vm', description: 'Backup/Restore a VM' },
    { id: 'vm.clone', name: 'vm.clone', category: 'vm', description: 'Clone a VM' },
    { id: 'vm.migrate', name: 'vm.migrate', category: 'vm', description: 'Migrate a VM', is_dangerous: 1 },
    { id: 'vm.config', name: 'vm.config', category: 'vm', description: 'Modify VM configuration', is_dangerous: 1 },
    { id: 'vm.delete', name: 'vm.delete', category: 'vm', description: 'Delete a VM', is_dangerous: 1 },
    { id: 'vm.create', name: 'vm.create', category: 'vm', description: 'Create a new VM', is_dangerous: 1 },

    // Storage Operations
    { id: 'storage.view', name: 'storage.view', category: 'storage', description: 'View storages' },
    { id: 'storage.content', name: 'storage.content', category: 'storage', description: 'Browse storage content' },
    { id: 'storage.upload', name: 'storage.upload', category: 'storage', description: 'Upload ISO files/templates' },
    { id: 'storage.delete', name: 'storage.delete', category: 'storage', description: 'Delete files', is_dangerous: 1 },

    // Node Operations
    { id: 'node.view', name: 'node.view', category: 'node', description: 'View cluster nodes' },
    { id: 'node.console', name: 'node.console', category: 'node', description: 'Access node console' },
    { id: 'node.services', name: 'node.services', category: 'node', description: 'Manage services', is_dangerous: 1 },
    { id: 'node.network', name: 'node.network', category: 'node', description: 'Configure network', is_dangerous: 1 },

    // Cluster/Connection Operations
    { id: 'connection.view', name: 'connection.view', category: 'connection', description: 'View PVE/PBS connections' },
    { id: 'connection.manage', name: 'connection.manage', category: 'connection', description: 'Manage connections', is_dangerous: 1 },

    // Backup Operations
    { id: 'backup.view', name: 'backup.view', category: 'backup', description: 'View backups' },
    { id: 'backup.restore', name: 'backup.restore', category: 'backup', description: 'Restore a backup', is_dangerous: 1 },
    { id: 'backup.delete', name: 'backup.delete', category: 'backup', description: 'Delete a backup', is_dangerous: 1 },

    // Backup Job Operations (scheduled backups)
    { id: 'backup.job.view', name: 'backup.job.view', category: 'backup', description: 'View scheduled backup jobs' },
    { id: 'backup.job.create', name: 'backup.job.create', category: 'backup', description: 'Create a backup job', is_dangerous: 1 },
    { id: 'backup.job.edit', name: 'backup.job.edit', category: 'backup', description: 'Edit a backup job', is_dangerous: 1 },
    { id: 'backup.job.delete', name: 'backup.job.delete', category: 'backup', description: 'Delete a backup job', is_dangerous: 1 },
    { id: 'backup.job.run', name: 'backup.job.run', category: 'backup', description: 'Manually run a backup job' },

    // Node Management
    { id: 'node.manage', name: 'node.manage', category: 'node', description: 'Manage nodes (updates, restart)', is_dangerous: 1 },

    // Automation (DRS, Rolling Updates, etc.)
    { id: 'automation.view', name: 'automation.view', category: 'automation', description: 'View automation and DRS settings' },
    { id: 'automation.manage', name: 'automation.manage', category: 'automation', description: 'Configure automation and DRS', is_dangerous: 1 },
    { id: 'automation.execute', name: 'automation.execute', category: 'automation', description: 'Execute automation actions', is_dangerous: 1 },

    // Operations
    { id: 'events.view', name: 'events.view', category: 'operations', description: 'View events and logs' },
    { id: 'alerts.view', name: 'alerts.view', category: 'operations', description: 'View alerts' },
    { id: 'alerts.manage', name: 'alerts.manage', category: 'operations', description: 'Manage alerts (acknowledge, resolve)', is_dangerous: 1 },
    { id: 'tasks.view', name: 'tasks.view', category: 'operations', description: 'View task center' },
    { id: 'reports.view', name: 'reports.view', category: 'operations', description: 'View reports' },

    // Storage Admin
    { id: 'storage.admin', name: 'storage.admin', category: 'storage', description: 'Access Storage Overview and Ceph pages', is_dangerous: 1 },

    // Admin Operations
    { id: 'admin.users', name: 'admin.users', category: 'admin', description: 'Manage users', is_dangerous: 1 },
    { id: 'admin.rbac', name: 'admin.rbac', category: 'admin', description: 'Manage roles and permissions', is_dangerous: 1 },
    { id: 'admin.settings', name: 'admin.settings', category: 'admin', description: 'Modify settings', is_dangerous: 1 },
    { id: 'admin.audit', name: 'admin.audit', category: 'admin', description: 'View audit logs' },
    { id: 'admin.compliance', name: 'admin.compliance', category: 'admin', description: 'Manage compliance and security policies', is_dangerous: 1 },
    { id: 'admin.tenants', name: 'admin.tenants', category: 'admin', description: 'Manage tenants (multi-tenancy)', is_dangerous: 1 },

    // SDN / VNet Operations
    { id: 'sdn.vnet.view', name: 'sdn.vnet.view', category: 'sdn', description: 'List and view VNets in own vDCs', is_dangerous: 0 },
    { id: 'sdn.vnet.create', name: 'sdn.vnet.create', category: 'sdn', description: 'Create new VNets in own vDCs', is_dangerous: 0 },
    { id: 'sdn.vnet.edit', name: 'sdn.vnet.edit', category: 'sdn', description: 'Edit VNet metadata and firewall toggle', is_dangerous: 0 },
    { id: 'sdn.vnet.delete', name: 'sdn.vnet.delete', category: 'sdn', description: 'Delete VNets that have no NIC attached', is_dangerous: 1 },
    { id: 'sdn.vnet.firewall', name: 'sdn.vnet.firewall', category: 'sdn', description: 'CRUD firewall rules, ipsets, aliases per VNet', is_dangerous: 1 },
  ]

  // Utiliser INSERT OR IGNORE pour ajouter les permissions manquantes sans erreur
  const now = new Date().toISOString()
  const insertPerm = db.prepare(
    'INSERT OR IGNORE INTO rbac_permissions (id, name, category, description, is_dangerous, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )

  for (const p of allPermissions) {
    insertPerm.run(p.id, p.name, p.category, p.description, p.is_dangerous || 0, now)
  }

  // Insérer les rôles système par défaut si la table est vide
  const roleCount = db.prepare('SELECT COUNT(*) as count FROM rbac_roles').get() as any

  if (roleCount.count === 0) {
    const now = new Date().toISOString()

    const roles = [
      {
        id: 'role_super_admin',
        name: 'Super Admin',
        description: 'Full access to all features',
        is_system: 1,
        color: '#ef4444',
        permissions: ['*'] // Wildcard = all permissions
      },
      {
        id: 'role_operator',
        name: 'Operator',
        description: 'Day-to-day VM management without admin access',
        is_system: 1,
        color: '#f59e0b',
        permissions: [
          'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
          'vm.snapshot', 'vm.backup',
          'node.view', 'node.console', 'connection.view', 'backup.view',
          'events.view', 'tasks.view', 'alerts.view', 'automation.view', 'reports.view'
        ]
      },
      {
        id: 'role_vm_admin',
        name: 'VM Admin',
        description: 'Full VM administration',
        is_system: 1,
        color: '#8b5cf6',
        permissions: [
          'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
          'vm.snapshot', 'vm.backup', 'vm.clone', 'vm.migrate', 'vm.config', 'vm.delete', 'vm.create',
          'storage.view', 'storage.content', 'storage.upload',
          'node.view', 'node.console', 'node.manage', 'connection.view',
          'backup.view', 'backup.restore',
          'events.view', 'tasks.view', 'storage.admin',
          'alerts.view', 'alerts.manage', 'automation.view', 'automation.manage', 'reports.view'
        ]
      },
      {
        id: 'role_viewer',
        name: 'Viewer',
        description: 'Read-only access to all resources',
        is_system: 1,
        color: '#3b82f6',
        permissions: [
          'vm.view', 'node.view', 'connection.view', 'backup.view',
          'events.view', 'alerts.view', 'automation.view', 'reports.view', 'tasks.view'
        ]
      },
      {
        id: 'role_vm_user',
        name: 'VM User',
        description: 'Basic usage of assigned VMs (console, start/stop)',
        is_system: 1,
        color: '#10b981',
        permissions: [
          'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart'
        ]
      },
      {
        id: 'role_provider_admin',
        name: 'Provider Admin',
        description: 'MSP provider: full access + manages tenant identity and OIDC',
        is_system: 1,
        color: '#dc2626',
        permissions: ['*']
      },
      {
        id: 'role_tenant_admin',
        name: 'Tenant Admin',
        description: 'Full VM and backup administration within tenant scope',
        is_system: 1,
        color: '#ea580c',
        permissions: [
          'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
          'vm.snapshot', 'vm.backup', 'vm.clone', 'vm.migrate', 'vm.config', 'vm.delete', 'vm.create',
          'node.view', 'connection.view',
          'backup.view', 'backup.restore', 'backup.delete',
          'backup.job.view', 'backup.job.create', 'backup.job.edit', 'backup.job.delete', 'backup.job.run',
          'admin.users', 'admin.rbac', 'admin.settings', 'admin.audit',
          'alerts.view', 'alerts.manage',
          'sdn.vnet.view', 'sdn.vnet.create', 'sdn.vnet.edit', 'sdn.vnet.delete', 'sdn.vnet.firewall',
        ]
      },
      {
        id: 'role_tenant_operator',
        name: 'Tenant Operator',
        description: 'Day-to-day VM operations (start, stop, console, snapshots)',
        is_system: 1,
        color: '#2563eb',
        permissions: [
          'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
          'vm.snapshot', 'vm.migrate',
          'node.view', 'connection.view',
          'backup.view',
          'events.view', 'tasks.view',
          'alerts.view',
          'reports.view',
          'sdn.vnet.view',
        ]
      },
      {
        id: 'role_tenant_viewer',
        name: 'Tenant Viewer',
        description: 'Read-only access with console to assigned VMs',
        is_system: 1,
        color: '#6b7280',
        permissions: [
          'vm.view', 'vm.console',
          'node.view', 'connection.view',
          'backup.view',
          'events.view', 'tasks.view',
          'alerts.view',
          'reports.view',
          'sdn.vnet.view',
        ]
      },
    ]

    const insertRole = db.prepare(
      'INSERT INTO rbac_roles (id, name, description, is_system, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )

    const insertRolePerm = db.prepare(
      'INSERT INTO rbac_role_permissions (role_id, permission_id) VALUES (?, ?)'
    )

    const allPermissions = db.prepare('SELECT id FROM rbac_permissions').all() as any[]

    for (const r of roles) {
      insertRole.run(r.id, r.name, r.description, r.is_system, r.color, now, now)
      
      if (r.permissions.includes('*')) {
        // Super Admin: toutes les permissions
        for (const p of allPermissions) {
          insertRolePerm.run(r.id, p.id)
        }
      } else {
        for (const permId of r.permissions) {
          try {
            insertRolePerm.run(r.id, permId)
          } catch (e) {
            // Permission n'existe pas, ignorer
          }
        }
      }
    }
  } else {
    // Roles already exist — auto-create new MSP roles if missing (upgrade path)
    const mspRolesToCreate = [
      { id: 'role_provider_admin', name: 'Provider Admin', description: 'MSP provider: full access + manages tenant identity and OIDC', color: '#dc2626', wildcard: true },
      { id: 'role_tenant_admin', name: 'Tenant Admin', description: 'Full VM and backup administration within tenant scope', color: '#ea580c', wildcard: false },
      { id: 'role_tenant_operator', name: 'Tenant Operator', description: 'Day-to-day VM operations (start, stop, console, snapshots)', color: '#2563eb', wildcard: false },
      { id: 'role_tenant_viewer', name: 'Tenant Viewer', description: 'Read-only access with console to assigned VMs', color: '#6b7280', wildcard: false },
    ]
    const insertMspRole = db.prepare(
      'INSERT OR IGNORE INTO rbac_roles (id, name, description, is_system, color, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)'
    )
    const migNow = new Date().toISOString()
    for (const mr of mspRolesToCreate) {
      insertMspRole.run(mr.id, mr.name, mr.description, mr.color, migNow, migNow)
    }

    // Ensure wildcard roles have all permissions (covers newly added ones)
    const wildcardRoles = db.prepare("SELECT id FROM rbac_roles WHERE id IN ('role_super_admin', 'role_provider_admin')").all() as any[]
    if (wildcardRoles.length > 0) {
      const allPerms = db.prepare('SELECT id FROM rbac_permissions').all() as any[]
      const insertRolePerm = db.prepare(
        'INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_id) VALUES (?, ?)'
      )
      for (const wr of wildcardRoles) {
        for (const p of allPerms) {
          insertRolePerm.run(wr.id, p.id)
        }
      }
    }
  }

  // ========================================
  // Auto-migration: ensure system roles have up-to-date permissions
  // (covers permissions added in newer versions)
  // ========================================
  try {
    const rolePermMap: Record<string, string[]> = {
      role_operator: [
        'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
        'vm.snapshot', 'vm.backup',
        'node.view', 'node.console', 'connection.view', 'backup.view',
        'events.view', 'tasks.view', 'alerts.view', 'automation.view', 'reports.view'
      ],
      role_vm_admin: [
        'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
        'vm.snapshot', 'vm.backup', 'vm.clone', 'vm.migrate', 'vm.config', 'vm.delete', 'vm.create',
        'storage.view', 'storage.content', 'storage.upload',
        'node.view', 'node.console', 'node.manage', 'connection.view',
        'backup.view', 'backup.restore',
        'events.view', 'tasks.view', 'storage.admin',
        'alerts.view', 'alerts.manage', 'automation.view', 'automation.manage', 'reports.view'
      ],
      role_viewer: [
        'vm.view', 'node.view', 'connection.view', 'storage.view', 'backup.view',
        'events.view', 'alerts.view', 'automation.view', 'reports.view', 'tasks.view'
      ],
      role_vm_user: [
        'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart'
      ],
      role_tenant_admin: [
        'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
        'vm.snapshot', 'vm.backup', 'vm.clone', 'vm.migrate', 'vm.config', 'vm.delete', 'vm.create',
        'node.view', 'connection.view',
        'backup.view', 'backup.restore', 'backup.delete',
        'backup.job.view', 'backup.job.create', 'backup.job.edit', 'backup.job.delete', 'backup.job.run',
        'admin.users', 'admin.rbac', 'admin.settings', 'admin.audit',
        'alerts.view', 'alerts.manage',
        'sdn.vnet.view', 'sdn.vnet.create', 'sdn.vnet.edit', 'sdn.vnet.delete', 'sdn.vnet.firewall',
      ],
      role_tenant_operator: [
        'vm.view', 'vm.console', 'vm.start', 'vm.stop', 'vm.restart', 'vm.suspend',
        'vm.snapshot', 'vm.migrate',
        'storage.view',
        'node.view', 'connection.view',
        'backup.view',
        'events.view', 'tasks.view',
        'alerts.view',
        'reports.view',
        'sdn.vnet.view',
      ],
      role_tenant_viewer: [
        'vm.view', 'vm.console',
        'storage.view',
        'node.view', 'connection.view',
        'backup.view',
        'events.view', 'tasks.view',
        'alerts.view',
        'reports.view',
        'sdn.vnet.view',
      ],
    }
    const insertOrIgnoreRolePerm = db.prepare(
      'INSERT OR IGNORE INTO rbac_role_permissions (role_id, permission_id) VALUES (?, ?)'
    )
    for (const [roleId, perms] of Object.entries(rolePermMap)) {
      const role = db.prepare('SELECT id FROM rbac_roles WHERE id = ?').get(roleId) as any
      if (role) {
        for (const perm of perms) {
          insertOrIgnoreRolePerm.run(roleId, perm)
        }
      }
    }
  } catch {}

  // ========================================
  // Auto-migration: assign role_super_admin to legacy admins
  // ========================================
  try {
    const legacyAdmins = db.prepare(
      "SELECT id FROM users WHERE role IN ('admin', 'super_admin')"
    ).all() as any[]

    const checkExisting = db.prepare(
      "SELECT 1 FROM rbac_user_roles WHERE user_id = ? AND role_id = 'role_super_admin' AND tenant_id = 'default'"
    )
    const insertUserRole = db.prepare(
      "INSERT INTO rbac_user_roles (id, user_id, role_id, scope_type, scope_target, tenant_id, granted_at) VALUES (?, ?, 'role_super_admin', 'global', NULL, 'default', ?)"
    )

    const migrationNow = new Date().toISOString()

    for (const admin of legacyAdmins) {
      const existing = checkExisting.get(admin.id)

      if (!existing) {
        insertUserRole.run(crypto.randomUUID(), admin.id, migrationNow)
      }
    }
  } catch (e) {
    // Migration error is non-critical for existing installs without RBAC tables yet
  }

  return db
}