/**
 * 「分叉」页签的**渲染夹具**：极简 React 桩 + 在桩环境里跑真实 bundle 的 `apply`。
 *
 * 两个调用方：`tests/client-view.test.mjs`（断言渲染出的文案）与
 * `scripts/preview-tab.mjs`（把页签渲染成可读文本，改了 UI 不用开浏览器也能先看一眼）。
 *
 * **不引入任何依赖**：仓库不声明依赖、也不构建，所以 React 用一个 ~40 行的桩顶上，
 * 只实现本 bundle 用到的那三样（`createElement` / `useState` / `useEffect`）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const BUNDLE = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

/**
 * 极简 React 桩：只实现本 bundle 用到的那几样。
 * @returns {any} `{react, render, texts}`。
 */
function makeReact() {
  let store = []
  let cursor = 0

  const react = {
    createElement(type, props, children) {
      const rest = Array.prototype.slice.call(arguments, 2)
      return {
        type,
        props: props === null || props === undefined ? {} : props,
        children: rest.length === 1 ? [children] : rest,
      }
    },
    /** 一次渲染内按调用顺序取值；不重渲染，所以只需要初值。 */
    useState(initial) {
      const index = cursor
      cursor += 1
      if (store[index] === undefined) store[index] = initial
      return [store[index], function () {}]
    },
    /** 渲染期不跑副作用（React 也不跑）。 */
    useEffect() {},
  }

  /** 进入一个组件时给它一套**独立**的 hook 槽（组件之间不能互相污染）。 */
  function withHooks(fn) {
    const savedStore = store
    const savedCursor = cursor
    store = []
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
  function render(node) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(render).filter(child => child !== null)
    const element = node
    if (typeof element.type === 'function') return withHooks(() => render(element.type(element.props)))
    return {
      type: element.type,
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

  return { react, render, texts, rows }
}

/**
 * 在桩环境里跑真实 bundle 的 `apply`，拿到注册的页签组件与它们渲染出的树。
 * @param {object} options `{nodes, current}`。
 * @returns {Promise<any>} `{spec, component, tree, texts, rows, lines, stop}`。
 */
export async function mountView({ nodes, current }) {
  const stub = makeReact()
  const disposers = []
  let registered

  // 1) 拦住 `window.__ModuleLoader__.load`，拿到 bundle 的工厂
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) { loaded = spec },
    },
  }
  // 2) 桩 `require('react')`
  const requireStub = name => {
    if (name === 'react') return stub.react
    throw new Error('unexpected require: ' + name)
  }

  // 3) 假的 fetch：health 探针返回服务端那份 nodes（字段与服务端一字不差）
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, parameters: {}, tools: [], nodes, driver: null, handoff: null }),
  })

  const context = {
    get(name) {
      if (name === 'sessions') {
        return {
          list: { getSnapshot: () => ({ current }) },
          refresh: async () => {},
          open: async () => {},
        }
      }
      if (name === 'slots') {
        return {
          inject(_channel, fn) { fn() },
          register(spec, component) { registered = { spec, component } },
        }
      }
      return undefined
    },
    effect(fn) { disposers.push(fn()) },
  }

  // eslint-disable-next-line no-new-func -- 桩环境就是这个测试的目的
  new Function('window', 'require', BUNDLE)(globalThis.window, requireStub)
  assert.ok(loaded !== undefined, 'bundle 必须调用 __ModuleLoader__.load')
  const exportsObject = loaded.factory(requireStub)
  exportsObject.apply(context)

  // 4) `apply` 里已经 tick() 过一次；等它的 promise 链落到 publish()
  await new Promise(resolve => setImmediate(resolve))

  assert.ok(registered !== undefined, '「分叉」页签必须注册进 conversation.view')
  const tree = stub.render({ type: registered.component, props: {}, children: [] })
  return {
    spec: registered.spec,
    tree,
    texts: stub.texts(tree),
    rows: stub.rows(tree),
    stop() { disposers.forEach(fn => { if (typeof fn === 'function') fn() }) },
  }
}
