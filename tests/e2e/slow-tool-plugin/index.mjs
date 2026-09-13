/**
 * E2E 专用：一个**真的会慢慢返回**的工具，用来制造"悬空工具调用"窗口。
 *
 * 存在的理由（2026-09-11）：本机 `sandbox-exec` 不可用，headless（`--profile sdk`）下
 * 任何 `bash` 调用都被沙箱拒绝并**瞬间返回**，于是容器永远不出现
 * "assistant 已发 tool_call、结果还没落盘"的那段窗口——而那正是用户实测里容器报
 * `An assistant message with 'tool_calls' must be followed by tool messages …` 的条件。
 *
 * 这个工具在**进程内** sleep，完全不碰沙箱，因此能在 headless 下精确复现那段窗口。
 * 只用于 `.experiments/`，不进任何发布物。
 *
 * @module @vlln/e2e-slow-tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'e2e-slow-tool'

/** 只要 tools 服务；缺席就让整个 runtime 起不来（严格注入），所以放在顶层是安全的。 */
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'slow_wait',
    description: '睡指定毫秒数再返回。E2E 专用，用来制造长时间运行的工具调用。',
    parameters: {
      ms: { type: 'number', required: true, description: '要睡的毫秒数。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { waited: { type: 'number', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `waited ${String(value?.waited ?? 0)}ms` }],
    },
    async execute(args) {
      const ms = Number(args?.ms ?? 0)
      await new Promise(resolve => { setTimeout(resolve, ms) })
      return { waited: ms }
    },
  }))
}
