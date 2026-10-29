/** 同一回合里"复读"被连续拦到第 N 次，就结束这一轮——别再让模型空转。
 *
 * 为什么需要这一层：`output-signatures` 只负责**拦下**这一条，回合不会因此结束。
 * 2026-10-29 实测（`channel-qq.log`）：拦截文案只说"换个说法再发"，模型看不见
 * 自己刚发过什么，于是每 3–4 秒重试一次同一句，一小时被拦 **474 次**；每次重试
 * 都是一整步模型调用（当时上下文 5.5 万 token）。回合因此永远结束不了，只能等
 * 会话看门狗在 10–15 分钟后"判定卡死、强制换血"——而那一步又会让复读状态清零，
 * 于是同一条又被发出去一遍。
 *
 * 这里只做一件事：按会话计数，到阈值就让 `agent/pre-step` 返回 `{kind:'reject'}`
 * 把这一轮干净收尾（`installStepBudget` 用的就是同一条杠杆）。
 *
 * 纯内存、无时钟、无 IO：计数会在发送成功或回合结束时清零，进程重启也就丢了——
 * 丢了的后果只是"少拦一次"，不会误伤正常对话。
 */

/** 同一回合连续被拦几次就结束这一轮。3 次足够确认模型在打转，又不至于误杀。 */
export const SEND_LOOP_STRIKES = 3

/** 有界：会话数很少，但别让异常路径把这张表撑大。 */
const MAX_TRACKED = 200

const strikes = new Map<string, number>()

/** 记一次"因为复读被拦"，返回这一轮累计被拦次数。 */
export function noteBlockedSend(sessionId: string): number {
  if (sessionId === '') return 0
  const next = (strikes.get(sessionId) ?? 0) + 1
  strikes.delete(sessionId)
  strikes.set(sessionId, next)
  while (strikes.size > MAX_TRACKED) {
    const oldest = strikes.keys().next().value
    if (oldest === undefined) break
    strikes.delete(oldest)
  }
  return next
}

/** 这一轮该不该直接结束（连续被拦到阈值）。 */
export function sendLoopTripped(sessionId: string): boolean {
  return (strikes.get(sessionId) ?? 0) >= SEND_LOOP_STRIKES
}

/** 清零（发送成功、或回合结束）。 */
export function clearSendLoop(sessionId: string): void {
  strikes.delete(sessionId)
}

/** 只给测试用：把整张表清空。 */
export function resetSendLoopForTest(): void {
  strikes.clear()
}
