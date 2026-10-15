/**
 * 血缘重读的节流策略与存储生命周期（使用内存存储桩）。
 *
 * 判据：便宜的库保持下限（新鲜度优先）；贵的库退避到上限（成本优先）；中间带不动。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLineage, lineageEdgeSchema } from '../src/lineage.mjs'
import { nativeDiscovery } from '../src/relationships.mjs'

import {
  nextRefreshInterval, REFRESH_MAX_MS, REFRESH_MIN_MS,
} from '../src/refresh.mjs'

test('重读节流：快则维持下限、慢则翻倍退避、封顶在上限', () => {
  assert.equal(nextRefreshInterval(undefined, 3), REFRESH_MIN_MS, '首次且很快 ⇒ 下限')
  assert.equal(nextRefreshInterval(REFRESH_MIN_MS, 3), REFRESH_MIN_MS, '一直很快 ⇒ 维持下限')
  assert.equal(nextRefreshInterval(REFRESH_MIN_MS, 200), REFRESH_MIN_MS * 2, '慢 ⇒ 退避一档')
  assert.equal(nextRefreshInterval(REFRESH_MIN_MS * 4, 200), REFRESH_MIN_MS * 8,
    '没到上限前继续翻倍（8s → 16s）')
  assert.equal(nextRefreshInterval(REFRESH_MAX_MS, 200), REFRESH_MAX_MS, '撞上限就停在上限')
  assert.equal(nextRefreshInterval(REFRESH_MAX_MS / 2, 200), REFRESH_MAX_MS, '翻倍超过上限时取上限')
  assert.equal(nextRefreshInterval(REFRESH_MIN_MS * 4, 30), REFRESH_MIN_MS * 4, '中间带不动')
  assert.equal(nextRefreshInterval(REFRESH_MAX_MS, 30), REFRESH_MAX_MS, '中间带也不该把大间隔拉回来')
  assert.equal(nextRefreshInterval(REFRESH_MAX_MS, 2), REFRESH_MIN_MS, '忽然变快 ⇒ 回到下限')
})

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function storage() {
  const settings = new Map()
  const handles = []
  const facility = {
    async open() {
      const snapshot = new Map(settings)
      const handle = {
        closed: false,
        table: name => ({
          entries: () => (name === 'session_settings' ? snapshot : new Map()).entries(),
          async put(key, value) {
            assert.equal(handle.closed, false, 'put must use an open domain')
            if (name === 'session_settings') settings.set(key, value)
          },
        }),
        async close() { handle.closed = true },
      }
      handles.push(handle)
      return handle
    },
  }
  return { facility, settings, handles }
}

const noDebug = () => {}

test('未命名分叉的 ordinal=0 通过真实持久化 schema', () => {
  assert.equal(lineageEdgeSchema.parse({
    workerId: 'root', rootId: 'root', ordinal: 0, base: '', title: '', createdAt: 0,
  }).ordinal, 0)
})

test('close 等首次 open，之后 refresh 不重新打开域', async () => {
  const db = storage()
  const gate = deferred()
  const open = db.facility.open
  db.facility.open = async () => { await gate.promise; return open() }
  const lineage = createLineage(db.facility, noDebug)
  const closing = lineage.close()
  gate.resolve()
  await closing
  assert.equal(db.handles[0].closed, true)
  assert.equal(await lineage.refresh(), false)
  assert.equal(db.handles.length, 1)
})

test('close 等待在途 refresh 打开的新句柄并关闭它', async () => {
  const db = storage()
  const lineage = createLineage(db.facility, noDebug)
  await lineage.ready
  const gate = deferred()
  const entered = deferred()
  const open = db.facility.open
  db.facility.open = async () => { entered.resolve(); await gate.promise; return open() }
  const refreshing = lineage.refresh()
  await entered.promise
  const closing = lineage.close()
  gate.resolve()
  await Promise.all([refreshing, closing])
  assert.equal(db.handles.length, 2)
  assert.ok(db.handles.every(handle => handle.closed))
})

test('refresh 等待在途写入，不提前关闭其句柄', async () => {
  const db = storage()
  const lineage = createLineage(db.facility, noDebug)
  await lineage.ready
  const gate = deferred()
  const entered = deferred()
  const handle = db.handles[0]
  const table = handle.table
  handle.table = name => {
    const original = table(name)
    return { ...original, async put(key, value) {
      entered.resolve()
      await gate.promise
      await original.put(key, value)
    } }
  }
  const writing = lineage.setSessionSetting('root', { muted: true })
  await entered.promise
  const refreshing = lineage.refresh()
  await Promise.resolve()
  assert.equal(handle.closed, false)
  gate.resolve()
  assert.equal(await writing, true)
  assert.equal(await refreshing, true)
  assert.equal(handle.closed, true)
  assert.equal(lineage.settingsOf('root').muted, true)
  await lineage.close()
})

test('refresh 期间设置先内存可见，等重开后写入且不被旧快照覆盖', async () => {
  const db = storage()
  db.settings.set('root', { muted: false, updatedAt: 1 })
  const lineage = createLineage(db.facility, noDebug)
  await lineage.ready
  const gate = deferred()
  const entered = deferred()
  const open = db.facility.open
  db.facility.open = async () => { entered.resolve(); await gate.promise; return open() }
  const refreshing = lineage.refresh()
  await entered.promise
  const writing = lineage.setSessionSetting('root', { muted: true })
  assert.equal(lineage.settingsOf('root').muted, true)
  gate.resolve()
  await refreshing
  assert.equal(await writing, true)
  assert.equal(lineage.settingsOf('root').muted, true)
  assert.equal(db.settings.get('root').muted, true)
  db.settings.set('root', { muted: false, updatedAt: lineage.settingsOf('root').updatedAt + 1 })
  await lineage.refresh()
  assert.equal(lineage.settingsOf('root').muted, false, '外部较新设置仍可导入')
  await lineage.close()
})


const forkSnapshot = (id, parentSession = 'root', extra = {}) => ({ header: { id, parentSession, ...extra } })
test('native成功重读移除删除记录，更新parent并排除改为subagent的header', async () => {
  let rows = [forkSnapshot('deleted'), forkSnapshot('moved'), forkSnapshot('sub')]
  const discovery = nativeDiscovery({ live: () => [], stored: () => async () => rows })
  await discovery.refresh()
  rows = [forkSnapshot('moved', 'other'), forkSnapshot('sub', 'root', { origin: 'subagent' })]
  await discovery.refresh(true)
  assert.deepEqual([...discovery.edges.keys()], ['moved'])
  assert.equal(discovery.edges.get('moved').workerId, 'other')
})

test('native失败保留旧快照并允许重试，live header覆盖持久化快照', async () => {
  let fail = false
  const discovery = nativeDiscovery({ live: () => [forkSnapshot('live', 'live-parent')], stored: () => () => {
    if (fail) throw new Error('list failed synchronously')
    return [forkSnapshot('old'), forkSnapshot('live', 'stale-parent')]
  } })
  await discovery.refresh()
  fail = true
  await discovery.refresh(true)
  assert.equal(discovery.edges.has('old'), true)
  assert.equal(discovery.edges.get('live').workerId, 'live-parent')
  fail = false
  await discovery.refresh(true)
  assert.equal(discovery.edges.has('old'), true)
})

test('native扫描期间created事件不丢失，合并同一在途扫描', async () => {
  const gate = deferred()
  let scans = 0
  const discovery = nativeDiscovery({ live: () => [], stored: () => async () => { scans++; await gate.promise; return [] } })
  const first = discovery.refresh()
  const second = discovery.refresh(true)
  discovery.remember({ id: 'during-scan', parentSession: 'root' })
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(scans, 1)
  assert.equal(discovery.edges.has('during-scan'), true)
})

test('native无持久化服务按当前live重建，服务后来出现仍可扫描', async () => {
  let rows = [forkSnapshot('live')]
  let list
  const discovery = nativeDiscovery({ live: () => rows, stored: () => list })
  await discovery.refresh()
  rows = []
  await discovery.refresh()
  assert.equal(discovery.edges.size, 0)
  list = async () => [forkSnapshot('stored')]
  await discovery.refresh()
  assert.equal(discovery.edges.has('stored'), true)
})
