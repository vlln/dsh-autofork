/**
 * 「分叉」页签的**渲染自证**：用极简 React 桩把真实 bundle 渲染成元素树，断言用户看到的信息。
 *
 * ## 为什么需要它
 *
 * 门禁 3 只做**静态**契约检查（bundle 调了 `__ModuleLoader__.load`、id 与包名一致…），
 * 服务端测试又碰不到客户端。于是"页签里到底显示了什么"一直只能在浏览器里用眼睛看——
 * 而这一层恰恰是最容易悄悄坏的地方（字段名写错、`undefined` 渲染进正文、状态标签退化成
 * 两个含义并排）。
 *
 * 这里**不引入任何依赖**（仓库不声明依赖、也不构建）：React 用一个 ~40 行的桩顶上，
 * 只实现本 bundle 用到的那三样（`createElement` / `useState` / `useEffect`）。于是
 * `npm test` 就能验证：给定服务端的 `nodes`，页签渲染出的文案里有没有那些**对用户有意义
 * 的信息**（触发指令、相对时间、状态、我在哪），以及**旧数据**（没有 trigger 的边）会不会
 * 渲染出 `undefined`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountView } from './react-stub.mjs'

/** 造一条服务端形状的节点（字段与服务端 `familyNodes()` 对齐）。 */
function node(overrides) {
  return Object.assign({
    sessionId: 'session-root-000001',
    title: '修 GUI 卡顿',
    state: 'running',
    busy: true,
    depth: 0,
    current: true,
    parentId: null,
    at: null,
    trigger: '',
    ordinal: 0,
    label: '',
  }, overrides)
}

const MINUTE = 60 * 1000

test('页签渲染：触发指令、相对时间、状态、我在哪——都在文案里', async () => {
  const view = await mountView({
    current: 'session-head-000003',
    nodes: [
      node({ sessionId: 'session-root-000001', title: '修 GUI 卡顿', state: 'finished', busy: false, current: false }),
      node({
        sessionId: 'session-head-000002',
        title: '⑂1 修 GUI 卡顿',
        label: '修 GUI 卡顿',
        state: 'running',
        busy: true,
        depth: 1,
        current: false,
        parentId: 'session-root-000001',
        at: Date.now() - 3 * MINUTE,
        trigger: '改成用 worktree 隔离',
        ordinal: 1,
      }),
      node({
        sessionId: 'session-head-000003',
        title: '⑂2 修 GUI 卡顿',
        label: '修 GUI 卡顿',
        state: 'idle',
        busy: false,
        depth: 1,
        current: true,
        parentId: 'session-root-000001',
        at: Date.now() - 30 * 1000,
        trigger: '顺便把日志也改成 JSON',
        ordinal: 2,
      }),
    ],
  })

  const text = view.texts.join('\n')
  try {
    // 摘要行：一共几条、几条在跑、几条已结束
    assert.match(text, /分叉家族 · 3 条会话/)
    assert.match(text, /1 条正在跑/)
    assert.match(text, /1 条已结束/)

    // **这次新增的三项"对用户有意义的信息"**
    assert.match(text, /触发：改成用 worktree 隔离/, '触发指令')
    assert.match(text, /触发：顺便把日志也改成 JSON/)
    assert.match(text, /3 分钟前/, '分叉时刻（相对时间）')
    assert.match(text, /刚刚/, '30 秒前渲染成"刚刚"')

    // 名字、序号徽章、根徽章、状态标签、我在哪
    // 名字用 `label`（服务端已剥掉 `<标记><序号> ` 前缀——那就是左边那枚徽章），
    // 所以**不会**读成"⑂1 ⑂1 修 GUI 卡顿"。
    assert.match(text, /^修 GUI 卡顿$/m)
    assert.ok(!text.includes('⑂1 ⑂1'), '徽章与名字不能各带一遍序号：\n' + text)
    assert.match(text, /⑂1/, '序号徽章')
    assert.match(text, /⑂2/, '序号徽章')
    assert.ok(text.includes('根'), '家族根有自己的徽章')
    assert.match(text, /运行中/)
    assert.match(text, /空闲/)
    assert.match(text, /已结束/)
    assert.match(text, /你在这里/)

    // 一行一条会话（根 + 两条分叉），都可点
    assert.equal(view.rows.length, 3)
    assert.equal(typeof view.rows[1].props.onClick, 'function')
    assert.equal(view.rows[2].props['aria-current'], 'true', '当前那条要标出来')

    // 渲染里绝不能出现 `undefined`/`null` 文本（字段写错时最容易出现）
    assert.ok(!/undefined|null|NaN/.test(text), '渲染文案里不能漏出 undefined：\n' + text)

    // 槽位契约：id / order / label（页签名）
    assert.equal(view.spec.id, 'branch')
    assert.equal(view.spec.order, 20)
    assert.equal(view.spec.label(), '分叉')
  } finally {
    view.stop()
  }
})

test('页签渲染：旧边（没有 trigger / at）只显示会话坐标，不渲染空标签或 undefined', async () => {
  // 这是"升级前落盘的边"与"家族根"的共同形状：只有 sessionId/title/state。
  const view = await mountView({
    current: 'session-root-000001',
    nodes: [
      node({ sessionId: 'session-root-000001' }),
      node({
        sessionId: 'session-head-000002',
        title: '',
        state: 'finished',
        busy: false,
        depth: 1,
        current: false,
        parentId: 'session-root-000001',
      }),
    ],
  })
  const text = view.texts.join('\n')
  try {
    assert.ok(!text.includes('触发：'), '没有触发指令时不渲染"触发："')
    assert.match(text, /会话 000002/, '没有名字时退回会话短 id')
    // 旧数据（没有 label）时用完整 title，而不是渲染成空
    assert.ok(!/^\s*$/m.test(text), '不能渲染出空行')
    assert.match(text, /已结束/)
    assert.ok(!/undefined|null|NaN/.test(text), '渲染文案里不能漏出 undefined：\n' + text)
  } finally {
    view.stop()
  }
})

test('页签渲染：只有自己一条会话时给"还没有分叉"的引导，且不画树', async () => {
  const view = await mountView({ current: 'session-root-000001', nodes: [node({})] })
  const text = view.texts.join('\n')
  try {
    assert.match(text, /这条会话还没有分叉/)
    assert.match(text, /就会自动分叉出一条新会话/, '空态要说明怎么触发分叉')
    assert.match(text, /⑂1 <本会话名>/, '空态给出分叉后的名字形状')
    assert.ok(!/undefined|null|NaN/.test(text), '渲染文案里不能漏出 undefined：\n' + text)
  } finally {
    view.stop()
  }
})
