# 工程笔记（dsh-autofork）

**这份文件不是给插件使用者看的**——面向用户的内容（这是什么、怎么装、怎么用、参数、限制）
全在 [`../README.md`](../README.md)。这里放的是**改这个插件的人才需要**的东西：内部机制、
为什么这么选、踩过的坑、以及各层验证证据。

分成四块：① 实现范围与机制挂钩点；② 验证证据与行为层 E2E 台；③ 形态决策（容器 / 扁平、
seed、血缘存储）；④ 设计要点与不变量。

---
## 动机与定位（需求原话摘要）

来自用户 2026-09 的原始笔记《上下文连续性的 agent》，README 的"为什么需要它"就是它的
用户面向版本；这里留原文里**实现相关**的几条：

- **要解决的问题是交互模型，不是性能**：agent 一个 turn 十几分钟，用户这期间无法干预，
  产生大量碎片等待；常规做法（手动开多个 session 来回切）消耗工作记忆、打断心流，
  而且人的上限是 3–5 条。目标是"用工程方法模拟出用户体验上接近同步的效果"。
- **三条能力面**：① session 之间能传递信息（新会话继承旧会话的上下文，旧会话跑完把结果
  注入回来）；② agent 能管理其它 session（给旧会话发指令或直接介入）；③ agent 能查看
  session 树（工具 + 页签，见事实 23/24）。
- **与"管理者 agent 模式"的区别（笔记原话）**：「我们这里的模式更"自动化"，没有专门的
  Agent 层级关系。这是扁平分流与层级委派的区别。」→ 事实 19 那条"head 必须是普通顶层
  会话"就是这条的落地。
- **"自动"才是特点**：「这个模式的最大特点不是"branch"，而是"自动 branch"……对于 agent
  而言，branch 操作是被动发生的，而非 agent 主动发起的。」→ 触发规则见事实 20（空闲自己
  作答、只有忙到无法立刻打断才分叉）。
- **branch 的继承规则**：「继承当前 session 的所有状态和模型上下文，但最后一个 step
  （当前进行中的模型生成或者工具的执行）不继承」，并且注入一段 prompt 告知"发生了什么、
  有一个并行的自己在跑"。→ 事实 16 的 seed 切点 + 事实 12 的 notice 注入。
- **agent 被 branch 后的行为预期**：笔记认为继承的是 **LLM 上下文**（不考虑外部环境状态），
  所以新 agent 完全知道之前发生了什么，并且在知道自己是被 branch 出来之后会**主动避免
  竞争冲突**——这也是"注入的通知"定位为意图机制而非安全机制的原因（见「注入通知不是
  安全网」）。
- **自认的边界（写进 README）**：它能改"响应式交互"，但解决不了"用户需要等 agent"本身——
  真实问题常有时间因果关系，下一条 prompt 依赖当前 turn 的结论。

### 与官方 agent-team 的关系

用户补充：**dsh 从 0.1.5-alpha.2 起提供 `agent-team`**，可以看作"管理者 agent 模式"的官方
形态（共享 task 区 + lead 身份 + 任务委派与通信）。在这个视角下，**auto-fork 是它的一个特殊
子集**：同样产生"多个 agent 协作"，但没有管理者身份、没有共享任务区，分叉由 harness 被动
触发而不是由某个 lead 委派。

本插件当前验证基线是 `dsh 0.1.2-rc.1`（早于 agent-team），两者**未做互操作验证**——若同一
环境下都启用，需要先确认它们在 `agent/*` 事件与 inbox 语义上没有互相干扰（待办）。

## 实现范围


| 面 | 内容 |
|---|---|
| 触发 | `agent/inbox/inserted` + `inbox.remove()` CAS —— **只在 agent 忙（无法立刻被打断）时**分叉；空闲时消息照旧由当前会话回答 |
| 切点 | 最后一个 `turn/end` 作为 seed 边界（在飞 turn 不继承，由确定性渲染的「在飞摘要」承载） |
| 继承 | 新会话是**普通顶层会话**（不是 subagent 子会话），带旧会话的已完成前缀 ⇒ 转写连续 |
| 焦点 | 分叉后把客户端焦点交付到新会话（两阶段：先提供候选，客户端确认切换成功才 ack） |
| 回注 | 旧会话转 idle → 它这一 turn 的结果渲染后注入新会话 |
| 血缘 | 写进 DSH 官方存储域（`<DSH_HOME>/storages/autofork_lineage/`），**重启不丢**；工具与页签都读它 |
| 命名 | 新会话被命名为 `⑂n <家族根名>`（走原生 `sessionTitle.rename`，与手动重命名同一条路） |
| 界面 | 「分叉」页签（血缘树 + 点击跳转）+ 三行可折叠的注入摘要 |
| 调度 | `fork_list` / `fork_steer` / `fork_cancel` 三个工具 |

## 验证

```sh
npm run verify     # 语法（6 个发行文件 + 4 个 E2E 脚本）+ 3 道静态门禁 + 123 项自证测试
```

| 层 | 证据 |
|---|---|
| `npm test`·纯函数 | digest 的**确定性**（逐字节可复现、无时间戳/随机）与**有界性**（超预算显式标注丢弃量，且只让人类消息进固定保留区）；工具层**授权边界**（无 agent 上下文必须拒绝、调用者 id 必须透传、`keepInbox` 只认严格 `true`） |
| `npm test`·apply() 级 | 桩测试驱动**真实入口**：主路径（CAS 抢占 → seed 切点 → 注入通知 + digest → `followup` 投递）、**空 seed 主场景**、6 条拒绝路径、结果回注、创建期 idle、授权边界 |
| `npm run gate` 门禁 1 | **严格注入完整性**：顶层 `inject` 只放真正必需的服务（2 项），可选能力必须走嵌套 `ctx.inject`（`dsh-base` 之外的服务缺席时，只让那项能力缺席，而不是让整棵树起不来） |
| `npm run gate` 门禁 2 | **参数文档不漂移**：README 参数表与 `DEFAULT_PARAMS` 键集双向一致 |
| `npm run gate` 门禁 3 | **client bundle 契约**：调用 `__ModuleLoader__.load`、`id` 与包名一致、导出 `name`/`inject`/`apply` |
| **挂载（真实实例）** | `DSH_HOME=/tmp/dsh-autofork-home dsh web --port 0 --no-open` → 无 `plugin tree failed to load`；health 探针 → `200 {"ok":true,"tools":[…],"params":{…25 项…},"nodes":[…]}` |
| **client bundle（真实实例）** | boot payload 含 `{"id":"@vlln/dsh-autofork","url":"/plugins/??@vlln/dsh-autofork/client.js&rev=…"}`；该 URL → `200` / 28192 字节（含 `conversation.view` / `'分叉'`） |
| **行为层（真实 harness）** | `dsh --profile sdk`（stdio JSON-RPC）+ 官方 `llm-mock-server`（**不需要模型凭据**）驱动一次真实对话：父分叉的 step 挂住 → 第二条指令到达 → `forkDetected / digestInjected / noticeInjected / instructionDelivered` **全为 true**，且父分叉仍在 `running` 时子分叉已 `running → idle` 完成响应；同一场景验证**分叉命名**：`title.assigned "⑂1 <根标题>"`（序号只来自持久化血缘表，`title.ordinal {max, next, lineage}` 三者一致） |
| **血缘持久化（真实 harness，两进程）** | 进程 1（headless）分叉 → 盘上出现 `storages/autofork_lineage/edges/<head>.json`；进程 2（**全新 `dsh web` 实例**，随机端口）`GET /api/dsh-autofork/health?sessionId=<head>` 返回整棵树：根（标题由孩子的 `base` 反推）+ `⑂1 …`（`depth 1` / `parentId` / `current`）。同一场景里 head 的真实 turn 调 `fork_list`，`tool/result` 渲染出 `↑ 我接管的`（`isError:false` ⇒ 封闭的 `output.schema` 过得了运行时校验） |
| 未验证（只能靠人眼） | **「分叉」页签是否真的出现在 tab 栏、点击是否真的切了会话**、**焦点是否真的切换**、转写是否连续、折叠是否真的折叠——服务端只能验到 bundle 200 + 事件形状 + `nodes` 的形状 |

行为层证据跑在**已发布的 `dsh 0.1.2-rc.1`** 上（本机源码检出的 `node_modules` 不完整，未做基线 worktree 复验）。

### 行为层复现（台子在 [`tests/e2e/`](../tests/e2e/README.md)，但不进 `npm run verify`）

三个场景（忙时分叉 / 血缘跨进程 / 悬空工具调用两臂对照）与前置条件见
[`tests/e2e/README.md`](../tests/e2e/README.md)。**它不进 `npm test` 与 CI**，因为它需要一个
**dsh 源码检出**：官方 mock LLM 在 `packages/test-support/llm-mock-server` 里，不在 npm 闭包中，
要用 `DSH_MOCK_LLM_SERVER` 指路。命令形状：

```sh
export DSH_HOME=/tmp/dsh-autofork-e2e-home   # 先装：DSH_HOME=$DSH_HOME dsh plugin --profile sdk add .
export DSH_MOCK_LLM_SERVER=/path/to/deepseek-harness/packages/test-support/llm-mock-server/lib/index.js

# 终端 1：mock LLM（零依赖，OpenAI 兼容；stall 挂住旧会话的 step，success 回新会话）
MOCK_PORT=8123 MOCK_SEQUENCE=stall,success node tests/e2e/mock-server.mjs
# 终端 2：驱动真实 harness
DSH_AUTOFORK_DEBUG=/tmp/dsh-autofork-debug.log node tests/e2e/drive.mjs
```

`debugLogPath`（或环境变量 `DSH_AUTOFORK_DEBUG`）会逐行写下每条判定与早退原因——没有它，"为什么没分叉"在进程外完全不可见（每条早退分叉默认都是静默的）。

### E2E / 用户实测抓出的六个真 bug

单元测试与挂载验证都看不见，只有真跑一遍才暴露：

1. **可选能力做掉整个 harness**：`agentPresets` 写在顶层 `inject` 后，`--profile sdk` 的 runtime **启动失败**（`1 entry did not activate`）——不是本插件降级，是 dsh 起不来。修：顶层只留 `agents` / `sessionProjections`。
2. **空 seed 被当成"无合法切点"**：自动分叉的**主场景就是第一个 turn 还在跑**，此时没有 `turn/end`；早期实现因此**永远不触发**。修：对齐官方 `subagent-fork-in-process`，返回空 seed（等价全新子 session），上下文全由 digest 承担。
3. **创建期 idle 毒化回注**：子 agent 刚建立会发一次 idle；当成"turn 结束"会立刻回注空报告并标记 `reported`，真正跑完后的回注再也不会发生。修：判据用日志事实——必须已有 `turn/end`。
4. **digest 被样板文本吃光**：把系统注入（skill 目录、runtime 上下文）当"用户在飞消息"固定保留，实测能吃光整个 8000 字符预算。修：只有 `source.kind === 'user'` 进固定区，注入上下文只留紧凑标记——同场景 digest 从臃肿块降到 **241 字符**。
5. **往容器日志 append 必须带 surface 标记**：`session.append('user/message', …)` 抛 `is surface-eligible and requires a surfaceOp marker`。修：第三参 `{ surfaceOp: 'append' }`；同时把 `source` 改成 `form:'notice'` + `summary`，容器转写才是一行摘要而不是整块注入。
6. **镜像插进了 `assistant(tool_calls)` 与它的 `tool/result` 之间**（用户实测，容器直接 400 `INVALID_REQUEST`）。详见下面「为什么镜像不能无条件立刻落盘」。

### 为什么镜像不能无条件立刻落盘

容器的 surface 是**追加有序**的。当它已经发出 `assistant(tool_calls)` 而工具结果还没落盘时，
此时追加**任何** `user/message` 都会把这一对拆开，provider 直接拒：

```
An assistant message with 'tool_calls' must be followed by tool messages
responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)
```

第一版把"`user/message` 在**日志不变量**里无约束"误读成"在**转写顺序**里也无约束"——前者
确实没有，后者被 provider 强制。窗口正好是"工具正在跑"那段，也就是容器本来就没反应的那段，
所以**延后到下一个 step 起点**不损失可用性，读起来反而更顺（工具结果与实例产出一起来）。

`mirrorDelivery: 'safe'`（默认）就是这么做的：命中悬空工具调用 → 改走 `inject()`（走 inbox，
在下一个 `step/start` 才落到 surface）并入队；容器转 idle 时按 `message.id` 去重补落盘，
兜住"工具失败、turn 就此结束、再没有下一个 step"的情形。

`'immediate'` 保留为**对照臂**——它复现事故现场：

```sh
bash tests/e2e/e2e-dangling.sh   # 两臂对照：safe 臂镜像落在 tool/result 之后，immediate 臂落在中间
# safe      : toolCallSeq=20 toolResultSeq=26 firstMirrorSeq=31 → mirrorAfterToolResult=true
# immediate : toolCallSeq=20 toolResultSeq=26 firstMirrorSeq=25 → mirrorAfterToolResult=false
```

headless 下 `bash` 被本机沙箱拒绝并瞬间返回，造不出那段窗口，所以这个 E2E 用
一个自建的 `slow_wait(ms)` 工具插件（在**进程内** sleep，不碰沙箱）——它就在
[`tests/e2e/slow-tool-plugin/`](../tests/e2e/slow-tool-plugin/)，同样不进 `npm run verify`。
mock 不校验消息顺序，它复现的是"顺序被写坏"这个事实本身；真实 provider 才把它变成 400。

⚠️ **写坏是永久的。** surface 是追加有序的，"插错位置"这件事会被记进日志，之后**这条会话的
每一次请求**都带着那个非法顺序——用户实测的那条会话在 turn 一次 400 之后再也没法继续
（只能新开）。这正是 `mirrorDelivery` 默认必须取 `'safe'` 的原因：宁可晚一点显示，
也不能把用户的会话写死。


### 一条与安全相关的实测结论

`bash` 这类外部进程**没有任何守卫**：本机上它甚至被沙箱直接拒绝（`sandbox-exec` 不可用）。文件级冲突由 harness 的 `fs-observation-policy` 兜底（`FS_STALE_VERSION`），但 `git commit` / `rm` / 重定向不受保护。本插件**有意不做**这一层的隔离或仲裁，交由 agent 自行判断——这是设计选择，不是遗漏。

### health 探针

`GET /api/dsh-autofork/health[?sessionId=<id>]` 返回插件参数、已注册工具、家族状态。它的存在理由是**挂载在进程外不可观测**：DSH 的 `ctx.logger.info` 不写 stdout（实测 boot 日志只有 2 行），`dsh plugin list` 也只转发 pnpm。带 `?sessionId=` 时返回：

- `nodes`：「分叉」页签的数据源——家族链条（根 → 最新，**含本会话自己**），每项带
  `title` / `state`（互斥三态 `running|idle|finished`）/ `busy` / `depth` / `current` / `parentId`。
- `driver`：当前回答用户的那条会话。
- `?consume=1` 时另给 `handoff`（待交付的新 driver，两阶段交付用）。

## 能力面

### 机制

| 项 | 说明 |
|---|---|
| 触发事件 | `agent/inbox/inserted`（DSH core 事件；消息进入 agent inbox 时发出） |
| 抢占原语 | `agent.inbox.remove(messageId): boolean`——抢到才分叉，抢不到即让原 steer/queue 生效 |
| 切点读取 | `TurnBoundaryProjection`（key `turnBoundary`，由 `dsh-agent-loop` 注册） |
| 建分叉 | `ctx.agents.create({ seed, inheritedEventCount, meta, setup })` |
| 子分叉组合 | `ctx.agentPresets.composeFrom(agentCtx, parentCtx)`——加入父分叉同一份 standing composition |
| 上下文注入 | `agent.inject(UserMessage)`（不唤醒）+ `agent.followup(UserMessage)`（唤醒） |
| 回注触发 | 子分叉 `agent/status` 转 `idle` |

## 容器形态（默认）：**同一个容器**，忙时才分叉

**触发规则**（这条决定它还是不是"自动分叉"）：

- 容器**空闲**（能立刻响应）→ **容器自己作答，不建任何 agent**；
- 容器**忙碌**（在跑它自己那条 turn，来不及打断）→ **分叉**：建一个 agent 接手这条消息，
  agent 的答复**作为一等 assistant 回复**出现在容器转写里，容器自己那条 turn **不中止**。

> 笔记原文：「自动 branch 只会发生在 agent 处于无法立刻被打断的情况下（也就是同步执行的
> 时候），而在正常的一次 agent 反馈后的用户指令不会 branch，因为已经可以立即响应了。」

实现：`routeToInstance` 开头 `if (container.status !== 'running') return`；
`agent/pre-step` 只在"这一步没有用户消息可答"（分叉时消息已被 CAS 抢走）时 reject，
有用户消息时放行——放行那一条就是"空闲容器自己作答"的路径。

容器 = 你所在的那条会话，**从头到尾是同一条**（session id 不变，你永不移动）。
A 和 B 都是**这条会话名下的 agent**（"一条 session 持有多条 agent 的 durable 记录"），
谁当 head 就把内容渲染进容器的转写：

```
 5 turn/start
 6 subagent/catalog  instance=A          ← 花名册：A 是容器名下的 agent
 8 user/message user "…"                ← 你说的那句话
10 turn/end {"kind":"blocked"}          ← 容器自己：不跑 step、不发模型请求
13 turn/start 14 subagent/catalog B     ← 分叉：B 成为 head
17 turn/end {"kind":"blocked"}
18 turn/start 20 assistant/message "…"  ← B 的答复成为容器里的**一等 assistant 回复**
22 turn/end {"kind":"completed"}
```

**容器自己永不干活**：用户消息一进 inbox，容器的 loop 就会开 turn，而 `preStep` 总会注入
runtime context / skill catalog 使消息表非空 ⇒ 它会自己发一个真请求、与 agent 重复劳动。
插件在 **`agent/pre-step`**（waterfall）上给容器返回 `{kind:'reject'}`，于是 loop
"不跑 step、不发请求、不产出回复"地立刻收尾。

⚠️ 必须是 `reject`，不能是 `{kind:'enter', messages: []}`：链上十几个 pre-step 监听器
（skill 目录、time-context、agent-instructions、plan-mode…）都会在 `enter` 时把自己的注入
**追加回 `decision.messages`**，空表又被填满；它们**全都**显式短路 reject。

已用真实 harness 验证：mock LLM 只收到 agent 的调用，容器 **0** 次。

### 旧版本说明

分叉曾按"容器前移"实现（head 是新的顶层会话，用户跟过去）。用户实测后否掉了它：
那会让 A 与 B 变成**两条独立的容器**。现在 head 是**容器名下的 agent**，
容器本身不动——这才是"同一个容器，内容变成 head 的"。



**容器 = 用户当前所在的那条会话；分叉时它前移一格。** 目标是**打破同步交互**：用户发出消息后
永远是立刻在跟一条空闲的 agent 说话，而不是等旧 agent 跑完。

一次分叉发生的事：

1. 用户的消息在旧会话（下称 A）的 inbox 里被 `inbox.remove()` **CAS 抢下**，投给新建的 head（B）
   ——A 从头到尾**没被中止**，它的在飞 turn / step 原样继续；
2. **B 用 A 的历史做 seed**，所以客户端的焦点切到 B 之后，转写是**连续的**（见「seed 只继承**已完成**的部分」）；
3. 客户端（本插件的 client half）在 1 秒内看到 `handoff`，调 `sessions.open(B)` 把用户切到 B 并 ack；
   切不过去就下次重试（两阶段交付，见「交付是两阶段的」）；
4. A 跑完后，它的最后一条回复被转给 B——**B 是用户面对的那条，所以是 B 讲给用户听**；
   同一份产出也回灌进 A 的日志（`mirrorInstanceReply`），点回 A 也能看到完整经过。

### 为什么「留在 A 里看」做不到（用户实测拍板，不是没打磨）

曾经默认 `followHead: false`：用户留在 A 里，B 作为 A 的实例嵌套，B 的产出以折叠成一行摘要的
注入行回灌进 A 的转写。**用户实测结论：那个效果对用户没有意义。**

原因是结构性的，不是文案问题：

- A 那个长步骤的**在飞 turn 就写在 A 自己的日志里**；
- 会话的「运行中」状态来自它的日志里有一条**开着的 turn**（不变量：一条日志同时只有一个
  `openTurn`，`turn/start` 在 `openTurn !== null` 时直接失败）；
- 所以只要不中止 A，A 就一直是「卡住」的样子。插件能改的只有那行注入的**文案**，
  **改不掉 A 自己那条开着的 turn**。

用户仍要等 = 同步交互没被打破。要打破它，用户所在的会话就必须是**已经换成 driver 的那一条**
（`followHead: true`，默认）。

### seed 只继承**已完成**的部分

seed 只取"最后一个 `turn/end` 及其之前"的事件；**没有已完成的 turn 时是空 seed**
（等价全新子会话，对齐官方 `subagent-fork-in-process`）。

**当前那个在飞的 turn 不继承** —— 这是笔记的原话：「继承当前 session 的所有状态和模型
上下文，但**最后一个 step（当前进行中的模型生成或者工具的执行）不继承**」。它**只由
「在飞摘要」（`renderInFlightDigest`）承载**，digest 里那条 `[用户] …` 固定行就是它。

曾经做过相反的事（把在飞 turn 的用户消息合成一段前缀带过去），已撤回：那样同一条消息会
**被继承一次、又被在飞摘要渲染一次**（用户实测报的"与在飞摘要冗余"），而且违背上面那条规则。

### 子会话的"durable 父地址"：三件事缺一不可

用户实测报过 `历史加载失败：subagent Sessions require their durable parent address（session/agent-busy）`。
根因是**子会话的寻址**，它比"实例树能显示出来"多两组要求：

**① 子会话自己的日志里必须有 `subagent/descriptor`**（版本 3，`.strict()`）：
`{version:3, mode:'continuable', provider, label, agentProvider?, agentModel?}`。
它不是装饰——宿主与客户端都靠它把子会话认出来：

- `validateAddress()` 读 `subagent` 投影（由该事件折叠而来），要求
  `identity.seq >= inheritedEventCount` 且 `identity.mode === address.mode`；
- 分类子会话的 `resolveCandidateRows()` 更严：`live.isOwnSeq(identity.seq)`。

所以**它必须落在继承前缀之后**——seed 的正确形状是
`[…继承前缀…] + session/end-seed（边界）+ subagent/descriptor（子会话自己的第一条）`，
且传给 `create()` 的 `inheritedEventCount` 必须是**前缀长度**、不是 seed 长度。
落盘后 header 里的 `seedLength` 就是它：实测 head 的日志与 header 为

```
header: {parentSession: '…', seedLength: 5, origin: 'subagent'}
0 turn/start  1 step/start  2 user/message(用户原话)  3 step/end  4 turn/end
5 session/end-seed         ← 边界 = seedLength 5
6 subagent/descriptor      ← seq 6 ≥ 5，算"自己的事件"
```

（与官方 `seedDescriptorTurn(childId, seed, descriptor)` 同款。前缀为空时必须给 `Session.create`
传 `undefined` 而不是 `[]`，否则会凭空多一个边界事件——官方真实子会话的形状是
`[descriptor@0, end-seed@1]`。）

**② 父会话日志里要有 `subagent/catalog`**（容器模式下才需要；见上面「容器形态」）。

**③ 客户端必须用 `openSubagent(address)` 打开它，不能用 `open(id)`**：
宿主对 `address.kind === 'session'` 且 `header.origin === 'subagent'` 的请求**直接拒**
（就是那个报错）。地址形如 `{parentSessionId, childSessionId, mode}`，且必须从**父会话的
catalog** 派生——`selectSubagent()` 会校验 catalog 里有同 id、同 mode 的 child 条目。
因此客户端 `openAddressed()` 的顺序是：`refreshSubagents(parentSessionId)` →
`navigationAddress(id)` → `openSubagent(address)`，派生不到才退回 `open(id)`。
服务端的 `handoff` 因此必须带 `parentSessionId`，否则客户端拿不到父会话的 catalog。

### head 是**普通顶层会话**（扁平，不挂子会话）

分叉产生的 head **不是**旧会话的子代理：不设 `origin:'subagent'`、不设 `parentSession`、
不写 `subagent/catalog`。理由：

- 一旦标成子会话，它就被**嵌在旧会话里面** —— 用户看到的是"A 里钻进了一个子代理"，
  **顶层容器仍然是旧会话**、内容仍然是旧会话的，于是"容器内容换成 B"永远做不到；
- 而那就是**层级模型**（容器=管理者、分叉=下属），本插件的模型是**扁平分叉**：
  并行拉起一个新 session，与用户交互的就是它。

落盘实测（head 的 header 与事件）：

```
{"type":"session","version":0,"id":"session-…","cwd":"…","seedLength":5,"delegationDepth":0}
0 turn/start 1 step/start 2 user/message(用户原话) 3 step/end 4 turn/end
5 session/end-seed  6 permission/preset …            ← 无任何 subagent/* 事件
```

`seedLength: 5` 是继承前缀的长度（= `inheritedEventCount`），恢复侧据此还原
`isSeeded`；所以"重启后打不开"这类坑不存在（前提是建 head 时传了 `isSeeded: true`）。

**代价**：原生**实例树**不再列出分叉。血缘由 ①「分叉」页签、② `fork_list` 工具表达，
**并且是持久化的**（见下节）——dsh 重启后关系仍在。

### 血缘是**持久化**的（重启不丢）

分叉关系写进 **DSH 官方的存储域**，而不是插件自己找地方放文件：

```yaml
# dsh-base 的 cordis.patch.yml（官方插件自己也在用这套）
- id: storage-json   name: @deepseek-ai/dsh-storage-json     config: { root: dshHomePath('storages') }
- id: storage-domain name: @deepseek-ai/dsh-storage-domain   config: { backend: json }
```

插件调用 `ctx.storageDomain.open(spec)`（spec 用 `defineDomain` + `domainTable(zod)` 声明），
**落点由 DSH 决定、且按域独占**：

```
<DSH_HOME>/storages/                    ← 所有域共用的根（后端 config 的 root）
├── autofork_lineage/edges/<新会话 id>.json   ← 本插件独占（域名 = 目录名 = 后端 unit 名）
├── session_projcache/sessions/*.json       ← 官方投影缓存（另一个域）
└── workspace.json                          ← 官方 workspace 域（layout:'single'）
```

域之间只共享父目录、不共享文件（域名唯一，per-record 布局再按表名分目录），所以不会与别的
插件抢键或抢文件。一条边 = 一次分叉：

```json
{ "version": 1,
  "record": { "workerId": "session-<被接管的>", "rootId": "session-<家族根>",
              "ordinal": 4, "base": "修 GUI 卡顿", "title": "⑂4 修 GUI 卡顿",
              "createdAt": 1789149220103 } }
```

- **schema 在持久化边界上被校验**（官方域设施逐条验证），坏了也不会让插件起不来：
  `invalidRecords: 'backup-and-skip'` + `layout: 'per-record'`（一条边一个文档，彼此独立）。
- **读取**：health 探针的 `nodes`、`fork_list`、`steer`/`cancel` 的授权都先等一次域装载
  （`settleLineage()`，一次性表扫描），之后同一次请求里的读取就都能看见持久化的边。
- **降级**：域打不开（比如别的组合没有存储栈）只退化成"本次运行内的内存血缘"，
  分叉本身照常工作。
- **同族是树不是链**：一条会话可以被分叉多次（`⑂1` / `⑂2` 都是它的孩子），所以
  `fork_list` 除了 `↑ 我接管的` / `↓ 接管了我的`，还会给出 `~ 同族的另一条分叉`。

### 可见化

- **「分叉」页签**（会话视图区，与「对话」「轨迹」并列）：画出本会话所在家族的完整链条
  ——根 → 每一级分叉，逐行显示**名字 / 实时状态 / 我在哪一格**，点任意一行即可跳过去。
  它取代了原先会话头部右上角那个胶囊下拉（用户 2026-09 拍板取消）：那个位置只能承载
  「现在是谁在回答你」一个事实，而这里要回答的是一组事实（有哪些会话、谁在跑、谁在等、
  谁已结束、我在哪一格）。
  实现走原生槽位：`conversation.view` 是个 **list 槽**，`ui-conversation` 直接遍历它的条目
  造 tab 按钮（官方「轨迹」就是这么注册的），所以观感与原生 tab 完全一致。
- **分叉会话有自己的名字**：`⑂1 修 GUI 卡顿`（标记 + 序号 + 家族根名，见下面「分叉会话的名字」）。
- 注入行一律**折叠成一行摘要**（`source` 声明 `form:'notice'` + `summary`）：分叉通知、在飞摘要、
  后台回复各占一行，不把转写刷成一片大段注入。只影响呈现——`source` 不进 `deriveMessages()`
  的投影，模型读到的正文一字不改。用 `noticeSummaries: false` 可关掉折叠。
- 容器模式（实验，默认关）下另有原生**实例树**：子会话以 `meta.origin='subagent'` +
  `meta.parentSession=C.id` 创建，并向 C 的日志写 `subagent/catalog`（两者**必须同时做**：
  只设 origin 不写 catalog 会让客户端停在「正在加载子代理」；只写 catalog 不设 origin
  会被寻址校验拒）。扁平模式（默认）**不标** subagent——head 自己就是用户的会话本体。

### 分叉会话的名字

`⑂1 <家族根名>` —— 标记 + 序号 + 基名，三条都是用户 2026-09 定的形状：

| 取值 | 为什么 |
|---|---|
| **标记在最前**（`⑂`） | 侧栏是单行截尾的，标记与序号放最前才一定看得见 |
| **序号不累加** | 全家族共用一个基名：`⑂1 修 GUI 卡顿` / `⑂2 修 GUI 卡顿`。路径式累积（`⑂1-1`）会把重要部分挤到被截掉的那一头 |
| **基名取家族根会话的标题** | 同族在左侧列表里**成组**、一眼能归堆；链式分叉时不会滚成 `⑂1 ⑂2 …` |

走的是原生 `ctx.sessionTitle.rename()`——**与用户在侧栏手动重命名完全同一条路**（追加一条
`source:{kind:'user'}` 的 `session/title`），所以左侧列表、头部面包屑、搜索全都自动生效。
代价要写明：rename 会**钉住**标题，这条会话不会再被 `dsh-session-title-first-prompt-llm` 自动命名
（用户明确选了"名字立刻确定、不等模型那一两秒"）。`titleMark: ''` 可关闭命名。

序号只来自**持久化血缘表**（外加本次运行的内存镜像）——不靠"从标题里反推当年分配了几号"。
曾经有过两条这样的兜底路径（读内存活会话的标题、读持久化会话的标题 + 投影缓存），
用户 2026-09 拍板删掉：既然有了 schema 校验、读取零 I/O 的持久化方案，就不该再养着
"从渲染结果反推事实"的判据——那种判据只会在真实数据上悄悄出错（标题是用户随时能改的）。
代价写明：存储域缺席且跨了进程重启时，同族可能出现两个 `⑂1`（命名降级，不影响分叉）。

把 `followHead` 设为 `false` 可退回「留在原会话」的对照形态（适合「只看产出、不要视图移动」的部署）。

### 为什么答复不能做成一条「一等 assistant 回复」

这是客户端契约给的上限，不是没做：

- `user/message` 在客户端由 ui-chat 的 `input-message` 定义**独占**渲染（它按 `source.kind`
  内部分叉成用户行 / 上下文行），而事件派发是**所有匹配的定义都发布**
  （`dispatchInput` 遍历全部 entries 并逐个 accept）——插件再注册一个匹配 `user/message`
  的定义只会**多渲染一行**，拿不到接管权。
- `assistant/message` 需要开着的 step（不变量 `requireOpenStep`），会话 idle 时根本写不进去；
  而且插进 `tool_calls` 与 `tool_result` 之间同样是非法的消息顺序（见上面那条 bug）。
- `form:'relay'`（官方给「agent 之间转发消息」用的形态）正文会渲染成「来自会话 X」，
  但它的**折叠行只有标签、没有一行 account**（`relay` 不带 `summary`），用户不展开就看不到内容。

所以那条行的来源标签是 `fork-answer`、折叠行的一行 account 直接写 `分叉 xxxxxxxx：<回复要点>`。

### 为什么不做一个「容器视图」

曾经做过原型：向 `conversation.view` 注册一个 label 为「容器」的视图，试图在一条会话的视图里
内联渲染另一条会话的原生转写。**该提案已撤回**（原文只在本机历史里，不随仓库分发），
实测挡路的是三件硬事实：`@deepseek-ai/dsh-client-ui-chat/client` **不导出**转写渲染器；
`ConversationViewRegistry` 只按 target 注册视图构造器，**没有跨 session 派发 API**；
`page` / `follow` 两个 RPC 都是 **session-addressed**。原型页签因此从客户端移除。

## 模型：链式接管

分叉形成的是一条**链**，不是父子树：

```
A ←── 接管 ── B ←── 接管 ── C
```

- **head** = 最新的那条，用户面向它；它**接管**了身后的会话。
- 被接管的会话继续在后台跑（**绝不中止在飞 turn / step**），它最后一条回复流向 head。
- head 能看见并管理整条链：`fork_list` 列出家族（↑ 我接管的 / ↓ 接管了我的 /
  ~ 同族的另一条分叉——同一条会话被分叉多次时，两条分叉互为兄弟），每行带**名字**与**一个**实时状态标签：
`运行中（正在跑自己的 turn）` / `空闲（可以立刻接话）` / `已结束（agent 已不在）`
—— 三态互斥（曾经并排打 `[state]` 与 `busy` 两个含义不同的字段，于是出现
`[running] 已停` 这种自相矛盾的行）。，
  `fork_steer` / `fork_cancel` 作用于家族成员。

第一版把这个关系读成"父拥有子"，方向是反的——head 调 `fork_list` 返回空，因为它被
当成"子"而不是"拥有者"（实测："B 无法用 branch-list 工具列出 A"）。修正后与
"无限身份一致性"对齐：**身份沿链前移，身后都是可调度的后台会话。**

一次分叉做四件事：

1. 触发判定通过 → `inbox.remove()` CAS 抢占用户消息；
2. 在**最后一个已完成的 turn** 上 fork 出新会话作为 head（没有已完成 turn 时用空 seed）；
3. 给 head 注入分叉通知（点名 worker 正在动的文件）+ 在飞 turn 的确定性 digest；
4. 给 worker 注入一条**不改变方向**的提示：继续工作，但把最后一条回复写成简短总结。

## 设计要点（有实验依据）

### 竞态是自愈的

消息进入 inbox 后、被 loop 领取前，插件用 `inbox.remove()` 做 CAS：

| 场景 | 消息在 inbox 停留 | 结果 |
|---|---|---|
| agent 在**长 step 内**（正是需要分叉的场景） | 数分钟 | 插件稳赢 CAS → 分叉 |
| agent 在 **step 边界** | 毫秒 | 插件输掉 CAS → 消息按 steer 投递 → agent 立刻响应，**本来也不需要分叉** |

输掉竞争的场合，恰是"不该分叉"的场合。因此不需要额外的竞态保护。

### 为什么必须补偿在飞 turn

`CreateAgentOptions.seed` 的契约要求 seed 是**平衡的已完成 turn 前缀**，明确"contain no open turn/step or dangling tool call"。所以会话层 fork 切不进一个正在跑的 turn——而自动分叉的触发场景**恰恰是** agent 处于长 turn 中途。

结果：子分叉的 seed 缺掉整个在飞 turn（可能 30 个 step）。`src/digest.mjs` 把这段事件流水确定性渲染后注入，作为补偿。

### 注入通知不是安全网

两个分叉共享同一 cwd、**文件系统无隔离**。真正拦住静默覆盖的是 harness 的 `dsh-fs-observation-policy`：文件在读取后被改动时，`write`/`edit` 会以 `FS_STALE_VERSION` 失败并要求重读。实测中它确实开火并串行化了两个并发写入者。

所以 fork 通知的定位是**效率与意图机制**（少做重复劳动、撞守卫时知道该重基），不是安全机制。把它当安全网会在 prompt 上过度投入。

### 有意不做：`bash` 竞态

`fs-observation-policy` 是**工具级策略**（挂在 `fs/*` 事件上），不是 OS 级锁。`bash` 跑 `git commit`、`rm`、`mv`、重定向完全绕过守卫。本插件不对其加隔离或仲裁，交由 agent 自行判断——这也是一个有意的观察性实验。

### 客户端：为什么是轮询而不是"监听新 session 出现"

第一版监听 `sessions.list` 里新出现的会话再回查路由。**实测两次失败**，两次的根因不同：

1. 启动押在 `sessions.list.subscribe` 上，而**页面在"尚无当前会话"时加载、之后选中会话并不触发该回调** → 轮询一次都没跑（决策日志里 `slot.mounted` 有、`health.request` 为 0）。改为**无条件定时 tick**，每次重读 `current`。
2. 交付送达、`openSession` 被调用，却抛 `TypeError: uiWorkspace.openSession is not a function` —— 取服务的方式不对。所有能正常工作的插件都用**属性访问** `ctx.uiWorkspace.…`；改为属性访问且**在调用点取**（不在 apply 时捕获）。

现在依赖只剩"HTTP 能通"，且所有客户端失败都会经 `?note=` 回报到决策日志——客户端 half 不再是黑盒。

### 交付是两阶段的

`consume=1` 只**提供候选**、不清标记；客户端切换成功并**确认 `current` 真的变了**之后才
用 `ack` 清除。切换失败不 ack，下次轮询服务端会再提供同一条，自动重试。

### 回注方向

**worker → head，且只转 worker 的最后一条回复**（不转整个 turn 的事件流水——那是日志，
会淹掉结论）。worker 侧由注入的分叉提示要求它把收尾写成总结。

### 参数：几条取舍的来由

### 为什么默认不设"step 年龄"门槛

曾经默认 `minStepAgeMs=8000`，理由是"step 还年轻说明边界马上到，steer 就能解决"。
**实测证明这个推断是错的**：用户发第二条消息时当前 step 只跑了 1.19 秒，而那一步正在
跑 `sleep 5min`——边界要 5 分钟后才到，消息被 queue 住，**分叉完全没有触发**。

而且在不中止 worker 的链式模型下，分叉的代价只剩"多一条会话 + 一份 digest"，
年龄门槛已失去保护作用。参数保留只为让部署能按需调回保守策略。

### 已被接管的会话，消息直接落到 head

若本会话已被接管（链上已有 head），用户消息**不再分叉，而是投给 head**。
这是状态规则而非时间窗：一条链上只有 head 是继续对话的地方。用时间窗做合并会犯错
——被合并的那条消息会被 steer 回**仍被阻塞的 worker**，等于又让人等。

### 环境变量覆盖

`DSH_AUTOFORK_PARAMS`（JSON 对象）可在不改出厂默认值的前提下覆盖任意参数，**优先级低于插件配置**：

```sh
# 真实模型很快时，缩短分叉门槛，便于验证
DSH_AUTOFORK_PARAMS='{"minStepAgeMs":0}' dsh web
```

非法 JSON 与非对象值一律被忽略，绝不让插件起不来。这条通道与 health 探针、`debugLogPath` 同源：**验证与排障需要在不改出厂默认值的前提下调行为**。

## 确定性的三条不变量

`src/digest.mjs` 的门禁（`npm test`，16 项）：

1. **纯函数**：无 `Date.now()`、无随机数、无 I/O；同一输入逐字节可复现。
2. **有界**：任何输入都产出不超过预算的文本，并标注丢弃了什么。
3. **不发明内容**：只取事件字段，不推断、不总结、不改写。

## 开发期安装（本机目录）

```sh
cd dsh-autofork && dsh plugin --profile web add .
```

⚠️ **本地目录安装会让官方包解析失败**（实测）：`add <本地目录>` 生成 `link:` 依赖，Node 用插件的**真实路径**做 parent-walk，走不到 `$DSH_HOME/profiles/node_modules`，boot 报
`Cannot find package '@deepseek-ai/dsh-llm' imported from <plugin>/index.mjs`。
**开发期修法**（不入库）：

```sh
ln -sfn "$DSH_HOME/profiles/node_modules" <plugin>/node_modules
```

**git 源安装不受影响**（pnpm 把包放进 profile 内部，parent-walk 可达）。所以只有"从本地目录开发调试"才需要上面那条 symlink。

挂载后确认无 `plugin tree failed to load`，并 curl health 探针确认 `ok:true`（`ctx.logger.info` 不写 stdout，日志不是可靠判据）。
