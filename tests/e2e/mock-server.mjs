import { pathToFileURL } from 'node:url'
/**
 * 启动 scriptable mock LLM 服务器（OpenAI 兼容，不需要 provider key）。
 *
 * ## 它依赖什么
 *
 * 官方 mock 在 dsh **源码**里（`packages/test-support/llm-mock-server`），**不在 npm 闭包里**，
 * 所以本文件不能裸 `import '@deepseek-ai/dsh-llm-mock-server'`。用环境变量指路：
 *
 * ```sh
 * DSH_MOCK_LLM_SERVER=/path/to/deepseek-harness/packages/test-support/llm-mock-server/lib/index.js \
 *   MOCK_PORT=8123 node mock-server.mjs
 * ```
 *
 * 没设时先试裸模块名（万一你的环境里装了），都不行就报一条可操作的错。
 * 换句话说：**这套 E2E 需要一个 dsh 源码检出**（或任何提供该模块的地方）——
 * 这是"行为层证据能复现"的代价，README 里写明了。
 *
 * ## 序列设计（制造"在飞 step"）：`['stall','success']` + repeatLast
 *   - 请求 1（旧会话）→ `stall`：SSE 头发出去后一直挂着。`step/start` 在模型调用**之前**
 *     就写进日志，所以这一步的年龄一直涨、agent 状态一直是 `running` —— 正是自动分叉的触发条件。
 *   - 请求 2（新会话）→ `success`：新会话拿到正常回复。
 *
 * 为什么不用"慢工具"造长 step：`bash` 在 headless 下被沙箱拒绝并**瞬间返回**（见仓库
 * docs 里的环境事实），长 step 根本造不出来。走模型侧就完全绕开沙箱。
 *
 * ## ⚠️ 每次跑都必须**新起**一个 mock
 *
 * 序列是**有状态**的（每个请求消费一格）。同一个 mock 进程被两次跑复用，第二次的第一条请求
 * 就会拿到 `success` 而不是 `stall` —— 父会话不忙，于是**不分叉**，看起来像"插件坏了"。
 * 实测踩过一整轮（排查方向完全跑偏）。所以端口被占时这里**显式报错**，而不是静默连上去。
 */

/** 官方 mock 模块：环境变量优先，其次裸模块名。 */
async function loadMockServer() {
  const fromEnv = process.env.DSH_MOCK_LLM_SERVER
  if (fromEnv !== undefined && fromEnv !== '') {
    return import(pathToFileURL(fromEnv).href)
  }
  try {
    return await import('@deepseek-ai/dsh-llm-mock-server')
  } catch (error) {
    throw new Error(
      'E2E 需要官方 mock LLM：设 DSH_MOCK_LLM_SERVER=<dsh 源码>/packages/test-support/llm-mock-server/lib/index.js'
      + `（裸模块名也不可解析：${String(error?.code ?? error)}）`,
    )
  }
}

const { startMockLlmServer } = await loadMockServer()

const PORT = Number(process.env.MOCK_PORT ?? 8123)
/** 逗号分隔；默认 ['stall','success']。全 stall 让父分支持续忙碌（手工验证焦点切换用）。 */
const sequence = (process.env.MOCK_SEQUENCE ?? 'stall,success').split(',').filter(Boolean)

/**
 * mock 的行为参数（两个工具参数只在设了对应环境变量时透传）。
 * @param {string|undefined} toolName `tool_call_success` 要调的工具名。
 * @param {string|undefined} toolArgs 该工具的参数 JSON 文本。
 * @returns {object} `startMockLlmServer` 的选项。
 */
function options(toolName, toolArgs) {
  return {
    host: '127.0.0.1',
    port: PORT,
    apiKey: 'mock-key',
    sequence,
    repeatLast: true,
    successText: process.env.MOCK_SUCCESS_TEXT ?? '已按指令完成。',
    chunkSize: 1,
    // 用来制造"**悬空工具调用**"窗口：agent 已经发出 tool_call、结果还没落盘。
    // 这正是 2026-09-11 用户实测里容器报
    // `An assistant message with 'tool_calls' must be followed by tool messages …` 的场景，
    // 所以 E2E 必须能复现它，而不是只靠单元测试。
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolArgs === undefined ? {} : { toolArguments: toolArgs }),
    onEvent: (event) => {
      // 每次请求的具体行为都打出来，便于确认序列被按预期消费
      console.log(JSON.stringify({ t: 'mock-event', event }))
    },
  }
}

/**
 * 起服务。**必须**把 `EADDRINUSE` 变成一条可操作的错（见文件头的"每次都必须新起"）。
 * @returns {Promise<any>} 官方 mock 的 server 句柄。
 */
async function start() {
  try {
    return await startMockLlmServer(options(process.env.MOCK_TOOL_NAME, process.env.MOCK_TOOL_ARGS))
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      throw new Error(
        `端口 ${String(PORT)} 已被占用：多半是上一次的 mock 还活着，而它的序列已经被消费过了`
        + '（驱动连上去会拿到 success 而不是 stall ⇒ 看起来像"插件没分叉"）。'
        + '先 `pkill -f mock-server.mjs`（或换 MOCK_PORT）再重跑。',
      )
    }
    throw error
  }
}

const server = await start()

const keys = server === undefined || server === null ? [] : Object.keys(server)
const baseUrl = typeof server?.url === 'string' ? server.url : `http://127.0.0.1:${String(PORT)}/v1`
console.log(JSON.stringify({ t: 'ready', keys, baseUrl }))
