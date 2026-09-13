#!/bin/bash
# E2E：容器出现"悬空工具调用"时，镜像必须**延后**到工具结果之后。
#
# 复现的事故（用户 2026-09-11 实测）：容器正在跑 `bash sleep 60`，实例回复被直接
# append 到容器 surface → `assistant(tool_calls)` 与它的 `tool/result` 被拆开 →
# provider 报 400 `An assistant message with 'tool_calls' must be followed by tool
# messages responding to each 'tool_call_id'`。
#
# 为什么要一个专用 E2E：本机 sandbox-exec 不可用，headless 下 `bash` 被沙箱拒绝并
# **瞬间返回**，所以用 `bash` 造不出那段窗口。改用 `slow-tool-plugin` 的 `slow_wait`
# 工具在**进程内** sleep，完全不碰沙箱。
#
# 两臂对照：
#   safe（默认）  → 镜像落在 tool/result **之后**，容器 turn 正常结束
#   immediate     → 镜像落在 tool/call 与 tool/result **之间**（事故现场）
# 注意 mock 不校验消息顺序，所以它复现的是"**顺序被写坏**"这个事实本身；
# 真实 provider 才会把它变成 400。
#
# 跑法：bash e2e-dangling.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# 隔离 home：必须是**已装好本插件**（且带官方依赖闭包）的那个；刻意不用共享 ~/.dsh。
HOME_DIR="${E2E_DSH_HOME:-${DSH_HOME:-/tmp/dsh-autofork-e2e-home}}"
WORK="$HERE/work"
# 会话目录名 = cwd 的编码形式；`clean()` 里重新算，别硬编码
SESSIONS=""
MOCK_PORT=8123
WAIT_TOOL_MS=30000

clean() {
  pkill -f "mock-server.mjs" 2>/dev/null
  sleep 1
  rm -rf "$WORK"
  mkdir -p "$WORK"
  # 会话目录名 = cwd 编码。**不在这里手写编码规则**：它照抄官方 `projectKey`（分隔符压成
  # 一个 `-`、特殊字符 `~XXXX`、两端 `--`），写错一次就是"清理静默失效"。
  # 单一事实来源在 session-dir.mjs。
  SESSIONS="$(node "$HERE/session-dir.mjs" "$HOME_DIR" "$WORK")"
  rm -rf "$SESSIONS"
}

# 慢工具必须装进**这个隔离 home 的 sdk profile**：
# ① 它必须做成 bundle（`dsh.bundle.patch`）才会进 `profile.bundles`——只写 `dsh.plugin` 时
#    `dsh plugin add` 只加一条 dependency，插件**不会激活**（症状：mock 调 slow_wait 得到未知
#    工具、turn 秒结束）；
# ② 只装 sdk，别装 web —— web 那边有真 bash 可用。
ensure_slow_tool() {
  echo "===== 前置：把 slow_wait 工具装进 $HOME_DIR 的 sdk profile ====="
  if ! DSH_HOME="$HOME_DIR" dsh plugin --profile sdk add "$HERE/slow-tool-plugin" 2>&1 | grep -E 'slow-tool|Done'; then
    echo "装不上 slow-tool-plugin：没有它造不出'悬空工具调用'窗口，本对照无意义。" >&2
    exit 1
  fi
}

# 一臂：跑完把容器的镜像落点打出来。
# $1 = arm 名（safe|immediate），$2 = 会话 id，$3 = DSH_AUTOFORK_PARAMS（可为空）
arm() {
  local name="$1" session="$2" extra_params="$3"
  clean
  (cd "$HERE" && MOCK_PORT=$MOCK_PORT MOCK_SEQUENCE=tool_call_success,success \
     MOCK_TOOL_NAME=slow_wait MOCK_TOOL_ARGS="{\"ms\":$WAIT_TOOL_MS}" \
     node mock-server.mjs > "/tmp/e2e-dangling-mock-$name.log" 2>&1 &)
  sleep 3
  rm -f "/tmp/e2e-dangling-$name.log"
  (cd "$HERE" && \
    E2E_CWD="$WORK" E2E_SESSION_ID="$session" \
    E2E_STEP_WAIT_MS=10000 E2E_OBSERVE_MS=50000 \
    DSH_HOME="$HOME_DIR" DSH_AUTOFORK_DEBUG="/tmp/e2e-dangling-$name.log" \
    DSH_AUTOFORK_PARAMS="$extra_params" DEEPSEEK_API_KEY=mock-key \
    node drive.mjs > "/tmp/e2e-dangling-drive-$name.log" 2>&1)
  echo "===== 臂：$name ====="
  node - "$name" "$session" <<'NODE'
const name = process.argv[2]
const session = process.argv[3]
const frames = JSON.parse(require('node:fs').readFileSync('/tmp/autofork-e2e-frames.json', 'utf8'))
const events = frames.filter(f => f.method === 'session.event')
  .map(f => f.params).filter(p => p.sessionId === session).map(p => p.event)
const at = (type, pred) => events.find(e => e.type === type && (pred === undefined || pred(e)))
const toolCall = at('tool/call')
const toolResult = at('tool/result')
// 判据钉在 source.kind 上（内容文案会随用词调整，kind 才是身份）
const mirror = at('user/message', e => e.data?.source?.plugin === 'dsh-autofork'
  && e.data?.source?.kind === 'fork-answer')
const turnEnd = at('turn/end')
const seq = e => (e === undefined ? undefined : e.seq)
console.log(JSON.stringify({
  arm: name,
  toolCallSeq: seq(toolCall),
  toolResultSeq: seq(toolResult),
  firstMirrorSeq: seq(mirror),
  mirrorAfterToolResult: seq(mirror) > seq(toolResult),
  turnEndReason: turnEnd?.data?.reason?.kind,
}, null, 2))
NODE
  grep -o '"event":"mirror\.\(appended\|deferred\)"' "/tmp/e2e-dangling-$name.log" | sort | uniq -c
  echo
}

# 反向回灌已默认关（用户判定方向错了），而本对照要观察的正是"回灌消息的落点"，
# 所以两臂都显式打开它。
ensure_slow_tool
arm safe session-dangling-safe '{"mirrorInstanceReply":true}'
arm immediate session-dangling-bad '{"mirrorInstanceReply":true,"mirrorDelivery":"immediate"}'
pkill -f "mock-server.mjs" 2>/dev/null
rm -rf "$WORK"
echo "判据：safe 臂 mirrorAfterToolResult=true 且 turnEndReason=completed；immediate 臂 mirrorAfterToolResult=false。"
