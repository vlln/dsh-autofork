/**
 * 分叉调度工具：head（用户面向的那条会话）用来管理它家族里的其它会话。
 *
 * ## 方向（2026-09 实测修正）
 *
 * 第一版把记录读作"父拥有子"，于是 head 调 `fork_list` 返回空——因为 head 是
 * "分叉"而不是"拥有者"（用户实测踩到："B 无法用 branch-list 工具列出 A"）。
 *
 * 正确的模型是一条**链**：
 *
 *     A ←── 接管 ── B ←── 接管 ── C
 *
 * 最新的那条是 **head**（用户面向它），它**接管**了身后的会话；head 能看见并管理
 * 整条链。这与"无限身份一致性"是同一件事：身份沿链前移，身后都是可调度的后台会话。
 *
 * 于是工具语义是：
 *  - `fork_list`  → 列出**我家族里的会话**（承接来的 upstream + 接管了我的 downstream）
 *  - `fork_steer` → 给家族里某条会话发中途指令
 *  - `fork_cancel`→ 中止家族里某条会话
 *
 * 设计约束：
 *  - `defineTool` 由 index.mjs 注入，本模块**不 import 任何 `@deepseek-ai/*`**，
 *    因此工具逻辑可在本机离线单测（官方包在公共 npm 解析不到，见 skill gotchas）。
 *  - 授权边界写在依赖实现里：只能操作**自己家族**的会话，且由 index.mjs 按
 *    `caller` 过滤；工具层拒绝无 agent 的调用。
 *
 * @module dsh-autofork/tools
 */

/**
 * 家族中的一个会话。字段名与 output.schema 严格一致。
 *
 * ⚠️ 这是**封闭形状**（`additionalProperties: false`）：`memberView` 多给一个字段，这里
 * 不同步声明就会在**运行时**抛 `ToolOutputError`（`createSuccessResult` 会逐条校验输出）。
 * 曾经漏掉 `title` 正是这个坑。
 *
 * `title` 用 `type:'string'`（空串 = 没有名字）而不是 `string|null`：官方 JSON-schema 子集里
 * `null` 只能靠 `oneOf` 表达，而 `oneOf` **不允许**与 `required` 并列。
 */
const RELATED_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    relation: { type: 'string', required: true, enum: ['upstream', 'downstream', 'sibling'] },
    state: { type: 'string', required: true, enum: ['running', 'idle', 'finished'] },
    busy: { type: 'boolean', required: true },
    title: { type: 'string', required: true },
  },
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    detail: { type: 'string', required: true },
  },
}

/**
 * 渲染家族列表。
 * @param {Record<string, unknown>} _args 调用参数（未使用）。
 * @param {{related: Array<Record<string, unknown>>}} value 工具的规范输出。
 * @returns {Array<{type: 'text', text: string}>} 面向模型的文本块。
 */
/**
 * 家族的实时状态标签。
 *
 * 三个取值**互斥且自解释**（`state` 由 index.mjs 的 `memberView` 计算）：
 *  · `running`  — agent 还活着，且**正在跑**它自己的 turn；
 *  · `idle`     — agent 还活着，但此刻空闲（可以立刻接话）；
 *  · `finished` — agent 已经不在了（这条会话的进程侧已结束，日志仍在）。
 */
const STATE_LABEL = {
  running: '运行中（正在跑自己的 turn）',
  idle: '空闲（可以立刻接话）',
  finished: '已结束（agent 已不在）',
}

export function renderRelated(_args, value) {
  const related = Array.isArray(value?.related) ? value.related : []
  if (related.length === 0) {
    return [{ type: 'text', text: '你的家族里目前没有其它会话（没有发生过分叉，也没有被别的会话接管）。' }]
  }
  const ARROW = {
    upstream: '↑ 我接管的',
    downstream: '↓ 接管了我的',
    // 同一条会话被分叉多次时，两条分叉是**兄弟**：既不是我接管的，也没接管我。
    sibling: '~ 同族的另一条分叉',
  }
  const lines = related.map((row) => {
    const arrow = ARROW[row.relation] ?? String(row.relation)
    // **只渲染一个状态标签**。曾经同时打 `[state]` 与 `busy` 两个字段，而它们含义不同
    // （`state` 只表示"agent 对象还在不在"、`busy` 才是实时状态），于是出现
    // `[running] 已停` 这种自相矛盾的行（用户实测报的歧义）。
    // 名字（`⑂n <基名>`）非空时一并给出：模型可以直接用名字指代成员，不必只认短 id。
    const name = typeof row.title === 'string' && row.title !== '' ? `${row.title} · ` : ''
    return `- ${name}${String(row.sessionId)}  ${arrow}  ${STATE_LABEL[row.state] ?? String(row.state)}`
  })
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 渲染单结果（steer / cancel）。
 * @param {Record<string, unknown>} _args 调用参数（未使用）。
 * @param {{ok: boolean, detail: string}} value 工具的规范输出。
 * @returns {Array<{type: 'text', text: string}>} 面向模型的文本块。
 */
export function renderResult(_args, value) {
  return [{ type: 'text', text: value?.detail ?? String(value) }]
}

/**
 * 构造三个调度工具定义。
 *
 * @param {object} deps 依赖注入。
 * @param {(spec: unknown) => unknown} deps.defineTool `@deepseek-ai/dsh-tools` 的 defineTool。
 * @param {(callerId: string) => Array<Record<string, unknown>>} deps.related 列出该会话家族里的其它会话。
 * @param {(callerId: string, targetId: string, text: string) => {ok: boolean, detail: string}} deps.steer 给家族会话发中途指令。
 * @param {(callerId: string, targetId: string, keepInbox: boolean) => {ok: boolean, detail: string}} deps.cancel 中止家族会话。
 * @returns {unknown[]} 工具定义数组，交给 `ctx.tools.register`。
 */
export function createBranchTools({ defineTool, related, steer, cancel }) {
  /**
   * 解析调用者身份；无 agent 的调用一律拒绝（授权边界）。
   * @param {any} exec 工具运行上下文。
   * @returns {string | undefined} 调用者的 session id。
   */
  const callerOf = (exec) => {
    const agent = exec?.agent
    return typeof agent?.id === 'string' ? agent.id : undefined
  }

  const denied = {
    ok: false,
    detail: '该工具必须在 agent 会话内调用：无法确定调用者身份，已拒绝。',
  }

  const TARGET_DESC = '目标会话的 id，取自 fork_list（只能是你家族里的会话）。'

  return [
    defineTool({
      name: 'fork_list',
      description: '列出你家族里的其它会话：↑ 你接管的（在你之前工作、仍在后台跑的）'
        + '与 ↓ 接管了你的（在你之后接手用户交互的）。'
        + '分叉发生时会形成一条这样的链，最新的那条是 head —— 也就是你。'
        + '这些会话与你在同一工作目录上并行工作（文件系统没有隔离），'
        + '在你需要判断"某件事是不是已经有人在做"、或需要给它们下指令时用它。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { related: { type: 'array', items: RELATED_ITEM, required: true } },
        },
        render: renderRelated,
      },
      async execute(_args, exec) {
        const caller = callerOf(exec)
        if (caller === undefined) return { related: [] }
        // `related` 是 **async**（读取家族前要先等血缘域装载，重启后才看得到持久化的关系），
        // 所以这里必须 await —— 直接 `return { related: related(caller) }` 会把一个 Promise
        // 塞进输出，schema 校验会判 `related` 不是数组。
        return { related: await related(caller) }
      },
    }),

    defineTool({
      name: 'fork_steer',
      description: '给你家族里的一条会话发中途指令（等价于对它调用 steer）。'
        + '它在当前 step 结束后会读到你的指令并据此改变方向，不需要中止它。'
        + '典型用途：你在 digest 里看到某条后台会话正在做的事已经过时，用它改向。',
      parameters: {
        sessionId: { type: 'string', required: true, description: TARGET_DESC },
        text: { type: 'string', required: true, description: '要传达给它的指令正文。' },
      },
      output: { schema: RESULT_SCHEMA, render: renderResult },
      async execute(args, exec) {
        const caller = callerOf(exec)
        if (caller === undefined) return denied
        return steer(caller, String(args?.sessionId ?? ''), String(args?.text ?? ''))
      },
    }),

    defineTool({
      name: 'fork_cancel',
      description: '中止家族里的一条会话。默认连同它排队与 steering 中的待处理工作一起清空；'
        + 'keepInbox=true 只中止当前 turn 并保留待处理项。'
        + '这是"直接介入"的手段：fork + fork_cancel 的效果等同于 interrupt，'
        + '但决定权在你（拿到完整上下文的一方），而不在启发式规则。'
        + '注意没有"只中止当前 step、保留 turn 继续运行"的选项。',
      parameters: {
        sessionId: { type: 'string', required: true, description: TARGET_DESC },
        keepInbox: { type: 'boolean', description: 'true 时只中止当前 turn，保留待处理项。缺省 false。' },
      },
      output: { schema: RESULT_SCHEMA, render: renderResult },
      async execute(args, exec) {
        const caller = callerOf(exec)
        if (caller === undefined) return denied
        return cancel(caller, String(args?.sessionId ?? ''), args?.keepInbox === true)
      },
    }),
  ]
}
