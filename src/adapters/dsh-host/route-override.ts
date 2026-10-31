/** 把**当前**该用的 provider/model 压到接回来的会话上。
 *
 * 为什么需要它：会话的请求头是持久化的，里面写着**上一次运行**时的 provider/model。
 * 换了供应商或换掉一个下线的模型之后，那些会话仍在按旧路由发请求——2026-10-30
 * 群会话锁死在 `windhub/grok-4.7`、每轮 `403 insufficient_user_quota` 累计 537 次，
 * 就是"恢复出来的会话没人改它的路由"。
 *
 * 为什么是一个可改的槽而不是闭包：`finish()` 每次接上都会调用本函数，而同一个
 * agent 上下文可能被接上多次。挂第二个监听器只会把同一个请求改两遍；把 selection
 * 直接闭包进去，后台换模型之后老会话就再也跟不过来了。
 *
 * 为什么单独一个文件：`agents.ts` 贴着 400 行的体量棘轮上限（与 `send-loop.ts`
 * 同一个理由）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { onAgentEvent } from './agent.js'

/** agent 上下文 → 当前要强制使用的路由。 */
const slots = new WeakMap<object, { provider: string; model: string }>()

/** 装（或更新）路由覆盖。同一个上下文只挂一个监听器。 */
export function installModelOverride(
  agentCtx: Context,
  selection: { provider: string; model: string },
): void {
  const key = agentCtx as unknown as object
  const existing = slots.get(key)
  if (existing !== undefined) {
    existing.provider = selection.provider
    existing.model = selection.model
    return
  }
  const slot = { provider: selection.provider, model: selection.model }
  slots.set(key, slot)
  onAgentEvent(agentCtx, 'agent/request', (_payload, next) => {
    return next().then((resolved) => {
      if (resolved.provider === slot.provider && resolved.model === slot.model) return resolved
      return { ...resolved, provider: slot.provider, model: slot.model }
    })
  })
}
