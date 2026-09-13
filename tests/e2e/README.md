# 行为层 E2E（真 harness，不需要模型凭据）

这一层回答的是"**它真的按设计跑起来了吗**"——单元测试与门禁都答不了。它用官方
`llm-mock-server` 当模型，用 `dsh --profile sdk` 的 stdio JSON-RPC 当驱动面，在**真实 harness**
上跑完整场景，然后从**落盘的会话日志**里读证据。

## 前置条件

| 需要 | 说明 |
|---|---|
| `dsh` CLI | `dsh --version` 能跑；脚本用的是 `dsh --profile sdk` |
| **一个已装好本插件的隔离 home** | `DSH_HOME=<隔离目录> dsh plugin --profile sdk add <本仓库>`。**不要用共享 `~/.dsh`**：E2E 会在里面建会话、清目录 |
| 官方 mock LLM 模块 | 它在 dsh **源码**里（`packages/test-support/llm-mock-server`），**不在 npm 闭包里**，所以要用 `DSH_MOCK_LLM_SERVER` 指路（见下） |

```sh
export DSH_HOME=/tmp/dsh-autofork-e2e-home          # 隔离 home（先按上面那行装好插件）
export DSH_MOCK_LLM_SERVER=/path/to/deepseek-harness/packages/test-support/llm-mock-server/lib/index.js
```

`DSH_MOCK_LLM_SERVER` 不设时脚本会先试裸模块名 `@deepseek-ai/dsh-llm-mock-server`，都不行就报一条
可操作的错。**换句话说：这一层需要一个 dsh 源码检出**——这是"行为层证据能复现"的代价，
也是它没有做成 `npm test` 的一部分的原因（`npm run verify` 与 CI 都不需要它）。

`npm run check:e2e` 只做这一层脚本的**语法**检查（不需要上面的前置条件）；场景本身一律手工跑。

## 复跑：会话清理已经自动化

E2E 用**固定的 session id**（否则没法对照），于是"上一次跑剩下的日志"会让下一次跑**无声地**失败：

| 残留 | 症状 | 看起来像 |
|---|---|---|
| 同 id、不同生命周期的日志 | `session "…" already has a persisted log on disk that does not match this live session (id collision)` | "插件坏了"——第二条 prompt 永不触发分叉 |
| 上次被 kill、留着**没 `turn/end`** 的 turn | 那条会话在新进程里 prompt 起不来新 turn | 同上 |
| **旧 mock 还在监听**（序列已被消费） | 第一条请求拿到 `success` 而不是 `stall` ⇒ 父会话不忙 | 同上 |

第二类残留 `mock-server.mjs` 会**显式报错**（`EADDRINUSE` + 提示 `pkill -f mock-server.mjs`），
`drive.mjs` 也会在第二条指令之前自检"父会话还在忙吗"，不忙就打印一行 `mock-not-stalling`
说明原因——**mock 必须每次新起**，序列是有状态的，别图省事复用。

所以 `drive.mjs` 与 `verify-lineage.mjs phase1` 会在**起 dsh 之前**自己删掉这条会话
（`session-dir.mjs` 的 `cleanSession()`）——**不需要手工清目录**，而且每次都是全新会话而不是 resume。
`phase2` 恰恰要续上 `phase1` 留下的会话，所以它**不清**（这是设计，不是遗漏）。

> 目录名编码照抄官方 `projectKey`（分隔符压成一个 `-`、不安全字符 `~XXXX`、两端 `--`：
> `/tmp/dsh-autofork-e2e-work` → `--tmp-dsh-autofork-e2e-work--`）。`session-dir.mjs` 是唯一实现，
> `tests/e2e-session-dir.test.mjs` 把它钉在**盘上真实观测到的目录名**上——这段编码写错时的
> 失败消息完全指向别处（清目录静默失效 ⇒ id collision），值得一个单测。

## 三个场景

### ① 主场景：忙时分叉（`drive.mjs`）

```sh
# 终端 1：mock（序列 stall,success —— 第 1 个请求挂住旧会话的 step，第 2 个给新会话正常回复）
MOCK_PORT=8123 MOCK_SEQUENCE=stall,success node tests/e2e/mock-server.mjs
# 终端 2
node tests/e2e/drive.mjs
```

驱动面：发第一条指令 → 等 16s（在飞 step 变老）→ 发第二条 → 观察 75s。**判据**（脚本自己打印）：

```
forkDetected / digestInjected / noticeInjected / instructionDelivered 四项全 true
turnErrors 为空；两次 prompt 的返回都不带 error
```

同时落盘侧可直接核对（`$DSH_HOME/sessions/<cwd 编码>/…`）：
新会话是**普通顶层会话**（header 无 `origin`/`parentSession`，日志无 `subagent/*`），
里面依次是 `[自动分叉通知]`、`[兄弟分叉在飞进度]`、用户原话、然后才是它的回复。

### ② 血缘跨进程 + 工具输出 schema（`verify-lineage.mjs`，两阶段）

```sh
# 阶段 1：真分叉一次；head 的第一轮会调 fork_list（mock 第 2 个槽给它）
MOCK_PORT=8123 MOCK_SEQUENCE=stall,tool_call_success,success \
  MOCK_TOOL_NAME=fork_list MOCK_TOOL_ARGS='{}' node tests/e2e/mock-server.mjs &
node tests/e2e/verify-lineage.mjs phase1        # 写出 /tmp/autofork-verify-head.txt
# 阶段 2：**全新进程**。它起的是 `dsh web`（生产 profile），不打模型
node tests/e2e/verify-lineage.mjs phase2 /tmp/autofork-verify-head.txt
```

**它证明两件单元测试证不了的事**：

① **血缘真的落了盘、而且新进程读得回来**。阶段 1 产出
`<DSH_HOME>/storages/autofork_lineage/edges/<head>.json`；阶段 2 起一个全新的 `dsh web`
（自己的随机端口），`GET /api/dsh-autofork/health?sessionId=<head>` 返回**整棵树**：
根（标题由孩子的 `base` 反推）+ `⑂1 …`（`depth 1` / `parentId` / `current`）。

② **`fork_list` 的输出 schema 过得了运行时校验**。工具的 `output.schema` 是封闭形状
（`additionalProperties:false`）且逐条校验（`createToolResult` → `ToolOutputError`），
侧漏一个字段就炸——而单测直接调依赖，**看不见这一层**。阶段 1 打印的 `toolTexts` 就是
真实渲染结果（`↑ 我接管的` 这类关系标记必须出现）。

> ⚠️ **阶段 2 为什么用 web 而不是再 prompt 一次**：`dsh 0.1.2-rc.1` 的 sdk 服务器建会话走
> `agents.create({sessionId, meta})`，**不带 seed**，于是持久化层在 `adoptLivePrefix` 里做
> `seedCoversPrefix([], 已落盘事件)` → 假 ⇒ turn 以 `error` 收尾：
>
> ```
> Error: session "…" already has a persisted log on disk that does not match this live session (id collision)
> ```
>
> 这**与本插件无关**——一条不装插件的普通会话跨进程 prompt 同样如此（已最小复现）。
> 所以"重启后关系还在吗"这个问题，在 headless 里只能靠**新的 web 实例 + 健康探针**回答，
> 而那恰好就是用户真实的重启场景。

### ③ 悬空工具调用两臂对照（`e2e-dangling.sh`）

```sh
bash tests/e2e/e2e-dangling.sh
```

复现并守住那个最危险的事故：会话里已经发出 `tool_call`、结果还没落盘时，插件若把镜像**直接
append**，就会把 `assistant(tool_calls)` 与它的 `tool/result` 拆开 —— 真实 provider 会因此 400
`INVALID_REQUEST`，而且**写坏是永久的**（surface 追加有序）。

- **safe 臂**（默认投递方式）：镜像改走 `inject()` 延到下一个 step 起点 ⇒ 落点排在 `tool/result` **之后**；
- **immediate 臂**（对照）：落点夹在 `tool_call` 与 `tool/result` **之间**，即事故现场。

它需要 `slow-tool-plugin/`（一个在**进程内** sleep 的 `slow_wait` 工具——headless 下 `bash` 被沙箱
拒绝并瞬间返回，造不出那段窗口）：脚本会自动把它装进 sdk profile。

⚠️ mock **不校验**消息顺序，所以这脚本复现的是"**顺序被写坏**"这个事实本身；
把它变成 400 的是真实 provider。两臂都断言 `mirrorAfterToolResult` 与 `turnEndReason`。

## 这一层验不到什么

- **浏览器里才暴露的**：焦点是否真的切到了新会话、「分叉」页签是否真的出现在 tab 栏、
  点击是否真的跳转、注入行是否真的折叠成一行。服务端只能验到"bundle 200 + 事件形状"。
- **模型质量**：全程用 mock，检查的是**控制流**，不是回答得好不好。
- **headless 里续不上一条已落盘的会话**（`dsh 0.1.2-rc.1` 的 sdk profile 的既有行为，与本插件
  无关，见场景 ② 的 ⚠️）。所以"重启后再 prompt 同一条会话"这条路径在这台子上**验不了**——
  能验的是"重启后关系还在"（web 探针）。
