/** 回合即将关闭时纠正「只写了文本、话没发出去」。
 *
 * 为什么落在这里而不是等回合结束再补一轮：宿主在回合边界会跑 `agent/turn-stopping`
 * （serial 瀑布），文档写明"a listener that objects steers (`agent.steer(...)`) and the
 * machine re-reads its inbox: fresh steering runs another step"——也就是**同一个回合里**
 * 再走一步，不多开一个回合，日志里也不会多出一条 `turn done`。
 *
 * 判据与文案都由调用方的回合账本给（`sendCorrection`）：这里只管"要不要插手 + 插手
 * 的方式"，策略留在 `app/`（谁在等回复、这一轮走了几步、是不是已经催过）。
 *
 * 为什么单独一个文件：`agents.ts` 贴着 400 行的体量棘轮上限（与 `send-loop.ts` 同一
 * 个理由）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionSpec } from '../../ports/agent-gateway.js'
import { buildUserMessage, onAgentEvent, steerAgent } from './agent.js'
import { peekTurnSteps } from './turn-steps.js'

/** 已经装过的 agent 上下文（接上的动作每个会话会跑 ≥2 次）。 */
const installed = new WeakSet<object>()

export function installTurnStopping(agentCtx: Context, spec: SessionSpec): void {
  const key = agentCtx as unknown as object
  if (installed.has(key)) return
  installed.add(key)
  onAgentEvent(agentCtx, 'agent/turn-stopping', (payload) => {
    const text = spec.listener.sendCorrection?.(peekTurnSteps(agentCtx)) ?? null
    if (text === null || text.trim() === '') return
    // 拿不到 steer 能力就安静放弃：账本那边还有回合结束后的兜底催发。
    if (!steerAgent(payload.agent, buildUserMessage([{ type: 'text', text }]))) {
      spec.log('turn-stopping: agent 没有 steer 能力，跳过本回合内纠正')
      return
    }
    spec.log(`turn-stopping: 本轮零工具调用，已在同一回合内催 ${spec.sessionId} 调用发送工具`)
  })
}
