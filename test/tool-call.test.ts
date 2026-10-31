/** 工具调用诊断：这一轮模型到底有没有调工具，必须能从日志里看出来。
 *
 * 为什么要这一步：回复全靠模型调用发送工具完成，所以"模型没调任何工具"的表现
 * 是**回合正常跑完、一句话没发**。2026-10-30 私聊连续四轮都是这个形状（每轮
 * `turn done`、7 秒、零发送、零 `agent error`），日志里没有任何异常可查，只能
 * 猜"是不是这个模型不支持 function calling"。
 *
 * 现在宿主把这一轮的步边界数随 idle 一起报出来（`agent/pre-step` 次数），账本
 * 在 1 步收工时写一条明确的诊断日志。测试断言的就是这三件事：
 *
 *   1. 1 步 → 日志写明"没有工具调用"；
 *   2. 多步 / 未知 → 日志与原来**逐字相同**（新增诊断不能改既有产物）；
 *   3. "重发无用"的失败（额度/鉴权）被单独认出来，并随失败事件上报。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isFutileToResend, classifyFailure } = await import('../src/core/retry-policy.js')
const { TurnTracker } = await import('../src/app/conversation/turn-tracker.js')
const { GatewayHealth } = await import('../src/app/conversation/gateway-health.js')
const { systemClock } = await import('../src/ports/clock.js')

type AgentSession = import('../src/ports/agent-gateway.js').AgentSession
type TurnErrorInfo = import('../src/ports/turn-hooks.js').TurnErrorInfo

/**
 * 线上那条 403 的原文（2026-10-30 22:07:00，群聊 `group-1000000004`）。
 *
 * 形状取自宿主日志：`JSON.stringify` 掉 message 之后只剩上游那一层 JSON，
 * 而 `classifyFailure` 与 `isFutileToResend` 都是对**这个串**做子串匹配。
 */
const QUOTA_403 = JSON.stringify({
  name: 'LlmError',
  message: '403: {"code":"insufficient_user_quota","message":"insufficient_user_quota","param":"","type":"upstream_error"}',
})

/** 一条值得重试的失败（网关抖动）：重发是有意义的。 */
const TIMEOUT = JSON.stringify({ name: 'LlmError', message: 'request timed out', code: 'TIMEOUT' })

function trackerHarness(): {
  tracker: InstanceType<typeof TurnTracker>
  logs: string[]
  errors: Array<{ kind: string; info?: TurnErrorInfo }>
} {
  const logs: string[] = []
  const errors: Array<{ kind: string; info?: TurnErrorInfo }> = []
  const session: AgentSession = {
    id: 'qq-group-1',
    isRunning: () => false,
    deliver: () => true,
    dispose: async () => true,
  }
  const tracker = new TurnTracker({
    room: 'group-1',
    health: new GatewayHealth(),
    clock: systemClock,
    log: (line) => logs.push(line),
    nudge: () => '接着做',
    injectMode: () => ({ enabled: false, wakeIdle: true }),
    roll: () => 0.5,
    onTurnError: (_room, kind, info) => errors.push({ kind, ...(info === undefined ? {} : { info }) }),
  })
  tracker.bind(session)
  return { tracker, logs, errors }
}

test('工具调用诊断：一轮只走 1 步 → 日志写明「没有工具调用」', () => {
  const h = trackerHarness()
  h.tracker.begin('一包', false)
  h.tracker.onIdle(1)
  assert.deepEqual(h.logs, ['turn done for group-1 (no tool call: 1 step)'])
})

test('工具调用诊断：多步收工 → 日志与原来逐字相同', () => {
  const h = trackerHarness()
  h.tracker.begin('一包', false)
  h.tracker.onIdle(3)
  h.tracker.begin('一包', false)
  h.tracker.onIdle()
  assert.deepEqual(h.logs, ['turn done for group-1', 'turn done for group-1'])
})

test('失败分类：额度 403 属于「重发无用的永久失败」', () => {
  const action = classifyFailure(QUOTA_403, { hadImages: false, textOnlyRetryDone: false })
  assert.equal(action.kind, 'permanent', '不该进退避重试链')
  assert.equal(isFutileToResend(QUOTA_403), true, '重发一百次还是同一个 403')
})

test('失败分类：网关超时不属于「重发无用」', () => {
  assert.equal(isFutileToResend(TIMEOUT), false, '抖动类失败重发是有意义的')
  assert.equal(classifyFailure(TIMEOUT, { hadImages: false, textOnlyRetryDone: false }).kind, 'retry')
})

test('失败分类：分类结论随失败事件交给告知层', () => {
  const h = trackerHarness()
  h.tracker.begin('一包', false)
  h.tracker.onError({ raw: QUOTA_403 })
  assert.deepEqual(h.errors, [{ kind: 'permanent', info: { resendFutile: true } }])

  const other = trackerHarness()
  other.tracker.begin('一包', false)
  other.tracker.onError({ raw: TIMEOUT })
  assert.equal(other.errors[0]?.info?.resendFutile, false)
})

/** 带投递记录的账本：催发是 `deliver` 出去的一句话，必须能断言它发了几次、发的是什么。 */
function nudgeHarness(): {
  tracker: InstanceType<typeof TurnTracker>
  sent: Array<{ content: unknown; mode: string }>
  logs: string[]
} {
  const sent: Array<{ content: unknown; mode: string }> = []
  const logs: string[] = []
  const session: AgentSession = {
    id: 'qq-group-1',
    isRunning: () => false,
    deliver: (content, mode) => { sent.push({ content, mode }); return true },
    dispose: async () => true,
  }
  const tracker = new TurnTracker({
    room: 'group-1',
    health: new GatewayHealth(),
    clock: systemClock,
    log: (line) => logs.push(line),
    nudge: () => '接着做',
    mustSendNudge: () => '用 qq_message 把它发出去',
    injectMode: () => ({ enabled: false, wakeIdle: true }),
    roll: () => 0.5,
  })
  tracker.bind(session)
  return { tracker, sent, logs }
}

test('零工具调用：用户回合结束 → 催模型自己用工具发，而不是代发文本', () => {
  const h = nudgeHarness()
  h.tracker.begin('一包', false, true)
  h.tracker.onIdle(1)
  assert.equal(h.sent.length, 1, '应该补一句催发')
  assert.equal(h.sent[0]!.mode, 'followup')
  assert.match(JSON.stringify(h.sent[0]!.content), /qq_message/)
  assert.ok(h.logs.some((line) => line.includes('asking group-1 to send it via the tool')))
})

test('零工具调用：一轮最多催一次（模型还只写文本就收手）', () => {
  const h = nudgeHarness()
  h.tracker.begin('一包', false, true)
  h.tracker.onIdle(1)
  h.tracker.onIdle(1)
  h.tracker.onIdle(1)
  assert.equal(h.sent.length, 1, '不能来回拉扯成无限回合')
})

test('零工具调用：主动回合可以沉默，不催', () => {
  const h = nudgeHarness()
  h.tracker.begin('巡逻', false, false)
  h.tracker.onIdle(1)
  assert.equal(h.sent.length, 0, '巡逻/做梦本来就可以不说话')
})

test('零工具调用：这一轮调过工具就不催', () => {
  const h = nudgeHarness()
  h.tracker.begin('一包', false, true)
  h.tracker.onIdle(3)
  assert.equal(h.sent.length, 0)
})

test('零工具调用：新的一包重置催发状态', () => {
  const h = nudgeHarness()
  h.tracker.begin('一包', false, true)
  h.tracker.onIdle(1)
  assert.equal(h.sent.length, 1)
  h.tracker.begin('第二包', false, true)
  h.tracker.onIdle(1)
  assert.equal(h.sent.length, 2, '每个用户回合都该有自己的机会')
})

test('同回合纠正：回合边界问账本 → 用户回合零工具调用时给一句话', () => {
  const h = nudgeHarness()
  h.tracker.begin('一包', false, true)
  const text = h.tracker.sendCorrection(1)
  assert.ok(text !== null && text.includes('qq_message'), '应该请宿主在本回合内再走一步')
  assert.equal(h.sent.length, 0, '同回合纠正走 steer，不走 deliver')
})

test('同回合纠正：与回合结束后的兜底共用标记，绝不催两次', () => {
  const h = nudgeHarness()
  h.tracker.begin('一包', false, true)
  assert.ok(h.tracker.sendCorrection(1) !== null)
  // 边界已经催过：这一轮结束时不该再补一次（否则同一个回合催两遍）
  h.tracker.onIdle(1)
  assert.equal(h.sent.length, 0)
})

test('同回合纠正：调过工具 / 主动回合 / 重复边界都不插手', () => {
  const call = nudgeHarness()
  call.tracker.begin('一包', false, true)
  assert.equal(call.tracker.sendCorrection(3), null, '调过工具就不管')

  const proactive = nudgeHarness()
  proactive.tracker.begin('巡逻', false, false)
  assert.equal(proactive.tracker.sendCorrection(1), null, '主动回合可以沉默')

  const twice = nudgeHarness()
  twice.tracker.begin('一包', false, true)
  assert.ok(twice.tracker.sendCorrection(1) !== null)
  assert.equal(twice.tracker.sendCorrection(1), null, '同一个回合只催一次')
})
