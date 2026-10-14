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
    // 摘要行（降噪后）：一行说完"几条会话、几条还在跑"——不再罗列"几条已结束"，
    // 也不再挂那句纯操作说明（用户反馈"文字太多"）
    assert.match(text, /分叉家族/)
    assert.match(text, /3 条会话 · 1 条在跑/)
    assert.ok(!text.includes('点任意一行'), '操作说明属于噪声，已删')
    assert.ok(!text.includes('缩进表示'), '操作说明属于噪声，已删')

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
    assert.match(text, /你在这里/)
    // 已结束的行**不再**挂状态胶囊（整行已变淡，再挂一枚同样的胶囊是纯重复）；
    // 完整会话 id 也从行里删掉了（它只留在 tooltip 上）
    assert.ok(!text.includes('未运行'), '未运行不再重复成胶囊：\n' + text)
    assert.ok(!text.includes('000001') && !text.includes('000002'),
      '行内不再出现 6 位短 id（tooltip 里仍有完整 id）：\n' + text)

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

test('跳转：点一行走 `uiWorkspace.openSession`（0.2.0 的导航入口）', async () => {
  // 0.2.0 起 `ctx.sessions` 不再有 `open` / `openSubagent`（导航属于视图所有者），
  // 唯一入口是 `ctx.uiWorkspace.openSession(target)`。桩里没有旧方法，所以只要代码还在
  // 走旧路径，这里就会抛 TypeError / 记不到目标。
  const view = await mountView({
    current: 'session-root-000001',
    nodes: [
      node({ sessionId: 'session-root-000001', current: true }),
      node({ sessionId: 'session-head-000002', title: '⑂1 修 GUI 卡顿', depth: 1, current: false, parentId: 'session-root-000001' }),
    ],
  })
  try {
    view.rows[1].props.onClick()
    // navTo 的链路是 promise（refresh → 拉投影 → 打开），等它落到 openSession。
    for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(view.opened, ['session-head-000002'], '点分叉行必须把目标交给 uiWorkspace.openSession')
    assert.equal(view.rows[1].props['aria-current'], undefined, '非当前行不带 aria-current')
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
    assert.ok(!text.includes('未运行'), '未运行不再重复成胶囊')
    assert.ok(!/undefined|null|NaN/.test(text), '渲染文案里不能漏出 undefined：\n' + text)
  } finally {
    view.stop()
  }
})

test('页签渲染：只有自己一条会话时只报"还没有分叉"，不复述插件怎么工作', async () => {
  const view = await mountView({ current: 'session-root-000001', nodes: [node({})] })
  const text = view.texts.join('\n')
  try {
    assert.match(text, /还没有分叉/, '摘要行要说明还没有分叉')
    // 空态**只**报状态，不解释"它忙时你再发一条指令会怎样"（用户 2026-10：那是噪声，已删）。
    // 判据同 0.6.2 的卡片正文原则：界面文字要么是模型可见内容、要么是数据派生的标签。
    for (const noise of ['它正忙', '自动分叉出新会话', '结果回注']) {
      assert.ok(!text.includes(noise), `空态不得出现解释性文案「${noise}」：\n` + text)
    }
    assert.ok(!text.includes('⑂1 <本会话名>'),
      '空态压缩成一句，不再复述命名规则（那里已经有一行示例行）')
    assert.ok(!/undefined|null|NaN/.test(text), '渲染文案里不能漏出 undefined：\n' + text)
  } finally {
    view.stop()
  }
})

/** 从元素树里按标签名收集元素（`svg` / `path` / `div`…）。 */
function collect(node, type, out = []) {
  if (node === null || typeof node === 'string') return out
  if (Array.isArray(node)) {
    node.forEach(child => collect(child, type, out))
    return out
  }
  if (node.type === type) out.push(node)
  collect(node.children, type, out)
  return out
}

/** 把 SVG path 的 `d` 拆成数字序列（本插件只生成 `M x1 y1 C x1 y1+k, x2 y2-k, x2 y2`）。 */
function pathNumbers(d) {
  return String(d).match(/-?\d+(?:\.\d+)?/g).map(Number)
}

test('页签渲染：树状图 —— 连线数、父子几何、卡片不重叠（这是"树"而非缩进列表的判据）', async () => {
  const now = Date.now()
  const view = await mountView({
    current: 'session-b',
    nodes: [
      node({ sessionId: 'session-root', label: '家族根', state: 'finished', busy: false, current: false, depth: 0, parentId: null }),
      node({
        sessionId: 'session-a', label: '甲', state: 'running', busy: true, depth: 1, current: false,
        parentId: 'session-root', ordinal: 1, at: now - 60_000, trigger: '甲触发',
      }),
      node({
        sessionId: 'session-b', label: '乙', state: 'idle', busy: false, depth: 1, current: true,
        parentId: 'session-root', ordinal: 2, at: now - 30_000, trigger: '乙触发',
      }),
      node({
        sessionId: 'session-c', label: '丙', state: 'finished', busy: false, depth: 2, current: false,
        parentId: 'session-a', ordinal: 3, at: now - 10_000, trigger: '丙触发',
      }),
    ],
  })

  const cards = view.rows                                            // role=button 的卡片
  const paths = collect(view.tree, 'path')
  const cardId = card => String(card.props['data-session-id'])
  const boxes = new Map(cards.map(card => [cardId(card), card.props.style]))

  // ① 一条边一条连线：4 个节点 3 条边（缩进列表时代这里会是 0 条）。
  assert.equal(cards.length, 4, '四个节点四张卡')
  assert.equal(paths.length, 3, '三条边三条连线')

  // ② 卡片是**绝对定位**在树画布上（不是靠 marginLeft 缩进的列表行）。
  for (const card of cards) {
    assert.equal(card.props.style.position, 'absolute', '卡片必须绝对定位在画布上')
  }
  const tops = new Set(cards.map(card => card.props.style.top))
  assert.equal(tops.size, 3, '三层各有一条水平线')

  // ③ 父卡居中于它的孩子们；子卡的连线端点落在卡边中点上。
  const x = id => Number.parseFloat(boxes.get(id).left)
  const y = id => Number.parseFloat(boxes.get(id).top)
  // 卡片尺寸从**渲染值**读，而不是把 `TREE` 的数字抄进测试：尺寸是观感参数、会随用户反馈调，
  // 抄进来的话每次调尺寸都要改测试（而且很容易漏掉一处）。
  const cw = Number.parseFloat(boxes.get('session-root').width)
  const ch = Number.parseFloat(boxes.get('session-root').height)
  assert.ok(cw > 0 && ch > 0, '卡片必须有显式尺寸（布局与连线的锚点）')
  assert.equal(x('session-root'), (x('session-a') + x('session-b')) / 2, '父节点居中于孩子')
  for (const path of paths) {
    const to = path.props.key
    const [x1, y1, , , , , x2, y2] = pathNumbers(path.props.d)
    const parent = to === 'session-c' ? 'session-a' : 'session-root'
    assert.equal(x1, x(parent) + cw / 2, '连线从父卡底边中点出发')
    assert.equal(y1, y(parent) + ch, '连线从父卡底边出发')
    assert.equal(x2, x(to) + cw / 2, '连线进入子卡顶边中点')
    assert.equal(y2, y(to), '连线进入子卡顶边')
  }

  // ④ 同层不重叠：任何两张卡都不该在水平与垂直上同时贴近。
  for (const one of cards) {
    for (const other of cards) {
      if (one === other) continue
      const apart = Math.abs(x(cardId(one)) - x(cardId(other))) >= cw
        || Math.abs(y(cardId(one)) - y(cardId(other))) >= ch
      assert.ok(apart, `卡片重叠：${cardId(one)} 与 ${cardId(other)}`)
    }
  }

  // ⑤ 在跑的那条用强调色连线（状态映射到图上，不是随机配色）。
  const running = paths.find(path => path.props.key === 'session-a')
  const finished = paths.find(path => path.props.key === 'session-c')
  assert.match(String(running.props.stroke), /state-business-primary/, '运行中的那条连线用强调色')
  assert.match(String(finished.props.stroke), /border-l2/, '未运行的那条用中性色')

  view.stop()
})

test('页签渲染：整张卡只有**一个** hover 详情，且含 session id / 触发指令等详细信息', async () => {
  // 用户 2026-10 报的："卡片现在在不同位置 hover 有不同的信息" —— 以前名字/触发指令/相对时间/
  // 值守胶囊各有自己的 title，鼠标在卡内移动会看到信息跳变。契约改成：**只有卡根一个 title**，
  // 所有卡结构一致，内容覆盖完整会话 id、状态、触发指令、分叉时刻与动作提示。
  const view = await mountView({
    current: 'session-b',
    nodes: [
      node({ sessionId: 'session-root', label: '家族根', state: 'finished', busy: false, current: false, depth: 0, parentId: null }),
      node({
        sessionId: 'session-b', label: '乙', state: 'idle', busy: false, depth: 1, current: true,
        parentId: 'session-root', ordinal: 2, at: Date.now() - 30_000, trigger: '把日志也改成 JSON',
      }),
    ],
  })

  const cards = view.rows
  assert.equal(cards.length, 2)

  /** 卡内（不含卡根自己）有没有别的 title —— 有就说明又散开了。 */
  const innerTitles = (card, out = []) => {
    for (const child of card.children ?? []) {
      if (child === null || typeof child !== 'object') continue
      if (Array.isArray(child)) { child.forEach(item => innerTitles(item, out)); continue }
      if (child.props?.title !== undefined) out.push(child.type)
      innerTitles(child, out)
    }
    return out
  }

  for (const card of cards) {
    const id = String(card.props['data-session-id'])
    const title = String(card.props.title)
    assert.match(title, new RegExp('会话：' + id), '卡根 tooltip 必须带完整会话 id')
    // 用户 2026-10："不需要有任何区分'未运行'，因为这对于用户是无意义的信息" ⇒
    // 只有**活着**（有实时状态）的卡才写状态行；不在本进程时整行不出现（不是写成"未运行"）。
    if (title.includes('状态：')) assert.match(title, /状态：(运行中|空闲)/, '状态行只能是实时两态')
    assert.equal(/未运行|已结束/.test(title), false, '不得出现"不在本进程"这类实现细节：\n' + title)
    assert.match(title, /触发指令：/, '带触发指令（家族根给"—"）')
    assert.match(title, /分叉于：/, '带分叉时刻')
    assert.deepEqual(innerTitles(card), [], `${id} 卡内不该再有 title（否则 hover 信息会跳变）`)
  }

  const head = cards.find(card => card.props['data-session-id'] === 'session-b')
  assert.match(String(head.props.title), /触发指令：把日志也改成 JSON/, '触发指令给全文（卡上是截断的）')
  // 状态里的"你在这里 / 现在回答你的是它"**保留在 aria-label**（屏幕阅读器只念它、不念卡内芯片），
  // 但**不另起一行"位置"**——卡上那两枚胶囊已经写了（用户 2026-10 判定的重复）。
  assert.match(String(head.props.title), /状态：空闲（你在这里）/, '无障碍详情要带"你在这里"')
  const plain = cards.find(card => card.props['data-session-id'] === 'session-root')
  assert.ok(!String(plain.props.title).includes('你在这里'), '不是当前会话就别写它：\n' + String(plain.props.title))
  // 动作提示那两行**已删**（用户 2026-10："点击切过去"是操作提示、不是这一层的详情；
  // 当前卡那半句与键值行里的"位置：你在这里"重复）。可点性由指针与悬停抬升表达。
  for (const card of cards) {
    const detail = String(card.props.title)
    assert.ok(!detail.includes('点击切过去'), '详情里不再写动作提示：\n' + detail)
    assert.ok(!detail.includes('当前会话'), '当前卡也不另写一遍"当前会话"：\n' + detail)
  }

  view.stop()
})

test('每张卡自带「自动回注」开关：按会话渲染、点一下按同形契约落盘（且不误触切会话）', async () => {
  // 用户 2026-10："自动回注应该是每个 session 独立开关的功能。" ⇒ 开关挂在**每张卡**上，
  // 语义是"这条会话跑完要不要自动把结果投给它派生出的会话"。
  /** 收集所有带某属性的元素。 */
  const findAll = (tree, key, out = []) => {
    const walk = (node) => {
      if (node === null || typeof node === 'string') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node.props?.[key] !== undefined) out.push(node)
      walk(node.children)
    }
    walk(tree)
    return out
  }

  const view = await mountView({
    current: 'session-root-000001',
    nodes: [
      node({ sessionId: 'session-root-000001', muted: false }),
      node({ sessionId: 'session-root-000002', title: '⑂1 修 GUI 卡顿', label: '修 GUI 卡顿', ordinal: 1, muted: true, depth: 1, parentId: 'session-root-000001' }),
    ],
  })

  const switches = findAll(view.tree, 'data-mute-toggle')
  assert.equal(switches.length, 2, '每张卡各一个开关')
  const onSwitch = switches.find(item => item.props['data-mute-toggle'] === 'session-root-000001')
  const offSwitch = switches.find(item => item.props['data-mute-toggle'] === 'session-root-000002')
  assert.equal(onSwitch.props['aria-checked'], 'false', '开着的会话 aria-checked=false（未静音）')
  assert.equal(offSwitch.props['aria-checked'], 'true', '关掉的会话 aria-checked=true')
  assert.equal(view.texts.includes('回注开'), true)
  assert.equal(view.texts.includes('回注关'), true)
  // 整卡只有一个 tooltip 是既有契约 ⇒ 开关**不带**自己的 title，含义写在卡根那句里
  assert.equal(onSwitch.props.title, undefined, '开关不得自带 title')
  const cards = findAll(view.tree, 'data-session-id')
  const rootCard = cards.find(card => card.props['data-session-id'] === 'session-root-000001')
  assert.match(String(rootCard.props.title), /自动回注：开/, '卡根 tooltip 要写清这个开关的含义')

  // 点开关：必须 stopPropagation（否则会顺带触发卡片的"切会话"）
  let stopped = false
  let navigated = null
  view.bundle?.opened
  onSwitch.props.onClick({ stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true, '点开关要阻止冒泡')
  const post = view.fetchCalls.find(call => String(call.url).includes('/api/dsh-autofork/mute'))
  assert.ok(post !== undefined, '点击要打 mute 路由')
  assert.equal(post.init.method, 'POST')
  assert.equal(post.init.headers['x-dsh-autofork'], '1', '与分叉路由同一道安全边界')
  assert.deepEqual(JSON.parse(post.init.body), { sessionId: 'session-root-000001', muted: true },
    '改的是**这张卡**那条会话，不是当前会话/家族')
  view.stop()
})
