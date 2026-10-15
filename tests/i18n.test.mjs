/**
 * i18n 自证测试：字典自洽、语言解析顺序、以及"用户可见文案真的会切语言"。
 *
 * 两点设计：
 *  · 会改模块状态的用例用 `import('…?x=…')` 拿**全新实例**（ESM 查询串缓存失效），
 *    免得"回传优先"这类粘性状态串味到别的用例；
 *  · 端到端那条（工具输出跟随语言）必须与 `src/locale.mjs` **同一个实例**，所以用静态
 *    import —— `src/tools.mjs` 内部 import 的是没有查询串的那一份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setLang, t } from '../src/locale.mjs'
import { renderRelated } from '../src/tools.mjs'

/** 取一份全新的 locale 模块实例（模块状态不跨用例污染）。 */
let seq = 0
const fresh = () => import(`../src/locale.mjs?case=${(seq += 1)}`)

test('字典自洽：zh/en 键集相等、无空值、键是点分小写', async () => {
  const { DICTIONARIES, SUPPORTED_LANGS } = await fresh()
  assert.deepEqual([...SUPPORTED_LANGS].sort(), ['en', 'zh'])
  const zh = Object.keys(DICTIONARIES.zh)
  const en = Object.keys(DICTIONARIES.en)
  assert.deepEqual([...en].sort(), [...zh].sort(), '两种语言的键集必须相等')
  assert.ok(zh.length >= 25, `宿主字典键太少（${zh.length}）`)
  for (const lang of ['zh', 'en']) {
    for (const [key, value] of Object.entries(DICTIONARIES[lang])) {
      assert.match(key, /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/, `键形状：${key}`)
      assert.notEqual(value.trim(), '', `空值：${key}`)
    }
  }
})

test('语言白名单：只认 zh/en，区域变体取主语言', async () => {
  const { setLang: set, getLang } = await fresh()
  assert.equal(getLang(), 'zh', '默认中文（本插件的历史行为）')
  assert.equal(set('en'), true)
  assert.equal(getLang(), 'en')
  assert.equal(set('fr'), false, '非白名单值不改变语言')
  assert.equal(getLang(), 'en')
  assert.equal(set('zh-CN'), true, '区域变体取主语言')
  assert.equal(getLang(), 'zh')
})

test('客户端回传优先于设置文档（回传后设置不再覆盖）', async () => {
  const { setLang: set, getLang } = await fresh()
  set('en', { relay: true })
  assert.equal(set('zh'), false, '回传已表态 ⇒ 设置来源不覆盖')
  assert.equal(getLang(), 'en')
  set('zh', { relay: true })
  assert.equal(getLang(), 'zh', '回传本身可以改语言')
})

test('插值与缺键回退：缺键返回键本身而不是崩', async () => {
  const { t: tr } = await fresh()
  assert.match(tr('tool.delivered', { id: 'session-x' }), /session-x/u)
  assert.equal(tr('nope.missing'), 'nope.missing')
  assert.equal(tr('tool.delivered'), '已向 "{id}" 投递；它会在当前 step 结束后读到。', '无参数时保留占位符原文')
})

test('attachSettings：读 locale.preference；服务缺席/抛错都不影响主路径', async () => {
  // 有 settings 且用户显式选了英文。
  {
    const { attachSettings, getLang } = await fresh()
    const ctx = {
      inject: (deps, callback) => { if (deps.includes('settings')) callback({ get: () => ({ describe: () => [{ ns: 'locale', value: { preference: 'en' } }] }), effect: () => {} }) },
    }
    attachSettings(ctx)
    assert.equal(getLang(), 'en')
  }
  // 没有 settings 服务：保持默认语言。
  {
    const { attachSettings, getLang } = await fresh()
    attachSettings({ inject: (deps, callback) => callback({ get: () => undefined }) })
    assert.equal(getLang(), 'zh')
  }
  // describe 抛错：不冒泡（设置面读失败不影响分叉本体）。
  {
    const { attachSettings, getLang } = await fresh()
    attachSettings({ inject: (deps, callback) => callback({ get: () => ({ describe: () => { throw new Error('boom') } }), effect: () => {} }) })
    assert.equal(getLang(), 'zh')
  }
  // 桩形状不全：不抛。
  {
    const { attachSettings } = await fresh()
    assert.doesNotThrow(() => attachSettings(undefined))
    assert.doesNotThrow(() => attachSettings({ inject: (deps, callback) => callback(undefined) }))
  }
})

test('切换语言后工具输出真的跟着变（用户可见面）', () => {
  setLang('zh', { relay: true })
  const zh = renderRelated({}, { related: [] })[0].text
  assert.match(zh, /没有其它会话/u)
  const zhRows = renderRelated({}, {
    related: [{ sessionId: 'session-a', relation: 'upstream', state: 'running', title: '⑂1 甲' }],
  })[0].text
  assert.match(zhRows, /运行中/u)

  setLang('en', { relay: true })
  const en = renderRelated({}, { related: [] })[0].text
  assert.match(en, /no other sessions/iu)
  const enRows = renderRelated({}, {
    related: [{ sessionId: 'session-a', relation: 'upstream', state: 'running', title: '⑂1 甲' }],
  })[0].text
  assert.match(enRows, /Running/u)
  assert.doesNotMatch(enRows, /运行中/u, '切到英文后不该再出现中文状态标签')
  assert.match(enRows, /I took over/u, '方向箭头也要跟着切')
  assert.equal(t('list.empty'), en, '同一实例的 t 与渲染结果一致')

  setLang('zh', { relay: true }) // 复位，避免影响同进程里的其他用例
})