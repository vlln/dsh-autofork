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
    for (const file of ['scripts/gate.mjs', 'src/params.mjs', 'index.mjs', 'client/index.js', 'README.md', 'docs/configuration.md', 'package.json']) {
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
