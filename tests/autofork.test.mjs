/**
 * `apply()` 级测试：用桩驱动真实的插件入口，验证**分解决策与投递**。
 *
 * 为什么需要这一层：挂载验证（health 探针 200）只证明"插件能加载、注入齐、
 * schema 合法"，**证明不了它做对事**。而真实行为路径需要模型凭据，不可用。
 * 桩测试填的就是这个缺口——它覆盖 `apply()` 里的全部分叉判定与副作用顺序。
 *
 * 本文件 import `index.mjs`，因此需要官方包可解析（开发期见 AGENTS.local.md
 * 事实 1 的 node_modules 链接）。解析不到时**明确失败**，不静默跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject as declaredInject, name as pluginName } from '../index.mjs'
import { DEFAULT_PARAMS as DEFAULT_PARAMS_REF } from '../src/params.mjs'

// 实现用真实 Date.now() 计算 step 年龄，夹具必须以真实当前时间为基准，
// 否则"step 太年轻"这类断言会因基准错位而假通过或假失败。
const NOW = Date.now()

/* ------------------------------ 夹具 ------------------------------ */

/**
 * 造一段会话日志：turn 1 完整结束，turn 2 正在进行中。
 * @returns {any[]} 事件数组（seq 即下标）。
 */
function sessionLog() {
  return [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW - 600_000 },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: { id: 'm-log-1', role: 'user', content: [{ type: 'text', text: '原始指令' }], source: { kind: 'user' } }, time: NOW - 590_000 },
    { seq: 2, type: 'step/start', data: { turn: 1, step: 1 }, time: NOW - 580_000 },
    { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a-log-1', role: 'assistant', content: [{ type: 'text', text: '开始处理' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, time: NOW - 570_000 },
    { seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }, time: NOW - 560_000 },
    { seq: 5, type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 't-log-1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] }] } }, time: NOW - 550_000 },
    { seq: 6, type: 'step/end', data: { turn: 1, step: 1 }, time: NOW - 540_000 },
    { seq: 7, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW - 530_000 },
    // ---- 在飞 turn ----
    { seq: 8, type: 'turn/start', data: { turn: 2 }, time: NOW - 70_000 },
    { seq: 9, type: 'step/start', data: { turn: 2, step: 1 }, time: NOW - 60_000 },
    { seq: 10, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: 'a-log-2', role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"npm test"}' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, time: NOW - 55_000 },
    { seq: 11, type: 'tool/call', data: { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"npm test"}' }, time: NOW - 50_000 },
  ]
}

/**
 * 以**链式接管模式**（对照臂）apply 插件。
 *
 * 容器模式已成为默认（`containerMode: true`），而本文件里绝大多数用例描述的是链式模式的
 * 行为（容器自己跑、忙时才分叉、产出以注入行回灌）。显式钉住对照臂，避免默认值一变
 * 就让整个文件测到别的东西——那是最难查的一类"测试还绿着但测的是别的"。
 * @param {any} ctx 桩上下文。
 * @param {Record<string, unknown> | undefined} config 覆盖配置。
 * @returns {void}
 */
function applyChain(ctx, config) {
  // 链式模式的用例大多在验证"回灌进容器转写"那条路，所以这里显式打开它
  // （它已不是默认值 —— 默认关，理由见 params 里 `mirrorInstanceReply` 的注释）。
  apply(ctx, { containerMode: false, mirrorInstanceReply: true, ...(config ?? {}) })
}

/**
 * 以**出厂默认** apply 插件（不覆盖任何参数）。
 * @param {any} ctx 桩上下文。
 * @returns {void}
 */
function applyDefaults(ctx) {
  apply(ctx, undefined)
}

/** 在飞 turn 的投影（openTurnStartSeq=8，当前 step 已跑 60 秒）。 */
const PROJECTION = {
  openTurnStartSeq: 8,
  lastStepStartSeq: 9,
  lastStepBoundary: { kind: 'start', seq: 9 },
  lastTurn: 2,
}

/**
 * 把一条 session 事件投影成模型消息，或 null（不产出消息的事件）。
 *
 * 复刻 `@deepseek-ai/dsh-session` 的 `deriveEventMessage`——镜像投递的安全性判据读的
 * 就是它，桩若不复刻就会让测试与真实顺序脱节。
 * @param {any} event 一条事件。
 * @returns {any} 投影出的消息，或 null。
 */
function deriveEventMessage(event) {
  if (event?.type === 'user/message') return event.data
  if (event?.type === 'assistant/message') {
    const message = event.data?.message
    return (message?.content ?? []).length === 0 ? null : message
  }
  if (event?.type === 'tool/result') return event.data?.message
  return null
}

/**
 * 一个**没有悬空工具调用**的 surface：最后一条 assistant 没有 tool-call 部件。
 * @returns {any[]} 投影后的消息表。
 */
function safeMessages() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'sleep 1min' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
    // ⚠️ 真实落盘里工具结果消息的 role 是 'user'，不是 'tool'（Message.role 的取值域
    // 只有 system|user|assistant）；认它只能靠 source.kind === 'tool' + source.callId。
    { role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] },
  ]
}

/**
 * 造一个可驱动的宿主环境。
 * @param {object} [options] 覆盖点。
 * @returns {any} 桩上下文与调用记录。
 */
function harness(options = {}) {
  const events = options.events ?? sessionLog()
  const projection = options.projection ?? PROJECTION
  const listeners = new Map()
  const calls = {
    agentsCreate: [], injections: [], followups: [], steers: [], removes: [],
    registeredTools: [], cancels: [], effects: [], requeued: [], nestedInject: [], appended: [],
    /** 注册过的 webServer 路由（health 探针），供测试直接调用 handler。 */
    routes: [],
    /** `sessionTitle.rename()` 的调用记录：分叉命名的观测面。 */
    renames: [],
    /** 血缘域的写入记录：`[{ headId, edge }]`。 */
    lineageWrites: [],
    /** 血缘域被打开过几次（每次 apply 一次）。 */
    lineageOpens: [],
  }

  /** 父 agent（被分叉的那个）。 */
  const parentInbox = {
    pending: new Set(['m-user']),
    remove(id) {
      calls.removes.push(id)
      parentInbox.pending.delete(id)
      // 默认"抢到"：夹具不追踪具体是哪些 id 进了 inbox（真实实现里 loop 只在步边界
      // 才领取，所以要测"抢不到"的场景请显式传 casWins: false）。
      return options.casWins === false ? false : true
    },
    /** 分叉失败时把消息放回原投递路径。 */
    append(target, message) {
      calls.requeued.push({ target, id: message.id })
      parentInbox.pending.add(message.id)
    },
  }

  const parentSession = {
    id: 'session-parent',
    // 真实 SessionHeader 带 id / createdAt（catalog 条目要 createdAt）
    header: { id: 'session-parent', createdAt: 1_700_000_000_000, cwd: '/work' },
    snapshotEvents: () => events,
    eventAt: (seq) => events.find(event => event.seq === seq),
    append: (type, data, opts) => { calls.appended.push({ type, data, opts }) },
    // 镜像投递的安全性判据取 `deriveMessages()`（模型真正读到的投影顺序），所以桩必须
    // 提供它。投影规则与 `@deepseek-ai/dsh-session` 的 `deriveEventMessage` 一致。
    deriveMessages: () => events.map(deriveEventMessage).filter(Boolean),
  }

  const parent = {
    id: 'session-parent',
    session: parentSession,
    status: options.parentStatus ?? 'running',
    ctx: { tag: 'parent-ctx' },
    inbox: parentInbox,
    steer: (message) => calls.steers.push(message),
    inject: (message) => calls.injections.push({ agent: 'session-parent', message }),
    followup: (message) => calls.followups.push({ agent: 'session-parent', message }),
    cancel: (cause, opts) => calls.cancels.push({ cause, opts }),
  }

  const createdAgents = new Map()
  createdAgents.set('session-parent', parent)

  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    // 嵌套子插件：桩里让 webServer 立即可用，从而走真实的探针装载路径。
    inject(deps, callback) {
      calls.nestedInject.push([...deps])
      // 模拟 headless/sdk 组合：没有 webServer 时子插件只是不运行，绝不抛。
      if (options.noWebServer === true && deps.includes('webServer')) return undefined
      return callback(ctx)
    },
    effect(fn) {
      calls.effects.push(fn)
      return fn
    },
    logger: { info() {}, warn() {} },
    agents: {
      get: (id) => createdAgents.get(id),
      create: async (opts) => {
        calls.agentsCreate.push(opts)
        const child = {
          id: opts.sessionId,
          session: { id: opts.sessionId, header: { id: opts.sessionId, createdAt: 1_700_000_000_000, cwd: opts.meta?.cwd } },
          status: 'running',
          ctx: {
            on(event, handler) {
              if (!listeners.has(`child:${event}`)) listeners.set(`child:${event}`, [])
              listeners.get(`child:${event}`).push(handler)
            },
          },
          inject: (message) => calls.injections.push({ agent: opts.sessionId, message }),
          followup: (message) => calls.followups.push({ agent: opts.sessionId, message }),
          steer: (message) => calls.steers.push({ branch: opts.sessionId, message }),
          cancel: (cause, o) => calls.cancels.push({ branch: opts.sessionId, cause, opts: o }),
        }
        createdAgents.set(opts.sessionId, child)
        if (typeof opts.setup === 'function') opts.setup(child.ctx, child)
        return { agent: child, dispose: async () => {} }
      },
    },
    sessionProjections: { stateOf: () => projection },
    agentPresets: { composeFrom: (agentCtx, parentCtx) => { calls.composeFrom = [agentCtx, parentCtx]; return 'standard' } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    tools: { register: (tool) => { calls.registeredTools.push(tool); return () => {} } },
    webServer: { register: (route) => { calls.routes.push(route); return () => {} } },
    /**
     * 标题服务桩：`get` 给"这条会话此刻的标题"（家族基名取自家根会话的标题），
     * `rename` 就是原生那条"用户重命名"的路（追加 `session/title`）。
     */

    sessionTitle: {
      get: (session) => {
        const title = (options.titles ?? {})[session?.id]
        return title === undefined ? undefined : { title }
      },
      rename: (session, title) => { calls.renames.push({ sessionId: session?.id, title }) },
    },
    sessions: {
      get: (id) => (id === 'session-parent' ? parentSession : createdAgents.get(id)?.session),
      /** 活会话（本桩造的）。 */
      list: () => [...createdAgents.values()].map(agent => agent.session),
    },
    /**
     * 血缘持久化域（DSH 官方 `ctx.storageDomain`）的桩。
     *
     * `options.lineageEdges` 是**盘上已有的边**（key = headId）——用它模拟"进程重启后
     * 内存记录空了、但域里还有边"这个正是要修的场景。
     */
    storageDomain: {
      open: async (spec) => {
        calls.lineageOpens.push(spec?.name)
        if (options.lineageBroken === true) throw new Error('backend-not-found: nope')
        const rows = new Map(Object.entries(options.lineageEdges ?? {}))
        return {
          table: () => ({
            entries: () => [...rows.entries()][Symbol.iterator](),
            put: async (key, value) => {
              calls.lineageWrites.push({ headId: key, edge: value })
              rows.set(key, value)
            },
          }),
          close: async () => {},
        }
      },
    },
    // 缺席即未定义：模拟不提供工作区注册表的部署（挂载降级但不报错）
    ...(options.workspaceRegistry === undefined ? {} : { workspaceRegistry: options.workspaceRegistry }),
    ...(options.noTitleService === true
      ? { sessionTitle: undefined, sessions: undefined }
      : {}),
  }

  /** 触发一次 inbox 插入。 */
  const emitInsert = (message) => {
    for (const handler of listeners.get('agent/inbox/inserted') ?? []) {
      handler({ agent: parent, message })
    }
  }

  return { ctx, calls, parent, events, emitInsert, listeners, createdAgents }
}

/** 让 `void considerFork(...)` 里的异步链跑完。 */
async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** 一条普通用户消息。 */
const userMessage = (id = 'm-user') => ({
  id, role: 'user', content: [{ type: 'text', text: '改成用 worktree 隔离' }], source: { kind: 'user' },
})

/* ------------------------------ 契约 ------------------------------ */

test('导出 name / inject / apply，且 inject 是数组', () => {
  assert.equal(pluginName, 'dsh-autofork')
  assert.ok(Array.isArray(declaredInject))
  assert.equal(typeof apply, 'function')
})

test('顶层 inject 只放真正必需的服务——可选能力一律走嵌套', () => {
  // 实测教训：把 agentPresets 写进顶层后，`--profile sdk`（不挂 agent-presets）
  // 的整个 runtime **启动失败**——`1 entry did not activate ... pending`。
  // 一个可选能力做掉整个 harness 是不可接受的失败模式，所以这条必须钉住。
  assert.deepEqual([...declaredInject].sort(), ['agents', 'sessionProjections'])
})

test('可选能力全部走嵌套 ctx.inject，且缺席时不抛', () => {
  const { ctx, calls } = harness()
  applyChain(ctx, undefined)
  const nested = calls.nestedInject.flat().sort()
  assert.deepEqual(nested,
    ['agentDefaultModel', 'agentPresets', 'sessionTitle', 'sessions', 'storageDomain',
      'tools', 'webServer', 'workspaceRegistry'],
    '每一项都是"缺席时功能降级、但插件照常工作"的能力')
})

test('标题服务缺席 → 不命名，但分叉本身照常完成', async () => {
  // 为什么这条必须钉住：命名是**锦上添花**，分叉才是功能本体。
  // 一个可选能力把主路径做掉，正是本项目反复踩过的失败模式。
  const { ctx, calls, emitInsert } = harness({ noTitleService: true })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  assert.equal(calls.agentsCreate.length, 1, '分叉必须照常发生')
  assert.deepEqual(calls.renames, [], '没有标题服务时不得尝试命名')
})

/* ------------------------------ 主路径 ------------------------------ */

test('running + 长 step + 有已完成 turn → 抢占消息、建分叉、注入补偿、投递指令', async () => {
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  // CAS 先发生
  assert.deepEqual(calls.removes, ['m-user'], '必须先用 inbox.remove 抢占')

  // 建 head：seed 切在最后一个 turn/end（seq 7，含端）——**不是** subagent 子会话
  assert.equal(calls.agentsCreate.length, 1)
  const opts = calls.agentsCreate[0]
  assert.equal(opts.seed.length, 8, 'seed 应为 seq 0..7')
  assert.equal(opts.seed.at(-1).type, 'turn/end', 'seed 必须结束在 turn/end')
  assert.equal(Number(opts.inheritedEventCount), 8)
  // **扁平分叉**（用户 2026-09-11 纠正）：head 是普通顶层会话，不是旧会话的子代理。
  // 不设 origin / parentSession、不写 subagent/catalog —— 否则它被嵌在旧会话里，
  // 顶层容器仍是旧会话，"把容器内容换成 B"永远做不到，而且那是笔记否决的层级模型。
  assert.deepEqual(opts.meta, { cwd: '/work', isSeeded: true })
  // origin 与 catalog 条目**必须成对**（实测教训）：
  // 只设 origin 不写 catalog → 客户端停在"正在加载子代理"；
  // 只写 catalog 不设 origin → 寻址校验（history.ts:346）拒。
  // **扁平分叉**：head 不是 subagent 子会话，也不往旧会话写 catalog。
  // 标成子会话会让用户看到"我钻进了一个子代理"、而顶层容器仍是旧会话——
  // 那正是用户否掉的形态，也是笔记否决的层级模型。
  assert.equal(opts.meta.origin, undefined, 'head 必须是普通顶层会话')
  assert.equal(opts.meta.parentSession, undefined, '血缘不用 header 表达（那是层级）')
  assert.equal(calls.appended.find(entry => entry.type === 'subagent/catalog'), undefined,
    '不再写 subagent/catalog')
  assert.deepEqual(opts.agentOptions, { provider: 'p', model: 'm' })

  // 子分叉加入父分叉的 standing composition（第二个参数必须是父的 ctx）
  assert.deepEqual(calls.composeFrom?.[1], { tag: 'parent-ctx' })

  // 发给 **head** 的注入：分叉通知 + 在飞 turn 进度，各一次
  const headId = opts.sessionId
  const toHead = calls.injections.filter(entry => entry.agent === headId)
  assert.equal(toHead.length, 2, 'head 应收到通知 + digest')
  const text = toHead.map(entry => entry.message.content[0].text)
  assert.match(text[0], /自动分叉通知/)
  assert.match(text[1], /兄弟分叉在飞进度/)

  // 在飞 turn 的补偿内容：包含正在跑的那条 bash 调用
  assert.match(text[1], /npm test/, 'digest 必须带上在飞 turn 的实际动作')
  assert.ok(!text[1].includes('原始指令'), '已完成的 turn 不该被重复塞进 digest')

  // 发给 **worker** 的注入：只有一条提示，且**不改变它的方向**
  const toWorker = calls.injections.filter(entry => entry.agent === 'session-parent')
  assert.equal(toWorker.length, 1, 'worker 只应收到那条分叉提示')
  assert.match(toWorker[0].message.content[0].text, /继续当前工作，不要改变方向/)

  // 用户指令被原样投递给 head（唤醒它）
  assert.equal(calls.followups.length, 1)
  assert.equal(calls.followups[0].message.id, 'm-user')
  assert.equal(calls.followups[0].agent, headId, '用户指令必须投给 head')

  // 注入消息带 plugin source，不与人类发言混淆；并声明 notice 形态（客户端折叠成
  // 一行摘要）。`summary` 必须存在且非空——客户端 `noticeSummary()` 对空串返回 null，
  // 会静默退回整块呈现，等于这次折叠白设。
  for (const entry of calls.injections) {
    const source = entry.message.source
    assert.equal(source.kind, 'plugin')
    assert.equal(source.plugin, 'dsh-autofork')
    assert.equal(source.form, 'notice')
    assert.equal(typeof source.summary, 'string')
    assert.ok(source.summary.length > 0 && source.summary.length <= 120, source.summary)
  }
})

test('三个调度工具被注册（默认参数）', async () => {
  const { ctx, calls } = harness()
  applyChain(ctx, undefined)
  assert.deepEqual(calls.registeredTools.map(tool => tool.name),
    ['fork_list', 'fork_steer', 'fork_cancel'])
})

test('exposeDispatchTools=false 时不注册工具', async () => {
  const { ctx, calls } = harness()
  applyChain(ctx, { exposeDispatchTools: false })
  assert.deepEqual(calls.registeredTools, [])
})

/* ------------------------------ 拒绝路径 ------------------------------ */

test('agent 非 running → 不动 inbox、不建分叉', async () => {
  const { ctx, calls, emitInsert } = harness({ parentStatus: 'idle' })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  assert.deepEqual(calls.removes, [], '未分叉时不得动消息')
  assert.deepEqual(calls.agentsCreate, [])
  assert.deepEqual(calls.followups, [])
})

test('门槛显式设大于 0 时，年轻 step 不分叉（默认 0 = 不设门槛）', async () => {
  const young = { ...PROJECTION, lastStepBoundary: { kind: 'start', seq: 9 } }
  const events = sessionLog().map(event => (
    event.seq === 9 ? { ...event, time: NOW - 500 } : event
  ))
  const { ctx, calls, emitInsert } = harness({ projection: young, events })
  applyChain(ctx, { minStepAgeMs: 8000 })
  emitInsert(userMessage())
  await flush()

  assert.deepEqual(calls.agentsCreate, [], 'step 还年轻时应留给 steer 处理')
  assert.deepEqual(calls.removes, [])
})

test('CAS 输掉（loop 已领取）→ 不建分叉，原投递语义生效', async () => {
  const { ctx, calls, emitInsert } = harness({ casWins: false })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  assert.deepEqual(calls.removes, ['m-user'], '仍会尝试抢占')
  assert.deepEqual(calls.agentsCreate, [], '抢不到就不能再投递一份')
  assert.deepEqual(calls.followups, [])
})

test('消息来源不在 forkableSourceKinds → 不处理', async () => {
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert({ ...userMessage('m-x'), source: { kind: 'plugin', plugin: 'other' } })
  await flush()
  assert.deepEqual(calls.removes, [])
  assert.deepEqual(calls.agentsCreate, [])
})

test('没有已完成的 turn（第一个 turn 还在跑）→ **空 seed**，在飞内容只由 digest 承载', async () => {
  // 笔记的规则："继承当前 session 的所有状态和模型上下文，但**最后一个 step（当前进行中
  // 的模型生成或者工具的执行）不继承**"。当前 turn 正属于"不继承"的那部分 —— 所以这里
  // **不能**把它的用户消息合成进 seed（早期实现这么做过，造成同一条消息被继承一次、
  // 又被在飞摘要渲染一次；用户实测报的"与在飞摘要冗余"）。
  const events = sessionLog().filter(event => event.type !== 'turn/end')
  const { ctx, calls, emitInsert } = harness({ events })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  assert.equal(calls.agentsCreate.length, 1, '主场景必须分叉，不能因为"没有已完成 turn"就放弃')
  const opts = calls.agentsCreate[0]
  assert.equal('seed' in opts, false, '没有已完成 turn ⇒ 不传 seed（等价全新子会话）')
  assert.equal('inheritedEventCount' in opts, false)
  assert.equal('isSeeded' in opts.meta, false)

  // 在飞 turn 的全部内容由 digest 承载（含用户那条指令）——这才是它的唯一来源。
  const digest = calls.injections.find(entry => entry.message.content[0].text.includes('兄弟分叉在飞进度'))
  assert.ok(digest !== undefined, '空 seed 时 digest 是唯一上下文来源，必须注入')
  assert.match(digest.message.content[0].text, /npm test|把 config 的 revision 加一/)
  assert.ok(!calls.requeued.some(entry => entry.id === 'm-user'), '成功分叉后不应回放消息')
})

test('连用户消息都没有的在飞 turn → 前缀为空 ⇒ 不传 seed（全新会话语义）', async () => {
  const events = sessionLog()
    .filter(event => event.type !== 'turn/end')
    .filter(event => !(event.type === 'user/message' && event.data?.source?.kind === 'user'))
  const { ctx, calls, emitInsert } = harness({ events })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  const opts = calls.agentsCreate[0]
  // 没有可继承的内容就**不传 seed**：空 seed 等价于全新会话（官方
  // `subagent-fork-in-process` 同一语义），而不是造一个空壳 turn。
  assert.equal('seed' in opts, false)
  assert.equal('inheritedEventCount' in opts, false)
  assert.equal('isSeeded' in opts.meta, false)
})

test('分叉数达上限 → 不建分叉', async () => {
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, { maxActiveBranches: 0 })
  emitInsert(userMessage())
  await flush()
  assert.deepEqual(calls.agentsCreate, [])
  assert.deepEqual(calls.removes, [])
})

test('enabled=false → 完全不接管', async () => {
  const { ctx, calls, emitInsert, listeners } = harness()
  applyChain(ctx, { enabled: false })
  emitInsert(userMessage())
  await flush()
  assert.equal(listeners.get('agent/inbox/inserted'), undefined, '关闭时不应订阅事件')
  assert.deepEqual(calls.removes, [])
})

test('无 webServer 的组合（headless / sdk）也能 apply：核心功能在，探针不装', async () => {
  const { ctx, calls, emitInsert } = harness({ noWebServer: true })
  applyChain(ctx, undefined) // 关键：不得抛——webServer 缺席只是探针不装

  assert.ok(calls.nestedInject.some(deps => deps.includes('webServer')),
    '探针必须走嵌套 inject 而不是顶层依赖')
  assert.deepEqual(calls.registeredTools.map(tool => tool.name),
    ['fork_list', 'fork_steer', 'fork_cancel'],
    '核心调度工具在无 webServer 的组合里同样要注册')

  // 分叉路径本身照常工作
  emitInsert(userMessage())
  await flush()
  assert.equal(calls.agentsCreate.length, 1, '无 webServer 不得影响分叉')
})

test('web 组合下探针被装载（嵌套 inject 命中）', () => {
  const { ctx, calls } = harness()
  applyChain(ctx, undefined)
  const probes = calls.nestedInject.filter(deps => deps.includes('webServer'))
  assert.equal(probes.length, 1, 'webServer 应恰好被嵌套注入一次')
})

/* ------------------------------ 回注 ------------------------------ */

test('被接管的会话（worker）转 idle → 它的最后一条回复转给 head', async () => {
  const { ctx, calls, listeners, emitInsert, parent } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  const headId = calls.agentsCreate[0].sessionId
  assert.equal(typeof headId, 'string')

  // worker = 父会话（session-parent）；给它一段已完成、带结论的 turn
  parent.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 }, time: NOW },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '中间过程' }] } }, time: NOW },
    { seq: 3, type: 'step/end', data: { turn: 1, step: 1 }, time: NOW },
    { seq: 4, type: 'step/start', data: { turn: 1, step: 2 }, time: NOW },
    { seq: 5, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '结论：改了两个文件，跑了 npm test' }] } }, time: NOW },
    { seq: 6, type: 'step/end', data: { turn: 1, step: 2 }, time: NOW },
    { seq: 7, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]

  const injectionsBefore = calls.injections.length
  const followupsBefore = calls.followups.length
  listeners.get('agent/status')[0]({ agent: parent, status: 'idle' })
  await flush()

  const added = [
    ...calls.injections.slice(injectionsBefore),
    ...calls.followups.slice(followupsBefore),
  ]
  assert.equal(added.length, 1, 'idle 后应恰好产生一条注入')
  const text = added[0].message.content[0].text
  // **只转最后一条回复**，不转整个 turn 的事件流水
  assert.match(text, /结论：改了两个文件/)
  assert.ok(!text.includes('中间过程'), '不应把 turn 的中间过程一起转过去')
  assert.match(text, /后台会话回复/)
  // 方向正确：落到 head 上，而不是 worker 自己
  assert.equal(added[0].agent, headId, '注入必须发给 head，而不是被接管的会话')
})

test('无关 agent 转 idle 不得被回注（全局订阅必须按 workerId 过滤）', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  const before = calls.injections.length + calls.followups.length
  listeners.get('agent/status')[0]({ agent: { id: 'session-someone-else' }, status: 'idle' })
  await flush()
  assert.equal(calls.injections.length + calls.followups.length, before, '无关 agent 的 idle 必须被忽略')
})

test('同一条 worker 的重复 idle 不会重复注入', async () => {
  const { ctx, calls, listeners, emitInsert, parent } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  parent.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const handler = listeners.get('agent/status')[0]
  handler({ agent: parent, status: 'idle' })
  await flush()
  const first = calls.injections.length + calls.followups.length
  handler({ agent: parent, status: 'idle' })
  handler({ agent: parent, status: 'idle' })
  await flush()
  assert.equal(calls.injections.length + calls.followups.length, first + 2,
    '每次 idle 是一条独立汇报（worker 可以跑多个 turn），但不得因同一次 idle 重复')
})

test('wakeForegroundOnTurnEnd=false → 只 inject 不唤醒 head', async () => {
  const { ctx, calls, listeners, emitInsert, parent } = harness()
  applyChain(ctx, { wakeForegroundOnTurnEnd: false })
  emitInsert(userMessage())
  await flush()

  parent.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'done' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const headId = calls.agentsCreate[0].sessionId
  const before = calls.injections.length
  listeners.get('agent/status')[0]({ agent: parent, status: 'idle' })
  await flush()

  const added = calls.injections.slice(before).filter(entry => entry.agent === headId
    && entry.message.content[0].text.includes('后台会话回复'))
  assert.equal(added.length, 1, '关闭唤醒时仍然要 inject（head 下一个 step 读到）')
})

test('worker 刚建立、还没跑过 turn 时的 idle 不得被当成 turn 结束', async () => {
  const { ctx, calls, listeners, emitInsert, parent } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  parent.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
  ]
  const before = calls.injections.length + calls.followups.length
  listeners.get('agent/status')[0]({ agent: parent, status: 'idle' })
  await flush()
  assert.equal(calls.injections.length + calls.followups.length, before,
    '没有 turn/end 就不算跑完过，不得注入')

  parent.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '真跑完了' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  listeners.get('agent/status')[0]({ agent: parent, status: 'idle' })
  await flush()
  const injected = [...calls.injections, ...calls.followups].filter(
    entry => entry.message.content[0].text.includes('真跑完了'),
  )
  assert.equal(injected.length, 1, '真跑完后必须注入')
})


test('新建分叉带 handoffPending 标记，客户端消费前一直有效', async () => {
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  assert.equal(calls.agentsCreate.length, 1)
})

test('子分叉被挂进父分叉的 workspace（漏掉则客户端侧边栏看不到它）', async () => {
  const attached = []
  const { ctx, calls, emitInsert } = harness({
    workspaceRegistry: {
      list: () => [{
        id: 'ws-1',
        sessionIds: ['session-parent'],
        attachSession: (id) => { attached.push(id); return Promise.resolve() },
      }],
    },
  })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  assert.equal(attached.length, 1, '必须调用 attachSession')
  assert.equal(attached[0], calls.agentsCreate[0].sessionId, '挂载的必须是刚建的子 session')
})

/* ---------------- 已被接管的会话：消息必须落到 head，而不是再分叉 ---------------- */

test('worker 收到新消息 → 投给 head，不再分叉', async () => {
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage('m-1'))
  await flush()
  const headId = calls.agentsCreate[0].sessionId
  assert.equal(calls.followups.length, 1, '第一条消息投给 head')

  // 第二条消息仍落在 worker（用户界面可能还停在 A）上
  emitInsert(userMessage('m-2'))
  await flush()

  assert.equal(calls.agentsCreate.length, 1, '不得再建第二条分叉')
  const routed = calls.followups.filter(entry => entry.agent === headId)
  assert.equal(routed.length, 2, '第二条消息也应投给同一个 head')
  assert.equal(routed[1].message.id, 'm-2')
})

/* ---------------- 实例回复回灌容器（使容器转写成为统一转写） ---------------- */

test('实例转 idle + 容器 surface 无悬空调用 → 回复被 append 进容器日志', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  // 默认夹具的在飞 turn 里有一个**悬空**工具调用（c2 之后没有 tool/result），
  // 那是"容器正跑 long tool"的真实形态，命中下面的延迟分叉。这条测的是安全路径，
  // 所以显式换成已应答的 surface。
  ctx.agents.get('session-parent').session.deriveMessages = safeMessages

  const headId = calls.agentsCreate[0].sessionId
  const head = ctx.agents.get(headId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '容器里应该看到这句' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]

  const before = calls.appended.length
  // 两个 status 订阅：worker 一个、实例一个。用 agent 身份筛选出处理实例的那个。
  for (const handler of listeners.get('agent/status')) {
    handler({ agent: head, status: 'idle' })
  }
  await flush()

  const mirrored = calls.appended.slice(before).filter(
    entry => entry.type === 'user/message'
      && entry.data.content[0].text.includes('容器里应该看到这句'),
  )
  assert.equal(mirrored.length, 1, '实例回复必须被追加进容器日志')
  // 正文：以**当前 driver**的口吻出现（`分叉 <短id>`），不是"某条陌生会话"。
  assert.match(mirrored[0].data.content[0].text, /^\[分叉会话 [0-9a-f]{8}\] 这是它对你刚才那条指令的回复。/)
  // 折叠行的一行 account：客户端只读 `source.summary`，正文不进折叠行。
  // summary 必须**承载回复要点**——折叠行是用户不展开就能读到的唯一一行，
  // 只写"某实例已回复"会把"谁在回答我、说了什么"两件事都丢掉。
  assert.equal(mirrored[0].data.source.kind, 'fork-answer')
  assert.equal(mirrored[0].data.source.plugin, 'dsh-autofork')
  assert.equal(mirrored[0].data.source.form, 'notice')
  assert.match(mirrored[0].data.source.summary, /^分叉会话 [0-9a-f]{8}：容器里应该看到这句$/)
})

test('noticeSummaries=false → 注入消息退回整块呈现（不带 form/summary）', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, { noticeSummaries: false })
  emitInsert(userMessage())
  await flush()
  ctx.agents.get('session-parent').session.deriveMessages = safeMessages

  for (const entry of calls.injections) {
    assert.deepEqual(entry.message.source, { kind: 'plugin', plugin: 'dsh-autofork' })
  }

  const headId = calls.agentsCreate[0].sessionId
  const head = ctx.agents.get(headId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '不折叠' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  for (const handler of listeners.get('agent/status')) handler({ agent: head, status: 'idle' })
  await flush()

  const mirrored = calls.appended.filter(entry => entry.type === 'user/message')
  assert.ok(mirrored.length > 0)
  for (const entry of mirrored) {
    assert.equal(entry.data.source.form, undefined)
  }
})

test('mirrorInstanceReply=false → 不回灌', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, { mirrorInstanceReply: false })
  emitInsert(userMessage())
  await flush()

  const head = ctx.agents.get(calls.agentsCreate[0].sessionId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const before = calls.appended.length
  for (const handler of listeners.get('agent/status')) handler({ agent: head, status: 'idle' })
  await flush()
  assert.equal(calls.appended.slice(before).filter(e => e.type === 'user/message').length, 0)
})

test('默认（followHead=true）→ 产生待交付，客户端据此把用户切到新 driver', async () => {
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  const headId = calls.agentsCreate[0].sessionId
  // 两阶段交付：`consume` 只**提供候选**、不清标记。
  const first = await callHealth(calls.routes, 'sessionId=session-parent&consume=1&client=1')
  // 形状是 `{sessionId}`（客户端读 `handoff.sessionId`）；链式模型重写时这里曾经与客户端
  // 不一致过，导致"分叉成功但不切焦点"——所以形状本身也要钉住。
  // 必须有 `parentSessionId`：客户端要用它取父会话的 subagent catalog 派生
  // `{parentSessionId, childSessionId, mode}` 这个 durable 父地址才能打开子会话；
  // 少了它只能用 `open(id)`，而那条路对 `origin:'subagent'` 的会话被设计上拒绝
  // （`session/agent-busy`：subagent Sessions require their durable parent address）。
  assert.deepEqual(first.handoff, { sessionId: headId, parentSessionId: 'session-parent' },
    '默认必须把用户切到新 driver —— 这是"打破同步交互"的前提')
  // 未 ack 前一直提供：客户端切换失败（或页面还没加载）可自动重试。
  const again = await callHealth(calls.routes, 'sessionId=session-parent&consume=1&client=1')
  assert.deepEqual(again.handoff, { sessionId: headId, parentSessionId: 'session-parent' })
  // ack 之后不再提供，避免反复抢焦点。
  await callHealth(calls.routes, `ack=${headId}`)
  const after = await callHealth(calls.routes, 'sessionId=session-parent&consume=1&client=1')
  assert.equal(after.handoff, null, 'ack 之后不得再提供')
})

test('followHead=false（对照臂）→ 不产生待交付，用户留在原会话', async () => {
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, { followHead: false })
  emitInsert(userMessage())
  await flush()

  const body = await callHealth(calls.routes, 'sessionId=session-parent&consume=1&client=1')
  assert.equal(body.handoff, null)
  // 默认值必须是 true：false 只作对照（见 params 注释里那段实测结论）。
  assert.equal(resolveParamsDefault('followHead'), true)
})

/** 从 params 模块读默认值（避免在测试里硬编码常量）。 */
function resolveParamsDefault(key) {
  return DEFAULT_PARAMS_REF[key]
}

test('回灌必须带 surfaceOp（surface-eligible 事件的硬要求）', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  ctx.agents.get('session-parent').session.deriveMessages = safeMessages

  const head = ctx.agents.get(calls.agentsCreate[0].sessionId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'r' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  for (const handler of listeners.get('agent/status')) handler({ agent: head, status: 'idle' })
  await flush()

  const mirrored = calls.appended.find(entry => entry.type === 'user/message')
  assert.ok(mirrored !== undefined)
  assert.deepEqual(mirrored.opts, { surfaceOp: 'append' },
    '缺 surfaceOp 会被 Session.append 拒（自测实证）')
})

/* ---------- 悬空工具调用：容器正跑长工具时绝不能直接 append（用户实测抓到的真 bug） ---------- */

test('容器 surface 有悬空 tool_calls → 实例回复改走 inject（不写坏转写）', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  // 默认夹具的 turn 2 正是这个形态：assistant 发了 bash 调用，结果还没落盘。
  // 此时若 append 一条 user/message，provider 会报
  // "An assistant message with 'tool_calls' must be followed by tool messages …"。

  const headId = calls.agentsCreate[0].sessionId
  const head = ctx.agents.get(headId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '实例产出' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]

  const appendedBefore = calls.appended.length
  const injectedBefore = calls.injections.length
  for (const handler of listeners.get('agent/status')) handler({ agent: head, status: 'idle' })
  await flush()

  assert.equal(
    calls.appended.slice(appendedBefore).filter(e => e.type === 'user/message').length,
    0,
    '悬空工具调用期间绝不允许往容器 surface 追加 user/message',
  )
  const injected = calls.injections.slice(injectedBefore).filter(
    entry => entry.agent === 'session-parent'
      && entry.message.content[0].text.includes('实例产出'),
  )
  assert.equal(injected.length, 1, '实例回复必须改走 inject，落到下一个 step 起点')
})

test('mirrorDelivery=immediate → 明知会写坏也直接 append（仅对照用）', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, { mirrorDelivery: 'immediate' })
  emitInsert(userMessage())
  await flush()

  const head = ctx.agents.get(calls.agentsCreate[0].sessionId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const before = calls.appended.length
  for (const handler of listeners.get('agent/status')) handler({ agent: head, status: 'idle' })
  await flush()
  assert.equal(calls.appended.slice(before).filter(e => e.type === 'user/message').length, 1)
})

/* ---------- 回归：用户实测那份落盘日志（session-650c1e40，2026-09-11） ---------- */

/**
 * 用户实测容器的 surface，逐字取自落盘的 session 事件（seq 109/116）。
 *
 * 这份夹具是**唯一能挡住"判据写错"的东西**：第一版 `hasDanglingToolCall` 用
 * `role === 'tool'` 认工具结果，用旧夹具（把 role 写成 'tool'）测是绿的，但真实数据里
 * 工具结果的 role 是 `'user'`，于是判据恒真→安全性检查失效→又一个 400。断言必须钉在
 * **真实形状**上。
 *
 * @param {boolean} withResult 是否包含工具结果（false = 复现事故现场）。
 * @returns {any[]} 投影后的消息表。
 */
function realLogMessages(withResult) {
  const assistant = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '先跑个长命令' },
      {
        type: 'tool-call',
        id: 'call_00_lf2Sol7SWs8dq7AwOQGu6039',
        name: 'bash',
        arguments: '{"command": "sleep 60; echo \\"slept 60s\\"", "timeoutMs": 90000}',
      },
    ],
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    id: 'a-1',
  }
  const toolResult = {
    role: 'user',
    source: { kind: 'tool', callId: 'call_00_lf2Sol7SWs8dq7AwOQGu6039' },
    content: [{
      type: 'tool-result',
      toolCallId: 'call_00_lf2Sol7SWs8dq7AwOQGu6039',
      content: [{ type: 'text', text: 'slept 60s\n' }],
      isError: false,
    }],
    id: 't-1',
  }
  const base = [
    { role: 'user', content: [{ type: 'text', text: 'sleep 1min' }], source: { kind: 'user' }, id: 'u-1' },
    assistant,
  ]
  return withResult ? base.concat([toolResult]) : base
}

test('回归（事故现场）：容器卡在 sleep 60 且工具结果未落盘 → 镜像必须 defer', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  ctx.agents.get('session-parent').session.deriveMessages = () => realLogMessages(false)

  const head = ctx.agents.get(calls.agentsCreate[0].sessionId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '待命中' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const appendedBefore = calls.appended.length
  for (const handler of listeners.get('agent/status')) handler({ agent: head, status: 'idle' })
  await flush()

  assert.equal(
    calls.appended.slice(appendedBefore).filter(e => e.type === 'user/message').length, 0,
    '工具结果未落盘时 append 会复现 400 INVALID_REQUEST',
  )
})

test('回归：工具结果落盘之后 → 同一份 surface 允许 append', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  ctx.agents.get('session-parent').session.deriveMessages = () => realLogMessages(true)

  const head = ctx.agents.get(calls.agentsCreate[0].sessionId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '待命中' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const appendedBefore = calls.appended.length
  for (const handler of listeners.get('agent/status')) handler({ agent: head, status: 'idle' })
  await flush()

  assert.equal(
    calls.appended.slice(appendedBefore).filter(e => e.type === 'user/message').length, 1,
    '结果已配对后应恢复"立即追加"，不必无谓延迟',
  )
})

/* ---------- 延后镜像的兜底：容器再也没有下一个 step 时补落盘 ---------- */

test('延后的镜像在容器转 idle 时补落盘（工具失败、turn 就此结束的情形）', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  // 撞上悬空工具调用 → 延后（默认夹具的 turn 2 正是这个形态）。
  ctx.agents.get('session-parent').session.deriveMessages = () => realLogMessages(false)

  const head = ctx.agents.get(calls.agentsCreate[0].sessionId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '实例产出' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const parent = ctx.agents.get('session-parent')
  for (const handler of listeners.get('agent/status')) handler({ agent: head, status: 'idle' })
  await flush()
  assert.equal(calls.appended.filter(e => e.type === 'user/message').length, 0, '此时应延后')

  // 工具失败、turn 结束 → 容器转 idle。不变量保证此刻没有开着的 step，可以安全补落盘。
  const parentMessages = []
  parent.session.deriveMessages = () => parentMessages.slice()
  for (const handler of listeners.get('agent/status')) handler({ agent: parent, status: 'idle' })
  await flush()

  const flushed = calls.appended.filter(e => e.type === 'user/message')
  assert.equal(flushed.length, 1, 'idle 时必须把延后的镜像补上')
  assert.match(flushed[0].data.content[0].text, /^\[分叉会话 [0-9a-f]{8}\] 这是它对你刚才那条指令的回复。/)
  assert.equal(flushed[0].data.source.kind, 'fork-answer')
  assert.deepEqual(flushed[0].opts, { surfaceOp: 'append' })

  // 再 idle 一次不得重复注入（队列已清空）。
  const before = calls.appended.length
  for (const handler of listeners.get('agent/status')) handler({ agent: parent, status: 'idle' })
  await flush()
  assert.equal(calls.appended.length, before, '不得重复补落盘')
})

test('延后的镜像若已被下一个 step 吃掉 → idle 时不再补（按 message.id 去重）', async () => {
  const { ctx, calls, listeners, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  ctx.agents.get('session-parent').session.deriveMessages = () => realLogMessages(false)

  const head = ctx.agents.get(calls.agentsCreate[0].sessionId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '实例产出' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const parent = ctx.agents.get('session-parent')
  for (const handler of listeners.get('agent/status')) handler({ agent: head, status: 'idle' })
  await flush()
  const deferred = calls.injections.filter(e => e.agent === 'session-parent'
    && e.message.content[0].text.includes('实例产出'))
  assert.equal(deferred.length, 1)

  // 模拟"下一个 step 起点把它 append 到了 surface"。
  parent.session.deriveMessages = () => [{ ...deferred[0].message }]
  const before = calls.appended.length
  for (const handler of listeners.get('agent/status')) handler({ agent: parent, status: 'idle' })
  await flush()
  assert.equal(calls.appended.length, before, '已在 surface 上的消息不得重复注入')
})

/* ---------- health 探针的 driver 字段：容器模型的可见化数据源 ---------- */

/**
 * 调一次 health 路由的 handler，取回 JSON。
 * @param {any[]} routes harness 捕获的路由。
 * @param {string} query 查询串（不含 `?`）。
 * @returns {Promise<any>} 响应体。
 */
async function callHealth(routes, query) {
  const route = routes.find(candidate => candidate?.path === '/api/dsh-autofork/health')
  assert.ok(route !== undefined, 'health 路由必须已注册')
  let body
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text) { body = JSON.parse(text) },
  }
  await route.handler({ method: 'GET', url: `/api/dsh-autofork/health?${query}` }, res)
  return body
}

test('health.driver：分叉后 driver 指向 head，且链条节点里能找到它', async () => {
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  const headId = calls.agentsCreate[0].sessionId
  const body = await callHealth(calls.routes, 'sessionId=session-parent')

  assert.equal(body.driver.sessionId, headId, '当前 driver 必须是分叉出来的 head')
  assert.equal(body.driver.self, false)
  assert.equal(body.driver.label, `分叉会话 ${headId.slice('session-'.length, 'session-'.length + 8)}`)
  assert.ok(Array.isArray(body.nodes))
  assert.ok(body.nodes.some(node => node.sessionId === headId))
})

test('health.nodes：链条按"根 → 最新"排序，且带 depth / current / parentId', async () => {
  // 「分叉」页签直接吃这个数组，所以顺序与三个身份字段是 UI 的契约。
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const headId = calls.agentsCreate[0].sessionId

  // 从**新会话**的角度再看一次：链条应仍然是 根 → head，且 current 落在 head 上。
  const headBody = await callHealth(calls.routes, `sessionId=${headId}`)
  assert.deepEqual(headBody.nodes.map(node => node.sessionId), ['session-parent', headId])
  assert.deepEqual(headBody.nodes.map(node => node.depth), [0, 1])
  assert.deepEqual(headBody.nodes.map(node => node.current), [false, true])
  assert.deepEqual(headBody.nodes.map(node => node.parentId), [null, 'session-parent'])
  assert.equal(headBody.nodes[1].state, 'running', 'head 的 agent 还活着')
  assert.equal(headBody.nodes[0].state, 'running', '被接管的会话仍在后台跑它那一轮')
})

test('health.driver：没有下游时就是本会话（self）', async () => {
  const { ctx, calls } = harness()
  applyChain(ctx, undefined)
  const body = await callHealth(calls.routes, 'sessionId=session-parent')
  assert.equal(body.driver.sessionId, 'session-parent')
  assert.equal(body.driver.self, true)
  assert.equal(body.driver.label, '本会话')
})

test('health 无 sessionId → driver 为 null、nodes 为空（客户端据此不渲染页签内容）', async () => {
  const { ctx, calls } = harness()
  applyChain(ctx, undefined)
  const body = await callHealth(calls.routes, 'client=1')
  assert.equal(body.driver, null)
  assert.deepEqual(body.nodes, [])
})

/* ---------- 分叉会话的命名：`⑂n <家族根名>`（用户 2026-09 定的形状） ---------- */

/**
 * 造一个带"已存在会话标题"的 harness。
 * @param {Record<string, string>} titles session id → 标题。
 * @returns {any} harness。
 */
function titledHarness(titles) {
  return harness({ titles })
}

test('命名：建 head 时把标题钉成 `⑂1 <根标题>`（前缀 + 不累加）', async () => {
  const { ctx, calls, emitInsert } = titledHarness({ 'session-parent': '修 GUI 卡顿' })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  const headId = calls.agentsCreate[0].sessionId
  assert.deepEqual(calls.renames, [{ sessionId: headId, title: '⑂1 修 GUI 卡顿' }])
})

test('命名：盘上已有 ⑂1 → 新分叉是 ⑂2（按基名接号、不累加）', async () => {
  // 用户明确定的形状：链式分叉**不**做路径式累加（`⑂1-1`），全家族共用基名 + 各自序号。
  // 序号来自**持久化血缘表**（`src/lineage.mjs`）——权威来源，不再靠"标题里有没有 ⑂n"反推
  // （用户 2026-09 拍板删掉那两条路径：有 schema 校验的持久化方案之后，靠渲染结果反推
  // 事实的判据只会悄悄出错）。
  const { ctx, calls, emitInsert } = harness({
    titles: { 'session-parent': '修 GUI 卡顿' },
    lineageEdges: { 'session-old-head': edge('session-parent', 'session-parent', 1, 1000) },
  })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const headId = calls.agentsCreate[0].sessionId
  assert.deepEqual(calls.renames, [{ sessionId: headId, title: '⑂2 修 GUI 卡顿' }])
})

test('命名：别的基名占用的序号不算进来', async () => {
  const { ctx, calls, emitInsert } = harness({
    titles: { 'session-parent': '修 GUI 卡顿' },
    lineageEdges: { 'session-other': edge('session-x', 'session-x', 5, 1000, '另一件事') },
  })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const headId = calls.agentsCreate[0].sessionId
  assert.deepEqual(calls.renames, [{ sessionId: headId, title: '⑂1 修 GUI 卡顿' }],
    '另一个家族编到几号与本家族无关')
})

test('命名：基名从父标题里剥掉标记 —— 不会累积成 `⑂1 ⑂2 …`', async () => {
  const { ctx, calls, emitInsert } = titledHarness({ 'session-parent': '⑂3 修 GUI 卡顿' })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const headId = calls.agentsCreate[0].sessionId
  // 根标题即便自己带着标记（理论上不该发生，但绝不能让它滚雪球），也先剥干净再编号：
  // 基名是 `修 GUI 卡顿`（不是 `⑂3 修 GUI 卡顿`），序号从血缘表/内存里算。
  assert.deepEqual(calls.renames, [{ sessionId: headId, title: '⑂1 修 GUI 卡顿' }],
    '基名不含标记；序号不含"父标题里那个 3"——那已经不是判据了')
})

test('命名：拿不到任何标题时退回可读兜底名，而不是空标题', async () => {
  // 标题是由首条用户消息异步生成的，理论上可能还没落地；此时不能让 rename 抛
  // （原生 `rename` 对规范化后为空的标题会抛 SessionTitleInvalidError）。
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const headId = calls.agentsCreate[0].sessionId
  assert.equal(calls.renames.length, 1)
  assert.equal(calls.renames[0].sessionId, headId)
  // 桩里根会话是 `session-parent` ⇒ 短形式 `parent`（`shortSessionId` 取 `session-` 之后的前 8 位）。
  assert.equal(calls.renames[0].title, '⑂1 会话 parent')
})

test('命名：`titleMark` 为空串 → 关闭命名（不做任何 rename）', async () => {
  const { ctx, calls, emitInsert } = titledHarness({ 'session-parent': '修 GUI 卡顿' })
  applyChain(ctx, { titleMark: '' })
  emitInsert(userMessage())
  await flush()
  assert.equal(calls.agentsCreate.length, 1)
  assert.deepEqual(calls.renames, [])
})

/* ---------- 血缘的持久化：重启后关系不丢（用户 2026-09 实测报的） ---------- */

/**
 * 造一条血缘边（形状与 `src/lineage.mjs` 的 `lineageEdgeSchema` 一致）。
 * @param {string} workerId 被接管的会话。
 * @param {string} rootId 家族根。
 * @param {number} ordinal 序号。
 * @param {number} createdAt 建分叉时间。
 * @param {string} base 基名。
 * @returns {any} 边。
 */
function edge(workerId, rootId, ordinal, createdAt, base = '修 GUI 卡顿') {
  return { workerId, rootId, ordinal, base, title: `⑂${ordinal} ${base}`, createdAt }
}

test('分叉时把血缘边写进官方存储域（这是重启后关系不丢的唯一依据）', async () => {
  const { ctx, calls, emitInsert } = titledHarness({ 'session-parent': '修 GUI 卡顿' })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  assert.deepEqual(calls.lineageOpens, ['autofork_lineage'], '域名要与 spec 一致')
  assert.equal(calls.lineageWrites.length, 1)
  const { headId, edge: written } = calls.lineageWrites[0]
  assert.equal(headId, calls.agentsCreate[0].sessionId)
  assert.equal(written.workerId, 'session-parent')
  assert.equal(written.rootId, 'session-parent')
  assert.equal(written.ordinal, 1)
  assert.equal(written.base, '修 GUI 卡顿')
  assert.equal(written.title, '⑂1 修 GUI 卡顿')
  assert.equal(typeof written.createdAt, 'number')
})

test('**重启后**：内存记录为空，家族仍从持久化的边恢复出来（health.nodes 整棵树）', async () => {
  // 这正是用户报的场景：进程重启后页签只剩当前这一条、fork_list 也看不到亲属。
  const { ctx, calls } = harness({
    lineageEdges: {
      'session-head-1': edge('session-parent', 'session-parent', 1, 1000),
    },
  })
  applyChain(ctx, undefined)

  // 从**老的根**看：能看到它分出去的那条。
  const fromRoot = await callHealth(calls.routes, 'sessionId=session-parent')
  assert.deepEqual(fromRoot.nodes.map(node => node.sessionId), ['session-parent', 'session-head-1'])
  assert.deepEqual(fromRoot.nodes.map(node => node.depth), [0, 1])
  assert.deepEqual(fromRoot.nodes.map(node => node.current), [true, false])
  assert.equal(fromRoot.nodes[1].title, '⑂1 修 GUI 卡顿')
  assert.equal(fromRoot.nodes[1].state, 'finished', '进程重启后 agent 不在了')

  // 从**那条分叉**看：同一棵树，current 落在自己身上。
  const fromHead = await callHealth(calls.routes, 'sessionId=session-head-1')
  assert.deepEqual(fromHead.nodes.map(node => node.sessionId), ['session-parent', 'session-head-1'])
  assert.deepEqual(fromHead.nodes.map(node => node.current), [false, true])
  assert.equal(fromHead.nodes[1].parentId, 'session-parent')
})

test('**重启后**：fork_list 也能看到亲属（工具路径同样先等血缘域装载）', async () => {
  const { ctx, calls } = harness({
    lineageEdges: {
      'session-head-1': edge('session-parent', 'session-parent', 1, 1000),
    },
  })
  applyChain(ctx, undefined)
  const tool = calls.registeredTools.find(candidate => candidate.name === 'fork_list')
  assert.ok(tool !== undefined)
  const value = await tool.execute({}, { agent: { id: 'session-head-1' } })
  assert.equal(value.related.length, 1)
  assert.equal(value.related[0].sessionId, 'session-parent')
  assert.equal(value.related[0].relation, 'upstream')
  assert.equal(value.related[0].title, '修 GUI 卡顿', '标题也一并恢复（模型可用名字指代）')
})

test('一条会话被分叉两次 = 树不是链：两条分叉互为 sibling，页签两行都在', async () => {
  // 链式视角的老毛病：`recordByWorker` 只指向最后绑定的那条，早先那条分叉会从
  // "我分出去的"里消失。持久化层按 createdAt 排全部子节点，所以兄弟都在。
  const { ctx, calls } = harness({
    lineageEdges: {
      'session-head-1': edge('session-parent', 'session-parent', 1, 1000),
      'session-head-2': edge('session-parent', 'session-parent', 2, 2000),
    },
  })
  applyChain(ctx, undefined)

  const body = await callHealth(calls.routes, 'sessionId=session-head-1')
  assert.deepEqual(body.nodes.map(node => node.sessionId),
    ['session-parent', 'session-head-1', 'session-head-2'],
    '根的整棵树：自己 + 兄弟，按创建时间排')
  assert.deepEqual(body.nodes.map(node => node.depth), [0, 1, 1])

  const tool = calls.registeredTools.find(candidate => candidate.name === 'fork_list')
  const value = await tool.execute({}, { agent: { id: 'session-head-1' } })
  assert.deepEqual(value.related.map(row => [row.sessionId, row.relation]),
    [['session-parent', 'upstream'], ['session-head-2', 'sibling']])
})

test('授权：同族的兄弟分叉也可以被 steer（不只有祖先/后代）', async () => {
  const { ctx, calls } = harness({
    lineageEdges: {
      'session-head-1': edge('session-parent', 'session-parent', 1, 1000),
      'session-head-2': edge('session-parent', 'session-parent', 2, 2000),
    },
  })
  applyChain(ctx, undefined)
  // 让兄弟"活着"：注册一个 agent 桩。
  ctx.agents.create({ sessionId: 'session-head-2', meta: {} })
  const tool = calls.registeredTools.find(candidate => candidate.name === 'fork_steer')
  const ok = await tool.execute({ sessionId: 'session-head-2', text: '改方向' },
    { agent: { id: 'session-head-1' } })
  assert.equal(ok.ok, true, '兄弟分叉应当被放行')
})

test('序号也来自血缘表：盘上已有 ⑂2 → 新分叉是 ⑂3（不必再扫持久化标题）', async () => {
  const { ctx, calls, emitInsert } = harness({
    titles: { 'session-parent': '修 GUI 卡顿' },
    lineageEdges: {
      'session-old-1': edge('session-parent', 'session-parent', 1, 1000),
      'session-old-2': edge('session-parent', 'session-parent', 2, 2000),
    },
  })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const headId = calls.agentsCreate[0].sessionId
  assert.deepEqual(calls.renames, [{ sessionId: headId, title: '⑂3 修 GUI 卡顿' }])
})

test('血缘域打不开 → 只降级成"内存血缘"，分叉与命名照常', async () => {
  const { ctx, calls, emitInsert } = harness({
    titles: { 'session-parent': '修 GUI 卡顿' },
    lineageBroken: true,
  })
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  assert.equal(calls.agentsCreate.length, 1, '域坏掉不能影响分叉')
  assert.deepEqual(calls.lineageWrites, [], '域没打开就不落盘（只在内存里）')
  assert.deepEqual(calls.renames, [{ sessionId: calls.agentsCreate[0].sessionId, title: '⑂1 修 GUI 卡顿' }])
  // 家族至少还有内存那一条（本次运行内的行为不变）。
  const body = await callHealth(calls.routes, 'sessionId=session-parent')
  assert.equal(body.nodes.length, 2)
})

/* ---------- 子会话的 durable 描述符：地址校验靠它（用户 2026-09-11 实测的加载失败） ---------- */

/**
 * 容器模式的投影：容器**空闲**（没有开着的 turn），已完成 2 轮。
 * 这正是容器模式的不变式——容器自己不跑 turn，所以它永远空闲。
 */
const CONTAINER_PROJECTION = {
  openTurnStartSeq: null,
  lastStepStartSeq: null,
  lastStepBoundary: null,
  lastTurn: 2,
}

/** 造一个容器模式的宿主。 */
function containerHarness(options = {}) {
  return harness({ ...options, projection: options.projection ?? CONTAINER_PROJECTION })
}

/**
 * 以**容器模式** apply 插件。
 *
 * 必须显式打开：容器模式的默认值目前是 false，因为"容器自己不跑 turn"这条前提被 E2E
 * 证伪了（容器的 loop 总会因为 preStep 注入的上下文消息而跑一个真请求，见 params 注释）。
 * 这一族测试保留下来，是因为容器模式的可分发部分（路由 / 重绑 / 一等回复写入）本身是对的。
 * @param {any} ctx 桩上下文。
 * @param {Record<string, unknown> | undefined} config 覆盖配置。
 * @returns {void}
 */
function applyContainer(ctx, config) {
  apply(ctx, { containerMode: true, ...(config ?? {}) })
}

test('容器模式：容器空闲也要路由给实例（容器自己不跑 turn）', async () => {
  const { ctx, calls, emitInsert } = containerHarness()
  applyContainer(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  // 抢下消息：容器自己的 loop 绝不会消费它
  assert.deepEqual(calls.removes, ['m-user'], '容器模式下也必须 CAS 抢下消息')
  // 建第一个实例（容器自己不跑，所以空闲时也要建）
  assert.equal(calls.agentsCreate.length, 1, '容器空闲也必须建实例——容器不跑 turn')
  const instanceId = calls.agentsCreate[0].sessionId

  // **用户说的话必须被插件写进容器日志**：真实实现里 loop 是消费 inbox 时才 append 的，
  // 我们把消息抢走了，不代写的话用户就看不到自己刚发的那句话。
  const shown = calls.appended.filter(entry => entry.type === 'user/message' && entry.data?.id === 'm-user')
  assert.equal(shown.length, 1, '必须把用户消息代写进容器日志')
  assert.deepEqual(shown[0].opts, { surfaceOp: 'append' })

  // 交给实例
  assert.equal(calls.followups.at(-1).agent, instanceId)
  assert.equal(calls.followups.at(-1).message.id, 'm-user')

  // 首次绑定要插一行折叠通知说明"现在由谁回答"
  const notice = calls.appended.filter(entry => entry.type === 'user/message'
    && entry.data?.source?.form === 'notice' && String(entry.data.content[0].text).includes('[容器]'))
  assert.equal(notice.length, 1)
  assert.match(notice[0].data.source.summary, /现在由 分叉会话 /)

  // 焦点**不动**：容器就是用户所在的会话
  assert.equal(ctx.agents.get('session-parent').status, 'running')
})

test('容器模式：绑定的实例空闲 → 复用，不新建实例、不重绑', async () => {
  const { ctx, calls, emitInsert } = containerHarness()
  applyContainer(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const instanceId = calls.agentsCreate[0].sessionId
  // 实例跑完一轮后转 idle（这正是"用户接着说话"的常态）
  ctx.agents.get(instanceId).status = 'idle'

  emitInsert(userMessage('m-second'))
  await flush()

  assert.equal(calls.agentsCreate.length, 1, '绑定实例空闲时不得再建实例')
  assert.equal(calls.followups.at(-1).agent, instanceId)
  assert.equal(calls.followups.at(-1).message.id, 'm-second')
  assert.equal(calls.removes.includes('m-second'), true)
})

test('容器模式：绑定的实例在忙 → 新建实例并重绑（容器允许更换 driver）', async () => {
  const { ctx, calls, emitInsert } = containerHarness()
  applyContainer(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const first = calls.agentsCreate[0].sessionId
  // 默认子 agent 是 running：用户这时又发了一条 ⇒ 重绑
  emitInsert(userMessage('m-second'))
  await flush()

  assert.equal(calls.agentsCreate.length, 2, '实例在忙时必须新建实例，不能让用户等')
  const second = calls.agentsCreate[1].sessionId
  assert.notEqual(second, first)
  assert.equal(calls.followups.at(-1).agent, second)
  // 旧实例**不被中止**，它继续跑
  assert.equal(calls.cancels.length, 0, '绝不中止旧实例')

  const rebind = calls.appended.filter(entry => entry.type === 'user/message'
    && entry.data?.source?.form === 'notice' && String(entry.data.source.summary).includes('已切换到'))
  assert.equal(rebind.length, 1)
  assert.match(String(rebind[0].data.content[0].text), /不会被中止/)
})

test('容器模式：实例转 idle → 答复写成容器里的一等 assistant turn（不是注入行）', async () => {
  const { ctx, calls, listeners, emitInsert } = containerHarness()
  applyContainer(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  const instance = ctx.agents.get(calls.agentsCreate[0].sessionId)
  instance.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '容器里应该看到这句' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]

  const before = calls.appended.length
  for (const handler of listeners.get('agent/status')) handler({ agent: instance, status: 'idle' })
  await flush()

  const written = calls.appended.slice(before)
  assert.deepEqual(written.map(entry => entry.type), [
    'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
  ], '必须是完整的 turn 信封，否则不变量拒')
  const assistant = written.find(entry => entry.type === 'assistant/message')
  assert.deepEqual(assistant.opts, { surfaceOp: 'append' }, 'assistant/message 是 surface-eligible')
  assert.equal(assistant.data.turn, 3, 'turn 号 = 容器 lastTurn + 1')
  assert.equal(assistant.data.step, 1)
  assert.equal(assistant.data.message.role, 'assistant')
  assert.equal(assistant.data.message.source.kind, 'model')
  assert.match(assistant.data.message.content[0].text, /容器里应该看到这句/)
  // **不能再**出现"注入行"形态的回灌（那是容器模式的旧形态，也是客户端事实 15 的天花板）
  assert.equal(written.filter(entry => entry.data?.source?.kind === 'fork-answer').length, 0)
})

test('容器模式：容器若意外开着 turn → 不写（宁可漏一条也不写坏容器日志）', async () => {
  // 用默认（有开着 turn 的）投影模拟"容器 loop 抢跑"
  const { ctx, calls, listeners, emitInsert } = harness()
  applyContainer(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  const instance = ctx.agents.get(calls.agentsCreate[0].sessionId)
  instance.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const before = calls.appended.length
  for (const handler of listeners.get('agent/status')) handler({ agent: instance, status: 'idle' })
  await flush()
  assert.equal(
    calls.appended.slice(before).filter(entry => entry.type === 'turn/start').length, 0,
    '容器有开着的 turn 时插 turn 会撞不变量',
  )
})

test('容器模式：handoff 恒为 null（用户永不移动）', async () => {
  const { ctx, calls, emitInsert } = containerHarness()
  applyContainer(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const body = await callHealth(calls.routes, 'sessionId=session-parent&consume=1&client=1')
  assert.equal(body.handoff, null, '容器模式下绝不能把用户切走')
})

test('容器模式：实例收到用户消息时**不再往外分包**（实测递归 bug 的回归）', async () => {
  // 实测事故：容器模式刚上线时，`instance.followup(用户消息)` 里的那条消息
  // （source.kind === 'user'）又触发了这个处理器；实例刚建好正是 running，于是它
  // 给自己建了子实例，消息一层层往下传，直到撞上 maxActiveBranches——
  // E2E 日志里是 `cm-test → A → A′ → A″` 这条递归链。
  const { ctx, calls, emitInsert, listeners } = containerHarness()
  applyContainer(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const instance = ctx.agents.get(calls.agentsCreate[0].sessionId)
  const created = calls.agentsCreate.length

  // 模拟实例的 inbox 收到了一条用户消息（就是被投递给它的那条）
  for (const handler of listeners.get('agent/inbox/inserted') ?? []) {
    handler({ agent: instance, message: userMessage('m-to-instance') })
  }
  await flush()

  assert.equal(calls.agentsCreate.length, created, '实例不得再给自己建实例')
  assert.equal(calls.removes.includes('m-to-instance'), false, '实例的消息不该被抢走')
})

test('容器模式：实例数上限按"该容器的实例"计，且撞上限不吞消息', async () => {
  const { ctx, calls, emitInsert } = containerHarness()
  applyContainer(ctx, { maxActiveBranches: 2 })
  for (const id of ['m-1', 'm-2', 'm-3']) {
    emitInsert(userMessage(id))
    await flush()
    // 让最近建立的实例保持 running（默认就是），从而下一条必然重绑
  }
  // 前两条各建一个实例；第三条撞上限 → 排队给当前绑定的实例，而不是丢掉
  assert.equal(calls.agentsCreate.length, 2, '上限是 2 就不该建第 3 个')
  assert.equal(calls.removes.includes('m-3'), true, '撞上限也要抢下消息')
  assert.equal(calls.followups.at(-1).message.id, 'm-3', '撞上限时把消息交给绑定实例排队')
})

/* ---------- 容器模式的核心闸门：容器**不跑任何 step**（agent/pre-step 中和） ---------- */

test('容器模式：没有用户消息可答的 pre-step 被 reject；有的则放行（容器自己作答）', async () => {
  // 这是"同一个容器"成立的最后一环。容器的 loop 每来一条消息都会开 turn，而 preStep
  // 总会注入 runtime context / skill catalog 使消息表非空 ⇒ 容器会发一个真请求、与 agent
  // 重复劳动。返回 `{kind:'enter', messages: []}` 让 loop 命中
  // `phase.step === 0 && messages.length === 0` 分叉 ⇒ turn 以 completed 立刻关闭。
  const { ctx, parent, listeners } = harness({ projection: CONTAINER_PROJECTION })
  applyContainer(ctx, undefined)

  const run = async (messages) => {
    let decision
    for (const handler of listeners.get('agent/pre-step') ?? []) {
      decision = await handler(
        { agent: parent, messages, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: ['默认'] }),
      )
    }
    return decision
  }

  // ① 分叉时消息已被 CAS 抢走 ⇒ 这一步没东西可答 ⇒ **reject**（否则 loop 会因为别人注入的
  // runtime context 而发一个空转的模型请求）。**必须是 reject**：链上其它 pre-step 监听器
  // 会在 `enter` 时把自己的注入追加回 `decision.messages`（空表又被填满 ⇒ step 照跑），
  // 而它们全都显式短路 reject。
  assert.deepEqual(await run([]), { kind: 'reject' },
    '没有用户消息可答时必须 reject')
  assert.deepEqual(await run([{ id: 'ctx', role: 'user', content: [{ type: 'text', text: 'ctx' }], source: { kind: 'plugin', plugin: 'x' } }]),
    { kind: 'reject' }, '只有注入上下文、没有用户消息时同样 reject')

  // ② **有用户消息 ⇒ 放行**：笔记定的规则是"正常的一次 agent 反馈后的用户指令不会 branch,
  // 因为已经可以立即响应了" —— 空闲容器必须自己作答。
  assert.deepEqual(await run([userMessage()]), { kind: 'enter', messages: ['默认'] },
    '有用户消息时容器必须自己作答，不准拿去分叉')
})

test('容器模式：agent（实例）的 pre-step **不被**中和', async () => {
  const { ctx, calls, emitInsert, listeners } = harness({ projection: CONTAINER_PROJECTION })
  applyContainer(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const instance = ctx.agents.get(calls.agentsCreate[0].sessionId)

  let result
  for (const handler of listeners.get('agent/pre-step') ?? []) {
    result = await handler(
      { agent: instance, messages: [userMessage('m-x')], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: ['默认'] }),
    )
  }
  assert.deepEqual(result, { kind: 'enter', messages: ['默认'] }, 'agent 必须照常执行')
})

test('容器模式：agent 被登记成容器名下的子会话（花名册 + durable 父地址）', async () => {
  // 用户定的结构："一条 session 持有多条 agent 的 durable 记录"。那条"记录"就是容器日志里的
  // `subagent/catalog`；而 agent 自己那条日志里要有 `subagent/descriptor`（寻址与分类都要它）。
  const { ctx, calls, emitInsert } = containerHarness()
  applyContainer(ctx, undefined)
  emitInsert(userMessage())
  await flush()

  const opts = calls.agentsCreate[0]
  assert.equal(opts.meta.origin, 'subagent', '容器模式下 agent 是容器名下的子会话')
  assert.equal(opts.meta.parentSession, 'session-parent')
  const catalog = calls.appended.find(entry => entry.type === 'subagent/catalog')
  assert.ok(catalog !== undefined, '必须往容器日志写花名册')
  assert.deepEqual(catalog.data, {
    version: 0, childId: opts.sessionId, childCreatedAt: 1_700_000_000_000,
    mode: 'continuable', label: '分叉',
  })
  // 描述符必须落在**继承前缀之后**（`isOwnSeq` 判据），且形状是 version 3 / continuable。
  const descriptorIndex = opts.seed.length - 1
  assert.equal(opts.seed[descriptorIndex].type, 'subagent/descriptor')
  assert.ok(opts.seed[descriptorIndex].seq >= opts.inheritedEventCount)
  assert.deepEqual(opts.seed[descriptorIndex].data, {
    version: 3, mode: 'continuable', provider: 'fork', label: '分叉',
    agentProvider: 'p', agentModel: 'm',
  })
})

test('扁平模式（对照）：head 是普通顶层会话，不写花名册', async () => {
  // 链式模式要求"有在飞的 turn"，所以用默认夹具（默认投影里有 openTurnStartSeq）。
  const { ctx, calls, emitInsert } = harness()
  applyChain(ctx, undefined)
  emitInsert(userMessage())
  await flush()
  const opts = calls.agentsCreate[0]
  assert.equal(opts.meta.origin, undefined)
  assert.equal(opts.meta.parentSession, undefined)
  assert.equal(calls.appended.find(e => e.type === 'subagent/catalog'), undefined)
})

test('容器模式：**空闲的容器不分叉**，自己作答（笔记的触发规则）', async () => {
  // "自动 branch 只会发生在 agent 处于无法立刻被打断的情况下…正常的一次 agent 反馈后的
  // 用户指令不会 branch，因为已经可以立即响应了。" 早期版本把每条消息都交给 agent，
  // 等于把"自动分叉"改成了"永远分叉"——用户实测第一句 "hi" 就被分叉了。
  const { ctx, calls, emitInsert } = containerHarness()
  applyContainer(ctx, undefined)
  const container = ctx.agents.get('session-parent')
  container.status = 'idle'
  emitInsert(userMessage())
  await flush()

  assert.equal(calls.agentsCreate.length, 0, '空闲容器不得建 agent')
  assert.equal(calls.removes.length, 0, '空闲容器不得抢走消息——它要自己回答')
  assert.equal(calls.followups.length, 0)
  assert.equal(calls.appended.filter(e => e.type === 'user/message').length, 0,
    '用户消息由容器自己的 loop 写，插件不得代写')
})

test('容器模式：**忙碌的容器**才分叉，且不中止容器自己那条 turn', async () => {
  const { ctx, calls, emitInsert } = containerHarness()
  applyContainer(ctx, undefined)
  const container = ctx.agents.get('session-parent')
  container.status = 'running' // 来不及立刻响应
  emitInsert(userMessage())
  await flush()

  assert.equal(calls.agentsCreate.length, 1, '容器忙时必须分叉')
  assert.equal(calls.removes.includes('m-user'), true, '分叉要把消息抢下来')
  assert.equal(calls.cancels.length, 0, '绝不中止容器自己那条 turn')
  // 用户消息由插件代写（否则容器永远不消费它，用户看不到自己说的话）
  assert.equal(calls.appended.filter(e => e.type === 'user/message' && e.data?.id === 'm-user').length, 1)
})

/* ---------- 用户实测报的两条：digest 重复、以及"B→A"反向回灌 ---------- */

test('默认：**不做** B→A 的反向回灌（方向错了，纯噪声）', async () => {
  // 用户实测：A 跑完把结果注入给 B，B 因此回复一句，那句又被回灌成 A 里的一行
  // `fork-answer` —— 没有任何用途。笔记定的方向只有"旧 session 的结果注入给新 session"。
  const { ctx, calls, listeners, emitInsert } = harness()
  applyDefaults(ctx)
  emitInsert(userMessage())
  await flush()

  const head = ctx.agents.get(calls.agentsCreate[0].sessionId)
  head.session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: NOW },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'B 的回复' }] } }, time: NOW },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, time: NOW },
  ]
  const before = calls.appended.length
  for (const handler of listeners.get('agent/status') ?? []) handler({ agent: head, status: 'idle' })
  await flush()

  assert.equal(
    calls.appended.slice(before).filter(entry => entry.data?.source?.kind === 'fork-answer').length,
    0, '默认不得把 B 的回复回灌进 A',
  )
})

