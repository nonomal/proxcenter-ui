# ProxCenter v1.4.0

**MSP / IaaS release: vDC cockpit, native IPAM, multi-tenant PBS, Postgres cutover.**

## Breaking change: SQLite to PostgreSQL

ProxCenter v1.4.0 drops SQLite and requires PostgreSQL. **No automatic data migration ships with this release.** Upgrading starts on an empty Postgres.

**Why this change.** SQLite's single-writer model produced visible lock contention as soon as multi-tenant workloads, vDC quotas, replication metadata, and the report generator's per-tenant queries kicked in concurrently. PostgreSQL removes those locks, scales to the cross-tenant aggregations and JSONB queries we now rely on, and unlocks the next milestone: ProxCenter running in HA with PostgreSQL streaming replication and a shared cluster store between frontend and orchestrator.

## Headline feature: MSP / IaaS with vDC

ProxCenter becomes an MSP-ready IaaS surface. Tenants get a cloud-style abstraction (no node or cluster details) backed by per-tenant resource pools.

- **vDC tenant cockpit** (`/my-vdc`) with live consumption, donut quotas (CPU, RAM, Storage, Snapshots, Backups), datacenter map, Green KPIs.
- **Cloud-style deploy flow** with quota enforcement on every step (template, ISO, clone, qmrestore). Foreign nodes, storages, bridges refused upfront.
- **Native IPAM** at the vDC level: SDN VNet/subnet management, automatic IP and MAC reservation on deploy/clone/restore, PVE pool scan to merge externally created VMs.
- **Per-vDC PBS bindings** with auto-provisioning of namespace, sub-token, ACL, and PVE storage. Manual mode also supported.
- **Tenant restore from PBS** (overwrite source or restore as new VM into the tenant pool).
- **Tenant-scoped PVE backup jobs** with structured schedule picker, Verify/Delete actions.
- **Datacenters, country, Green configuration**: per-datacenter assignments tree, country flags, Green factors per node.
- **Tenant-scoped reports** (alerts, capacity, compliance, inventory, security, site recovery, utilization). New vDC report type gated to super-admin. Rendered via WeasyPrint sidecar with per-tenant white-label.

