/**
 * digest / params 的自证测试：门禁核心是「确定性」与「有界性」两条不变量。
 *
 * 跑法：node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  truncate, oneline, partText, safeJson, renderEventLines, assembleWithinBudget,
  renderForkNotice, renderInFlightDigest, renderWorkerReply, renderBranchHint, activeTargets,
  boundSummary, CONTEXT_SUMMARY_MAX_CHARS, shortSessionId, instanceReplySummary, renderInstanceReply,
  renderSteerReply,
} from '../src/digest.mjs'
import { DEFAULT_PARAMS, resolveParams, describeParams } from '../src/params.mjs'

/* ------------------------------ 事件夹具 ------------------------------ */

/** 一个两 step 的在飞 turn：用户指令 → 助手调工具 → 工具结果 → 助手再调。 */
const IN_FLIGHT = [
  { seq: 0, type: 'turn/start', data: { turn: 3 } },
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '把 config 的 revision 加一' }], source: { kind: 'user' } } },
  { seq: 2, type: 'step/start', data: { turn: 3, step: 1 } },
  { seq: 3, type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [
    { type: 'reasoning', text: '先读文件' },
    { type: 'text', text: '我来看一下 config.json' },
    { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"config.json"}' },
  ] } } },
  { seq: 4, type: 'tool/call', data: { turn: 3, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"config.json"}' } },
  { seq: 5, type: 'tool/result', data: { turn: 3, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: '{"revision":1}' }] } } },
  { seq: 6, type: 'step/end', data: { turn: 3, step: 1 } },
  { seq: 7, type: 'step/start', data: { turn: 3, step: 2 } },
  { seq: 8, type: 'assistant/message', data: { turn: 3, step: 2, message: { content: [
    { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"bash slow-check.sh"}' },
  ] } } },
]

/* ------------------------------ 基础工具 ------------------------------ */

test('truncate 在极限内原样返回，超出时带上丢弃量', () => {
  assert.equal(truncate('abcdef', 6), 'abcdef')
  assert.equal(truncate('abcdef', 7), 'abcdef')
  assert.equal(truncate('abcdef', 3), 'abc…(+3)')
  assert.equal(truncate('', 0), '')
  assert.equal(truncate('abc', 0), '…(+3)')
})

test('truncate 对非字符串输入不抛错', () => {
  assert.equal(truncate(undefined, 10), '')
  assert.equal(truncate(null, 10), '')
})

test('oneline 折叠换行与连续空白', () => {
  assert.equal(oneline('a\n\n b\t c '), 'a b c')
})

test('partText 认已知形状，未知形状退化为有界 JSON', () => {
  assert.equal(partText({ type: 'text', text: 'hello' }, 100), 'hello')
  assert.equal(partText({ type: 'reasoning', text: 'why' }, 100), 'why')
  assert.equal(partText({ type: 'tool-result', content: [{ type: 'text', text: 'inner' }] }, 100), 'inner')
  assert.equal(partText({ weird: 1 }, 100), '{"weird":1}')
})

test('safeJson 对循环引用退化为标记', () => {
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(safeJson(cyclic), '[unserializable]')
})

/* ------------------------------ 参数面 ------------------------------ */

test('resolveParams 补齐默认值、接受覆盖、忽略未知键', () => {
  assert.deepEqual(resolveParams(undefined), DEFAULT_PARAMS)
  const merged = resolveParams({ minStepAgeMs: 1, unknownKey: 42 })
  assert.equal(merged.minStepAgeMs, 1)
  assert.equal(merged.digestMaxChars, DEFAULT_PARAMS.digestMaxChars)
  assert.equal('unknownKey' in merged, false)
})

test('describeParams 渲染关键参数，便于排查"为什么没分叉"', () => {
  const text = describeParams(DEFAULT_PARAMS, 'auto')
  assert.match(text, /minStepAge=0ms/, '默认不设门槛：只要忙就分叉')
  assert.match(text, /maxActiveBranches=3/)
})

/* ------------------------------ 渲染 ------------------------------ */

test('renderEventLines 覆盖已知事件类型并忽略未知类型', () => {
  const { pinned, flow } = renderEventLines(
    [...IN_FLIGHT, { seq: 9, type: 'future/unknown-event', data: {} }],
    DEFAULT_PARAMS,
  )
  assert.equal(pinned.length, 2)
  assert.match(pinned[0], /turn 3 开始/)
  assert.match(pinned[1], /\[用户\] 把 config 的 revision 加一/)
  const joined = flow.join('\n')
  assert.match(joined, /\[step 1 开始\]/)
  assert.match(joined, /\[助手\] 先读文件 我来看一下 config\.json/)
  assert.match(joined, /\[调用\] read/)
  assert.match(joined, /\[结果\] \{"revision":1\}/)
  assert.match(joined, /\[调用\] bash/)
})

test('tool/result 失败态被显式标注', () => {
  const { flow } = renderEventLines([
    { seq: 0, type: 'tool/result', data: { message: { source: { callId: 'c' }, content: [{ type: 'text', text: 'boom', isError: true }] } } },
  ], DEFAULT_PARAMS)
  assert.match(flow[0], /\[结果 失败\]/)
})

test('assembleWithinBudget 保最新：流动行从最近往前保留', () => {
  const { text, omitted } = assembleWithinBudget(
    { pinned: ['PIN-A', 'PIN-B'], flow: ['F1', 'F2', 'F3', 'F4', 'F5'] },
    20,
  )
  assert.match(text, /PIN-A/, 'turn 起始行是一个 turn 的身份，永远保留')
  assert.match(text, /F5/, '最新的流动行必须在')
  assert.ok(omitted > 0, '应当报告被丢弃的行数')
  assert.ok(!text.includes('F1'), '最早的行应最先被丢弃')
})

test('assembleWithinBudget 固定行有上限：连续 steer 不得把进度挤光', () => {
  // 用户 2026-10 反馈"摘要丢掉了最重要的最新情况"。实测根因不是"从头截断"（流动行一直是
  // 从最近往前留），而是**固定行不受预算约束**：在飞 turn 里人类消息条数不设上限，
  // 20 条各 600 字符就能吃光整个预算 ⇒ 进度只剩 1 行、正文还超出预算。
  const pinned = ['--- turn 7 开始 ---', ...Array.from({ length: 20 }, (_, i) => `[用户] 第${i + 1}条指令${'填'.repeat(60)}`)]
  const flow = Array.from({ length: 30 }, (_, i) => `[进度] 第${i + 1}行${'x'.repeat(40)}`)
  const budget = 800
  const { text, omitted, droppedPinned } = assembleWithinBudget({ pinned, flow }, budget)
  assert.ok(droppedPinned > 0, '超出上限的固定行必须被丢弃（并上报）')
  assert.ok(omitted > 0, '流动行必然也被限制')
  assert.ok(text.includes('[进度] 第30行'), '最新的进度必须留下')
  assert.ok(!text.includes('第1条指令'), '丢的是更早的指令')
  assert.ok(text.length <= budget + 200, `正文必须有界（实际 ${text.length} / 预算 ${budget}）`)
  assert.match(text, /此处省略/, '省略处必须就地标注，读者才知道断在哪')
})

test('assembleWithinBudget 丢弃量与实际不符时不谎报', () => {
  const { omitted, droppedPinned } = assembleWithinBudget({ pinned: [], flow: ['x'] }, 1000)
  assert.equal(omitted, 0)
  assert.equal(droppedPinned, 0)
})

/* --------------------------- 确定性（核心） --------------------------- */

test('三个渲染面在同一输入下逐字节可复现', () => {
  const args = { events: IN_FLIGHT, params: DEFAULT_PARAMS, siblingId: 's-1' }
  const a = renderInFlightDigest(args)
  const b = renderInFlightDigest({ ...args, events: [...IN_FLIGHT] })
  assert.equal(a, b, 'in-flight digest 必须确定性')

  const n1 = renderForkNotice({ branchId: 'b-1', siblingId: 's-1', cwd: '/w' })
  const n2 = renderForkNotice({ branchId: 'b-1', siblingId: 's-1', cwd: '/w' })
  assert.equal(n1, n2, 'fork notice 必须确定性')

  const r1 = renderWorkerReply({ workerId: 'w-1', reply: '做完了 X', stepCount: 3, maxChars: 500 })
  const r2 = renderWorkerReply({ workerId: 'w-1', reply: '做完了 X', stepCount: 3, maxChars: 500 })
  assert.equal(r1, r2, 'background result 必须确定性')
})

test('渲染不含时间戳或随机成分', () => {
  const text = renderInFlightDigest({ events: IN_FLIGHT, params: DEFAULT_PARAMS, siblingId: 's-1' })
  assert.ok(!/\d{4}-\d{2}-\d{2}T/u.test(text), '不应出现 ISO 时间戳')
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/u.test(text), '不应出现随机 uuid 形态')
})

/* ------------------------------ 边界 ------------------------------ */

test('空事件与空参数面都不崩', () => {
  assert.equal(typeof renderInFlightDigest({ events: [], params: DEFAULT_PARAMS, siblingId: 's' }), 'string')
  assert.equal(typeof renderWorkerReply({ workerId: 'w', reply: '', stepCount: 0, maxChars: 100 }), 'string')
  assert.equal(typeof renderBranchHint({ headId: 'h' }), 'string')
})

test('renderForkNotice 的说话人是**兄弟会话**（它以 agent-message 投递，卡片头写着"来自会话"）', () => {
  const text = renderForkNotice({ branchId: 'session-b', siblingId: 'session-a', cwd: '/w', targets: [] })
  // 契约：这条文本以官方 `agent-message` + `form:'relay'` 投给 head，客户端渲染成 turn-trigger
  // 卡片，卡片头已经写明「来自会话 session-a」。所以正文里说话的人是**兄弟会话**：
  // 「你」= 新分叉会话（session-b），「我」= 兄弟（session-a）。
  // 写成新分叉会话自称（"我是分叉会话 session-b…"）会与卡片头自相矛盾。
  assert.match(text, /你（分叉会话 session-b）接手了用户/)
  assert.match(text, /我留在后台把没做完的那一轮跑完，结果会发给你/)
  assert.ok(!/我是分叉会话/u.test(text), '不得让新分叉会话自称——说话人是兄弟会话')
  // 降噪后的契约：卡片头/来源前缀已经写明是谁发来的，正文不再重复报会话 id
  assert.ok(!text.includes('session-a'), '正文不再重复兄弟的 id（前缀与卡片头已经给了）')
})

test('renderBranchHint 明说"用户已经切走了"（旧 agent 不该以为用户还在看它）', () => {
  const text = renderBranchHint({ headId: 'session-6a40195b-eed3' })
  assert.match(text, /用户已经切到 分叉会话 6a40195b 继续对话/)
  assert.match(text, /你还在跑的那一轮\*\*不会被中止\*\*/)
  assert.match(text, /继续当前工作，不要改变方向/)
})

test('in-flight digest 的正文受字符预算约束', () => {
  const huge = Array.from({ length: 50 }, (_, i) => ({
    seq: i,
    type: 'tool/result',
    data: { message: { source: { callId: `c${i}` }, content: [{ type: 'text', text: 'x'.repeat(5000) }] } },
  }))
  const text = renderInFlightDigest({ events: huge, params: DEFAULT_PARAMS, siblingId: 's' })
  assert.match(text, /此处省略|因 digestMaxEvents 未渲染/)
  assert.ok(text.length < DEFAULT_PARAMS.digestMaxChars * 2, '必须有界')
})

test('digestMaxEvents 生效并显式标注丢弃量', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ seq: i, type: 'step/start', data: { turn: 1, step: i + 1 } }))
  const text = renderInFlightDigest({ events: many, params: { ...DEFAULT_PARAMS, digestMaxEvents: 5 }, siblingId: 's' })
  assert.match(text, /更早的 25 个事件/)
})

/* ---------------- 注入上下文不得吃掉 digest 预算（E2E 实测教训） ---------------- */

test('注入上下文（skill 目录 / runtime context）只留紧凑标记，不进固定保留区', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真正的人类指令' }] } },
    // 一份巨大的系统注入：实测里它能把整条 digest 的预算吃光
    { seq: 2, type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'x'.repeat(20000) }] } },
    // runtime context 注入：v3 日志里它是 `{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt'}`，
    // 会话格式 v4 把它改写/写作生产者自有的 `runtime-context`（digest 只看"是不是 user"，
    // 两种形状都必须被当成注入、不进固定保留区）。
    { seq: 3, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'y'.repeat(20000) }] } },
    { seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' } },
  ]
  const { pinned, flow } = renderEventLines(events, DEFAULT_PARAMS)

  assert.deepEqual(pinned, ['--- turn 1 开始 ---', '[用户] 真正的人类指令'],
    '只有人类消息进固定保留区')
  const joined = flow.join('\n')
  assert.match(joined, /\[注入上下文 skill-catalog\]/)
  assert.match(joined, /\[注入上下文 runtime-context\]/)
  assert.ok(!joined.includes('xxxx'), '注入正文不得进入 digest')
})

test('注入上下文不会把人类进度挤出预算', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'z'.repeat(50000) }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '人类指令还在' }] } },
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{"command":"npm test"}' } },
  ]
  const text = renderInFlightDigest({ events, params: DEFAULT_PARAMS, siblingId: 's' })
  assert.match(text, /人类指令还在/)
  assert.match(text, /npm test/, '在飞动作必须还在')
  assert.ok(text.length < DEFAULT_PARAMS.digestMaxChars + 500, '必须仍然有界')
})

/* ---------------- 避让通知必须点名目标（8 次运行实验的结论） ---------------- */

test('activeTargets 按首次出现顺序抽出兄弟正在动的文件', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"src/api.ts"}' } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [
      { type: 'tool-call', name: 'edit', arguments: '{"file_path":"src/api.ts","old_string":"x"}' },
      { type: 'tool-call', name: 'edit', arguments: '{"file_path":"src/store.ts"}' },
    ] } } },
    { seq: 3, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } },
  ]
  assert.deepEqual(activeTargets(events), ['src/api.ts', 'src/store.ts'],
    '去重、保序、忽略没有 file_path 的调用')
})

test('activeTargets 对畸形输入不抛错', () => {
  assert.deepEqual(activeTargets([]), [])
  assert.deepEqual(activeTargets([{ type: 'tool/call', data: { arguments: 'not json' } }]), [])
  assert.deepEqual(activeTargets([{ type: 'tool/call', data: {} }]), [])
})

test('通知把兄弟的目标顶到最前面（埋在事件流水里等于没生效）', () => {
  const notice = renderForkNotice({
    branchId: 'b', siblingId: 's', cwd: '/w',
    targets: ['src/api.ts', 'src/store.ts'],
  })
  const head = notice.slice(0, 400)
  assert.match(head, /我此刻正在动.*src\/api\.ts.*src\/store\.ts/s)
  assert.ok(head.indexOf('src/api.ts') < notice.indexOf('避让（'),
    '目标必须出现在通用避让之前')
  // 必须写明"任务完整性优先于避让"——这是 8 次运行里 agent 一致采纳的优先级
  assert.match(notice, /任务完整性优先于避让/)
})

test('没有可识别目标时不产出空的目标段落', () => {
  const notice = renderForkNotice({ branchId: 'b', siblingId: 's', cwd: '/w' })
  assert.ok(!notice.includes('此刻正在动'), '无目标时不得留下空标题')
  assert.match(notice, /避让（效率约定）/)
})

/* ---------------- 环境变量参数覆盖（验证/运维通道） ---------------- */

test('DSH_AUTOFORK_PARAMS 覆盖默认值，插件配置优先级更高', () => {
  const fromEnv = resolveParams(undefined, { DSH_AUTOFORK_PARAMS: '{"minStepAgeMs":1500}' })
  assert.equal(fromEnv.minStepAgeMs, 1500)
  assert.equal(fromEnv.digestMaxChars, DEFAULT_PARAMS.digestMaxChars, '未覆盖的项保持默认')

  const both = resolveParams(
    { minStepAgeMs: 9000 },
    { DSH_AUTOFORK_PARAMS: '{"minStepAgeMs":1500}' },
  )
  assert.equal(both.minStepAgeMs, 9000, '显式配置必须压过环境变量')
})

test('非法或非对象的 DSH_AUTOFORK_PARAMS 被忽略，绝不让插件起不来', () => {
  for (const raw of ['not json', '[]', '"str"', 'null', '{}', '']) {
    const params = resolveParams(undefined, { DSH_AUTOFORK_PARAMS: raw })
    assert.equal(params.minStepAgeMs, DEFAULT_PARAMS.minStepAgeMs, `raw=${raw} 应退回默认`)
  }
})

test('环境覆盖同样只认已知键', () => {
  const params = resolveParams(undefined, { DSH_AUTOFORK_PARAMS: '{"ghostKey":1}' })
  assert.equal('ghostKey' in params, false)
})

/* ---------------- 工具调用不得渲染两次（实测踩到） ---------------- */

test('同一次调用只在 digest 里出现一次（assistant 部件 + tool/call 事件）', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"sleep 120"}' },
    ] } } },
    { seq: 3, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"sleep 120"}' } },
  ]
  const { flow } = renderEventLines(events, DEFAULT_PARAMS)
  const calls = flow.filter(line => line.startsWith('[调用]'))
  assert.equal(calls.length, 1, `只应渲染一次，实际 ${JSON.stringify(calls)}`)
  assert.match(calls[0], /sleep 120/)
})

test('被拒绝、从未执行的调用仍会被渲染（没有 tool/call 事件）', () => {
  const events = [
    { seq: 0, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 1, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
      { type: 'tool-call', id: 'c9', name: 'bash', arguments: '{"command":"rm -rf /"}' },
    ] } } },
  ]
  const { flow } = renderEventLines(events, DEFAULT_PARAMS)
  assert.equal(flow.filter(line => line.startsWith('[调用]')).length, 1)
})

/* ---------------- 折叠行摘要（form:'notice' 的 summary） ---------------- */

test('boundSummary：短文本原样、单行化', () => {
  assert.equal(boundSummary('实例已回复'), '实例已回复')
  assert.equal(boundSummary('实例\n  已\t回复 '), '实例 已 回复')
})

test('boundSummary：超限截到 120 并加省略号（不带丢弃量标注）', () => {
  const bounded = boundSummary('x'.repeat(500))
  assert.equal(bounded.length, CONTEXT_SUMMARY_MAX_CHARS)
  assert.ok(bounded.endsWith('…'))
  // `truncate` 会附 `(+N)`；折叠行只有一行，不能带这种标注。
  assert.equal(/\(\+\d+\)/.test(bounded), false)
})

/* ---------------- driver 文案：容器换 driver 的可见化 ---------------- */

test('shortSessionId：剥掉 session- 前缀并取 8 位', () => {
  assert.equal(shortSessionId('session-6a40195b-eed3-46a9-9418-f6cb2750b17e'), '6a40195b')
  assert.equal(shortSessionId('abc'), 'abc')
  assert.equal(shortSessionId(undefined), '')
})

test('instanceReplySummary：折叠行承载回复要点，而不仅是状态', () => {
  const summary = instanceReplySummary({ instanceId: 'session-6a40195b-eed3', reply: '你好，我在待命' })
  assert.equal(summary, '分叉会话 6a40195b：你好，我在待命')
})

test('instanceReplySummary：无产出时说明是空的，且仍有界', () => {
  assert.equal(
    instanceReplySummary({ instanceId: 'session-6a40195b-eed3', reply: '' }),
    '分叉会话 6a40195b 这一轮没有产出文本回复',
  )
  const long = instanceReplySummary({ instanceId: 'session-6a40195b-eed3', reply: 'x'.repeat(400) })
  assert.equal(long.length, CONTEXT_SUMMARY_MAX_CHARS)
})

test('renderInstanceReply：以当前 driver 的口吻出现（不是"某条陌生会话"）', () => {
  const text = renderInstanceReply({ instanceId: 'session-6a40195b-eed3', reply: '好的', maxChars: 100 })
  assert.match(text, /^\[分叉会话 6a40195b\] 这是它对你刚才那条指令的回复。\n好的$/)
})

test('三兄弟消息的措辞：说话人是**兄弟会话**（「我」= 兄弟，「你」= 新分叉会话）', () => {
  // 契约：这三条都以官方 `agent-message` + `form:'relay'` 投给 head ⇒ 客户端渲染成
  // turn-trigger 卡片，卡片头写着「来自会话 <兄弟>」，正文是**兄弟说的话**。
  // 所以正文里兄弟自称「我」，新分叉会话是「你」；反过来（新分叉会话自称"我"）会与卡片头矛盾。
  const notice = renderForkNotice({ branchId: 'b', siblingId: 's', cwd: '/w', targets: ['src/a.ts'] })
  const digest = renderInFlightDigest({ events: IN_FLIGHT, params: DEFAULT_PARAMS, siblingId: 's' })
  const reply = renderWorkerReply({ workerId: 's', reply: '做完了', stepCount: 2, maxChars: 100 })
  for (const [name, text] of [['notice', notice], ['digest', digest], ['reply', reply]]) {
    assert.ok(!/我是分叉会话/u.test(text), `${name} 不得让新分叉会话自称`)
    assert.ok(!/我接管的那条/u.test(text), `${name} 不得用"接管"视角描述兄弟`)
  }
  assert.match(notice, /你（分叉会话 b）接手了用户/)
  assert.match(digest, /我（s）这一轮还没跑完（seed 切在 turn 边界），不在你的上下文里/)
  assert.match(digest, /下面是原始事件流水，不是结论/)
  assert.match(reply, /我这一轮跑完了，最后一条回复如下/)
  // 降噪：三兄弟消息都不得在正文里重复报发送方的会话 id（卡片头 + 来源前缀已经给了）
  for (const [name, text] of [['notice', notice], ['digest', digest], ['reply', reply]]) {
    if (name === 'digest') continue  // digest 的「我（s）」是必要上下文（它要说明这是谁的那一轮）
    assert.ok(!text.includes('会话 s'), `${name} 不再重复发送方 id`)
  }
})

test('注入文案必须写明"通信方向不对称"（用户 2026-10 指出的真实误判）', () => {
  // 现象：head 把它在这个会话里写的普通回复（"收到""我承接了"）当成已经回给了 origin，
  // 而机制上**只有 origin → 分叉 这一条自动通道**，反向必须显式调 `fork_send`。
  // 根因是没有任何一处文案说明这件事 —— 这三条断言就是那个洞的护栏。
  const notice = renderForkNotice({ branchId: 'b', siblingId: 's', cwd: '/w', targets: [] })
  assert.match(notice, /通信方向（不对称，别想当然）/, '通知必须点明方向不对称')
  assert.match(notice, /反过来没有自动通道/)
  assert.match(notice, /不会\*\*传给我/, '要明确"你在这里的普通回复不会传给我"')
  assert.match(notice, /一发即走、\*\*没有回执\*\*/, 'steer 没有回执这件事必须写明')

  const hint = renderBranchHint({ headId: 'b' })
  assert.match(hint, /通信方向是不对称的/, 'worker 侧也要讲同一件事')
  assert.match(hint, /不会自动传给你/)
})

test('renderSteerReply：第三人称、带边界、没产出文本回复时交代步数', () => {
  const ok = renderSteerReply({ targetId: 'session-b', reply: '已按你的范围实施。', stepCount: 3, maxChars: 100 })
  assert.match(ok, /^「session-b」这一轮跑完了，它的最后一条回复：/)
  assert.match(ok, /已按你的范围实施。/)

  const empty = renderSteerReply({ targetId: 'session-b', reply: '   ', stepCount: 4, maxChars: 100 })
  assert.match(empty, /没有产出文本回复（走了 4 步）/)

  const long = renderSteerReply({ targetId: 'session-b', reply: 'x'.repeat(500), stepCount: 1, maxChars: 40 })
  assert.ok(long.length < 140, '回复正文按 maxChars 有界：' + String(long.length))
})
