/** 学习闭环的纯判定：挑技能候选、挑闲置记忆、把失败写成教训。
 *
 * 三个函数都不碰 IO、不读时钟（`now` 由调用方传）：这样"为什么这条被晋升/归档了"
 * 可以在测试里逐条复现，而不是只能上服务器看日志。
 *
 * 一条贯穿始终的分界：**事实（fact/preference/event/person）与方法（procedure/skill）
 * 是两种东西**。事实再重要也不该变成技能——技能是"怎么做"，事实是"是什么"。
 */

import { isChunkRecord, isPinned, type MemoryKind, type MemoryRecord } from './model.js'

/** 能变成「做法」的记忆种类。 */
export const METHOD_KINDS: readonly MemoryKind[] = ['procedure', 'skill']

/** 一条待晋升的候选。 */
export interface SkillCandidate {
  readonly record: MemoryRecord
  readonly hits: number
}

/**
 * 挑出该晋升成技能的方法类记忆。
 *
 * 判据只有三条：**是方法**（`METHOD_KINDS`）、**被反复用上**（`hits ≥ minHits`）、
 * **还在生效**（`status === 'active'`）。
 *
 * 刻意**不**按 importance 排序：importance 是建档时模型打的印象分，而 `hits` 是
 * 真实被召回的次数——"用得上"比"觉得重要"更能说明它值得变成一套做法。
 */
export function pickSkillCandidates(
  records: readonly MemoryRecord[],
  opts: { readonly minHits: number; readonly limit: number },
): SkillCandidate[] {
  const minHits = Math.max(1, Math.floor(opts.minHits))
  const limit = Math.max(0, Math.floor(opts.limit))
  if (limit === 0) return []
  return records
    .filter((record) => record.status === 'active'
      && !isChunkRecord(record)
      && METHOD_KINDS.includes(record.kind)
      && record.hits >= minHits
      && record.content.trim() !== '')
    .map((record) => ({ record, hits: record.hits }))
    .sort((a, b) => b.hits - a.hits || a.record.id.localeCompare(b.record.id))
    .slice(0, limit)
}

/** 闲置归档的判据。 */
export interface IdleOptions {
  /** 多久没被召回算闲置；`0` = 关闭（一条都不归档）。 */
  readonly idleDays: number
  /** 重要度达到这个值的记忆不因闲置而归档。 */
  readonly minImportance: number
}

const DAY_MS = 86_400_000

/**
 * 挑出「从没被用上」的记忆。
 *
 * 与遗忘曲线（`shouldArchive`，按 R < 0.05 判）是**两条独立的理由**，不是替代：
 *   - 遗忘曲线问的是"还记得住吗"（strength 随时间衰减）；
 *   - 闲置问的是"还用得上吗"（根本没被召回）。
 * 一条被钉住的（`isPinned`）永远不因闲置归档——那是主人明说要一直记得的事。
 */
export function splitForIdle(
  records: readonly MemoryRecord[],
  now: number,
  opts: IdleOptions,
): { readonly archive: readonly MemoryRecord[]; readonly keep: readonly MemoryRecord[] } {
  const archive: MemoryRecord[] = []
  const keep: MemoryRecord[] = []
  const windowMs = Math.max(0, opts.idleDays) * DAY_MS
  for (const record of records) {
    if (windowMs === 0 || record.status !== 'active' || isPinned(record) || record.importance >= opts.minImportance) {
      keep.push(record)
      continue
    }
    // 「最后一次被看见」= 最后一次被召回；从没被召回就从建档算起。
    const lastSeen = record.lastHitAt ?? record.recordedAt
    if (now - lastSeen >= windowMs) archive.push(record)
    else keep.push(record)
  }
  return { archive, keep }
}

/** 一类反复出现的失败。 */
export interface FailureSignature {
  /** 稳定的键（工具名 / 错误类），用来去重。 */
  readonly key: string
  /** 给人看的名字（会进教训正文）。 */
  readonly label: string
  readonly count: number
  /** 统计窗口（天），写进正文让读者知道样本跨度。 */
  readonly windowDays: number
}

/**
 * 把失败签名写成一条「教训」。
 *
 * 措辞刻意是**可执行的下一步**（"先确认参数与目标"），不是"要注意"——后者对模型
 * 等于没说。内容控制在 `MAX_CONTENT_CHARS` 以内：它会进检索与注入预算。
 */
export function buildLesson(sig: FailureSignature): {
  readonly content: string
  readonly keywords: readonly string[]
  readonly context: string
} {
  const window = sig.windowDays <= 0 ? '最近' : `近 ${Math.round(sig.windowDays)} 天`
  const content = `「${sig.label}」${window}失败了 ${sig.count} 次：重试之前先确认参数与目标，别连着撞同一个坑`
  return {
    content,
    // 关键词只放稳定的锚点（工具名/错误类 + 高频词），别把整句切碎。
    keywords: [sig.key, '失败', '教训'].filter((word) => word !== ''),
    context: `${window} ${sig.count} 次失败（来源：指标采集，键 ${sig.key}）`,
  }
}

/** 教训记录的稳定键：同一类失败永远映射到同一个键（用于去重）。 */
export function lessonKeyOf(sig: FailureSignature): string {
  return `lesson:${sig.key}`
}
