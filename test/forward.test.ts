/** 合并转发（A3）：开关语义、节点内容、超限/失败回退。
 *
 * 这条测试防的是"卡片吞内容"：开关关着必须逐条发；打开后只有条数在
 * [阈值, maxNodes] 且没有单条超长时才改发卡片；转发失败必须回退逐条发。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { registerQQTools } = await import('../src/features/qq-tools/register.js')
const { resolveConfig } = await import('../src/config.js')
const { createQQApi } = await import('../src/adapters/onebot/qq-api.js')
const { fakeClient, fakeOut, toolRecorder } = await import('./fakes/host.js')

const SELF = 1705
const GROUP = 107
const MASTER = 280

const SEG = { enabled: true, style: 'active' as const, minLength: 8, maxSegments: 20, removeTrailingPeriod: false }
const TEXT = '第一句。第二句。第三句。'

function harness(opts: {
  forward: { longReplyThreshold: number; maxNodes: number }
  responses?: Record<string, unknown>
  failForward?: boolean
}) {
  const { ctx, definitions } = toolRecorder()
  const client = fakeClient(opts.responses)
  const api = createQQApi(client as never)
  const target = opts.failForward === true
    ? {
        ...api,
        sendGroupForward: async () => { throw new Error('forward rejected') },
        sendPrivateForward: async () => { throw new Error('forward rejected') },
      }
    : api
  const logs: string[] = []
  const config = resolveConfig({
    selfId: SELF, admins: [MASTER], primaryGroup: GROUP, workspacePath: '/tmp/ws',
    segmentation: SEG, forward: opts.forward,
  })
  registerQQTools(ctx, config, target as never, fakeOut() as never, (line: string) => { logs.push(line) })
  return {
    calls: client.calls,
    logs,
    async run(args: Record<string, unknown>) {
      const def = definitions.find((d) => d.name === 'qq_send_text')
      assert.ok(def)
      return await (def!.execute as (a: unknown) => Promise<unknown>)(args)
    },
  }
}

const OK = { get_group_list: [{ group_id: GROUP }], get_group_info: { group_name: '主群' }, get_login_info: { user_id: SELF, nickname: '诺诺' } }
const DIRECT = 'send_group_msg'

test('合并转发：开关关着 → 逐条发送，没有转发动作', async () => {
  const h = harness({ forward: { longReplyThreshold: 0, maxNodes: 20 }, responses: OK })
  await h.run({ isGroup: true, target: GROUP, text: TEXT })
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 3)
  assert.equal(h.calls.some((c) => c.action === 'send_group_forward_msg'), false)
  assert.equal(h.calls.some((c) => c.action === 'get_login_info'), false)
})

test('合并转发：达到阈值 → 一条卡片，节点带机器人昵称与各段正文', async () => {
  const h = harness({ forward: { longReplyThreshold: 3, maxNodes: 20 }, responses: OK })
  const result = await h.run({ isGroup: true, target: GROUP, text: TEXT })
  assert.equal(h.calls.some((c) => c.action === DIRECT), false, '不该再逐条发')
  const forward = h.calls.find((c) => c.action === 'send_group_forward_msg')
  assert.ok(forward)
  const nodes = forward!.params.messages as Array<{ type: string; data: { nickname: string; content: Array<{ data: { text: string } }> } }>
  assert.equal(nodes.length, 3)
  assert.equal(nodes[0]!.data.nickname, '诺诺')
  assert.equal(nodes[2]!.data.content[0]!.data.text, '第三句。')
  assert.equal((result as { forwarded?: boolean }).forwarded, true)
})

test('合并转发：条数低于阈值 → 仍逐条发送', async () => {
  const h = harness({ forward: { longReplyThreshold: 4, maxNodes: 20 }, responses: OK })
  await h.run({ isGroup: true, target: GROUP, text: TEXT })
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 3)
  assert.equal(h.calls.some((c) => c.action === 'send_group_forward_msg'), false)
})

test('合并转发：条数超过 maxNodes → 回退逐条（不截断）', async () => {
  const h = harness({ forward: { longReplyThreshold: 2, maxNodes: 2 }, responses: OK })
  await h.run({ isGroup: true, target: GROUP, text: TEXT })
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 3)
  assert.equal(h.calls.some((c) => c.action === 'send_group_forward_msg'), false)
})

test('合并转发：转发失败 → 回退逐条，内容不丢', async () => {
  const h = harness({ forward: { longReplyThreshold: 2, maxNodes: 20 }, responses: OK, failForward: true })
  await h.run({ isGroup: true, target: GROUP, text: TEXT })
  assert.equal(h.calls.filter((c) => c.action === DIRECT).length, 3)
  assert.equal(h.logs.some((l) => l.includes('forward failed')), true)
})

test('合并转发：私聊走 send_private_forward_msg', async () => {
  const h = harness({
    forward: { longReplyThreshold: 2, maxNodes: 20 },
    responses: { ...OK, get_friend_list: [{ user_id: MASTER }] },
  })
  await h.run({ isGroup: false, target: MASTER, text: '第一句。第二句。' })
  assert.equal(h.calls.some((c) => c.action === 'send_private_forward_msg'), true)
})
