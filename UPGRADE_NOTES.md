# Upgrade Notes — SQLite → Postgres release

This release replaces SQLite with Postgres as the sole supported
database for both the frontend (Prisma) and the orchestrator (GORM).
**No automatic data migration ships with this release.** Upgrading an
existing installation produces an empty Postgres database.

This is acceptable in practice because ProxCenter does not own
operational data — the source of truth lives in Proxmox itself, reached
through the PVE API. What ProxCenter stores is configuration: the list
of Proxmox connections, user accounts, RBAC assignments, vDC mappings,
alert rules, datacenter / green configs, dashboard layouts. Re-creating
these through the UI after the upgrade takes minutes, not hours.

## What changes

| Component | Before | After |
| --- | --- | --- |
| Frontend store | SQLite (`/app/data/proxcenter.db`) | Postgres (Prisma adapter) |
| Orchestrator store | SQLite (`/app/data/orchestrator.db`) | Postgres (shared with frontend) |
| Compose stack | `proxcenter` only | `proxcenter` + `postgres` services |
| Required env vars | — | `POSTGRES_PASSWORD` (mandatory) |
| New Docker volume | — | `postgres_data` |

The frontend image no longer ships `better-sqlite3`; the orchestrator
binary no longer links the SQLite GORM driver. There is no fallback
path back to SQLite once you boot this release.

## Upgrade procedure

### Community (script-based)

```sh
docker compose down
curl -fsSL <COMMUNITY_INSTALL_URL> | sudo bash
```

The script generates a new `.env` (with `POSTGRES_PASSWORD`), creates
the `postgres_data` volume, downloads the new compose file, and starts
the stack against an empty Postgres.

### Enterprise (upgrade flag)

```sh
docker compose down
curl -fsSL <ENTERPRISE_INSTALL_URL> | sudo bash -s -- --upgrade
docker compose up -d
```

The `--upgrade` flow:
- backs up your current `docker-compose.yml` as `docker-compose.yml.bak.<ts>`
- downloads the new compose
- backfills `POSTGRES_PASSWORD` into your existing `.env` (a fresh
  password — Postgres is empty on first boot)
- creates the `postgres_data` volume

### Manual upgrade (no script)

If you maintain your own `docker-compose.yml`:

1. Append a `postgres` service (use
   `docker-compose.community.yml` / `docker-compose.enterprise.yml`
   from this release as reference).
2. Declare `postgres_data: { name: postgres_data, external: true }` in
   `volumes`.
3. Add `POSTGRES_PASSWORD=<random>` to your `.env`.
4. Replace the frontend's `DATABASE_URL` with the Postgres form:
   ```
   DATABASE_URL=postgresql://proxcenter:${POSTGRES_PASSWORD}@postgres:5432/proxcenter?schema=public
   ```
5. `docker volume create postgres_data`
6. `docker compose up -d`

The frontend container's entrypoint runs `prisma migrate deploy` and
the idempotent seed (default tenant, RBAC permission catalogue, system
roles) on first boot. No additional bootstrap step is needed.

## After you upgrade

1. `docker compose ps` — every service should report healthy;
   `curl localhost:3000/api/health` returns `200`.
2. Open `http://<host>:3000` and complete the initial setup wizard
   (creates the first super-admin account).
3. Re-add Proxmox connections under Infrastructure → Connections.
4. Re-create RBAC roles / assignments, vDC bindings, alert rules,
   datacenter and green configs, dashboard layouts as needed. All of
   it lives in the UI.

## Why the change

Multi-tenancy, JSONB queries on tenant settings / audit logs, and the
unification of frontend + orchestrator storage all required Postgres.
SQLite served the single-host community deployment well; it stops
scaling once we add cross-tenant aggregations, vDC quotas, replication
metadata, and the report generator's per-tenant queries.

Shipping a one-shot SQLite importer would have meant carrying
`better-sqlite3` (cgo + sqlite-dev) in every release plus the support
burden on a code path used once per customer. Re-entering the
configuration through the UI is faster and cleaner.
