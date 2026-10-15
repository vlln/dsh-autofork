import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

test('plugin icon: manifest points to a packaged, self-contained SVG', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['./package.json'], './package.json')
  assert.equal(manifest.icon, 'icon.svg')
  assert.ok(manifest.files.includes(manifest.icon), 'icon must survive npm packaging')
  const path = realpathSync(resolve(root, manifest.icon))
  const local = relative(realpathSync(root), path)
  assert.ok(!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`))
  assert.ok(statSync(path).size <= 256 * 1024)
  const svg = readFileSync(path, 'utf8')
  assert.match(svg, /viewBox="0 0 36 36"/u)
  assert.match(svg, /<path\s/u)
  assert.doesNotMatch(svg, /<(?:script|foreignObject|image|text)\b|\bon\w+\s*=|(?:xlink:)?href\s*=|currentColor/iu,
    'image must not depend on fonts, external resources, host CSS or executable markup')
})
