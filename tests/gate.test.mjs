import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'autofork-gate-test-'))
  try {
    for (const directory of ['scripts', 'src', 'client', 'docs']) await mkdir(join(root, directory))
    for (const file of ['scripts/gate.mjs', 'src/params.mjs', 'src/locale.mjs', 'src/tools.mjs', 'index.mjs', 'client/index.js', 'README.md', 'docs/configuration.md', 'package.json']) {
      await copyFile(join(sourceRoot, file), join(root, file))
    }
    await run(root)
  } finally {
    // Only remove the exact directory returned by mkdtemp, never a caller-supplied path.
    assert.equal(resolve(root), root)
    assert.ok(root.startsWith(join(tmpdir(), 'autofork-gate-test-')))
    await rm(root, { recursive: true, force: true })
  }
}

function gate(root) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/gate.mjs')], { encoding: 'utf8' })
  assert.ifError(result.error)
  return { status: result.status, output: result.stdout + result.stderr }
}

test('gate: client contract follows the manifest entry, not a second hardcoded path', async () => {
  await withFixture(async root => {
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.exports['./client'] = './client/alternate.js'
    await writeFile(manifestPath, JSON.stringify(manifest))
    const client = await readFile(join(root, 'client/index.js'), 'utf8')
    await writeFile(join(root, 'client/alternate.js'), client)
    assert.equal(gate(root).status, 0)
    // Keep the old path valid: only the declared entry loses a required card title.
    const changed = client.replace(/\bsteer:\s*'[^']*'/u, "extra: '会话消息'")
    assert.notEqual(changed, client)
    await writeFile(join(root, 'client/alternate.js'), changed)
    const rejected = gate(root)
    assert.equal(rejected.status, 1)
    assert.match(rejected.output, /门禁4.*steer/u)
  })
})

test('gate: missing client entry is reported as a contract failure, not an uncaught read error', async () => {
  await withFixture(async root => {
    const manifestPath = join(root, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.exports['./client'] = './client/missing.js'
    await writeFile(manifestPath, JSON.stringify(manifest))
    const result = gate(root)
    assert.equal(result.status, 1)
    assert.match(result.output, /门禁3.*不存在/u)
    assert.doesNotMatch(result.output, /ENOENT|TypeError/u)
  })
})

test('gate: a key missing from one locale fails the dictionary parity rule', async () => {
  await withFixture(async root => {
    const clientPath = join(root, 'client/index.js')
    const client = await readFile(clientPath, 'utf8')
    // 删掉 en 段里的一个键（zh 仍在）——那种语言下会露出键名。
    const mutated = client.replace(/^ {8}'state\.idle': 'Idle',\n/mu, '')
    assert.notEqual(mutated, client, '夹具必须真的删掉一行')
    await writeFile(clientPath, mutated)
    const result = gate(root)
    assert.equal(result.status, 1)
    assert.match(result.output, /门禁5：en 缺这些键：state\.idle/u)
  })
})

test('gate: hardcoded UI copy outside the dictionary is rejected', async () => {
  await withFixture(async root => {
    const clientPath = join(root, 'client/index.js')
    const client = await readFile(clientPath, 'utf8')
    const anchor = "var NS = 'autofork'"
    const mutated = client.replace(anchor, `${anchor}\n    var leaked = '会话设置'`)
    assert.notEqual(mutated, client, '夹具必须真的注入一行')
    await writeFile(clientPath, mutated)
    const result = gate(root)
    assert.equal(result.status, 1)
    assert.match(result.output, /门禁5：字典之外出现硬编码文案/u)
  })
})

test('gate: a placeholder that exists on one side only is rejected', async () => {
  await withFixture(async root => {
    const clientPath = join(root, 'client/index.js')
    const client = await readFile(clientPath, 'utf8')
    const mutated = client.replace("'view.branch.summary.sessions': '{count} sessions',", "'view.branch.summary.sessions': 'sessions',")
    assert.notEqual(mutated, client, '夹具必须真的改掉那一行')
    await writeFile(clientPath, mutated)
    const result = gate(root)
    assert.equal(result.status, 1)
    assert.match(result.output, /门禁5：占位符两侧不一致：view\.branch\.summary\.sessions/u)
  })
})
