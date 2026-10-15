/**
 * 客户端 half 的**渲染夹具**：极简 React 桩 + 在桩环境里跑真实 bundle 的 `apply`。
 *
 * 调用方：
 *  · `tests/client-view.test.mjs` —— 断言渲染出的文案（「分叉」页签、设置卡片、队列行按钮）；
 *  · `scripts/preview-tab.mjs` —— 把页签渲染成可读文本，改了 UI 不用开浏览器也能先看一眼。
 *
 * **不引入任何依赖**：仓库不声明依赖、也不构建，所以 React 用一个有限的桩顶上，只实现
 * 本 bundle 用到的那三样（`createElement` / `useState` / `useEffect`）。`react-dom` 与
 * `@deepseek-ai/dsh-client-ui-primitives` 是**可选**的（bundle 自己 try/catch），所以这里
 * 可以按场景给或不给——给了就顺便测"官方件在场"的那条分支。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

/** 本插件 Node half 的动作路由（断言 fetch 目标用）。 */
export const FORK_PATH = '/api/dsh-autofork/fork'
export const TAKEOVER_PATH = '/api/dsh-autofork/takeover'

/**
 * 极简 React 桩：只实现本 bundle 用到的那几样。
 * @returns {any} `{react, render, texts, buttons, portals}`。
 */
function makeReact() {
  let store = []
  let cursor = 0

  const react = {
    createElement(type, props) {
      const rest = Array.prototype.slice.call(arguments, 2)
      const { key, ...elementProps } = props ?? {}
      if (rest.length > 0) elementProps.children = rest.length === 1 ? rest[0] : rest
      return { type, key, props: elementProps, children: rest.length > 0 ? rest : [elementProps.children] }
    },
    /** 一次渲染内按调用顺序取值；不重渲染，所以只需要初值。 */
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in store)) store[index] = typeof initial === 'function' ? initial() : initial
      return [store[index], function () {}]
    },
    /** 渲染期不跑副作用（React 也不跑）。 */
    useEffect() {},
  }

  /**
   * 一次性初始 hook 槽：`render(node, {states:[…]})` 传给**第一个**被求值的函数组件，
   * 用来测"初始 state 不是它自己那个默认值"的分支（例如卡片的**展开态**——真实 React 里
   * 靠点击切换，而桩的 `setState` 是 no-op，所以只能从初始值这一侧进）。
   */
  let pendingStore

  /** 进入一个组件时给它一套**独立**的 hook 槽（组件之间不能互相污染）。 */
  function withHooks(fn) {
    const savedStore = store
    const savedCursor = cursor
    store = pendingStore === undefined ? [] : pendingStore
    pendingStore = undefined
    cursor = 0
    try {
      return fn()
    } finally {
      store = savedStore
      cursor = savedCursor
    }
  }

  /**
   * 把元素树展开成普通对象树（函数组件就地求值，host 元素保留 type/props/children）。
   * @param {any} node 元素。
   * @returns {any} 展开后的树。
   */
  function render(node, options) {
    if (options?.states !== undefined && pendingStore === undefined) pendingStore = options.states
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(render).filter(child => child !== null)
    const element = node
    // 假 react-dom 的 portal：保留挂载点（断言"按钮挂进了哪一行"），子树照常展开。
    if (element.__portal === true) {
      return { type: 'portal', props: { container: element.container }, children: [render(element.element)] }
    }
    if (typeof element.type === 'function') return withHooks(() => render(element.type(element.props)))
    return {
      type: element.type,
      key: element.key,
      props: element.props,
      children: (element.children ?? []).map(render).filter(child => child !== null),
    }
  }

  /** 收集树里所有文本（按渲染顺序）。 */
  function texts(node, out = []) {
    if (node === null) return out
    if (typeof node === 'string') {
      out.push(node)
      return out
    }
    if (Array.isArray(node)) {
      node.forEach(child => texts(child, out))
      return out
    }
    texts(node.children, out)
    return out
  }

  /** 收集所有带 `role="button"` 的行（页签里的每一行会话）。 */
  function rows(node, out = []) {
    if (node === null || typeof node === 'string') return out
    if (Array.isArray(node)) {
      node.forEach(child => rows(child, out))
      return out
    }
    if (node.props?.role === 'button') out.push(node)
    rows(node.children, out)
    return out
  }

  /**
   * 收集所有按钮元素（`<button>`，含自绘的回退控件）。
   * @param {any} node 树。
   * @param {any[]} [out] 输出数组。
   * @returns {any[]} 按钮元素。
   */
  function buttons(node, out = []) {
    if (node === null || typeof node === 'string') return out
    if (Array.isArray(node)) {
      node.forEach(child => buttons(child, out))
      return out
    }
    if (node.type === 'button' || node.type === 'Button' || node.type?.name === 'Button') out.push(node)
    buttons(node.children, out)
    return out
  }

  return { react, render, texts, rows, buttons }
}

/** 最小 DOM 树：插入/移除维护 parentNode，查询只返回仍挂载的直接子元素。 */
export function makeDomElement(tag = 'div') {
  return {
    tagName: tag.toUpperCase(), id: '', textContent: '', parentNode: null,
    children: [], attributes: {}, style: {},
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] ?? null },
    insertBefore(child, before) {
      child.remove()
      const index = before == null ? this.children.length : this.children.indexOf(before)
      assert.ok(index >= 0, 'insertBefore 目标必须属于该父节点')
      this.children.splice(index, 0, child)
      child.parentNode = this
    },
    appendChild(child) { this.insertBefore(child, null) },
    removeChild(child) {
      const index = this.children.indexOf(child)
      assert.ok(index >= 0, 'removeChild 目标必须属于该父节点')
      this.children.splice(index, 1)
      child.parentNode = null
    },
    remove() { this.parentNode?.removeChild(this) },
    querySelector(selector) {
      const attribute = /^\[([^\]]+)\]$/.exec(selector)?.[1]
      return this.children.find(child => child.getAttribute(attribute) !== null) ?? null
    },
  }
}

/**
 * 造一个假的 `configForms` 服务（官方 `ConfigForms` 的读/写面，够本插件用）。
 * @param {string} initial 初始分叉方式。
 * @returns {any} `{service, writes}`。
 */
function makeConfigForms(initial) {
  const writes = []
  let snapshot = {
    status: 'ready',
    value: { forkMode: initial },
    base: {},
    user: {},
    writable: true,
    revision: 1,
  }
  const listeners = new Set()
  const forms = {
    get(ns) {
      assert.equal(ns, 'dsh-autofork', '设置命名空间必须是条目 id（不是包名）')
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async mutate(ops) {
          writes.push(ops)
          const op = ops[0]
          snapshot = { ...snapshot, value: { ...snapshot.value, [op.path[0]]: op.value }, revision: snapshot.revision + 1 }
          listeners.forEach(listener => listener())
          return true
        },
      }
    },
  }
  return { service: forms, writes }
}

/**
 * 在桩环境里跑真实 bundle 的 `apply`。
 *
 * @param {object} [options] 场景开关。
 * @param {any[]} [options.nodes] health 返回的家族节点（页签的数据源）。
 * @param {string} [options.current] 当前会话 id。
 * @param {'auto'|'manual'} [options.mode] health 返回的分叉方式。
 * @param {any} [options.inbox] `useProjection('inbox')` 的值（队列行）。
 * @param {any} [options.pendingSubmissions] `useSession(s => s.pendingSubmissions)` 的值。
 * @param {string} [options.forkMode] 设置文档里的分叉方式（configForms 初值）。
 * @param {any[]} [options.queueRowNodes] 队列行的假 DOM 节点（给了才走 portal 分支）。
 * @param {any} [options.primitives] 假的官方控件模块（默认不给：走自绘分支）。
 * @returns {Promise<any>} 桩上下文、注册表、渲染工具与调用记录。
 */
export async function mountBundle(options = {}) {
  const globals = new Map(['window', 'fetch', 'document', 'MutationObserver'].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  // 每个场景从无 DOM 开始，stop 后恢复宿主，避免前一测试的 DOM 污染降级路径。
  delete globalThis.document
  delete globalThis.MutationObserver
  const stub = makeReact()
  const disposers = []
  /** 按槽名记注册（后注册覆盖同名槽的早注册，与真实槽注册表同义）。 */
  const registry = new Map()
  /** `uiWorkspace.openSession(target)` 的调用记录（断言跳转目标）。 */
  const opened = []
  /** fetch 调用记录（health 轮询 + 分叉动作）。 */
  const fetchCalls = []
  const { service: configForms, writes } = makeConfigForms(options.forkMode ?? 'auto')

  // 1) 拦住 `window.__ModuleLoader__.load`，拿到 bundle 的工厂
  let loaded
  globalThis.window = {
    confirm: options.confirm,
    __ModuleLoader__: {
      load(spec) { loaded = spec },
    },
  }

  // 2) 桩 `require`：react 恒在；react-dom / primitives 按场景给（缺了走 bundle 的降级分支）
  const requireStub = name => {
    if (name === 'react') return stub.react
    if (name === 'react-dom') {
      if (options.queueRowNodes === undefined) throw new Error('no react-dom in this scenario')
      return { createPortal: (element, container) => ({ __portal: true, element, container }) }
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (options.primitives === undefined) throw new Error('no primitives in this scenario')
      return options.primitives
    }
    throw new Error('unexpected require: ' + name)
  }

  // 3) 假的 fetch：health 探针返回服务端那份数据，动作路由回执成功
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    if (String(url) === TAKEOVER_PATH) {
      assert.equal(typeof options.takeoverResponse, 'function', '接管响应必须由用例显式提供，不能默认替用户同意')
      return options.takeoverResponse(init)
    }
    if (String(url).startsWith(FORK_PATH)) {
      return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'session-head-new' }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        params: {},
        mode: options.mode ?? 'auto',
        /** 侧栏徽标要的两样：`{会话 id: 序号}` + 字形。 */
        marks: options.marks ?? {},
        mark: options.mark ?? '\u2442',
         tools: [],
        nodes: options.nodes ?? [],
        driver: null,
        handoff: null,
      }),
    }
  }

  // 4) 假 DOM：只有本插件用到的几样（查询队列行、样式表宿主、DOM 观察者）
  /** 本插件注入的 `<style>` 元素（断言样式与官方 `.action` 一致用）。 */
  const styleElements = []
  const head = makeDomElement('head')
  if (options.queueRowNodes !== undefined || options.sessionRowNodes !== undefined) {
    globalThis.document = {
      querySelectorAll: (selector) => {
        if (selector === '[data-queue-dock] li') return options.queueRowNodes ?? []
        // 侧栏行的锚（官方源码里的 `data-row-key`）——徽标注入按它找行。
        if (selector === '[data-row-key]') return options.sessionRowNodes ?? []
        return []
      },
      getElementById: id => head.children.find(element => element.id === id) ?? null,
      createElement: tag => {
        const element = makeDomElement(tag)
        if (tag === 'style') styleElements.push(element)
        return element
      },
      head,
      body: {},
    }
    globalThis.MutationObserver = class { observe() {} disconnect() {} }
  }

  /** 客户端注册的会话节点定义（key = kind）。 */
  const conversationEvents = new Map()

  const services = {
    sessions: {
      list: {
        // `options.retainedMain` 与 `options.current` **刻意分开**：真实工作区在
        // `replaceMain` 里"先 retain(新) 再 release(旧)"，中间那一瞬间两条会话的
        // `retainedBy.mainView` 都 >0 —— 用它复现"该选哪一条"这个判据（见 client-fork 测试）。
        getSnapshot: () => {
          const retained = options.retainedMain ?? (options.current === undefined ? [] : [options.current])
          return {
            ids: retained,
            byId: Object.fromEntries(retained.map(id => [id, { id, retainedBy: { mainView: 1 } }])),
            phase: 'ready',
            projectionsBySession: {},
          }
        },
      },
      refresh: async () => {},
      refreshProjections: async () => {},
      subagentAddress: () => undefined,
    },
    /**
     * ⚠️ **只暴露真实服务面上有的东西**：`dsh-client-ui-workspace` 的 `selection` 是**模块级
     * 变量**，不在服务对象上（实测页签会空掉）——桩跟着暴露过一次，测试全绿而真机是坏的，
     * 所以这里刻意不提供它（README 的"判据钉在真实形状上"）。
     */
    uiWorkspace: { openSession: target => { opened.push(target) } },
    /**
     * `uiConversation`：官方客户端插件用它注册**自己的会话节点种类**（`ui-goal` 的
     * `/goal` 卡片就是这么做的）。这里只实现本插件用到的那一件：`events.register`。
     */
    uiConversation: {
      events: {
        register(definition) {
          conversationEvents.set(definition.kind, definition)
          return () => { conversationEvents.delete(definition.kind) }
        },
      },
    },
    slots: {
      inject(_channel, fn) { disposers.push(fn()); },
      register(spec, component) {
        // 真实 `slots.register` 返回卸载函数（卡片那条路要用它）——夹具照抄，别漏。
        registry.set(spec.name, { spec, component })
        return () => { registry.delete(spec.name) }
      },
    },
    configForms,
  }

  const context = {
    get(name) { return services[name] },
    // 嵌套 inject：声明了的服务都在才跑（与 cordis 语义一致）；这正是"可选能力不拖垮入口"的路径。
    // 服务既要能 `ctx.get('x')` 也要能 `ctx.x` ——真实 cordis 两种都提供。
    inject(deps, callback) {
      if (deps.some(name => services[name] === undefined)) return undefined
      const child = Object.assign({}, context)
      for (const [name, value] of Object.entries(services)) child[name] = value
      return callback(child)
    },
    effect(fn) { disposers.push(fn()) },
  }

  // eslint-disable-next-line no-new-func -- 桩环境就是这个测试的目的
  new Function('window', 'require', BUNDLE)(globalThis.window, requireStub)
  assert.ok(loaded !== undefined, 'bundle 必须调用 __ModuleLoader__.load')
  const exportsObject = loaded.factory(requireStub)
  // 定时器换成空转：轮询的**第一次** tick 在 apply 里直接调用（测试要的就是它），而周期性的
  // 那一个绝不能在测试里真的跑起来——否则某个断言失败提前退出时会漏掉 stop()，测试进程
  // 被一个 1 秒的 interval 永远吊住（这个坑踩过一次）。
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const intervals = []
  globalThis.setInterval = fn => { intervals.push(fn); return 0 }
  globalThis.clearInterval = () => {}
  try {
    exportsObject.apply(context)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }

  // 5) `apply` 里已经 tick() 过一次；等它的 promise 链落到 publish()
  await new Promise(resolve => setImmediate(resolve))

  return {
    registry,
    stub,
    services,
    /** 客户端注册的会话节点定义（卡片断言用）。 */
    conversationEvents,
    /** 设置写入的 path/value 记录。 */
    writes,
    /** 本插件注入的 `<style>` 元素（假 DOM 场景下才有）。 */
    styleElements,
    /** 已经交给 `uiWorkspace.openSession` 的目标（跳转断言用）。 */
    opened,
    /** 所有 fetch 调用。 */
    fetchCalls,
    /** 渲染一个已在注册表里的槽条目。 */
    renderSlot(name, props = {}) {
      const entry = registry.get(name)
      assert.ok(entry !== undefined, `槽 ${name} 必须注册`)
      return stub.render({ type: entry.component, props, children: [] })
    },
    async tick() {
      intervals.forEach(fn => fn())
      await new Promise(resolve => setImmediate(resolve))
    },
    stop() {
      disposers.splice(0).reverse().forEach(fn => { if (typeof fn === 'function') fn() })
      for (const [key, descriptor] of globals) {
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
    },
  }
}

/**
 * 「分叉」页签的渲染入口（`tests/client-view.test.mjs` 与 `scripts/preview-tab.mjs` 用）。
 * @param {object} options `{nodes, current}`。
 * @returns {Promise<any>} `{spec, tree, texts, rows, opened, stop}`。
 */
export async function mountView(options) {
  const bundle = await mountBundle(options)
  const entry = bundle.registry.get('conversation.view')
  assert.ok(entry !== undefined, '「分叉」页签必须注册进 conversation.view')
  const tree = bundle.stub.render({ type: entry.component, props: {}, children: [] })
  return {
    spec: entry.spec,
    tree,
    texts: bundle.stub.texts(tree),
    rows: bundle.stub.rows(tree),
    opened: bundle.opened,
    fetchCalls: bundle.fetchCalls,
    tick: bundle.tick,
    stop: bundle.stop,
  }
}
