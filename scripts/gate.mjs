/**
 * 静态门禁：检查注入声明、参数文档、客户端入口及跨半边卡片契约。
 *
 * 门禁 1 —— **严格注入完整性**。0811 cordis 对未在 `inject` 声明的服务直接抛
 * `cannot get property without inject`，且 apply 开头即抛、整个 effect 不注册
 * （插件"加载了但什么都不工作"）。本检查只验证声明集合，不能替代真实挂载：
 * `ctx.X` 用到的服务须有顶层或嵌套注入声明，不验证其所在作用域及运行时可用性。
 *
 * 门禁 2 —— **参数文档不漂移**。配置参考的参数表是用户唯一能看到的可调面；
 * 它与 `DEFAULT_PARAMS` 的键集必须双向一致（缺一或多一都失败）。
 *
 * 门禁 4 —— **跨半边的卡片契约不漂移**。宿主 half 的 `CARD_MARKERS`（它能写出的 `source.autofork`
 * 标记）与客户端 half 的 `CARD_TITLES`（它能画出的卡片标题）必须**一一对应**：两个 half 是各自
 * 独立的产物（客户端 bundle 跑在浏览器里、无法 import 宿主模块），所以这条契约只能靠门禁守
 * ——漂了的表现是"卡片有消息没标题"（静默、只在真机上出现）。
 *
 * 跑法：node scripts/gate.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DEFAULT_PARAMS } from '../src/params.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const warnings = []

/**
 * Context 的核心成员：不是注入服务，出现时不必声明。
 * 依据：`ctx.logger` / `ctx.on` / `ctx.effect` 在多个官方插件里都未声明
 * （例：packages/acp/acp 的 inject 只有 ['agents','llm','sessionPersistence','sessions']）。
 */
const CORE_CONTEXT_MEMBERS = new Set([
  'on', 'once', 'off', 'emit', 'parallel', 'serial', 'bail', 'waterfall',
  'effect', 'inject', 'get', 'set', 'provide', 'isolate', 'plugin', 'dispose',
  'logger', 'root', 'scope', 'ctx', 'baseUrl', 'registry', 'start', 'stop',
])

/* ------------------------------ 门禁 1 ------------------------------ */

const source = readFileSync(join(root, 'index.mjs'), 'utf8')

/**
 * 剥掉注释后的代码。注释里会出现 `ctx.inject([...])` 这样的**示例**，不剥掉
 * 会被当成真实声明，把门禁的声明集算脏。
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/\/\/[^\n]*/gu, '')

/** 顶层 `export const inject`：全部为**必需**依赖。 */
const injectMatch = source.match(/export const inject\s*=\s*\[([\s\S]*?)\]/u)
if (injectMatch === null) {
  failures.push('index.mjs 未导出 `export const inject`；严格注入下必须显式声明')
}
const declared = new Set(
  (injectMatch?.[1] ?? '')
    .replace(/\/\/[^\n]*/gu, '')
    .split(',')
    .map(part => part.replace(/['"\s]/gu, ''))
    .filter(Boolean),
)

/**
 * 嵌套子插件 `ctx.inject([...], cb)` 声明的服务。与顶层分开记账：这些服务缺席
 * 时子插件只是不运行，**不会**让 apply 抛错（webServer / tools / agentPresets
 * 都走这条路），因此不能拿来当"必需"判据。
 */
const nested = new Set()
for (const match of code.matchAll(/\bctx\.inject\(\s*\[([^\]]*)\]/gu)) {
  for (const part of match[1].split(',')) {
    const name = part.replace(/['"\s]/gu, '')
    if (name !== '') nested.add(name)
  }
}

/** 收集 `ctx.X` 形式的使用点（含 `ctx.X?.` 与 `ctx.X.`）。 */
const used = new Set()
for (const match of code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/gu)) {
  const name = match[1]
  if (!CORE_CONTEXT_MEMBERS.has(name)) used.add(name)
}

for (const name of [...used].sort()) {
  if (!declared.has(name) && !nested.has(name)) {
    failures.push(`门禁1：index.mjs 使用了 ctx.${name}，但既未在顶层 inject 声明、也未走嵌套 ctx.inject（挂载时 apply 会抛）`)
  }
}
for (const name of [...declared].sort()) {
  if (!used.has(name)) {
    warnings.push(`门禁1：顶层 inject 声明了 "${name}" 但 index.mjs 未使用它`)
  }
}

/* ------------------------------ 门禁 2 ------------------------------ */

const configuration = readFileSync(join(root, 'docs', 'configuration.md'), 'utf8')
const tableStart = configuration.indexOf('## 参数')
if (tableStart < 0) {
  failures.push('门禁2：配置参考缺少「## 参数」章节')
} else {
  const section = configuration.slice(tableStart)
  const documented = new Set()
  for (const match of section.matchAll(/^\|\s*`([A-Za-z_$][\w$]*)`\s*\|/gmu)) {
    documented.add(match[1])
  }
  const actual = new Set(Object.keys(DEFAULT_PARAMS))

  for (const key of [...actual].sort()) {
    if (!documented.has(key)) {
      failures.push(`门禁2：参数 "${key}" 在 DEFAULT_PARAMS 中但 配置参考参数表缺它`)
    }
  }
  for (const key of [...documented].sort()) {
    if (!actual.has(key)) {
      failures.push(`门禁2：配置参考参数表列了 "${key}"，但 DEFAULT_PARAMS 里没有（文档漂移）`)
    }
  }
}

/* ------------------------------ 门禁 3 ------------------------------ */

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientRel = manifest.exports?.['./client']
let clientSource
if (manifest.dsh?.client !== undefined && clientRel === undefined) {
  failures.push('门禁3：package.json 声明了 dsh.client，但 exports["./client"] 缺失（浏览器拿不到 bundle）')
}
if (clientRel !== undefined) {
  const clientPath = join(root, clientRel)
  try {
    clientSource = readFileSync(clientPath, 'utf8')
  } catch {
    failures.push(`门禁3：exports["./client"] 指向的 ${clientRel} 不存在`)
  }
  if (clientSource !== undefined) {
    // client-modules 只扫描声明 dsh.client 的包，且 bundle 必须自己调用
    // `__ModuleLoader__.load({id, factory})`——否则浏览器报 "loaded without
    // registering"，而这条只在浏览器里才暴露，服务端 200 不代表成功。
    if (!clientSource.includes('__ModuleLoader__.load')) {
      failures.push(`门禁3：${clientRel} 未调用 __ModuleLoader__.load（浏览器会报 loaded without registering）`)
    }
    const idMatch = clientSource.match(/__ModuleLoader__\.load\(\{[\s\S]*?id:\s*['"]([^'"]+)['"]/u)
    if (idMatch === null) {
      failures.push(`门禁3：${clientRel} 的 __ModuleLoader__.load 未声明 id`)
    } else if (idMatch[1] !== manifest.name) {
      failures.push(`门禁3：client bundle 的 id "${idMatch[1]}" 与包名 "${manifest.name}" 不一致`)
    }
    for (const exported of ['name', 'inject', 'apply']) {
      if (!clientSource.includes(`exports.${exported}`)) {
        failures.push(`门禁3：${clientRel} 未导出 ${exported}（Cordis 客户端插件三件套）`)
      }
    }
    const clientInject = manifest.dsh?.client?.inject
    if (!Array.isArray(clientInject) || clientInject.length === 0) {
      failures.push('门禁3：dsh.client.inject 必须是非空数组（声明该 half 依赖的客户端包）')
    }
  }
}

/* ------------------------------ 门禁 4 ------------------------------ */

{
  const markersMatch = source.match(/const CARD_MARKERS = \[([^\]]*)\]/u)
  if (markersMatch === null) {
    failures.push('门禁4：index.mjs 里找不到 `CARD_MARKERS`（宿主可写的卡片标记清单）')
  } else {
    const hostMarkers = [...markersMatch[1].matchAll(/'([^']+)'/gu)].map(match => match[1])
    const titlesMatch = clientSource?.match(/var CARD_TITLES = \{([\s\S]*?)\n    \}/u) ?? null
    if (titlesMatch === null) {
      failures.push('门禁4：客户端的 `CARD_TITLES` 找不到（卡片标题表）')
    } else {
      const clientMarkers = [...titlesMatch[1].matchAll(/^\s*([A-Za-z][\w-]*):\s*'/gmu)].map(match => match[1])
      const missing = hostMarkers.filter(marker => !clientMarkers.includes(marker))
      const extra = clientMarkers.filter(marker => !hostMarkers.includes(marker))
      if (missing.length > 0) failures.push(`门禁4：客户端缺这些标记的标题：${missing.join(', ')}`)
      if (extra.length > 0) failures.push(`门禁4：客户端多出宿主不写的标记：${extra.join(', ')}`)
      if (hostMarkers.length === 0) failures.push('门禁4：宿主标记清单为空（标记就是卡片契约，不能空）')
      const emptyTitle = [...titlesMatch[1].matchAll(/^\s*([A-Za-z][\w-]*):\s*''/gmu)].map(match => match[1])
      if (emptyTitle.length > 0) failures.push(`门禁4：这些标记的标题是空串：${emptyTitle.join(', ')}`)
      if (missing.length === 0 && extra.length === 0 && hostMarkers.length > 0) {
        console.log(`门禁 4 通过：卡片标记 ↔ 标题一一对应（${hostMarkers.join(' / ')}）`)
      }
    }
  }
}

/* ------------------------------ 门禁 5 ------------------------------ */

/**
 * **界面文案只住在字典里**（对齐官方 `scripts/verify-client-ui-i18n.ts` 的纪律）。
 *
 * 客户端 half 是手写单文件 bundle（没有 `locales/` 目录），所以字典就地内联在 `DICTS`。
 * 本门禁守这一半：
 *
 *  · zh / en 的**键集必须相等**（缺一个 = 那种语言下会露出键名）；
 *  · 键必须是点分小写（≥2 段，`view.branch.title`）——官方的门禁也正是靠这个形状把
 *    `t('a.b')` 的实参认作键而不是硬编码文案；
 *  · 值不能是空串；同一个键两侧的 `{占位符}` 集必须一致；
 *  · `CARD_TITLES` 里的每个标题键在两种语言里都要有（补门禁 4 只查标记名的缺口）；
 *  · **字典区块之外不许再出现中文文案字面量**——只放行诊断串（`dsh-autofork:` /
 *    `settings.` / `nav.` 前缀）与单字符排版符号（`　`）。
 */
{
  const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u
  const startMatch = /^\s*var DICTS = \{\s*$/mu.exec(clientSource ?? '')
  if (startMatch === null) {
    failures.push('门禁5：客户端 bundle 里找不到内联的 `DICTS` 字典（界面文案的唯一来源）')
  } else {
    const lines = clientSource.split('\n')
    const startLine = clientSource.slice(0, startMatch.index).split('\n').length - 1
    let endLine = -1
    for (let i = startLine + 1; i < lines.length; i += 1) {
      if (/^ {4}\}\s*$/u.test(lines[i])) { endLine = i; break }
    }
    if (endLine === -1) {
      failures.push('门禁5：`DICTS` 字典块没有找到结束的 `}`')
    } else {
      /** @type {Record<string, Map<string, string>>} */
      const locales = { zh: new Map(), en: new Map() }
      let current = null
      const KEY_LINE = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',\s*$/u
      for (let i = startLine + 1; i < endLine; i += 1) {
        const line = lines[i]
        const section = /^\s*(zh|en):\s*\{\s*$/u.exec(line)
        if (section !== null) { current = section[1]; continue }
        if (/^\s*\},?\s*$/u.test(line)) { current = null; continue }
        const trimmed = line.trim()
        if (current === null || trimmed === '' || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
        const key = KEY_LINE.exec(line)
        if (key === null) {
          failures.push(`门禁5：字典第 ${i + 1} 行不是 \`'key': 'value',\` 形状：${trimmed}`)
          continue
        }
        if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/u.test(key[1])) {
          failures.push(`门禁5：字典键必须是点分小写（≥2 段）：${key[1]}`)
        }
        if (key[2].trim() === '') failures.push(`门禁5：字典值不能是空串：${key[1]}`)
        locales[current].set(key[1], key[2])
      }
      const zh = locales.zh
      const en = locales.en
      const missingInEn = [...zh.keys()].filter(key => !en.has(key))
      const missingInZh = [...en.keys()].filter(key => !zh.has(key))
      if (missingInEn.length > 0) failures.push(`门禁5：en 缺这些键：${missingInEn.join(', ')}`)
      if (missingInZh.length > 0) failures.push(`门禁5：zh 缺这些键：${missingInZh.join(', ')}`)
      const holders = value => [...value.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort().join(',')
      for (const key of [...zh.keys()].filter(item => en.has(item))) {
        if (holders(zh.get(key)) !== holders(en.get(key))) {
          failures.push(`门禁5：占位符两侧不一致：${key}（zh:{${holders(zh.get(key))}} / en:{${holders(en.get(key))}}）`)
        }
      }
      // 卡片标题键必须两种语言都在（`CARD_TITLES` 的值现在是字典键；门禁 4 只查标记名）。
      const titles = /var CARD_TITLES = \{([\s\S]*?)\n {4}\}/u.exec(clientSource ?? '')
      if (titles !== null) {
        const titleKeys = [...titles[1].matchAll(/^\s*[A-Za-z][\w-]*:\s*'([^']+)'/gmu)].map(match => match[1])
        const missing = titleKeys.filter(key => !zh.has(key) || !en.has(key))
        if (missing.length > 0) failures.push(`门禁5：卡片标题键在字典里缺失：${missing.join(', ')}`)
      }
      const ALLOWED = /^(?:dsh-autofork:|settings\.|nav\.)/u
      for (let i = 0; i < lines.length; i += 1) {
        if (i >= startLine && i <= endLine) continue
        const code = lines[i].replace(/\/\/.*$/u, '')
        if (/^\s*(?:\*|\/\*)/u.test(code)) continue
        for (const literal of code.match(/'([^'\\]|\\.)*'/gu) ?? []) {
          if (!cjk.test(literal)) continue
          const value = literal.slice(1, -1)
          if (value.length <= 1 || ALLOWED.test(value)) continue
          failures.push(`门禁5：字典之外出现硬编码文案（第 ${i + 1} 行）：${literal}`)
        }
      }
      if (missingInEn.length === 0 && missingInZh.length === 0) {
        console.log(`门禁 5 通过：文案字典 zh/en 各 ${zh.size} 键（键集 / 占位符 / 卡片标题键一致，字典外无硬编码文案）`)
      }
    }
  }
}

/* ------------------------------ 门禁 6 ------------------------------ */

/**
 * **宿主半边同理**：`src/locale.mjs` 是 Node 侧用户可见文案的唯一来源，`index.mjs` /
 * `src/tools.mjs` 里不许再出现硬编码文案。
 *
 * 两处**刻意例外**（都不是"用户可见文案"，写在这里免得后人当漏网之鱼）：
 *  · `src/tools.mjs` 的工具与参数 description、`src/digest.mjs` 的注入正文 = **模型可见文本**，
 *    官方立场是宿主侧不本地化（`command-compact` 的描述与回执都是英文）；它们留在中文，
 *    翻译它们只会动 prompt 缓存与模型行为，不会改善用户体验；
 *  · 日志与 effect 标签（`[dsh-autofork] …` / `dsh-autofork: …`）。
 */
{
  const cjk = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u
  const localeSource = (() => {
    try { return readFileSync(join(root, 'src/locale.mjs'), 'utf8') } catch { return undefined }
  })()
  if (localeSource === undefined) {
    failures.push('门禁6：读不到 `src/locale.mjs`（Node 侧文案字典）')
  } else {
    const lines = localeSource.split('\n')
    /** @type {Record<string, Map<string, string>>} */
    const locales = { zh: new Map(), en: new Map() }
    let current = null
    const KEY_LINE = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',\s*$/u
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const section = /^\s*(zh|en):\s*\{\s*$/u.exec(line)
      if (section !== null) { current = section[1]; continue }
      if (/^\s*\},?\s*$/u.test(line)) { current = null; continue }
      const trimmed = line.trim()
      if (current === null || trimmed === '' || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
      const key = KEY_LINE.exec(line)
      if (key === null) {
        failures.push(`门禁6：src/locale.mjs 第 ${i + 1} 行不是 \`'key': 'value',\` 形状：${trimmed}`)
        continue
      }
      if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/u.test(key[1])) {
        failures.push(`门禁6：字典键必须是点分小写（≥2 段）：${key[1]}`)
      }
      if (key[2].trim() === '') failures.push(`门禁6：字典值不能是空串：${key[1]}`)
      locales[current].set(key[1], key[2])
    }
    const missingInEn = [...locales.zh.keys()].filter(key => !locales.en.has(key))
    const missingInZh = [...locales.en.keys()].filter(key => !locales.zh.has(key))
    if (missingInEn.length > 0) failures.push(`门禁6：en 缺这些键：${missingInEn.join(', ')}`)
    if (missingInZh.length > 0) failures.push(`门禁6：zh 缺这些键：${missingInZh.join(', ')}`)
    const holders = value => [...value.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort().join(',')
    for (const key of [...locales.zh.keys()].filter(item => locales.en.has(item))) {
      if (holders(locales.zh.get(key)) !== holders(locales.en.get(key))) {
        failures.push(`门禁6：占位符两侧不一致：${key}`)
      }
    }
    // `index.mjs` 与 `src/tools.mjs` 里不许再有硬编码文案（诊断串/日志除外）。
    const ALLOWED = /^(?:dsh-autofork:|\[dsh-autofork\]|settings\.|nav\.|binding-|http-|client\.|handoff\.|fork\.|steer\.|cards\.|lineage\.|seed|title\.|answer\.|container\.|tool\.|settings\.|view\.|nav\.|reload|snapshot)/u
    for (const file of ['index.mjs', 'src/tools.mjs']) {
      const text = readFileSync(join(root, file), 'utf8')
      // **模型可见文本刻意留在中文**（见本节头注释）：`description:` 的值与其 `+ '…'` 续行，
      // 以及 `TARGET_DESC` 这类参数描述常量。它们是给模型读的 schema 文案，不进 UI 字典。
      let skipContinuation = false
      for (const [index, line] of text.split('\n').entries()) {
        const code = line.replace(/\/\/.*$/u, '')
        if (/^\s*(?:\*|\/\*)/u.test(code)) { skipContinuation = false; continue }
        const trimmed = code.trim()
        const isDescription = /(?:^|[^A-Za-z_])description:\s/u.test(code)
          || /^const TARGET_DESC = /u.test(trimmed)
        if (skipContinuation) {
          // 续行以 `+` 开头（`description: '…'\n + '…'`）；不是续行就结束跳过区间。
          if (trimmed.startsWith('+')) continue
          skipContinuation = false
        }
        if (isDescription) { skipContinuation = true; continue }
        for (const literal of code.match(/'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/gu) ?? []) {
          if (!cjk.test(literal)) continue
          const value = literal.slice(1, -1)
          if (value.length <= 1 || ALLOWED.test(value)) continue
          failures.push(`门禁6：${file} 第 ${index + 1} 行出现硬编码文案（应进 src/locale.mjs）：${literal}`)
        }
      }
    }
    if (missingInEn.length === 0 && missingInZh.length === 0) {
      console.log(`门禁 6 通过：宿主文案字典 zh/en 各 ${locales.zh.size} 键（键集 / 占位符一致，index.mjs 与 tools.mjs 无硬编码文案）`)
    }
  }
}

/* ------------------------------ 结果 ------------------------------ */

for (const warning of warnings) console.warn(`warn  ${warning}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  console.error(`\n门禁未通过（${failures.length} 项）`)
  process.exit(1)
}
console.log(`门禁通过：inject 声明完整（${declared.size} 项），参数文档一致（${Object.keys(DEFAULT_PARAMS).length} 项），client bundle 契约合法`)
