/**
 * Tenant scoping for Proxmox tasks/events.
 *
 * In multi-tenant MSP deployments vDCs share cluster nodes and isolate
 * via PVE pools. Filtering tasks by `node` is a no-op when every vDC
 * has every node in scope. The right boundary is pool membership,
 * derived from the VM identifier carried in `task.id` (`qemu/<vmid>`
 * or `lxc/<vmid>`).
 */

/**
 * Extract the VMID from a Proxmox task id.
 *
 * PVE returns the task `id` field in different shapes depending on
 * the task source:
 *   - VM-scoped tasks (qmstart, qmstop, vzstop, vncproxy, ...) carry
 *     the bare vmid as a numeric string: `"103"`.
 *   - Some endpoints/legacy paths return `"qemu/103"` or `"lxc/200"`.
 *   - Cluster-wide jobs (package updates, ceph ops, service reloads)
 *     have non-numeric ids (`"networking"`) or are empty.
 *
 * Returns the vmid string when the id matches a VM shape, null
 * otherwise. The caller is expected to verify membership against the
 * tenant's vDC vmid set — that check naturally rejects any numeric
 * id that isn't actually a vmid.
 */
export function extractTaskVmid(taskId: string | undefined): string | null {
  if (!taskId) return null
  // Bare numeric: PVE's standard cluster/tasks shape.
  if (/^\d+$/.test(taskId)) return taskId
  // Legacy / nested form.
  const m = /^(?:qemu|lxc)\/(\d+)$/.exec(taskId)
  return m ? m[1] : null
}
