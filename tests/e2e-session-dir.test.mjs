/**
 * E2E 会话目录编码的自证：把 `tests/e2e/session-dir.mjs` 钉在**真实观测到的目录名**上。
 *
 * 为什么值得一个单测：这段编码是**照抄官方** `projectKey` / `encodeSegment` 的（分发契约
 * 不允许 import 官方包），而它错了的后果是**静默**的——E2E 每次跑前"清理会话"匹配不到任何
 * 东西，于是下一次跑撞上 id collision，表现成"插件坏了"。这个 bug 真的发生过一次
 * （`sed 's#/#-#g'` 少了尾部 `--`），而当时的失败信息完全指向别处。
 *
 * 判据（第一条是盘上真实观测值，其余是官方规则的分支）：
 *   - `/tmp/dsh-autofork-e2e-work` → `--tmp-dsh-autofork-e2e-work--`
 *   - 连续分隔符只出一个 `-`
 *   - 非安全字符走 `~XXXX`（大写十六进制，4 位）
 *   - 空/全分隔符路径回退 `root`；超长截到 251
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeSegment, projectKey, sessionsDirOf } from './e2e/session-dir.mjs'

test('projectKey：真实观测到的目录名（盘上证据）', () => {
  assert.equal(projectKey('/tmp/dsh-autofork-e2e-work'), '--tmp-dsh-autofork-e2e-work--')
})

test('projectKey：连续分隔符压成一个 `-`，首尾各补 `--`', () => {
  assert.equal(projectKey('/a//b///c'), '--a-b-c--')
  assert.equal(projectKey('///'), '--root--')
})

test('projectKey：不安全字符走 ~XXXX（大写十六进制）', () => {
  // 空格 U+0020 → ~0020；"目" U+76EE、"录" U+5F55
  assert.equal(projectKey('/tmp/a b'), '--tmp-a~0020b--')
  assert.equal(projectKey('/tmp/目录'), '--tmp-~76EE~5F55--')
  // `~` 自身也必须转义，否则目录名有歧义（`~` 是转义引导符）
  assert.equal(projectKey('/tmp/a~b'), '--tmp-a~007Eb--')
})

test('projectKey：超长截到 251 字符（仍在 `--` 包裹之内）', () => {
  const key = projectKey(`/${'x'.repeat(400)}`)
  assert.equal(key.length, 251 + 4)
  assert.ok(key.startsWith('--') && key.endsWith('--'))
})

test('encodeSegment：`.` / `..` 有专属转义，空段抛错', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('session-abc_1.2'), 'session-abc_1.2')
  assert.throws(() => encodeSegment(''), /empty path segment/)
})

test('sessionsDirOf：拼在 <home>/sessions/ 下，且与清理路径一致', () => {
  assert.equal(
    sessionsDirOf('/tmp/home', '/tmp/work'),
    '/tmp/home/sessions/--tmp-work--',
  )
})
