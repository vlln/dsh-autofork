/**
 * 血缘的**持久化层** —— 把"谁接管了谁"写进 DSH 官方的**存储域**（不是自己找地方放文件）。
 *
 * ## 为什么需要它
 *
 * 分叉关系原本只活在本插件的内存记录（`recordByHead` / `recordByWorker`）里，于是
 * **dsh 一重启，所有分叉关系就没了**：左侧列表里两条会话在名字上还看得出是一族
 * （`Sleep for one minute` / `⑂1 Sleep for one minute`），但「分叉」页签只剩当前这一条，
 * agent 调 `fork_list` 也看不到任何亲属（用户 2026-09 实测报的）。
 *
 * ## 为什么用存储域，而不是自己写文件 / 正则读日志
 *
 * 用户的判断（2026-09）：**不要从会话日志里正则捞**，要用 DSH 提供的规范存储。
 * 核实结果——DSH 有现成的持久化栈，且官方插件都走它：
 *
 * ```
 * @deepseek-ai/dsh-base 的 cordis.patch.yml：
 *   - id: storage        name: @deepseek-ai/dsh-storage           # 中枢（ctx.storage）
 *   - id: storage-json   name: @deepseek-ai/dsh-storage-json      # 后端，root = <DSH_HOME>/storages
 *                        config: { root: dshHomePath('storages') }
 *   - id: storage-domain name: @deepseek-ai/dsh-storage-domain    # 表单，config: { backend: json }
 * ```
 *
 * 于是插件只需要 `ctx.storageDomain.open(spec)`：
 *
 * - **落点由 DSH 决定**（本机实测 `<DSH_HOME>/storages/autofork_lineage/`），插件不猜路径、
 *   不写 DSH_HOME 之外的任何地方；
 * - **schema 在持久化边界上被校验**（`defineDomain` + `domainTable(zod)`，官方原文
 *   "Validates every stored record at the durable boundary"），所以读回来的东西要么合法、
 *   要么在 open 阶段就被拦（见下面的 `invalidRecords`）；
 * - 官方同类先例：投影缓存（`session_projcache`）也是这么开的，形状可直接对照。
 *
 * ## 数据形状
 *
 * 一条边 = 一次分叉：`headId`（新会话）← `workerId`（被接管的会话）。键取 `headId`
 * （一条会话最多被创建一次，天然唯一），于是"往上走"是一次查表；"往下走"用内存里的
 * 反向索引（装载时建一次，写入时增量维护）。
 *
 * ⚠️ **一条 worker 可以有多个 head**（同一个会话被分叉多次 = 一棵树，不是一条链）。
 * 这一点内存版本是**看不见**的：`recordByWorker` 只会指向最后绑定的那一个，早先那条
 * 分叉就从"我分出去的"列表里消失了。持久化层按 `createdAt` 排全部子节点，所以树是完整的。
 *
 * @module dsh-autofork/lineage
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 域与表的名字（必须匹配 `^[a-z][a-z0-9_]*$`：它同时是后端里的文件名段）。 */
export const LINEAGE_DOMAIN = 'autofork_lineage'

/** 表名。 */
export const LINEAGE_TABLE = 'edges'

/**
 * 域格式版本。改**记录形状**时必须 +1，并把旧版本列进 `compatibleVersions`
 * （后端会按记录上的版本戳决定读还是丢）。
 */
export const LINEAGE_VERSION = 1

/**
 * 一条血缘边。
 *
 * 字段都是**分叉那一刻的既成事实**，不是"cache"：`workerId` 是结构，`ordinal`/`base`/`title`
 * 是当时分配的命名（有了它，重启后的新分叉不会与旧分叉重号，也不必再去扫持久化标题），
 * `createdAt` 用来给同级的多个分叉排序（新在前/后要稳定）。
 */
export const lineageEdgeSchema = z.object({
  /** 被接管的会话（父）。 */
  workerId: z.string().min(1),
  /** 家族根（当时算出来的），便于不做上溯就归族。 */
  rootId: z.string().min(1),
  /** 命名序号（`⑂<ordinal> <base>`）。 */
  ordinal: z.number().int().positive(),
  /** 命名基名（家族根当时的标题）。 */
  base: z.string(),
  /** 分配时的完整标题。 */
  title: z.string(),
  /** 建分叉时间（epoch ms）。 */
  createdAt: z.number().int().nonnegative(),
})

/**
 * 域声明。
 *
 * - `layout: 'per-record'`：一条边一个文档。记录彼此独立、可单独丢弃，正是官方给这个
 *   布局写的适用场景（"large, sparse, or individually disposable"）。
 * - `invalidRecords: 'backup-and-skip'`：**血缘是派生数据，不是权威数据**。一条坏记录
 *   不该让整个域打不开（那会把插件的分叉功能一起拖死）；官方会把它挪到一边、记一条日志、
 *   其余记录照常可用。
 */
export const lineageDomainSpec = defineDomain({
  name: LINEAGE_DOMAIN,
  version: LINEAGE_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { [LINEAGE_TABLE]: domainTable(lineageEdgeSchema) },
})

/**
 * 建一个血缘存储句柄。
 *
 * **不阻塞 apply**：`ready` 是个 Promise，`open` 在后台跑；需要家族的读取路径先
 * `await ready`（见 index.mjs 的 `settleLineage()`），写路径则在写之前先写内存索引，
 * 所以"写进去的立刻能被看见"。
 * @param {any} facility `ctx.storageDomain`。
 * @param {(event: string, detail?: object) => void} debug 决策日志。
 * @returns {object} 句柄：`ready` / `edgeOf` / `headsOf` / `remember` / `ordinalOf` / `close`。
 */
export function createLineage(facility, debug) {
  /** headId → edge（装载 + 增量）。 */
  const edges = new Map()
  /** workerId → headId[]（按 createdAt 升序）。 */
  const headsByWorker = new Map()

  let domain
  let closed = false

  /**
   * 把一条边放进内存索引（幂等：同 key 覆盖）。
   * @param {string} headId 新会话 id。
   * @param {any} edge 边。
   * @returns {void}
   */
  function index(headId, edge) {
    edges.set(headId, edge)
    const list = headsByWorker.get(edge.workerId)
    if (list === undefined) {
      headsByWorker.set(edge.workerId, [headId])
      return
    }
    if (list.includes(headId)) return
    list.push(headId)
    // 同级按创建时间排序：树里的兄弟顺序必须稳定（否则每次重启画的树都不一样）。
    list.sort((left, right) => (edges.get(left)?.createdAt ?? 0) - (edges.get(right)?.createdAt ?? 0))
  }

  const ready = (async () => {
    if (facility === undefined || typeof facility.open !== 'function') {
      debug('lineage.no-facility')
      return false
    }
    try {
      domain = await facility.open(lineageDomainSpec)
      for (const [headId, edge] of domain.table(LINEAGE_TABLE).entries()) index(headId, edge)
      debug('lineage.opened', { edges: edges.size, workers: headsByWorker.size })
      return true
    } catch (error) {
      // 域打不开**不能**影响分叉本体：降级成"只有内存血缘"（等于本次运行内的旧行为）。
      debug('lineage.open-failed', { error: String(error) })
      return false
    }
  })()

  return {
    ready,

    /**
     * @param {string} headId 会话 id。
     * @returns {any} 该会话**接管了谁**的边，或 undefined。
     */
    edgeOf(headId) {
      return edges.get(headId)
    },

    /**
     * @param {string} workerId 被接管的会话 id。
     * @returns {string[]} 接管过它的会话（按创建时间升序）。
     */
    headsOf(workerId) {
      return headsByWorker.get(workerId) ?? []
    },

    /**
     * 记下一条边：**先写内存再落盘**（读取路径立刻可见），落盘失败只记日志。
     * @param {string} headId 新会话 id。
     * @param {any} edge 边。
     * @returns {Promise<boolean>} 是否已持久化。
     */
    async remember(headId, edge) {
      index(headId, edge)
      if (domain === undefined || closed) {
        debug('lineage.memory-only', { head: headId })
        return false
      }
      try {
        await domain.table(LINEAGE_TABLE).put(headId, edge)
        debug('lineage.wrote', { head: headId, worker: edge.workerId, ordinal: edge.ordinal })
        return true
      } catch (error) {
        debug('lineage.write-failed', { head: headId, error: String(error) })
        return false
      }
    },

    /**
     * 该基名已经用掉的**最大**序号。
     * @param {string} base 命名基名。
     * @returns {number} 最大序号（没有则 0）。
     */
    ordinalOf(base) {
      let max = 0
      for (const edge of edges.values()) {
        if (edge.base === base) max = Math.max(max, edge.ordinal)
      }
      return max
    },

    /** @returns {number} 已记录的血缘边条数（诊断用）。 */
    size() {
      return edges.size
    },

    /**
     * 关域（由插件 effect 的 disposer 调）：域句柄由**调用方**持有并负责关闭。
     * @returns {Promise<void>} 关闭完成。
     */
    async close() {
      closed = true
      if (domain === undefined) return
      try {
        await domain.close()
      } catch (error) {
        debug('lineage.close-failed', { error: String(error) })
      }
    },
  }
}
