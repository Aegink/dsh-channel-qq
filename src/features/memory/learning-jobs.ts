/** 学习闭环的三个夜间 job：晋升技能草稿、把失败写成教训、把缺口写成清单。
 *
 * 三个都遵守同一条纪律：**产出候选，不产出结论**。
 *   - 晋升写的是**技能草稿**（进待审区，人确认才启用）；
 *   - 失败写的是**记忆记录**（可被检索、可被 supersede）；
 *   - 缺口写的是**一份 Markdown 清单**（给人看的待办，不自动联网）。
 *
 * 一个都不改行为：没有一条会改配置、改人格文件或调用模型。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import type { MemoryRecord } from '../../core/memory/model.js'
import { buildLesson, pickSkillCandidates, splitForIdle, type FailureSignature } from '../../core/memory/learning.js'
import type { SkillDrafts } from '../../ports/skills.js'
import { registerJob, type JobContext, type JobOutcome } from '../proactive/jobs.js'
import type { MemoryStore } from './store.js'

/** 一次晋升最多产出几条草稿（宁可少而准）。 */
export const PROMOTE_LIMIT = 3
/** 同一类失败达到这个次数才值得写成教训。 */
export const LESSON_MIN_COUNT = 3
/** 教训的统计窗口（天）。 */
export const LESSON_WINDOW_DAYS = 7

export interface LearningJobsDeps {
  readonly store: () => MemoryStore | null
  readonly drafts: () => SkillDrafts | undefined
  readonly workspace: () => string | null
  readonly log: (line: string) => void
  readonly config: () => {
    readonly promoteEnabled: boolean
    readonly promoteMinHits: number
    readonly lessonsEnabled: boolean
    readonly archiveIdleDays: number
    readonly archiveMinImportance: number
  }
  /** 指标文件（`<dshHome>/channel-qq/metrics.json`）；读不到就跳过教训。 */
  readonly metricsFile: () => string | null
  /** 时间源（测试注入）。 */
  readonly now?: () => number
  readonly random?: () => number
}

/** 从指标样本里挑出「反复失败」的签名（按房间聚合）。 */
export function failureSignatures(
  samples: readonly { at: number; room: string; ok: boolean }[],
  now: number,
  windowDays: number,
): FailureSignature[] {
  const since = now - Math.max(1, windowDays) * 86_400_000
  const counts = new Map<string, number>()
  for (const sample of samples) {
    if (sample.ok || sample.at < since) continue
    counts.set(sample.room, (counts.get(sample.room) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= LESSON_MIN_COUNT)
    .map(([room, count]) => ({ key: room, label: room, count, windowDays }))
    .sort((a, b) => b.count - a.count)
}

/** 读指标文件（坏文件当没有）。 */
async function readSamples(file: string): Promise<Array<{ at: number; room: string; ok: boolean }>> {
  const raw = await readTextFileOrNull(file)
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is { at: number; room: string; ok: boolean } =>
      item !== null && typeof item === 'object'
      && typeof item.at === 'number' && typeof item.room === 'string' && typeof item.ok === 'boolean')
  } catch {
    return []
  }
}

/** 注册 `memory.promote` / `memory.lessons` / `memory.gaps`。 */
export function registerLearningJobs(deps: LearningJobsDeps): () => void {
  const offs = [
    registerJob('memory.promote', (ctx) => promoteJob(deps, ctx)),
    registerJob('memory.lessons', (ctx) => lessonsJob(deps, ctx)),
    registerJob('memory.idle', (ctx) => idleJob(deps, ctx)),
    registerJob('memory.gaps', (ctx) => gapsJob(deps, ctx)),
  ]
  return () => { for (const off of offs) off() }
}

/** 时间源：测试注入优先，否则用执行器给的"现在"。 */
function nowOf(deps: LearningJobsDeps, ctx: JobContext): number {
  return deps.now?.() ?? ctx.now.getTime()
}

/** M2.1：把够格的方法类记忆写成技能草稿（进待审区，人确认才启用）。 */
async function promoteJob(deps: LearningJobsDeps, _ctx: JobContext): Promise<JobOutcome> {
  if (!deps.config().promoteEnabled) return { skipped: 'promote-off' }
  const store = deps.store()
  if (store === null) return { skipped: 'memory-v2-off' }
  const drafts = deps.drafts()
  if (drafts === undefined) return { skipped: 'no-skills' }
  const picks = pickSkillCandidates(store.all(), {
    minHits: deps.config().promoteMinHits,
    limit: PROMOTE_LIMIT,
  })
  if (picks.length === 0) return { note: '晋升：没有够格的方法类记忆' }
  let created = 0
  const failures: string[] = []
  for (const pick of picks) {
    try {
      await drafts.create({
        name: `memory-${pick.record.id}`,
        description: pick.record.content.slice(0, 120),
        whenToUse: pick.record.context.slice(0, 200),
        body: [`# ${pick.record.content.slice(0, 60)}`, '', pick.record.content, '', pick.record.context].join('\n'),
        source: `memory:${pick.record.id}`,
      })
      created += 1
    } catch (error) {
      failures.push(`${pick.record.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) deps.log(`memory.promote: ${failures.length} 条草稿没写成功：${failures[0]}`)
  return { note: `晋升：${created} 条草稿进待审区（候选 ${picks.length} 条）` }
}

/** M3.1：把反复出现的失败写成一条教训（带出处，夜间去重）。 */
async function lessonsJob(deps: LearningJobsDeps, ctx: JobContext): Promise<JobOutcome> {
  if (!deps.config().lessonsEnabled) return { skipped: 'lessons-off' }
  const store = deps.store()
  if (store === null) return { skipped: 'memory-v2-off' }
  const file = deps.metricsFile()
  if (file === null) return { skipped: 'no-metrics' }
  const now = nowOf(deps, ctx)
  const signatures = failureSignatures(await readSamples(file), now, LESSON_WINDOW_DAYS)
  if (signatures.length === 0) return { note: '教训：没有够格的失败模式' }
  const existing = new Set(store.all().filter((r) => r.status === 'active').map((r) => r.content))
  let created = 0
  for (const sig of signatures) {
    const lesson = buildLesson(sig)
    // 同一条教训只留一条：内容完全相等就算重复（与 memorize 的去重口径一致）。
    if (existing.has(lesson.content)) continue
    await store.remember({
      kind: 'procedure',
      subject: { type: 'self' },
      content: lesson.content,
      source: { kind: 'extract', file: `metrics:${sig.key}` },
      tags: ['lesson'],
      keywords: [...lesson.keywords],
      context: lesson.context,
      importance: 6,
      confidence: 0.6,
    }, now, deps.random ?? (() => 0.5))
    created += 1
  }
  return { note: `教训：新增 ${created} 条（失败模式 ${signatures.length} 类）` }
}

/** M2.2：久未召回且不重要的记忆转 `archived`（不删）。 */
async function idleJob(deps: LearningJobsDeps, ctx: JobContext): Promise<JobOutcome> {
  const store = deps.store()
  if (store === null) return { skipped: 'memory-v2-off' }
  const now = nowOf(deps, ctx)
  const { archive } = splitForIdle(store.all(), now, {
    idleDays: deps.config().archiveIdleDays,
    minImportance: deps.config().archiveMinImportance,
  })
  if (archive.length === 0) return { note: '闲置归档：没有该归档的' }
  // 只转状态、不删记录：`records.jsonl` 是追加式的，旧版本永远留在文件里可回查。
  await store.put(...archive.map((record) => ({ ...record, status: 'archived' as const, validTo: now })))
  return { note: `闲置归档：${archive.length} 条（不删，可回查）` }
}

/** M3.3：把"她其实不知道"的三类东西写成一份给人看的待办清单（不自动联网）。 */
async function gapsJob(deps: LearningJobsDeps, ctx: JobContext): Promise<JobOutcome> {
  const workspace = deps.workspace()
  if (workspace === null || workspace === '') return { skipped: 'no-workspace' }
  const store = deps.store()
  if (store === null) return { skipped: 'memory-v2-off' }
  const text = await renderGaps(store, nowOf(deps, ctx))
  const dir = path.join(workspace, 'memory')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'GAPS.md')
  await atomicWriteFile(file, text)
  return { note: `缺口清单：${file}` }
}

/** 缺口清单：三类"她其实不知道"的东西，写成给人看的待办。 */
export async function renderGaps(store: MemoryStore, now: number): Promise<string> {
  const all = store.all()
  const candidates = all
    .filter((r) => r.status === 'candidate')
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, 20)
  const lessons = all
    .filter((r) => r.status === 'active' && r.tags.includes('lesson') && r.hits === 0)
    .slice(0, 20)
  const conflicts = await readConflictTail(store.dir, 20)
  const stamp = new Date(now).toISOString().slice(0, 10)
  const lines = [
    `# 缺口清单（${stamp}）`,
    '',
    '> 这份清单由夜间 job 自动生成：**只列出来，不自动联网、不改任何东西**。',
    '> 想让她补哪一块，自己去找资料丢进知识库，或者直接问她。',
    '',
    `## 1. 还没确认的候选记忆（${candidates.length} 条，置信从低到高）`,
    '',
    ...(candidates.length === 0 ? ['（没有）'] : candidates.map((r) => `- [${r.kind}] ${r.content}（置信 ${r.confidence.toFixed(2)}）`)),
    '',
    `## 2. 还没被用上的教训（${lessons.length} 条）`,
    '',
    ...(lessons.length === 0 ? ['（没有）'] : lessons.map((r) => `- ${r.content}`)),
    '',
    `## 3. 还没裁决的矛盾（${conflicts.length} 条）`,
    '',
    ...(conflicts.length === 0 ? ['（没有）'] : conflicts.map((line) => `- ${line}`)),
    '',
  ]
  return lines.join('\n')
}

/** 读矛盾队列的尾部（一行一条，坏行跳过）。 */
async function readConflictTail(dir: string, limit: number): Promise<string[]> {
  const raw = await readTextFileOrNull(path.join(dir, 'conflicts.jsonl'))
  if (raw === null) return []
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const out: string[] = []
  for (const line of lines.slice(-limit)) {
    try {
      const parsed = JSON.parse(line) as { left?: MemoryRecord; right?: MemoryRecord }
      const left = parsed.left?.content ?? '?'
      const right = parsed.right?.content ?? '?'
      out.push(`「${left}」 vs 「${right}」`)
    } catch {
      // 坏行跳过。
    }
  }
  return out
}
