/** 会话体积看门狗：什么时候该给会话「换血」。
 *
 * 纯函数，方便在测试里把边界钉死。阈值来自**模型声明的窗口**（不是估算的
 * 默认值）：窗口没声明时不做判断——宁可不换，也不要在错误的尺寸上误杀历史。
 */

/** 阈值比例的合法范围：太低会频繁换血，太高来不及。 */
export const MIN_RATIO = 0.1
export const MAX_RATIO = 0.95

/**
 * 这个会话是不是该换血了？
 *
 * @param tokens 当前会话的请求 token 估算（tokenMeter 的结果）
 * @param contextWindow 路由模型声明的上下文窗口；未知时传 null
 * @param ratio 触发比例（`sessionReset.thresholdRatio`）
 */
export function shouldResetSession(
  tokens: number,
  contextWindow: number | null,
  ratio: number,
): boolean {
  if (contextWindow === null || !Number.isFinite(contextWindow) || contextWindow <= 0) return false
  if (!Number.isFinite(tokens) || tokens <= 0) return false
  const clamped = Number.isFinite(ratio) ? Math.min(Math.max(ratio, MIN_RATIO), MAX_RATIO) : 0.7
  return tokens >= contextWindow * clamped
}
