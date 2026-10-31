/** 这一轮走了几步：诊断"她收到了消息却一句话没发"。
 *
 * 宿主在每个步边界都会跑一次 `agent/pre-step`，所以"一次模型调用"记一步。于是
 * **1 步收工 = 模型没有调用任何工具**——回复全靠工具发出去，那一轮就必然静默。
 * 2026-10-30 的 u2-flash 事故就是这个形状：私聊每轮 `turn done`、耗时 7 秒、
 * 零发送，而日志里看不出任何异常，只能靠猜"是不是模型不支持 function calling"。
 *
 * 为什么单独一个文件：`agents.ts` 贴着 400 行的体量棘轮上限（与 `send-loop.ts`
 * 同一个理由）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { onAgentEvent } from './agent.js'

/** 每个 agent 上下文一个计数器；接上的动作每个会话会跑 ≥2 次，必须去重。 */
const counters = new WeakMap<object, { count: number }>()

/** 装上步数计数（同一个上下文只装一次）。 */
export function installTurnSteps(agentCtx: Context): void {
  const key = agentCtx as unknown as object
  if (counters.has(key)) return
  const counter = { count: 0 }
  counters.set(key, counter)
  onAgentEvent(agentCtx, 'agent/pre-step', (_payload, next) => {
    counter.count += 1
    return next()
  })
}

/**
 * 取走这一轮的步数并清零。
 *
 * 取走而不是只读：同一个上下文上可能挂着不止一个 idle 监听器（`watchTurns`
 * 每次接上都会再装一遍），只读会让同一条诊断报两次。
 *
 * @returns 这一轮的步数；没装过计数时为 0（未知，不是"零步"）。
 */
export function takeTurnSteps(agentCtx: Context): number {
  const counter = counters.get(agentCtx as unknown as object)
  if (counter === undefined) return 0
  const steps = counter.count
  counter.count = 0
  return steps
}

/**
 * 只读这一轮的步数，**不**清零（回合边界要在 idle 之前判断）。
 *
 * @returns 这一轮的步数；没装过计数时为 0。
 */
export function peekTurnSteps(agentCtx: Context): number {
  return counters.get(agentCtx as unknown as object)?.count ?? 0
}
