/** 学习闭环（M1–M3）的纯逻辑与服务层：评测判定、挑候选、闲置归档、教训、策略统计、
 * 以及模型侧的「忘掉/纠正」。
 *
 * 这一批全部是**可复现的判定**：给定同样的记录与"现在"，结论必须一模一样。所以
 * 每个断言都写明"为什么是这个数"，而不是只写结果。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const {
  compareToBaseline, parseBenchReport, pickBaseline,
} = await import('../src/core/memory/eval.js')
const {
  buildLesson, pickSkillCandidates, splitForIdle, METHOD_KINDS,
} = await import('../src/core/memory/learning.js')
const {
  pairProactive, pearson, phraseCoverage, phraseHits, proactiveReplyRate,
} = await import('../src/core/metrics/strategy.js')
const { failureSignatures } = await import('../src/features/memory/learning-jobs.js')
const { makeRecord } = await import('../src/core/memory/model.js')
const { MemoryStore } = await import('../src/features/memory/store.js')
const { createMemoryService } = await import('../src/features/memory/service.js')

const HOME = mkdtempSync(path.join(tmpdir(), 'learning-test-'))
process.on('exit', () => { rmSync(HOME, { recursive: true, force: true }) })

const NOW = Date.parse('2026-10-30T12:00:00+08:00')
const DAY = 86_400_000

/** 造一条记录（字段用 makeRecord 的默认值，只覆盖关心的部分）。 */
function rec(over: Partial<Parameters<typeof makeRecord>[0]> & {
  hits?: number
  lastHitAt?: number
  recordedAt?: number
} = {}) {
  const { hits, lastHitAt, recordedAt, ...input } = over
  const base = makeRecord({
    kind: 'fact',
    subject: { type: 'world' },
    content: '默认内容',
    source: { kind: 'manual' },
    ...input,
  }, NOW, () => 0.5)
  return {
    ...base,
    ...(hits === undefined ? {} : { hits }),
    ...(lastHitAt === undefined ? {} : { lastHitAt }),
    ...(recordedAt === undefined ? {} : { recordedAt }),
  }
}

test('评测：解析 --json 输出，形状不对返回 null', () => {
  const ok = parseBenchReport({
    recallAtK: 0.85, recallSample: 60, latency: { p95: 12 }, injectChars: { max: 520 }, activeRecords: 900, k: 8,
  })
  assert.deepEqual(ok, { recallAtK: 0.85, recallSample: 60, latencyP95Ms: 12, injectCharsMax: 520, activeRecords: 900, k: 8 })
  assert.equal(parseBenchReport({ recallAtK: 'x' }), null)
  assert.equal(parseBenchReport(null), null)
})

test('评测：跌幅按相对值算，首次运行与样本太少都不报退化', () => {
  const base = { recallAtK: 0.85, recallSample: 60, latencyP95Ms: 10, injectCharsMax: 500, activeRecords: 900, k: 8 }
  // 0.85 → 0.76 是跌 10.6%，超过 10% 的阈值
  assert.equal(compareToBaseline({ ...base, recallAtK: 0.76 }, base, 10).regressed, true)
  // 0.85 → 0.80 是跌 5.9%，不报
  assert.equal(compareToBaseline({ ...base, recallAtK: 0.8 }, base, 10).regressed, false)
  // 没有基线 = 首次运行
  assert.equal(compareToBaseline(base, null, 10).regressed, false)
  // 3 题样本不下结论
  assert.equal(compareToBaseline({ ...base, recallAtK: 0.1, recallSample: 3 }, base, 10).regressed, false)
})

test('评测：基线取最早一条样本足够的', () => {
  const thin = { at: 1, recallAtK: 0.2, recallSample: 2, latencyP95Ms: 0, injectCharsMax: 0, activeRecords: 0, k: 8 }
  const thick = { ...thin, at: 2, recallAtK: 0.9, recallSample: 60 }
  assert.equal(pickBaseline([thin, thick])?.recallAtK, 0.9)
  assert.equal(pickBaseline([thin]), null)
})

// ── M2.1 挑技能候选 ────────────────────────────────────────────────────────

test('晋升：只挑方法类、够次数、还生效的；按命中次数排', () => {
  const records = [
    rec({ kind: 'procedure', content: '部署要先跑 verify', hits: 5 }),
    rec({ kind: 'skill', content: '画表情包用 meme', hits: 3 }),
    rec({ kind: 'fact', content: '学弟喜欢冰美式', hits: 99 }),      // 事实不晋升
    rec({ kind: 'procedure', content: '只提过一次的做法', hits: 1 }), // 次数不够
    rec({ kind: 'procedure', content: '已归档的做法', hits: 9, status: 'archived' }),
  ]
  const picks = pickSkillCandidates(records, { minHits: 3, limit: 3 })
  assert.deepEqual(picks.map((p) => p.record.content), ['部署要先跑 verify', '画表情包用 meme'])
  assert.deepEqual([...METHOD_KINDS], ['procedure', 'skill'])
})

test('晋升：limit=0 时一条都不给（关掉就是关掉）', () => {
  const records = [rec({ kind: 'procedure', content: 'x', hits: 9 })]
  assert.deepEqual(pickSkillCandidates(records, { minHits: 1, limit: 0 }), [])
})

// ── M2.2 闲置归档 ──────────────────────────────────────────────────────────

test('闲置：久未召回且不重要 → 归档；重要/钉住/刚用过都不动', () => {
  const records = [
    rec({ content: '闲置的事实', importance: 4, recordedAt: NOW - 120 * DAY } as never),
    rec({ content: '重要的事', importance: 9, recordedAt: NOW - 120 * DAY } as never),
    rec({ content: '刚被用过', importance: 4, lastHitAt: NOW - 2 * DAY }),
    rec({ content: '钉住的', importance: 4, tags: ['pin'], recordedAt: NOW - 120 * DAY } as never),
  ]
  const { archive, keep } = splitForIdle(records, NOW, { idleDays: 90, minImportance: 6 })
  assert.deepEqual(archive.map((r) => r.content), ['闲置的事实'])
  assert.equal(keep.length, 3)
})

test('闲置：idleDays=0 等于关闭', () => {
  const records = [rec({ content: 'x', importance: 1, recordedAt: NOW - 999 * DAY } as never)]
  assert.equal(splitForIdle(records, NOW, { idleDays: 0, minImportance: 10 }).archive.length, 0)
})

// ── M3.1 失败教训 ──────────────────────────────────────────────────────────

test('教训：同一房间 7 天内失败 ≥3 次才够格', () => {
  const samples = [
    { at: NOW - 1 * DAY, room: 'dm-1', ok: false },
    { at: NOW - 2 * DAY, room: 'dm-1', ok: false },
    { at: NOW - 3 * DAY, room: 'dm-1', ok: false },
    { at: NOW - 1 * DAY, room: 'group-2', ok: false },
    { at: NOW - 1 * DAY, room: 'dm-1', ok: true },
    { at: NOW - 30 * DAY, room: 'dm-9', ok: false },
  ]
  const sigs = failureSignatures(samples, NOW, 7)
  assert.deepEqual(sigs.map((s) => [s.key, s.count]), [['dm-1', 3]])
})

test('教训：正文是可执行的下一步，且带统计窗口', () => {
  const lesson = buildLesson({ key: 'dm-1', label: 'dm-1', count: 5, windowDays: 7 })
  assert.match(lesson.content, /近 7 天失败了 5 次/)
  assert.match(lesson.content, /重试之前先确认参数与目标/)
  assert.ok(lesson.keywords.includes('dm-1'))
})

// ── M3.2 策略度量 ──────────────────────────────────────────────────────────

test('口癖：一条发言里重复出现只算一次，命中率按条数算', () => {
  const stats = phraseHits(['真的会谢', '笑死', '摸鱼'], ['真的会谢真的会谢', '今天摸鱼', '早'])
  assert.deepEqual(stats.map((s) => [s.phrase, s.occurrences]), [['摸鱼', 1], ['真的会谢', 1], ['笑死', 0]])
  assert.deepEqual(phraseCoverage(stats), { covered: 2, total: 3, rate: 2 / 3 })
})

test('主动开口：之前 5 分钟没人说话才算主动，之后 30 分钟有人接才算被回复', () => {
  const MIN = 60_000
  const inbounds = [
    { at: NOW, room: 'dm-1' },              // 她 1 分钟后回话 → 不算主动
    { at: NOW + 20 * MIN, room: 'dm-1' },   // 接住了 19 分钟前那次主动
  ]
  const sends = [
    { at: NOW + 1 * MIN, room: 'dm-1' },    // 回话
    { at: NOW + 20 * MIN - 1, room: 'dm-1' }, // 主动且被接住
    { at: NOW + 200 * MIN, room: 'group-2' }, // 主动但没人理
  ]
  const gaps = pairProactive(sends, inbounds, { idleMs: 5 * MIN, replyWindowMs: 30 * MIN })
  assert.equal(gaps.length, 2)
  assert.equal(proactiveReplyRate(gaps).rate, 0.5)
})

test('相关性：样本不足 8 或方差为 0 时不给数字', () => {
  assert.equal(pearson([1, 2, 3], [1, 2, 3]), null)
  const xs = [10, 20, 30, 40, 50, 60, 70, 80]
  assert.equal(pearson(xs, xs.map(() => 5)), null)
  assert.ok((pearson(xs, xs) ?? 0) > 0.99)
})

// ── M2.3 忘掉 / 纠正（服务层，落真实文件） ─────────────────────────────────

test('忘掉：转 archived，记录仍在库里（不是删除）', async () => {
  const store = new MemoryStore({ workspacePath: HOME, dshHome: HOME, log: () => {} })
  await store.load()
  const svc = createMemoryService({
    store, log: () => {}, renderTime: (at: number) => new Date(at).toISOString(),
    clock: { now: () => NOW }, legacy: null,
  })
  const created = await svc.memorize({ content: '学弟喜欢冰美式' })
  const result = await svc.forget({ id: created.id })
  assert.equal(result.ok, true)
  assert.equal(result.archived, 1)
  assert.equal(store.get(created.id)?.status, 'archived')
  assert.equal(store.get(created.id)?.content, '学弟喜欢冰美式')
})

test('纠正：新记录 supersede 旧的（旧的转 superseded，内容仍可查）', async () => {
  const store = new MemoryStore({ workspacePath: HOME, dshHome: HOME, log: () => {} })
  await store.load()
  const svc = createMemoryService({
    store, log: () => {}, renderTime: (at: number) => new Date(at).toISOString(),
    clock: { now: () => NOW }, legacy: null,
  })
  const created = await svc.memorize({ content: '学弟不喝咖啡' })
  const fixed = await svc.correct({ id: created.id, content: '学弟只喝冰美式' })
  assert.equal(fixed.ok, true)
  assert.equal(store.get(created.id)?.status, 'superseded')
  assert.equal(store.get(created.id)?.content, '学弟不喝咖啡')
  assert.equal(store.get(fixed.id)?.content, '学弟只喝冰美式')
})

test('忘掉/纠正：找不到目标时给可读的拒绝，不抛错', async () => {
  const store = new MemoryStore({ workspacePath: HOME, dshHome: HOME, log: () => {} })
  await store.load()
  const svc = createMemoryService({
    store, log: () => {}, renderTime: (at: number) => new Date(at).toISOString(),
    clock: { now: () => NOW }, legacy: null,
  })
  const missed = await svc.forget({ query: '完全不存在的东西' })
  assert.equal(missed.ok, false)
  assert.match(missed.note, /没找到/)
  const empty = await svc.correct({ id: 'nope', content: '   ' })
  assert.equal(empty.ok, false)
})
