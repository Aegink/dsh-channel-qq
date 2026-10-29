/** 复读死循环的四道防线（2026-10-29 实测后补的）。
 *
 * 当时的现象：拦截只回一句"换个说法再发"，模型看不见自己刚发过什么，于是每
 * 3–4 秒重试一次同一句，一小时被拦 **474 次**；每次重试都是一整步模型调用
 * （上下文 5.5 万 token），回合只能等会话看门狗 10–15 分钟后"判定卡死、强制换血"，
 * 而换血又把复读状态清零 —— 08:10 于是把 06:00 那条"早安"原样又发了一遍。
 *
 * 这里守住四件事：
 *   1. 拦截要计数（撞的是哪个开头、这一轮第几次）；
 *   2. 文案要给锚点并明说"别再重试同一条"；
 *   3. 连续被拦到阈值要**硬停**（`send-loop` → `agent/pre-step` reject）；
 *   4. 状态要落盘，换血/重启后同一条不能又发出去。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const { SendSignatureGuard, OUTPUT_SIGNATURE_REASONS } = await import('../src/core/guards/output-signatures.js')
const {
  SEND_LOOP_STRIKES, clearSendLoop, noteBlockedSend, resetSendLoopForTest, sendLoopTripped,
} = await import('../src/core/guards/send-loop.js')
const { createToolGateHooks } = await import('../src/features/qq-tools/register.js')
const { createSendGuardSaver, restoreSendGuard, sendGuardFile } = await import('../src/features/qq-tools/send-guard-store.js')
const { loadSignatureBundle } = await import('../src/features/inbound/index.js')

const bundle = await loadSignatureBundle(() => {})
assert.ok(bundle !== null, '签名规则包要能加载（assets/persona/default）')
const RULES = bundle.output
const MIN = RULES.repeatOpening.minChars

/** 让一条消息真的"发出去"两次，凑到复读阈值。 */
function seedRepeat(guard: InstanceType<typeof SendSignatureGuard>, room: string, text: string): void {
  const need = Math.max(1, RULES.repeatOpening.minRun - 1)
  for (let i = 0; i < need; i += 1) {
    assert.equal(guard.check(room, text), null, `第 ${i + 1} 条还不该拦`)
    guard.record(room, text)
  }
}

test('拦截计数：撞车的开头 + 这一轮第几次，发送成功后清零', () => {
  const guard = new SendSignatureGuard(RULES)
  const room = 'dm-10001'
  const text = '早安 学弟 今天要带伞了'
  seedRepeat(guard, room, text)
  assert.equal(guard.check(room, text), OUTPUT_SIGNATURE_REASONS.repeatOpening)

  const first = guard.noteBlocked(room, text)
  assert.equal(first.opening, text.slice(0, MIN))
  assert.equal(first.count, 1)
  assert.equal(guard.blockedRun(room), 1)

  const second = guard.noteBlocked(room, text)
  assert.equal(second.count, 2, '同一条再被拦，计数要涨')

  // 换个开头被拦：计数从 1 重新开始（换锚点就该重新算）
  const other = guard.noteBlocked(room, '换了个开头说说今天天气')
  assert.equal(other.count, 1)

  guard.record(room, text)
  assert.equal(guard.blockedRun(room), 0, '真的发出去一条就清零')
})

test('硬停：同一会话连续被拦到阈值才算打转，清一次就恢复', () => {
  resetSendLoopForTest()
  const session = 'qq-dm-10001'
  for (let i = 1; i < SEND_LOOP_STRIKES; i += 1) {
    assert.equal(noteBlockedSend(session), i)
    assert.equal(sendLoopTripped(session), false, `第 ${i} 次还不该硬停`)
  }
  assert.equal(noteBlockedSend(session), SEND_LOOP_STRIKES)
  assert.equal(sendLoopTripped(session), true, `第 ${SEND_LOOP_STRIKES} 次要硬停`)

  clearSendLoop(session)
  assert.equal(sendLoopTripped(session), false, '清零之后又能正常说话')

  noteBlockedSend('qq-dm-20002')
  assert.equal(sendLoopTripped(session), false, '不同会话各自计数')
})

test('闸门文案：给出撞车开头与次数，到阈值明说别再调发送工具', () => {
  resetSendLoopForTest()
  const guard = new SendSignatureGuard(RULES)
  const logs: string[] = []
  const hooks = createToolGateHooks({
    trustOf: () => 'master',
    guardText: (reasonKey) => `【拒绝:${reasonKey}】`,
    workspacePath: () => null,
    sendGuard: guard,
    log: (line) => logs.push(line),
    switches: { policyOn: () => true, toolsOn: () => false },
  })
  const text = '早安 学弟 今天要带伞了'
  const call = { name: 'qq_send_text', args: { isGroup: false, target: 10001, text }, agentId: 'qq-dm-10001' }
  seedRepeat(guard, 'dm-10001', text)

  const opening = text.slice(0, MIN)
  const first = hooks.decide(call)
  assert.equal(first.kind, 'deny')
  assert.ok(first.kind === 'deny' && first.reason.includes(`「${opening}」`), `要带上撞车的开头，实际：${first.kind === 'deny' ? first.reason : ''}`)
  assert.ok(first.kind === 'deny' && first.reason.includes('第 1 次'))
  assert.ok(first.kind === 'deny' && first.reason.includes('别再重试同一条'))

  const second = hooks.decide(call)
  assert.ok(second.kind === 'deny' && second.reason.includes('第 2 次'))

  const third = hooks.decide(call)
  assert.ok(third.kind === 'deny' && third.reason.includes('第 3 次'))
  assert.ok(third.kind === 'deny' && third.reason.includes('不要再调用任何发送工具'), '到阈值要明说停手')
  assert.equal(sendLoopTripped('qq-dm-10001'), true, '第三次要触发硬停')

  assert.ok(logs.some((line) => line.includes('repeat-opening') && line.includes(opening)), `日志要能看出撞了哪一句：${logs.join(' | ')}`)
})

test('发送成功会清掉硬停计数（换说法发出去之后不该再被掐）', () => {
  resetSendLoopForTest()
  const guard = new SendSignatureGuard(RULES)
  const hooks = createToolGateHooks({
    trustOf: () => 'master',
    guardText: (reasonKey) => `【拒绝:${reasonKey}】`,
    workspacePath: () => null,
    sendGuard: guard,
    log: () => {},
    switches: { policyOn: () => true, toolsOn: () => false },
  })
  const text = '早安 学弟 今天要带伞了'
  const call = { name: 'qq_send_text', args: { isGroup: false, target: 10001, text }, agentId: 'qq-dm-10001' }
  seedRepeat(guard, 'dm-10001', text)
  for (let i = 0; i < SEND_LOOP_STRIKES; i += 1) hooks.decide(call)
  assert.equal(sendLoopTripped('qq-dm-10001'), true)

  hooks.record(call, true)
  assert.equal(sendLoopTripped('qq-dm-10001'), false, '真的发出去就清零')
})

test('状态落盘：换血/重启后同一条不能再发一遍', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'send-guard-'))
  const file = sendGuardFile(dir)
  const room = 'dm-10001'
  const text = '早安 学弟 今天要带伞了'

  const before = new SendSignatureGuard(RULES)
  seedRepeat(before, room, text)
  assert.equal(before.check(room, text), OUTPUT_SIGNATURE_REASONS.repeatOpening, '落盘前就应该是拦的')

  // 落盘（节流 0ms → 立刻写）
  const save = createSendGuardSaver(() => before.snapshot(), file, () => {}, 0)
  save()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const written = JSON.parse(await readFile(file, 'utf8')) as { rooms: Array<{ room: string }> }
  assert.ok(written.rooms.some((item) => item.room === room), `要写出房间状态：${JSON.stringify(written)}`)

  // 新实例（模拟换血后重建）= 回灌之后仍然拦
  const after = new SendSignatureGuard(RULES)
  const restored = await restoreSendGuard(after, file, () => {})
  assert.equal(restored, 1)
  assert.equal(after.check(room, text), OUTPUT_SIGNATURE_REASONS.repeatOpening, '重启后不能把同一条再发一遍')

  // 坏文件不该把插件拖挂
  const broken = new SendSignatureGuard(RULES)
  assert.equal(await restoreSendGuard(broken, path.join(dir, 'nope.json'), () => {}), 0, '没有文件是正常状态')
  assert.equal(broken.restore({ rooms: 'not-an-array' }), 0, '坏结构忽略')
  assert.equal(broken.restore({ rooms: [{ room: 1 }, { room: 'dm-x', open: 'abc', run: -1 }] }), 0, '坏条目忽略')
})
