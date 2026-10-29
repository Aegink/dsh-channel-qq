/** 策略层的三个数字：口癖命中率、主动开口被回复率、情绪与回复长度的相关性。
 *
 * 全是纯统计（零 IO、零时钟）：输入是已经从盘上读出来的时间戳与文本，输出是可以
 * 直接摆到后台的一行结论。这样"口癖到底有没有用"就不再是感觉问题。
 *
 * 三个都要带**样本量**：只有比率没有样本量，等于用一个数字骗自己（3 条里中 1 条
 * 和 300 条里中 100 条，比率一样，可信度差一个数量级）。
 */

/** 一条口癖的命中统计。 */
export interface PhraseStat {
  readonly phrase: string
  readonly occurrences: number
}

/** 统计每条口癖在她的发言里出现过几次（子串命中，大小写不敏感）。 */
export function phraseHits(phrases: readonly string[], sentTexts: readonly string[]): PhraseStat[] {
  const haystack = sentTexts.map((text) => text.toLowerCase())
  const out: PhraseStat[] = []
  for (const phrase of phrases) {
    const needle = phrase.trim().toLowerCase()
    if (needle === '') continue
    let occurrences = 0
    for (const text of haystack) {
      // 一条发言里重复出现只算一次：这条要回答的是"她用不用这个说法"。
      if (text.includes(needle)) occurrences += 1
    }
    out.push({ phrase, occurrences })
  }
  return out.sort((a, b) => b.occurrences - a.occurrences || a.phrase.localeCompare(b.phrase))
}

/** 命中率 = 至少命中过一次的口癖条数 / 学到的口癖总数（0–1）。 */
export function phraseCoverage(stats: readonly PhraseStat[]): { covered: number; total: number; rate: number } {
  const total = stats.length
  const covered = stats.filter((s) => s.occurrences > 0).length
  return { covered, total, rate: total === 0 ? 0 : covered / total }
}

/** 一条带房间与时间的记录（入站或出站）。 */
export interface Timed {
  readonly at: number
  readonly room: string
}

/** 一次「她主动开口」的判定结果。 */
export interface ProactiveGap {
  readonly room: string
  readonly sentAt: number
  /** 之后多久收到回话（毫秒）；`null` = 窗口内没人理。 */
  readonly repliedAfterMs: number | null
}

/**
 * 把出站与入站配成「主动开口 → 有没有人接」。
 *
 * 判据是**两条时间窗**，都是可解释的近似：
 *   1. 发之前 `idleMs` 内这个房间**没有**入站 → 算她主动开口（否则是在回话）；
 *   2. 发之后 `replyWindowMs` 内这个房间**有**入站 → 算被回复。
 *
 * 为什么用近似而不是精确标记：精确标记要在回合发起处写一条日志（热路径改造），
 * 而这两个时间窗只用现有落盘数据就能算，代价是会把"她在别人说话 5 分钟后插话"
 * 误算成主动。宁可用一个说得清的近似，也不给热路径加埋点。
 */
export function pairProactive(
  sends: readonly Timed[],
  inbounds: readonly Timed[],
  opts: { readonly idleMs: number; readonly replyWindowMs: number },
): ProactiveGap[] {
  const byRoom = new Map<string, number[]>()
  for (const item of inbounds) {
    const list = byRoom.get(item.room)
    if (list === undefined) byRoom.set(item.room, [item.at])
    else list.push(item.at)
  }
  for (const list of byRoom.values()) list.sort((a, b) => a - b)
  const out: ProactiveGap[] = []
  for (const send of [...sends].sort((a, b) => a.at - b.at)) {
    const times = byRoom.get(send.room) ?? []
    const before = times.filter((t) => t <= send.at).at(-1)
    if (before !== undefined && send.at - before < opts.idleMs) continue // 是在回话，不算主动
    const after = times.find((t) => t > send.at && t - send.at <= opts.replyWindowMs)
    out.push({ room: send.room, sentAt: send.at, repliedAfterMs: after === undefined ? null : after - send.at })
  }
  return out
}

/** 被回复率（分母是主动开口次数）。 */
export function proactiveReplyRate(gaps: readonly ProactiveGap[]): { replied: number; total: number; rate: number } {
  const total = gaps.length
  const replied = gaps.filter((g) => g.repliedAfterMs !== null).length
  return { replied, total, rate: total === 0 ? 0 : replied / total }
}

/**
 * 皮尔逊相关系数（-1..1）。
 *
 * 样本少于 8 或任一列方差为 0 时返回 `null`：那种样本量下算出来的系数纯属噪音，
 * 报一个数字比报"样本不足"更糟。
 */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 8) return null
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]!
    sy += ys[i]!
  }
  const mx = sx / n
  const my = sy / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx
    const b = ys[i]! - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}
