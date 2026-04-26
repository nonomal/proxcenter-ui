export interface Vdc {
  id: string
  tenantId: string
  connectionId: string
  name: string
  slug: string
  description: string | null
  pvePoolName: string
  sdnZoneName: string | null
  enabled: boolean
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface VdcWithDetails extends Vdc {
  tenantName?: string
  connectionName?: string
  nodes: string[]
  storages: string[]
  quota: VdcQuota | null
  usage: VdcUsage | null
  sharedBridges: VdcSharedBridge[]
  vnets: VdcVnet[]
  pbsBindings: VdcPbsBinding[]
}

export interface VdcPbsBinding {
  id: string
  vdcId: string
  pbsConnectionId: string
  pbsConnectionName: string
  datastore: string
  namespace: string
  mode: 'auto' | 'manual'
  createdAt: string
}

export interface VdcQuota {
  maxVcpus: number | null
  maxRamMb: number | null
  maxStorageMb: number | null
  maxVms: number | null
  maxSnapshots: number | null
  maxBackups: number | null
  maxVnets: number | null
}

export interface VdcUsage {
  usedVcpus: number
  usedRamMb: number
  usedStorageMb: number
  usedVms: number
  usedSnapshots: number
  usedBackups: number
  lastSyncedAt: string | null
}

export interface VdcSharedBridge {
  id: string
  vdcId: string
  bridge: string
  label: string | null
  createdAt: string
}

export interface VdcVnet {
  id: string
  vdcId: string
  pveName: string
  description: string | null
  vxlanTag: number
  firewall: boolean
  createdBy: string | null
  createdAt: string
}

// PVE-native shapes used by lib/vdc/sdn.ts
export interface SdnZone {
  zone: string
  type: 'vxlan'
  peers: string[]
}

export interface SdnVnet {
  vnet: string
  zone: string
  tag: number
  firewall: 0 | 1
}

export interface CreateVdcInput {
  tenantId: string
  connectionId: string
  name: string
  slug: string
  description?: string
  nodes: string[]
  storages: string[]
  quota?: Partial<VdcQuota>
  sharedBridges?: Array<{ bridge: string; label?: string }>
}

export interface UpdateVdcInput {
  name?: string
  description?: string
  enabled?: boolean
  nodes?: string[]
  storages?: string[]
  quota?: Partial<VdcQuota>
  sharedBridges?: Array<{ bridge: string; label?: string }>
}
