/**
 * 血缘重读的节流策略（纯函数，不碰存储）。
 *
 * 判据：便宜的库保持下限（新鲜度优先）；贵的库退避到上限（成本优先）；中间带不动。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  nextRefreshInterval, REFRESH_MAX_MS, REFRESH_MIN_MS,
} from '../src/refresh.mjs'

test('重读节流：快则维持下限、慢则翻倍退避、封顶在上限', () => {
  assert.equal(nextRefreshInterval(undefined, 3), REFRESH_MIN_MS, '首次且很快 ⇒ 下限')
  assert.equal(nextRefreshInterval(REFRESH_MIN_MS, 3), REFRESH_MIN_MS, '一直很快 ⇒ 维持下限')
  assert.equal(nextRefreshInterval(REFRESH_MIN_MS, 200), REFRESH_MIN_MS * 2, '慢 ⇒ 退避一档')
  assert.equal(nextRefreshInterval(REFRESH_MIN_MS * 4, 200), REFRESH_MIN_MS * 8,
    '没到上限前继续翻倍（8s → 16s）')
  assert.equal(nextRefreshInterval(REFRESH_MAX_MS, 200), REFRESH_MAX_MS, '撞上限就停在上限')
  assert.equal(nextRefreshInterval(REFRESH_MAX_MS / 2, 200), REFRESH_MAX_MS, '翻倍超过上限时取上限')
  assert.equal(nextRefreshInterval(REFRESH_MIN_MS * 4, 30), REFRESH_MIN_MS * 4, '中间带不动')
  assert.equal(nextRefreshInterval(REFRESH_MAX_MS, 30), REFRESH_MAX_MS, '中间带也不该把大间隔拉回来')
  assert.equal(nextRefreshInterval(REFRESH_MAX_MS, 2), REFRESH_MIN_MS, '忽然变快 ⇒ 回到下限')
})
