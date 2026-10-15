/** Header lineage is descriptive; takeover selection is an independent directed graph. */
export function ordinaryFork(header) {
  return typeof header?.id === 'string' && typeof header.parentSession === 'string'
    && header.parentSession !== '' && header.origin !== 'subagent'
    ? { workerId: header.parentSession, createdAt: header.createdAt ?? 0, kind: 'fork' }
    : undefined
}

/** Metadata-only discovery. Successful scans replace snapshots; failed scans retain them. */
export function nativeDiscovery({ live, stored, onError = () => {}, now = Date.now }) {
  const edges = new Map()
  let pending
  let scanCreated
  let refreshedAt = -Infinity
  const put = (map, header) => {
    if (typeof header?.id !== 'string') return
    const edge = ordinaryFork(header)
    if (edge === undefined) map.delete(header.id)
    else map.set(header.id, edge)
  }
  const remember = header => {
    if (typeof header?.id !== 'string') return
    put(edges, header)
    scanCreated?.set(header.id, header)
  }
  async function refresh(force = false) {
    for (const session of live()) put(edges, session.header)
    if (pending !== undefined) return pending
    const list = stored()
    if (list === undefined) {
      edges.clear()
      for (const session of live()) put(edges, session.header)
      return
    }
    if (!force && now() - refreshedAt < 2000) return
    const created = new Map()
    scanCreated = created
    // Defer execution until after pending is assigned, including synchronous failures.
    pending = Promise.resolve().then(async () => {
      try {
        const snapshots = await list()
        const next = new Map()
        for (const snapshot of snapshots) put(next, snapshot.header)
        for (const session of live()) put(next, session.header)
        for (const header of created.values()) put(next, header)
        edges.clear()
        for (const [id, edge] of next) edges.set(id, edge)
        refreshedAt = now()
      } catch (error) { onError(error) }
      finally { pending = undefined; scanCreated = undefined }
    })
    await pending
  }
  return { edges, remember, refresh }
}

/** Follow only selected bindings, rejecting corrupt cycles rather than choosing by age. */
export function bindingHead(id, targetOf) {
  const seen = new Set([id])
  let cursor = id
  while (targetOf(cursor) !== undefined) {
    cursor = targetOf(cursor)
    if (seen.has(cursor)) return id
    seen.add(cursor)
  }
  return cursor
}

export function takeoverError(parentId, childId, targetOf) {
  if (parentId === childId) return 'binding-cycle'
  // A child with its own driver cannot itself become the selected head.
  if (targetOf(childId) !== undefined) return 'child-already-taken-over'
  const seen = new Set([parentId])
  let cursor = childId
  while (cursor !== undefined) {
    if (seen.has(cursor)) return 'binding-cycle'
    seen.add(cursor)
    cursor = targetOf(cursor)
  }
  return undefined
}

/** Undirected component for authority/counting; ordinary display edges are never supplied. */
export function connectedIds(id, pairs) {
  const neighbors = new Map()
  for (const [a, b] of pairs) {
    if (!neighbors.has(a)) neighbors.set(a, [])
    if (!neighbors.has(b)) neighbors.set(b, [])
    neighbors.get(a).push(b)
    neighbors.get(b).push(a)
  }
  const seen = new Set([id])
  for (const current of seen) for (const next of neighbors.get(current) ?? []) seen.add(next)
  return [...seen]
}

/** Fail competing requests explicitly; never queue a stale confirmation behind another choice. */
export function parentLock() {
  const active = new Set()
  return async (id, run) => {
    if (active.has(id)) return { ok: false, error: 'takeover-in-progress', status: 409 }
    active.add(id)
    try { return await run() } finally { active.delete(id) }
  }
}
