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
 * 注册 `conversation.view` 里一个「分叉」页签（与「对话」「轨迹」并列），画本会话所在的
 * 分叉家族：每条会话一行（名字 / 状态 / 触发指令 / 分叉时刻），点一行跳到那条会话。
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
     * 需要的客户端服务：
     *  · `sessions` —— 列表快照（`list`）、子会话地址（`subagentAddress`）、投影刷新
     *    （`refreshProjections`）与列表刷新（`refresh`）；
     *  · `uiWorkspace` —— **切换当前会话的唯一入口**（`openSession(target)`，见下）；
     *  · `slots` —— 注册「分叉」页签。
     *
     * `uiWorkspace` 必须声明：0.2.0 起 `sessions` 服务只负责"目录与引用"，会话选择属于
     * 视图所有者（`dsh-client-ui-workspace` 的 UiWorkspaceService），导航动作在
     * `openSession`。服务缺席时本插件做不到"把用户切到分叉上"，与其静默失效不如让
     * 严格注入规则把整个客户端条目拦住（web 组合里 ui-workspace 恒在）。
     */
    exports.inject = ['sessions', 'uiWorkspace', 'slots']

    var React = require('react')

    /**
     * 可选的同伴模块。**必须容错**：`require` 抛出会让整个 bundle 的工厂失败，浏览器报
     * "loaded without registering" —— 整条客户端插件（含「分叉」页签与焦点交付）一起消失。
     * 所以拿不到就降级，绝不因为一个可选控件让主体功能不可用。
     *
     * `react-dom` 在 0.2.0 的种子表里（`createPortal` 用它把「分叉」按钮挂进队列行）；
     * primitives 也在种子里，用它的图标与控件让观感与官方一致。
     */
    var reactDom = tryRequire('react-dom')
    var primitives = tryRequire('@deepseek-ai/dsh-client-ui-primitives') || {}

    /**
     * 取一个可选模块，拿不到返回 undefined。
     * @param {string} name 模块名。
     * @returns {any} 模块命名空间，或 undefined。
     */
    function tryRequire(name) {
      try {
        return require(name)
      } catch (error) {
        return undefined
      }
    }

    /** 本插件 Node half 的 health 路由。 */
    var HEALTH_PATH = '/api/dsh-autofork/health'

    /**
     * 手动分叉的动作路由（Node half 注册）。**必须带 `FORK_HEADER`**：自定义头让跨站
     * 请求需要 CORS 预检，而服务端不回应预检 ⇒ 任何网页都无法对本地端口发起本动作
     * （无自定义头的"简单 JSON 请求"本来可以绕过同源策略）。
     */
    var FORK_PATH = '/api/dsh-autofork/fork'

    /** 动作路由要求的自定义请求头（与 Node half 的 `FORK_HEADER` 必须一字不差）。 */
    var FORK_HEADER = 'x-dsh-autofork'

    /** 设置命名空间 = Node half 的**条目 id**（`cordis.patch.yml` 的 `insert.id`），不是包名。 */
    var SETTINGS_NS = 'dsh-autofork'

    /** `plugins.bundle.config` 是 **keyed 槽**：key = bundle **包名**（与命名空间不同）。 */
    var BUNDLE_PKG = '@vlln/dsh-autofork'

    /** 队列行上「分叉」按钮的 DOM 属性（样式表也按它选）。 */
    var FORK_ATTR = 'data-dsh-autofork-fork'

    /**
     * 本插件卡片（分叉通知 / 在飞摘要 / 后台回传）的**节点 kind**。
     *
     * 为什么不直接用官方的 turn-trigger 卡片：官方判据是
     * `nextTurn.currentClaimed.has(id) || idleSteer`，而 `ReactLoopInbox.claim` 的粒度是
     * **next-turn 每轮只认领 1 条**。于是"两条卡 + 用户那条指令 + 只跑一次模型请求"在官方路径下
     * 不可能成立：卡片 = 本轮开场触发，一轮只能有一张，多一张就多一轮（= 多一次请求，用户实测报过）。
     * 所以宿主把三条都**直接落盘**，卡片由本模块注册的节点视图渲染（形状照抄官方 trigger 卡片）。
     */
    var CARD_KIND = 'autofork-message'

    /** 卡片根节点的 DOM 属性（样式按它选）。 */
    var CARD_ATTR = 'data-dsh-autofork-card'

    /** 标记 → 卡片标题（`source.autofork`，宿主 half 与这里必须一字不差）。 */
    var CARD_TITLES = {
      notice: '分叉通知',
      digest: '在飞进度',
      reply: '后台会话回复',
    }

    /** 回退条容器的 DOM 属性。 */
    var FORKBAR_ATTR = 'data-dsh-autofork-forkbar'

    /**
     * 把一句回报发回 Node half 的决策日志。
     *
     * 客户端 half 跑在浏览器里，没有这条通道时它的任何失败都是纯黑盒——这是本插件从第一版
     * 起就有的诊断面。定义在模块级（而不是 `apply` 内）是为了让子组件也能用。
     * @param {string} note 回报内容。
     * @returns {void}
     */
    function postNote(note) {
      try {
        fetch(HEALTH_PATH + '?client=1&note=' + encodeURIComponent(note), {
          headers: { accept: 'application/json' },
        }).catch(function () { /* 回报失败本身不必再报 */ })
      } catch (error) { /* fetch 不可用时静默：诊断面不得反过来弄坏主体 */ }
    }

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
    var snapshot = { current: undefined, nodes: [], driver: null, mode: 'auto' }

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

    /* ------------------------------ 手动分叉：队列那一行 ------------------------------ */

    /**
     * 一条消息内容的一行预览（队列行上认人的那一眼）。
     * @param {any} content 消息 content（ContentBlock 数组）。
     * @returns {string} 折叠空白后的有界文本，没有文本部分时为空串。
     */
    function previewOf(content) {
      if (!Array.isArray(content)) return ''
      for (var index = 0; index < content.length; index += 1) {
        var part = content[index]
        if (part !== null && part !== undefined && part.type === 'text' && typeof part.text === 'string') {
          var text = part.text.replace(/\s+/gu, ' ').trim()
          if (text === '') continue
          return text.length > 60 ? text.slice(0, 59) + '…' : text
        }
      }
      return ''
    }

    /**
     * 队列里**可被分叉**的那些条目（手动模式下每一条都要有「分叉」入口）。
     *
     * 过滤规则**逐条复刻** `ui-conversation` 的 `QueueDock`（否则按钮会挂错行）：
     * 取 `inbox['next-turn']`，剔除已经在聊天转写里出现的本地回声（`placement === 'transcript'`），
     * 而**只在等宿主接纳**的本地回声（`placement === 'queued'`）没有宿主消息 id，无法作为
     * 分叉对象，故不进本表——它的「分叉」按钮要等宿主那一行回来才出现（通常几十毫秒）。
     * @param {any} inbox `useProjection('inbox')` 的值。
     * @param {any} pendingSubmissions `useSession(s => s.pendingSubmissions)` 的值。
     * @returns {Array<{id: string, preview: string}>} 按队列顺序的可分叉条目。
     */
    function queuedForkables(inbox, pendingSubmissions) {
      var rows = inbox !== null && inbox !== undefined && Array.isArray(inbox['next-turn'])
        ? inbox['next-turn']
        : []
      var submissions = Array.isArray(pendingSubmissions) ? pendingSubmissions : []

      var inTranscript = {}
      var transcriptCount = 0
      for (var index = 0; index < submissions.length; index += 1) {
        if (submissions[index]?.placement !== 'transcript') continue
        inTranscript[submissions[index].requestId] = true
        transcriptCount += 1
      }

      var queue = rows
      if (transcriptCount > 0) {
        queue = rows.filter(function (row) {
          var source = row?.source
          if (source === undefined || source === null || source.kind !== 'user') return true
          if (!Object.prototype.hasOwnProperty.call(source, 'rpcId')) return true
          return inTranscript[source.rpcId] !== true
        })
      }

      return queue
        .filter(function (row) { return typeof row?.id === 'string' && row.id !== '' })
        .map(function (row) { return { id: row.id, preview: previewOf(row.content) } })
    }

    /**
     * 队列 dock 每一行的 DOM 挂载点。
     *
     * `QueueDock` 的根节点带 `data-queue-dock` 属性、每行是一个 `<li>`——这是**非公开 DOM
     * 契约**（官方没有给"往队列行里加按钮"的槽）。因此这里**只读不写别人的结构**：取不到
     * 就返回空数组，调用方退回自己画一条回退条——绝不猜、不乱插。
     * @param {any} root 查询根（浏览器里是 `document`）。
     * @param {number} count 需要几行的挂载点。
     * @returns {Array<any>} 长度为 count 的数组，缺失位置是 null。
     */
    function queueRowTargets(root, count) {
      var nodes = root !== null && root !== undefined && typeof root.querySelectorAll === 'function'
        ? root.querySelectorAll('[data-queue-dock] li')
        : []
      var targets = []
      for (var index = 0; index < count; index += 1) {
        targets.push(nodes[index] === undefined ? null : nodes[index])
      }
      return targets
    }

    /**
     * 这个节点在队列 dock 的子树里吗（含自身）。
     * @param {any} node DOM 节点。
     * @returns {boolean} 是否属于队列 dock。
     */
    function insideQueueDock(node) {
      var current = node
      for (var depth = 0; depth < 32 && current !== null && current !== undefined; depth += 1) {
        if (current.nodeType === 1 && typeof current.hasAttribute === 'function'
          && current.hasAttribute('data-queue-dock')) {
          return true
        }
        current = current.parentNode
      }
      return false
    }

    /**
     * 这批 DOM 变动碰到队列 dock 了吗。
     *
     * 用途：`MutationObserver` 挂在 `document.body` 上（队列 dock 可能还没挂载），但**只在
     * 队列那一块动了才重渲染**——否则流式输出每帧都会让本组件跟着重画一次。
     * @param {any[]} mutations MutationRecord 数组。
     * @returns {boolean} 是否需要重渲染。
     */
    function touchesQueueDock(mutations) {
      for (var index = 0; index < mutations.length; index += 1) {
        var mutation = mutations[index]
        if (insideQueueDock(mutation?.target)) return true
        var added = mutation?.addedNodes
        for (var position = 0; added !== undefined && position < added.length; position += 1) {
          if (insideQueueDock(added[position])) return true
        }
      }
      return false
    }

    /**
     * 发一次手动分叉请求。
     * @param {string} sessionId 目标会话。
     * @param {string} messageId 队列里那条消息的 id。
     * @returns {Promise<{ok: boolean, sessionId?: string, error?: string}>} 服务端结论。
     */
    function forkRequest(sessionId, messageId) {
      var headers = { 'content-type': 'application/json' }
      headers[FORK_HEADER] = '1'
      return fetch(FORK_PATH, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ sessionId: sessionId, messageId: messageId }),
      }).then(function (response) {
        return response.json().catch(function () { return undefined }).then(function (body) {
          if (body !== undefined && body !== null && typeof body === 'object') return body
          return { ok: false, error: 'http-' + String(response.status) }
        })
      })
    }

    /**
     * 给一个控件挂上官方悬停提示（拿不到 primitives 时退回原生 `title`）。
     * @param {string} label 提示文案。
     * @param {object} element 控件元素。
     * @returns {object} 可能被包了一层的元素。
     */
    function withTooltip(label, element) {
      if (typeof primitives.Tooltip !== 'function') return element
      return React.createElement(primitives.Tooltip, {
        portal: true,
        label: label,
        side: 'bottom',
        delayMs: 500,
      }, element)
    }

    /**
     * 队列行右侧那枚「分叉」按钮（点它才分叉这条排队中的指令）。
     *
     * **观感必须与旁边的官方按钮一模一样**（编辑 / 删除 / 转向）：官方那几个是
     * **图标按钮**——28×28 圆形、14px 图标、无文字、悬停提示在 Tooltip 里
     * （`QueueDock.module.css` 的 `.action`）。所以这里也只放图标：
     * 文字版会比旁边宽一倍、圆角形状也不同，一眼就看得出是外挂的。
     *
     * 状态只体现在**颜色与提示文案**上，几何形状不变：
     * idle 三级文字色 / busy 半透明（`:disabled` 的 .45）/ failed 错误色 + 提示说明可再点一次。
     *
     * 单击即发请求；服务端是唯一权威——它只认"这条消息此刻仍在那个 agent 的队列里"，
     * 抢不到就回 409，本按钮转成失败态并把原因回报进决策日志（`client.note`）。
     * 不自动重试：同一条消息点第二次是用户的决定，不是我们的。
     * @param {object} props `{ sessionId, messageId, preview }`。
     * @returns {object} React 元素。
     */
    function ForkButton(props) {
      var pair = React.useState('idle')
      var phase = pair[0]
      var setPhase = pair[1]

      var submit = function () {
        if (phase === 'busy') return
        setPhase('busy')
        forkRequest(props.sessionId, props.messageId)
          .then(function (result) {
            if (result.ok === true) {
              setPhase('idle')
              postNote('fork.button.ok: ' + props.messageId + ' -> ' + String(result.sessionId))
              return
            }
            setPhase('failed')
            postNote('fork.button.refused: ' + props.messageId + ' ' + String(result.error))
          })
          .catch(function (error) {
            setPhase('failed')
            postNote('fork.button.failed: ' + props.messageId + ' ' + String(error))
          })
      }

      // 提示文案：官方同级按钮是「编辑 / 删除 / 转向」这种一个词，所以常态也只给「分叉」；
      // 这条指令本身是什么，交给 aria-label（读屏能听全，视觉上不占位）。
      var tooltip = phase === 'busy' ? '分叉中…' : (phase === 'failed' ? '分叉失败，可再点一次' : '分叉')
      var icon = typeof primitives.IconBranchOutlineRegular === 'function'
        ? React.createElement(primitives.IconBranchOutlineRegular, { size: 14 })
        // 拿不到官方图标时用分支符号顶上：字号与图标同量级，几何形状不受影响。
        : React.createElement('span', { style: { fontSize: '14px', lineHeight: 1 } }, '⑂')

      var attributes = {
        type: 'button',
        className: 'dsh-autofork-fork',
        'aria-label': '分叉这条排队中的指令：' + props.preview,
        disabled: phase === 'busy',
        onClick: submit,
      }
      attributes[FORK_ATTR] = ''
      if (phase === 'failed') attributes['data-tone'] = 'error'
      // 有官方 Tooltip 时不要再挂原生 `title`（会与它叠成两个提示）；没有时 title 是唯一的说明面。
      if (typeof primitives.Tooltip !== 'function') attributes.title = tooltip

      return withTooltip(tooltip, React.createElement('button', attributes, [icon]))
    }

    /**
     * 队列行内的「分叉」按钮注入点（`conversation.input.dock` 的 list 槽条目）。
     *
     * ## 为什么是 DOM 注入而不是槽
     *
     * 队列行右侧那几个按钮（编辑 / 删除 / 转向）写死在官方 `QueueDock` 里，`QueueAction`
     * 也是 `edit | remove | steer` 的封闭联合——插件层**没有**"往一条队列行加动作"的槽，
     * 也没法接管或包裹别人已注册的槽条目（注册绑在各自 fiber 上）。所以这里用官方留的
     * `conversation.input.dock` 槽**只做一件事**：用 `createPortal` 把自己的按钮挂进那一行。
     *
     * ## 契约与失败模式（都是"不出现"，不是"做错事"）
     *
     *  · 只认 `[data-queue-dock] li` 这个非公开 DOM 契约；结构变了 → 挂载点取不到 →
     *    本组件退回画一条右对齐的回退条（每条排队指令一个按钮），功能仍在；
     *  · 队列面板**收起**（多于一条时行整体不在 DOM 里）→ 同上走回退条；
     *  · 没有 `react-dom`（非 web 组合）→ 只走回退条；
     *  · 模式不是手动（`mode !== 'manual'`）→ 整条不渲染。
     * @param {object} props 槽运行时 props（session 作用域：`sessionId` / `useProjection` / `useSession`）。
     * @returns {any} 门户数组、回退条，或 null。
     */
    function ForkDock(props) {
      var pair = React.useState(getSnapshot())
      var setSnapshot = pair[1]
      React.useEffect(function () {
        return subscribe(function () { setSnapshot(getSnapshot()) })
      }, [])

      var sessionId = props.sessionId
      var inbox = typeof props.useProjection === 'function' ? props.useProjection('inbox') : undefined
      var pending = typeof props.useSession === 'function'
        ? props.useSession(function (state) { return state.pendingSubmissions })
        : undefined
      var forkables = queuedForkables(inbox, pending)

      var snap = pair[0]
      // 以**服务端**为准：只有宿主此刻真的按手动模式行事时，按钮才出现。
      var manual = snap.mode === 'manual' && snap.current === sessionId

      var bumpPair = React.useState(0)
      var bump = bumpPair[1]
      var signature = forkables.map(function (row) { return row.id }).join('\u0000')

      // 队列面板从"收起"变"展开"时行才进 DOM，而队列长度没变——所以还得听 DOM 变化。
      // 只在**队列 dock 子树**变动时重渲染：整页 DOM 变化（流式输出）不该让本组件跟着重画。
      React.useEffect(function () {
        if (!manual || forkables.length === 0 || reactDom === undefined) return undefined
        if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return undefined
        var observer = new MutationObserver(function (mutations) {
          if (!touchesQueueDock(mutations)) return
          bump(function (value) { return value + 1 })
        })
        observer.observe(document.body, { childList: true, subtree: true })
        return function () { observer.disconnect() }
      }, [signature, manual, sessionId])

      if (!manual || forkables.length === 0) return null

      // 挂载点**在渲染期直接解析**：DOM 已提交，读到的就是这一刻的队列行。读不到（结构变了 /
      // 面板收起 / 没有 react-dom）就退回下面那条回退条——"不出现"是唯一的失败模式。
      var targets = reactDom === undefined
        ? []
        : queueRowTargets(typeof document === 'undefined' ? undefined : document, forkables.length)

      var portals = []
      if (reactDom !== undefined && typeof reactDom.createPortal === 'function') {
        for (var index = 0; index < forkables.length; index += 1) {
          var node = targets[index]
          if (node === undefined || node === null) continue
          portals.push(reactDom.createPortal(
            React.createElement(ForkButton, {
              sessionId: sessionId,
              messageId: forkables[index].id,
              preview: forkables[index].preview,
            }),
            node,
            forkables[index].id,
          ))
        }
      }
      if (portals.length > 0) return portals

      // 回退条：行不在 DOM 里（面板收起）或拿不到 react-dom 时，每条排队指令仍各有一个入口。
      // 间距与官方 `.actions` 的 10px 对齐（按钮本身样式同 `.action`，见 installForkStyles）。
      var barProps = {
        style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      }
      barProps[FORKBAR_ATTR] = ''
      return React.createElement('div', barProps,
        forkables.map(function (row) {
          return React.createElement(ForkButton, {
            key: row.id,
            sessionId: sessionId,
            messageId: row.id,
            preview: row.preview,
          })
        }))
    }

    /* ------------------------------ 手动分叉：开关在哪 ------------------------------ */

    /**
     * 把「分叉方式」写进设置文档，并按宿主回读值确认真的落库了。
     *
     * 不自己传 `expectedRevision`：官方 `ConfigFormController` 自己按 `pendingRevision`
     * 串行排队并给后继写定栅栏；自己传快照 revision 会绕过那道栅栏，同一 RTT 内的连续改动
     * 会被宿主按 CAS 拒（第一次其实已落库），结果是误报"未被接受"。
     * @param {any} scope `configForms.get(SETTINGS_NS)` 的 ConfigFormController。
     * @param {string} value 目标取值（`'auto'` / `'manual'`）。
     * @returns {Promise<void>} 未被接受时抛错（卡片据此提示并回读宿主值）。
     */
    function writeForkMode(scope, value) {
      return Promise.resolve(scope.mutate([{ op: 'set', path: ['forkMode'], value: value }]))
        .then(function (accepted) {
          var committed = scope.getSnapshot()?.value
          var landed = committed === null || committed === undefined ? undefined : committed.forkMode
          if (accepted !== true || landed !== value) {
            throw new Error('dsh-autofork: 设置写入未被接受（forkMode=' + value + '）')
          }
        })
    }

    /** 两种方式的说明文案（卡片下方一行）。 */
    var MODE_HINT = {
      auto: '忙的时候你提交的指令会立刻在新会话里开始执行（本插件的原始行为）。',
      manual: '忙的时候你提交的指令照常排队；在队列那条指令上点「分叉」才分叉。',
    }

    /**
     * Plugins 页上本插件的设置卡片（`plugins.bundle.config` keyed 槽，key = bundle 包名）。
     *
     * 与官方通用设置页同一种保存语义：**改动即时写入**，没有保存按钮——官方设置页的开关与
     * 选项都是"改即落库"，只有部分页面用页脚保存。
     * @param {object} props 槽 props（`view` / `t`）加注入面（`useForkSettings` / `writeForkMode`）。
     * @returns {any} 一行描述（`summary` 视图）、设置区，或 null（命名空间不可用）。
     */
    function ForkSettingsCard(props) {
      var state = props.useForkSettings(function (value) { return value })
      var pair = React.useState(false)
      var failed = pair[0]
      var setFailed = pair[1]

      if (props.view === 'summary') return '自动分叉 / 手动分叉'
      if (state === null || state === undefined || state.status === 'unavailable') return null

      var current = state.value !== null && state.value !== undefined && state.value.forkMode === 'manual'
        ? 'manual'
        : 'auto'
      var disabled = state.writable !== true

      var choose = function (value) {
        if (disabled || value === current) return
        setFailed(false)
        Promise.resolve(props.writeForkMode(value)).catch(function (error) {
          setFailed(true)
          postNote('settings.write-refused: ' + String(error))
        })
      }

      var control = typeof primitives.SegmentedControl === 'function'
        ? React.createElement(primitives.SegmentedControl, {
          id: 'dsh-autofork-mode',
          label: '分叉方式',
          value: current,
          disabled: disabled,
          options: [
            { value: 'auto', label: '自动分叉' },
            { value: 'manual', label: '手动分叉' },
          ],
          onChange: choose,
        })
        : React.createElement('div', { style: { display: 'flex', gap: '8px' } },
          ['auto', 'manual'].map(function (value) {
            return React.createElement('button', {
              key: value,
              type: 'button',
              className: 'dsh-autofork-fork',
              'aria-pressed': current === value,
              disabled: disabled,
              onClick: function () { choose(value) },
            }, value === 'auto' ? '自动分叉' : '手动分叉')
          }))

      return React.createElement('div', {
        'data-dsh-autofork-settings': '',
        style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0' },
      },
      React.createElement('span', {
        style: { fontSize: '13px', fontWeight: '500', lineHeight: '20px', color: TOKEN.labelPrimary },
      }, '分叉方式'),
      control,
      React.createElement('span', {
        style: { fontSize: '12px', lineHeight: '18px', color: TOKEN.labelTertiary },
      }, MODE_HINT[current]),
      failed ? React.createElement('span', {
        role: 'status',
        style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #c62828)' },
      }, '刚才的改动未被接受，已回读当前值。') : null,
      )
    }

    /**
     * 注册设置卡片。
     *
     * 走**嵌套** `ctx.inject(['configForms'])` 而不是顶层 `inject`：`ui-settings` 缺席的
     * 组合里整条客户端插件仍要能用（顶层缺服务会让 apply 直接抛，插件的其他功能一起消失）。
     *
     * 注册**不**经 `configForms.whileServed()`（官方页面的写法）：本卡片只出现在**本插件自己的
     * 包页**上，而 `plugins.bundle.config` 的 keyed 槽本身就是渲染条件——服务缺席时卡片自己
     * 渲染成空，比"整个槽位时有时无"更少一种只在浏览器里才暴露的失败模式。
     * @param {any} ctx 客户端插件上下文。
     * @param {any} slots 槽服务。
     * @returns {void}
     */
    function registerForkSettings(ctx, slots) {
      // 整段**包在 try 里**：设置卡片是可选能力，而这条路径（嵌套 inject + configForms 的形状）
      // 只在浏览器里才能真验。任何一步不如预期都必须是"卡片不出现"，绝不能把 apply 抛掉——
      // 那会连带「分叉」页签与焦点交付一起消失（比少一个设置项严重得多）。
      try {
        if (typeof ctx.inject !== 'function') {
          postNote('settings.no-inject: 客户端 ctx 没有 inject，设置卡片未注册')
          return
        }
        ctx.inject(['configForms'], function (formCtx) {
          var forms = formCtx.configForms
          if (forms === undefined || forms === null || typeof forms.get !== 'function') {
            postNote('settings.no-config-forms: configForms 服务形状不符，设置卡片未注册')
            return
          }
          var scope = forms.get(SETTINGS_NS)
          slots.inject('plugins.bundle.config', function () {
            return slots.register({
              name: 'plugins.bundle.config',
              key: BUNDLE_PKG,
              inject: function () {
                return {
                  hooks: {
                    forkSettings: {
                      getSnapshot: function () { return scope.getSnapshot() },
                      subscribe: function (listener) { return scope.subscribe(listener) },
                    },
                  },
                  writeForkMode: function (value) { return writeForkMode(scope, value) },
                }
              },
            }, ForkSettingsCard)
          })
        })
      } catch (error) {
        postNote('settings.register-failed: ' + String(error))
      }
    }

    /**
     * 注入本插件的那几行样式（表里的 `:hover` 没法用内联样式表达）。
     * @returns {Function} 卸载函数；本次没创建时是空操作。
     */
    /* ------------------------- 卡片（消息卡，照抄官方 trigger 观感） ------------------------- */

    /**
     * 消息卡的样式：**逐条照抄官方 `TurnTriggerNodeView.module.css`**（插件拿不到那个 CSS module
     * 的哈希类名，只能复刻声明），只把类名前缀换成我们自己的属性选择器。这样这三张卡片与官方
     * 「收到任务消息」卡片在边框、圆角、留白、字号、折叠行为上完全一致。
     * @returns {() => void} 卸载函数。
     */
    function installCardStyles() {
      if (typeof document === 'undefined' || document.head === null || document.head === undefined) {
        return function () {}
      }
      var element = document.createElement('style')
      element.id = 'dsh-autofork-card-styles'
      element.textContent = [
        '[data-dsh-autofork-card]{border:.5px solid var(--dsw-alias-border-l1);',
        'border-radius:var(--dsw-radius-xl);',
        'background:var(--dsw-alias-turn-trigger-bg,var(--dsw-alias-markdown-code-block));',
        'min-width:0;transition:background-color .1s}',
        '[data-dsh-autofork-card]:hover{background:var(--dsw-alias-turn-trigger-bg-hover,',
        'var(--dsw-alias-interactive-bg-hover))}',
        '[data-dsh-autofork-card] > button{width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;',
        'text-align:left;cursor:pointer;background:0 0;border:0;align-items:center;gap:10px;',
        'padding:12px 16px;transition:color .1s;display:flex}',
        '[data-dsh-autofork-card] > button:hover{color:var(--dsw-alias-label-secondary)}',
        '[data-dsh-autofork-card] [data-part=icon]{color:inherit;flex:none;display:inline-flex}',
        '[data-dsh-autofork-card] [data-part=title]{font-size:var(--dsh-content-font-size,14px);flex:none}',
        '[data-dsh-autofork-card] [data-part=time]{color:inherit;font:var(--dsw-font-xxs-12);flex:none;',
        'margin-left:auto}',
        '[data-dsh-autofork-card] [data-part=chevron]{color:inherit;flex:none}',
        '[data-dsh-autofork-card][data-open] [data-part=chevron]{transform:rotate(180deg)}',
        '[data-dsh-autofork-card] [data-part=body]{padding:0 16px 12px 40px}',
        '[data-dsh-autofork-card] [data-part=sender]{color:var(--dsw-alias-label-caption);',
        'overflow-wrap:anywhere;margin:0 0 6px}',
        '[data-dsh-autofork-card] [data-part=content]{white-space:pre-wrap;overflow-wrap:anywhere;',
        'max-height:240px;font:var(--dsw-font-xxs-12);overflow:auto}',
        '@media (prefers-reduced-motion:reduce){[data-dsh-autofork-card],[data-dsh-autofork-card] > button',
        '{transition:none}}',
      ].join('')
      document.head.appendChild(element)
      return function () {
        if (element.parentNode !== null && element.parentNode !== undefined) element.parentNode.removeChild(element)
      }
    }

    /**
     * 消息卡视图：图标 + 标题 + 时间 + 可展开正文（结构照抄官方 `TurnTriggerNodeView`）。
     * @param {any} props 槽位注入的 props（`node` 是本模块定义产出的节点）。
     * @returns {any} React 元素。
     */
    function AutoforkCardView(props) {
      var node = props?.node
      var data = node?.data ?? {}
      var [open, setOpen] = React.useState(false)
      var Icon = primitives.IconPaperPlaneOutlineRegular ?? primitives.IconBranchOutlineRegular
      var Chevron = primitives.IconChevronDownOutlineRegular
      var title = CARD_TITLES[data.marker] ?? '消息'
      var clock = ''
      try {
        clock = new Date(data.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch (error) {
        clock = ''
      }
      var head = React.createElement('button', {
        type: 'button',
        'aria-expanded': open,
        onClick: function () { setOpen(!open) },
      },
      Icon === undefined ? null : React.createElement('span', { 'data-part': 'icon', 'aria-hidden': true },
        React.createElement(Icon, { size: 14 })),
      React.createElement('span', { 'data-part': 'title' }, title),
      clock === '' ? null : React.createElement('time', { 'data-part': 'time' }, clock),
      Chevron === undefined ? null : React.createElement(Chevron, { 'data-part': 'chevron', size: 12 }))
      var body = open === false ? null : React.createElement('div', { 'data-part': 'body' },
        React.createElement('p', { 'data-part': 'sender' }, '来自会话 ' + (data.sender === '' ? '未知' : data.sender)),
        React.createElement('div', { 'data-part': 'content' }, data.text))
      return React.createElement('section', {
        [CARD_ATTR]: data.marker,
        'data-open': open ? '' : undefined,
      }, head, body)
    }

    /**
     * 注册"这三条消息长成卡片"的客户端节点定义 + 视图。
     *
     * 契约来自官方 `ui-goal`（它用同一套 API 画 `/goal` 指令卡片）：
     *  · `ctx.uiConversation.events.register({kind, target:'chat', match, start, update, buildViewNode})`
     *    定义一种**新的会话节点**；
     *  · `slots.register({name:'conversation.chat.node', key:<kind>}, View)` 把该 kind 的渲染交给
     *    我们的组件（ui-chat 的每个 flow item 里都有 `[data-slot="conversation.chat.node"]`）。
     *
     * 走**嵌套** `ctx.inject(['uiConversation'])`：这两个服务缺席（比如非 web 组合）时只丢卡片，
     * 不能把整条客户端插件（页签 / 焦点交付 / 分叉按钮）一起拖下水。
     * @param {any} ctx 客户端根上下文。
     * @param {any} slots slots 服务。
     * @returns {() => void} 卸载函数。
     */
    function registerAutoforkCards(ctx, slots) {
      if (typeof ctx.inject !== 'function' || slots === undefined) return function () {}
      var disposeStyles = installCardStyles()
      var disposeSlot = function () {}
      var disposeEvents = function () {}
      try {
        ctx.inject(['uiConversation'], function (conversationCtx) {
          var definition = {
            kind: CARD_KIND,
            target: 'chat',
            match: function (event) {
              // 只认本插件自己写的三条（宿主在 source 上打了 `autofork` 标记）——
              // 别人的 agent 消息照旧走官方渲染，我们不去抢。
              if (event?.type !== 'user/message') return null
              var marker = event.data?.source?.autofork
              if (typeof marker !== 'string') return null
              return { id: String(event.data.id), role: 'start' }
            },
            start: function (context, match, reader) {
              var event = match.event
              // 这条消息若是**本轮 turn 的开场触发**（被 next-turn 认领），官方 `input-message`
              // 会把它渲染成 turn-trigger 卡片（后台回传走 `followup` 时就是这种情况）——
              // 我们不再画第二张，否则同一个事件上会出现两张卡。判定与官方同源：
              //   waking = reader.previous('inbox-next-turn')?.state.currentClaimed.has(id) === true || idleSteer
              // `idleSteer` 那条我们不复制：它的三个前置（开场 step / claimSeq 关系 / 批里没有人类
              // 消息）在本插件这三条消息上都不成立——通知与摘要走 next-step 与用户指令**同批**
              // （claimedHuman=true），回传的两条路要么命中 next-turn，要么落进人类开场的轮里。
              var nextTurn = reader?.previous?.('inbox-next-turn')?.state
              if (nextTurn?.currentClaimed?.has(String(event.data.id)) === true) return undefined
              return {
                id: match.id,
                seq: event.seq,
                time: event.time,
                marker: event.data.source.autofork,
                sender: typeof event.data.source.senderSessionId === 'string' ? event.data.source.senderSessionId : '',
                text: (event.data.content ?? [])
                  .filter(function (part) { return part?.type === 'text' })
                  .map(function (part) { return part.text })
                  .join(''),
              }
            },
            update: function (context) { return context.state },
            buildViewNode: function (context) {
              if (context.state === undefined) return null
              return {
                key: context.key,
                kind: CARD_KIND,
                id: context.id,
                target: 'chat',
                anchorSeq: context.state.seq,
                // ⚠️ **必须显式 unresolved**：客户端把"落在 turn 内、且 kind 不在
                // `TURN_PROCESS_INDEPENDENT_KINDS` 里"的节点当成 turn 的**过程成员**，
                // 折进那个可折叠的 "Completed in …" 分组里（真 GUI 实测：卡片被折叠、文字都取不到）。
                // 标成 unresolved 后它就是独立的一行，显示位置仍由 anchorSeq（= 事件 seq）决定，
                // 所以顺序依旧是"通知 → 摘要 → 用户那条指令"。
                location: { kind: 'unresolved' },
                visibility: 'visible',
                data: context.state,
              }
            },
          }
          disposeEvents = conversationCtx.uiConversation.events.register(definition) ?? function () {}
          postNote('card.registered')
        })
        // ⚠️ **必须**包在 `slots.inject('conversation.chat.node', …)` 里（官方 ui-goal 就是这么写的）。
        // 直接 `slots.register({name, key}, View)` 不会生效：宿主按 kind 查这个 keyed 子槽时查不到，
        // 于是退回它自带的 fallback（真 GUI 实测：渲染成一行 "Unknown surface event: autofork-message"）。
        slots.inject('conversation.chat.node', function () {
          // `register` 正常返回卸载函数；拿不到也不能让整块崩掉（卡片是可选能力）。
          return slots.register({ name: 'conversation.chat.node', key: CARD_KIND }, AutoforkCardView) ?? function () {}
        })
      } catch (error) {
        // 卡片是可选能力（页签 / 按钮 / 焦点交付才是主体）：任何一步失败都只降级成
        // "消息以原生方式呈现"，不能让整个客户端条目挂掉。
        postNote('card.failed: ' + String(error))
      }
      return function () {
        disposeSlot()
        disposeEvents()
        disposeStyles()
      }
    }

    function installForkStyles() {
      if (typeof document === 'undefined' || document.head === null || document.head === undefined) {
        return function () {}
      }
      var existing = document.getElementById('dsh-autofork-styles')
      var element = existing
      if (element === null || element === undefined) {
        element = document.createElement('style')
        element.id = 'dsh-autofork-styles'
        // 逐条照抄官方 `QueueDock.module.css` 的 `.action`（旁边编辑 / 删除 / 转向那三个按钮
        // 用的就是它）——插件拿不到那个 CSS module 的哈希类名，只能复刻声明：
        //
        //   .action{corner-shape:round;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);
        //           cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;
        //           place-items:center;padding:0;display:grid}
        //   .action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
        //   .action:focus-visible{outline:var(--dsw-focus-ring-width) solid
        //           var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
        //   .action:disabled{cursor:default;opacity:.45}
        //
        // `corner-shape:round` 不能省：主题层默认把按钮渲染成超椭圆（squircle），少了它这个
        // 圆形按钮会变成圆角方块（whale-girl 在官方 Switch 上踩过同一条）。
        // 唯一与官方不同的地方是失败态的颜色（官方没有这个状态）——几何形状仍然一致。
        element.textContent = [
          '[data-dsh-autofork-fork]{corner-shape:round;width:28px;height:28px;',
          'color:var(--dsw-alias-label-tertiary,#9a9a9a);cursor:pointer;background:0 0;border:none;',
          'border-radius:999px;flex:none;place-items:center;padding:0;display:grid}',
          '[data-dsh-autofork-fork]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
          '[data-dsh-autofork-fork]:focus-visible{outline:var(--dsw-focus-ring-width) solid ',
          'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
          '[data-dsh-autofork-fork]:disabled{cursor:default;opacity:.45}',
          '[data-dsh-autofork-fork][data-tone=error]{color:var(--dsw-alias-state-error-primary,#c62828)}',
        ].join('')
        document.head.appendChild(element)
      }
      return function () {
        // 只回收本次真正插进去的那一个；别把别人（或上一次 apply）的样式带走。
        if (existing === null || existing === undefined) {
          if (element.parentNode !== null && element.parentNode !== undefined) element.parentNode.removeChild(element)
        }
      }
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
      var uiWorkspace = ctx.get('uiWorkspace')
      if (sessions === undefined) return

      /**
       * 切到另一条会话。**唯一入口是 `ctx.uiWorkspace.openSession(target)`。**
       *
       * 0.2.0 起 `ctx.sessions` 只剩"目录 + 引用"（`ISessions` 的文档原话：*Host catalog and
       * local reference-source counts; navigation belongs to view owners*）——`open` /
       * `openSubagent` / `refreshSubagents` 都已不存在。会话选择归视图所有者
       * （`dsh-client-ui-workspace` 的 `UiWorkspaceService`），导航动作是
       * `openSession(target: SessionTarget)`，`target` 是 session id **或** durable 子会话地址
       * （`SessionId | SubagentAddress`）；官方 `ui-subagent` 跳子会话也是这么调的。
       *
       * 在调用点读服务（不在 apply 时把方法抓成闭包变量）：服务可能在 apply 之后才挂上。
       */
      function openSession(target) {
        if (uiWorkspace === undefined || typeof uiWorkspace.openSession !== 'function') {
          report('nav.no-service: uiWorkspace.openSession 不可用')
          return
        }
        uiWorkspace.openSession(target)
      }

      /**
       * 当前**正在显示的**会话 id。
       *
       * 0.2.0 的列表快照里没有 `current` 字段了（`SessionListState` = `{ids, byId, phase,
       * projectionsBySession}`）。"主视图选中了谁"由引用计数表达：`ui-workspace` 用
       * `sessions.retain(target, { source: 'mainView' })` 持有当前会话，于是那一行的
       * `retainedBy.mainView > 0`——这正是官方 `ui-session` 内部判 `isMain()` 的写法：
       * `list.getSnapshot().byId[sessionId]?.retainedBy.mainView > 0`。
       *
       * @returns {string|undefined} 当前会话 id。
       */
      function currentSessionId() {
        var snap = sessions.list.getSnapshot()
        var rows = snap === undefined || snap === null ? undefined : snap.byId
        if (rows === undefined || rows === null) return undefined
        var ids = Object.keys(rows)
        for (var index = 0; index < ids.length; index += 1) {
          var row = rows[ids[index]]
          var retained = row === undefined || row === null ? undefined : row.retainedBy
          if (retained !== undefined && retained !== null && (retained.mainView ?? 0) > 0) return ids[index]
        }
        return undefined
      }

      /**
       * 一条子会话的 durable 父地址（形状 `{parentSessionId, childSessionId, mode}`）。
       *
       * 数据源是 `sessions.subagentAddress(childId)`：它先看客户端**已保留/已解析**的地址，
       * 再扫各会话已加载的 `subagentCatalog` 投影。投影没加载时返回 undefined——所以调用方
       * 先 `refreshProjections(parentId)`（见 `openAddressed`）。
       *
       * @param {string} childId 子会话 id。
       * @returns {object|undefined} 地址，或 undefined（不是子会话 / catalog 还没加载）。
       */
      function subagentAddressOf(childId) {
        try {
          if (typeof sessions.subagentAddress !== 'function') return undefined
          var address = sessions.subagentAddress(childId)
          return address === undefined || address === null ? undefined : address
        } catch (error) {
          report('nav.address-threw: ' + String(error))
          return undefined
        }
      }

      /**
       * 打开一条会话，**按它的寻址方式**打开。
       *
       * subagent 会话（容器模式下的分叉会话）不能用普通 session 地址打开——宿主
       * `validateAddress()` 对 `address.kind === 'session'` 且 `header.origin === 'subagent'`
       * 直接抛 `session/agent-busy`。所以先 `refreshProjections(parentSessionId)` 把父会话的
       * 投影（含 `subagentCatalog`）拉进客户端，再 `subagentAddress(childId)` 派生地址；
       * 派生得到就把**地址**交给 `openSession`（`SessionTarget` 允许地址），否则按普通
       * 顶层会话开。扁平分叉（默认）的 head 本来就是普通会话，走的就是后者。
       *
       * @param {string} sessionId 目标会话。
       * @param {string|undefined} parentSessionId 已知的直接父会话（分叉交付时服务端会给）。
       * @returns {Promise<void>} 打开完成。
       */
      function openAddressed(sessionId, parentSessionId) {
        var anchor = parentSessionId !== undefined ? parentSessionId : currentSessionId()
        var loadProjections = anchor === undefined || typeof sessions.refreshProjections !== 'function'
          ? Promise.resolve()
          : Promise.resolve(sessions.refreshProjections(anchor)).catch(function (error) {
            report('catalog.refresh-failed: ' + String(error))
          })
        return loadProjections.then(function () {
          var address = subagentAddressOf(sessionId)
          if (address !== undefined) {
            openSession(address)
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
      /** 本插件注入的样式表卸载函数（见 installForkStyles）。 */
      var styles = null
      var cardStyles = null

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
        postNote(note)
      }

      /**
       * 交付一条分叉：先刷新列表，再切焦点，**验证真的切过去了**才 ack。
       *
       * 验证读的是"当前显示的是哪条会话"（`retainedBy.mainView`，见 `currentSessionId`）——
       * `uiWorkspace.openSession` 是同步发起、异步打开的，只有这一读能确认它落地了。
       * 没切成就不 ack，下次轮询服务端会再提供同一条，自动重试。
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
            var current = currentSessionId()
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
              // 服务端**此刻生效**的分叉方式：手动模式下队列行才有「分叉」按钮。
              // 以服务端为准（而不是读设置文档），所以按钮不会出现在宿主不照它行事的时候。
              mode: body.mode === 'manual' ? 'manual' : 'auto',
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
        var current = currentSessionId()
        if (current === undefined || current === null) {
          publish({ current: undefined, nodes: [], driver: null, mode: 'auto' })
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

        // 手动分叉的「分叉」按钮：注册进 `conversation.input.dock`（list 槽，与官方队列条 /
        // 任务条同一列），但组件本身**不画在这一列里**——它把按钮用 portal 挂进队列那一行
        // 右侧（见 ForkDock 的注释：队列行的动作区是官方写死的，插件没有那个槽）。
        slots.inject('conversation.input.dock', function () {
          report('forkdock.mounted')
          return slots.register({
            name: 'conversation.input.dock',
            id: 'fork',
            order: 21,
            inject: function () { return {} },
          }, ForkDock)
        })

        // 消息卡：分叉通知 / 在飞摘要 / 后台回传三条长成官方那种卡片。
        // 宿主**直接落盘**这三条（不占 turn），所以卡片必须由本模块自己画，见 CARD_KIND 的注释。
        cardStyles = registerAutoforkCards(ctx, slots)

        // Plugins 页上本插件的设置卡片（分叉方式）。走嵌套 inject，见 registerForkSettings。
        registerForkSettings(ctx, slots)
      }

      // 队列行上那个按钮要 `:hover`，内联样式表达不了——注入一小段样式，卸载时收回。
      styles = installForkStyles()

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
          if (styles !== null) {
            styles()
            styles = null
          }
          if (cardStyles !== null) {
            cardStyles()
            cardStyles = null
          }
        }
      }, 'dsh-autofork: 分叉关系 UI 与交付轮询')
    }

    return exports
  },
})
