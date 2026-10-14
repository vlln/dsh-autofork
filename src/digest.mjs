/**
 * 确定性渲染：把一段 session 事件流渲染成注入用的文本。
 *
 * 三条硬约束（用户 2026-09 拍板「确定性渲染」）：
 *  1. **纯函数**：无 Date.now()、无随机数、无 I/O。同一输入必得同一输出，
 *     因此可复现、可测试、可用于回归对比。
 *  2. **有界**：任何输入都产出不超过预算的文本，且**显式标注丢弃了什么**
 *     （静默截断会让阅读者误以为看到了全貌）。
 *  3. **不发明内容**：只从事件里取字段，不推断、不总结、不改写。
 *
 * 三个渲染面：
 *  - renderForkNotice    —— fork 发生时告诉新分叉会话「你是谁、有个兄弟在跑、怎么避让」
 *  - renderInFlightDigest—— 把兄弟分叉会话**正在进行中**的 turn 渲染成可读进度
 *  - renderBackgroundResult —— 后台分叉会话跑完后，把它这一 turn 的结果回注前台
 *
 * @module dsh-autofork/digest
 */

/** 截断标记：显式带上被丢弃的字符数，便于判断信息损失量。 */
const ELLIPSIS = '…'

/**
 * `form:'notice'` 的 `summary` 上限。
 *
 * 与官方 `@deepseek-ai/dsh-llm` 的 `CONTEXT_SUMMARY_MAX_CHARS` **同值**，但本插件
 * 不 import 官方包（分发契约：不声明 `@deepseek-ai/*` 依赖），所以在这里复刻。
 * 依据（`dsh-llm/lib/types/message.d.ts`）：`notice` 形式的 `summary` 是"不展开
 * 就能读的那一行 account"，因此必须**有界**——它会被折叠行直接显示。
 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * 把一行摘要压到 {@link CONTEXT_SUMMARY_MAX_CHARS} 以内。
 *
 * 与官方 `boundContextSummary` 同语义（超限则 `slice(0, 119) + '…'`）。这里**不用**
 * {@link truncate}：后者会附上 `(+N)` 的丢弃量标注，那是给"注入正文"用的信息损失
 * 标记；折叠行只有一行，标注会把真正的内容挤掉。
 * @param {string} text 生产者给出的一行 account。
 * @returns {string} 有界的一行 account。
 */
export function boundSummary(text) {
  const line = oneline(text)
  return line.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? line
    : `${line.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}${ELLIPSIS}`
}

/**
 * 按字符数截断，并在截断处标注丢弃量。
 * @param {string} text 原文。
 * @param {number} limit 字符上限。
 * @returns {string} 原文，或已截断并带标注的文本。
 */
export function truncate(text, limit) {
  if (typeof text !== 'string') return ''
  if (limit <= 0) return text.length === 0 ? '' : `${ELLIPSIS}(+${text.length})`
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}${ELLIPSIS}(+${text.length - limit})`
}

/**
 * 折叠换行与多余空白，使同一语义内容在不同来源下渲染一致。
 * @param {string} text 原文。
 * @returns {string} 单行化后的文本。
 */
export function oneline(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * 从一个 content part 里取出可读文本。只认已知形状，未知形状退回有界的 JSON。
 * @param {unknown} part 一个 content part。
 * @param {number} limit 字符上限。
 * @returns {string} 该 part 的可读文本。
 */
export function partText(part, limit) {
  if (part === null || typeof part !== 'object') return truncate(String(part ?? ''), limit)
  const p = /** @type {Record<string, any>} */ (part)
  if (typeof p.text === 'string') return truncate(oneline(p.text), limit)
  if (Array.isArray(p.content)) {
    return truncate(p.content.map(inner => partText(inner, limit)).filter(Boolean).join(' '), limit)
  }
  if (typeof p.name === 'string' && p.arguments !== undefined) {
    return truncate(oneline(`${p.name} ${String(p.arguments)}`), limit)
  }
  return truncate(oneline(safeJson(p)), limit)
}

/**
 * 有界 JSON 序列化：循环引用或超长对象都退化为可读的短标记。
 * @param {unknown} value 任意值。
 * @returns {string} JSON 文本或退化标记。
 */
export function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return '[unserializable]'
  }
}

/**
 * 取出一个 user/assistant 消息的正文文本（跳过 `tool-call` 部件——那是参数，不是人说的话）。
 *
 * 导出是给**「分叉」页签**用的：它要显示"是哪条指令触发的这次分叉"。与 digest 共用同一个
 * 取法，避免两处对"什么算正文"理解不一致。
 * @param {any} message 消息对象。
 * @param {number} limit 字符上限。
 * @returns {string} 正文文本。
 */
export function messageText(message, limit) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part?.type === 'tool-call') continue
    const text = partText(part, limit)
    if (text !== '') parts.push(text)
  }
  return truncate(parts.join(' '), limit)
}

/**
 * 取出一个 assistant 消息里请求的工具调用。
 * @param {any} message 消息对象。
 * @param {number} limit 参数截断长度。
 * @returns {string[]} 每个工具调用一行。
 */
function messageToolCalls(message, limit) {
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content
    .filter(part => part?.type === 'tool-call')
    .map(part => ({
      id: typeof part.id === 'string' ? part.id : undefined,
      text: `${part.name}(${truncate(oneline(String(part.arguments ?? '')), limit)})`,
    }))
}

/**
 * 把这些 session 事件渲染成按 seq 升序的文本行。
 *
 * 只处理派生历史与结构相关的事件类型；未知类型被忽略（前向兼容：新增事件
 * 类型不会让 digest 崩掉或静默变形）。
 *
 * @param {readonly any[]} events session 事件（含 seq/type/data）。
 * @param {typeof import('./params.mjs').DEFAULT_PARAMS} params 渲染预算。
 * @returns {{pinned: string[], flow: string[]}} 固定保留行与可丢弃行。
 */
export function renderEventLines(events, params) {
  const pinned = []
  const flow = []
  // 同一次工具调用在日志里出现**两处**：`assistant/message` 里的 tool-call 部件
  // （模型的请求）与独立的 `tool/call` 事件（实际发起）。两份都渲染会让同一条调用
  // 在 digest 里出现两次——实测中分叉出来的 agent 据此误判"兄弟发起了两次相同的 bash"。
  // 以 `tool/call` 为准；仅当某个 callId 没有对应的 `tool/call` 时（例如被拒绝、
  // 从未执行）才回退到 message 部件。
  const executed = new Set()
  for (const event of events) {
    const callId = event?.type === 'tool/call' ? event.data?.callId : undefined
    if (typeof callId === 'string') executed.add(callId)
  }
  for (const event of events) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start':
        pinned.push(`--- turn ${data.turn} 开始 ---`)
        break
      case 'user/message': {
        // 只有**人类**消息才是"兄弟在做的事"，才值得固定保留。
        // 注入上下文（system prompt 快照、skill 目录、runtime context、定时通知…）
        // 是喂给兄弟的样板材料，不是它的工作——实测里一份 skill 目录就能吃光整条
        // digest 的字符预算，把真正有用的进度挤掉。这里只留一个紧凑标记，且
        // 标记可被预算丢弃。
        if (data?.source?.kind === 'user') {
          const text = messageText(data, params.digestAssistantChars)
          if (text !== '') pinned.push(`[用户] ${text}`)
        } else {
          const producer = data?.source?.plugin ?? data?.source?.kind ?? 'unknown'
          flow.push(`[注入上下文 ${producer}]`)
        }
        break
      }
      case 'step/start':
        flow.push(`[step ${data.step} 开始]`)
        break
      case 'step/end':
        flow.push(`[step ${data.step} 结束]`)
        break
      case 'assistant/message': {
        const text = messageText(data.message, params.digestAssistantChars)
        if (text !== '') flow.push(`[助手] ${text}`)
        for (const call of messageToolCalls(data.message, params.digestToolArgsChars)) {
          // 已由 `tool/call` 事件渲染过的不再重复（见本函数开头的 executed 集合）
          if (call.id !== undefined && executed.has(call.id)) continue
          flow.push(`[调用] ${call.text}`)
        }
        break
      }
      case 'tool/call':
        flow.push(`[调用] ${data.name}(${truncate(oneline(String(data.arguments ?? '')), params.digestToolArgsChars)})`)
        break
      case 'tool/result': {
        const failed = data.error !== undefined
          || data.message?.content?.some(part => part?.isError === true) === true
        const text = messageText(data.message, params.digestToolResultChars)
        flow.push(`[结果${failed ? ' 失败' : ''}] ${text}`)
        break
      }
      default:
        break
    }
  }
  return { pinned, flow }
}

/**
 * 在字符预算内组装行：**两端都从"最近"往回保**，省略处就地标注。
 *
 * 两条不变量（都是用户实测反馈推出来的）：
 *
 *  1. **最新状态必须留**。分叉会话最需要知道的是"兄弟**现在**在做什么"，而它这一轮的内容
 *     只能由 digest 承载（seed 切在 turn 边界，在飞 turn 不在上下文里）。所以可丢弃行
 *     **从最近往前**保留。
 *  2. **固定行也不能无界**。在飞 turn 里人类消息的**条数不设上限**（连续 steer、长指令，
 *     每条截到 `digestAssistantChars` 但条数不限）。早期版本固定行全留 ⇒ 20 条指令就能
 *     吃光 8000 字符预算、把进度挤到只剩 1 行、正文还超出预算 50%——那才是真正的
 *     "丢失最新情况"。所以固定行**最多占一半预算**，且只保 `pinned[0]`（turn 起始行，
 *     一个 turn 的身份）与该上限内的**最近**几条用户指令。
 *
 * 省略**就地标注**（不再只在末尾写一句"（N 行未渲染）"）：那句话挂在末尾会被读成
 * "末尾被砍掉了"，而实际被丢的是**更早**的行。
 *
 * @param {{pinned: string[], flow: string[]}} lines 渲染行。
 * @param {number} budget 字符上限。
 * @returns {{text: string, omitted: number, droppedPinned: number}} 组装结果、被丢弃的
 *   流动行数、被丢弃的固定行数（不含 turn 起始行）。
 */
export function assembleWithinBudget(lines, budget) {
  const pinnedBudget = Math.floor(budget / 2)
  // 第 0 条是 `--- turn N 开始 ---`：一个 turn 的身份，永远保留（它只有几十字符）。
  const identity = lines.pinned.length > 0 ? lines.pinned[0] : undefined
  const keptPinned = identity === undefined ? [] : [identity]
  let used = identity === undefined ? 0 : identity.length + 1
  const pinnedTail = []
  for (let i = lines.pinned.length - 1; i >= 1; i -= 1) {
    const line = lines.pinned[i]
    const cost = line.length + 1
    if (used + cost > pinnedBudget) break
    used += cost
    pinnedTail.push(line)
  }
  let next = Math.max(0, lines.pinned.length - 1 - pinnedTail.length)  // 下一个候选固定行下标（往上走）
  const reversed = []
  for (let i = lines.flow.length - 1; i >= 0; i -= 1) {
    const line = lines.flow[i]
    const cost = line.length + 1
    if (used + cost > budget) break
    used += cost
    reversed.push(line)
  }
  const omitted = lines.flow.length - reversed.length
  // 第二遍：进度没用满预算时，把还装得下的**更早的固定行**补回来。一半预算是保底的
  // 下限（保证进度永远有位置），不是上限——剩下的字符给上下文比空着有用。
  while (next >= 1 && used + lines.pinned[next].length + 1 <= budget) {
    pinnedTail.push(lines.pinned[next])
    used += lines.pinned[next].length + 1
    next -= 1
  }
  const droppedPinned = next  // 下标 1..next 的固定行被丢弃
  const head = [...keptPinned, ...[...pinnedTail].reverse()]
  const body = [...head, ...reversed.reverse()]
  if (droppedPinned > 0 || omitted > 0) {
    const parts = []
    if (droppedPinned > 0) parts.push(`${droppedPinned} 条更早的指令`)
    if (omitted > 0) parts.push(`${omitted} 行更早的进度`)
    // 插在"固定行"与"保留的尾部"之间 —— 那正是内容真正断开的位置。
    body.splice(identity === undefined ? 0 : head.length, 0, `……（此处省略 ${parts.join(' 与 ')}）……`)
  }
  return { text: body.join('\n'), omitted, droppedPinned }
}

/**
 * 从在飞事件里抽出兄弟分叉会话**正在动的文件**（按首次出现顺序，确定性）。
 *
 * 这是避让通知最该顶到最前面的信息。实测依据（2026-09，8 次运行）：
 * 把"兄弟在改什么文件"埋在 digest 事件流水里的**协议式**通知，零避让效果
 * （2/2 照旧改同一文件，且明确答"避让协议不能覆盖任务目标"）；
 * 而在开头**点名文件**并给出替代目标的版本，出现了避让（1/2）。
 * 结论不是"通知能否奏效"，而是**清晰度是有效变量**——所以把它提取出来单独顶头。
 *
 * @param {readonly any[]} events 在飞 turn 的事件。
 * @returns {string[]} 文件路径，按首次出现顺序。
 */
export function activeTargets(events) {
  const seen = new Set()
  const out = []
  const collect = (args) => {
    if (typeof args !== 'string') return
    const matched = args.match(/"file_path"\s*:\s*"([^"]+)"/u)
    if (matched === null) return
    const path = matched[1]
    if (path === '' || seen.has(path)) return
    seen.add(path)
    out.push(path)
  }
  for (const event of events) {
    const data = event?.data ?? {}
    if (event?.type === 'tool/call') collect(data.arguments)
    if (event?.type === 'assistant/message') {
      for (const part of data.message?.content ?? []) {
        if (part?.type === 'tool-call') collect(part.arguments)
      }
    }
  }
  return out
}

/**
 * 渲染 fork 通知：**兄弟会话（分叉源）发给新分叉会话的消息正文**。
 *
 * ⚠️ 措辞契约（与本插件的投递方式绑死）：这条文本以官方的 `agent-message` + `form:'relay'`
 * 形状投给 head，客户端把它渲染成 **turn-trigger 卡片**（标题「收到任务消息」、agent 图标、
 * 可展开正文），卡片头已经写明「来自会话 <sibling>」。所以正文里**说话的人是兄弟会话**：
 * 「你」= 新分叉会话，「我」= 兄弟。写成新分叉会话自称（"我是分叉会话…"）会与卡片头自相矛盾。
 *
 * 结构（顺序有实测依据）：**先点名兄弟正在动的文件**，再给避让约定。把关键信息埋在
 * 事件流水里时，通知等于没生效。
 *
 * 注意定位（这是实验结论，不是猜测）：真正的**安全网**是 harness 的
 * `fs-observation-policy` 版本守卫（撞上改动会拿到 FS_STALE_VERSION 并被要求
 * 重读），所以本通知不是安全机制，而是**效率与意图机制**。而且它有固有上限：
 * 当被占用的资源是双方**正当必需**的目标时，称职的 agent 会（也应该）覆盖
 * 避让提示——所以协议里明确写出这条优先级，而不是假装避让总能生效。
 *
 * @param {object} input 渲染输入。
 * @param {string} input.branchId 本分叉会话 id。
 * @param {string} input.siblingId 兄弟（父）分叉会话 id。
 * @param {string | undefined} input.cwd 共享工作目录。
 * @param {readonly string[]} [input.targets] 兄弟正在动的文件（`activeTargets` 的结果）。
 * @returns {string} 回复正文。
 */
export function renderForkNotice({ branchId, siblingId, cwd, targets = [] }) {
  // 卡片本身已经给了标题（分叉通知）与「来自会话 X」，`agentMessage` 也加了来源前缀，
  // 所以正文**不再重复**是谁发给谁的（用户反馈"注入内容噪声多"）。
  // 正文只留三条事实：① 分工（用户归你）② 共享工作目录 ③ 避让要点。
  const lines = [
    '[分叉通知]',
    `你（分叉会话 ${branchId}）接手了用户；我留在后台把没做完的那一轮跑完，结果会发给你。`,
    `共享同一工作目录${cwd === undefined ? '' : `（${cwd}）`}，文件系统没有隔离。`,
    '',
    // 用户 2026-10 指出的真实误判：head 会把"自己在这个会话里写的普通回复"当成已经回给了
    // origin —— 因为**没有一处文案说明方向是不对称的**。这一行就是补这个洞：
    // 自动通道只有 origin → 分叉 这一个方向，反向必须显式调工具。
    '**通信方向（不对称，别想当然）**：我那一轮跑完会把最后一条回复**自动**投给你；'
      + '**反过来没有自动通道** —— 你在这个会话里的普通回复（包括"收到""我承接了"这类答复）'
      + '**不会**传给我。要给我指令就用 `fork_send`，它一发即走、**没有回执**，'
      + '不表示我已经读到或照办。',
  ]

  if (targets.length > 0) {
    lines.push(
      '',
      `我此刻正在动：${targets.map(path => `\`${path}\``).join('、')}`,
      '这些也在你任务里就优先改**别的**目标；若它是唯一目标就照常改——任务完整性优先于避让。',
    )
  }

  lines.push(
    '',
    '避让（效率约定）：改文件前重读并重基（撞 `FS_STALE_VERSION` 就重读重试）、优先 `edit`；'
      + 'bash / git / rm 没有守卫，自己判断会不会和我撞。',
  )
  return lines.join('\n')
}

/**
 * 渲染兄弟分叉会话**在飞 turn** 的进度摘要。
 *
 * 这是自动分叉方案的核心补偿：会话层 fork 只能切在 turn 边界（见
 * `SessionStore.fork` 的 OPEN_TURN 拒绝），所以子分叉的 seed 天然缺掉整个
 * 正在跑的 turn；本函数把那段缺失补回来。
 *
 * @param {object} input 渲染输入。
 * @param {readonly any[]} input.events 在飞 turn 的事件（从 turn/start 起）。
 * @param {typeof import('./params.mjs').DEFAULT_PARAMS} input.params 参数。
 * @param {string} input.siblingId 兄弟分叉 id。
 * @returns {string} 注入文本。
 */
export function renderInFlightDigest({ events, params, siblingId }) {
  const bounded = events.slice(-params.digestMaxEvents)
  const droppedByCount = events.length - bounded.length
  const { pinned, flow } = renderEventLines(bounded, params)
  const { text } = assembleWithinBudget({ pinned, flow }, params.digestMaxChars)
  // 标题与「来自会话 X」已在卡片上；这里只需要说清两件事：这是**我还没跑完**的那一轮
  // （所以它不在你的 seed 里），以及下面是**原始事件流水**、不是结论。
  const header = [
    '[在飞进度]',
    `我（${siblingId}）这一轮还没跑完（seed 切在 turn 边界），不在你的上下文里。`
      + '下面是原始事件流水，不是结论。',
  ].join('\n')
  // 事件窗口的丢弃发生在**渲染之前**，所以它的说明只能放在最前面（放在末尾同样会被误读成"末尾被砍"）。
  // 参数名（`digestMaxEvents`）是给排障的人看的，模型只需要知道"更早的事件被截掉了"。
  const notes = droppedByCount > 0
    ? [`（更早的 ${droppedByCount} 个事件未渲染）`]
    : []
  return [header, ...notes, '', text].filter(part => part !== '').join('\n')
}

/**
 * 渲染后台分叉的结果，用于回注前台。
 *
 * 取该分叉最后一个 turn 的事件，渲染后带上前缀与显式的"这是后台分叉"标记，
 * 使前台 agent 能把它与自己的历史区分开。
 *
 * @param {object} input 渲染输入。
 * @param {readonly any[]} input.events 后台分叉最后一个 turn 的事件。
 * @param {typeof import('./params.mjs').DEFAULT_PARAMS} input.params 参数。
 * @param {string} input.branchId 后台分叉会话 id。
 * @param {string} input.reason turn 结束原因（completed / aborted / blocked…）。
 * @returns {string} 回注文本。
 */
/**
 * 渲染**注入给 worker（后台那条会话）**的分叉提示。
 *
 * 实测（2026-09）确认了方向：**head 不再给 worker 回注工作日志**，只把 worker 的
 * **最后一条回复**转给 head。于是 worker 的汇报质量直接决定 head 能拿到什么——
 * 这条提示就是为此存在的：它不改变 worker 的工作方向，只要求它把收尾写清楚。
 *
 * 通过 `agent.inject()` 投递，落在 worker 的**下一个** step，不打断在飞步骤。
 *
 * @param {object} input 渲染输入。
 * @param {string} input.headId 接手用户交互的那条会话 id。
 * @returns {string} 注入文本。
 */
export function renderBranchHint({ headId }) {
  return [
    `[分叉提示] 用户已经切到 ${driverLabel(headId)} 继续对话`,
    `你还在跑的那一轮**不会被中止**，但用户当前的会话已经是 ${driverLabel(headId)}`,
    '（会话 ' + String(headId) + '）了——它接管了与用户的交互，你的产出会转给它。',
    '你**继续当前工作，不要改变方向**——它会管理你的产出。',
    '唯一的额外要求：结束时请在**最后一条回复**里简短总结你做了什么',
    '（结论、改动的文件、执行过的关键命令），因为接管的那条会话只能看到你的最后一条回复。',
    '**通信方向是不对称的**：你的产出会自动转给它；但它给你的消息**不会自动传给你**，'
      + '要它答复就用 `fork_send`（一发即走、没有回执，不代表它会照办）。',
  ].join('\n')
}

/**
 * 渲染**实例（head）的回复**，用于追加进容器日志。
 *
 * 与 `renderWorkerReply` 的区别在方向：这一条是"实例 → 容器"，目的是让**容器的
 * 转写成为统一转写**——用户在容器里就能看到实例的产出，不必跳进实例视图。
 *
 * 通过直接往容器日志 `append('user/message', …)` 投递（校验器对 `user/message`
 * **无约束**，不需要开着的 turn），所以容器即使正忙也能立刻显示。
 *
 * @param {object} input 渲染输入。
 * @param {string} input.instanceId 产出这条回复的实例会话 id。
 * @param {string} input.reply 其最后一条 assistant 文本。
 * @param {number} input.maxChars 字符上限。
 * @returns {string} 追加文本。
 */
/**
 * `fork_send`（`block:true`）等到的答复：**工具结果**里的措辞（第三人称，不是"我"）。
 *
 * 与 `renderWorkerReply` 的区别只在人称：那条是注入给 head 的"后台会话对我说话"，
 * 这条是调用方拿到的"它回了我什么"。回复本身按 `reInjectMaxChars` 截断（同一套预算）。
 * @param {object} input 渲染输入。
 * @param {string} input.targetId 被 steer 的那条会话 id。
 * @param {string} input.reply 对方这一轮的最后一条文本回复（可为空）。
 * @param {number} input.stepCount 对方这一轮跑了几步（没有文本回复时用来交代它并非没动）。
 * @param {number} input.maxChars 回复正文的字符上限。
 * @returns {string} 工具结果正文。
 */
export function renderSteerReply({ targetId, reply, stepCount, maxChars }) {
  const body = truncate(oneline(reply ?? ''), maxChars)
  const head = `「${targetId}」这一轮跑完了`
  return body === ''
    ? `${head}，但没有产出文本回复（走了 ${String(stepCount)} 步）。`
    : `${head}，它的最后一条回复：\n${body}`
}

export function renderInstanceReply({ instanceId, reply, maxChars }) {
  const body = truncate(oneline(reply ?? ''), maxChars)
  const header = `[${driverLabel(instanceId)}] 这是它对你刚才那条指令的回复。`
  return body === '' ? `${header}\n它这一轮没有产出文本回复。` : `${header}\n${body}`
}

/**
 * 会话 id 的短形式：去掉 `session-` 前缀、取前 8 位。
 *
 * 渲染成折叠行的一行 account 时，完整 id（`session-6a40195b-eed3-46a9-…`）会把整行
 * 占满却几乎不提供信息——用户需要的是"是哪一条"可辨识，而不是完整坐标。
 * @param {string} sessionId 完整会话 id。
 * @returns {string} 短形式。
 */
export function shortSessionId(sessionId) {
  const raw = String(sessionId ?? '')
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return bare.slice(0, 8)
}

/**
 * 一条会话在**面向用户**的文案里的名字。
 *
 * 用户 2026-09 定的模型：容器的 driver 是可以更换的，所以文案必须让"现在回答你的是谁"
 * 一眼可见。只用短 id 会被误读成一个陌生会话；加上 `分叉` 前缀才对得上会话头部那个
 * 实例树里的条目。
 * @param {string} sessionId 会话 id。
 * @returns {string} 例如 `分叉会话 6a40195b`。
 */
export function driverLabel(sessionId) {
  return `分叉会话 ${shortSessionId(sessionId)}`
}

/**
 * 实例回复的**折叠行一行 account**。
 *
 * 为什么把正文塞进 summary，而不是只写"某实例已回复"：折叠行是用户**不展开就能读到**的
 * 唯一一行（`form:'notice'` 的整个存在理由），所以它应该承载回复的要点，而不只是一个状态。
 * 上限 120 字符由客户端契约定（`CONTEXT_SUMMARY_MAX_CHARS`），这里按它压。
 * @param {object} input 渲染输入。
 * @param {string} input.instanceId 产出这条回复的会话 id。
 * @param {string} input.reply 回复正文（可为空）。
 * @returns {string} 有界的一行 account。
 */
export function instanceReplySummary({ instanceId, reply }) {
  const gist = oneline(reply ?? '')
  if (gist === '') return `${driverLabel(instanceId)} 这一轮没有产出文本回复`
  return boundSummary(`${driverLabel(instanceId)}：${gist}`)
}

/**
 * 渲染 worker 的最后一条回复，注入给 head。
 *
 * 契约（用户 2026-09 定的）：**只转最后一条 assistant 回复**，不再转整个 turn 的
 * 事件流水——前者是"同事的汇报"，后者是"工作日志"，而日志会淹掉结论。
 * worker 侧由 `renderBranchHint` 要求它把最后一条回复写成总结。
 *
 * @param {object} input 渲染输入。
 * @param {string} input.workerId 产出这条回复的会话 id。
 * @param {string} input.reply 它的最后一条 assistant 文本（可为空）。
 * @param {number} input.stepCount 该 turn 走的步数（回复为空时用于说明它确实干了活）。
 * @param {number} input.maxChars 字符上限。
 * @returns {string} 注入文本。
 */
export function renderWorkerReply({ workerId, reply, stepCount, maxChars }) {
  const body = truncate(oneline(reply ?? ''), maxChars)
  // 标题（后台会话回复）与「来自会话 <id>」都已在卡片上，`agentMessage` 还加了
  // 「分叉会话 <id> 发来消息：」前缀——正文再报一次"我（分叉会话 ab12cd34）"就是第三次重复
  // （用户反馈"注入内容噪声多"）。只说发生了什么。
  const header = '我这一轮跑完了，最后一条回复如下'
  if (body === '') {
    return `${header}\n它这一轮没有产出文本回复（走了 ${String(stepCount)} 步）。`
  }
  return `${header}\n${body}`
}
