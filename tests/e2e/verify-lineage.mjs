/**
 * 两阶段探针：血缘**跨进程**还在吗 + `fork_list` 的输出 schema 真的过得了运行时校验吗。
 *
 * ## 为什么分两段、为什么第二段用 **web** 实例
 *
 * 阶段 1（`dsh --profile sdk` + mock）跑一次真分叉，产两样东西：
 *   ① 盘上一条血缘边 `<DSH_HOME>/storages/autofork_lineage/edges/<head>.json`；
 *   ② head 第一次 turn 里 `fork_list` 的 **tool/result 文本**——工具的 `output.schema` 是
 *      封闭形状（`additionalProperties:false`），运行时会逐条校验（`createToolResult` →
 *      `ToolOutputError`），侧漏一个字段就炸，而**单测看不见**这一层（单测直接调依赖）。
 *
 * 阶段 2（**全新进程**）读回那棵树。它**不能**再用 sdk profile 去 prompt 那条 head：
 * `dsh 0.1.2-rc.1` 的 sdk 服务器建会话走 `agents.create({sessionId, meta})`，**不带 seed**，
 * 于是持久化层在 `adoptLivePrefix` 里做 `seedCoversPrefix([], 已落盘事件)` → 假 ⇒
 * turn 直接以 `error` 收尾：
 *
 * ```
 * Error: session "…" already has a persisted log on disk that does not match this live session (id collision)
 * ```
 *
 * 这**与本插件无关**：一条最普通的会话（不装插件）跨进程 prompt 同样报这个（已最小复现）。
 * 所以阶段 2 改用**生产 profile**（`dsh web`）——那里插件挂在 `ctx.webServer` 上的健康探针
 * 就是现成的观测面：`GET /api/dsh-autofork/health?sessionId=<head>` 返回整棵树。
 * 这比"再 prompt 一次"更接近用户真正会遇到的重启场景（用户重启的是 web）。
 *
 * ## 跑法
 *
 * ```sh
 * # 阶段 1：mock 序列 stall,tool_call_success,success（第 2 个请求让 head 调 fork_list）
 * MOCK_PORT=8123 MOCK_SEQUENCE=stall,tool_call_success,success \
 *   MOCK_TOOL_NAME=fork_list MOCK_TOOL_ARGS='{}' node tests/e2e/mock-server.mjs &
 * node tests/e2e/verify-lineage.mjs phase1          # 写出 /tmp/autofork-verify-head.txt
 * # 阶段 2：**换一个 mock 也行**（这一阶段只用 web 探针，不打模型），但必须新起一个进程
 * node tests/e2e/verify-lineage.mjs phase2 /tmp/autofork-verify-head.txt
 * ```
 */
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { cleanLineage, cleanSession } from './session-dir.mjs'

const PHASE = process.argv[2] ?? 'phase1'
const HEAD_FILE = process.argv[3] ?? '/tmp/autofork-verify-head.txt'
// 必须是**已装好这个插件**（且带官方依赖闭包）的隔离 home：`dsh plugin --profile sdk add <repo>` 之后
// 用那个 home，或者由 `DSH_HOME` 直接指定。别用共享的 `~/.dsh`——E2E 会在里面建会话。
const DSH_HOME = process.env.E2E_DSH_HOME ?? process.env.DSH_HOME ?? '/tmp/dsh-autofork-e2e-home'
const WORK_DIR = process.env.E2E_CWD ?? '/tmp/dsh-autofork-e2e-work'
const SESSION_ID = process.env.E2E_SESSION_ID ?? 'session-autofork-verify'
const MOCK_BASE = process.env.MOCK_BASE_URL ?? 'http://127.0.0.1:8123/v1'
/** 插件仓库根（本文件在 `<repo>/tests/e2e/` 下）。 */
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')

mkdirSync(WORK_DIR, { recursive: true })

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const say = (payload) => console.log(JSON.stringify(payload, null, 1))

/**
 * 起一个 sdk 进程并返回 RPC 通道。
 * @returns {any} `{send, events, sessions, kill, stderr}`。
 */
function connect() {
  const child = spawn('dsh', ['--profile', 'sdk'], {
    env: { ...process.env, DSH_HOME, DEEPSEEK_BASE_URL: MOCK_BASE, DEEPSEEK_API_KEY: 'mock-key' },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: WORK_DIR,
  })
  const state = { stderr: '', nextId: 1, pending: new Map(), events: [], sessions: new Set() }
  child.stderr.on('data', (chunk) => { state.stderr = (state.stderr + String(chunk)).slice(-2000) })
  const reader = createInterface({ input: child.stdout })
  reader.on('line', (line) => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    if (frame.id !== undefined && frame.method === undefined) {
      const settle = state.pending.get(frame.id)
      if (settle !== undefined) { state.pending.delete(frame.id); settle(frame) }
      return
    }
    if (frame.method === 'session.event') {
      // sessionId 在**通知的 params 上**，不在事件体里——所以必须在这里收集，
      // 事后从 events 上是取不到"这次跑出过哪几条会话"的（第一版就是这么错的：
      // 分叉明明成功了，`sessions` 却是空的，于是 head 文件没写成）。
      const sessionId = frame.params?.sessionId
      if (sessionId !== undefined) state.sessions.add(sessionId)
      state.events.push(frame.params?.event ?? frame.params)
    }
  })
  state.send = (method, params) => {
    const id = state.nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve) => {
      state.pending.set(id, resolve)
      setTimeout(() => { if (state.pending.delete(id)) resolve({ error: { code: 'timeout' } }) }, 60_000)
    })
  }
  state.kill = () => { child.kill('SIGKILL') }
  return state
}

/** 从 tool-result 的部件里取文本。 */
function textsOf(data) {
  const parts = data?.message?.content ?? data?.content ?? []
  return parts.flatMap((part) => {
    if (part?.type === 'tool-result') return textsOf({ content: part.content })
    return typeof part?.text === 'string' ? [part.text] : []
  })
}

/** 血缘域里现有的边文件（文件名 = head id；阶段 1 只应有一条）。 */
function edgeFiles() {
  const dir = join(DSH_HOME, 'storages', 'autofork_lineage', 'edges')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.json'))
}

/* ------------------------------ 阶段 1 ------------------------------ */
if (PHASE === 'phase1') {
  // 从**全新会话**开始：残留日志 = id collision；残留血缘边 = 序号一路涨 + 幽灵兄弟。
  say({ phase: PHASE, removed: cleanSession(DSH_HOME, WORK_DIR, SESSION_ID), lineage: cleanLineage(DSH_HOME) })

  const client = connect()
  const init = await client.send('initialize', {
    provider: 'deepseek-official', model: process.env.MODEL ?? 'deepseek-v4-flash', cwd: WORK_DIR,
  })
  say({ phase: PHASE, step: 'initialize', ok: init.error === undefined, error: init.error })

  const first = await client.send('session/prompt', {
    sessionId: SESSION_ID, cwd: WORK_DIR,
    contentBlocks: [{ type: 'text', text: '先跑一遍慢检查（sleep 40 那条），不要改任何文件。' }],
  })
  say({ phase: PHASE, step: 'prompt-1', ok: first.error === undefined })
  // 等在飞 step 变老，再发第二条 → 触发自动分叉。
  await sleep(Number(process.env.E2E_STEP_WAIT_MS ?? 16_000))
  const second = await client.send('session/prompt', {
    sessionId: SESSION_ID, cwd: WORK_DIR,
    contentBlocks: [{ type: 'text', text: '改成用 worktree 隔离：把当前改动挪到独立工作树' }],
  })
  say({ phase: PHASE, step: 'prompt-2', ok: second.error === undefined })
  // 让 head 的那一轮跑完（mock 的 `tool_call_success` 让它调 `fork_list`，再来一次 `success`）。
  await sleep(Number(process.env.E2E_SETTLE_MS ?? 20_000))

  const sessions = [...client.sessions]
  const head = sessions.find(id => id !== SESSION_ID)
  if (head !== undefined) writeFileSync(HEAD_FILE, head)

  // head 那一轮的 tool/result：`fork_list` 的输出 schema 真的过得了运行时校验吗。
  const headEvents = client.events
  const calls = headEvents.filter(event => event?.type === 'tool/call').map(event => event.data?.name)
  const toolTexts = headEvents.filter(event => event?.type === 'tool/result').flatMap(event => textsOf(event.data))

  say({
    phase: PHASE,
    sessions,
    head,
    headFile: head === undefined ? undefined : HEAD_FILE,
    edgesOnDisk: edgeFiles(),
    toolCalls: calls,
    // 渲染出来的家族（含 `↑ 我接管的` / `~ 同族的另一条分叉` 这类关系标记）
    toolTexts: toolTexts.map(text => text.split('\n').filter(line => line.trim() !== '').slice(0, 12)),
    stderr: client.stderr.slice(-300),
  })
  await client.send('shutdown').catch(() => {})
  await sleep(1000)
  client.kill()
  await sleep(200)   // 让 stdout 落尽再退（piped stdout 上 process.exit 会截断）
  process.exit(head === undefined ? 1 : 0)
}

/* ------------------------------ 阶段 2 ------------------------------ */

// web profile 里也得有本插件——阶段 2 用的就是生产 profile。
const webProfile = join(DSH_HOME, 'profiles', 'web', 'package.json')
if (!existsSync(webProfile)) {
  say({ phase: PHASE, step: 'install-web-profile' })
  execFileSync('dsh', ['plugin', '--profile', 'web', 'add', REPO], { env: { ...process.env, DSH_HOME }, stdio: 'inherit' })
}

const head = readFileSync(HEAD_FILE, 'utf8').trim()
const web = spawn('dsh', ['web', '--port', '0', '--no-open'], {
  env: { ...process.env, DSH_HOME }, stdio: ['ignore', 'pipe', 'pipe'], cwd: WORK_DIR,
})
let out = ''
web.stdout.on('data', (chunk) => { out += String(chunk) })
web.stderr.on('data', (chunk) => { out += String(chunk) })

/** 等启动日志里的 URL。 */
async function urlIn(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(out)
    if (found !== null) return found[0]
    await sleep(300)
  }
  return undefined
}

const url = await urlIn(30_000)
if (url === undefined) {
  say({ phase: PHASE, step: 'web-boot-failed', output: out.slice(-2000) })
  web.kill('SIGKILL')
  await sleep(200)
  process.exit(1)
}
const origin = new URL(url).origin
say({ phase: PHASE, step: 'web-up', origin, pluginTreeError: /plugin tree failed to load/.test(out) })

// 探针要等插件 apply 完（它自己会先 settle 血缘域再回答）。
let health
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    const response = await fetch(`${origin}/api/dsh-autofork/health?sessionId=${encodeURIComponent(head)}`)
    if (response.ok) { health = await response.json(); break }
  } catch { /* 还没起来 */ }
  await sleep(500)
}

say({
  phase: PHASE,
  asked: head,
  health: health ?? null,
  // 判据：整棵树必须从**根**开始，且这条 head 落在里面——这棵树完全是**跨进程**读回来的。
  nodes: Array.isArray(health?.nodes) ? health.nodes : null,
  stderr: out.slice(-300),
})
web.kill('SIGKILL')
await sleep(200)
process.exit(Array.isArray(health?.nodes) && health.nodes.length >= 2 ? 0 : 1)
