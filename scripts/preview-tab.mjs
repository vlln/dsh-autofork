/**
 * 把「分叉」页签用**样例数据**渲染成可读文本，供改 UI 时先看一眼（不开浏览器）。
 *
 * 为什么需要：这一层只能在浏览器里生效，而"文案顺序、有没有漏出 undefined、一行里到底
 * 显示了哪些事实"这些恰恰是改 UI 时最容易错的地方。它跑的是**真实 bundle**（同一个
 * `tests/react-stub.mjs` 夹具），不是另写一份假渲染。
 *
 * 用法：`node scripts/preview-tab.mjs`
 */
import { mountView } from '../tests/react-stub.mjs'

const MINUTE = 60 * 1000
const now = Date.now()

const sample = [
  {
    sessionId: 'session-root-000001', title: '修 GUI 卡顿', label: '修 GUI 卡顿',
    state: 'finished', busy: false,
    depth: 0, current: false, parentId: null, at: null, trigger: '', ordinal: 0,
  },
  {
    sessionId: 'session-head-000002', title: '⑂1 修 GUI 卡顿', label: '修 GUI 卡顿',
    state: 'running', busy: true,
    depth: 1, current: false, parentId: 'session-root-000001',
    at: now - 3 * MINUTE, trigger: '改成用 worktree 隔离：把当前改动挪到独立工作树', ordinal: 1,
  },
  {
    sessionId: 'session-head-000003', title: '⑂2 修 GUI 卡顿', label: '修 GUI 卡顿',
    state: 'idle', busy: false,
    depth: 1, current: true, parentId: 'session-root-000001',
    at: now - 40 * 1000, trigger: '顺便把日志也改成 JSON', ordinal: 2,
  },
]

/**
 * 把渲染出的元素树打成缩进文本（顺序 = 屏幕上的从上到下、从左到右）。
 * @param {any} tree 渲染树。
 * @param {number} depth 缩进级别。
 * @returns {string[]} 行。
 */
function outline(tree, depth = 0) {
  if (tree === null) return []
  if (typeof tree === 'string') return ['  '.repeat(depth) + tree]
  if (Array.isArray(tree)) return tree.flatMap(child => outline(child, depth))
  const tag = typeof tree.type === 'string' ? tree.type : '?'
  const props = tree.props ?? {}
  const marks = []
  if (props.role === 'button') marks.push('role=button')
  if (props['aria-current'] === 'true') marks.push('aria-current')
  if (typeof props.onClick === 'function') marks.push('onClick')
  if (typeof props.title === 'string' && props.title !== '') marks.push('title=' + JSON.stringify(props.title.slice(0, 28)) + '…')
  const self = tree.children.some(child => typeof child === 'string')
    ? ' ' + tree.children.filter(child => typeof child === 'string').join(' / ')
    : ''
  const head = '  '.repeat(depth) + '<' + tag + (marks.length > 0 ? ' ' + marks.join(' ') : '') + '>' + self
  const rest = tree.children.filter(child => typeof child !== 'string')
  return [head, ...rest.flatMap(child => outline(child, depth + 1))]
}

const view = await mountView({ current: 'session-head-000003', nodes: sample })
try {
  console.log('=== 文案（用户实际读到的顺序） ===')
  console.log(view.texts.join('\n'))
  console.log('\n=== 结构 ===')
  console.log(outline(view.tree).join('\n'))
} finally {
  view.stop()
}
