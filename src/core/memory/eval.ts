/** 记忆评测的解析与退化判定（纯函数，零 IO）。
 *
 * 评测本身在 `eval/memory/run.mjs`——它测的是**检索侧**（recall@8 / 延迟 / 注入预算），
 * **不调模型**（抽取质量才要模型）。所以夜间跑它的成本是一次进程启动 + 几秒 CPU，
 * 没有 token 开销——这也是为什么 `memory.evalEnabled` 可以默认开着。
 *
 * 这里只做两件事：把 `--json` 的输出收成一条可比较的样本；回答"比基线差了多少"。
 * 判定要能说人话，否则告警只会让人把开关关掉。
 */

/** 一次评测的样本（落进 `eval/history.jsonl` 的也是这个形状）。 */
export interface BenchSample {
  /** 主指标：recall@k。 */
  readonly recallAtK: number
  /** 参与打分的题数（语料太少时样本会很小，样本太小时结论不可信）。 */
  readonly recallSample: number
  readonly latencyP95Ms: number
  readonly injectCharsMax: number
  /** 语料规模：拿它判断"这次分数是不是语料变了导致的"。 */
  readonly activeRecords: number
  readonly k: number
}

/** 一条样本 + 时间（历史文件里的一行）。 */
export interface BenchPoint extends BenchSample {
  readonly at: number
}

/** 从 `run.mjs --json` 的输出里读出样本；形状不对返回 null（绝不猜）。 */
export function parseBenchReport(raw: unknown): BenchSample | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const recall = r.recallAtK
  const sample = r.recallSample
  const latency = r.latency as Record<string, unknown> | undefined
  const inject = r.injectChars as Record<string, unknown> | undefined
  const k = r.k
  if (typeof recall !== 'number' || !Number.isFinite(recall)) return null
  if (typeof sample !== 'number' || !Number.isFinite(sample)) return null
  const p95 = latency?.p95
  const max = inject?.max
  return {
    recallAtK: recall,
    recallSample: sample,
    latencyP95Ms: typeof p95 === 'number' && Number.isFinite(p95) ? p95 : 0,
    injectCharsMax: typeof max === 'number' && Number.isFinite(max) ? max : 0,
    activeRecords: typeof r.activeRecords === 'number' ? r.activeRecords : 0,
    k: typeof k === 'number' && Number.isFinite(k) ? k : 8,
  }
}

/** 判定结果。`reason` 是给人看的一句话，会直接进告警。 */
export interface RegressionVerdict {
  readonly regressed: boolean
  readonly reason: string
  /** 相对基线的跌幅（百分比，正数 = 变差）。 */
  readonly dropPercent: number
}

/**
 * 与基线比。
 *
 * 三条纪律：
 *   - **没有基线不算退化**（第一次跑就是在建基线，不该报"掉了 100%"）；
 *   - **样本太少不下结论**（<5 题时噪音比信号大，只记不报）；
 *   - **跌幅按相对值算**：0.85 → 0.76 是跌 10.6%，不是跌 0.09。
 */
export function compareToBaseline(
  current: BenchSample,
  baseline: BenchSample | null,
  regressPercent: number,
): RegressionVerdict {
  if (baseline === null) return { regressed: false, reason: '首次运行（已建立基线）', dropPercent: 0 }
  if (current.recallSample < 5) {
    return { regressed: false, reason: `样本太少（${current.recallSample} 题），不下结论`, dropPercent: 0 }
  }
  if (baseline.recallAtK <= 0) return { regressed: false, reason: '基线为 0，无法比较', dropPercent: 0 }
  const drop = ((baseline.recallAtK - current.recallAtK) / baseline.recallAtK) * 100
  if (drop <= regressPercent) {
    return {
      regressed: false,
      reason: `recall@${current.k} ${current.recallAtK}（基线 ${baseline.recallAtK}，跌幅 ${drop.toFixed(1)}% ≤ ${regressPercent}%）`,
      dropPercent: drop,
    }
  }
  return {
    regressed: true,
    reason: `recall@${current.k} 从 ${baseline.recallAtK} 掉到 ${current.recallAtK}（跌 ${drop.toFixed(1)}% > ${regressPercent}%）`,
    dropPercent: drop,
  }
}

/** 历史文件里只留最近多少条（再老的没有比较价值，只会把文件撑大）。 */
export const HISTORY_KEEP = 400

/** 从历史里挑基线：取**最早**一条样本量足够的（"我们曾经做到过什么"）。 */
export function pickBaseline(points: readonly BenchPoint[]): BenchSample | null {
  for (const point of points) {
    if (point.recallSample >= 5) return point
  }
  return null
}
