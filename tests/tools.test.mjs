/**
 * 分叉调度工具的自证测试：门禁是**授权边界**——只能操作自己家族里的会话。
 *
 * defineTool 由测试注入桩，所以本文件不需要解析任何 `@deepseek-ai/*` 包。
 *
 * 方向（2026-09 修正）：head 是**拥有者**，它管理的是自己**接管的**会话（upstream）
 * 与**接管了自己的**会话（downstream）。第一版读成"父拥有子"，导致 head 调
 * `fork_list` 返回空（用户实测踩到）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBranchTools, renderRelated, renderResult } from '../src/tools.mjs'

/** 捕获 spec 的 defineTool 桩：原样返回 spec，便于直接调用 execute。 */
const captureDefineTool = (spec) => spec

const UPSTREAM = 'session-upstream-a'
const DOWNSTREAM = 'session-downstream-c'

/**
 * 造一组带调用记录的依赖桩。
 * @param {object} [overrides] 覆盖默认实现。
 * @returns {any} 工具数组 + 调用记录。
 */
function harness(overrides = {}) {
  const calls = { related: [], steer: [], cancel: [] }
  const tools = createBranchTools({
    defineTool: captureDefineTool,
    related: (caller) => {
      calls.related.push(caller)
      return overrides.relatedResult ?? [
        { sessionId: UPSTREAM, relation: 'upstream', state: 'running', busy: true },
        { sessionId: DOWNSTREAM, relation: 'downstream', state: 'finished', busy: false },
      ]
    },
    steer: (caller, targetId, text) => {
      calls.steer.push({ caller, targetId, text })
      return { ok: true, detail: `已向 ${targetId} 发送指令` }
    },
    cancel: (caller, targetId, keepInbox) => {
      calls.cancel.push({ caller, targetId, keepInbox })
      return { ok: true, detail: `已中止 ${targetId}（keepInbox=${String(keepInbox)}）` }
    },
  })
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
  return { byName, calls, tools }
}

/** 一个带 agent 的 exec 桩。 */
const execWith = (agentId) => ({ agent: { id: agentId }, signal: new AbortController().signal })

/* ------------------------------ 形状 ------------------------------ */

test('注册三个工具且名字不变（用户要求不改名）', () => {
  const { tools } = harness()
  assert.deepEqual(tools.map(tool => tool.name), ['fork_list', 'fork_steer', 'fork_cancel'])
})

test('每个工具都有 output.schema 与 render，且 description 足够长', () => {
  for (const tool of harness().tools) {
    assert.ok(tool.output?.schema, `${tool.name} 缺 output.schema`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺 output.render`)
    assert.ok(tool.description.length > 30, `${tool.name} 的 description 太短`)
  }
})

test('家族项的 schema 与视图字段一致，relation 允许三个方向', () => {
  const item = harness().byName.fork_list.output.schema.properties.related.items
  // ⚠️ **封闭形状**：`memberView` 的每个字段都必须在这里声明，`title` 曾经漏过——
  // 那会让 fork_list 在**运行时**抛 ToolOutputError（单测看不见，因为单测直接调依赖）。
  assert.deepEqual(Object.keys(item.properties).sort(),
    ['busy', 'relation', 'sessionId', 'state', 'title'])
  assert.deepEqual(item.properties.relation.enum, ['upstream', 'downstream', 'sibling'])
  assert.equal(item.properties.title.type, 'string', 'title 用空串表示"没有名字"，不用 string|null')
})

/* ------------------------------ 授权边界 ------------------------------ */

test('无 agent 上下文时三个工具都拒绝或返回空，且不触碰依赖', async () => {
  const { byName, calls } = harness()
  const noAgent = { signal: new AbortController().signal }

  assert.deepEqual(await byName.fork_list.execute({}, noAgent), { related: [] })
  const steered = await byName.fork_steer.execute({ sessionId: UPSTREAM, text: 'x' }, noAgent)
  const cancelled = await byName.fork_cancel.execute({ sessionId: UPSTREAM }, noAgent)

  assert.equal(steered.ok, false)
  assert.equal(cancelled.ok, false)
  assert.deepEqual(calls, { related: [], steer: [], cancel: [] }, '拒绝路径不得调用依赖')
})

test('调用者 id 被原样传给依赖（授权过滤在依赖侧按它执行）', async () => {
  const { byName, calls } = harness()
  await byName.fork_list.execute({}, execWith('session-me'))
  await byName.fork_steer.execute({ sessionId: UPSTREAM, text: '改方向' }, execWith('session-me'))
  await byName.fork_cancel.execute({ sessionId: UPSTREAM }, execWith('session-me'))

  assert.deepEqual(calls.related, ['session-me'])
  assert.deepEqual(calls.steer, [{ caller: 'session-me', targetId: UPSTREAM, text: '改方向' }])
  assert.deepEqual(calls.cancel, [{ caller: 'session-me', targetId: UPSTREAM, keepInbox: false }])
})

/* ------------------------------ 参数语义 ------------------------------ */

test('fork_cancel 的 keepInbox 缺省为 false，显式 true 才透传', async () => {
  const { byName, calls } = harness()
  await byName.fork_cancel.execute({ sessionId: UPSTREAM }, execWith('me'))
  await byName.fork_cancel.execute({ sessionId: UPSTREAM, keepInbox: true }, execWith('me'))
  await byName.fork_cancel.execute({ sessionId: UPSTREAM, keepInbox: 'yes' }, execWith('me'))

  assert.deepEqual(calls.cancel.map(c => c.keepInbox), [false, true, false],
    'keepInbox 必须是严格的 true，非布尔真值不得透传')
})

test('参数收敛：缺失/null 变空串，非字符串走 String()', async () => {
  const { byName, calls } = harness()
  await byName.fork_steer.execute({}, execWith('me'))
  await byName.fork_steer.execute({ sessionId: 42, text: null }, execWith('me'))

  assert.deepEqual(calls.steer, [
    { caller: 'me', targetId: '', text: '' },
    { caller: 'me', targetId: '42', text: '' },
  ])
})

test('null/undefined 不得变成字面量 "null"/"undefined"', async () => {
  const { byName, calls } = harness()
  await byName.fork_steer.execute({ sessionId: undefined, text: undefined }, execWith('me'))
  const sent = calls.steer.at(-1)
  assert.equal(sent.targetId, '')
  assert.equal(sent.text, '')
})

/* ------------------------------ 渲染 ------------------------------ */

test('renderRelated 空家族给明确文本，非空逐行带方向箭头', () => {
  assert.match(renderRelated({}, { related: [] })[0].text, /没有其它会话/)
  const text = renderRelated({}, {
    related: [
      { sessionId: UPSTREAM, relation: 'upstream', state: 'running', busy: true },
      { sessionId: DOWNSTREAM, relation: 'downstream', state: 'finished', busy: false },
    ],
  })[0].text
  assert.match(text, /↑ 我接管的/)
  assert.match(text, /↓ 接管了我的/)
  assert.match(text, new RegExp(UPSTREAM))
  assert.match(text, new RegExp(DOWNSTREAM))
  assert.match(text, /运行中/)
  assert.match(text, /已结束/)
  // **不许**再把两个含义不同的字段并排打出来（曾出现 `[running] 已停` 这种自相矛盾的行）。
  assert.equal(text.includes('已停'), false, `不得出现"已停"这种与 state 冲突的措辞：${text}`)
  assert.equal(text.includes('['), false, `不得再渲染裸枚举：${text}`)
})

test('renderRelated 对畸形输入不抛错', () => {
  assert.equal(typeof renderRelated({}, {}).at(0).text, 'string')
  assert.equal(typeof renderRelated({}, undefined).at(0).text, 'string')
})

test('renderResult 透传 detail', () => {
  assert.equal(renderResult({}, { ok: true, detail: 'done' })[0].text, 'done')
  assert.equal(typeof renderResult({}, undefined)[0].text, 'string')
})

test('渲染输出是单块 text 内容，形状符合 ContentBlock', () => {
  for (const blocks of [
    renderRelated({}, { related: [] }),
    renderResult({}, { ok: true, detail: 'x' }),
  ]) {
    assert.ok(Array.isArray(blocks) && blocks.length === 1)
    assert.equal(blocks[0].type, 'text')
    assert.equal(typeof blocks[0].text, 'string')
  }
})

test('家族状态三态互斥：活着但空闲显示"空闲"，不得与"运行中"同时出现', () => {
  const text = renderRelated({}, {
    related: [
      { sessionId: 'session-a', relation: 'upstream', state: 'running', busy: true },
      { sessionId: 'session-b', relation: 'upstream', state: 'idle', busy: false },
      { sessionId: 'session-c', relation: 'upstream', state: 'finished', busy: false },
    ],
  })[0].text
  const rows = text.split('\n')
  assert.equal(rows.length, 3)
  assert.match(rows[0], /运行中/)
  assert.match(rows[1], /空闲/)
  assert.match(rows[2], /已结束/)
  // 用户实测报的歧义：同一行同时出现"运行"与"停"——现在每行只有一个标签。
  for (const row of rows) {
    assert.equal(/已停/.test(row), false, row)
  }
})
