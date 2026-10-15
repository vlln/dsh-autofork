/**
 * Node half 的用户可见文案字典 + 界面语言解析。
 *
 * ## 为什么宿主半边也要字典
 *
 * 官方把**用户可见**文案留给客户端（`ui-commands` 的 `command` 命名空间提供 `/goal`、`/compact`
 * 的中文标题，宿主描述符只有英文 `description`）。但本插件有一半用户可见文案产生在**宿主**：
 * 工具结果（`fork_send` / `fork_cancel`）、注入进会话的进展行、容器转写行、会话标题、卡片前缀。
 * 它们的读者是用户，所以宿主也要能选语言。
 *
 * ## 语言从哪来（按可信度排序）
 *
 * 1. **客户端回传**（`?lang=` 挂在既有的 1s health 轮询上，见 `HEALTH_PATH`）：界面语言最终由
 *    浏览器决定（用户没显式选过时按 `navigator` 回退），**只有客户端知道**——它在场就以它为准。
 * 2. **宿主设置文档**：官方把偏好持久化成设置命名空间 `locale` 的字段 `preference`（BCP 47）。
 *    没有客户端在场时（headless / CLI）读它；只在**没有回传过**时生效（回传更权威）。
 * 3. 都没有 ⇒ `zh`：本插件的历史行为，headless 场景保持中文。
 *
 * 语言变化后命令描述这类**注册期**文案要重新注册才变（`commands/change` 会让面板刷新）；
 * 回执与注入正文是每次执行现读，下一次就跟着变。
 */

/** 支持的语言（白名单：非白名单值不改变当前语言）。 */
const LANGS = ['zh', 'en']

/** 默认语言（客户端与设置都没有时的回退；保持本插件的历史行为）。 */
const DEFAULT_LANG = 'zh'

/**
 * 文案字典。键与客户端字典同风格（点分小写、≥2 段），参数用 `{name}`。
 * 客户端那份在 `client/index.js` 的 `DICTS`（手写单文件 bundle，无法从这里 import）。
 */
const DICTS = {
  zh: {
    /* 注入进会话的正文（用户能看见，模型也读） */
    'inject.prefix': '分叉会话 {senderId} 发来{what}{note}：',
    'inject.prefix.message': '消息',
    'inject.prefix.awaiting': '（它在等你回复）',
    'inject.resumeUnavailable': '原会话当前不在本进程，无法读取实时进度；未恢复或启动原任务。',
    'inject.noInflight': '原会话当前没有可读取的在飞进度。',
    'inject.takeoverConfirmed': '用户已确认由本会话接手原会话 {parentId}。后续用户指令转到这里；原会话继续原任务，完成后按发送方自动回注设置回传。分叉历史未改写。\n\n{progress}',
    /* 容器转写行 */
    'container.nowAnswering': '[容器] 现在由 {label}（会话 {id}）负责回答你。',
    'container.previousStillRunning': '前一个实例 {label} 仍在后台跑它没做完的那一轮，不会被中止。',
    'container.workingInBackground': '它在后台工作，产出会出现在这条对话里。',
    /* 折叠摘要（`form:'notice'` 的一行 account） */
    'summary.switchedTo': '已切换到 {label} 回答',
    'summary.nowAnswering': '现在由 {label} 回答',
    'summary.forkedTo': '已分叉：{label} 接走了下一条消息，你继续当前的活',
    /* 会话标题兜底（钉进 session/title，侧栏/面包屑/搜索都显示） */
    'session.title.fallback': '会话 {shortId}',
    /* driver 标签（容器模式 health / 通知用） */
    'driver.thisSession': '本会话',
    /* fork_list 的输出（工具卡里给用户看，模型也读） */
    'list.state.running': '运行中（正在跑自己的 turn）',
    'list.state.idle': '空闲（可以立刻接话）',
    'list.empty': '你的家族里目前没有其它会话（没有发生过分叉，也没有被别的会话接管）。',
    'list.arrow.upstream': '↑ 我接管的',
    'list.arrow.downstream': '↓ 接管了我的',
    'list.arrow.sibling': '~ 同族的另一条分叉',
    /* 工具结果 */
    'tool.denied': '该工具必须在 agent 会话内调用：无法确定调用者身份，已拒绝。',
    'tool.notInFamily': '"{id}" 不在你的家族里；先用 fork_list 查看。',
    'tool.resumeFailed': '会话 "{id}" 此刻无法恢复（可能正被另一个进程打开）。',
    'tool.resumeFailed.hint': ' 用 fork_list 确认它还在家族里，或先在界面上打开它。',
    'tool.delivered': '已向 "{id}" 投递；它会在当前 step 结束后读到。',
    'tool.revived': '（它此前不在运行，已自动恢复。）',
    'tool.noAutoReply': '**它不会自动回复你** —— 要答复就用 block:true 等它这一轮跑完，或稍后 fork_list 看进展。',
    'tool.blockInterrupted': '但**等待被中断**（调用方中止或工具超时）；它仍会读到这条消息。',
    'tool.blockTimeout': '等了 {seconds} 秒它这一轮还没结束',
    'tool.blockTimeout.hint': '（可能还在跑长任务）。用 fork_list 看进展，或稍后再问它一次。',
    'tool.cancel.notRunning': '会话 "{id}" 已不在运行。',
    'tool.cancel.done': '已中止会话 "{id}"（keepInbox={keepInbox}）。',
  },
  en: {
    /* Text injected into a session (visible to the user, read by the model) */
    'inject.prefix': 'Forked session {senderId} sent {what}{note}:',
    'inject.prefix.message': 'a message',
    'inject.prefix.awaiting': ' (it is waiting for your reply)',
    'inject.resumeUnavailable': 'The original session is not in this process, so its live progress cannot be read; it was neither resumed nor started.',
    'inject.noInflight': 'The original session currently has no in-flight progress to read.',
    'inject.takeoverConfirmed': 'The user confirmed that this session takes over the original session {parentId}. Later user instructions go here; the original session keeps running its task and reports back according to its sender auto-report setting. The fork history is not rewritten.\n\n{progress}',
    /* Container transcript lines */
    'container.nowAnswering': '[container] {label} (session {id}) is answering you now.',
    'container.previousStillRunning': 'The previous instance {label} is still running its unfinished turn in the background and will not be stopped.',
    'container.workingInBackground': 'It works in the background; its output shows up in this conversation.',
    /* Collapsed summaries (the one-line account of a `form:'notice'` row) */
    'summary.switchedTo': 'Switched to {label}',
    'summary.nowAnswering': '{label} is answering now',
    'summary.forkedTo': 'Forked: {label} took the next message; keep working on your current task',
    /* Session title fallback (pinned into session/title; shown in the sidebar, breadcrumb, search) */
    'session.title.fallback': 'Session {shortId}',
    /* Driver label (container-mode health / notices) */
    'driver.thisSession': 'this session',
    /* fork_list output (shown in the tool card, also read by the model) */
    'list.state.running': 'Running (working on its own turn)',
    'list.state.idle': 'Idle (can take a message right away)',
    'list.empty': 'Your family has no other sessions right now (no forks yet, and no session has taken over yours).',
    'list.arrow.upstream': '↑ I took over',
    'list.arrow.downstream': '↓ took over mine',
    'list.arrow.sibling': '~ another fork in the same family',
    /* Tool results */
    'tool.denied': 'This tool must be called inside an agent session: the caller identity is unknown, so the call was refused.',
    'tool.notInFamily': '"{id}" is not in your family; use fork_list to look it up first.',
    'tool.resumeFailed': 'Session "{id}" cannot be resumed right now (it may be open in another process).',
    'tool.resumeFailed.hint': ' Use fork_list to confirm it is still in the family, or open it in the UI first.',
    'tool.delivered': 'Delivered to "{id}"; it will read this after its current step ends.',
    'tool.revived': ' (it was not running, so it was resumed automatically.)',
    'tool.noAutoReply': '**It will not reply to you automatically** — to get an answer use block:true and wait for its turn to finish, or check fork_list later.',
    'tool.blockInterrupted': 'but **the wait was interrupted** (the caller aborted or the tool timed out); it will still read this message.',
    'tool.blockTimeout': 'waited {seconds}s and its turn has not finished',
    'tool.blockTimeout.hint': ' (it may be running a long task). Use fork_list to check progress, or ask it again later.',
    'tool.cancel.notRunning': 'Session "{id}" is no longer running.',
    'tool.cancel.done': 'Cancelled session "{id}" (keepInbox={keepInbox}).',
  },
}

/** 当前语言（白名单内；见模块头的解析顺序）。 */
let lang = DEFAULT_LANG

/** 是否已有客户端回传过语言（有回传就不再被设置文档覆盖）。 */
let relayed = false

/**
 * 设置当前语言（非白名单值忽略）。
 * @param {unknown} value 候选语言，如 `'en'` / `'zh-CN'`。
 * @param {{relay?: boolean}} [options] `relay: true` 表示来自客户端回传（比设置文档权威）。
 * @returns {boolean} 语言是否因此改变。
 */
export function setLang(value, options = {}) {
  const next = typeof value === 'string' ? value.trim().toLowerCase().split('-')[0] : ''
  if (!LANGS.includes(next)) return false
  if (options.relay === true) relayed = true
  else if (relayed) return false // 客户端已表态，设置文档不再覆盖
  if (next === lang) return false
  lang = next
  return true
}

/**
 * 当前语言。
 * @returns {string} `'zh'` 或 `'en'`。
 */
export function getLang() {
  return lang
}

/**
 * 翻译：查当前语言 → 缺键回退中文 → 再缺返回键本身（可见但不崩）。
 * @param {string} key 字典键。
 * @param {Record<string, unknown>} [params] `{name}` 占位符的值。
 * @returns {string} 文案。
 */
export function t(key, params) {
  const template = DICTS[lang]?.[key] ?? DICTS[DEFAULT_LANG][key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match)
}

/**
 * 从宿主设置文档读界面语言（官方把偏好持久化成命名空间 `locale` 的 `preference`）。
 *
 * `ctx.settings.describe()` 只列**活跃**条目；读不到（没有 settings 服务、locale 命名空间
 * 不在、用户从没显式选过语言）时什么都不做——回退是 §3 的 `zh`。
 * 走**嵌套** `ctx.inject(['settings'], …)`：没有设置服务的组合里这段代码不执行。
 * @param {any} ctx cordis 上下文（插件 apply 的 ctx）。
 * @returns {void}
 */
export function attachSettings(ctx) {
  // 桩/极简组合里 `inject` 或作用域形状可能不完整 —— 这类防御在本仓库是惯例
  // （见 `ctx.on` 返回 undefined 的那条事实）：读不到语言不是错误，保持默认语言即可。
  if (ctx === undefined || typeof ctx.inject !== 'function') return
  ctx.inject(['settings'], (scope) => {
    const settings = typeof scope?.get === 'function' ? scope.get('settings') : undefined
    if (settings === undefined || typeof settings.describe !== 'function') return
    const read = () => {
      try {
        const descriptor = settings.describe().find((item) => item?.ns === 'locale')
        const value = descriptor?.value?.preference ?? descriptor?.user?.preference
        setLang(value)
      } catch (error) {
        // 设置面读失败不影响分叉本体：保持当前语言。
      }
    }
    read()
    // 用户在设置里改了语言：重新读一次（`settings/document-updated` 是官方事件）。
    if (typeof scope.effect !== 'function') return
    scope.effect(() => {
      const off = typeof scope.on === 'function' ? scope.on('settings/document-updated', read) : undefined
      return typeof off === 'function' ? off : undefined
    }, 'dsh-autofork: locale settings read')
  })
}

/** 字典本体（门禁/自证测试用；正常调用走 {@link t}）。 */
export const DICTIONARIES = DICTS

/** 支持的语言列表。 */
export const SUPPORTED_LANGS = LANGS