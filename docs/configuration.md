# 配置参考

日常使用在 Plugins 页选择自动或手动分叉即可。以下参数供高级配置参考；未提供者使用默认值。

## 参数

| 参数 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭后完全退回 steer/queue |
| `forkMode` | `'auto'` | 分叉方式：`'auto'` 忙时立即分叉；`'manual'` 指令先入队、点队列行上的「分叉」才分叉。在 Plugins 页切换 |
| `minStepAgeMs` | `0` | 分叉门槛：step 已运行**低于**此时长则不分叉。**默认 0 = 只要忙就分叉**（保守部署可调大） |
| `coalesceWindowMs` | `2000` | 距下一个 step 边界不足此时长时降级为 steer（合并窗口） |
| `forkableSourceKinds` | `['user']` | 只对这些 `message.source.kind` 触发分叉 |
| `maxActiveBranches` | `3` | 同一前台下的活跃后台分叉上限；超出强制 steer |
| `harvestAfterMs` | `600000` | 已回注分叉多久后视为已收割并移出计数 |
| `digestMaxChars` | `8000` | in-flight digest 整体字符上限 |
| `digestAssistantChars` | `600` | 单条助手文本截断长度 |
| `digestToolArgsChars` | `300` | 单条工具调用参数截断长度 |
| `digestToolResultChars` | `400` | 单条工具结果截断长度 |
| `digestMaxEvents` | `200` | digest 最多渲染事件数（**自尾部**保留最近的；丢弃量在正文最前面标注） |
| `reInjectOnTurnEnd` | `true` | 后台 turn 结束后是否把结果投给接手会话并唤醒它；仍受发送方的自动回注开关控制 |
| `reInjectMaxChars` | `4000` | 回注内容字符上限 |
| `containerMode` | `false` | **容器模式（实验，默认关）**：容器不跑 turn、消息交给绑定实例、答复写成一等回复。**不要打开**：容器**不可能**完全不跑 turn，这条模式会与实例重复劳动 |
| `rebindNotice` | `true` | 容器模式下首次绑定 / 重绑 driver 时，在容器里插一行折叠通知 |
| `followHead` | `true` | **是否把焦点切到新分叉**。默认 true = 立刻在跟一条空闲 agent 说话（「打破同步交互」的前提）；`false` 留作对照：只看产出、视图不移动 |
| `instanceLabel` | `'分叉'` | 实例在会话头部实例树里的显示名 |
| `titleMark` | `'⑂'` | 分叉徽标的标记字形；序号按家族计数，不写入新会话标题。启用时沿用家族根名并钉住标题（不再自动命名）；空串关闭分叉命名及侧栏徽标 |
| `instanceProvider` | `'fork'` | 写进子会话 `subagent/descriptor` 的 `provider`（只用于冷恢复反查后端） |
| `mirrorInstanceReply` | `false` | 是否把实例的回复**反向**追加进容器日志。默认关：方向错了（笔记定的是"旧会话的结果注入回新会话"），那是 `reInjectOnTurnEnd` 干的 |
| `mirrorDelivery` | `'safe'` | 实例回复的投递方式：`'safe'` 避开悬空 `tool_calls`（必要时延到下一个 step 起点）；`'immediate'` 直接 append（**已知会写坏容器转写**，仅作对照） |
| `noticeSummaries` | `true` | 注入消息是否声明 `form:'notice'`——客户端把它**折叠成一行摘要**（可展开），不折叠则整块显示 |
| `exposeDispatchTools` | `true` | 是否向前台暴露 `fork_list` / `fork_send` / `fork_cancel` |
| `forkSendBlockTimeoutMs` | `600000` | `fork_send(block:true)` 最多等对方多久（毫秒）。超时不是失败：消息已投递，结果文本会说明"还没回"，让调用方改用 `fork_list` 看进展 |
| `debugLogPath` | `''` | 决策日志路径（逐行 JSON）；空表示关闭，可用环境变量 `DSH_AUTOFORK_DEBUG` 兜底 |


## 官方分叉与接管

官方普通分叉默认只进入家族树，不自动转交指令、回注或计入后台上限。在直接子会话卡上确认「接手原会话」后，才保存接管选择；每个原会话同时只有一个接手目标，切换目标不会删除其他分支。

接管不复制分叉后的全部历史，不中止原任务，也不重置原会话的自动回注开关。旧版本只保存了分叉关系、没有接管选择的数据，不按“最新后代”推断接手目标。

同一棵展示树可以显式通信；取消权限与后台计数仍按 autofork／已确认接管关系判断，不因加入展示树自动扩大。

## 环境变量与诊断

环境变量优先级低于插件配置。

```sh
DSH_AUTOFORK_PARAMS='{"minStepAgeMs":2000}' dsh web
DSH_AUTOFORK_DEBUG=/tmp/dsh-autofork-debug.log dsh web
```

`GET /api/dsh-autofork/health` 可检查挂载情况和插件状态。分享日志前请移除敏感指令与路径。

实现与验证说明见[工程笔记](engineering-notes.md)。
