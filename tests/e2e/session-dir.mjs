/**
 * E2E 会话目录的定位与清理。
 *
 * ## 为什么需要它（两个都实测踩过，都会让"复跑"从全绿变全红）
 *
 * 1. **id collision**：E2E 用固定的 session id（否则没法对照），而 DSH 对"同一个 id、
 *    但不是同一个生命周期"有守卫。上一次跑剩下的日志会让下一次直接抛
 *    `session "…" already has a persisted log on disk that does not match this live session`
 *    —— 于是第二条 prompt 永不触发分叉，看起来像"插件坏了"。
 * 2. **被中断的 turn 卡死下一条会话**：上一次进程被 kill 时，日志可能停在
 *    `turn/start` + 消息已 claim 而**没有** `turn/end`；那条会话在下一个进程里
 *    prompt 起不来新 turn（恢复侧的平衡只发生在内存里）。
 *
 * 两件事都只能靠"每次跑前把这条会话删干净"解决 —— 也就是**全新会话**，而不是 resume。
 *
 * ## 目录编码：照抄官方，不要自己 sed
 *
 * 官方实现在 `@deepseek-ai/dsh-session-persistence-jsonl`（`projectKey` / `encodeSegment`）：
 *
 * - 路径分隔符（`/` `\` `:`）压成**一个** `-`（连续分隔符只出一个）；
 * - `[A-Za-z0-9._-]` 之外（且不是 `~`）的字符 → `~` + 4 位大写十六进制；
 * - 两端包 `--`，先去掉开头的连续 `-`，空则用 `root`，再截到 251 字符。
 *
 * 于是 `/tmp/dsh-autofork-e2e-work` → `--tmp-dsh-autofork-e2e-work--`。
 * 曾经的 `sed 's#/#-#g'` 写法少了**尾部的 `--`**，清理永远匹配不到（静默失效）；
 * 更糟的是 cwd 里只要有中文/空格，朴素替换就整个错位。所以这里逐字符复刻官方规则。
 *
 * 直接跑本文件可以打印目录，便于 shell 脚本复用（**单一事实来源**）：
 *
 * ```sh
 * SESSIONS=$(node tests/e2e/session-dir.mjs "$DSH_HOME" "$WORK")
 * ```
 */
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 安全字符：与官方 `encodeSegment` 的正则一致。 */
const SAFE = /^[A-Za-z0-9._-]$/
/** 官方把目录名截到 251 个字符长。 */
const MAX_LEN = 251

/**
 * 单个路径段的安全编码（官方 `encodeSegment` 的逐字符复刻）。
 * @param {string} raw 原始段（会话 id 等）。
 * @returns {string} 文件系统安全的一段。
 */
export function encodeSegment(raw) {
  const text = String(raw)
  if (text.length === 0) throw new Error('cannot encode an empty path segment')
  if (text === '.') return '~002E'
  if (text === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && SAFE.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * cwd → 项目目录名（官方 `projectKey` 的逐字符复刻）。
 * @param {string} cwd 会话的工作目录。
 * @returns {string} `<home>/sessions/` 下的一级目录名。
 */
export function projectKey(cwd) {
  const text = String(cwd)
  if (text.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && SAFE.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const stripped = readable.replace(/^-+/, '') || 'root'
  return `--${stripped.slice(0, MAX_LEN)}--`
}

/**
 * 会话日志所在的目录。
 * @param {string} home 隔离 DSH_HOME。
 * @param {string} cwd 会话的工作目录（与驱动面 `initialize` 的 cwd 一致）。
 * @returns {string} `<home>/sessions/<编码后的 cwd>`。
 */
export function sessionsDirOf(home, cwd) {
  return join(home, 'sessions', projectKey(cwd))
}

/**
 * 删掉一条会话的落盘日志，让下一次是全新会话。
 * @param {string} home 隔离 DSH_HOME。
 * @param {string} cwd 会话的工作目录。
 * @param {string} sessionId 会话 id。
 * @returns {string} 被删掉的路径（便于打印证据）。
 */
export function cleanSession(home, cwd, sessionId) {
  const dir = join(sessionsDirOf(home, cwd), encodeSegment(sessionId))
  rmSync(dir, { recursive: true, force: true })
  return dir
}

/**
 * 清掉**隔离 home 里这个插件的血缘存储域**，让命名证据可复现。
 *
 * 为什么需要：血缘边是**按 head 的 session id 记账**的，而 E2E 的父会话 id 固定。
 * 于是每跑一次就多几条"上一轮的 head"边，它们属于同一家族 ⇒ 序号一路涨（实测：全新 home
 * 第一跑就打出 `⑂3`，因为前几轮的边还在），`fork_list` 里还会冒出**幽灵兄弟**。
 * 那正是插件的已知待办（血缘不带生命周期身份；生产里 session id 是 uuid、不复用），
 * 但 E2E 不该每次都在噪声里读证据。
 *
 * 安全阀：解析结果落在**共享 home**（`~/.dsh`）下时**拒绝删除**，只返回跳过原因——
 * 那段数据是用户的，不是 E2E 的。
 *
 * @param {string} home 隔离 DSH_HOME。
 * @returns {{removed: string|undefined, skipped: string|undefined}} 结果（用于打印证据）。
 */
export function cleanLineage(home) {
  const shared = join(homedir(), '.dsh')
  const target = join(home, 'storages', 'autofork_lineage')
  if (resolve(home) === resolve(shared)) return { removed: undefined, skipped: 'shared-home' }
  rmSync(target, { recursive: true, force: true })
  return { removed: target, skipped: undefined }
}

// 直接执行时打印目录（给 shell 用）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [home, cwd] = process.argv.slice(2)
  if (home === undefined || cwd === undefined) {
    console.error('用法：node session-dir.mjs <DSH_HOME> <cwd>   # 打印该 cwd 的项目目录')
    process.exit(2)
  }
  console.log(sessionsDirOf(home, cwd))
}
