/**
 * 血缘重读的**节流策略**（自适应）。
 *
 * 为什么需要：`lineage.refresh()` 是"`close()` + 重新 `open()` + 重建索引"，而官方 JSON 后端是
 * **per-record 布局**（一次分叉一个小文件）⇒ 代价随家族数线性增长。几十条时是毫秒级，
 * 几千条时就不该每 2s 来一次了。
 *
 * 策略：按**上次实测耗时**调档——快就维持下限（保新鲜），慢就翻倍退避到上限（新鲜度让位于成本）。
 * 这样"小库"始终是 2s 的新鲜度，"大库"自动放慢，且**不需要**知道落点路径（domain 句柄不暴露它）。
 *
 * @module dsh-autofork/refresh
 */

/** 重读间隔的下限（后台空闲轮询分不出更细的差别，再密只是浪费）。 */
export const REFRESH_MIN_MS = 2000

/** 重读间隔的上限（成本高时的退避天花板）。 */
export const REFRESH_MAX_MS = 30000

/** 比这还快 ⇒ 视作"便宜"，回到下限。 */
export const REFRESH_FAST_MS = 10

/** 比这还慢 ⇒ 视作"贵"，退避一档。 */
export const REFRESH_SLOW_MS = 60

/**
 * 下一次重读的最小间隔。
 * @param {number|undefined} previous 上一次采用的间隔（毫秒）。
 * @param {number} elapsedMs 上一次重读的实测耗时（毫秒）。
 * @returns {number} 新的间隔（毫秒）。
 */
export function nextRefreshInterval(previous, elapsedMs) {
  const current = typeof previous === 'number' && previous > 0 ? previous : REFRESH_MIN_MS
  if (elapsedMs > REFRESH_SLOW_MS) return Math.min(current * 2, REFRESH_MAX_MS)
  if (elapsedMs < REFRESH_FAST_MS) return REFRESH_MIN_MS
  return current
}
