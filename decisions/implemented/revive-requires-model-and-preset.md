# 恢复一条会话必须带模型选择与 preset 组合，不能裸 `resume`

分类：fix / agent-lifecycle

## Problem

用户 2026-10 实测报的（原话）：

> A分叉出B，A的turn完成后回注到B，但用户打开B发现对话内容全空，仅有最上方的「加载更多」按钮
> 和最下方的输入框。

B 是 2026-10-20 由本插件分叉出来的会话（标题「排查小米遥控器按键失灵」）。它的日志**并不空**：
1.2 万条事件、177 条 `user/message`、1756 条 `assistant/message`，尾部一页就有 87 条可渲染消息。

落盘证据（B 的日志，每次 A 跑完回注都重复一遍）：

```
turn/start (turn 39) → step/start → step/end → turn/end {kind:'error'}
  "prompt variable \"{{model}}\" has no value for this assembly
   (section \"deployment:persona-prefix\")"
```

**没有 `user/message`**：回注的消息进 inbox 后，turn 开了、step 也"跑"了，但**模型请求根本没发出去**，
所以那条消息永远没有落到转写上。turn 39、40、41、42 全是这个形状。

## Root cause

A 跑完时 B 可能**不在本进程**（重启过、或只是没被打开）。插件的 `reviveAgent()` 于是调：

```js
await ctx.agents.resume({ resumeSessionId: sessionId })   // ← 裸恢复
```

而官方界面打开一条旧会话走的是 `session-controller` 的 `resumeObserved()`：

```js
const composition = await this.composeAgent(this.presetForObservation(observation))
await this.ctx.agents.resume({
  resumeSessionId,
  agentOptions: this.agentOptions(),      // 部署的 {provider, model}
  setup: composition.setup,               // presets.mount(agentCtx, resolvedId)
})
```

少了 `agentOptions`，`Agent.options` 就是 `{}`；而 `@deepseek-ai/dsh-agent-loop` 注册的 prompt
变量正是 `ctx.systemPrompt.variable('model', context => context.agent?.options.model)` ⇒
取值 undefined ⇒ `dsh-system-prompt` 的插值器抛
`prompt variable "{{model}}" has no value …`（persona 段的模板里有 `{{model}}`）。

少了 `setup`，agent **一套 preset 都没挂**（工具表、prompt 段、per-agent 的 UI 贡献全缺席）。

**第二个症状**（打开 B 全空）与第一条同源。隔离实例里复现（`dsh web` + 无头 Chrome，同一份
落盘日志）：

| 打开方式 | `[data-chat-flow]` 子节点 |
|---|---|
| 冷打开（客户端按官方组合恢复） | **139**（内容完整） |
| 先裸 `resume({resumeSessionId})`，再打开 | **2**（空转写 + 「加载更早」） |

也就是说：这条被裸恢复的 agent 一旦活下来，客户端再打开它时只拿到空转写——正是用户看到的画面。

## Decision

`reviveAgent()` 按官方同一套组合恢复：

```js
const selection = currentSelection()            // ctx.agentDefaultModel.currentSelection()
await ctx.agents.resume({
  resumeSessionId,
  ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
  setup: composeForResume,                      // 解析会话的 preset 并 mount
})
```

`composeForResume(agentCtx, agent)` 与官方 `composeAgent()` 同形：

```js
const recorded = ctx.sessionProjections.stateOf(agent.session, 'agentPreset')  // 可能 undefined
const resolved = await presets.resolve(recorded)      // undefined ⇒ 部署默认
await presets.mount(agentCtx, resolved.id)
```

**同时**让 `spawnHead` 把 worker 当时的 preset 记进 head 的 header
（`meta.agentPreset`，官方 `fork()` 一直这么写）：否则恢复侧只能靠 `agent-preset/selected`
投影，分叉会话通常没有它 ⇒ 退回部署默认，preset 可能与分叉当时不同。

## 回归钉

`tests/autofork.test.mjs`：

- 「fork_send 对**不在本进程**的家族成员」现在断言恢复参数里 **有** `agentOptions` 与 `setup`，
  并断言 `setup` 真的 `resolve` + `mount` 了 preset（桩会 await `setup`，与真实工厂一致）。
- 「恢复失败」那条同样钉住参数形状（不能退回裸 resume）。
- 「分叉把 worker 的 preset 记进 head 的 header」：有 preset 时写、读不到时不凭空写。

## 教训

**"同一个 API 入口"不等于"同一条路"。** 0.10.0 引入恢复时写了句"与界面打开旧会话走的是同一条路"
——入口确实是同一个 `agents.resume`，但官方在那之前还做了 `composeAgent()` 和模型选择。
判断"官方怎么用某个 API"要读**调用方**，不能只读该 API 的文档注释。
