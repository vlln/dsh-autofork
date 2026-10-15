# 扁平模式的 head 必须声明 `parentSession`

分类：fix / session-format

## Problem

用户 2026-10 实测报的：

```
历史加载失败：stored session "session-7dcb49e6-…" is corrupt: session "session-7dcb49e6-…":
stored log is corrupt: SessionFormatError: current-generation delivery marker names the
wrong Session (raw log: /Users/vlln/.dsh/sessions/--…--/session-7dcb49e6-…/session.v4.jsonl.zstd)
```

**这条会话是本插件自己分叉出来的**，写的时候一切正常（界面能跑、模型能答），**从盘上再读就炸**。

根因在 harness 的当代格式校验器里（`@deepseek-ai/dsh-session-persistence-jsonl` 的
`validateStoredEvents`，逐字复述）：

```js
case 'session-log-deepseek/delivery-accepted':
  if ((data.sessionFormatVersion ?? 0) === header.version
      && !(header.parentSession !== undefined && event.seq < inheritedEventCount)
      && data.sessionId !== header.id) throw new SessionFormatError('current-generation delivery marker names the wrong Session')
```

`dsh-session-log-deepseek` 在**每一轮官方 API 2xx 之后**往会话日志追加一条
`delivery-accepted`，`data.sessionId` 是**这条会话**的 id。而 seed 是父会话已完成前缀的
**逐字拷贝**（官方 `buildForkSeed` 也是逐字拷贝）⇒ 继承前缀里那些标记记的是**父会话**的 id。
校验器只在两种情形放行异会话标记：① `header.parentSession` 存在**且**标记落在继承前缀内；
② 标记记的就是本会话。

而扁平模式（默认）当时**故意不写 `parentSession`**（见下"当时的理由"）⇒ 情形 ① 永不成立 ⇒
**一条写进去就再也读不出来的日志**：写入端不报错（活会话在内存里），下次从盘上重新打开
必炸。触发条件是"父会话用过官方 API"——所以用户的 11 条分叉里恰好 3 条中招（其余家族的父会话
走的是 pi-ai / flowhub 路由，日志里没有这种标记）。

## Decision

**`spawnHead` 的 `meta` 两种模式都写 `parentSession: session.id`**，`origin:'subagent'` 只在
容器模式写。

判据是**与官方逐字同形**：官方普通分叉（`@deepseek-ai/dsh-api-session-controller` 的 `fork()`）
写的就是 `meta: { parentSession: source.header.id, isSeeded: true }`——**没有 `origin`**。
本插件扁平模式的 head 现在与它完全一致。

## Alternatives considered

- **过滤掉 seed 里的 `delivery-accepted` 事件**：技术要求 seed 是源前缀的**逐字**拷贝
  （官方 `buildForkSeed` 如此，且 seq 稠密、继承边界要精确），过滤会重排 seq、让"忠实前缀"
  这条前提失效。
- **把异会话标记的 `sessionId` 改写成子会话 id**：那会让 `dsh-session-log-deepseek` 的水位
  折叠**误以为**继承前缀已经以子会话的名义上传过（README 明说"fork 会话会忽略从父会话继承的
  水位"），于是服务端那条会话的日志会缺掉整段继承上下文——用一个功能的静默损坏换另一个。
- **不写 seed**：分叉的全部价值就在"带着已完成前缀过去"（用户笔记：继承当前 session 的所有
  状态和模型上下文，只有正在进行的最后一步不继承）。
- **标 `origin:'subagent'`**（官方另一条路）：那正是用户 2026-09 否掉的层级模型，也实测会让
  用户"钻进一个子代理"、顶层容器仍是旧会话。

## Consequences

- **写盘形状变了**：分叉会话的 header 多一个 `parentSession`。这**只影响新分叉**；
  盘上已损坏的旧日志不会自愈（用户 2026-10 决定**不动历史文件**，只修插件）。
- `parentSession` 也让这些 head 落进 `ordinaryFork()`（即"官方普通分叉"的判据）——
  于是它们同时出现在 `nativeEdges` 里，与插件自己的内存记录/血缘边**重复一份**。
  可观察后果为零：`edgeOf` 的优先级是 `recordByHead → lineage → nativeEdges`，
  `headsOf` 按 id 去重，health 的 `marks` 显式过滤掉已知 id，`takeOver` 用
  `recordByHead.has(child) || lineage?.edgeOf(child)` 先一步拒掉自己的 head。
  **残留一点**：血缘域不可用（降级成"只有内存"）时重启一次，这些 head 会以"官方分叉"
  的身份出现在树里（语义正确），并带上一个点下去只会 503 的「接手原会话」按钮。
  那条降级路径本来就丢血缘，不值得为它加第二套身份标记。
- `isInstanceSession()` 的第 2 条判据（`parentSession !== undefined`）现在也会命中扁平模式的
  head。**它只在容器模式下被问到**（两处调用都在 `containerMode === true` 分支里），而那时
  "head 是父会话的子会话"本来就是事实 ⇒ 行为自洽：容器模式下这类会话不再充当容器。
- 页签 / 工具面 / 存储格式 / health 契约都没变。

## 验证

1. **用 harness 自己的校验器判死**：`session-persistence-jsonl` 的 worker 入口
   （`{path, compression:'zstd', expectedId, expectedEventCount}`）指向用户的 7dcb49e6 日志
   ⇒ `current-generation delivery marker names the wrong Session`；把那条日志拷一份、**只在
   header 里补 `parentSession`**（其余帧逐字节不动）⇒ 同一个校验器返回 OK。
2. **对照**：盘上另一条**官方**分叉（`session-cb4fe0ff`，`parentSession` 有、`origin` 无）
   同一校验器 OK；用户 11 条插件的分叉里，继承前缀**不含**异会话标记的那些（走非官方
   provider 的家族）也都 OK——与根因判据一致。
3. **回归钉**：`tests/autofork.test.mjs` 的「seed 里带着父会话的 delivery 标记时，head 必须
   声明 `parentSession`」把上面那段校验器规则**原样钉在插件自己的输出上**（含"标记必须落在
   继承前缀内"这个前提），另加扁平分叉/容器模式两条形状断言。