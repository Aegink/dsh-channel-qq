/** 网关重试策略：什么样的失败值得重试、退避多久、什么时候放弃。
 *
 * 这段逻辑原来长在 `attachTurnWatch` 的事件回调里——一个"读到什么字符串就决定
 * 后续行为"的判断，埋在宿主事件监听器内部，只能靠**真的让网关过载**来验证。
 * 搬成纯函数之后，"过载/限流/超时该重试、参数错误不该重试、带图被拒要改发纯文本"
 * 这些结论可以逐条测。
 *
 * 判据是错误对象 JSON 化之后的**子串匹配**而不是结构化字段：宿主把上游错误塞进
 * 一个自由形状里，我们没有比这更可靠的抓手。这是当前实现的事实，不是设计偏好，
 * 所以刻意保持原样——换掉它要等 06 §P6 的
 * `policy.v2`（那时才有结构化的失败分类）。
 */

/** 一个数据包最多重试几次（含退避链）之后丢弃。 */
export const GATEWAY_RETRY_MAX = 8

/** 值得重试的错误码。 */
const RETRIABLE_CODES = ['SERVER', 'RATE_LIMIT', 'PI_AI_ERROR', 'TIMEOUT'] as const

/** 指数退避：30s 起、每次翻倍、封顶 3 分钟、±20% 抖动。`roll` 由调用方注入。 */
export function gatewayBackoffMs(attempt: number, roll: () => number): number {
  const base = Math.min(30_000 * 2 ** (attempt - 1), 180_000)
  return Math.round(base * (0.8 + roll() * 0.4))
}

/** 一次回合失败该怎么处理。 */
export type FailureAction =
  /** 带图的请求被整个拒了：正文还在，改成纯文本重试一次。 */
  | { readonly kind: 'retry-text-only' }
  /** 网关形状的失败：退避之后重新驱动这一包。 */
  | { readonly kind: 'retry' }
  /** 永久性失败：不在这里重试（例如请求本身就非法）。 */
  | { readonly kind: 'permanent' }

/**
 * 分类一次 agent 失败。
 *
 * `raw` 是错误对象 `JSON.stringify` 之后的串（拿不到 message 时就是整个 payload）。
 * `hadImages` / `textOnlyRetryDone` 是"这一轮带过图没有""纯文本重试试过没有"——
 * 同一个错误在两种状态下要采取不同动作，所以它们是入参而不是内部状态。
 */
export function classifyFailure(
  raw: string,
  state: { readonly hadImages: boolean; readonly textOnlyRetryDone: boolean },
): FailureAction {
  // Image-bearing request rejected outright (count/size/vision-outage): the
  // conversation text is intact, so retry once text-only instead of losing the turn.
  const imageShaped = (raw.includes('"INVALID_REQUEST"') || raw.includes('"SERVER"'))
    && state.hadImages
    && !state.textOnlyRetryDone
  if (imageShaped) return { kind: 'retry-text-only' }
  const retriable = RETRIABLE_CODES.some((code) => raw.includes(`"${code}"`))
  return retriable ? { kind: 'retry' } : { kind: 'permanent' }
}
/**
 * 「重发不会有任何不同结果」的失败：额度耗尽、鉴权失败、账号欠费、模型被下线。
 *
 * 这类失败与网络抖动相反——用户照着提示再发一百次，收到的还是同一个 403，
 * 于是「再发一次试试」既是错误建议，又会看起来像机器人在反复刷屏（2026-10-30
 * 群里连续 537 次 `403 insufficient_user_quota` 就是这个形状）。真正要做的是
 * 让管理员去续费/换 key/换模型，所以判据单独抽出来，供告知层分流。
 *
 * 判据同样是子串匹配（与 `classifyFailure` 同一个理由，见文件头）。
 */
const FUTILE_MARKERS = [
  'insufficient_user_quota',
  'insufficient_quota',
  'exceeded your current quota',
  'invalid_api_key',
  'incorrect_api_key',
  'invalid_authentication',
  'authentication_error',
  'account_overdue',
  'arrearage',
  'model_not_found',
] as const

/** 这次失败是不是「重发也没用」的那一类。 */
export function isFutileToResend(raw: string): boolean {
  const lower = raw.toLowerCase()
  return FUTILE_MARKERS.some((marker) => lower.includes(marker))
}
