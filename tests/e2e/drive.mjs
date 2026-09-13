/**
 * 行为层端到端驱动：用 SDK stdio JSON-RPC 驱动真实 harness，验证自动分叉。
 *
 * 场景（正是笔记描述的那个痛点）：
 *   ① 发第一条指令 → mock 让 agent 调 bash(sleep 40)，制造一个 40 秒的在飞 step
 *   ② 等 step 年龄超过 minStepAgeMs(8s) 后，发第二条指令
 *   ③ 期望：插件用 inbox.remove() 抢占这条消息、fork 出子分支、把
 *      「自动分叉通知 + 兄弟分叉在飞进度」注入子分叉、把用户指令投给子分叉
 *
 * 观察面：SDK 会流式回传**每个** session 的事件，所以子 session 的出现与它
 * 日志里的注入文本都是直接证据。
 *
 * 跑法：node drive.mjs
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cleanLineage, cleanSession } from './session-dir.mjs'

// 必须是**已装好这个插件**（且带官方依赖闭包）的隔离 home：`dsh plugin --profile web add <repo>` 之后
// 用那个 home，或者由 `DSH_HOME` 直接指定。别用共享的 `~/.dsh`——E2E 会在里面建会话。
const DSH_HOME = process.env.E2E_DSH_HOME ?? process.env.DSH_HOME ?? '/tmp/dsh-autofork-e2e-home'
const MOCK_BASE = process.env.MOCK_BASE_URL ?? 'http://127.0.0.1:8123/v1'
// 工作目录：E2E 会在这里建会话日志（每次跑前请清掉，否则是 resume 而不是全新会话）。
const WORK_DIR = process.env.E2E_CWD ?? '/tmp/dsh-autofork-e2e-work'
const SESSION_ID = process.env.E2E_SESSION_ID ?? 'session-autofork-e2e'
const SECOND_PROMPT = '改成用 worktree 隔离：把当前改动挪到独立工作树'
// 场景时长可调：复现"悬空工具调用"窗口时，第二次 prompt 要落在**工具还在跑**的那段里。
const STEP_WAIT_MS = Number(process.env.E2E_STEP_WAIT_MS ?? 16_000)
const OBSERVE_MS = Number(process.env.E2E_OBSERVE_MS ?? 75_000)

mkdirSync(WORK_DIR, { recursive: true })

const log = (...parts) => console.log(JSON.stringify({ t: 'driver', ...Object.assign({}, ...parts) }))

/**
 * 预检：mock 真的在监听吗。
 *
 * 不做这一步的代价是**误判**：mock 没起来时 agent 只会拿到一个 LlmError，而驱动看到的
 * 是"没分叉"——和"插件坏了"长得一模一样。宁可在这里明确地死。
 */
async function assertMockReachable() {
  const url = new URL(MOCK_BASE)
  const port = Number(url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : url.port)
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port })
    const fail = (why) => {
      socket.destroy()
      reject(new Error(
        `mock LLM 连不上（${url.hostname}:${String(port)}，${why}）。先按 tests/e2e/README.md 起它：`
        + 'MOCK_PORT=8123 MOCK_SEQUENCE=stall,success node tests/e2e/mock-server.mjs'
        + '（每次跑都要**新起**：序列是有状态的，复用的旧 mock 会让第一条请求就拿到 success）。',
      ))
    }
    socket.setTimeout(3000)
    socket.once('connect', () => { socket.destroy(); resolve() })
    socket.once('timeout', () => fail('超时'))
    socket.once('error', (error) => fail(String(error?.code ?? error)))
  })
}

await assertMockReachable()
log({ step: 'mock-reachable', base: MOCK_BASE })

// **必须在起 dsh 之前**清掉这条会话的落盘日志：残留日志会让下一次直接撞 id collision，
// 或被上一次未收尾的 turn 卡住（见 session-dir.mjs 的注释）。删掉 = 全新会话（这是要的）。
log({ step: 'clean-session', removed: cleanSession(DSH_HOME, WORK_DIR, SESSION_ID) })
// 顺带清血缘域：残留的旧 head 边会让序号一路涨、还会在 fork_list 里冒出幽灵兄弟，
// 让"分叉命名"这条证据没法逐次对照（详见 session-dir.mjs 的 cleanLineage）。
log({ step: 'clean-lineage', ...cleanLineage(DSH_HOME) })

const child = spawn('dsh', ['--profile', 'sdk'], {
  env: {
    ...process.env,
    DSH_HOME,
    DEEPSEEK_BASE_URL: MOCK_BASE,
    DEEPSEEK_API_KEY: 'mock-key',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: WORK_DIR,
})

let stderrTail = ''
child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-4000) })

/** 每个 session 收到的全部事件。 */
const eventsBySession = new Map()
/** 状态迁移序列。 */
const statuses = []
/** 每个 session 的**最新**状态（判据用；statuses 是完整迁移史）。 */
const latestStatus = new Map()
/** 原始帧（调试用）。 */
const frames = []
let nextId = 1
const pending = new Map()

const reader = createInterface({ input: child.stdout })
reader.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return // 协议规定：非 JSON 行忽略
  }
  frames.push(frame)
  if (frame.id !== undefined && frame.method === undefined) {
    const settle = pending.get(frame.id)
    if (settle !== undefined) {
      pending.delete(frame.id)
      settle(frame)
    }
    return
  }
  const params = frame.params ?? {}
  if (frame.method === 'session.event') {
    const sessionId = params.sessionId ?? params.event?.sessionId ?? 'unknown'
    if (!eventsBySession.has(sessionId)) eventsBySession.set(sessionId, [])
    eventsBySession.get(sessionId).push(params.event ?? params)
    return
  }
  if (frame.method === 'session.status') {
    statuses.push({ sessionId: params.sessionId, status: params.status })
    latestStatus.set(params.sessionId, params.status)
  }
})

/** 发一个 JSON-RPC 请求并等响应。 */
function send(method, params) {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve) => {
    pending.set(id, resolve)
    setTimeout(() => {
      if (pending.delete(id)) resolve({ error: { code: 'timeout', message: `no response to ${method}` } })
    }, 30_000)
  })
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** 从一个 session 的事件里抽出所有 user/message 的文本。 */
function userTexts(events) {
  const texts = []
  for (const event of events) {
    const payload = event?.data ?? event
    if (event?.type !== 'user/message' && payload?.type !== 'user/message') continue
    const message = payload.message ?? payload
    const content = message?.content ?? []
    for (const part of content) {
      if (typeof part?.text === 'string') texts.push(part.text)
    }
  }
  return texts
}

/* ------------------------------ 主流程 ------------------------------ */

const init = await send('initialize', {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  // initialize 里 cwd 是**必填**：服务端直接 resolve(params.cwd)，缺了会抛
  // `The "paths[0]" argument must be of type string`。
  cwd: WORK_DIR,
})
log({ step: 'initialize', ok: init.error === undefined, error: init.error })

const first = await send('session/prompt', {
  sessionId: SESSION_ID,
  cwd: WORK_DIR,
  contentBlocks: [{ type: 'text', text: '先跑一遍慢检查（sleep 40 那条），不要改任何文件。' }],
})
log({ step: 'prompt-1', ok: first.error === undefined, error: first.error })

log({ step: 'waiting-for-step-age', ms: STEP_WAIT_MS })
await sleep(STEP_WAIT_MS)

// 自检：**父会话此刻必须还在忙**，否则分叉的前提根本不成立。
// 最常见的原因是 mock 被复用（序列已消费到 success）——那时后面的"没分叉"是环境问题，
// 不是插件问题，必须在这里说清楚，否则日志会把人引到错的方向（实测踩过）。
const parentStatus = latestStatus.get(SESSION_ID)
if (parentStatus !== 'running') {
  log({
    step: 'mock-not-stalling',
    sessionStatus: parentStatus ?? 'unknown',
    hint: '父会话在第二条指令之前就空闲了 ⇒ 没有"在飞 step"，本就不会触发自动分叉。'
      + '检查 mock 是否新起、MOCK_SEQUENCE 是否为 stall,success（序列是有状态的）。',
  })
}

const second = await send('session/prompt', {
  sessionId: SESSION_ID,
  cwd: WORK_DIR,
  contentBlocks: [{ type: 'text', text: SECOND_PROMPT }],
})
log({ step: 'prompt-2', ok: second.error === undefined, error: second.error })

log({ step: 'observing', ms: OBSERVE_MS })
await sleep(OBSERVE_MS)

/* ------------------------------ 汇总 ------------------------------ */

const summary = {
  t: 'summary',
  sessionCount: eventsBySession.size,
  sessions: [],
  statuses,
  forkDetected: false,
  digestInjected: false,
  noticeInjected: false,
  instructionDelivered: false,
  // ---- 悬空工具调用窗口：镜像的落点必须晚于工具结果 ----
  mirrorOrder: null,
  turnErrors: [],
}

for (const [sessionId, events] of eventsBySession) {
  const texts = userTexts(events)
  const joined = texts.join('\n')
  const isChild = sessionId !== SESSION_ID
  const entry = {
    sessionId,
    role: isChild ? 'child(分支)' : 'parent',
    eventCount: events.length,
    types: [...new Set(events.map(event => (event?.data ?? event)?.type ?? event?.type))].slice(0, 12),
    hasForkNotice: joined.includes('自动分叉通知'),
    hasInFlightDigest: joined.includes('兄弟分叉在飞进度'),
    hasSecondPrompt: joined.includes('worktree'),
  }
  summary.sessions.push(entry)
  if (!isChild) {
    const seqOf = (predicate) => {
      for (const event of events) {
        const payload = event?.data ?? event
        if (predicate(payload)) return event?.seq ?? payload?.seq
      }
      return undefined
    }
    const toolResultSeq = seqOf(p => p?.type === 'tool/result')
    const mirrorSeq = seqOf(p => p?.type === 'user/message'
      && (p.data ?? p)?.source?.plugin === 'dsh-autofork'
      && (p.data ?? p)?.source?.form === 'notice')
    summary.mirrorOrder = {
      toolResultSeq,
      mirrorSeq,
      // true = 镜像落在工具结果之后（正确）；false = 插在 tool_calls 与结果之间（会 400）
      afterToolResult: toolResultSeq !== undefined && mirrorSeq !== undefined
        ? mirrorSeq > toolResultSeq
        : null,
    }
    summary.turnErrors = events
      .map(event => (event?.data ?? event))
      .filter(p => p?.type === 'turn/end' && p.data?.reason?.kind === 'error')
      .map(p => p.data.reason.error?.message ?? 'error')
  }
  if (isChild) summary.forkDetected = true
  if (entry.hasForkNotice) summary.noticeInjected = true
  if (entry.hasInFlightDigest) summary.digestInjected = true
  if (entry.hasSecondPrompt) summary.instructionDelivered = true
}

writeFileSync('/tmp/autofork-e2e-frames.json', JSON.stringify(frames, null, 2))
console.log(JSON.stringify(summary, null, 2))
if (stderrTail !== '') console.log(JSON.stringify({ t: 'dsh-stderr-tail', stderrTail }))

await send('shutdown', undefined).catch(() => {})
await sleep(1000)
child.kill('SIGKILL')
process.exit(0)
