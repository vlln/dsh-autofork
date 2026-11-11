/**
 * Header lineage is descriptive; takeover selection is an independent directed graph.
 *
 * ⚠️ **dsh 0.2.2 起官方普通分叉不再写 `parentSession`**
 * （`@deepseek-ai/dsh-api-session-controller` 的 `fork()` 只写
 * `cwd / isSeeded / agentPreset`；`SessionHeader.parentSession` 的文档改成
 * "Ordinary forks omit this field"）。所以这条边只能发现**本插件自己建的**分叉
 * （`spawnHead` 仍显式写 `parentSession`，v4 校验器接受）。后果：
 * 用户在官方 GUI 里 fork 出来的会话不再进入 `nativeEdges`——家族/分叉视图看不到它们，
 * `takeOver()` 会以 `not-native-direct-child` 拒绝。
 *
 * 影响面（逐个消费方核对过）：**自动分叉 / 回注 / `fork_*` 工具 / MUTE 都不走这条边**
 * （它们用内存记录 + 存储域血缘 `lineage`），只有"官方分叉的家族展示与接管"退化。
 *
 * 将来若要恢复"官方分叉"的发现，候选做法是读继承前缀里当代
 * `session-log-deepseek/delivery-accepted` 的 `data.sessionId`（父会话 id）反推；
 * **未实测，验证前不要启用**。
 * @param {any} header 会话 header。
 * @returns {{workerId: string, createdAt: number, kind: 'fork'}|undefined}
 */
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
