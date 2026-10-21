/** 交互提示（A1）：输入状态与表情回应的开关语义、调用序列、失败降级。
 *
 * 这条测试防的是三件事：
 *   1. **默认关 = 零协议动作**（关着时不能多发一个包，golden 才站得住）；
 *   2. **撤销的是当时发出去的那一个**（回合中途改配置/表情 id 不会撤错）；
 *   3. **提示失败不能拖垮回合**（只写日志，不抛）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { Interaction } = await import('../src/features/interaction/index.js')
const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
const { fakeClient } = await import('./fakes/host.js')

interface Cfg {
  typingIndicator: boolean
  ackReaction: boolean
  ackEmojiId: string
}

const OFF: Cfg = { typingIndicator: false, ackReaction: false, ackEmojiId: '424' }

function harness(initial: Cfg = OFF) {
  const client = fakeClient()
  const api = createQQApi(client as never)
  let cfg = initial
  const logs: string[] = []
  const interaction = new Interaction({
    api: () => api,
    config: () => cfg,
    log: (line) => logs.push(line),
  })
  return {
    client,
    interaction,
    logs,
    setConfig(next: Cfg) { cfg = next },
  }
}

const privateEvent = {
  time: 0, self_id: 1, post_type: 'message', message_type: 'private', message_id: 11, user_id: 22,
} as never
const groupEvent = {
  time: 0, self_id: 1, post_type: 'message', message_type: 'group', message_id: 33, user_id: 44, group_id: 55,
} as never

test('交互提示：开关全关 → 一个协议动作都不发', () => {
  const h = harness()
  h.interaction.begin('dm-22', privateEvent)
  h.interaction.end('dm-22')
  assert.deepEqual(h.client.calls, [])
})

test('交互提示：私聊不贴表情（SnowLuma 实测 retcode 100）', () => {
  const h = harness({ ...OFF, ackReaction: true })
  h.interaction.begin('dm-22', privateEvent)
  h.interaction.end('dm-22')
  assert.deepEqual(h.client.calls, [])
})

test('交互提示：私聊回合 → 开始输入、结束取消', () => {
  const h = harness({ ...OFF, typingIndicator: true })
  h.interaction.begin('dm-22', privateEvent)
  assert.deepEqual(h.client.calls, [
    { action: 'set_input_status', params: { user_id: 22, event_type: 1 } },
  ])
  h.interaction.end('dm-22')
  assert.deepEqual(h.client.calls[1], {
    action: 'set_input_status', params: { user_id: 22, event_type: 0 },
  })
})

test('交互提示：群聊不发输入状态，但会贴/撤表情', () => {
  const h = harness({ ...OFF, typingIndicator: true, ackReaction: true })
  h.interaction.begin('group-55', groupEvent)
  assert.deepEqual(h.client.calls, [
    { action: 'set_msg_emoji_like', params: { message_id: 33, emoji_id: '424', set: true } },
  ])
  h.interaction.end('group-55')
  assert.deepEqual(h.client.calls[1], {
    action: 'set_msg_emoji_like', params: { message_id: 33, emoji_id: '424', set: false },
  })
})

test('交互提示：回合中途改开关/改表情 id，结束仍撤原表情', () => {
  const h = harness({ ...OFF, ackReaction: true, ackEmojiId: '424' })
  h.interaction.begin('group-55', groupEvent)
  h.setConfig({ ...OFF, ackReaction: true, ackEmojiId: '999' })
  h.interaction.end('group-55')
  assert.deepEqual(h.client.calls[1], {
    action: 'set_msg_emoji_like', params: { message_id: 33, emoji_id: '424', set: false },
  })
})

test('交互提示：同一房间重复 begin → 先撤上一轮再贴新的', () => {
  const h = harness({ ...OFF, ackReaction: true })
  h.interaction.begin('group-55', groupEvent)
  h.interaction.begin('group-55', groupEvent)
  assert.deepEqual(
    h.client.calls.map((c) => c.params.set),
    [true, false, true],
  )
})

test('交互提示：协议动作失败只写日志，不抛、不影响后续', async () => {
  const logs: string[] = []
  const interaction = new Interaction({
    api: () => ({
      setInputStatus: async () => { throw new Error('boom') },
      setMessageEmojiLike: async () => { throw new Error('boom') },
    }) as never,
    config: () => ({ ...OFF, typingIndicator: true, ackReaction: true }),
    log: (line) => logs.push(line),
  })
  interaction.begin('dm-22', privateEvent)
  interaction.end('dm-22')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(logs.length, 2)
  assert.match(logs[0] ?? '', /input status on failed for dm-22: boom/)
})
