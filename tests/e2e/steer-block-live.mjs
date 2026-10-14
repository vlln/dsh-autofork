/**
 * E2E（**真模型，需要凭据**）：`fork_send(block:true)` 真的会**阻塞等待**，并且把对方那一轮
 * 的最后一条回复作为工具结果返回。
 *
 * ## 为什么是"真模型"这一档
 *
 * 仓库里另外两台 E2E 用 mock（不需要凭据），但它们在本机跑不通这条：
 *
 * - `dsh-llm-deepseek`（provider `deepseek-official` 背后的适配器）**只能走 Messages API**
 *   （源码原话："protocol is not configurable; use a Messages-compatible baseURL"），
 * - 而官方 mock 只服务 `/chat/completions`（其余路径 404）。
 *
 * ⇒ 想用 mock 就得上 **pi-ai 路由**（profile 里 `api: openai-completions` + `baseURL` 指 mock）。
 * 那是另一件事；本文件先用"真模型 + 真 loop"把 `block` 的行为钉住。
 *
 * ## 一个关键设计（踩过才知道）
 *
 * 驱动面是 `dsh --profile <p>` 的 stdio JSON-RPC，而 **SDK 不能 prompt 插件创建的会话**
 * （head 由 `ctx.agents.create` 建，再 prompt 它会与盘上日志 id collision，那一轮静默 error）。
 * 所以这里**不去驱动 head**：`block` 是**对称**的 —— 让 SDK 建的 A 去阻塞等 head 一样能验
 * 整条机制。而且 A 忙的时候再发指令会**继续链式分叉**（新的 head 才是真正的调用者），
 * 所以判据一律**扫盘上所有会话**找那次 `block:true` 调用，而不是假设调用者是谁。
 *
 * 跑法（隔离 home 必须已装本插件 + 有可用凭据）：
 *
 * ```sh
 * E2E_DSH_HOME=/tmp/dsh-autofork-demo E2E_PROFILE=autofork-sdk \
 * E2E_MODEL=deepseek-v4.1-flash-expires-on-0910 node steer-block-live.mjs
 * ```
 *
 * 环境变量：`E2E_CWD`（默认 `/tmp/dsh-autofork-e2e-work`）、`E2E_SESSION_ID`、
 * `E2E_PROVIDER`、`E2E_MODEL`、`E2E_PROFILE`、`E2E_FORK_DELAY_MS`（默认 4000）、
 * `E2E_TIMEOUT_MS`（默认 240000）、`E2E_BLOCK_TIMEOUT_MS`（写进插件的
 * `forkSendBlockTimeoutMs`，默认 180000）。
 *
 * 退出码：0 = 通过；1 = 没验到（会打印盘上原始证据，便于判断是插件坏了还是模型没照做）。
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { zstdDecompressSync } from 'node:zlib'
import { cleanLineage, cleanSession, sessionsDirOf } from './session-dir.mjs'

const HOME_DIR = process.env.E2E_DSH_HOME ?? process.env.DSH_HOME ?? '/tmp/dsh-autofork-live-home'
const WORK = process.env.E2E_CWD ?? '/tmp/dsh-autofork-e2e-work'
const PROFILE = process.env.E2E_PROFILE ?? 'sdk'
const SESSION_ID = process.env.E2E_SESSION_ID ?? 'session-steer-block-e2e'
const PROVIDER = process.env.E2E_PROVIDER ?? 'deepseek-official'
const MODEL = process.env.E2E_MODEL ?? 'deepseek-v4-flash'
const FORK_DELAY_MS = Number(process.env.E2E_FORK_DELAY_MS ?? 4000)
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 240_000)
const BLOCK_TIMEOUT_MS = Number(process.env.E2E_BLOCK_TIMEOUT_MS ?? 180_000)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = (...parts) => console.log(JSON.stringify(Object.assign({}, ...parts)))

/** 逐帧解压一份会话日志（多帧 zstd，整文件解压只出第一帧）。 */
function rowsOf(path) {
  const raw = readFileSync(path)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) if (raw.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : raw.length
    text += zstdDecompressSync(raw.subarray(starts[k], end)).toString('utf8')
  }
  return text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

const SESSIONS = sessionsDirOf(HOME_DIR, WORK)
const logPathOf = id => `${SESSIONS}/${id}/session.v4.jsonl.zstd`
const allSessionIds = () => {
  try { return readdirSync(SESSIONS).filter(name => name.startsWith('session-') && existsSync(logPathOf(name))) }
  catch { return [] }
}
const textOf = row => (row?.data?.message?.content ?? row?.data?.content ?? []).map(part => part?.text ?? '').join('')

if (process.env.E2E_CLEAN_LINEAGE === '1') {
  await cleanLineage(HOME_DIR)
  log({ step: 'lineage-cleaned', home: HOME_DIR })
}
await cleanSession(HOME_DIR, WORK, SESSION_ID)
log({ step: 'start', home: HOME_DIR, profile: PROFILE, provider: PROVIDER, model: MODEL, session: SESSION_ID })

const child = spawn('dsh', ['--profile', PROFILE], {
  env: {
    ...process.env,
    DSH_HOME: HOME_DIR,
    DSH_AUTOFORK_PARAMS: JSON.stringify({ forkSendBlockTimeoutMs: BLOCK_TIMEOUT_MS }),
  },
  cwd: WORK,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderrTail = ''
child.stderr.on('data', chunk => { stderrTail = (stderrTail + String(chunk)).slice(-800) })

let nextId = 1
const pending = new Map()
createInterface({ input: child.stdout }).on('line', line => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (frame.id !== undefined && frame.method === undefined) {
    const settle = pending.get(frame.id)
    if (settle !== undefined) { pending.delete(frame.id); settle(frame) }
  }
})
const send = (method, params) => {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise(resolve => {
    pending.set(id, resolve)
    setTimeout(() => { if (pending.delete(id)) resolve({ error: { code: 'timeout' } }) }, 60_000)
  })
}
const prompt = (sessionId, text) => send('session/prompt', {
  sessionId, cwd: WORK, contentBlocks: [{ type: 'text', text }],
})

await send('initialize', { provider: PROVIDER, model: MODEL, cwd: WORK })

// **只认本次运行之后的调用**：判据扫的是盘上所有会话（见文件头），上一次跑留下的
// `block:true` 调用同样"有结果"，不过滤就会拿旧证据当通过 —— 实测踩到过。
const runStart = Date.now()

log({ step: 'prompt-1（让父会话忙起来）' })
await prompt(SESSION_ID, '请写一篇约 900 字的说明，主题是"为什么写文件前要重读"，分四小节。')
await sleep(FORK_DELAY_MS)
log({ step: 'prompt-2（父会话忙时插入 ⇒ 触发分叉）' })
await prompt(SESSION_ID, '另外把结论压成一句话。')

// 等分叉出 head（血缘边 workerId = 本会话）。
const headOf = () => {
  try {
    for (const name of readdirSync(`${HOME_DIR}/storages/autofork_lineage/edges`)) {
      const edge = JSON.parse(readFileSync(`${HOME_DIR}/storages/autofork_lineage/edges/${name}`, 'utf8'))
      if (edge?.record?.workerId === SESSION_ID) return name.replace(/\.json$/, '')
    }
  } catch { /* 血缘域可能还没建 */ }
  return null
}
let head = null
const headDeadline = Date.now() + 120_000
while (head === null && Date.now() < headDeadline) { await sleep(5000); head = headOf() }
log({ step: 'head', head })
if (head === null) {
  console.error('❌ 没有分叉出 head（父会话没被判为"忙"，或插件没跑起来）')
  child.kill()
  process.exit(1)
}

// 让父会话用 block:true 去问 head。注意：这条指令本身也可能再次触发分叉（父会话那时可能仍在忙），
// 所以真正的调用者是谁要看盘 —— 判据不假设。
// ⚠️ 目标必须**此刻还活着**：分叉出来的 head 在它那一轮跑完后，它的 agent 可能已经被释放，
// 这时 steer 会走"已不在运行"那条早退（实测踩到，测试会误判成插件坏了）。所以让调用者
// 先 `fork_list` 挑一条状态不是"已结束"的——这也正是真实 agent 的做法。
log({ step: 'prompt-3（要求 block:true 的中途指令）' })
await prompt(SESSION_ID,
  '请按顺序做两件事，不要做别的：\n'
  + '1) 调用 fork_list，看家族里每条会话的状态；\n'
  + '2) 从中挑一条**状态不是"已结束"、且不是你自己**的会话，对它调用 fork_send：'
  + 'sessionId=<它的 id>、text="请用一句话总结你刚才在做什么"、block=true。\n'
  + '它会在对方那一轮跑完后返回对方的最后一条回复。拿到回复后，把回复原文贴出来。'
  + `（刚才分叉出来的那条是 ${head}，若它已结束就换一条。）`)

/** 扫盘上所有会话，找**最新**那次 block:true 的 fork_send 调用。 */
function findBlockCall() {
  const found = []
  for (const id of allSessionIds()) {
    let rows
    try { rows = rowsOf(logPathOf(id)) } catch { continue }
    for (const row of rows) {
      if (row.type !== 'tool/call' || row.data?.name !== 'fork_send') continue
      if (!/"block":\s*true/.test(String(row.data.arguments))) continue
      if ((row.time ?? 0) < runStart) continue
      const result = rows.find(candidate => candidate.type === 'tool/result' && candidate.seq > row.seq
        && candidate.data?.message?.source?.callId === row.data.callId)
      found.push({ caller: id, rows, call: row, result })
    }
  }
  return found
}

let hit = null
const deadline = Date.now() + TIMEOUT_MS
while (hit === null && Date.now() < deadline) {
  await sleep(5000)
  const calls = findBlockCall()
  hit = calls.find(candidate => candidate.result !== undefined) ?? null
  if (calls.length > 0 && hit === null) log({ step: 'observe', note: '已调用，等结果', waited: Math.round((Date.now() + TIMEOUT_MS - deadline) / 1000) })
}
child.kill()

console.log('\n================ 判据 ================')
const fail = reason => { console.error(`❌ ${reason}`); if (stderrTail !== '') console.error(stderrTail); process.exit(1) }
if (hit === null) fail('没有观察到"带 block:true 且拿到结果"的 fork_send 调用')

const { caller, call, result } = hit
const args = JSON.parse(String(call.data.arguments))
const resultText = textOf(result)
const elapsed = Math.round(((result.time ?? 0) - (call.time ?? 0)) / 1000)
const counterpart = String(args.sessionId)
const counterpartRows = existsSync(logPathOf(counterpart)) ? rowsOf(logPathOf(counterpart)) : []
// 对方收到的那条：**新形状是卡片**（`agent-message` + `relay` + `autofork:'steer'`，
// 0.6.0 起）——老形状是 `form:'notice'` 且 summary 写着「中途指令」，两种都认，便于拿旧构建对照。
const steerRows = counterpartRows.filter(row => row.type === 'user/message'
  && (row.data?.source?.autofork === 'steer'
    || JSON.stringify(row.data?.source ?? {}).includes('中途指令')))
const steerInside = steerRows.filter(row => (row.time ?? 0) >= (call.time ?? 0) && (row.time ?? 0) <= (result.time ?? 0))
const afterCaller = hit.rows.filter(row => row.type === 'assistant/message' && row.seq > result.seq).length

console.log(`调用者 = ${caller}（真模型下可能是链式分叉出来的新 head，所以不假设是谁）`)
console.log(`① 调用参数 block=true ? ${/"block":\s*true/.test(String(call.data.arguments)) ? '✅' : '❌'}`)
console.log(`② 工具结果带回对方最后一条回复 ? ${/这一轮跑完了/.test(resultText) && /最后一条回复/.test(resultText) ? '✅' : '❌'}`)
console.log(`   走了兜底分支（超时/被中断）? ${/还没结束|等待被中断/.test(resultText) ? '❌ 是' : '✅ 否'}`)
console.log(`③ 真的等了（调用→结果 ${elapsed}s）? ${elapsed > 0 ? '✅' : '❌'}`)
console.log(`④ 对方在等待窗口内收到跨会话消息（steer 卡片）? ${steerInside.length > 0 ? '✅' : '❌'}（共 ${steerRows.length} 条，窗口内 ${steerInside.length} 条）`)
// ⑤ 只是参考：调用者可能在同一个 turn 里就答完了，扫描时刻未必看得到后续 assistant。
console.log(`⑤（参考）调用者拿到结果后的 assistant 数：${afterCaller}`)
console.log('\n结果正文：\n' + resultText.slice(0, 400))

if (!/"block":\s*true/.test(String(call.data.arguments))) fail('调用没有带 block:true')
if (!/这一轮跑完了/.test(resultText) || !/最后一条回复/.test(resultText)) fail('结果里没有带回对方的回复')
if (/还没结束|等待被中断/.test(resultText)) fail('走了兜底分支（超时/被中断），没验到"等到了"')
if (!(elapsed > 0)) fail('调用与结果之间没有时间间隔，可疑')
if (steerInside.length === 0) fail('对方没有在等待窗口内收到跨会话消息（steer 卡片）')
console.log('\n✅ 通过：block:true 真的阻塞等到对方那一轮结束，并把它的最后一条回复作为结果返回。')
process.exit(0)
