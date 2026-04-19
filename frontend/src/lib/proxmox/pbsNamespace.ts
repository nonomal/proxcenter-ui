import { pbsFetch, type PbsClientOptions } from './pbs-client'

type NsRow = { ns: string }

function splitHeadTail(namespace: string): { head: string; parent: string | null } {
  const idx = namespace.lastIndexOf('/')
  if (idx < 0) return { head: namespace, parent: null }
  return { head: namespace.slice(idx + 1), parent: namespace.slice(0, idx) }
}

/**
 * Create the namespace on PBS if missing. Hierarchical paths are created
 * level-by-level by the caller — this helper creates only ONE level.
 * Use `ensureNamespacePath` for full hierarchical creation.
 */
export async function ensureNamespace(
  conn: PbsClientOptions,
  datastore: string,
  namespace: string,
  opts: { parent?: string } = {},
): Promise<void> {
  const existing = await pbsFetch<NsRow[]>(conn, `/admin/datastore/${encodeURIComponent(datastore)}/namespace`)
  const already = (existing || []).some(r => r.ns === namespace)
  if (already) return

  const { head } = splitHeadTail(namespace)
  const body: Record<string, any> = { ns: head }
  if (opts.parent) body.parent = opts.parent

  await pbsFetch(conn, `/admin/datastore/${encodeURIComponent(datastore)}/namespace`, {
    method: 'POST',
    body,
  })
}

/** Ensures every segment of a `a/b/c` namespace exists (idempotent). */
export async function ensureNamespacePath(
  conn: PbsClientOptions,
  datastore: string,
  fullNamespace: string,
): Promise<void> {
  const parts = fullNamespace.split('/').filter(Boolean)
  let parent: string | null = null
  for (const seg of parts) {
    const path = parent ? `${parent}/${seg}` : seg
    await ensureNamespace(conn, datastore, path, parent ? { parent } : {})
    parent = path
  }
}

export async function ensureSubToken(
  conn: PbsClientOptions,
  user: string,
  tokenId: string,
): Promise<{ tokenId: string; secret: string | null }> {
  const full = `${user}!${tokenId}`
  try {
    const existing = await pbsFetch<any>(
      conn,
      `/access/users/${user}/token/${tokenId}`,
    )
    if (existing && existing.tokenid) return { tokenId: full, secret: null }
  } catch {
    // fall through — create below
  }
  const created = await pbsFetch<any>(
    conn,
    `/access/users/${user}/token/${tokenId}`,
    { method: 'POST', body: {} },
  )
  return { tokenId: created.tokenid ?? full, secret: created.value ?? null }
}

export async function setNamespaceAcl(
  conn: PbsClientOptions,
  datastore: string,
  namespace: string,
  authId: string,
  role: 'DatastoreBackup' | 'DatastoreReader' = 'DatastoreBackup',
): Promise<void> {
  await pbsFetch(conn, '/access/acl', {
    method: 'PUT',
    body: {
      path: `/datastore/${datastore}/${namespace}`,
      'auth-id': authId,
      role,
      propagate: 1,
    },
  })
}

export async function deleteSubToken(
  conn: PbsClientOptions,
  user: string,
  tokenId: string,
): Promise<void> {
  try {
    await pbsFetch(
      conn,
      `/access/users/${user}/token/${tokenId}`,
      { method: 'DELETE' },
    )
  } catch (e: any) {
    if (!/\b404\b/.test(String(e?.message))) throw e
  }
}

/** List snapshots in a specific namespace (non-recursive). */
export async function listSnapshotsInNamespace(
  conn: PbsClientOptions,
  datastore: string,
  namespace: string,
): Promise<any[]> {
  const qs = `?ns=${encodeURIComponent(namespace)}&max-depth=0`
  return (await pbsFetch<any[]>(conn, `/admin/datastore/${encodeURIComponent(datastore)}/snapshots${qs}`)) || []
}
