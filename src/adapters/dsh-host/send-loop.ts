/** 复读死循环的硬停：接 `agent/pre-step`，到阈值就让这一轮干净收尾。
 *
 * 为什么单独一个文件：`agents.ts` 已经贴着 400 行的体量棘轮上限，这段逻辑虽然
 * 和步数预算同构，但不该把它挤爆。
 *
 * 为什么需要它：拦截（`output-signatures`）只负责**拦下这一条**，回合不会因此
 * 结束。模型看不见自己刚发过什么，会一直重试同一条——2026-10-29 实测一小时被拦
 * 474 次、每次都是一整步模型调用，回合最后只能靠会话看门狗在 10–15 分钟后
 * "判定卡死、强制换血"。这里用与步数预算同一个杠杆收尾。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionSpec } from '../../ports/agent-gateway.js'
import { SEND_LOOP_STRIKES, clearSendLoop, sendLoopTripped } from '../../core/guards/send-loop.js'
import { onAgentEvent } from './agent.js'

/** 已经装过的 agent 上下文（接上的动作每个会话会跑 ≥2 次）。 */
const installed = new WeakSet<object>()

export function installSendLoopGuard(agentCtx: Context, spec: SessionSpec): void {
  const key = agentCtx as unknown as object
  if (installed.has(key)) return
  installed.add(key)
  // 回合结束就清零：这是"这一轮在打转"，不是"这个会话以后不许说话"。
  onAgentEvent(agentCtx, 'agent/status', (payload) => {
    if (payload?.status === 'idle') clearSendLoop(spec.sessionId)
  })
  onAgentEvent(agentCtx, 'agent/pre-step', (_payload, next) => {
    if (sendLoopTripped(spec.sessionId)) {
      spec.log(`send loop: 连续 ${SEND_LOOP_STRIKES} 次复读拦截，结束这一轮（不再重试同一条）`)
      clearSendLoop(spec.sessionId)
      return Promise.resolve({ kind: 'reject' })
    }
    return next()
  })
}
