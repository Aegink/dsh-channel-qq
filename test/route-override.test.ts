/** 会话路由跟随当前配置：接回来的旧会话不许再按老 provider 发请求。
 *
 * 这条测试直接对应 2026-10-30 的事故：群会话 `qq-group-1000000004` 每次重启走
 * `agents.resume()` 恢复，而那条路径当时**没有**装路由覆盖，于是它一直按上一次
 * 运行的 `windhub/grok-4.7` 发请求（该账号额度耗尽），每轮 `403
 * insufficient_user_quota`，累计 537 次；同一时刻私聊已经换成 `maas-api-unisound`。
 *
 * 断言的是三件事：
 *
 *   1. 请求被改写成当前配置的路由（不是持久化头里那条）；
 *   2. 同一个上下文只挂一个监听器——重复接上不叠加、不重复改写；
 *   3. 换成新配置后立即生效（后台改模型不用重启，也不用重建会话）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { installModelOverride } = await import('../src/adapters/dsh-host/route-override.js')

type Selection = { provider: string; model: string }
type Handler = (payload: unknown, next: () => Promise<Selection>) => unknown

/** 一个能手动触发 `agent/request` 的 agent 上下文（宿主那边只用到 `on()`）。 */
function ctxHarness(): { ctx: { on(event: string, handler: Handler): () => void }; request(actual: Selection): Promise<Selection> } {
  const handlers: Handler[] = []
  const ctx = {
    on(_event: string, handler: Handler) {
      handlers.push(handler)
      return () => {}
    },
  }
  return {
    ctx,
    async request(actual: Selection): Promise<Selection> {
      assert.equal(handlers.length, 1, '同一个上下文只该挂一个路由覆盖监听器')
      const next = async (): Promise<Selection> => actual
      return await handlers[0]!({}, next) as Selection
    },
  }
}

/** 上一次运行留在会话头里的那条路由（额度已耗尽）。 */
const STALE: Selection = { provider: 'windhub', model: 'grok-4.7' }
/** 当前配置该用的路由。 */
const CURRENT: Selection = { provider: 'maas-api-unisound', model: 'u2-flash' }

test('路由覆盖：接回来的会话按当前配置发请求，而不是持久化头里那条', async () => {
  const h = ctxHarness()
  installModelOverride(h.ctx as never, CURRENT)
  assert.deepEqual(await h.request(STALE), CURRENT)
})

test('路由覆盖：重复接上不叠加监听器，换成新配置后立即生效', async () => {
  const h = ctxHarness()
  installModelOverride(h.ctx as never, CURRENT)
  installModelOverride(h.ctx as never, { provider: 'other', model: 'x-1' })
  // request() 里断言了"只有一个监听器"，这里再断言它用的是最后一次的配置。
  assert.deepEqual(await h.request(STALE), { provider: 'other', model: 'x-1' })
})

test('路由覆盖：已经一致时原样返回，不复制对象', async () => {
  const h = ctxHarness()
  installModelOverride(h.ctx as never, CURRENT)
  const input: Selection = { ...CURRENT }
  assert.equal(await h.request(input), input, '已经一致就该原样返回，不复制对象')
})
