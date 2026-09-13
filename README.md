<h1 align="center">dsh-autofork</h1>

<p align="center">DSH 插件：agent 忙的时候你提交的新指令会<strong>立刻</strong>在新会话里得到响应，原来那条会话留在后台把活干完、再把结果回注过来。<br>
Automatically forks the session when you type while the agent is busy — you keep talking, the old turn keeps working.</p>

<p align="center">
  <a href="LICENSE"><img src="https://badgen.net/badge/license/MIT/blue" alt="license"></a>
  <img src="https://badgen.net/badge/format/dsh%20bundle/blue" alt="format">
</p>

## 这是什么

用 DSH 工作时一个 turn 常常跑十几分钟（工具调用、长生成）。这期间你提交的新指令只有两条路：**queue**（等当前 turn 结束）或 **steer**（等下一个 step 边界）——两者都是**串行**的，你只能等。

dsh-autofork 补上这一步：检测到你在 agent 忙时提交新指令，就**自动分叉**出一条新会话让你立刻说上话；原来那条会话在后台继续跑它没做完的那一轮（**绝不中止**），跑完后把结果回注到你现在这条会话里。

> **关键是"自动"。** 官方 `subagent` / `subagent_fork` 要求 agent 自己决定要不要并行、fork 哪一段；这里的分叉是 **harness 侧被动发生**的 —— agent 不需要参与决策，也不会因此被打断。

## 安装

```sh
dsh plugin --profile web add github:vlln/dsh-autofork
```

装完**重启 web**（bundle 走层栈）。从本机目录安装（开发用，要一条 symlink 修法）见[工程笔记](docs/engineering-notes.md)。

## 用起来是什么样

**只在 agent 忙的时候分叉**：它空闲时（能立刻响应你）就是它自己回答，不会平白多出一条会话；只有它正跑着自己那一轮、来不及被打断时，你发的那条指令才会带出一条新会话。

一次分叉你会看到：

| 你会看到 | 说明 |
|---|---|
| 左侧列表冒出新会话 | 名字是 `⑂1 <原会话名>`；同族在列表里**成组**（`⑂1` / `⑂2` … 共用一个基名，序号不累加） |
| 焦点被切到新会话 | 你立刻在跟一条空闲的 agent 说话；转写带着旧会话**已完成部分**，读起来是连续的 |
| 旧会话继续跑 | 它这一轮**不中止**；跑完后最后一条回复回注到你现在这条会话 |
| 多出一个「分叉」页签 | 本会话所在家族的血缘树（名字 / 实时状态 / 我在哪一格），点任意一行跳过去 |
| 注入行折叠成一行 | 分叉通知、在飞摘要、后台回注各占**一行摘要**，展开才看正文 |

再忙一次会接着分叉（`A → B → C`）：最新的那条负责回答你，身后的会话都在后台跑完、把结果交上来。已经被接管的会话里你再发言，消息直接交给最新那条（不再分叉）。

## 工具

agent 自己会用到的三个工具（`exposeDispatchTools: false` 可关掉）：

| 工具 | 说明 |
|---|---|
| `fork_list` | 列出你家族里的其它会话：`↑` 你接管的、`↓` 接管了你的、`~` 同族的另一条分叉。每行带名字与**一个**实时状态（运行中 / 空闲 / 已结束） |
| `fork_steer` | 给家族里的一条会话发中途指令（等价 steer）：它在当前 step 结束后读到并改向，不必中止 |
| `fork_cancel` | 中止家族里的一条会话（`keepInbox=true` 只中止当前 turn、保留待处理项） |

## 界面

| 位置 | 说明 |
|---|---|
| 「分叉」页签 | 会话视图区新增的一个 tab（与「对话」「轨迹」并列）：画出本会话所在家族的血缘树，点任意一行跳过去 |
| 会话名 | 分叉出来的会话命名为 `⑂n <家族根名>`（如 `⑂1 修 GUI 卡顿`），同族在左侧列表里成组 |
| 注入行 | 分叉通知 / 在飞摘要 / 后台回注各占**一行可折叠摘要**（`noticeSummaries: false` 可关掉折叠） |

## 参数

全部行为参数集中声明在 `src/params.mjs`，无硬编码；插件配置覆盖任意字段，未提供者取默认值，未知键被忽略。

| 参数 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后完全退回 steer/queue |
| `minStepAgeMs` | `0` | 分叉门槛：step 已运行**低于**此时长则不分叉。**默认 0 = 只要忙就分叉**（保守部署可调大） |
| `coalesceWindowMs` | `2000` | 距下一个 step 边界不足此时长时降级为 steer（合并窗口） |
| `forkableSourceKinds` | `['user']` | 只对这些 `message.source.kind` 触发分叉 |
| `maxActiveBranches` | `3` | 同一前台下的活跃后台分叉上限；超出强制 steer |
| `harvestAfterMs` | `600000` | 已回注分叉多久后视为已收割并移出计数 |
| `digestMaxChars` | `8000` | in-flight digest 整体字符上限 |
| `digestAssistantChars` | `600` | 单条助手文本截断长度 |
| `digestToolArgsChars` | `300` | 单条工具调用参数截断长度 |
| `digestToolResultChars` | `400` | 单条工具结果截断长度 |
| `digestMaxEvents` | `200` | digest 最多渲染事件数（自尾部保留最近） |
| `reInjectOnTurnEnd` | `true` | 后台 turn 结束后是否回注前台 |
| `reInjectMaxChars` | `4000` | 回注内容字符上限 |
| `wakeForegroundOnTurnEnd` | `true` | 前台 idle 时用 `followup` 唤醒，否则只 `inject` |
| `containerMode` | `false` | **容器模式（实验，默认关）**：容器不跑 turn、消息交给绑定实例、答复写成一等回复。**不要打开**：容器**不可能**完全不跑 turn，这条模式会与实例重复劳动 |
| `rebindNotice` | `true` | 容器模式下首次绑定 / 重绑 driver 时，在容器里插一行折叠通知 |
| `followHead` | `true` | **是否把焦点切到新分叉**。默认 true = 立刻在跟一条空闲 agent 说话（「打破同步交互」的前提）；`false` 留作对照：只看产出、视图不移动 |
| `instanceLabel` | `'分叉'` | 实例在会话头部实例树里的显示名 |
| `titleMark` | `'⑂'` | 分叉会话的**命名标记**：建 head 时把标题钉成 `<标记><序号> <家族根名>`（如 `⑂1 修 GUI 卡顿`）。序号**不累加**——同族共用一个基名、各自编号，所以左侧列表里同族成组。走原生 `sessionTitle.rename()`（与手动重命名同一条路），代价是这条会话不再被自动命名。**空串 = 关闭分叉命名** |
| `instanceProvider` | `'fork'` | 写进子会话 `subagent/descriptor` 的 `provider`（只用于冷恢复反查后端） |
| `mirrorInstanceReply` | `false` | 是否把实例的回复**反向**追加进容器日志。默认关：方向错了（笔记定的是"旧会话的结果注入回新会话"），那是 `reInjectOnTurnEnd` 干的 |
| `mirrorDelivery` | `'safe'` | 实例回复的投递方式：`'safe'` 避开悬空 `tool_calls`（必要时延到下一个 step 起点）；`'immediate'` 直接 append（**已知会写坏容器转写**，仅作对照） |
| `noticeSummaries` | `true` | 注入消息是否声明 `form:'notice'`——客户端把它**折叠成一行摘要**（可展开），不折叠则整块显示 |
| `exposeDispatchTools` | `true` | 是否向前台暴露 `fork_list` / `fork_steer` / `fork_cancel` |
| `debugLogPath` | `''` | 决策日志路径（逐行 JSON）；空表示关闭，可用环境变量 `DSH_AUTOFORK_DEBUG` 兜底 |

渲染预算不足时，digest **显式标注丢弃量**（`因字符预算未渲染` / `更早的 N 个事件`），不做静默截断。

## 环境变量

两个都不改出厂默认值，优先级**低于**插件配置：

```sh
# 覆盖任意参数（JSON 对象；非法 JSON 与非对象值一律忽略，绝不会让插件起不来）
DSH_AUTOFORK_PARAMS='{"minStepAgeMs":0}' dsh web
# 打开决策日志（逐行 JSON：每条判定与早退原因）。**"为什么没分叉"先看它**——早退默认是静默的
DSH_AUTOFORK_DEBUG=/tmp/dsh-autofork-debug.log dsh web
```

## 自检

`GET /api/dsh-autofork/health[?sessionId=<id>]` 返回插件参数、已注册工具与家族状态（`nodes` 就是「分叉」页签的数据源，`driver` 是当前回答你的那条会话）。

它也是"插件到底装上没有"的唯一可靠判据：DSH 的 `ctx.logger.info` 不写 stdout，`dsh plugin list` 也只转发安装器。

## 已知限制

- **分叉出来的会话是普通会话**，不会出现在原生「子代理」实例树里 —— 这换来的是"用户所在的会话不变、内容换成新的"。家族关系由「分叉」页签与 `fork_list` 表达，**重启不丢**。
- **命名会钉住标题**：走的是与手动重命名同一条路（侧栏 / 面包屑 / 搜索都正常），代价是这条会话不再被自动命名。`titleMark: ''` 可整个关掉。
- **没有文件级隔离**：分叉与旧会话共享同一个 cwd。`write` / `edit` 有 stale-version 守卫会拦住静默覆盖，但 `bash` 里跑的 `git commit` / `rm` / 重定向**不受保护** —— 两个并发会话碰同一批文件时请自己协调。
- `containerMode`（默认关）与 `mirrorDelivery: 'immediate'` 是**实验/对照开关，不要打开**：前者会让容器与分叉重复劳动，后者已知会写坏会话转写。
- 客户端一半只在 **web** 平台生效（`dsh.client.platform = web`）。

## 验证

`npm run verify` = 语法 + 3 道静态门禁 + 123 项自证测试（digest 的确定性/有界性、各条拒绝路径、结果回注、血缘持久化与命名规则、工具的授权边界）。

真 harness 的行为层 E2E 台在 [`tests/e2e/`](tests/e2e/README.md)：它需要一个 **dsh 源码检出**（官方 mock LLM 不在 npm 闭包里），所以不进 `npm run verify`。改这个插件的内部机制与踩坑记录见[工程笔记](docs/engineering-notes.md)。

## 插件管理

已装插件可以用 plugin-registry 的**薄控制台**（浏览器面板）管理 profile 插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置：

```sh
dsh plugin --profile web add https://github.com/vlln/plugin-registry.git#path:/packages/plugin/console
```

## 许可

MIT
