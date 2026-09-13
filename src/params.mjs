/**
 * dsh-autofork 可调参数：全部行为参数集中在此，无硬编码。
 *
 * 设计约束（用户 2026-09 拍板）：阶段 6 的合并窗口、分叉上限、回收超时，
 * 以及 digest 的截断预算，一律是可调参数。插件配置（cordis config）覆盖
 * DEFAULT_PARAMS 中的任意字段，未提供者取默认值。
 *
 * @module dsh-autofork/params
 */

/** 单个后台分叉的状态机取值。 */
export const BRANCH_STATES = /** @type {const} */ ([
  'seeding',   // 正在建分叉（fork + inject + followup）
  'running',   // 后台分叉的 turn 仍在跑
  'reported',  // 已把结果回注前台
  'harvested', // 已回收（不再出现在调度面）
])

/**
 * 默认参数。每个字段都可被插件配置覆盖。
 *
 * 命名约定：`Ms` 结尾是毫秒，`Chars` 结尾是字符预算，`Max` 前缀是上限。
 */
export const DEFAULT_PARAMS = {
  // ---- 触发 ----
  /** 总开关；false 时彻底不建分叉，全部按 steer/queue 原样投递。 */
  enabled: true,
  /**
   * 分叉门槛：当前 step 已运行**低于**此时长则不分叉。**默认 0 = 只要忙就分叉。**
   *
   * 曾经默认 8000，理由是"step 还年轻说明边界马上到、steer 就能解决"。实测证明
   * 这个推断是错的：用户发消息时 step 只跑了 1.19 秒，而那一步正在跑 `sleep 5min`
   * ——边界要 5 分钟后才到，消息被 queue 住，功能完全没触发（用户实测踩到）。
   *
   * 而且在不中止 worker 的链式模型下，分叉的代价只剩"多一条会话 + 一份 digest"，
   * 年龄门槛已失去保护作用。保留这个参数只为让部署能按需调回保守策略。
   */
  minStepAgeMs: 0,
  /**
   * 合并窗口：距离下一个 step 边界不足此时长时，降级为 steer 而不是 fork。
   * 这是"用户手速快"场景的合并策略。
   */
  coalesceWindowMs: 2000,
  /** 只对这些 source.kind 的人类消息触发分叉；缺省仅 'user'。 */
  forkableSourceKinds: ['user'],

  // ---- 分叉 ----
  /** 同一 lineage 上允许同时存在的后台分叉上限；超出则强制 steer。 */
  maxActiveBranches: 3,
  /** 后台分叉跑完（turn/end）后，多久未再被引用即视为已收割。 */
  harvestAfterMs: 600000,

  // ---- digest（确定性渲染预算）----
  /** 整条 digest 的字符上限；超出即按事件逐个丢弃并在尾部显式标注。 */
  digestMaxChars: 8000,
  /** 单条 assistant 文本的截断长度。 */
  digestAssistantChars: 600,
  /** 单条 tool/call 参数的截断长度。 */
  digestToolArgsChars: 300,
  /** 单条 tool/result 内容的截断长度。 */
  digestToolResultChars: 400,
  /** digest 最多渲染多少个事件（自尾部向前保留最近的事件）。 */
  digestMaxEvents: 200,

  // ---- 回注 ----
  /** 后台分叉 turn/end 后是否把结果回注前台。 */
  reInjectOnTurnEnd: true,
  /** 回注内容的字符上限。 */
  reInjectMaxChars: 4000,
  /** 前台处于 idle 时，是否用 followup 唤醒它去看回注结果。 */
  wakeForegroundOnTurnEnd: true,

  // ---- 容器形态 ----
  /**
   * **容器模式（实验分叉，默认关）**。
   *
   * ⚠️ 2026-09-11 最终决定：**默认关掉它，恢复扁平分叉**。原因见下面"为什么默认关"。
   * 这条分叉的实现（路由 / 重绑 / 一等回复写入 / pre-step 中和）留在代码里，是因为它
   * 本身工作正常，是"同一条 session 换 driver"那条上游路线的现成底座。
   *
   * true = 容器（用户所在的 session）**从不自己跑 turn**，它的 agent 只是宿主：
   *   ① 用户每条消息都被 `inbox.remove()` CAS 抢下，交给容器**当前绑定的实例**
   *      （容器里的 subagent 子会话，实例树里那些）；
   *   ② 绑定的实例在忙 → 新建一个实例并**重绑**（容器允许更换 driver）；
   *   ③ 实例的答复被写成容器里的一条**一等 `assistant/message`**（插件替实例写
   *      `turn/start → step/start → assistant/message → step/end → turn/end`），
   *      所以容器转写读起来就是正常对话，而不是一条"上下文注入"行。
   *
   * 为什么必须"容器自己不跑 turn"：旧 driver 的长步骤如果跑在容器自己的日志里，容器就一直
   * 显示"运行中"（不变量：一条日志同时一个 open turn），用户看到的仍是"卡住"——这正是
   * 用户实测否掉的形态。容器不跑 turn ⇒ 它永远 idle ⇒ 永远不显示卡住，且用户永不移动。
   *
   * 已实测：插件能往空闲会话写结构合法的一等 assistant turn（surface 上是普通 assistant 行）。
   *
   * false = 旧的链式接管形态（容器自己跑，忙时才分叉，焦点跟随 head）。
   *
   * ⚠️ 曾经默认关闭，因为撞上"容器必然自己跑一个 turn"的障碍（2026-09-11 E2E 实证）：
   *
   * 前提"容器自己不跑 turn"做不到：用户消息一进 inbox，容器的 loop 就会开一个 turn，
   * 而 `preStep` **总会**注入 runtime context / skill catalog 这类上下文消息 ⇒
   * `decision.messages` 永不为空 ⇒ 即使插件已经用 `inbox.remove()` 成功把用户消息抢走
   * （E2E 见证：`agent/inbox/spliced` 的 `outcome=canceled` 就在 `turn/start` **之前**），
   * 容器**仍然会跑一个真正的模型请求**并产出自己的 assistant 回复。
   *
   * **为什么默认关**（用户 2026-09-11 拍板，逻辑最完整）：容器模式下"容器内容变成 head 的"
   * 只能做到一半 —— 空闲时容器自己作答、忙碌时 agent 的答复能立刻写成容器里的一等回复，
   * 但 **A 那条在飞的 turn 永远显示在同一条会话里、搬不走**：`agent.id ≡ session.id` 让
   * 一条 session 不能换 driver；而在飞 turn 已落盘 + 工具在跑 + 一条日志只能有一个 open turn，
   * 使"把日志劈成两半、把在飞 turn 挪到后台"也不可能。所以理想效果（同一容器内容换成 B、
   * A 归后台）需要上游的**同日志双车道**（见 docs/proposal-same-container-driver-swap.md §4.6）。
   * 在那之前，扁平分叉"逻辑最完整"：**触发时新建一条 session**（左侧列表出现新的一条），
   * 代价是牺牲了体验的一致性。
   *
   * **已解决的技术难点（留档）**：`agent/pre-step` 是 **waterfall**（且按 scope 过滤），
   * 插件可以给容器返回 `{kind:'enter', messages: []}` ⇒ loop 命中
   * `phase.step === 0 && messages.length === 0` 分叉 ⇒ turn 以 `completed` **立刻关闭**：
   * 不跑 step、不发模型请求、不产出自己的回复。被 claim 的用户消息也不再被发出（由插件代写
   * 并交给 agent）。于是容器**永不阻塞、永不重复劳动**，agent 的答复得以写成一等 assistant
   * 回复 —— 这就是用户要的"同一个容器，内容变成 head 的"。
   */
  containerMode: false,

  /**
   * 容器模式下**重绑 driver**（或首次绑定）时，是否在容器里插一行折叠通知说明
   * "现在由哪个实例回答"。首次绑定与每次重绑各一行，之后的答复本身不带前缀——
   * 答复要读起来像"容器给你的话"，不该每条都挂一个来源标签。
   */
  rebindNotice: true,

  /**
   * 是否把用户的焦点切到新产生的 head。
   *
   * **默认 true —— 这是"打破同步交互"成立的前提**（用户 2026-09-11 实测拍板）。
   *
   * 曾经默认 false（用户留在原会话里，head 作为实例嵌套、产出以注入行回灌）。实测结论：
   * **那个效果对用户没有意义**——旧的 agent 还在跑长步骤，而它的在飞 turn 就写在**容器自己
   * 的日志**里；容器的"运行中"状态来自那条开着的 turn（不变量：一条日志同时只有一个
   * `openTurn`）。所以只要不中止旧 agent，容器就一直是"卡住"的样子，插件能改的只是那行
   * 注入的文案，改不掉容器自身那条开着的 turn。用户仍要等 = 同步交互没被打破。
   *
   * 设为 true 后：head 用旧会话的**已完成前缀**做 seed，所以切过去以后转写是连续的历史
   * （感觉仍是同一个对话，不是被丢进一个空会话），而用户立刻是在跟一条**空闲、可交互**的
   * agent 说话。旧会话继续在后台跑（**绝不中止**），成为 head 的实例，其产出回注 head。
   *
   * 设为 false 保留为对照臂：适合"只想看到产出、不想视图移动"的部署。
   */
  followHead: true,

  /** 实例在容器头部实例树里的显示名。 */
  instanceLabel: '分叉',

  /**
   * 分叉会话的**命名标记**：建 head 时把它的标题钉成 `<标记><序号> <家族根名>`。
   *
   * 用户 2026-09 定的形状（三条都实测确认过）：
   *   · **前缀**："序号前置"——侧栏是单行截尾的，标记与序号放最前才一定看得见；
   *   · **序号不累加**：全家族共用基名，`⑂1 修 GUI 卡顿` / `⑂2 修 GUI 卡顿`，而不是
   *     路径式累积（`⑂1-1`）——后者在链式分叉下会把重要的部分挤到被截掉的那一头；
   *   · **基名取家族根会话的标题**，所以同族所有分叉在左侧列表里成组，一眼能归堆。
   *
   * 用的是原生 `ctx.sessionTitle.rename()` —— 与用户在侧栏手动重命名**完全同一条路**
   * （写一条 `source:{kind:'user'}` 的 `session/title`）。副作用要写清楚：rename 会
   * **钉住**标题，于是这条会话不再被 `dsh-session-title-first-prompt-llm` 自动命名。
   * 这正是用户要的（"不用 first-prompt-llm"）：名字立刻确定，不等模型那一两秒。
   *
   * **空串 = 关闭分叉命名**（与 `debugLogPath` 同一种约定），此时 head 保持原生命名行为。
   */
  titleMark: '⑂',

  /**
   * 写进子会话 `subagent/descriptor` 的 `provider` 字段。
   *
   * 只用于**冷恢复**时反查 subagent 后端；日常寻址不用它（宿主与客户端只读
   * `identity.mode` / `identity.seq`）。本插件的子会话在组合上等价于官方 in-process fork
   * （seed 就是父会话的已完成前缀），所以指向官方那个后端名 `fork`。
   * 换后端时改这里，别改代码。
   */
  instanceProvider: 'fork',

  /**
   * 是否把 head 的回复**反向**回灌进被接管的会话（worker）日志。
   *
   * **默认 false**（用户 2026-09-11 实测判定）：方向错了。笔记定的方向是
   * "**旧 session 执行完成后的结果会注入返回给新 session**"（前台从后台学进展），
   * 而"新 session 的回复灌回旧 session"没有任何用途 —— 用户实测看到的是：A 跑完把结果
   * 注入给 B，B 因此产生一句回复，那句回复又被回灌成 A 里的一行 `branch-answer`，
   * 纯属噪声。前台要给后台下指令应当走 `fork_steer`（agent 主动），而不是自动回灌。
   *
   * 设为 true 保留为对照（也用于验证"悬空工具调用窗口不能乱插消息"那条 E2E 两臂对照）。
   */
  mirrorInstanceReply: false,

  /**
   * 是否把实例（head）的回复作为插件消息追加进**容器**日志。
   *
   * 追加 `user/message` 在校验器里是**无约束**的（不需要开着的 turn），所以容器
   * 即便正忙也能立刻显示实例的产出——这样容器的转写才是"统一转写"。
   *
   * （这条描述的是 containerMode 的路径；扁平模式下这条开关已默认关，见上面那条。）
   */

  /**
   * 实例回复的投递方式。
   *
   * - `'safe'`（默认）：**不拆散 `tool_calls` / `tool_result` 对**。容器 surface 上已有
   *   悬空工具调用时改用 `inject()`，落到下一个 step 起点，而不是直接 append 到 surface。
   * - `'immediate'`：永远直接 append（历史行为）。**已知会写坏容器转写**：provider 会报
   *   `An assistant message with 'tool_calls' must be followed by tool messages …`。
   *   保留只为对照实验——不要在生产开。
   *
   * 之所以要有这个开关：用户实测踩到过 'immediate' 的后果，而"为什么默认更慢一点"必须有
   * 可复现的对照，否则下一个人还会把它改回去。
   */
  mirrorDelivery: 'safe',

  /**
   * 注入消息是否声明 `form: 'notice'`（客户端折叠成**一行摘要**，可展开）。
   *
   * 依据：`MessageSourceMap.plugin` 混入 `ContextFormed`，`form: 'notice'` 要求同时
   * 给出 `summary`（≤ `CONTEXT_SUMMARY_MAX_CHARS` = 120），客户端
   * （`ui-chat` 的 `contextBody` → `noticeSummary(source)`）据此把整行折叠成
   * 那一行 account，展开才显示正文。**只影响呈现，不影响模型看到的内容**
   * ——`source` 不进 `deriveMessages` 的投影，正文一字不改。
   *
   * 这是"容器转写"的读法：分叉通知 / 在飞摘要 / 实例回复都以一行摘要出现，
   * 不把容器的转写刷成一片大段注入。设为 false 则退回整块呈现。
   */
  noticeSummaries: true,

  // ---- 调度面 ----
  /** 是否向前台 agent 暴露 fork_list / fork_steer / fork_cancel 三个调度工具。 */
  exposeDispatchTools: true,

  // ---- 诊断 ----
  /**
   * 决策日志路径；空字符串表示关闭。
   *
   * 存在的理由同 health 探针：`ctx.logger` 不写 stdout，而 headless / sdk 组合
   * 没有 webServer 可挂探针。没有这个开关，"为什么没分叉"在进程外完全不可见——
   * 每条早退分叉都会静默。设为路径后逐行追加 JSON，可被任何部署读取。
   * 未设置时回退到环境变量 `DSH_AUTOFORK_DEBUG`。
   */
  debugLogPath: '',
}

/**
 * 合并用户配置与默认值。
 *
 * 只接受 DEFAULT_PARAMS 中已声明的键：未知键被忽略（不抛错），以便配置
 * 面演进时不破坏既有配置。
 *
 * 另外支持环境变量 `DSH_AUTOFORK_PARAMS`（JSON 对象）覆盖，优先级低于插件配置。
 * 存在的理由与 health 探针、`debugLogPath` 同源：**验证/运维时需要在不改出厂
 * 默认值的前提下调行为**。典型用法是缩短 `minStepAgeMs`，好在真实模型很快的
 * 环境下也能触发分叉（出厂默认 8 秒是给"人真的等了一会儿"的场景定的）。
 *
 * @param {Record<string, unknown> | undefined} config 插件配置。
 * @param {Record<string, string | undefined>} [env] 环境变量源（便于测试注入）。
 * @returns {typeof DEFAULT_PARAMS} 补齐后的完整参数。
 */
export function resolveParams(config, env = process.env) {
  const resolved = { ...DEFAULT_PARAMS }

  // 顺序即优先级：先环境变量，后显式配置 —— 显式配置必须压过环境变量，
  // 否则部署里一处 env 就能悄悄改掉插件配置，排障时无从下手。
  const raw = env?.DSH_AUTOFORK_PARAMS
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      applyKnownKeys(resolved, JSON.parse(raw))
    } catch {
      // 非法 JSON 不得让插件起不来——环境变量覆盖只是便利通道，不是契约。
    }
  }
  applyKnownKeys(resolved, config)
  return resolved
}

/**
 * 把已知键写入目标对象；未知键与 undefined 一律忽略。
 * @param {Record<string, unknown>} target 目标参数对象。
 * @param {unknown} source 来源（配置对象或解析后的 JSON）。
 * @returns {void}
 */
function applyKnownKeys(target, source) {
  if (source === null || typeof source !== 'object') return
  for (const key of Object.keys(DEFAULT_PARAMS)) {
    const value = /** @type {Record<string, unknown>} */ (source)[key]
    if (value !== undefined) target[key] = value
  }
}

/** 在日志/回注文本里标注参数来源，便于排查"为什么没分叉"。 */
export function describeParams(params) {
  return [
    `minStepAge=${params.minStepAgeMs}ms`,
    `coalesce=${params.coalesceWindowMs}ms`,
    `maxActiveBranches=${params.maxActiveBranches}`,
    `digestMaxChars=${params.digestMaxChars}`,
  ].join(' ')
}
