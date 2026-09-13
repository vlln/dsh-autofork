/**
 * dsh-autofork Node half —— 自动分叉（链式接管模型）。
 *
 * ## 模型（2026-09 实测修正，取代第一版的"父子"模型）
 *
 * 分叉形成的是一条**链**：
 *
 *     A ←── 接管 ── B ←── 接管 ── C
 *
 * - **head** = 最新的那条，用户面向它；它**接管**了身后的会话。
 * - 被接管的会话继续在后台跑（**绝不中止在飞 turn**），它的最后一条回复流向 head。
 * - head 能看见并管理整条链（`fork_list` / `fork_steer` / `fork_cancel`）。
 *
 * 第一版把这个关系读成"父拥有子"，方向反了：head 调 `fork_list` 返回空，因为它被
 * 当成"子"而不是"拥有者"（用户实测："B 无法用 branch-list 工具列出 A"）。
 *
 * ## 一次分叉做什么
 *
 * 1. 触发判定（忙 + 有在飞 turn + 未超家族上限）→ `inbox.remove()` CAS 抢占用户消息；
 * 2. 在**最后一个已完成的 turn** 上 fork 出新会话作为 head；
 * 3. 给 head 注入：分叉通知（点名 worker 正在动的文件）+ 在飞 turn 的确定性 digest；
 * 4. 给 worker 注入**一条不改变方向的提示**：继续工作，但把最后一条回复写成简短的总结；
 * 5. head 接手与用户的交互；worker 照原计划跑完，其**最后一条回复**被转给 head。
 *
 * ## 边界（有意不做）
 *
 * `bash` 等外部进程没有守卫；文件级冲突由 `fs-observation-policy` 兜底（FS_STALE_VERSION）。
 * 本插件不做这一层的隔离或仲裁，交给 agent 自行判断。
 *
 * @module @vlln/dsh-autofork
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveParams, describeParams } from './src/params.mjs'
import {
  activeTargets, boundSummary, driverLabel, instanceReplySummary, messageText, renderBranchHint,
  renderForkNotice, renderInFlightDigest, renderInstanceReply, renderWorkerReply,
  shortSessionId,
} from './src/digest.mjs'
import { createBranchTools } from './src/tools.mjs'
import { createLineage } from './src/lineage.mjs'

/**
 * 「触发指令」在血缘边/UI 里的字符上限。
 *
 * 页签上就是一行省略号文本，存全量只会在持久化里留一堆用户原文；120 字符足够认出
 * "是那条 worktree 的指令"，与 digest 的 `digestAssistantChars` 同一量级。
 */
const TRIGGER_MAX_CHARS = 120

/** Cordis 插件名。 */
export const name = 'dsh-autofork'

/**
 * 只声明**真正必需**的服务。其余能力一律走嵌套 `ctx.inject([...], …)` 子插件：
 * cordis 里必需服务缺席会让**整个 runtime 启动失败**（`1 entry did not activate`），
 * 而不是本插件降级。实测：把 `agentPresets` 写进顶层 inject 后 `--profile sdk` 起不来。
 */
export const inject = ['agents', 'sessionProjections']

/**
 * health 探针路径。存在的理由：DSH 的 `logger.info` 不写 stdout，因此"插件是否挂载
 * 成功""客户端在做什么"在进程外不可观测。这个路由把两者都变成可 curl 的事实，
 * 同时充当客户端的分叉关系数据源。
 */
const HEALTH_PATH = '/api/dsh-autofork/health'


/**
 * `subagent/descriptor` 事件的版本字面量（`dsh-subagent` 的 `SUBAGENT_DESCRIPTOR_VERSION`）。
 *
 * 这个事件必须写进**子会话自己的日志**，而且必须在**继承前缀之后**——它是子会话
 * "durable 父地址"的另一半，客户端与宿主都靠它把子会话认出来：
 *
 *  · 宿主的 `validateAddress()` 用 `projections.values.subagent`（由 `subagent/descriptor`
 *    折叠而来）校验 `identity.seq >= inheritedEventCount`、`identity.mode === address.mode`；
 *  · 分类子会话的 `resolveCandidateRows()` 更严：`candidate.live.isOwnSeq(identity.seq)`
 *    —— 描述符的 seq 必须是子会话**自己的** seq，所以它**不能**落在继承前缀里，
 *    否则这个子会话根本不会出现在父会话的 catalog 里（实例树为空、`openSubagent` 也会拒）。
 *
 * 形状（`.strict()`，未知字段直接抛）：`{version, mode, provider, label, agentProvider?,
 * agentModel?, agentReasoningEffort?, persona?, toolFilter?}`。
 */
const SUBAGENT_DESCRIPTOR_VERSION = 3

/**
 * `subagent/catalog` 事件的版本字面量（`dsh-subagent` 的 `SUBAGENT_CATALOG_VERSION`）。
 *
 * 官方有 `establishCatalogChild(parent, childHeader, descriptor)` 做同一件事，但它
 * **没有从包入口导出**（只在包内部 import），插件只能自己 append；形状取自 `catalog.ts`：
 * `z.object({version: literal(0), childId, childCreatedAt: int≥0, mode, label?}).strict()`。
 */
const SUBAGENT_CATALOG_VERSION = 0


/** 注入上下文消息的生产者标识（MessageSourceMap.plugin.plugin）。 */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'dsh-autofork' }

/**
 * 插件入口。
 * @param {import('cordis').Context} ctx 宿主上下文。
 * @param {Record<string, unknown> | undefined} config 插件配置（覆盖 params）。
 * @returns {void}
 */
export function apply(ctx, config) {
  const params = resolveParams(config)
  if (!params.enabled) return

  /**
   * 装一个面向模型的消息，用于 inject()/followup()/append()。
   *
   * **呈现与内容是两件事**：`content` 是模型真正读到的东西，`source` 是客户端拿来
   * 决定怎么显示的东西。给 `source` 加上 `form:'notice'` + `summary` 后，客户端
   * （`ui-chat` 的 `contextBody`）会把这一行**折叠成一行摘要**、展开才显示正文；
   * 正文一个字都不变，`source` 根本不进 `deriveMessages()` 的投影。依据：
   * `dsh-llm` 的 `MessageSourceMap.plugin` 混入 `ContextFormed`，`notice` 要求
   * 同时给出 `summary`，并有 `CONTEXT_SUMMARY_MAX_CHARS` 上限。
   *
   * 定义在 `apply` 内部而不是模块级：是否折叠由**运行期参数** `noticeSummaries`
   * 决定，而参数只在 `apply` 里解析。
   *
   * @param {string} text 消息正文（模型读到的内容）。
   * @param {string} [summary] 折叠行显示的一行 account；省略则不折叠。
   * @returns {import('@deepseek-ai/dsh-llm').UserMessage} 构造好的 user 角色消息。
   */
  function contextMessage(text, summary, kind) {
    const source = summary === undefined || params.noticeSummaries !== true
      ? PLUGIN_SOURCE
      : { ...PLUGIN_SOURCE, form: 'notice', summary: boundSummary(summary) }
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: kind === undefined ? source : { ...source, kind },
    })
  }

  /**
   * 接管记录。每条记录描述一次分叉：
   * `headId` 是**拥有者**（新的、用户面向的那条），`workerId` 是**被接管**的那条。
   */
  const recordByHead = new Map()
  const recordByWorker = new Map()

  /**
   * 因"悬空工具调用"而暂时改走 `inject()` 的镜像，按**容器 id** 排队。
   * 容器转 idle 时补落盘（见下面第三条 `agent/status` 订阅）。
   */
  const deferredByContainer = new Map()

  /**
   * 因"容器自己那条 turn 还开着"而排队的 agent 答复，按容器 id 存 agent id 列表。
   * 容器转 idle 时补落盘（第三条 `agent/status` 订阅）——**绝不丢**。
   */
  const deferredAnswers = new Map()

  /**
   * 容器上**当前绑定的实例**（容器模式的 driver）。
   *
   * `recordByHead` 保留容器的**全部**实例（容器允许有多个实例、只有一个被绑定）；
   * `recordByWorker` 只指向当前绑定的那个——链式接管那套（`familyOf` / 工具 / 旧路径）
   * 因此不需要改语义，而重绑只是把它指向新记录。
   */
  function boundRecordOf(containerId) {
    return recordByWorker.get(containerId)
  }

  /**
   * 该容器名下的全部实例（含已经跑完/已被重绑替换掉的）。
   * @param {string} containerId 容器会话 id。
   * @returns {any[]} 记录列表（插入序）。
   */
  function instancesOf(containerId) {
    return [...recordByHead.values()].filter(record => record.workerId === containerId)
  }

  /** 已注册的调度工具名，供 health 探针报告（挂载证明的一部分）。 */
  const exposedToolNames = []

  /* ------------------------------ 可选能力 ------------------------------ */

  let composeInto = () => undefined
  ctx.inject(['agentPresets'], (capabilityCtx) => {
    composeInto = (agentCtx, parentCtx) => capabilityCtx.agentPresets.composeFrom(agentCtx, parentCtx)
  })

  let currentSelection = () => undefined
  ctx.inject(['agentDefaultModel'], (capabilityCtx) => {
    currentSelection = () => capabilityCtx.agentDefaultModel.currentSelection()
  })

  let workspaceRegistry
  ctx.inject(['workspaceRegistry'], (capabilityCtx) => {
    workspaceRegistry = capabilityCtx.workspaceRegistry
  })

  /**
   * 会话标题服务：`rename(session, title)` 就是**用户在侧栏手动重命名**那条路
   * （追加一条 `source:{kind:'user'}` 的 `session/title`，并钉住标题）。
   * 分叉会话的命名（`⑂1 修 GUI 卡顿`）走它，不自己写日志事件。
   */
  let sessionTitleApi

  /**
   * 活会话存储：① 取某条会话当前的标题（命名要以家族根**当时的名字**为基名）；
   * ② 枚举活会话，给同基名的分叉接上序号（插件重载后记录丢了也不会重号）。
   */
  let sessionsApi
  ctx.inject(['sessionTitle', 'sessions'], (capabilityCtx) => {
    sessionTitleApi = capabilityCtx.sessionTitle
    sessionsApi = capabilityCtx.sessions
  })

  ctx.logger?.info?.(`[dsh-autofork] 已启用：${describeParams(params)}`)

  /* ------------------------------ 诊断通道 ------------------------------ */

  const debugPath = params.debugLogPath !== '' ? params.debugLogPath : (process.env.DSH_AUTOFORK_DEBUG ?? '')
  /**
   * 决策日志：把每条判定、早退原因与客户端回报写成一行 JSON。
   * @param {string} event 事件名。
   * @param {Record<string, unknown>} [detail] 附加字段。
   */
  function debug(event, detail = {}) {
    if (debugPath === '') return
    try {
      appendFileSync(debugPath, `${JSON.stringify({ at: Date.now(), event, ...detail })}\n`)
    } catch {
      /* 诊断通道失败不得影响主流程 */
    }
  }
  debug('apply', { params: describeParams(params), pid: process.pid })

  /* ------------------------------ 家族（血缘树） ------------------------------ */

  /**
   * 血缘的**持久化**层（DSH 官方存储域，见 src/lineage.mjs）。
   *
   * 放在 debug 之后：`createLineage` 里会调它记日志，而 `debug` 读的 `debugPath` 是 `const`
   * （提前调用会撞 TDZ）。
   */
  let lineage
  ctx.inject(['storageDomain'], (capabilityCtx) => {
    lineage = createLineage(capabilityCtx.storageDomain, debug)
    capabilityCtx.effect(() => () => {
      void lineage?.close?.()
    }, 'dsh-autofork: 关闭血缘存储域')
  })

  /**
   * 等血缘域装载完。**读取家族的路径先调它一次**，之后同一次请求里的同步读取就都能看见
   * 持久化下来的边（装载是一次表扫描，几个毫秒）。
   * @returns {Promise<boolean>} 是否可用。
   */
  async function settleLineage() {
    if (lineage === undefined) return false
    try {
      return await lineage.ready
    } catch {
      return false
    }
  }

  /**
   * 一条会话**接管了谁**的边：内存记录优先（它带着 `dispose`/`bound` 等运行态），
   * 持久化边兜底（进程重启后内存是空的）。
   * @param {string} sessionId 会话 id。
   * @returns {any} `{workerId, …}` 或 undefined。
   */
  function edgeOf(sessionId) {
    return recordByHead.get(sessionId) ?? lineage?.edgeOf(sessionId)
  }

  /**
   * 接管过这条会话的**全部**会话（按创建时间升序）。
   *
   * ⚠️ 内存版只能给出"当前绑定的那一个"（`recordByWorker` 是 1:1），于是在同一条会话上
   * 分叉两次时，早先那条分叉会从"我分出去的"里**消失**；这里把两边的来源合起来，
   * 树才是完整的。容器模式下多个实例也走这条路（它们本来就是同一个容器的多个 agent）。
   * @param {string} sessionId 被接管的会话 id。
   * @returns {string[]} head id 列表。
   */
  function headsOf(sessionId) {
    const heads = []
    for (const record of recordByHead.values()) {
      if (record.workerId === sessionId && record.headId !== undefined) heads.push(record.headId)
    }
    for (const headId of lineage?.headsOf(sessionId) ?? []) {
      if (!heads.includes(headId)) heads.push(headId)
    }
    // 兄弟按建分叉时间升序：树的行顺序必须稳定（内存记录与持久化边的插入顺序不同，
    // 不排就会"每次重启画的树都不一样"）。
    const createdAtOf = id => recordByHead.get(id)?.createdAt
      ?? lineage?.edgeOf(id)?.createdAt
      ?? 0
    return heads.sort((left, right) => createdAtOf(left) - createdAtOf(right))
  }

  /**
   * 沿血缘上溯到没有被别人接管的祖宗会话。
   * @param {string} sessionId 起点会话。
   * @returns {string} 家族根会话 id。
   */
  function familyRootOf(sessionId) {
    let cursor = sessionId
    const seen = new Set([sessionId])
    for (let guard = 0; guard < 64; guard += 1) {
      const edge = edgeOf(cursor)
      if (edge === undefined || seen.has(edge.workerId)) break
      seen.add(edge.workerId)
      cursor = edge.workerId
    }
    return cursor
  }

  /**
   * 家族视图：以**家族根**为根的整棵血缘树，按与调用者的关系分组。
   *
   * 为什么不是"沿链走两步"：一条会话可以被分叉多次（`⑂1` / `⑂2` 都是它的孩子），
   * 那是**树**不是链。链式视角下兄弟分叉会互相看不见——工具与页签都会漏。
   *
   * `upstream` 由近及远；`downstream` 是我的后代（含各层）；`siblings` 是同族但既不是
   * 我的祖先也不是我的后代的那些（同一个父会话的其它分叉、以及它们的后代）。
   * @param {string} sessionId 起点会话。
   * @returns {{root: string, upstream: string[], downstream: string[], siblings: string[], all: string[]}} 家族。
   */
  function familyOf(sessionId) {
    const root = familyRootOf(sessionId)
    // 整棵树：从根开始按创建时间做 BFS（每个节点只进一次，防环）。
    const all = []
    const seen = new Set()
    const queue = [root]
    while (queue.length > 0) {
      const cursor = queue.shift()
      if (seen.has(cursor)) continue
      seen.add(cursor)
      all.push(cursor)
      for (const headId of headsOf(cursor)) queue.push(headId)
    }
    const upstream = []
    const walked = new Set([sessionId])
    let cursor = sessionId
    for (let guard = 0; guard < 64; guard += 1) {
      const edge = edgeOf(cursor)
      if (edge === undefined || walked.has(edge.workerId)) break
      walked.add(edge.workerId)
      upstream.push(edge.workerId)
      cursor = edge.workerId
    }
    const downstream = []
    const downSeen = new Set([sessionId])
    const downQueue = [sessionId]
    while (downQueue.length > 0) {
      const current = downQueue.shift()
      for (const headId of headsOf(current)) {
        if (downSeen.has(headId)) continue
        downSeen.add(headId)
        downstream.push(headId)
        downQueue.push(headId)
      }
    }
    const upSet = new Set(upstream)
    const downSet = new Set(downstream)
    downSet.add(sessionId)
    const siblings = all.filter(id => !upSet.has(id) && !downSet.has(id))
    return { root, upstream, downstream, siblings, all }
  }

  /* ------------------------------ 分叉会话的命名 ------------------------------ */

  /**
   * 分叉命名标记（`params.titleMark`）。空串 = 关闭分叉命名。
   * @returns {string} 标记。
   */
  function branchMark() {
    return typeof params.titleMark === 'string' ? params.titleMark : ''
  }

  /**
   * 家族根：沿"接管"边（内存记录 + 持久化边）上溯。
   *
   * 命名的基名取**根的**标题而不是直接父会话的：链式分叉下父会话自己的标题已经带着
   * `⑂k `，用它作基名会一层层累积（`⑂1 ⑂2 …`），而用户要的是"全家族共用一个基名 +
   * 各自序号"。
   */

  /**
   * 剥掉标题里的分叉标记与序号，得到**家族基名**。
   *
   * 只剥"标记 + 紧跟的数字 + 空白"，所以基名本身以数字开头（`2 号任务`）也不会被啃掉：
   * `⑂1 2 号任务` → `2 号任务`。
   * @param {unknown} title 会话标题。
   * @param {string} mark 分叉标记。
   * @returns {string|undefined} 基名；标题不可用时 undefined。
   */
  function stripBranchMark(title, mark) {
    if (typeof title !== 'string') return undefined
    const text = title.trim()
    if (mark === '' || !text.startsWith(mark)) return text === '' ? undefined : text
    const rest = text.slice(mark.length).replace(/^\d+\s*/u, '').trim()
    return rest === '' ? undefined : rest
  }

  /**
   * 取一条**活**会话当前的标题（原生 `sessionTitle.get` 读的是日志折叠结果）。
   * @param {string} sessionId 会话 id。
   * @returns {string|undefined} 标题。
   */
  function titleOfLive(sessionId) {
    if (sessionTitleApi === undefined || sessionsApi === undefined) return undefined
    const session = sessionsApi.get?.(sessionId)
    if (session === undefined) return undefined
    try {
      return sessionTitleApi.get?.(session)?.title
    } catch (error) {
      debug('title.read-failed', { session: sessionId, error: String(error) })
      return undefined
    }
  }

  /**
   * 从**持久化血缘**里恢复一条会话的名字（进程重启后、会话还没被打开时的唯一来源）。
   *
   * - 分叉会话：边里就写着当时分配的标题（`⑂1 修 GUI 卡顿`）。
   * - 家族根：它自己没有边，但**任何一个孩子的基名就是根当时的标题**——命名本来就是
   *   这么定的（`base = stripBranchMark(root 的标题)`，而根名里没有标记）。所以拿孩子们的
   *   `base` 反推即可，不必再存一份。
   * @param {string} sessionId 会话 id。
   * @returns {string|undefined} 标题，或 undefined（没有任何持久化线索时）。
   */
  function lineageTitleOf(sessionId) {
    if (lineage === undefined) return undefined
    const own = lineage.edgeOf(sessionId)?.title
    if (typeof own === 'string' && own !== '') return own
    for (const childId of lineage.headsOf(sessionId)) {
      const base = lineage.edgeOf(childId)?.base
      if (typeof base === 'string' && base !== '') return base
    }
    return undefined
  }

  /**
   * 该基名下**下一个可用**的分叉序号。
   *
   * 两个来源取最大值（不是相加，它们看到的是同一批分叉）：
   *   ① **持久化血缘表**（`src/lineage.mjs`）——权威来源：序号是当年分配时就记下的，
   *      不依赖"标题还在、还能被读到"；
   *   ② 本次内存里的记录——血缘域不可用（或那次落盘失败）时的即时镜像，就 5 行，
   *      留着的代价低于"同一次运行里自己跟自己重号"。
   *
   * 曾经还有两条**靠标题反推**的来源（内存活会话的标题、持久化会话标题 + 投影缓存）。
   * 用户 2026-09 拍板删掉：既然有了 schema 校验、读取零 I/O 的持久化方案，
   * 就不该再养着"从渲染结果里反推事实"的路径——那种判据只能在真实数据上悄悄出错。
   * 代价写明：血缘域缺席且跨了进程重启时会重号（同族出现两个 `⑂1`），命名的降级，
   * 不影响分叉。
   * @param {string} base 家族基名。
   * @returns {number} 下一个序号（从 1 起）。
   */
  function nextBranchOrdinal(base) {
    let max = lineage?.ordinalOf?.(base) ?? 0
    for (const record of recordByHead.values()) {
      if (record.titleBase === base && typeof record.titleOrdinal === 'number') {
        max = Math.max(max, record.titleOrdinal)
      }
    }
    debug('title.ordinal', { base, max, next: max + 1, lineage: lineage?.size?.() ?? 0 })
    return max + 1
  }

  /**
   * 给新建的分叉会话命名：`<标记><n> <家族根名>`。
   *
   * 为什么用原生 `sessionTitle.rename()`：它与用户在侧栏手动重命名**完全同一条路**
   * （追加 `session/title`，`source:{kind:'user'}`），因此左侧列表、头部面包屑、搜索
   * 全都自动生效，不需要插件自己碰客户端。代价是它会**钉住**标题（自动命名不再发生），
   * 这正是用户选的形状（见 `params.titleMark` 的注释）。
   *
   * 任何一步失败都只降级（不命名），绝不影响分叉本身。
   * @param {any} workerSession 被接管的会话。
   * @param {any} headSession 新建的分叉会话。
   * @returns {Promise<{title: string, ordinal: number, base: string, rootId: string}|undefined>} 命名结果。
   */
  async function assignBranchTitle(workerSession, headSession) {
    const mark = branchMark()
    if (mark === '') {
      debug('title.disabled', { head: headSession.id })
      return undefined
    }
    if (sessionTitleApi === undefined || typeof sessionTitleApi.rename !== 'function') {
      debug('title.no-service', { head: headSession.id })
      return undefined
    }
    const rootId = familyRootOf(workerSession.id)
    // 基名优先取家族根**此刻的**标题；根不在了（agent 已回收）就退回直接父会话的标题，
    // 并把父会话标题里的标记剥掉——两者都拿不到时给一个可读的兜底名。
    const base = stripBranchMark(titleOfLive(rootId), mark)
      ?? stripBranchMark(titleOfLive(workerSession.id), mark)
      ?? `会话 ${shortSessionId(rootId)}`
    const ordinal = nextBranchOrdinal(base)
    const title = `${mark}${ordinal} ${base}`
    try {
      sessionTitleApi.rename(headSession, title)
      debug('title.assigned', {
        head: headSession.id, worker: workerSession.id, root: rootId, title, ordinal,
      })
      return { title, ordinal, base, rootId }
    } catch (error) {
      debug('title.assign-failed', { head: headSession.id, error: String(error) })
      return undefined
    }
  }

  /**
   * **当前正在回答用户的那条会话**（该会话的 driver）。
   *
   * 用户 2026-09 定的模型：容器（用户所在的会话）与 driver 是两件事——触发分叉后，
   * 容器允许更换 driver。所以"现在是谁在回答你"必须在 UI 上可见，而不是让用户以为
   * 容器自己还卡在旧 driver 的那条长步骤上。
   *
   * 语义：链上最新的一条 head 就是 driver；没有下游就是自己。走链而不是只看直接下游，
   * 因为一次转发可能经过多跳。
   * @param {string} sessionId 起点会话。
   * @returns {{sessionId: string, self: boolean, label: string, busy: boolean}} driver 视图。
   */
  function driverView(sessionId) {
    pruneRecords()
    const { downstream } = familyOf(sessionId)
    // 下游按创建时间升序（`headsOf` 就保证了这个顺序），所以最后一条就是最新的那条 head。
    const driverId = downstream.length === 0
      ? sessionId
      : downstream[downstream.length - 1]
    const agent = ctx.agents.get(driverId)
    return {
      sessionId: driverId,
      self: driverId === sessionId,
      label: driverId === sessionId ? '本会话' : driverLabel(driverId),
      busy: agent?.status === 'running',
    }
  }

  /**
   * 把一条家族成员呈现给工具/UI。`state` 取实时 agent 状态而非缓存。
   * @param {string} sessionId 成员会话。
   * @param {'upstream'|'downstream'|'sibling'} relation 与调用者的关系。
   * @returns {{sessionId: string, relation: string, state: string, busy: boolean, title: string}} 视图。
   */
  function memberView(sessionId, relation) {
    const agent = ctx.agents.get(sessionId)
    // `state` 必须是**实时且互斥**的三态，不能是"agent 对象还在不在"——
    // 后者会让"活着但空闲"的会话同时显示成 running 与"已停"（用户实测报的歧义）。
    const state = agent === undefined ? 'finished' : (agent.status === 'running' ? 'running' : 'idle')
    return {
      sessionId,
      relation,
      state,
      busy: state === 'running',
      // 名字带着 `⑂n ` 前缀时，模型/UI 都能直接用名字指代成员，而不是只认一串短 id。
      // ⚠️ 这里是**字符串**（拿不到标题时是空串），不是 `null`：工具的输出 schema 是
      // `additionalProperties: false` 的封闭形状，`string|null` 得写成 `oneOf`，
      // 而 `oneOf` 又不允许与 `required` 并列（官方 JSON-schema 子集的规定）。
      // 空串在渲染侧当"没有名字"处理。
      title: titleOfLive(sessionId) ?? recordByHead.get(sessionId)?.title ?? lineageTitleOf(sessionId) ?? '',
    }
  }

  /**
   * 家族**链条视图**（根 → 最新），供客户端的「分叉」页签画树。
   *
   * 与 `relatedSessions` 的区别：那个是"相对于调用者的两个方向"（工具面用），
   * 这个是"整条链 + 每条的身份/状态/缩进深度"（UI 面用），且**含本会话自己**。
   * @param {string} sessionId 当前会话。
   * @returns {Array<Record<string, unknown>>} 链条节点。
   */
  function familyNodes(sessionId) {
    pruneRecords()
    const { root } = familyOf(sessionId)
    // 从**根**做 BFS，深度即缩进。这样兄弟分叉（同一条会话被分叉两次）也都在，
    // 而沿链走只会看见其中一条——那正是"我分出去的另一条哪去了"的来源。
    const nodes = []
    const seen = new Set()
    const queue = [{ id: root, depth: 0 }]
    while (queue.length > 0) {
      const item = queue.shift()
      if (seen.has(item.id)) continue
      seen.add(item.id)
      const edge = edgeOf(item.id)
      const agent = ctx.agents.get(item.id)
      const state = agent === undefined ? 'finished' : (agent.status === 'running' ? 'running' : 'idle')
      const ordinal = edge?.ordinal ?? recordByHead.get(item.id)?.titleOrdinal ?? 0
      const full = titleOfLive(item.id) ?? edge?.title ?? lineageTitleOf(item.id) ?? null
      // `label`：把**已经由徽章表达**的 `<标记><序号> ` 前缀去掉之后的显示名。
      // 页签左边就有一枚 `⑂1` 徽章，名字里再带一遍会读成"⑂1 ⑂1 修 GUI 卡顿"（实测
      // 在预览里一眼看到）。前缀用 `params.titleMark` + 序号精确匹配，不是正则猜——
      // 标记是可配的，配了自定义标记时这里也照样对得上。
      const prefix = ordinal > 0 && params.titleMark !== '' ? `${params.titleMark}${ordinal} ` : ''
      const label = prefix !== '' && typeof full === 'string' && full.startsWith(prefix)
        ? full.slice(prefix.length)
        : full
      nodes.push({
        sessionId: item.id,
        title: full,
        /** 显示名（去掉徽章已经表达过的 `<标记><序号> ` 前缀）；UI 用它，工具面不用。 */
        label,
        state,
        busy: state === 'running',
        /** 树上的深度：0 = 家族根（最开始那条会话）。UI 用它做缩进。 */
        depth: item.depth,
        /** 是不是用户此刻正在看的那条。 */
        current: item.id === sessionId,
        /** 它接管了谁（家族根为 null）——UI 画连线、判断分组用。 */
        parentId: edge === undefined ? null : edge.workerId,
        // ---- 下面三项是给「分叉」页签的"对用户有意义的信息"，工具面不用（见 memberView）----
        /** 这次分叉发生在什么时候（epoch ms）；家族根是用户自己开的会话，没有这一项。 */
        at: edge?.createdAt ?? recordByHead.get(item.id)?.createdAt ?? null,
        /** 触发这次分叉的那条用户指令（空串 = 不知道）。 */
        trigger: edge?.trigger ?? recordByHead.get(item.id)?.trigger ?? '',
        /** 命名序号（`<标记><ordinal>`）；没开命名或家族根时为 0。 */
        ordinal,
      })
      for (const headId of headsOf(item.id)) queue.push({ id: headId, depth: item.depth + 1 })
    }
    return nodes
  }

  /**
   * 列出该会话家族里的其它会话。
   * @param {string} sessionId 调用者。
   * @returns {Array<Record<string, unknown>>} 家族成员视图。
   */
  function relatedSessions(sessionId) {
    pruneRecords()
    const { upstream, downstream, siblings } = familyOf(sessionId)
    return [
      ...upstream.map(id => memberView(id, 'upstream')),
      ...downstream.map(id => memberView(id, 'downstream')),
      ...siblings.map(id => memberView(id, 'sibling')),
    ]
  }

  /** 丢弃 worker 已消失且超过回收期的记录。 */
  function pruneRecords() {
    const now = Date.now()
    for (const [headId, record] of recordByHead) {
      // 判据取**实例**是否还在：容器模式下容器会活很久（它永远是同一个），
      // 拿容器当判据等于永不回收，实例记录会一直堆着。
      if (ctx.agents.get(headId) !== undefined) {
        record.endedAt = undefined
        continue
      }
      if (record.endedAt === undefined) {
        record.endedAt = now
        continue
      }
      if (now - record.endedAt > params.harvestAfterMs) {
        recordByHead.delete(headId)
        recordByWorker.delete(record.workerId)
        // 容器已经不在了，它名下的延后镜像也就没有落点了——留着会一直占内存。
        deferredByContainer.delete(record.workerId)
      }
    }
  }

  /**
   * 该会话所在的家族里有多少条**活跃**（agent 仍在）的会话。
   * @param {string} sessionId 起点。
   * @returns {number} 活跃成员数（不含自己）。
   */
  function activeFamilyCount(sessionId) {
    pruneRecords()
    const { upstream, downstream, siblings } = familyOf(sessionId)
    return [...upstream, ...downstream, ...siblings].filter(id => ctx.agents.get(id) !== undefined).length
  }

  /**
   * 授权：目标必须与调用者同族（祖先、后代，或同族的兄弟分叉）。
   *
   * 兄弟也要放行：同一条会话被分叉两次时它们是并列的两条，互相给指令是正当的。
   * @param {string} callerId 调用者。
   * @param {string} targetId 目标。
   * @returns {boolean} 是否允许操作。
   */
  function isFamilyMember(callerId, targetId) {
    if (targetId === '' || targetId === callerId) return false
    const { upstream, downstream, siblings } = familyOf(callerId)
    return upstream.includes(targetId) || downstream.includes(targetId) || siblings.includes(targetId)
  }

  /* ------------------------------ 触发 ------------------------------ */

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    void considerFork(agent, message).catch((error) => {
      debug('consider.threw', { error: String(error) })
    })
  })

  /**
   * 判断一条刚进入 inbox 的消息是否应当分叉。
   * @param {any} agent 收到消息的 agent。
   * @param {any} message 该消息。
   * @returns {Promise<void>} 分叉流程（可能什么都不做）。
   */
  async function considerFork(agent, message) {
    if (agent === undefined || message === undefined) return
    const sourceKind = message?.source?.kind
    if (!params.forkableSourceKinds.includes(sourceKind)) {
      debug('skip.source-kind', { agent: agent.id, sourceKind })
      return
    }
    // 容器模式：**与忙闲无关**，每条用户消息都交给绑定的实例。
    // 容器自己不跑 turn，所以它永远 idle、永远不显示"卡住"，用户也永不移动。
    if (params.containerMode === true) {
      // ⚠️ **只有容器才有"绑定实例"这回事，实例自己干活**（实测踩到的真 bug）：
      // 不给实例设这道门，`instance.followup(用户消息)` 会再次触发本处理器 —— 实例刚建好
      // 正是 `running`，于是它又给自己建了一个子实例，消息一层层往下传，直到撞上
      // `maxActiveBranches`。E2E 里看到的就是 `cm-test → A → A' → A''` 这条递归链。
      if (isInstanceSession(agent)) {
        debug('skip.instance', { agent: agent.id })
        return
      }
      await routeToInstance(agent, message)
      return
    }
    if (agent.status !== 'running') {
      debug('skip.not-running', { agent: agent.id, status: agent.status })
      return
    }

    const session = agent.session
    const projection = ctx.sessionProjections.stateOf(session, 'turnBoundary')
    if (projection === undefined || projection.openTurnStartSeq === null) {
      debug('skip.no-open-turn', { agent: agent.id, hasProjection: projection !== undefined })
      return
    }

    // **本会话已被接管 → 消息该落到 head 上**，不要再分叉。
    // 这不是时间窗技巧，而是状态规则：一条链上只有一个 head，它才是继续对话的地方。
    // （用时间窗合并"用户连发两条"会犯错——被合并的那条会被 steer 回仍被阻塞的
    // worker，等于又让人等。落到 head 才是对的。）
    const takenOverBy = recordByWorker.get(agent.id)
    if (takenOverBy !== undefined) {
      const head = ctx.agents.get(takenOverBy.headId)
      if (head === undefined) {
        debug('route.head-gone', { worker: agent.id, head: takenOverBy.headId })
      } else if (agent.inbox.remove(message.id) === true) {
        head.followup(message)
        debug('route.to-head', { worker: agent.id, head: takenOverBy.headId })
        return
      }
    }

    const age = currentStepAgeMs(session, projection)
    if (params.minStepAgeMs > 0 && age !== undefined && age < params.minStepAgeMs) {
      debug('skip.step-too-young', { agent: agent.id, age, min: params.minStepAgeMs })
      return
    }
    if (activeFamilyCount(agent.id) >= params.maxActiveBranches) {
      debug('skip.family-cap', { agent: agent.id, cap: params.maxActiveBranches })
      return
    }

    const cut = seedCut(session)
    const won = agent.inbox.remove(message.id) === true
    debug('cas', { agent: agent.id, messageId: message.id, won, seedLength: cut.seed.length, stepAge: age })
    if (!won) return

    try {
      await spawnHead(agent, message, projection, cut)
      debug('fork.ok', { agent: agent.id })
    } catch (error) {
      // 分叉失败必须把消息放回原投递路径——绝不静默吞掉用户指令。
      agent.inbox.append('next-step', message)
      debug('fork.failed', { agent: agent.id, error: String(error), stack: error?.stack })
    }
  }

  /* ------------------------------ 容器的"不跑步骤"闸门 ------------------------------ */

  // `agent/pre-step` 是 **waterfall**，且**按 scope 过滤**（"agent-scoped listeners receive
  // only that agent"），回调里能拿到 `agent`，所以这里挂全局监听再按容器判定即可。
  //
  // 为什么必须有这道闸门（这是"同一个容器"能不能成立的最后一环）：用户消息一进 inbox，
  // 容器的 loop 就会开 turn，而 `preStep` **总会**注入 runtime context / skill catalog，
  // 使消息表非空 ⇒ 容器会发一个真请求、与 agent 重复劳动，而且它那条 turn 开着时插件写不进
  // "一等回复"（实测决策日志：`answer.deferred-open-turn`）。
  //
  // **必须用 `{kind:'reject'}`，不能用 `{kind:'enter', messages: []}`**（实测踩到）：
  // 链上还有一堆 `agent/pre-step` 监听器（skill 目录、time context、agent-instructions、
  // tmux-context、plan-mode、session-reference、hooks…），它们的写法一律是
  // `const decision = await next(); … return {...decision, messages: [...decision.messages, ...注入]}`
  // —— 也就是说**空消息表会被它们逐个追加回来**，step 照跑（E2E 里容器仍然发了
  // `request/header`）。而它们**每一个**都显式短路 reject：`if (decision.kind === 'reject') return decision`。
  // 所以 reject 是唯一能穿透整条链的形状。
  //
  // loop 收到 reject 后走 `turnEnds = {kind:'blocked'}` ⇒ **不跑 step、不发模型请求、
  // 不产出自己的回复**；被 claim 的那条用户消息也"既不被丢弃、也不再作为 user/message
  // 发出"（`agent/inbox/claimed` 的文档）——它由插件写进容器转写并交给 agent。
  ctx.on('agent/pre-step', async (payload, next) => {
    // 排障追踪（`DSH_AUTOFORK_TRACE=1` 才写日志）：`agent/pre-step` 是 loop 进 step 之前的必经
    // waterfall，而它前面还有一次 `systemPrompt.assemble`。若链上某个监听器永不 settle，
    // 症状就是"日志里 turn/start 有了、消息也被 claim 了，但永远没有 step/start"——
    // 而 loop 的错误被 `kick()` 静默兜住，进程外什么都看不到。有这两行才分得清是谁卡的。
    const trace = process.env.DSH_AUTOFORK_TRACE === '1'
    if (trace) debug('pre-step.enter', { agent: payload?.agent?.id, turn: payload?.turn, step: payload?.step })
    if (params.containerMode !== true) {
      const decision = await next()
      if (trace) debug('pre-step.exit', { agent: payload?.agent?.id, turn: payload?.turn, kind: decision?.kind })
      return decision
    }
    const agent = payload?.agent
    if (agent === undefined) return next()
    // agent（实例）照常跑；只有容器参与判定。
    if (isInstanceSession(agent)) return next()
    // **只中和"没有用户消息可答"的那一步**：分叉时插件已经把用户消息从 inbox 抢走
    // （`routeToInstance` 的 CAS），这一步就没有任何东西要回答——若放它过去，
    // loop 会因为别的监听器注入的 runtime context / skill catalog 而发一个空转的模型请求。
    // 反之，**有用户消息时一律放行**：那时容器自己就该作答（笔记："正常的一次 agent 反馈后的
    // 用户指令不会 branch，因为已经可以立即响应了"）。
    const claimed = Array.isArray(payload.messages) ? payload.messages : []
    const answerable = claimed.some(entry => entry?.source?.kind === 'user')
    if (answerable) return next()
    debug('container.pre-step-neutralized', {
      container: agent.id, turn: payload.turn, step: payload.step, dropped: claimed.length,
    })
    return { kind: 'reject' }
  })

  /**
   * 这条会话是不是**实例**（而不是容器）。
   *
   * 判据用持久事实而不是内存记录，因为要能挡住"还没登记就先收到消息"的瞬间：
   *  · 本插件建的实例：`header.parentSession` 指向容器；
   *  · 官方 subagent：`header.origin === 'subagent'`；
   *  · 兜底：它已经在 `recordByHead` 里（是本插件的某条实例）。
   *
   * 语义上就是用户那句："容器 = 你新建的那条顶层会话；实例 = 它里面的 agent"。
   * @param {any} agent 待判定的 agent。
   * @returns {boolean} 是否是实例。
   */
  function isInstanceSession(agent) {
    if (agent === undefined) return true
    const header = agent.session?.header
    if (header?.origin === 'subagent') return true
    if (header?.parentSession !== undefined) return true
    return recordByHead.has(agent.id)
  }

  /**
   * 这个容器名下**还活着**的实例数。
   *
   * 不能用 `activeFamilyCount()`：链式那套沿 `recordByWorker` 单向走，而容器模式下
   * 一个容器有**多个**实例（只有一个是绑定的），所以那样数永远只有 1，等于上限失效
   * ——用户连发几条消息就会堆出一串实例。
   * @param {string} containerId 容器会话 id。
   * @returns {number} 活跃实例数。
   */
  function activeInstanceCount(containerId) {
    pruneRecords()
    return instancesOf(containerId).filter(record => ctx.agents.get(record.headId) !== undefined).length
  }

  /**
   * **容器模式的分发**：用户消息 → 绑定的实例；绑定实例在忙 → 新建实例并重绑。
   *
   * 与链式分叉的三点区别：
   *  ① 不看 `agent.status`——容器空闲时也要交给实例（容器自己不跑 turn 才成立）；
   *  ② 消息落进**容器的日志**（`user/message` + surfaceOp），否则用户看不到自己说的话
   *     ——真实实现里 loop 是在 `preStep` 消费 inbox 时才 append 的，我们把消息抢走了，
   *     它永远不会被消费，也就永远不会显示；
   *  ③ 焦点不动（`handoffPending` 在容器模式下恒为 false）。
   *
   * @param {any} container 容器 agent。
   * @param {any} message 刚进 inbox 的用户消息。
   * @returns {Promise<void>} 分发完成。
   */
  async function routeToInstance(container, message) {
    // **触发规则（用户 2026-09-11 纠正，笔记原文）**：
    //   "自动 branch 只会发生在 agent 处于**无法立刻被打断**的情况下（也就是同步执行的时候），
    //    而在**正常的一次 agent 反馈后的用户指令不会 branch**，因为已经可以立即响应了。"
    // 所以**空闲的容器自己作答**，绝不建 agent —— 早期版本把"每条消息都交给 agent"当成了
    // 容器模式的前提，那等于把"自动分叉"改成了"永远分叉"，违背了 branch 的定义。
    if (container.status !== 'running') {
      debug('container.idle-answers', { container: container.id, status: container.status })
      return
    }
    const bound = boundRecordOf(container.id)
    const instance = bound === undefined ? undefined : ctx.agents.get(bound.headId)
    if (bound !== undefined && instance !== undefined && instance.status !== 'running') {
      // 绑定的实例空闲 → 直接给它继续对话（不新建实例）。
      if (container.inbox.remove(message.id) !== true) {
        debug('container.cas-lost', { container: container.id, messageId: message.id })
        return
      }
      showUserMessage(container.session, message)
      instance.followup(message)
      debug('container.routed', { container: container.id, instance: bound.headId })
      return
    }
    // 没绑定过，或绑定的实例正在忙 → 新建实例并重绑（"容器允许更换 driver"）。
    const rebind = bound !== undefined
    if (activeInstanceCount(container.id) >= params.maxActiveBranches) {
      // 撞上限：**绝不吞掉用户指令**。退回"排队给当前绑定的实例"——用户要等，但话不丢。
      if (instance !== undefined && container.inbox.remove(message.id) === true) {
        showUserMessage(container.session, message)
        instance.followup(message)
        debug('container.cap-queued', {
          container: container.id, instance: bound.headId, cap: params.maxActiveBranches,
        })
        return
      }
      debug('skip.family-cap', { agent: container.id, cap: params.maxActiveBranches })
      return
    }
    const cut = seedCut(container.session)
    if (container.inbox.remove(message.id) !== true) {
      debug('container.cas-lost', { container: container.id, messageId: message.id })
      return
    }
    try {
      await spawnHead(container, message, ctx.sessionProjections.stateOf(container.session, 'turnBoundary'), cut, { rebind })
      showUserMessage(container.session, message)
      debug('container.spawned', { container: container.id, rebind })
    } catch (error) {
      // 失败必须把消息放回原投递路径——绝不静默吞掉用户指令。
      container.inbox.append('next-step', message)
      debug('container.spawn-failed', { container: container.id, error: String(error), stack: error?.stack })
    }
  }

  /**
   * 把用户刚说的话写进容器日志（容器模式下必须由插件代写）。
   *
   * 为什么不能等 loop 写：真实实现里 `user/message` 是在 `preStep` 把 inbox 消息
   * **消费掉**的那一刻才 append 到 surface 的（`dsh-agent-loop` 里那一句
   * `for (const message of decision.messages) this.session.append('user/message', …)`）。
   * 容器模式把消息抢走投给了实例，容器自己的 loop 永远不会消费它，于是用户会看不到
   * 自己刚发的话——转写里凭空少一条。
   * @param {any} session 容器 session。
   * @param {any} message 用户消息（inbox 里的原始对象）。
   * @returns {void}
   */
  function showUserMessage(session, message) {
    try {
      session.append('user/message', message, { surfaceOp: 'append' })
    } catch (error) {
      debug('container.show-user-failed', { error: String(error) })
    }
  }

  /**
   * 当前 step 已运行的毫秒数；无法判定时返回 undefined（视为不构成门槛）。
   * @param {any} session 源 session。
   * @param {any} projection TurnBoundaryProjection。
   * @returns {number | undefined} 已运行毫秒数。
   */
  function currentStepAgeMs(session, projection) {
    const boundary = projection.lastStepBoundary
    if (boundary === null || boundary.kind !== 'start') return undefined
    const event = session.eventAt(boundary.seq)
    if (event?.time === undefined) return undefined
    return Date.now() - event.time
  }

  /**
   * 计算 seed：**只**取"最后一个 `turn/end` 及其之前"的事件。
   *
   * 没有已完成的 turn（自动分叉的**主场景**：第一个 turn 还在跑）⇒ **空 seed**，
   * 等价于全新子会话（对齐官方 `subagent-fork-in-process`）。
   *
   * ⚠️ 这里**曾经**合成过一段"把在飞 turn 里的用户消息带过去"的前缀，**已撤回**
   * （用户 2026-09-11 纠正）：那会造成**同一条消息被继承一次、又被在飞摘要渲染一次**，
   * 而且违背笔记的规则——"继承当前 session 的所有状态和模型上下文，但**最后一个 step
   * （当前进行中的模型生成或者工具的执行）不继承**"。当前 turn 正属于"不继承"的那部分，
   * 它的内容**只由 `renderInFlightDigest` 承载**（digest 里那条 `[用户] …` 固定行就是它），
   * 所以既不该继承、也不需要过滤 digest。
   *
   * @param {any} session 源 session。
   * @returns {{seed: any[]}} seed（可为空数组）。
   */
  function seedCut(session) {
    const events = session.snapshotEvents()
    const lastEnd = events.findLast(event => event?.type === 'turn/end')
    if (lastEnd === undefined) {
      debug('seed.empty', { session: session.id, reason: 'no-completed-turn' })
      return { seed: [] }
    }
    return { seed: events.slice(0, lastEnd.seq + 1) }
  }

  /**
   * 把 agent 自己的 `subagent/descriptor` 接在 seed 之后（对齐官方
   * `seedDescriptorTurn(childId, seed, descriptor)`：用 `Session.create` 暂存，由它分配
   * seq 并施加与持久化同一套无损 JSON 规则）。
   *
   * 关键：描述符的 seq 必须 = **继承前缀长度**（= agent 自己的第一个 seq），
   * 所以传给 `create()` 的 `inheritedEventCount` 是前缀长度，不是 seed 长度。
   * @param {string} childId agent 的会话 id。
   * @param {any[]} prefix 继承的已完成前缀（可为空）。
   * @param {Record<string, unknown>} descriptor 描述符载荷。
   * @returns {any[]} 完整 seed。
   */
  function seedChildDescriptor(childId, prefix, descriptor) {
    try {
      // 前缀为空时传 `undefined`（不是 `[]`）：`Session` 只在 `seed !== undefined` 时补
      // `session/end-seed` 边界，传空数组会凭空多一个边界事件。
      const staged = Session.create(childId, prefix.length === 0 ? undefined : prefix)
      staged.append('subagent/descriptor', descriptor)
      return staged.snapshotEvents()
    } catch (error) {
      debug('descriptor.stage-failed', { childId, error: String(error) })
      return prefix
    }
  }

  /** agent 的 durable 描述符载荷（`provider` 只用于冷恢复反查后端）。 */
  function childDescriptor(selection) {
    return {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: params.instanceProvider,
      label: params.instanceLabel,
      ...(selection?.provider === undefined ? {} : { agentProvider: selection.provider }),
      ...(selection?.model === undefined ? {} : { agentModel: selection.model }),
    }
  }

  /* ------------------------------ 建 head ------------------------------ */

  /**
   * 在最后一个已完成 turn 上 fork 出 head，注入上下文与提示，并把接管关系登记进链。
   *
   * **不中止 worker 的任何东西**：它在飞 turn、在飞 step 全部原样继续。
   * @param {any} worker 被接管的 agent（继续在后台跑）。
   * @param {any} message 从它 inbox 摘下的用户消息。
   * @param {any} projection worker 的 TurnBoundaryProjection。
   * @param {{seed: any[]}} cut 预先算好的 seed。
   * @returns {Promise<void>} 完成后 head 已在运行。
   */
  async function spawnHead(worker, message, projection, cut, options = {}) {
    const session = worker.session
    const events = session.snapshotEvents()
    const { seed } = cut
    // 容器模式：这是容器名下的又一条实例（driver 重绑），容器自己永远是 driver 之外的角色。
    const containerMode = params.containerMode === true
    const rebind = options.rebind === true

    const turnStartIndex = events.findIndex(
      event => event?.seq === projection.openTurnStartSeq,
    )
    const inFlight = turnStartIndex < 0 ? [] : events.slice(turnStartIndex)

    const headId = `session-${randomUUID()}`
    const workerCtx = worker.ctx
    const selection = currentSelection()

    // 继承的是旧会话**最后一个 `turn/end` 之前**的全部事件（笔记："继承当前 session 的
    // 所有状态和模型上下文，但最后一个 step（正在进行的生成或工具执行）不继承"）。
    // `inheritedEventCount` 是这条分界线，也是 header 里 `seedLength` 的来源。
    const inheritedEventCount = SessionLogOffset(seed.length)
    // 容器模式下 agent 是自己的子会话 ⇒ seed 末尾要带它自己的 `subagent/descriptor`
    // （`inheritedEventCount` 仍是**前缀**长度，见 seedChildDescriptor 的注释）。
    const fullSeed = containerMode
      ? seedChildDescriptor(headId, seed, childDescriptor(selection))
      : seed

    const record = {
      headId,
      workerId: session.id,
      // **建分叉的时刻**：树里的兄弟顺序按它排（必须稳定，否则每次重启画的树都不一样）。
      // 「分叉」页签也把它当"这次分叉发生在什么时候"显示。
      createdAt: Date.now(),
      // 触发这次分叉的那条用户指令（有界一行）。页签要用它回答"这条分叉是为什么来的"——
      // 同族的几条第名字一样（都是 `<标记><序号> <家族根名>`），只有这条指令能区分。
      trigger: messageText(message, TRIGGER_MAX_CHARS),
      // 容器模式下**永不**把用户切走：容器就是用户所在的会话，driver 换人不换容器。
      // 非容器模式才是"容器前移"（见 params.followHead 的注释）。
      handoffPending: containerMode ? false : params.followHead === true,
      // 是否当前绑定在容器上的实例（容器模式用；重绑时旧记录置 false 但仍留在
      // `recordByHead` 里，供 family/工具/健康探针看到全部实例）。
      bound: true,
      endedAt: undefined,
      dispose: undefined,
    }
    // 重绑：旧绑定记录让位（不移除——它是容器的一个实例，仍然在跑/可查看）。
    const previous = recordByWorker.get(session.id)
    if (previous !== undefined) previous.bound = false
    recordByHead.set(headId, record)
    recordByWorker.set(session.id, record)
    debug('spawn.begin', {
      head: headId, worker: session.id, seedLength: seed.length, inherited: inheritedEventCount, inFlight: inFlight.length,
    })

    let handle
    try {
      handle = await ctx.agents.create({
        sessionId: headId,
        // 标记方式**取决于模式**，两种模式的正确答案是相反的：
        //
        // · **容器模式**（默认）：agent 是**容器名下的子会话**——用户在容器 C 里，
        //   A/B 都是 C 的 agent 实例（"一条 session 持有多条 agent 的 durable 记录"，
        //   记录就是 `subagent/catalog`），谁当 head 就把内容渲染进 C 的转写。
        //   所以这里必须 `origin:'subagent'` + `parentSession:C` + 写 catalog，
        //   并在 agent 自己的日志里放 `subagent/descriptor`（寻址与分类都要它）。
        // · **扁平模式**（对照）：head 自己就是用户要进去的容器，于是它必须是
        //   **普通顶层会话**——标成子会话会让用户"钻进一个子代理"、顶层容器仍是旧会话。
        meta: {
          ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
          ...(containerMode ? { parentSession: session.id, origin: 'subagent' } : {}),
          ...(fullSeed.length > 0 ? { isSeeded: true } : {}),
        },
        ...(fullSeed.length > 0
          ? { seed: fullSeed, inheritedEventCount }
          : {}),
        ...(selection === undefined
          ? {}
          : { agentOptions: { provider: selection.provider, model: selection.model } }),
        setup: (agentCtx) => {
          composeInto(agentCtx, workerCtx)
        },
      })
    } catch (error) {
      recordByHead.delete(headId)
      recordByWorker.delete(session.id)
      throw error
    }

    const head = handle.agent
    record.dispose = handle.dispose
    attachToWorkspace(headId, session.header)

    // 命名：`⑂1 <家族根名>`（用户 2026-09 定的形状，见 params.titleMark）。
    // 放在建完 agent **之后**：`rename` 要求 session 在 store 里是活的，而 `agents.create`
    // 正是把它登记进去的那一步。失败只降级成"不命名"，绝不打断分叉。
    const naming = await assignBranchTitle(session, head.session)
    if (naming !== undefined) {
      record.title = naming.title
      record.titleOrdinal = naming.ordinal
      record.titleBase = naming.base
    }

    // **把血缘落盘**（DSH 官方存储域，见 src/lineage.mjs）。
    //
    // 这是"重启后关系不丢"的全部依据：内存记录随进程消失，而这条边不消失。写的是
    // **分叉那一刻的既成事实**（谁接管了谁、序号、基名、时间），不依赖别的会话还在不在。
    // 它在 `assignBranchTitle` 之后写，因为序号/标题正是那时定下的。
    //
    // 失败只降级（本条边只在内存里活着），绝不影响分叉。
    if (lineage !== undefined) {
      await lineage.remember(headId, {
        workerId: session.id,
        rootId: naming?.rootId ?? familyRootOf(session.id),
        ordinal: naming?.ordinal ?? 0,
        base: naming?.base ?? '',
        title: naming?.title ?? '',
        createdAt: record.createdAt,
        trigger: record.trigger,
      })
    }

    // 容器模式：往**容器日志**写一条 `subagent/catalog`，把这条 agent 登记成容器的实例
    // （客户端的实例树据此渲染 label / mode / 实时 activity / 可点入）。这是"一条 session
    // 持有多条 agent 的 durable 记录"里那份"记录"。
    // 扁平模式不写：那种模式下 head 是用户的容器本体，不是谁的子会话。
    if (containerMode) {
      try {
        const header = head.session.header
        session.append('subagent/catalog', {
          version: SUBAGENT_CATALOG_VERSION,
          childId: header.id,
          childCreatedAt: header.createdAt,
          mode: 'continuable',
          label: params.instanceLabel,
        })
        debug('catalog.written', { container: session.id, instance: headId, label: params.instanceLabel })
      } catch (error) {
        debug('catalog.failed', { container: session.id, instance: headId, error: String(error) })
      }
    }

    // head 的上下文：分叉通知（点名 worker 正在动的文件）+ 在飞 turn 的 digest。
    head.inject(contextMessage(renderForkNotice({
      params,
      branchId: headId,
      siblingId: session.id,
      cwd: session.header.cwd,
      targets: activeTargets(inFlight),
    }), `你已接手这个对话；${driverLabel(session.id)} 的后台工作仍在继续`))
    if (inFlight.length > 0) {
      head.inject(contextMessage(renderInFlightDigest({
        events: inFlight,
        params,
        siblingId: session.id,
      }), `在飞上下文摘要：${driverLabel(session.id)} 的 ${inFlight.length} 个事件`))
    }
    head.followup(message)

    // 容器模式：在容器里插一行折叠通知，说明"现在由谁回答"。
    // 只在**绑定变化**时插（首次 + 每次重绑），答复本身不挂来源前缀——答复要读起来像
    // "容器给你的话"，而不是每条都带一个第三方标签。
    if (containerMode && params.rebindNotice === true) {
      try {
        session.append('user/message', contextMessage(
          `[容器] 现在由 ${driverLabel(headId)}（会话 ${headId}）负责回答你。`
            + (rebind
              ? `前一个实例 ${driverLabel(previous?.headId ?? '')} 仍在后台跑它没做完的那一轮，不会被中止。`
              : '它在后台工作，产出会出现在这条对话里。'),
          rebind ? `已切换到 ${driverLabel(headId)} 回答` : `现在由 ${driverLabel(headId)} 回答`,
        ), { surfaceOp: 'append' })
      } catch (error) {
        debug('container.notice-failed', { container: session.id, error: String(error) })
      }
    }

    // worker 的提示：**不改变方向**，只要求它把最后一条回复写成简短总结——
    // 因为 head 只会收到那一条回复。经 inject() 投递，落在它下一个 step，不打断在飞步骤。
    // 容器模式：**不要**往容器里 inject 这条提示 —— 容器的 step 被中和（见 pre-step 闸门），
    // 注进去只会被 claim 掉、在日志里留一条无意义的 spliced；而且容器不干活，没有"当前的活"
    // 要它继续。这条提示只在扁平/链式模式下有意义（那时 worker 真的在跑）。
    if (!containerMode) {
      worker.inject(contextMessage(
        renderBranchHint({ headId }),
        `已分叉：${driverLabel(headId)} 接走了下一条消息，你继续当前的活`,
      ))
    }

    debug('spawn.done', { head: headId, worker: session.id })
    ctx.logger?.info?.(`[dsh-autofork] ${session.id} 被 ${headId} 接管（在飞 turn 补偿 ${inFlight.length} 个事件）`)
  }

  /**
   * 把 head 挂进 worker 所在的 workspace（官方 fork 一定会做；漏了客户端侧边栏看不到它）。
   * @param {string} headId 新会话 id。
   * @param {any} sourceHeader worker 的 header。
   * @returns {void}
   */
  function attachToWorkspace(headId, sourceHeader) {
    if (workspaceRegistry === undefined) return
    try {
      const workspace = workspaceRegistry.list()
        .find(candidate => candidate.sessionIds.includes(sourceHeader.id))
      if (workspace === undefined) {
        debug('workspace.not-found', { headId, worker: sourceHeader.id })
        return
      }
      void Promise.resolve(workspace.attachSession(headId)).then(
        () => debug('workspace.attached', { headId, workspaceId: workspace.id }),
        (error) => debug('workspace.attach-failed', { headId, error: String(error) }),
      )
    } catch (error) {
      debug('workspace.attach-threw', { headId, error: String(error) })
    }
  }

  /* ------------------------------ worker 的回复流向 head ------------------------------ */

  // 全局订阅 + 按 workerId 过滤，而不是在每个 worker 的 scoped ctx 上订阅。
  // agent 事件按 scope carrier 派发，scoped 订阅是否收到取决于 carrier 关系；
  // 全局订阅是官方协调型插件（agent-team / schedule）的通行做法。
  // loop 的失败在进程外不可见（`kick()` 静默兜住）。本插件会往 loop 里插手，所以把它的
  // 错误落到决策日志里——没有这条，排障时就只能看到"turn 开着但没有 step"。
  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    debug('agent.error', { agent: agent?.id, turn, step, error: String(error) })
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    // 容器模式下没有"worker 回注"这回事：容器不是 worker（它不跑 step），
    // 干活的那些 agent 才是主体，它们的产出走 `writeInstanceAnswer` 写进容器。
    if (params.containerMode === true) return
    const record = recordByWorker.get(agent?.id)
    if (record === undefined) return
    if (!hasCompletedTurn(agent)) {
      debug('worker.idle-not-started', { worker: agent.id })
      return
    }
    void reportWorkerReply(agent, record).catch((error) => {
      debug('report.failed', { worker: agent.id, error: String(error) })
    })
  })

  // 实例（head）转 idle → 把它的回复回灌**容器**，使容器转写成为统一转写。
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const asInstance = recordByHead.get(agent?.id)
    if (asInstance === undefined) return
    if (!hasCompletedTurn(agent)) return
    // 容器模式：把实例的答复写成容器里的**一等 assistant 回复**，而不是一条注入行。
    // 这是用户 2026-09 定的形态：容器 = 用户所在的会话，内容就是当前 driver 说的话。
    if (params.containerMode === true) {
      void writeInstanceAnswer(agent, asInstance).catch((error) => {
        debug('answer.failed', { instance: agent.id, error: String(error) })
      })
      return
    }
    if (params.mirrorInstanceReply !== true) return
    void mirrorInstanceReply(agent, asInstance).catch((error) => {
      debug('mirror.failed', { instance: agent.id, error: String(error) })
    })
  })

  /**
   * 容器当前开着的那个 step 的 `{turn, step}` 编号。
   * @param {any} session 容器 session。
   * @param {any} projection TurnBoundaryProjection。
   * @returns {{turn: number, step: number}|undefined} 编号，读不到时 undefined。
   */
  function openStepOf(session, projection) {
    const turn = session.eventAt(projection.openTurnStartSeq)?.data?.turn
    const boundary = projection.lastStepBoundary
    if (boundary === null || boundary.kind !== 'start') return undefined
    const step = session.eventAt(boundary.seq)?.data?.step
    if (typeof turn !== 'number' || typeof step !== 'number') return undefined
    return { turn, step }
  }

  /**
   * 把 agent 的答复追加进容器**当前开着的 step**（一等 assistant 消息，立即可见）。
   *
   * 为什么合法：`assistant/message` 的不变量是"turn/step 必须与开着的那个一致"
   * （`requireOpenStep`），并不要求这个 step 由谁开启。所以往 A 的 step 里写是合法的。
   * 为什么只在"无悬空工具调用"时做：见 {@link hasDanglingToolCall}（事实 13）。
   * @param {any} session 容器 session。
   * @param {any} instance 产出这条答复的 agent。
   * @param {{turn: number, step: number}} open 开着的 step 编号。
   * @param {string} reply 答复正文。
   * @returns {boolean} 是否写入成功。
   */
  function appendAnswerIntoStep(session, instance, open, reply) {
    const selection = currentSelection()
    try {
      session.append('assistant/message', {
        turn: open.turn,
        step: open.step,
        message: createAssistantMessage({
          content: [{ type: 'text', text: reply }],
          source: {
            kind: 'model',
            provider: selection?.provider ?? 'dsh-autofork',
            model: selection?.model ?? 'instance',
          },
        }),
      }, { surfaceOp: 'append' })
      return true
    } catch (error) {
      debug('answer.in-open-step-failed', { instance: instance.id, error: String(error) })
      return false
    }
  }

  /**
   * 往容器里插一行**立刻可见**的摘要行（悬空工具调用窗口的唯一选择）。
   *
   * 为什么只能是 `user/message`：那个窗口里插任何非 tool 消息都会破坏 provider 的
   * 配对要求（事实 13），而 `user/message` 是唯一"日志不变量无约束 + surface-eligible"
   * 的类型。呈现上限见 AGENTS.local.md 事实 15。
   * @param {any} session 容器 session。
   * @param {any} instance 产出这条答复的 agent。
   * @param {string} reply 答复正文。
   * @returns {void}
   */
  function appendAnswerNotice(session, instance, reply) {
    try {
      session.append('user/message', contextMessage(
        renderInstanceReply({
          instanceId: instance.id,
          reply,
          maxChars: params.reInjectMaxChars,
        }),
        instanceReplySummary({ instanceId: instance.id, reply }),
        'fork-answer',
      ), { surfaceOp: 'append' })
    } catch (error) {
      debug('answer.notice-failed', { instance: instance.id, error: String(error) })
    }
  }

  /**
   * 把实例这一轮的产出写成**容器日志里的一条一等 `assistant/message`**。
   *
   * 为什么可以这么写（实测过）：容器模式下容器**从不自己跑 turn**，所以它的日志里
   * 没有开着的 turn —— 插件可以替实例补一个完整的 turn 信封
   * （`turn/start → step/start → assistant/message → step/end → turn/end`），
   * 它满足全部不变量，并且 `deriveMessages()` 会把它投影成一条普通的 assistant 消息，
   * 客户端就渲染成正常的助手回复。**这正是"容器内容 = 当前 driver 的内容"**。
   *
   * 与注入行的区别（这是本模式的全部价值）：注入行是 `user/message` + `form:'notice'`，
   * 客户端按"上下文注入"渲染（客户端契约不允许插件接管 `user/message` 的渲染，
   * 见 AGENTS.local.md 事实 15）；而 assistant 行是**真正的助手回复**。
   *
   * 归属：`message.source` 只能是 `{kind:'model', provider, model}`（没有放会话 id 的位置），
   * 所以这里填**产出这段文本的那个模型**——这是事实。实例身份由容器头部的 driver 指示器
   * 与实例树承担，以及绑定变化时那一行折叠通知。
   *
   * @param {any} instance 刚转 idle 的实例 agent。
   * @param {any} record 它的记录。
   * @returns {Promise<void>} 写入完成。
   */
  async function writeInstanceAnswer(instance, record) {
    const container = ctx.agents.get(record.workerId)
    if (container === undefined) {
      debug('answer.no-container', { instance: instance.id, container: record.workerId })
      return
    }
    const { reply } = lastTurnReply(instance)
    if (reply === '') {
      debug('answer.empty', { instance: instance.id })
      return
    }
    const projection = ctx.sessionProjections.stateOf(container.session, 'turnBoundary')
    if (projection !== undefined && projection.openTurnStartSeq !== null) {
      // 容器正开着它自己的 turn（这正是"分叉"发生时的常态：容器在跑 A 的活）。
      //
      // **绝不能让用户等 A 结束才看到答复**（用户实测：那 60 秒里容器里什么都没有）。
      // 所以先试"写进容器当前那个开着的 step"：
      //   `assistant/message` 的不变量只要求 turn/step 与开着的那个一致，
      //   所以往 A 的 step 里追加一条 assistant 是合法的；
      // 唯一不合法的是**悬空工具调用窗口**（`assistant(tool_calls)` 与它的 tool/result 之间
      // 插入任何非 tool 消息，provider 会 400 —— 事实 13），那时退回"立刻插一行摘要行"
      // 并把一等回复排队，等 surface 空出来再写。
      if (!hasDanglingToolCall(container.session)) {
        const open = openStepOf(container.session, projection)
        if (open !== undefined && appendAnswerIntoStep(container.session, instance, open, reply)) {
          debug('answer.in-open-step', {
            container: record.workerId, instance: instance.id, turn: open.turn, step: open.step,
          })
          return
        }
      }
      // 悬空工具调用窗口：先给用户一行**立刻可见**的摘要行（正文承载要点），
      // 同时把一等回复排队，等容器 turn 结束补写——**绝不丢**。
      appendAnswerNotice(container.session, instance, reply)
      const queuedAnswer = deferredAnswers.get(record.workerId)
      if (queuedAnswer === undefined) deferredAnswers.set(record.workerId, [instance.id])
      else queuedAnswer.push(instance.id)
      debug('answer.deferred-open-turn', { container: record.workerId, instance: instance.id })
      return
    }
    const turn = (projection?.lastTurn ?? 0) + 1
    const step = 1
    const selection = currentSelection()
    try {
      container.session.append('turn/start', { turn })
      container.session.append('step/start', { turn, step })
      container.session.append('assistant/message', {
        turn,
        step,
        message: createAssistantMessage({
          content: [{ type: 'text', text: reply }],
          source: {
            kind: 'model',
            provider: selection?.provider ?? 'dsh-autofork',
            model: selection?.model ?? 'instance',
          },
        }),
      }, { surfaceOp: 'append' })
      container.session.append('step/end', { turn, step })
      container.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      debug('answer.written', {
        container: record.workerId, instance: instance.id, turn, chars: reply.length,
      })
    } catch (error) {
      debug('answer.write-failed', { container: record.workerId, instance: instance.id, error: String(error) })
    }
  }

  // 容器转 idle → 把**当时被延后**的镜像补落盘。
  //
  // 为什么需要这一步（不是多余的保险）：镜像撞上悬空工具调用时改走 `inject()`，它落在
  // 容器的**下一个 step 起点**。若那个工具失败、turn 就此结束，容器可能再也没有下一个
  // step——消息会一直躺在 inbox 里等下一次用户输入，转写里就一直看不到实例的产出。
  // 容器 idle ⇒ 不变量保证没有开着的 step（`turn/end` 在 openStep !== null 时会失败），
  // 所以这一刻追加**一定安全**，是补落盘的最佳时机。
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    // 先补写"容器开着 turn 时排队的 agent 答复"。
    const queuedAnswers = deferredAnswers.get(agent?.id)
    if (queuedAnswers !== undefined) {
      deferredAnswers.delete(agent.id)
      for (const instanceId of queuedAnswers) {
        const instance = ctx.agents.get(instanceId)
        const record = recordByHead.get(instanceId)
        if (instance === undefined || record === undefined) continue
        void writeInstanceAnswer(instance, record).catch((error) => {
          debug('answer.flush-failed', { instance: instanceId, error: String(error) })
        })
      }
    }
    const pending = deferredByContainer.get(agent?.id)
    if (pending === undefined) return
    deferredByContainer.delete(agent.id)
    for (const message of pending) {
      if (isOnSurface(agent.session, message)) {
        // 已经被下一个 step 起点吃掉，不必也不该再追加。
        debug('mirror.flush-skipped', { container: agent.id, messageId: message.id })
        continue
      }
      try {
        agent.session.append('user/message', message, { surfaceOp: 'append' })
        debug('mirror.flushed', { container: agent.id, messageId: message.id })
      } catch (error) {
        debug('mirror.flush-failed', { container: agent.id, error: String(error) })
      }
    }
  })

  /**
   * 这条消息是否已经在 surface 上（模型侧投影里出现）。
   *
   * 用于"补落盘"去重：`inject()` 投递的消息会在下一个 step 起点被 append 到 surface，
   * 此时再追加一次就是重复注入。判据取消息自身 `id`，因为 append 与 inject 用的是
   * **同一个 message 对象**。
   * @param {any} session 目标 session。
   * @param {any} message 待查消息。
   * @returns {boolean} 是否已在 surface 上。
   */
  function isOnSurface(session, message) {
    try {
      return session.deriveMessages().some(candidate => candidate?.id === message.id)
    } catch {
      // 读不到投影时按"已在 surface 上"处理：宁可不补，也不要重复注入。
      return true
    }
  }

  /**
   * 该会话是否真的跑完过至少一个 turn。
   * @param {any} agent 会话 agent。
   * @returns {boolean} 日志里存在 `turn/end`。
   */
  function hasCompletedTurn(agent) {
    try {
      return agent.session.snapshotEvents().some(event => event?.type === 'turn/end')
    } catch {
      return false
    }
  }

  /**
   * 取 worker 最后一个 turn 的**最后一条 assistant 回复**，注入给 head。
   * @param {any} worker worker agent。
   * @param {any} record 接管记录。
   * @returns {Promise<void>} 注入完成。
   */
  /**
   * 取一个 agent 最后一个 turn 的**最后一条 assistant 文本**与步数。
   * @param {any} agent 任意 agent。
   * @returns {{reply: string, stepCount: number}} 最后回复与步数。
   */
  function lastTurnReply(agent) {
    const events = agent.session.snapshotEvents()
    let turnStart = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/start') {
        turnStart = index
        break
      }
    }
    const turnEvents = turnStart < 0 ? [] : events.slice(turnStart)
    let reply = ''
    let stepCount = 0
    for (const event of turnEvents) {
      if (event?.type === 'step/start') stepCount += 1
      const message = event?.type === 'assistant/message' ? event.data?.message : undefined
      const text = (message?.content ?? [])
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join(' ')
        .trim()
      if (text !== '') reply = text
    }
    return { reply, stepCount }
  }

  /**
   * 把实例（head）的回复追加进**容器**日志，使容器转写成为统一转写。
   *
   * **必须避开"悬空工具调用"窗口**（用户实测抓到的真 bug）：容器的 surface 上一旦已经
   * 出现 `assistant(tool_calls)` 而它的 `tool/result` 还没落盘，此时追加**任何**
   * `user/message` 都会把这一对拆开，provider 直接拒：
   *
   *     An assistant message with 'tool_calls' must be followed by tool messages
   *     responding to each 'tool_call_id'. (insufficient tool messages following
   *     tool_calls message)
   *
   * 起因是把"`user/message` 在**日志不变量**里无约束"误读成"在**转写顺序**里也无约束"
   * ——前者确实没有，后者被 provider 强制。窗口正好是"工具正在跑"的那段，也就是容器
   * 本来就没反应的那段，因此落到下一个 step 起点不损失可用性，反而读起来更顺
   * （工具结果与实例产出一起来）。
   *
   * 安全时仍直接 `append`：`user/message` 是 surface-eligible，必须显式带
   * `{ surfaceOp: 'append' }`，否则抛 `requires a surfaceOp marker`（自测抓到）。
   *
   * @param {any} instance 实例 agent。
   * @param {any} record 接管记录。
   * @returns {Promise<void>} 追加完成。
   */
  async function mirrorInstanceReply(instance, record) {
    const { reply } = lastTurnReply(instance)
    const container = ctx.agents.get(record.workerId)
    if (container === undefined) {
      debug('mirror.no-container', { instance: instance.id, container: record.workerId })
      return
    }
    const text = renderInstanceReply({
      instanceId: instance.id,
      reply,
      maxChars: params.reInjectMaxChars,
    })
    // `kind: 'fork-answer'`：行的来源标签由客户端取 `source.kind` 显示（未知 kind 按原样
    // 显示，见 `contextProvenance` 的 default 分叉），所以这一改让那一行不再写着泛化的
    // 插件名 `dsh-autofork`，而是它真实的身份——一条**分叉答复**。
    //
    // 为什么不做成"一等 assistant 回复"：客户端里 `user/message` 由 ui-chat 的
    // `input-message` 定义**独占**渲染（它按 `source.kind` 内部分叉），而事件派发是
    // **所有匹配的定义都发布**（`dispatchInput` 遍历全部 entries 并逐个 accept），插件再注册
    // 一个匹配 `user/message` 的定义只会**多渲染一行**，拿不到接管权。`assistant/message`
    // 则需要开着的 step、且插进 tool_calls 与 tool_result 之间同样是非法顺序——都走不通。
    // 所以能改善的只有 content 文案与 source 形态，这个上限是客户端契约给的。
    const message = contextMessage(
      text,
      instanceReplySummary({ instanceId: instance.id, reply }),
      'fork-answer',
    )
    if (params.mirrorDelivery === 'safe' && hasDanglingToolCall(container.session)) {
      // 走 inbox → 下一个 step 起点落盘。**不能**用 followup：容器正忙，followup 只会
      // 再塞一条 next-turn 消息，而我们要的是"接在当前 turn 的下一步"。
      container.inject(message)
      // 同时入队：万一容器再没有下一个 step（工具失败、turn 就此结束），
      // 由 idle 时的那次补落盘兜住。
      const queued = deferredByContainer.get(container.id)
      if (queued === undefined) deferredByContainer.set(container.id, [message])
      else queued.push(message)
      debug('mirror.deferred', {
        instance: instance.id, container: record.workerId, chars: text.length,
      })
      return
    }
    container.session.append('user/message', message, { surfaceOp: 'append' })
    debug('mirror.appended', {
      instance: instance.id, container: record.workerId, chars: text.length, hadReply: reply !== '',
    })
  }

  /**
   * surface 末尾是否留着一个**没有结果的工具调用**。
   *
   * 判据取 `deriveMessages()`（模型真正读到的投影）而不是原始事件：要防的是 provider 的
   * 消息形状约束，所以看的必须是"投影之后"的顺序。倒着找最近一条 assistant：
   *   · 它没有 tool-call 部件 → 在它后面追加 user/message 合法；
   *   · 它有 → 查它**之后**有没有工具结果消息按 `source.callId` 应答。
   *
   * ⚠️ **工具结果消息的 `role` 是 `'user'`，不是 `'tool'`**（用户实测的落盘日志里
   * `tool/result` 的 message 是 `{role:'user', source:{kind:'tool', callId}}`）。
   * `Message.role` 的取值域只有 `'system' | 'user' | 'assistant'`——第一版按
   * `role === 'tool'` 判定，在真实数据上永远配不上对，等于把安全性判据写成了恒真。
   * 认工具结果只能认 `source.kind === 'tool'`。
   *
   * @param {any} session 目标 session。
   * @returns {boolean} 是否存在悬空调用。
   */
  function hasDanglingToolCall(session) {
    let messages
    try {
      messages = session.deriveMessages()
    } catch (error) {
      // 投影不可读时保守判定为"不安全"：宁可延迟显示，也不能写坏容器转写。
      debug('mirror.derive-failed', { error: String(error) })
      return true
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'assistant') continue
      const calls = (message.content ?? []).filter(part => part?.type === 'tool-call')
      if (calls.length === 0) return false
      const answered = new Set()
      for (const later of messages.slice(index + 1)) {
        const callId = later?.source?.callId
        if (later?.source?.kind === 'tool' && typeof callId === 'string') answered.add(callId)
      }
      return calls.some(call => !answered.has(call.id))
    }
    return false
  }

  async function reportWorkerReply(worker, record) {
    const { reply, stepCount } = lastTurnReply(worker)

    const text = renderWorkerReply({
      workerId: worker.id,
      reply,
      stepCount,
      maxChars: params.reInjectMaxChars,
    })

    const head = ctx.agents.get(record.headId)
    if (head === undefined) {
      debug('report.no-head', { worker: worker.id, head: record.headId })
      return
    }
    debug('report.inject', {
      worker: worker.id, head: record.headId, headStatus: head.status,
      chars: text.length, hadReply: reply !== '',
    })
    if (head.status === 'idle' && params.wakeForegroundOnTurnEnd) {
      head.followup(contextMessage(text, `${driverLabel(worker.id)} 的回复`))
    } else {
      head.inject(contextMessage(text, `${driverLabel(worker.id)} 的回复`))
    }
  }

  /* ------------------------------ 分叉调度工具 ------------------------------ */

  // 工具面是可选能力：`tools` 服务缺席时（极简组合）不注册，核心分叉照常工作。
  ctx.inject(['tools'], (toolsCtx) => {
    if (params.exposeDispatchTools !== true) return
    const dispatchTools = createBranchTools({
      defineTool,
      // 读取家族的路径先等血缘域装载完一次，这样**重启后**也能看到持久化下来的关系
      // （内存记录是空的，但边还在）。
      related: async (callerId) => {
        await settleLineage()
        return relatedSessions(callerId)
      },
      steer: async (callerId, targetId, text) => {
        await settleLineage()
        if (!isFamilyMember(callerId, targetId)) {
          return { ok: false, detail: `"${targetId}" 不在你的家族里；先用 fork_list 查看。` }
        }
        const target = ctx.agents.get(targetId)
        if (target === undefined) return { ok: false, detail: `会话 "${targetId}" 已不在运行。` }
        target.steer(contextMessage(text, `来自 ${callerId} 的中途指令`))
        return { ok: true, detail: `已向 "${targetId}" 发送中途指令；它会在当前 step 结束后读到。` }
      },
      cancel: async (callerId, targetId, keepInbox) => {
        await settleLineage()
        if (!isFamilyMember(callerId, targetId)) {
          return { ok: false, detail: `"${targetId}" 不在你的家族里；先用 fork_list 查看。` }
        }
        const target = ctx.agents.get(targetId)
        if (target === undefined) return { ok: false, detail: `会话 "${targetId}" 已不在运行。` }
        target.cancel(
          { kind: 'hook', reason: 'dsh-autofork: 被家族里的 head 中止' },
          { keepInbox },
        )
        return { ok: true, detail: `已中止会话 "${targetId}"（keepInbox=${String(keepInbox)}）。` }
      },
    })

    const disposers = dispatchTools.map(tool => toolsCtx.tools.register(tool))
    exposedToolNames.push(...dispatchTools.map(tool => tool.name))
    toolsCtx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-autofork: 注销分叉调度工具')
  }, 'dsh-autofork: 分叉调度工具')

  /* ------------------------------ health 探针 ------------------------------ */

  // 嵌套子插件：只有 web 组合会提供 webServer。服务缺席时本函数体从不运行，
  // 因此 headless / sdk 部署里本插件照常工作（只是没有探测面与 UI 数据源）。
  ctx.inject(['webServer'], (webCtx) => {
    const healthRoute = webCtx.webServer?.register?.({
      kind: 'exact',
      path: HEALTH_PATH,
      handler: async (req, res) => {
        const json = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
        }
        if ((req?.method ?? 'GET') !== 'GET') {
          json(405, { ok: false, error: 'only GET is supported' })
          return
        }
        const query = new URL(req?.url ?? '/', 'http://localhost').searchParams
        const sessionId = query.get('sessionId')
        const consume = query.get('consume') === '1'
        const ack = query.get('ack')
        const note = query.get('note')
        pruneRecords()
        // **重启后也要看得到关系**：先等一次血缘域装载（一次性表扫描，毫秒级），
        // 之后这次请求里的同步读取（`familyNodes` / `driverView`）就都能看见持久化的边。
        await settleLineage()

        // 客户端回报（开放诊断通道）：客户端 half 跑在浏览器里，没有它这里就是纯黑盒。
        if (note !== null) debug('client.note', { note })

        // 两阶段交付：`consume` 只**提供候选**、不清标记；客户端切换成功并确认
        // `current` 真的变了之后才用 `ack` 清除，切换失败可自动重试。
        if (ack !== null) {
          const acked = recordByHead.get(ack)
          if (acked !== undefined) acked.handoffPending = false
          debug('handoff.ack', { headId: ack, found: acked !== undefined })
        }

        let handoff = null
        if (consume && sessionId !== null) {
          for (const [headId, record] of recordByHead) {
            if (record.workerId !== sessionId || record.handoffPending !== true) continue
            // `parentSessionId` 是**直接父会话**：客户端要用它取父会话的 subagent catalog，
            // 再派生 `{parentSessionId, childSessionId, mode}` 这个"durable 父地址"才能打开子会话
            // （见客户端 deliver() 的注释）。少了它，客户端只能用 `open(id)`，而那条路对
            // `origin:'subagent'` 的会话是**设计上拒绝**的。
            handoff = { sessionId: headId, parentSessionId: record.workerId }
          }
        }
        debug('health.request', {
          sessionId, consume,
          handoff: handoff === null ? undefined : handoff.sessionId,
          client: query.get('client') ?? undefined,
        })

        json(200, {
          ok: true,
          plugin: name,
          params,
          tools: exposedToolNames,
          /**
           * 家族链条（根 → 最新，含本会话自己）：客户端「分叉」页签的数据源。
           * 每项带 title / state / depth / current / parentId。
           */
          nodes: sessionId === null ? [] : familyNodes(sessionId),
          /** 当前 driver：UI 用它把"现在是谁在回答你"显出来。 */
          driver: sessionId === null ? null : driverView(sessionId),
          handoff: consume ? handoff : null,
        })
      },
    })
    if (healthRoute !== undefined) {
      webCtx.effect(() => healthRoute, 'dsh-autofork: health 路由')
    }
  }, 'dsh-autofork: health 探针')

  /* ------------------------------ 清理 ------------------------------ */

  ctx.effect(() => () => {
    for (const record of recordByHead.values()) {
      void record.dispose?.()
    }
    recordByHead.clear()
    recordByWorker.clear()
  }, 'dsh-autofork: 回收所有接管记录')
}
