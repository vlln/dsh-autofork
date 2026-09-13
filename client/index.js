/**
 * dsh-autofork browser half —— 分叉关系 UI + 焦点跟随。
 *
 * ## 为什么自己造 UI，而不复用 subagent 视图
 *
 * 最初的想法是把旧的 driver「归为 subagent」，直接复用官方 subagent 卡片。核实后
 * 发现这条路要被 subagent 的身份模型挡住：
 *
 *  - `history.ts` 要求被寻址的 subagent 满足 `header.origin === 'subagent' ∧
 *    header.parentSession === P`；
 *  - 而 session header 是**不可变**的。
 *
 * 于是"把一个既有 session 登记为另一 session 的 catalog 子项"在寻址路径上必被拒。
 * 但**目标不是复用那个视图**，而是"让用户在同一个视图容器里有一致的体验"。所以这里
 * 自造一个分叉关系 UI —— 也更贴合后续专门的 branch 关系 UI 方向。
 *
 * ## 它做什么
 *
 * 填 `conversation.session.header.utilities` 槽（会话头部常驻），显示两个方向的关系：
 *  - 本会话**分出去**的分叉：`⇄ N 条后台分叉`，展开可逐条跳转；
 *  - 本会话**自己是**分叉：`← 分叉自 …`，可跳回前台。
 *
 * 状态来自对 `/api/dsh-autofork/health` 的轮询（同一个轮询顺带完成焦点交付）。
 * 组件不依赖槽位 props（从本模块的 store 读），把契约风险压到最小。
 *
 * 本文档是**手写产物**：不需要构建步骤，`exports["./client"]` 直接指向它。
 * 契约由 `window.__ModuleLoader__.load({id, factory})` 定义——不调用它，
 * client-modules 会报 "loaded without registering"。
 */
window.__ModuleLoader__.load({
  id: '@vlln/dsh-autofork',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    /** Cordis 客户端插件名。 */
    exports.name = 'dsh-autofork-client'

    /**
     * 需要的客户端服务：会话状态（`open` / `openSubagent`）与槽位。
     *
     * **不要再声明 `uiWorkspace`**：它不提供切会话能力（切会话的正解是
     * `ctx.sessions.open(id)` / `openSubagent(address)`，见下）。声明它只会让
     * "服务缺席就整个客户端插件不加载"这条严格注入规则多一个无谓门槛。
     */
    exports.inject = ['sessions', 'slots']

    var React = require('react')

    /** 本插件 Node half 的 health 路由。 */
    var HEALTH_PATH = '/api/dsh-autofork/health'

    /**
     * 轮询间隔。
     *
     * 1000ms 而不是 2000ms：这条轮询同时承担**交付新 driver**（`handoff`）。用户发出消息后
     * 要"立刻"落到新会话上——2 秒的迟滞会让"打破同步交互"这个承诺打折扣（用户会先看到旧
     * 会话又转了一下）。请求很轻（一条 JSON），1 秒是延迟与代价的折中。
     */
    var POLL_MS = 1000

    /* ------------------------------ 模块级 store ------------------------------ */

    /** UI 快照；轮询写入，React 组件订阅。 */
    var snapshot = { current: undefined, nodes: [], driver: null }

    /** 订阅者集合（组件用）。 */
    var listeners = new Set()

    /**
     * 只在内容真变了才通知——否则每 2 秒一次轮询会让组件无谓重渲染。
     * @param {object} next 新快照。
     */
    function publish(next) {
      var before = JSON.stringify(snapshot)
      var after = JSON.stringify(next)
      if (before === after) return
      snapshot = next
      listeners.forEach(function (fn) { fn() })
    }

    /**
     * @param {Function} fn 订阅回调。
     * @returns {Function} 退订。
     */
    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }

    /** @returns {object} 当前快照。 */
    function getSnapshot() { return snapshot }

    /* ------------------------------ 展示辅助 ------------------------------ */

    /** session id 太长（session-<uuid>），只显示尾部 6 位。 */
    function shortId(id) {
      if (typeof id !== 'string') return '?'
      return id.length <= 6 ? id : id.slice(-6)
    }

    /**
     * 主题令牌。用原生变量才能跟随明暗主题（`--dsw-alias-*` 是会话视图自己在用的那一套）；
     * 变量取不到时退回后面的中性值，绝不因为主题令牌改名就渲染出透明文字。
     */
    var TOKEN = {
      labelPrimary: 'var(--dsw-alias-label-primary, #1a1a1a)',
      labelSecondary: 'var(--dsw-alias-label-secondary, #4d4d4d)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, #808080)',
      caption: 'var(--dsw-alias-label-caption, #9a9a9a)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.10))',
      accent: 'var(--dsw-alias-state-business-primary, #0b6bcb)',
    }

    /**
     * 状态文案：与服务端 `state` 的**三态互斥**取值一一对应。
     *
     * 这里曾经写的是 `运行中 / 已停` 两个词，而服务端那时还并排给了"agent 在不在"与
     * "忙不忙"两个含义不同的字段——于是"活着但空闲"的会话同时显示成运行中与已停
     * （用户实测报的歧义）。现在两边都只有一态一个词。
     */
    var STATE_TEXT = { running: '运行中', idle: '空闲', finished: '已结束' }

    /** 空态/加载态的说明文字样式。 */
    var HINT_STYLE = {
      color: TOKEN.labelTertiary,
      fontSize: '12px',
      lineHeight: '20px',
      maxWidth: '560px',
    }

    /**
     * 状态 → 文案 / 颜色 / 底色。**三态互斥**，与服务端的 `state` 一一对应。
     *
     * 三态是"agent 此刻在干什么"这一个事实的三种取值；曾经服务端并排给过"agent 还在不在"
     * 与"忙不忙"两个字段，于是"活着但空闲"的会话同时显示成运行中与已停（用户实测报的
     * 自相矛盾）。这里把它压成一个标签，颜色只用一种语义。
     */
    var STATE_META = {
      running: { text: '运行中', color: TOKEN.accent, tint: 'rgba(11, 107, 203, 0.12)' },
      idle: { text: '空闲', color: TOKEN.labelSecondary, tint: 'rgba(127, 127, 127, 0.14)' },
      finished: { text: '已结束', color: TOKEN.caption, tint: 'rgba(127, 127, 127, 0.10)' },
    }

    /**
     * 相对时间（页签要回答"这次分叉是多久之前发生的"，而 `1789149220103` 对人没有意义）。
     *
     * 只做**粗粒度**：它是渲染时算的，每 30 秒重渲染一次，粒度细了会看到数字乱跳。
     * @param {number} at epoch ms。
     * @param {number} now 当前时刻。
     * @returns {string} `刚刚` / `N 分钟前` / `N 小时前` / `N 天前`；没有时刻则空串。
     */
    function relTime(at, now) {
      if (typeof at !== 'number' || at <= 0) return ''
      var diff = Math.max(0, now - at)
      var minutes = Math.floor(diff / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return String(minutes) + ' 分钟前'
      var hours = Math.floor(minutes / 60)
      if (hours < 24) return String(hours) + ' 小时前'
      return String(Math.floor(hours / 24)) + ' 天前'
    }

    /**
     * 绝对时刻 `HH:MM` —— 放进悬停提示里，需要精确时可读。
     * @param {number} at epoch ms。
     * @returns {string} 时刻文本；没有则空串。
     */
    function clockOf(at) {
      if (typeof at !== 'number' || at <= 0) return ''
      var date = new Date(at)
      var hh = String(date.getHours())
      var mm = String(date.getMinutes())
      return (hh.length < 2 ? '0' + hh : hh) + ':' + (mm.length < 2 ? '0' + mm : mm)
    }

    /**
     * 一枚小胶囊（状态 / `你在这里` / `现在回答你的是它`）。
     * @param {string} key React key。
     * @param {string} text 文案。
     * @param {string} color 文字与底色都用它派生（底色是同色低透明度，不硬编码主题色）。
     * @param {string} tint 底色。
     * @returns {object} React 元素。
     */
    function chip(key, text, color, tint) {
      return React.createElement('span', {
        key: key,
        style: {
          flex: 'none',
          padding: '1px 6px',
          borderRadius: '999px',
          background: tint,
          color: color,
          fontSize: '11px',
          lineHeight: '16px',
          whiteSpace: 'nowrap',
        },
      }, text)
    }

    /**
     * 家族链条里的一行。
     *
     * 一行要回答三件事（都是用户视角的问题）：
     * ① **这是哪条会话**——名字（`⑂1 修 GUI 卡顿`）+ 会话短 id；
     * ② **它此刻在干什么**——互斥三态中的一态；
     * ③ **这次分叉是为什么、什么时候发生的**——触发它的那条用户指令 + 相对时间。
     *    （③ 是同族几条第名字完全一样时的唯一区分，见 `trigger` 字段。）
     *
     * 只读本模块的 store（不依赖槽位 props），点击走 `navTo()`，也就是那条已经验证过的
     * "先 refresh、再按寻址方式打开、确认 current 真变了"的路。
     * @param {object} props `{node, driver, now}`。
     * @returns {object} React 元素。
     */
    function BranchRow(props) {
      var node = props.node
      var driver = props.driver
      var now = props.now
      var isCurrent = node.current === true
      var isDriver = driver !== null && driver !== undefined && driver.sessionId === node.sessionId
      var isRoot = node.parentId === null || node.parentId === undefined
      var hoverPair = React.useState(false)
      var hover = hoverPair[0]
      var setHover = hoverPair[1]

      var meta = STATE_META[node.state] === undefined
        ? { text: String(node.state), color: TOKEN.labelTertiary, tint: 'transparent' }
        : STATE_META[node.state]
      // 名字优先用服务端给的 `label`（**已经去掉** `<标记><序号> ` 前缀，因为左边那枚徽章
      // 就是它），退回完整 `title`，再退回会话短 id。
      var label = typeof node.label === 'string' && node.label !== ''
        ? node.label
        : (typeof node.title === 'string' && node.title !== ''
          ? node.title
          : '会话 ' + shortId(node.sessionId))
      var ordinal = typeof node.ordinal === 'number' && node.ordinal > 0 ? node.ordinal : 0
      var trigger = typeof node.trigger === 'string' ? node.trigger : ''
      var rel = relTime(node.at, now)
      var clock = clockOf(node.at)

      // 第二行：只渲染**有**的部分。家族根既没有触发指令也没有分叉时刻（它是用户自己
      // 开的会话），于是它那一行只剩会话坐标，而不是一排空标签。
      var info = []
      if (trigger !== '') {
        info.push(React.createElement('span', {
          key: 'trigger',
          title: '触发这次分叉的指令：' + trigger,
          style: {
            minWidth: '0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: TOKEN.labelSecondary,
          },
        }, '触发：' + trigger))
      }
      if (rel !== '') {
        info.push(React.createElement('span', {
          key: 'at',
          title: clock === '' ? '' : '分叉于 ' + clock,
          style: { flex: 'none', color: TOKEN.labelTertiary },
        }, rel))
      }
      info.push(React.createElement('span', {
        key: 'id',
        style: { flex: 'none', color: TOKEN.caption },
      }, shortId(node.sessionId)))

      var topRow = [
        React.createElement('span', {
          key: 'label',
          style: {
            minWidth: '0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: isCurrent ? '600' : '400',
          },
        }, label),
        isCurrent ? chip('here', '你在这里', TOKEN.accent, 'rgba(11, 107, 203, 0.12)') : null,
        isDriver && !isCurrent ? chip('driver', '现在回答你的是它', TOKEN.labelSecondary, 'rgba(127, 127, 127, 0.14)') : null,
        React.createElement('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
        chip('state', meta.text, meta.color, meta.tint),
      ]

      return React.createElement('div', {
        role: 'button',
        tabIndex: 0,
        title: isCurrent ? node.sessionId : '点击切到这条会话（' + node.sessionId + '）',
        'aria-current': isCurrent ? 'true' : undefined,
        onClick: function () { if (!isCurrent) navTo(node.sessionId) },
        onKeyDown: function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (!isCurrent) navTo(node.sessionId)
          }
        },
        onMouseEnter: function () { setHover(true) },
        onMouseLeave: function () { setHover(false) },
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          // 缩进表达树上位置（0 = 家族根）。树是"同一条会话被分叉多次"的多叉，
          // 所以深度缩进 + 行首的 └ 记号，比在行内画连线更省地方也更好读。
          marginLeft: String(node.depth * 14) + 'px',
          padding: '9px 12px',
          border: '1px solid ' + (isCurrent ? TOKEN.accent : 'transparent'),
          borderRadius: '8px',
          background: isCurrent
            ? TOKEN.hover
            : (hover ? TOKEN.hover : 'transparent'),
          cursor: isCurrent ? 'default' : 'pointer',
          // 已结束的行再淡一档：它只是历史，不该跟"正在跑"的抢注意力。
          color: isCurrent
            ? TOKEN.labelPrimary
            : (node.state === 'finished' ? TOKEN.caption : TOKEN.labelSecondary),
        },
      }, [
        React.createElement('span', {
          key: 'badge',
          style: {
            flex: 'none',
            width: '30px',
            height: '20px',
            borderRadius: '5px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: isRoot ? 'rgba(127, 127, 127, 0.12)' : 'rgba(11, 107, 203, 0.12)',
            color: isRoot ? TOKEN.labelSecondary : TOKEN.accent,
            fontSize: '11px',
            fontWeight: '600',
          },
        }, isRoot ? '根' : '⑂' + String(ordinal)),
        React.createElement('div', {
          key: 'body',
          style: { flex: '1 1 auto', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '1px' },
        }, [
          React.createElement('div', {
            key: 'top',
            style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' },
          }, topRow),
          React.createElement('div', {
            key: 'info',
            style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0', fontSize: '12px' },
          }, info),
        ]),
        isCurrent ? null : React.createElement('span', {
          key: 'go',
          style: {
            flex: 'none',
            color: hover ? TOKEN.accent : TOKEN.caption,
            fontSize: '14px',
            lineHeight: '20px',
          },
        }, '›'),
      ])
    }

    /**
     * 「分叉」页签：本会话所在家族的完整家族树，点任意一行切过去。
     *
     * 它取代了原先会话头部右上角那个胶囊下拉（用户 2026-09 决定）：那个位置太窄，
     * 只能显示"现在是谁在回答你"这一个事实；而这条家族树要回答的是一组事实——
     * 家族里有哪几条会话、各自**此刻在干什么**、**分别为什么会分叉出来**（触发指令 + 时间）、
     * 以及**我现在在哪一格**。
     *
     * tab 本身就是原生槽位（`conversation.view` 是个 list 槽，`ui-conversation` 直接遍历
     * 它的条目造 tab 按钮），所以观感与「对话」「轨迹」完全一致，不需要自己造导航。
     * @returns {object} React 元素。
     */
    function BranchView() {
      var pair = React.useState(getSnapshot())
      var setLocal = pair[1]
      React.useEffect(function () {
        return subscribe(function () { setLocal(getSnapshot()) })
      }, [])

      // 相对时间（"3 分钟前"）会随时间变旧，而 store 只在**数据**变化时才通知。
      // 所以自己每 30 秒推一次重渲染：粒度粗到不会看到数字乱跳，也够用来看"这条还在跑多久了"。
      var tickPair = React.useState(0)
      var setTick = tickPair[1]
      React.useEffect(function () {
        var timer = setInterval(function () { setTick(function (value) { return value + 1 }) }, 30000)
        return function () { clearInterval(timer) }
      }, [])
      var now = Date.now()

      var snap = pair[0]
      var nodes = Array.isArray(snap.nodes) ? snap.nodes : []
      var driver = snap.driver === undefined ? null : snap.driver

      var children = []
      if (nodes.length === 0) {
        children.push(React.createElement('div', { key: 'loading', style: HINT_STYLE }, '正在读取分叉关系…'))
      } else {
        var running = nodes.filter(function (node) { return node.state === 'running' }).length
        var done = nodes.filter(function (node) { return node.state === 'finished' }).length
        var summary = ['分叉家族 · ' + String(nodes.length) + ' 条会话']
        if (running > 0) summary.push(String(running) + ' 条正在跑')
        if (done > 0) summary.push(String(done) + ' 条已结束')
        children.push(React.createElement('div', {
          key: 'summary',
          style: { marginBottom: '4px' },
        }, [
          React.createElement('div', {
            key: 'a',
            style: { fontWeight: '600', fontSize: '13px', color: TOKEN.labelPrimary },
          }, summary.join(' · ')),
          React.createElement('div', {
            key: 'b',
            style: { marginTop: '2px', color: TOKEN.labelTertiary, fontSize: '12px' },
          }, nodes.length === 1
            ? '这条会话还没有分叉。'
            : '点任意一行切到那条会话；缩进表示它是从哪条分出去的。'),
        ]))
        children.push(React.createElement('div', {
          key: 'rows',
          style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '10px' },
        }, nodes.map(function (node) {
          return React.createElement(BranchRow, {
            key: node.sessionId, node: node, driver: driver, now: now,
          })
        })))
        if (nodes.length === 1) {
          children.push(React.createElement('div', {
            key: 'empty',
            style: Object.assign({ marginTop: '10px' }, HINT_STYLE),
          }, [
            React.createElement('div', { key: 'a' },
              '当它正在跑（模型还在生成、或工具还在执行）的时候你再发一条指令，'
              + '就会自动分叉出一条新会话：你立刻在新的那条里继续说话，原来这条留在后台把活干完，'
              + '结果回注到这里。'),
            React.createElement('div', { key: 'b', style: { marginTop: '6px' } },
              '分叉出来的会话会带着触发它的那条指令出现在上面，名字是 `⑂1 <本会话名>`。'),
          ]))
        }
      }

      return React.createElement('div', {
        style: {
          display: 'flex',
          flex: '1 1 auto',
          flexDirection: 'column',
          minHeight: '0',
          overflowY: 'auto',
          padding: '18px 24px 28px',
          fontSize: 'var(--dsw-font-xs-13, 13px)',
          lineHeight: '20px',
          color: TOKEN.labelPrimary,
        },
      }, children)
    }

    /**
     * 切到目标 session（经既有客户端服务；由 apply 注入实现）。
     * @param {string} sessionId 目标。
     */
    var navTo = function () { /* 由 apply 覆盖 */ }

    /* ------------------------------ 插件入口 ------------------------------ */

    /**
     * @param {object} ctx 客户端根上下文。
     */
    exports.apply = function (ctx) {
      var sessions = ctx.get('sessions')
      var slots = ctx.get('slots')
      if (sessions === undefined) return

      /**
       * 切到另一条会话。**只有 `sessions.open(id)` 这一条路。**
       *
       * 实测踩过两轮：`uiWorkspace` 上**根本没有**打开会话的方法——运行时探到的形状是
       * `own=[ctx|name|directoryPicker|workspaces|sessions|connecting]`
       * `proto=[constructor|connectWorkspace|startSession|archiveSession|pickDirectory|listDirectory|createDirectory|watchNavigation|clearArchivedCurrent]`，
       * 调 `openSession` 抛 `TypeError: uiWorkspace.openSession is not a function`
       * （决策日志里的 `nav.threw` / `openSession.threw`）。官方客户端里的正解是
       * `ui-workflow-run` 的用法：`ctx.sessions.open(id)`。
       *
       * 仍然**在调用点**读 `sessions.open`，不在 apply 时把它抓成闭包变量：服务可能在
       * 插件 apply 之后才挂上，缓存引用会拿到陈旧的空对象。
       */
      var openSession = function (sessionId) { return sessions.open(sessionId) }

      /**
       * 从**已加载的 catalog** 派生一条子会话的 durable 父地址。
       *
       * 形状逐字对齐官方 `ui-subagent` 的调用点：
       * `openChild({ parentSessionId, childSessionId: entry.id, mode: entry.mode })`，
       * 条目取 `sessions.list` 快照里的 `subagentsByParent[parentId].entries`
       * （客户端把 manager 的 catalogs 投影到那里）。
       *
       * ⚠️ **不要找 `sessions.navigationAddress`**：那个方法在 `SessionManager` 上，
       * **没有**暴露到 `sessions` 服务（服务上只有 `open` / `openSubagent` /
       * `subagentAddress` / `setSubagentCatalogOpen` / `refreshSubagents` …）。
       * 上一版就是这么写的 ⇒ `typeof … === 'function'` 恒为 false ⇒ 静默退回 `open(id)` ⇒
       * 宿主按设计拒绝 subagent 会话。决策日志里只有一行
       * `nav.plain: … (no subagent address)`——看起来像"还没准备好"，其实判据取错了对象。
       *
       * @param {string} childId 子会话 id。
       * @param {string|undefined} parentId 已知的直接父会话（优先用它）。
       * @returns {object|undefined} `{parentSessionId, childSessionId, mode}` 或 undefined。
       */
      function deriveSubagentAddress(childId, parentId) {
        // 1) 客户端已经保留过的地址（官方也先看这个）。
        try {
          if (typeof sessions.subagentAddress === 'function') {
            var retained = sessions.subagentAddress(childId)
            if (retained !== undefined && retained !== null) return retained
          }
        } catch (error) {
          report('nav.retained-threw: ' + String(error))
        }
        // 2) 从已加载的 catalog 条目派生。
        var snap = sessions.list.getSnapshot()
        var catalogs = snap === undefined || snap === null || snap.subagentsByParent === undefined
          ? {}
          : snap.subagentsByParent
        var parents = parentId !== undefined && parentId !== null
          ? [parentId]
          : Object.keys(catalogs)
        for (var index = 0; index < parents.length; index += 1) {
          var catalog = catalogs[parents[index]]
          var entries = catalog === undefined || catalog === null || !Array.isArray(catalog.entries)
            ? []
            : catalog.entries
          for (var entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
            var entry = entries[entryIndex]
            if (entry !== null && entry !== undefined && entry.kind === 'child' && entry.id === childId) {
              return { parentSessionId: parents[index], childSessionId: childId, mode: entry.mode }
            }
          }
        }
        return undefined
      }

      /**
       * 打开一条会话，**按它的寻址方式**打开。
       *
       * 实测踩到的坑（用户 2026-09-11 报的 `历史加载失败：subagent Sessions require their
       * durable parent address（session/agent-busy）`）：`origin:'subagent'` 的会话**不能**用
       * 普通 session 地址打开——宿主 `validateAddress()` 对 `address.kind === 'session'`
       * 且 `header.origin === 'subagent'` 直接抛 `session/agent-busy`。
       * 正确姿势是 `sessions.openSubagent({parentSessionId, childSessionId, mode})`，
       * 且必须**已从父会话的 catalog 派生**（`selectSubagent` 会校验条目存在且 mode 一致）。
       *
       * 顺序：`refreshSubagents(parentSessionId)`（拉父会话 catalog，复用 in-flight）→
       * 派生地址 → `openSubagent(address)`；派生不到才退回 `open(id)`。
       *
       * @param {string} sessionId 目标会话。
       * @param {string|undefined} parentSessionId 已知的直接父会话（分叉交付时服务端会给）。
       * @returns {Promise<void>} 打开完成。
       */
      function openAddressed(sessionId, parentSessionId) {
        var listState = sessions.list.getSnapshot()
        var anchor = parentSessionId !== undefined
          ? parentSessionId
          : (listState === undefined || listState === null ? undefined : listState.current)
        var loadCatalog = anchor === undefined || typeof sessions.refreshSubagents !== 'function'
          ? Promise.resolve()
          : Promise.resolve(sessions.refreshSubagents(anchor)).catch(function (error) {
            report('catalog.refresh-failed: ' + String(error))
          })
        return loadCatalog.then(function () {
          var address = deriveSubagentAddress(sessionId, parentSessionId)
          if (address !== undefined && typeof sessions.openSubagent === 'function') {
            sessions.openSubagent(address)
            report('nav.subagent: ' + sessionId + ' via ' + String(address.parentSessionId)
              + ' mode=' + String(address.mode))
            return
          }
          openSession(sessionId)
          report('nav.plain: ' + sessionId + ' (no subagent address)')
        })
      }


      /**
       * 报告某个对象的实际形状——取不到方法时用它一次定位，不必再猜。
       * @param {string} label 标记。
       * @param {any} value 被检查的对象。
       * @returns {string} 形状描述。
       */
      function shapeOf(label, value) {
        try {
          var own = Object.keys(value === null || value === undefined ? {} : value)
          var proto = value === null || value === undefined
            ? []
            : Object.getOwnPropertyNames(Object.getPrototypeOf(value)).slice(0, 24)
          return label + ': type=' + typeof value
            + ' own=[' + own.slice(0, 12).join('|') + ']'
            + ' proto=[' + proto.join('|') + ']'
        } catch (error) {
          return label + ': shape-failed ' + String(error)
        }
      }

      var timer = null
      var stopped = false

      navTo = function (sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        // 与交付路径同样要先 refresh：目标 session 可能还没进客户端列表
        Promise.resolve()
          .then(function () { return sessions.refresh() })
          .catch(function (error) { report('nav.refresh-failed: ' + String(error)) })
          .then(function () { return openAddressed(sessionId, undefined) })
          .then(function () { report('nav.ok: ' + sessionId) })
          .catch(function (error) {
            report('nav.threw: ' + String(error) + ' || ' + shapeOf('sessions', sessions))
          })
      }

      /** 停掉轮询。 */
      function stopPolling() {
        if (timer === null) return
        clearInterval(timer)
        timer = null
      }

      /**
       * 向服务端回报一句（落进决策日志）。客户端 half 跑在浏览器里，
       * 没有这条通道时它的任何失败都是纯黑盒。
       * @param {string} note 回报内容。
       */
      function report(note) {
        fetch(HEALTH_PATH + '?client=1&note=' + encodeURIComponent(note), {
          headers: { accept: 'application/json' },
        }).catch(function () { /* 回报失败本身不必再报 */ })
      }

      /**
       * 交付一条分叉：先刷新列表，再切焦点，**验证 current 真的变了**才 ack。
       * @param {string} branchId 目标分叉 session id。
       */
      function deliver(branchId, parentSessionId) {
        Promise.resolve()
          .then(function () { return sessions.refresh() })
          .catch(function (error) { report('refresh.failed: ' + String(error)) })
          .then(function () {
            return openAddressed(branchId, parentSessionId)
          })
          .catch(function (error) {
            report('openSession.threw: ' + String(error) + ' || ' + shapeOf('sessions', sessions))
          })
          .then(function () {
            var after = sessions.list.getSnapshot()
            var current = after === undefined || after === null ? undefined : after.current
            if (current === branchId) {
              report('handoff.delivered: ' + branchId)
              fetch(HEALTH_PATH + '?client=1&ack=' + encodeURIComponent(branchId), {
                headers: { accept: 'application/json' },
              }).catch(function () {})
              // **不停轮询**：ack 已让服务端不再重复提供这条交付，而分叉关系 UI
              // 还需要持续的状态。停止轮询只会让 UI 冻结。
            } else {
              // 没切成：**不 ack**，下次轮询服务端会再提供同一条，自动重试
              report('handoff.pending: want=' + branchId + ' current=' + String(current))
            }
          })
      }

      /**
       * 问一次服务端：分叉关系 + 待交付的分叉。
       * @param {string} sessionId 当前打开的 session。
       */
      function poll(sessionId) {
        if (stopped) return
        var url = HEALTH_PATH + '?client=1&consume=1&sessionId=' + encodeURIComponent(sessionId)
        fetch(url, { headers: { accept: 'application/json' } })
          .then(function (response) { return response.ok ? response.json() : undefined })
          .then(function (body) {
            if (stopped || body === undefined || body.ok !== true) return
            publish({
              current: sessionId,
              // 服务端算好的家族**链条**（根 → 最新，含本会话自己）：`title` / `state` /
              // `depth` / `current` / `parentId`。`state` 是互斥三态（running|idle|finished）
              // ——不再是"agent 在不在"和"忙不忙"两个含义不同的字段并排。
              nodes: Array.isArray(body.nodes) ? body.nodes : [],
              // 服务端算好的"当前 driver"（链上最新的 head，没有下游就是本会话）。
              driver: body.driver === undefined ? null : body.driver,
            })
            var handoff = body.handoff
            // 字段名必须与服务端一致：链式模型重写时服务端改成了 `sessionId`
            // （headId），客户端没跟着改 → 上一版在这里静默 early return，
            // 于是"分叉成功但不切焦点"（实测踩到，决策日志里 handoff 一直在返回
            // 却没有任何 handoff.delivered / openSession.threw 回报）。
            if (handoff === null || handoff === undefined) return
            var headId = typeof handoff.sessionId === 'string' ? handoff.sessionId : undefined
            if (headId === undefined) {
              report('handoff.unknown-shape: ' + JSON.stringify(handoff))
              return
            }
            // `parentSessionId` 是服务端给的**直接父会话**：子会话的寻址地址要从它的
            // subagent catalog 派生，见 openAddressed()。
            var parentId = typeof handoff.parentSessionId === 'string'
              ? handoff.parentSessionId
              : undefined
            deliver(headId, parentId)
          })
          .catch(function (error) { report('poll.failed: ' + String(error)) })
      }

      /** 按当前会话取一次数据。 */
      function tick() {
        if (stopped) return
        var snap = sessions.list.getSnapshot()
        var current = snap === undefined || snap === null ? undefined : snap.current
        if (current === undefined || current === null) {
          publish({ current: undefined, nodes: [], driver: null })
          return
        }
        poll(current)
      }

      // **不把启动押在订阅上**。实测：页面在"尚无当前会话"时加载，之后选中会话
      // 并没有触发 `sessions.list.subscribe` 的回调，于是轮询一次都没跑
      // （决策日志里 `slot.mounted` 有、`health.request` 为 0）。改成无条件定时
      // tick，每次重新读 current——少一个无法验证的契约。
      timer = setInterval(tick, POLL_MS)
      tick()

      // 「分叉」页签：`conversation.view` 是 **list 槽**，`ui-conversation` 直接遍历它的
      // 条目造 tab 按钮（`{id, label}`，`order` 决定左右位置），官方「轨迹」就是这么注册的
      // （`id:'trajectory', order:10`）。所以这里注册出来的 tab 与「对话」「轨迹」完全同族，
      // 不需要自己造导航，也不碰任何我无法在服务端验证的私有契约。
      //
      // 组件的状态全部来自本模块的 store（轮询写入），**不读槽位 props**：少依赖一个契约，
      // 就少一处只能在浏览器里才暴露的失败模式。
      if (slots !== undefined) {
        slots.inject('conversation.view', function () {
          report('view.mounted')
          return slots.register({
            name: 'conversation.view',
            id: 'branch',
            order: 20,
            label: function () { return '分叉' },
            inject: function () { return {} },
          }, BranchView)
        })
      }

      /* ------------------- 从头部胶囊改为页签（2026-09，用户决定） ------------------- */

      // 之前这里注册的是 `conversation.session.header.utilities` 里的一个胶囊下拉
      // （「driver：分叉 xxxx」/「容器：本会话 · 后台 N 条」）。用户实测后的结论是
      // **取消右上角那个 UI**：那个位置只能承载一个事实，而真正要回答的是一组事实
      // （有哪些会话、各自什么状态、我在哪一格）。现在由上面的「分叉」页签承载。
      //
      // 顺带说明为什么**不**用原生血脉槽位 `conversation.session.header.lineage` 来完成
      // 这件事：它是 **single** 槽，已被 `ui-subagent` 占用，第二次注册会直接抛
      // `single slot "…" already has a registration`（在 ui-slots 源码里核过）。
      //
      // 另外记一笔（免得后人重走）：`conversation.view` 上曾经挂过一个探路用的「容器」页签，
      // 目标是"在一条会话的视图里渲染另一条会话的原生转写"。那条路已实证走不通
      // （`dsh-client-ui-chat/client` 不导出转写渲染器、`ConversationViewRegistry` 没有
      // 跨 session 派发的 API、`page`/`follow` 两个 RPC 都是 session-addressed）。
      // 现在的「分叉」页签**不渲染别的会话的转写**，只画关系 + 负责跳转，所以不受那条结论影响。
      // 全部实证见 docs/proposal-session-container-view.md 与 AGENTS.local.md 事实 11。

      ctx.effect(function () {
        return function () {
          stopped = true
          stopPolling()
        }
      }, 'dsh-autofork: 分叉关系 UI 与交付轮询')
    }

    return exports
  },
})
