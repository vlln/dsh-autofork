# 设置卡在"命名空间不可用"时必须留下可见线索

分类：fix / ui

## Problem

用户 2026-10 报的第二件事：**Plugins 页里 autofork 的设置选项不见了**（插件是装着的）。

追到的链路是确定的：卡片渲染出空白的**唯一**条件是
`configForms.get('dsh-autofork')` 的快照 `status === 'unavailable'`，而 `ui-settings` 的
`ConfigFormController.derive()` 只在一种情形置这一态：

```js
const view = mirrored.view.namespaces.find(candidate => candidate.ns === this.spec.namespace)
if (view === undefined) { draft.status = 'unavailable'; return }
```

即**宿主设置文档里没有 `dsh-autofork` 这个命名空间**（命名空间 = Loader 条目 id，
`settings.describe()` 只列"fiber 活着 + Config 有 volatile 叶子"的条目）。
这一态在**运行中被装/卸/更新插件**之后是正常的中间状态（宿主半边可能仍是旧进程里的那一份），
而卡片原来的写法是 `return null`：

```js
if (state === null || state === undefined || state.status === 'unavailable') return null
```

于是用户看到的是"设置没了"——**原因与恢复办法一起被藏掉**，只剩空白页。

## Decision

只把**已定态**的 `unavailable` 从"整块不渲染"改成**渲染一行可读的说明**（标题 + 一句
"读不到宿主提供的 dsh-autofork 配置项 … 重启 dsh 后恢复"），并挂稳定排障锚
`data-dsh-autofork-settings-missing`；`summary` 视图在这一态返回字符串 `设置不可用`
（键控槽的摘要位要的是字符串，不能是元素）。

`null` / `undefined`（mirror 还没到）**仍然不渲染**——否则刷新页面时会先闪一行错误。

## Alternatives considered

- **整块不出现（原行为）**：那正是用户误判成"设置被删了"的成因；插件的可用性承诺是
  "设置缺席时插件其它功能照常"，而**空白不等于可读的缺席**。
- **用官方 `whileServed([...])` 注册**：命名空间不被服务时整条注册撤销，症状比现在更隐蔽
  （连卡片位置都没有），且要用它就得放弃"卡片只出现在本插件自己的包页上"这条更简单的形状。
- **在卡片里放一个"重试"按钮**：设置文档自带订阅与自动重载（mirror 变化会重新 `derive()`），
  不需要人手点；加按钮等于把宿主的刷新职责搬进插件。
- **把这一态也报到 health 的 note 通道**：note 只在有 debug 日志时可见（默认关），
  对"用户打不开设置"这件事没有帮助。

## Consequences

- 命名空间不可用时，Plugins 页面上会出现一行（而不是空白）：用户至少知道
  **哪一项设置**读不到、以及**重启 dsh** 是恢复动作。
- 这一态**不是**报错：`role="status"`（不是 `alert`），样式与卡片同语言，不引入红色错误态——
  宿主在运行中被装/卸插件是正常操作，不是故障。
- 只改了客户端 half 的渲染分支：设置写入路径、命名空间、槽 key、`inject` 面都没动。
- **验证边界**：服务端与单测能钉住"这一态渲染出什么"（`tests/client-fork.test.mjs` 用
  React 桩断言标题 / 说明 / 排障锚 / summary 字符串 / 不出现"自动分叉"选项）；
  **"真实浏览器里那一行画在哪、可不可读"仍然只能人眼验**（同"卡片是否真的注册进槽"那条边界）。