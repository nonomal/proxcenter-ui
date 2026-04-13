# MSP IaaS — vDC SDN VNets (Design Spec)

**Date:** 2026-04-13
**Status:** Design approved, implementation not started
**Scope:** Réseau self-service par vDC via Proxmox SDN VXLAN. Couvre les Phases 4a, 4b, 4c du chantier MSP-IaaS (après Phases 1-3: foundation, inventory filtering, quota enforcement).
**Worktree:** `/root/saas/proxcenter-frontend-msp-iaas/` (branche `feature/msp-iaas`)

---

## 1. Objectif

Permettre à chaque tenant, via son vDC, de gérer en autonomie ses réseaux L2 isolés (VNets), avec accès contrôlé aux bridges "uplinks" exposés par le super admin pour le trafic nord/sud. Le tenant doit pouvoir:

- Créer/supprimer autant de VNets que son quota le permet.
- Attacher les NICs de ses VMs/LXC uniquement à ses VNets + aux bridges partagés que le super admin lui a autorisés.
- Optionnellement, déployer sa propre VM firewall (OPNsense/pfSense/…) pour gérer son trafic N/S.
- Optionnellement, configurer le firewall PVE directement au niveau VNet sans passer par une VM firewall tiers.

Le super admin reste garant de l'infrastructure physique (uplinks, routage ISP) et décide quels bridges sont exposés à quel vDC.

---

## 2. Contexte

### 2.1 État actuel (référence)

- Phase 1 (plan écrit, pas mergé): tables `vdcs`, `vdc_nodes`, `vdc_storages`, `vdc_quotas`, `vdc_usage_cache`; pool PVE auto-créé par vDC; 4 rôles MSP (`role_provider_admin`, `role_tenant_admin`, `role_tenant_operator`, `role_tenant_viewer`); admin UI `VdcTab` dans Settings.
- Phase 2 (plan écrit): filtrage inventaire par vDC (`src/lib/vdc/scope.ts` avec `VdcScope { connectionIds, nodesByConnection, storagesByConnection, poolsByConnection }`).
- Phase 3 (plan écrit): enforcement quotas CPU/RAM/Storage/VM + auto-assignation du pool PVE (`src/lib/vdc/quota.ts`).
- Sélection réseau VM/LXC: `CreateVmDialog`, `CreateLxcDialog`, `AddNetworkDialog`, `EditNetworkDialog` lisent `GET /api/v1/connections/{id}/nodes/{node}/network` puis filtrent `type=bridge|OVSBridge`. Aucune notion SDN.

### 2.2 Décisions d'architecture validées en brainstorming (2026-04-13)

| # | Décision |
|---|---|
| 1 | Self-service VNet par tenant, borné par quota `max_vnets`. |
| 2 | Une zone VXLAN **par vDC** (isolation configuration maximale, cascade delete propre, pas de pool VNI global à maintenir). |
| 3 | Zone créée/détruite automatiquement au cycle de vie du vDC (hook dans `createVdc` / `deleteVdc` de Phase 1). |
| 4 | Egress (trafic N/S) via **bridges autorisés par vDC** (table `vdc_shared_bridges`), cochés par le super admin. ProxCenter ne gère pas l'allocation IP ni BGP; c'est l'admin PVE qui pose `vmbr-pub.NNN` en amont. |
| 5 | VNet L2 pur: **pas d'IPAM SDN**, pas de subnets, pas de DHCP SDN. Le tenant gère IP/DHCP/gateway dans sa VM firewall. |
| 6 | Parité complète VM/LXC. |
| 7 | Quota `max_vnets` ajouté à `vdc_quotas`. |
| 8 | **UI complète** CRUD règles firewall VNet incluse dans le MVP (isolée en Phase 4c). |
| 9 | Nommage VNet: saisie tenant directe, regex `^[a-z][a-z0-9]{0,14}$`, unique dans la zone. Zone: nom généré cluster-unique (voir §4.4), stocké dans `vdcs.sdn_zone_name`. |
| 10 | Tenant UI: nouvelle page dédiée `/dashboard/my-vdc`. |

### 2.3 Out of scope

- EVPN (zone type, BGP controllers, exit-nodes, gateway anycast)
- Subnets SDN + IPAM + DHCP SDN
- Cloud-init integration pour allocation IP auto
- Plugins DNS (Netbox, PowerDNS)
- Métriques par VNet (flows, bandwidth)
- Multi-site / federated SDN
- Outils de migration pour VMs legacy attachées à `vmbr0` (traitées au cas par cas manuellement ou dans une phase future)

---

## 3. Modèle topologique

### 3.1 Vue logique

```
[VM tenant "app-web01" 10.1.0.42]
    │ default route → 10.1.0.1
    ▼
[vnet: prodlan, VNI 10001] ─── overlay VXLAN dans zone zacmeprod ───
    │
    ▼ (arrive sur le node hébergeant la VM firewall tenant)
[VM tenant "fw-acme" LAN = 10.1.0.1]
    │ NAT outbound vers WAN
    ▼
[VM tenant "fw-acme" WAN = 203.0.113.25] ── sur vmbr-pub.100 (bridge partagé autorisé)
    │
    ▼ (VLAN 100 tagué sur uplink physique du node)
[Firewall tiers du provider / Router ISP]
    │
    ▼
  Internet
```

### 3.2 Responsabilités

| Acteur | Responsabilité |
|---|---|
| Super admin (ProxCenter) | Crée le vDC, coche les bridges partagés autorisés, définit `max_vnets`. |
| Super admin (hors ProxCenter) | Pose `vmbr-pub.NNN` sur chaque node (via PVE classique ou Ansible), coordonne routage ISP. |
| Tenant admin (ProxCenter) | Crée VNets dans la zone de son vDC, attache NICs de VMs aux VNets privés + aux bridges partagés autorisés, configure règles firewall VNet si besoin. |
| Tenant admin (hors ProxCenter) | Configure sa VM firewall (IPs, NAT, DHCP, règles N/S, VPN). |

---

## 4. Modèle de données

### 4.1 Nouvelles tables SQLite

```sql
-- Bridges "uplinks" autorisés par vDC (configuré par super admin)
CREATE TABLE vdc_shared_bridges (
  id         TEXT PRIMARY KEY,
  vdc_id     TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
  bridge     TEXT NOT NULL,         -- ex: 'vmbr-pub.100', 'vmbr0'
  label      TEXT,                  -- libellé documentaire affiché au tenant
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(vdc_id, bridge)
);
CREATE INDEX idx_vdc_shared_bridges_vdc ON vdc_shared_bridges(vdc_id);

-- Miroir local des VNets (source de vérité réelle dans /etc/pve/sdn/vnets.cfg)
-- Utilisé pour: tracking quota, métadonnées tenant, audit, perf reads
CREATE TABLE vdc_vnets (
  id          TEXT PRIMARY KEY,
  vdc_id      TEXT NOT NULL REFERENCES vdcs(id) ON DELETE CASCADE,
  pve_name    TEXT NOT NULL,        -- saisi par le tenant, regex ^[a-z][a-z0-9]{0,14}$
  description TEXT,                 -- texte libre ProxCenter-only
  vxlan_tag   INTEGER NOT NULL,     -- VNI alloué dans la zone, unique par vDC
  firewall    INTEGER DEFAULT 1,    -- miroir de vnet.firewall côté PVE
  created_by  TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(vdc_id, pve_name),
  UNIQUE(vdc_id, vxlan_tag)
);
CREATE INDEX idx_vdc_vnets_vdc ON vdc_vnets(vdc_id);
```

### 4.2 Modification de `vdc_quotas`

```sql
ALTER TABLE vdc_quotas ADD COLUMN max_vnets INTEGER;
```

Null = illimité. Valeur recommandée par défaut proposée dans l'UI admin: 16.

### 4.3 Modification de `vdcs`

```sql
ALTER TABLE vdcs ADD COLUMN sdn_zone_name TEXT;
CREATE UNIQUE INDEX idx_vdcs_sdn_zone_name ON vdcs(connection_id, sdn_zone_name);
```

Stocke le nom PVE de la zone SDN. Contrainte d'unicité par `connection_id` (les zones sont cluster-wide, donc uniques par connexion PVE). Null pour les vDCs créés avant Phase 4a (backfill via script, §12.1).

### 4.4 Nouvelles permissions RBAC (seed)

```
sdn.vnet.view       # lister VNets, voir quotas/bridges partagés
sdn.vnet.create     # POST /api/v1/vdcs/{id}/vnets
sdn.vnet.edit       # PUT (description, firewall toggle)
sdn.vnet.delete     # DELETE VNet (vérifie 0 NIC attachée)
sdn.vnet.firewall   # CRUD règles firewall VNet + IPSets/aliases locaux
```

Attribution par rôle:

| Rôle | sdn.vnet.view | create | edit | delete | firewall |
|---|---|---|---|---|---|
| super_admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| provider_admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| tenant_admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| tenant_operator | ✓ | | | | |
| tenant_viewer | ✓ | | | | |

---

## 5. Mapping PVE SDN

### 5.1 Ressources PVE gérées par ProxCenter

| Ressource PVE | Créée par | Nommage | Scope |
|---|---|---|---|
| Zone VXLAN | ProxCenter (au `createVdc`) | Nom généré `generateZoneName()`, stocké dans `vdcs.sdn_zone_name`. Voir §5.3. Respecte regex PVE `^[a-z][a-z0-9]*$`, max 15 chars. | 1 par vDC |
| VNet | ProxCenter (tenant via API) | saisi tenant, regex `^[a-z][a-z0-9]{0,14}$`, unique dans la zone | N par zone |
| Firewall VNet toggle | ProxCenter (tenant) | N/A | 1 par VNet |
| Firewall VNet rules | ProxCenter (tenant) | `pos` géré PVE | N par VNet |
| Firewall VNet IPSets | ProxCenter (tenant) | saisi tenant | N par VNet |
| Firewall VNet aliases | ProxCenter (tenant) | saisi tenant | N par VNet |

### 5.2 Ressources PVE **hors scope** ProxCenter

| Ressource | Gérée par |
|---|---|
| Bridges physiques (`vmbr-pub`, `vmbr0`, sub-interfaces VLAN) | Admin PVE via `/etc/network/interfaces` ou Ansible |
| Routage ISP | Admin réseau provider |
| Controllers BGP/EVPN | Hors scope |
| Subnets SDN / IPAM | Hors scope (Phase future) |

### 5.3 Génération du nom de zone

```ts
// src/lib/vdc/sdn.ts
function stripSlug(slug: string): string {
  return slug.replace(/-/g, '').slice(0, 14)  // max 14 après préfixe 'z'
}

export async function generateZoneName(vdc: Vdc, connectionId: string): Promise<string> {
  const base = 'z' + stripSlug(vdc.slug)     // ex: 'zacmeprod'
  // Check cluster-wide uniqueness (cluster = connection)
  const existing = db.prepare(
    `SELECT sdn_zone_name FROM vdcs
     WHERE connection_id = ? AND sdn_zone_name = ?`
  ).get(connectionId, base)
  if (!existing) return base

  // Collision: suffix with 2 hex chars from sha1(vdc.id)
  const hash = crypto.createHash('sha1').update(vdc.id).digest('hex').slice(0, 2)
  const withSuffix = ('z' + stripSlug(vdc.slug).slice(0, 12) + hash)
  // Retry check (rare): if still collides, bubble error — admin changes slug.
  const collision2 = db.prepare(
    `SELECT sdn_zone_name FROM vdcs
     WHERE connection_id = ? AND sdn_zone_name = ?`
  ).get(connectionId, withSuffix)
  if (collision2) throw new Error(`Cannot generate unique zone name for vDC ${vdc.id}`)
  return withSuffix
}
```

Appelé une fois au `createVdc()`, le résultat est persisté dans `vdcs.sdn_zone_name`. Toutes les opérations SDN ultérieures (VNet CRUD, delete) lisent cette colonne plutôt que de recalculer.

### 5.4 Endpoints PVE API consommés

| Verbe | Chemin | Usage |
|---|---|---|
| POST | `/cluster/sdn/zones` | Créer zone VXLAN à la création du vDC |
| DELETE | `/cluster/sdn/zones/{zone}` | Supprimer zone à la suppression du vDC |
| POST | `/cluster/sdn/vnets` | Créer VNet |
| PUT | `/cluster/sdn/vnets/{vnet}` | Modifier firewall toggle ou alias |
| DELETE | `/cluster/sdn/vnets/{vnet}` | Supprimer VNet |
| GET | `/cluster/sdn/vnets` | Lister (pour reconcile on-read) |
| GET | `/cluster/sdn/zones` | Lister zones (pour calcul "uplinks disponibles", exclus SDN) |
| PUT | `/cluster/sdn` | **Apply** (déclenche ifreload sur chaque node) |
| CRUD | `/cluster/sdn/vnets/{vnet}/firewall/rules` | Règles firewall VNet |
| CRUD | `/cluster/sdn/vnets/{vnet}/firewall/ipset` | IPSets locaux |
| CRUD | `/cluster/sdn/vnets/{vnet}/firewall/aliases` | Aliases locaux |
| GET | `/nodes/{node}/network` | Détection bridges physiques (existant) |
| GET | `/cluster/resources?type=vm` | Vérifier aucune VM/NIC attachée avant delete VNet |

---

## 6. Architecture applicative

### 6.1 Nouveau module `src/lib/vdc/sdn.ts`

Helpers purs autour de l'API PVE SDN, découplés du HTTP entrant:

```ts
export interface SdnZone {
  zone: string
  type: 'vxlan'
  peers: string[]         // cluster node IPs
}

export interface SdnVnet {
  vnet: string
  zone: string
  tag: number             // VNI
  firewall: 0 | 1
}

export async function createZone(vdc: Vdc, conn: Connection): Promise<void>
export async function deleteZone(vdc: Vdc, conn: Connection): Promise<void>
export async function createVnet(vdc: Vdc, conn: Connection, input: CreateVnetInput): Promise<SdnVnet>
export async function updateVnet(vdc: Vdc, conn: Connection, name: string, patch: Partial<SdnVnet>): Promise<void>
export async function deleteVnet(vdc: Vdc, conn: Connection, name: string): Promise<void>
export async function listVnets(vdc: Vdc, conn: Connection): Promise<SdnVnet[]>
export async function allocateVni(vdcId: string): Promise<number>  // max(tag)+1, start 10000
export async function applySdn(conn: Connection): Promise<void>    // PUT /cluster/sdn
export async function reconcileVnets(vdc: Vdc, conn: Connection): Promise<void>  // sync DB ↔ PVE
export async function countVnetAttachments(conn: Connection, vnetName: string): Promise<number>
```

### 6.2 Extensions de modules existants

| Module | Changement |
|---|---|
| `src/lib/vdc/index.ts` (Phase 1) | `createVdc()` appelle `createZone()` après pool. `deleteVdc()` appelle `deleteVnet()` pour chaque vnet puis `deleteZone()` avant de supprimer la row DB. Ajoute `listVdcs()` join pour exposer `sharedBridges` et count `vnets`. |
| `src/lib/vdc/scope.ts` (Phase 2) | `VdcScope` gagne `vnetsByConnection: Map<string, Set<string>>` et `sharedBridgesByConnection: Map<string, Set<string>>`. `applyVdcFilter()` inchangé. |
| `src/lib/vdc/quota.ts` (Phase 3) | `QuotaCheckResult` inchangé. Ajout d'un check `checkVnetQuota(tenantId, connectionId)` appelé par `POST /api/v1/vdcs/{id}/vnets`. |
| `src/lib/db/sqlite.ts` | Seed des 5 permissions `sdn.vnet.*`, des tables `vdc_shared_bridges` et `vdc_vnets`, de la colonne `max_vnets`. |

### 6.3 Nouvelles routes API

**Admin-scoped:**

| Route | Méthode | Permission | Usage |
|---|---|---|---|
| `/api/v1/admin/connections/{id}/provider-bridges` | GET | `ADMIN_SETTINGS` | Liste bridges physiques détectés sur le cluster (pour UI admin bridges partagés) |
| `/api/v1/admin/vdcs/{id}/shared-bridges` | GET, PUT | `ADMIN_SETTINGS` | Lister / remplacer la liste des bridges partagés d'un vDC |

**Tenant-scoped:**

| Route | Méthode | Permission | Usage |
|---|---|---|---|
| `/api/v1/vdcs/{id}/vnets` | GET | `sdn.vnet.view` | Liste VNets du vDC (reconcile on-read) |
| `/api/v1/vdcs/{id}/vnets` | POST | `sdn.vnet.create` | Crée VNet: quota + PVE + DB |
| `/api/v1/vdcs/{id}/vnets/{pve_name}` | GET | `sdn.vnet.view` | Détail VNet |
| `/api/v1/vdcs/{id}/vnets/{pve_name}` | PUT | `sdn.vnet.edit` | Modifie description / firewall toggle |
| `/api/v1/vdcs/{id}/vnets/{pve_name}` | DELETE | `sdn.vnet.delete` | Supprime: check 0 NIC + PVE + DB |
| `/api/v1/vdcs/{id}/shared-bridges` | GET | `sdn.vnet.view` | Read-only, bridges partagés autorisés |
| `/api/v1/vdcs/{id}/vnets/{pve_name}/firewall` | GET, PUT | `sdn.vnet.firewall` | Toggle + métadonnées |
| `/api/v1/vdcs/{id}/vnets/{pve_name}/firewall/rules` | GET, POST | `sdn.vnet.firewall` | Règles |
| `/api/v1/vdcs/{id}/vnets/{pve_name}/firewall/rules/{pos}` | GET, PUT, DELETE | `sdn.vnet.firewall` | |
| `/api/v1/vdcs/{id}/vnets/{pve_name}/firewall/rules/reorder` | POST | `sdn.vnet.firewall` | Drag-and-drop |
| `/api/v1/vdcs/{id}/vnets/{pve_name}/firewall/ipsets` | GET, POST | `sdn.vnet.firewall` | |
| `/api/v1/vdcs/{id}/vnets/{pve_name}/firewall/ipsets/{name}` | GET, DELETE | `sdn.vnet.firewall` | Avec sub-routes `/cidr` |
| `/api/v1/vdcs/{id}/vnets/{pve_name}/firewall/aliases` | GET, POST | `sdn.vnet.firewall` | |
| `/api/v1/vdcs/{id}/vnets/{pve_name}/firewall/aliases/{name}` | GET, PUT, DELETE | `sdn.vnet.firewall` | |

**Picker bridge unifié (appelé par tous les dialogs VM/LXC):**

| Route | Méthode | Permission | Usage |
|---|---|---|---|
| `/api/v1/connections/{id}/network-choices?node={node}` | GET | `VM_VIEW` | Liste unifiée `{ kind: 'vnet' \| 'shared', name, label?, vdc?, zone? }`, filtrée par `VdcScope` du tenant courant |

### 6.4 Nouvelles pages frontend

| Page | Rôle |
|---|---|
| `src/app/(dashboard)/my-vdc/page.tsx` | Page tenant "Mon vDC": sélecteur vDC, overview, uplinks read-only, CRUD VNets, bouton vers onglet firewall |
| `src/components/mydc/VnetList.tsx` | DataGrid VNets + actions |
| `src/components/mydc/VnetCreateDialog.tsx` | Dialog de création (name, description, firewall toggle) |
| `src/components/mydc/VnetEditDialog.tsx` | Dialog d'édition |
| `src/components/mydc/VnetFirewallPanel.tsx` | Onglet firewall complet (rules + ipsets + aliases) |
| `src/components/mydc/FirewallRuleDialog.tsx` | Dialog add/edit rule |
| `src/components/mydc/SharedBridgesPanel.tsx` | Read-only panel uplinks |
| `src/components/settings/VdcTab.tsx` (étendu) | Ajoute section "Shared bridges" dans dialog Create/Edit vDC + champ `max_vnets` |

### 6.5 Modifications des dialogs existants

| Fichier | Changement |
|---|---|
| `src/app/(dashboard)/infrastructure/inventory/CreateVmDialog.tsx` | `loadBridges()` remplacé par `loadNetworkChoices()` qui appelle `/network-choices`. Le `Select` de bridge affiche les VNets et bridges partagés avec un sous-header (groupe). |
| `src/app/(dashboard)/infrastructure/inventory/CreateLxcDialog.tsx` | Idem. |
| `src/components/hardware/AddNetworkDialog.tsx` | Idem. |
| `src/components/hardware/EditNetworkDialog.tsx` | Idem. |

### 6.6 Navigation

`src/components/layout/vertical/Navigation.jsx`: ajout d'un item "Mon vDC" (i18n key `nav.myVdc`), visible si:
- `hasFeature(Features.MULTI_TENANCY)` ET
- `!isSuperAdmin` (le super admin gère via `VdcTab` admin) ET
- Le tenant courant a au moins un vDC (`GET /api/v1/vdcs` retourne ≥1 résultat — déjà exposé en Phase 2)

---

## 7. Flows de référence

### 7.1 Création d'un vDC par super admin

```
1. POST /api/v1/admin/vdcs { name, slug, tenantId, connectionId,
                             nodes, storages, quotas { max_vnets: 16 },
                             sharedBridges: ['vmbr-pub.100'] }
2. createVdc():
   a. BEGIN TRANSACTION
   b. INSERT INTO vdcs, vdc_nodes, vdc_storages, vdc_quotas, vdc_usage_cache
   c. INSERT INTO vdc_shared_bridges (une ligne par bridge)
   d. POST /pools { poolid: 'vdc-acme-prod' }          (existing P1)
   e. sdn.createZone(vdc, conn) → POST /cluster/sdn/zones
   f. applySdn(conn) → PUT /cluster/sdn
   g. COMMIT
3. Si (d), (e) ou (f) échoue: rollback cascade:
   - delete zone si créée
   - delete pool si créé
   - ROLLBACK DB
```

### 7.2 Création d'un VNet par tenant

```
1. Tenant clique "+ Créer un VNet" dans /dashboard/my-vdc
2. Submit → POST /api/v1/vdcs/{vdcId}/vnets
   { pve_name: 'prodlan', description: 'Production LAN', firewall: true }
3. Route:
   a. resolveVdcForTenant(tenantId, connectionId, null) — retourne vdc, throw si mismatch
   b. checkVnetQuota(vdcId): SELECT COUNT(*) FROM vdc_vnets WHERE vdc_id=?
      if count >= quota.max_vnets → 409
   c. Validate regex pve_name
   d. SELECT 1 FROM vdc_vnets WHERE vdc_id=? AND pve_name=? → 409 si exists
   e. tag = allocateVni(vdcId) = max(vxlan_tag)+1, initial 10000
   f. POST /cluster/sdn/vnets { vnet: 'prodlan', zone: 'zacmeprod', tag, firewall: 1 }
   g. PUT /cluster/sdn (apply)
   h. INSERT INTO vdc_vnets
   i. Audit log
4. Rollback: si (f) échoue → DB non écrit, réponse 502. Si (h) échoue après (f) → delete VNet PVE avant 500.
```

### 7.3 Attachement d'un VNet à une NIC de VM

```
1. Tenant ouvre CreateVmDialog, sélectionne connection + node
2. Dialog appelle GET /api/v1/connections/{id}/network-choices?node=nodeX
   Retourne:
   [
     { kind: 'vnet',   name: 'prodlan', vdc: 'acme-prod', zone: 'zacmeprod' },
     { kind: 'vnet',   name: 'dmz',     vdc: 'acme-prod', zone: 'zacmeprod' },
     { kind: 'shared', name: 'vmbr-pub.100', label: 'WAN /29 - 203.0.113.24/29' },
   ]
3. Tenant choisit 'prodlan', submit.
4. POST /api/v1/connections/{id}/guests/qemu/{node} { net0: 'virtio,bridge=prodlan,firewall=1', ... }
5. Route (Phase 3 existant) check quota CPU/RAM, PUIS nouvelle validation:
   a. Parse chaque netN.bridge
   b. Pour chaque bridge: GET /network-choices pour même tenant+connection
   c. Si bridge ∉ ensemble autorisé → 403 "Bridge 'xxx' not authorized for this vDC"
6. pveFetch POST /nodes/{node}/qemu { ..., pool: 'vdc-acme-prod' }
```

### 7.4 Suppression d'un VNet

```
1. DELETE /api/v1/vdcs/{id}/vnets/prodlan
2. Route:
   a. resolveVdcForTenant
   b. countVnetAttachments(conn, 'prodlan'):
      GET /cluster/resources?type=vm → for each VM, parse netN → count matches
      + GET /cluster/resources?type=lxc → idem (netN est `net0: name=eth0,bridge=prodlan,...`)
   c. Si count > 0 → 409 "VNet is in use by N VM/LXC NIC(s)"
   d. DELETE /cluster/sdn/vnets/prodlan
   e. PUT /cluster/sdn (apply)
   f. DELETE FROM vdc_vnets WHERE vdc_id=? AND pve_name='prodlan'
```

### 7.5 Ajout d'une règle firewall VNet

```
1. Tenant ouvre VnetFirewallPanel, clique "+ Add rule"
2. Dialog → POST /api/v1/vdcs/{id}/vnets/prodlan/firewall/rules
   { type: 'in', action: 'ACCEPT', proto: 'tcp', dport: '80,443', enable: 1, comment: 'web' }
3. Route:
   a. resolveVdcForTenant
   b. POST /cluster/sdn/vnets/prodlan/firewall/rules (pve-proxy, passthrough)
   c. PUT /cluster/sdn (apply, pour propager les règles)
   d. Audit log
```

---

## 8. Gestion d'erreur & cohérence

### 8.1 Principes

- **Transactions DB atomiques** pour les opérations multi-rows.
- **Rollback PVE** si écriture DB échoue après création PVE: `DELETE /cluster/sdn/vnets/{name}` + apply.
- **Pas de rollback PVE** si `PUT /cluster/sdn` (apply) échoue — l'état config est cohérent dans `/etc/pve/sdn/*.cfg`, seulement les nodes ne sont pas reload. Log + endpoint admin `/api/v1/admin/sdn/apply` permet retry manuel.
- **Reconcile on-read**: `GET /api/v1/vdcs/{id}/vnets` appelle `reconcileVnets()` qui compare `vdc_vnets` DB avec PVE `/cluster/sdn/vnets`. Dérive (ex: vnet supprimé à la main via `pvesh`) → DELETE DB row correspondante. Nouveaux VNets PVE sans row DB → WARN log (orphan), pas d'INSERT auto (sécurité: seul ProxCenter doit créer des VNets via l'API).

### 8.2 Mapping erreurs PVE → HTTP

| Erreur PVE | Status | Payload |
|---|---|---|
| 400 invalid vnet name | 400 | `{ error: 'Invalid VNet name', details }` |
| 400 invalid tag | 500 | (ProxCenter alloue le tag, ne devrait pas arriver; log + retry allocation) |
| 409 vnet already exists | 409 | `{ error: 'VNet name already in use' }` |
| 404 zone not found | 500 | (cohérence: zone devrait toujours exister au moment du POST vnet; log + warning) |
| 500 autre | 502 | `{ error: 'PVE upstream error', details }` |

### 8.3 Quotas dépassés

- `max_vnets` atteint: 409 `{ error: 'Quota exceeded: max_vnets', current: 16, max: 16 }`
- Quota CPU/RAM (Phase 3) reste inchangé; le VNet n'a pas de coût CPU/RAM propre.

### 8.4 Dérive & cleanup

- **Job manuel admin** `POST /api/v1/admin/vdcs/{id}/sdn-reconcile`: parcourt tous les VNets en DB, vérifie PVE, recrée les manquants. À exécuter si dérive suspectée.
- **Suppression vDC avec VNets encore actifs**: `deleteVdc()` supprime d'abord tous les VNets (cascade PVE), puis la zone, puis la row vDC (qui cascade DB sur `vdc_vnets` et `vdc_shared_bridges`).

---

## 9. Découpage en phases

### 9.1 Phase 4a — Foundation SDN (admin only)

**Livrables:**
- Migration DB: nouvelles tables + `max_vnets`.
- Seed permissions `sdn.vnet.*`.
- Lib `src/lib/vdc/sdn.ts` complète (zone/vnet CRUD, apply, reconcile, allocateVni, countAttachments).
- Hook dans `createVdc()` / `deleteVdc()` (Phase 1) pour zone.
- Extension `VdcScope` (Phase 2) avec `vnetsByConnection` + `sharedBridgesByConnection`.
- Admin UI: `VdcTab` gagne section "Shared bridges" + champ `max_vnets` dans le dialog Create/Edit.
- Endpoint `GET /api/v1/admin/connections/{id}/provider-bridges` (détection bridges physiques, exclusion SDN).
- Endpoint `GET/PUT /api/v1/admin/vdcs/{id}/shared-bridges`.
- i18n EN + FR (admin labels).

**Critère d'acceptation:** super admin crée un vDC via l'UI, la zone VXLAN apparaît dans `pvesh get /cluster/sdn/zones`; supprime le vDC, la zone disparaît. Les bridges partagés cochés sont persistés. Pas d'impact côté tenant (aucune UI tenant nouvelle).

**Estimation:** ~7-8 tâches, plan ~400 lignes.

### 9.2 Phase 4b — Tenant self-service VNet

**Livrables:**
- Page `/dashboard/my-vdc` avec: sélecteur vDC (si tenant multi-vDC), overview, uplinks read-only, liste VNets, dialogs create/edit/delete.
- Routes tenant `/api/v1/vdcs/{id}/vnets/*` (sans firewall sub-routes).
- Route `/api/v1/vdcs/{id}/shared-bridges` (read-only tenant).
- Route unifiée `/api/v1/connections/{id}/network-choices` consommée par tous les dialogs VM/LXC.
- Enforcement serveur dans `POST /guests/[type]/[node]/route.ts`, `/clone/route.ts`, `/config/route.ts`: validation bridge ∈ choix autorisés.
- Intégration `CreateVmDialog`, `CreateLxcDialog`, `AddNetworkDialog`, `EditNetworkDialog`.
- Item sidebar "Mon vDC".
- i18n EN + FR (tenant labels).

**Critère d'acceptation:**
1. Tenant_admin crée 2 VNets via l'UI.
2. Crée 1 VM attachée au premier VNet, 1 VM attachée au second.
3. Les deux VMs ne peuvent pas se ping (VNI différents, pas de gateway entre elles).
4. Quota `max_vnets=2`: création du 3e VNet retourne 409.
5. Tentative (via curl bypass) d'attacher une NIC sur un bridge hors scope retourne 403.

**Estimation:** ~10-12 tâches, plan ~600 lignes.

### 9.3 Phase 4c — Firewall VNet UI

**Livrables:**
- Onglet firewall dans la fiche VNet.
- API CRUD rules + ipsets + aliases.
- Drag-and-drop reorder.
- Support macros PVE (HTTP, DNS, SMTP, …) dans le dialog rule.

**Critère d'acceptation:** tenant_admin crée une règle DROP par défaut IN + ACCEPT tcp/80,443 IN, apply, vérifie depuis une VM du VNet que seuls les ports 80/443 sont accessibles.

**Estimation:** ~8 tâches, plan ~500 lignes.

---

## 10. Testing

### 10.1 Tests unitaires (Jest)

| Lib | Cas |
|---|---|
| `sdn.ts::allocateVni` | Premier VNet = 10000, suivant = 10001, avec trou = max+1 |
| `sdn.ts::createZone/deleteZone` | Mock `pveFetch`, vérifie params POST corrects, apply appelé |
| `sdn.ts::createVnet` | Mock: PVE succès → DB écrit. PVE échec → DB non écrit. DB échec → PVE rollback. |
| `sdn.ts::reconcileVnets` | DB a VNet X pas en PVE → DELETE DB. PVE a orphan → warn, pas d'INSERT. |
| `scope.ts` (extension) | `vnetsByConnection` correctement peuplé; filtre retire les NICs non autorisées. |
| `quota.ts::checkVnetQuota` | Quota null = illimité. Quota 5, count 5 → bloqué. Count 4 → OK. |

### 10.2 Tests intégration API (`node --test`)

Requièrent un PVE de test accessible (variable `PVE_URL`):
- Create/delete zone end-to-end.
- Create VNet, list, delete.
- Create VNet puis attacher VM sur un PVE de test, vérifier que le bridge `vnet_name` existe bien sur le node (`ip link show`).
- Delete VNet avec NIC attachée → 409.

### 10.3 Tests E2E manuels (documentés dans chaque plan)

- Scénario 2 tenants isolés: tenant A crée VNet `prodlan`, tenant B crée VNet `prodlan` (même nom, zones différentes) — pas de collision.
- Scénario firewall VNet: règle DROP IN sauf 80,443 effective.

---

## 11. Considérations de performance

- **Caching `VdcScope`**: déjà prévu Phase 2 avec TTL 60s. Les ajouts `vnetsByConnection` et `sharedBridgesByConnection` s'intègrent dans la même clé de cache.
- **`network-choices` endpoint**: appelé fréquemment (chaque ouverture CreateVmDialog). Cache côté serveur 30s sur la paire (connectionId, tenantId). Invalidé au create/delete VNet.
- **Apply SDN**: `PUT /cluster/sdn` peut prendre 1-3s sur gros cluster (lance `ifreload` sur tous les nodes). Ne pas bloquer l'UI: retourner 202 Accepted avec un task id si > 5s (Phase 5, pas MVP).

---

## 12. Migration & compatibilité descendante

### 12.1 vDCs existants (Phase 1 déjà en prod)

Au déploiement de Phase 4a, les vDCs existants n'ont **pas** de zone SDN. Un script de migration (ou bouton admin "Provision SDN zone") crée la zone pour tous les vDCs existants:

```ts
// Script: scripts/migrate-sdn-zones.ts
for (const vdc of await listVdcs()) {
  if (!await zoneExists(vdc)) {
    await createZone(vdc, await getConnection(vdc.connectionId))
  }
}
await applySdn(/* each connection once */)
```

Ce script est idempotent: relancer plusieurs fois ne crée pas de doublons.

### 12.2 VMs existantes attachées à `vmbr0`

Non touchées. Elles restent sur `vmbr0` et continuent de fonctionner comme avant. Le super admin peut:
- Ajouter `vmbr0` comme `shared_bridge` du vDC pour que le tenant continue de pouvoir éditer la NIC.
- Ou demander au tenant de migrer manuellement vers un VNet (modifier `net0` via l'UI VM, reboot).

Pas de migration automatique en MVP.

### 12.3 Feature flag

Aucun feature flag. Activé pour tous les déploiements dès que Phase 4a est mergée. Retrocompatible: un tenant sans vDC voit toujours les bridges classiques (via `network-choices` qui retombe sur l'ancien chemin si `VdcScope` est null — default tenant / tenants sans vDC).

---

## 13. Décisions ouvertes (à trancher dans les plans)

- **Label UI `network-choices`**: grouping par provider (icône différente vnet vs shared) ou flat list avec badge ? À décider en Phase 4b dans la revue UI.
- **Bouton "Apply pending SDN changes"** admin en cas d'échec apply: à prévoir en Phase 4a ou différer Phase 5 ?
- **Audit log granularité**: une ligne par CRUD VNet/rule ou batchées ? À aligner avec la politique d'audit existante.

---

## 14. Références internes

- `frontend/docs/superpowers/plans/2026-04-12-msp-iaas-phase1-vdc-foundation.md` — Phase 1 (vDC data model)
- `frontend/docs/superpowers/plans/2026-04-12-msp-iaas-phase2-vdc-filtering.md` — Phase 2 (inventory filtering)
- `frontend/docs/superpowers/plans/2026-04-12-msp-iaas-phase3-quota-enforcement.md` — Phase 3 (quota enforcement)
- `frontend/src/lib/vdc/` — modules vDC (index, scope, quota, sdn à venir)
- `frontend/src/lib/proxmox/client.ts` — `pveFetch` helper utilisé par la lib SDN
- `frontend/src/lib/rbac/index.ts` — `checkPermission`, `PERMISSIONS` (à étendre avec `sdn.vnet.*`)
- PVE docs SDN: https://pve.proxmox.com/pve-docs/chapter-pvesdn
