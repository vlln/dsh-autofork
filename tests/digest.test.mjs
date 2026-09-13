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
  const text = describeParams(DEFAULT_PARAMS)
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

test('assembleWithinBudget 永不丢固定行，并从最近往前保留流动行', () => {
  const { text, omitted } = assembleWithinBudget(
    { pinned: ['PIN-A', 'PIN-B'], flow: ['F1', 'F2', 'F3', 'F4', 'F5'] },
    20,
  )
  assert.match(text, /PIN-A/)
  assert.match(text, /PIN-B/)
  assert.match(text, /F5/)
  assert.ok(omitted > 0, '应当报告被丢弃的行数')
  assert.ok(!text.includes('F1'), '最早的行应最先被丢弃')
})

test('assembleWithinBudget 丢弃量与实际不符时不谎报', () => {
  const { omitted } = assembleWithinBudget({ pinned: [], flow: ['x'] }, 1000)
  assert.equal(omitted, 0)
})

/* --------------------------- 确定性（核心） --------------------------- */

test('三个渲染面在同一输入下逐字节可复现', () => {
  const args = { events: IN_FLIGHT, params: DEFAULT_PARAMS, siblingId: 's-1' }
  const a = renderInFlightDigest(args)
  const b = renderInFlightDigest({ ...args, events: [...IN_FLIGHT] })
  assert.equal(a, b, 'in-flight digest 必须确定性')

  const n1 = renderForkNotice({ params: DEFAULT_PARAMS, branchId: 'b-1', siblingId: 's-1', cwd: '/w' })
  const n2 = renderForkNotice({ params: DEFAULT_PARAMS, branchId: 'b-1', siblingId: 's-1', cwd: '/w' })
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

test('renderForkNotice 告诉新 head：你现在就是用户所在的容器', () => {
  const text = renderForkNotice({
    params: DEFAULT_PARAMS, branchId: 'session-b', siblingId: 'session-a', cwd: '/w', targets: [],
  })
  assert.match(text, /\*\*你现在就是用户所在的容器\*\*/)
  assert.match(text, /原来的会话 session-a 留在后台继续跑它没做完的那一轮（不会被中止）/)
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
  assert.match(text, /因字符预算未渲染|因 digestMaxEvents 未渲染/)
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
    { seq: 3, type: 'user/message', data: { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [{ type: 'text', text: 'y'.repeat(20000) }] } },
    { seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' } },
  ]
  const { pinned, flow } = renderEventLines(events, DEFAULT_PARAMS)

  assert.deepEqual(pinned, ['--- turn 1 开始 ---', '[用户] 真正的人类指令'],
    '只有人类消息进固定保留区')
  const joined = flow.join('\n')
  assert.match(joined, /\[注入上下文 skill-catalog\]/)
  assert.match(joined, /\[注入上下文 @deepseek-ai\/dsh-system-prompt\]/)
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
    params: DEFAULT_PARAMS, branchId: 'b', siblingId: 's', cwd: '/w',
    targets: ['src/api.ts', 'src/store.ts'],
  })
  const head = notice.slice(0, 400)
  assert.match(head, /兄弟分叉此刻正在动.*src\/api\.ts.*src\/store\.ts/s)
  assert.ok(head.indexOf('src/api.ts') < notice.indexOf('避让协议'),
    '目标必须出现在避让协议之前')
  // 必须写明"任务完整性优先于避让"——这是 8 次运行里 agent 一致采纳的优先级
  assert.match(notice, /任务完整性优先于避让/)
})

test('没有可识别目标时不产出空的目标段落', () => {
  const notice = renderForkNotice({ params: DEFAULT_PARAMS, branchId: 'b', siblingId: 's', cwd: '/w' })
  assert.ok(!notice.includes('此刻正在动'), '无目标时不得留下空标题')
  assert.match(notice, /避让协议/)
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
