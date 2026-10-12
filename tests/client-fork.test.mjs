/**
 * 手动分叉的**客户端自证**：设置卡片（Plugins 页）与队列行上那枚「分叉」按钮。
 *
 * ## 为什么要有这一层
 *
 * 门禁 3 只做静态契约检查，服务端测试碰不到浏览器。于是"设置卡片点了到底写了什么"
 * "按钮挂进了哪一行、点下去发的请求对不对"这类事实，只能在浏览器里用眼睛看——
 * 而这正是最容易悄悄坏的地方（槽 key 写成命名空间、写路径少一段、按钮挂错行）。
 *
 * 这里用 `tests/react-stub.mjs` 的极简 React 桩把**真实 bundle**渲染成元素树：
 *  · `react-dom` 与 `@deepseek-ai/dsh-client-ui-primitives` 按场景给或不给，两条降级分支都测；
 *  · 队列行的 DOM 挂在桩里给，于是 portal 的**挂载点**（挂进了哪一行）可断言。
 *
 * **验不到的**：浏览器里真实 DOM 的观感、官方件在场时的视觉效果——那只能人眼验
 * （与本插件「分叉」页签同一条边界，见 AGENTS.local.md 事实 6/23）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FORK_PATH, mountBundle } from './react-stub.mjs'

/**
 * 造一条队列投影行（形状与 `ui-conversation` 的 `QueueDock` 读的 `inbox['next-turn']` 一致）。
 * @param {string} id 消息 id。
 * @param {string} text 文本。
 * @returns {object} 投影行。
 */
function inboxRow(id, text) {
  return { id, content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/**
 * 收集树里的 portal（`react-dom` 桩产出的节点）。
 * @param {any} node 树。
 * @param {any[]} [out] 输出数组。
 * @returns {any[]} portal 节点。
 */
function portalsOf(node, out = []) {
  if (node === null || typeof node === 'string') return out
  if (Array.isArray(node)) {
    node.forEach(child => portalsOf(child, out))
    return out
  }
  if (node.type === 'portal') out.push(node)
  portalsOf(node.children, out)
  return out
}

/**
 * 收集树里的按钮元素。
 * @param {any} node 树。
 * @param {any[]} [out] 输出数组。
 * @returns {any[]} 按钮节点。
 */
function buttonsOf(node, out = []) {
  if (node === null || typeof node === 'string') return out
  if (Array.isArray(node)) {
    node.forEach(child => buttonsOf(child, out))
    return out
  }
  if (node.type === 'button') out.push(node)
  buttonsOf(node.children, out)
  return out
}

/** 等 fetch 的 promise 链跑完。 */
async function flush() {
  for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve))
}

/**
 * 造队列行组件的 props（槽运行时在 session 作用域会给的三样 + 两个标准钩子）。
 * @param {object} options `{sessionId, inbox, pendingSubmissions}`。
 * @returns {object} props。
 */
function dockProps({ sessionId = 'session-parent', inbox = { 'next-turn': [] }, pendingSubmissions = [] } = {}) {
  return {
    sessionId,
    useProjection: key => (key === 'inbox' ? inbox : undefined),
    useSession: selector => selector({ pendingSubmissions }),
  }
}

/* ------------------------------ 设置卡片 ------------------------------ */

test('设置卡片：注册进 plugins.bundle.config，key 是**包名**、命名空间是**条目 id**（两者不同）', async () => {
  const bundle = await mountBundle({ forkMode: 'auto' })
  const entry = bundle.registry.get('plugins.bundle.config')
  assert.ok(entry !== undefined, '设置卡片必须注册进 plugins.bundle.config')
  assert.equal(entry.spec.key, '@vlln/dsh-autofork', 'keyed 槽的 key 必须是 bundle 包名')
  // `configForms.get(ns)` 在桩里断言 ns === 'dsh-autofork'（条目 id），所以这一行同时钉住了命名空间。
  assert.ok(entry.spec.inject().writeForkMode !== undefined)
  bundle.stop()
})

test('设置卡片：渲染出两种方式与说明，点「手动分叉」写的是 forkMode=manual', async () => {
  const bundle = await mountBundle({ forkMode: 'auto' })
  const entry = bundle.registry.get('plugins.bundle.config')
  const face = entry.spec.inject()
  const props = {
    view: 'page',
    // 官方槽运行时把 `hooks.forkSettings` 变成 `useForkSettings` 这个选择器钩子。
    useForkSettings: selector => selector(face.hooks.forkSettings.getSnapshot()),
    writeForkMode: face.writeForkMode,
  }
  const tree = bundle.stub.render({ type: entry.component, props, children: [] })
  const text = bundle.stub.texts(tree).join('\n')

  assert.match(text, /分叉方式/)
  assert.match(text, /自动分叉/)
  assert.match(text, /手动分叉/)
  assert.match(text, /立刻在新会话里开始执行/, '卡片必须说清当前这种方式是怎么运作的')

  const manual = buttonsOf(tree).find(button => button.children.some(child => child === '手动分叉'))
  assert.ok(manual !== undefined, '必须有「手动分叉」这个选项（拿不到官方 SegmentedControl 时的自绘回退）')
  manual.props.onClick()
  await flush()

  assert.deepEqual(bundle.writes, [[{ op: 'set', path: ['forkMode'], value: 'manual' }]])
  assert.equal(text.includes('刚才的改动未被接受'), false, '写入成功时不得显示失败提示')
  bundle.stop()
})

test('设置卡片：已选中项不重复写、summary 视图给一行描述、命名空间不可用时整块不渲染', async () => {
  const bundle = await mountBundle({ forkMode: 'manual' })
  const entry = bundle.registry.get('plugins.bundle.config')
  const face = entry.spec.inject()
  /** 组件要按 React 规则先跑完 hooks，所以 summary 视图同样要拿到选择器钩子。 */
  const hookProps = {
    useForkSettings: selector => selector(face.hooks.forkSettings.getSnapshot()),
    writeForkMode: face.writeForkMode,
  }

  const summary = bundle.stub.render({
    type: entry.component,
    props: { view: 'summary', ...hookProps },
    children: [],
  })
  assert.equal(summary, '自动分叉 / 手动分叉')

  const ready = bundle.stub.render({
    type: entry.component,
    props: { view: 'page', ...hookProps },
    children: [],
  })
  assert.match(bundle.stub.texts(ready).join('\n'), /点「分叉」才分叉/, '手动模式下要讲清分叉入口在哪')
  const current = buttonsOf(ready).find(button => button.children.some(child => child === '手动分叉'))
  assert.equal(current.props['aria-pressed'], true, '当前选中的那项要有选中态')
  current.props.onClick()
  await flush()
  assert.deepEqual(bundle.writes, [], '点已经选中的那一项不得产生写入')

  // 命名空间不被宿主服务（`configForms` 快照 status 不是 ready）：整块不渲染，不留空壳。
  const unavailable = bundle.stub.render({
    type: entry.component,
    props: {
      view: 'page',
      useForkSettings: selector => selector({ status: 'unavailable', value: undefined, writable: false }),
      writeForkMode: face.writeForkMode,
    },
    children: [],
  })
  assert.equal(unavailable, null)
  bundle.stop()
})

/* ------------------------------ 队列行上的按钮 ------------------------------ */

test('分叉按钮：手动模式下每条排队指令各挂一个 portal，挂载点就是那一行', async () => {
  const rowA = { id: 'row-a' }
  const rowB = { id: 'row-b' }
  const bundle = await mountBundle({
    current: 'session-parent',
    mode: 'manual',
    queueRowNodes: [rowA, rowB],
  })
  const entry = bundle.registry.get('conversation.input.dock')
  assert.ok(entry !== undefined, '分叉按钮必须注册进 conversation.input.dock')

  const inbox = { 'next-turn': [inboxRow('m-1', '改成用 worktree 隔离'), inboxRow('m-2', '顺便把日志改成 JSON')] }
  const tree = bundle.stub.render({ type: entry.component, props: dockProps({ inbox }), children: [] })
  const portals = portalsOf(tree)

  assert.equal(portals.length, 2, '两条排队指令各一个按钮')
  assert.equal(portals[0].props.container, rowA, '第一个按钮要挂进第一行')
  assert.equal(portals[1].props.container, rowB, '第二个按钮要挂进第二行')

  const button = buttonsOf(portals[0].children[0])[0]
  assert.equal(button.props['data-dsh-autofork-fork'], '', '按钮要带本插件的 DOM 属性（样式与自证都按它）')
  // 观感契约：旁边那几个官方按钮是**图标按钮**（14px 图标、无文字），所以这里也只能有图标——
  // 出现文字标签就会比旁边宽一倍，一眼看出是外挂的（用户实测反馈过）。
  assert.equal(bundle.stub.texts(button).join(''), '⑂', '拿不到官方图标时顶一个分支符号，不得渲染文字标签')
  assert.match(String(button.props['aria-label']), /worktree/, '这条指令是什么要留给 aria-label（读屏能听全）')
  assert.equal(button.props.title, '分叉', '常态提示词与官方同级按钮同量级（编辑 / 删除 / 转向）')

  button.props.onClick()
  await flush()
  const action = bundle.fetchCalls.find(call => call.url.startsWith(FORK_PATH))
  assert.ok(action !== undefined, '点击必须打动作路由')
  assert.equal(action.init.method, 'POST')
  assert.equal(action.init.headers['x-dsh-autofork'], '1', '必须带自定义头（跨站请求会被 CORS 预检挡住）')
  assert.deepEqual(JSON.parse(action.init.body), { sessionId: 'session-parent', messageId: 'm-1' },
    '必须分叉点的那一条，不是队首')
  bundle.stop()
})

test('分叉按钮样式：逐条对齐官方 QueueDock 的 .action（尺寸 / 圆角 / 颜色 / 悬停 / 禁用）', async () => {
  // 用户实测反馈：按钮必须**看起来就是旁边那几个**。插件拿不到官方 CSS module 的哈希类名，
  // 只能复刻声明——所以把复刻的每一条钉住，避免以后再"顺手改好看点"而漂移。
  const bundle = await mountBundle({ current: 'session-parent', mode: 'manual', queueRowNodes: [] })
  // 现在有两张样式表（分叉按钮 + 消息卡），按**选择器**找，不按下标。
  const style = bundle.styleElements.find(element => element.textContent.includes('[data-dsh-autofork-fork]'))
  assert.ok(style !== undefined, '必须注入样式表（:hover 之类内联样式表达不了）')
  const css = style.textContent

  assert.match(css, /width:28px/, '官方 .action 是 28×28')
  assert.match(css, /height:28px/)
  assert.match(css, /border-radius:999px/, '圆形，不是圆角矩形')
  assert.match(css, /corner-shape:round/, '少了它主题层会把圆按钮渲染成圆角方块')
  assert.match(css, /color:var\(--dsw-alias-label-tertiary/, '三级文字色（与旁边一致）')
  assert.match(css, /background:0 0/, '常态透明底')
  assert.match(css, /border:none/)
  assert.match(css, /display:grid/, '官方用 grid + place-items:center 居中图标')
  assert.match(css, /padding:0/)
  assert.match(css, /:hover:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover\)\}/, '悬停底色同官方')
  assert.match(css, /:focus-visible\{outline:var\(--dsw-focus-ring-width\) solid /, '键盘焦点环同官方')
  assert.match(css, /outline-offset:-2px/)
  assert.match(css, /:disabled\{cursor:default;opacity:\.45\}/, '禁用态同官方')
  bundle.stop()
})

test('分叉按钮：非手动模式、没有排队指令、或在等宿主接纳的本地回声都不挂按钮', async () => {
  const rowA = { id: 'row-a' }

  // 自动模式：宿主会立刻分叉，不该有手动按钮。
  const auto = await mountBundle({ current: 'session-parent', mode: 'auto', queueRowNodes: [rowA] })
  const entry = auto.registry.get('conversation.input.dock')
  const autoTree = auto.stub.render({
    type: entry.component,
    props: dockProps({ inbox: { 'next-turn': [inboxRow('m-1', '甲')] } }),
    children: [],
  })
  assert.equal(autoTree, null, '自动模式不得出现手动分叉入口')
  assert.equal(portalsOf(autoTree).length, 0)
  auto.stop()

  // 手动模式但没有排队指令。
  const idle = await mountBundle({ current: 'session-parent', mode: 'manual', queueRowNodes: [rowA] })
  const idleEntry = idle.registry.get('conversation.input.dock')
  assert.equal(idle.stub.render({ type: idleEntry.component, props: dockProps({}), children: [] }), null)
  idle.stop()

  // 本地回声（`placement: 'queued'`）尚未被宿主接纳，没有宿主消息 id ⇒ 不能作为分叉对象；
  // 而已经在转写里出现过的回声（`placement: 'transcript'`）要按 QueueDock 的规则剔除。
  const echo = await mountBundle({ current: 'session-parent', mode: 'manual', queueRowNodes: [rowA] })
  const echoEntry = echo.registry.get('conversation.input.dock')
  const echoTree = echo.stub.render({
    type: echoEntry.component,
    props: dockProps({
      inbox: {
        'next-turn': [
          { id: 'm-echo', content: [{ type: 'text', text: '回声' }], source: { kind: 'user', rpcId: 'rpc-1' } },
          inboxRow('m-real', '真指令'),
        ],
      },
      pendingSubmissions: [
        { requestId: 'rpc-1', placement: 'transcript' },
        { requestId: 'rpc-2', placement: 'queued' },
      ],
    }),
    children: [],
  })
  const portals = portalsOf(echoTree)
  assert.equal(portals.length, 1, '只给宿主真的收下了的那一条挂按钮')
  const echoButton = buttonsOf(portals[0].children[0])[0]
  // 这条按钮对应的是「真指令」，不是那条本地回声——预览文本现在挂在 aria-label 上。
  assert.match(String(echoButton.props['aria-label']), /真指令/)
  echo.stop()
})

test('分叉按钮：队列面板收起（行不在 DOM 里）时退回一条右对齐的回退条，功能仍在', async () => {
  // 不给 `queueRowNodes` ⇒ 桩里的 `react-dom` 也拿不到 ⇒ 走回退分支（与"面板收起"同一形状）。
  const bundle = await mountBundle({ current: 'session-parent', mode: 'manual' })
  const entry = bundle.registry.get('conversation.input.dock')
  const inbox = { 'next-turn': [inboxRow('m-1', '甲'), inboxRow('m-2', '乙')] }
  const tree = bundle.stub.render({ type: entry.component, props: dockProps({ inbox }), children: [] })

  assert.equal(portalsOf(tree).length, 0, '拿不到 react-dom 时不得产出门户')
  const bar = Array.isArray(tree) ? tree[0] : tree
  assert.equal(bar.props['data-dsh-autofork-forkbar'], '', '回退条要带自己的 DOM 属性')
  assert.equal(bar.props.style.justifyContent, 'flex-end', '回退条右对齐（用户要的"右侧"）')
  const buttons = buttonsOf(bar)
  assert.equal(buttons.length, 2, '每条排队指令仍各有一个入口')

  buttons[1].props.onClick()
  await flush()
  const action = bundle.fetchCalls.find(call => call.url.startsWith(FORK_PATH))
  assert.deepEqual(JSON.parse(action.init.body), { sessionId: 'session-parent', messageId: 'm-2' })
  bundle.stop()
})

const CARD_ATTR_KEY = 'data-dsh-autofork-card'

test('消息卡：注册 conversation.chat.node 视图 + 只认本插件标记的节点', async () => {
  // "两张卡 + 用户消息 + 只跑一次模型请求"要求卡片由本插件自己画（宿主直接落盘、不占 turn）。
  // 契约来自官方 ui-goal（同一套 API 画 /goal 指令卡片）：
  //   ctx.uiConversation.events.register({kind, target:'chat', match, start, update, buildViewNode})
  //   slots.register({name:'conversation.chat.node', key:<kind>}, View)
  const bundle = await mountBundle({ current: 'session-parent', mode: 'auto', queueRowNodes: [] })
  const entry = bundle.registry.get('conversation.chat.node')
  assert.ok(entry !== undefined, '必须把卡片视图注册进 conversation.chat.node 槽')
  assert.equal(entry.spec.key, 'autofork-message', 'key = 节点 kind')

  const definition = bundle.conversationEvents.get('autofork-message')
  assert.ok(definition !== undefined, '必须注册节点定义（否则消息根本不进转写）')
  assert.equal(definition.target, 'chat')

  // 只认本插件自己写的三条；别人的 agent 消息照旧走官方渲染（不抢别人的样式）。
  assert.equal(definition.match({ type: 'user/message', data: { source: { kind: 'agent-message' } } }), null,
    '没有 autofork 标记的 relay 消息不得被我们接管')
  const card = { type: 'user/message', seq: 7, time: 1700000000000, data: {
    id: 'm-card',
    content: [{ type: 'text', text: '正文' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'session-parent', autofork: 'notice' },
  } }
  assert.deepEqual(definition.match(card), { id: 'm-card', role: 'start' })
  const context = { key: '9:autofork-messagem-card', id: 'm-card', start: { location: { kind: 'unresolved' } }, state: undefined }
  context.state = definition.start(context, { event: card, id: 'm-card' })
  const node = definition.buildViewNode(context)
  assert.equal(node.kind, 'autofork-message')
  assert.equal(node.visibility, 'visible', '不可见就等于没渲染——正是要避免的旧症状')
  assert.deepEqual(node.location, { kind: 'unresolved' },
    '必须 unresolved：落在 turn 内且 kind 不在官方的 TURN_PROCESS_INDEPENDENT_KINDS 里会被折进过程分组')
  assert.equal(node.data.marker, 'notice')
  assert.equal(node.data.sender, 'session-parent')
  assert.equal(node.data.text, '正文')

  // 卡片样式照抄官方 trigger 卡片（边框 / 圆角 / 主题背景 / 折叠正文）
  const css = bundle.styleElements.map(element => element.textContent).join('')
  assert.match(css, /\[data-dsh-autofork-card\]\{border:\.5px solid var\(--dsw-alias-border-l1\)/)
  assert.match(css, /border-radius:var\(--dsw-radius-xl\)/)
  assert.match(css, /background:var\(--dsw-alias-turn-trigger-bg,var\(--dsw-alias-markdown-code-block\)\)/)
  assert.match(css, /\[data-part=content\]\{white-space:pre-wrap/)

  // 视图本体：折叠态只有头行，展开后出现"来自会话 X" + 正文
  const folded = bundle.stub.render({ type: entry.component, props: { node }, children: [] })
  assert.equal(folded.props[CARD_ATTR_KEY], 'notice', '根节点带本插件的标记属性（样式按它选）')
  assert.equal(folded.props['data-open'], undefined, '默认折叠')
  assert.equal(bundle.stub.texts(folded).includes('分叉通知'), true,
    '标题按标记取（分叉通知 / 在飞进度 / 后台会话回复）')
  const header = folded.children[0]
  assert.equal(typeof header.props.onClick, 'function', '头行可点击（折叠/展开）')
  header.props.onClick()  // 桩的 useState 是只读的，展开态由真 GUI 验证（见工程笔记）
  bundle.stop()
})
