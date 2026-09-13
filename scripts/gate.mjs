/**
 * 门禁：把两个只在挂载时才会暴露的失败模式提前到本地。
 *
 * 门禁 1 —— **严格注入完整性**。0811 cordis 对未在 `inject` 声明的服务直接抛
 * `cannot get property without inject`，且 apply 开头即抛、整个 effect 不注册
 * （插件"加载了但什么都不工作"）。本机没有 DSH 实例可挂载，所以用静态检查代替：
 * `ctx.X` 用到的每个服务都必须在 `export const inject` 里。
 *
 * 门禁 2 —— **参数文档不漂移**。README 的参数表是用户唯一能看到的可调面；
 * 它与 `DEFAULT_PARAMS` 的键集必须双向一致（缺一或多一都失败）。
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

const readme = readFileSync(join(root, 'README.md'), 'utf8')
const tableStart = readme.indexOf('## 参数')
if (tableStart < 0) {
  failures.push('门禁2：README 缺少「## 参数」章节')
} else {
  const section = readme.slice(tableStart)
  const documented = new Set()
  for (const match of section.matchAll(/^\|\s*`([A-Za-z_$][\w$]*)`\s*\|/gmu)) {
    documented.add(match[1])
  }
  const actual = new Set(Object.keys(DEFAULT_PARAMS))

  for (const key of [...actual].sort()) {
    if (!documented.has(key)) {
      failures.push(`门禁2：参数 "${key}" 在 DEFAULT_PARAMS 中但 README 参数表缺它`)
    }
  }
  for (const key of [...documented].sort()) {
    if (!actual.has(key)) {
      failures.push(`门禁2：README 参数表列了 "${key}"，但 DEFAULT_PARAMS 里没有（文档漂移）`)
    }
  }
}

/* ------------------------------ 门禁 3 ------------------------------ */

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientRel = manifest.exports?.['./client']
if (manifest.dsh?.client !== undefined && clientRel === undefined) {
  failures.push('门禁3：package.json 声明了 dsh.client，但 exports["./client"] 缺失（浏览器拿不到 bundle）')
}
if (clientRel !== undefined) {
  const clientPath = join(root, clientRel)
  let clientSource
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

/* ------------------------------ 结果 ------------------------------ */

for (const warning of warnings) console.warn(`warn  ${warning}`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  console.error(`\n门禁未通过（${failures.length} 项）`)
  process.exit(1)
}
console.log(`门禁通过：inject 声明完整（${declared.size} 项），参数文档一致（${Object.keys(DEFAULT_PARAMS).length} 项），client bundle 契约合法`)
