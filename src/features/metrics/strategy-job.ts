/** 策略度量（M3.2）：口癖命中率、主动开口被回复率、情绪与回复长度的相关性。
 *
 * 三个数字全部从**已经落盘的数据**里算（口癖库、按房间的 sent-log、chatlog、情绪历史），
 * 不给热路径加埋点。代价是口径是近似的（见 `core/metrics/strategy.ts` 的 `pairProactive`），
 * 收益是这套度量坏了也不会影响任何一次对话。
 *
 * 产物：`<dshHome>/channel-qq/metrics/strategy.json` + 后台资源 `strategy`。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import {
  pairProactive, pearson, phraseCoverage, phraseHits, proactiveReplyRate,
  type PhraseStat, type Timed,
} from '../../core/metrics/strategy.js'
import { registerJob, type JobContext, type JobOutcome } from '../proactive/jobs.js'

/** 发之前多久内没有入站，算「她主动开口」。 */
export const PROACTIVE_IDLE_MS = 5 * 60_000
/** 发之后多久内有入站，算「被回复」。 */
export const PROACTIVE_REPLY_MS = 30 * 60_000
/** 参与相关性计算的最近样本数。 */
export const STRATEGY_WINDOW = 300

export interface StrategyReport {
  readonly at: number
  readonly phrases: { readonly total: number; readonly covered: number; readonly rate: number; readonly top: readonly PhraseStat[] }
  readonly proactive: { readonly total: number; readonly replied: number; readonly rate: number }
  readonly emotionLength: { readonly samples: number; readonly r: number | null }
}

export interface StrategyJobDeps {
  readonly dshHome: string
  readonly workspace: () => string | null
  readonly log: (line: string) => void
}

export function strategyFileOf(dshHome: string): string {
  return path.join(dshHome, 'channel-qq', 'metrics', 'strategy.json')
}

/** 读后台资源（没有就是 null）。 */
export async function readStrategyReport(dshHome: string): Promise<StrategyReport | null> {
  const raw = await readTextFileOrNull(strategyFileOf(dshHome))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as StrategyReport
  } catch {
    return null
  }
}

/** 读学到的口癖（只要文本）。 */
async function readPhrases(dshHome: string, workspace: string | null): Promise<string[]> {
  const base = workspace ?? dshHome
  const raw = await readTextFileOrNull(path.join(base, 'channel-qq', 'learned-phrases.json'))
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => (item !== null && typeof item === 'object' ? (item as { text?: unknown }).text : undefined))
      .filter((text): text is string => typeof text === 'string' && text.trim() !== '')
  } catch {
    return []
  }
}

/** 读全部房间的发送记录：`<dshHome>/channel-qq/sent-<room>.json`。 */
async function readSent(dshHome: string): Promise<Array<{ room: string; text: string; time: number }>> {
  const dir = path.join(dshHome, 'channel-qq')
  let names: string[] = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: Array<{ room: string; text: string; time: number }> = []
  for (const name of names) {
    if (!name.startsWith('sent-') || !name.endsWith('.json')) continue
    const room = name.slice('sent-'.length, -'.json'.length)
    const raw = await readTextFileOrNull(path.join(dir, name))
    if (raw === null) continue
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) continue
      for (const entry of parsed) {
        if (entry === null || typeof entry !== 'object') continue
        const e = entry as { text?: unknown; time?: unknown }
        if (typeof e.text !== 'string' || typeof e.time !== 'number') continue
        out.push({ room, text: e.text, time: e.time })
      }
    } catch {
      // 坏文件跳过。
    }
  }
  return out.sort((a, b) => a.time - b.time)
}

/** 读情绪历史（每回合一行 `{t, energy, mood}`）。 */
async function readEmotionHistory(dshHome: string): Promise<Array<{ t: number; energy: number }>> {
  const raw = await readTextFileOrNull(path.join(dshHome, 'channel-qq', 'emotion-history.jsonl'))
  if (raw === null) return []
  const out: Array<{ t: number; energy: number }> = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const parsed = JSON.parse(text) as { t?: unknown; energy?: unknown }
      if (typeof parsed.t === 'number' && typeof parsed.energy === 'number') {
        out.push({ t: parsed.t, energy: parsed.energy })
      }
    } catch {
      // 坏行跳过。
    }
  }
  return out
}

/**
 * 读入站时间（chatlog 的 `<dir>/{group|dm}/<room>/<day>.md`）。
 *
 * 只取「文件最后修改时间」当粗粒度入站时间：chatlog 是给人读的 Markdown，逐行解析
 * 时间戳要依赖它的渲染格式，一旦格式改动度量就会静默归零。mtime 的精度够回答
 * 「发完之后半小时内有没有人说话」这个问题。
 */
async function readInboundTimes(dshHome: string, workspace: string | null): Promise<Timed[]> {
  const dir = path.join(workspace ?? dshHome, 'chatlog')
  const out: Timed[] = []
  for (const kind of ['group', 'dm']) {
    let rooms: string[] = []
    try {
      rooms = await fs.readdir(path.join(dir, kind))
    } catch {
      continue
    }
    for (const room of rooms) {
      const roomDir = path.join(dir, kind, room)
      let days: string[] = []
      try {
        days = await fs.readdir(roomDir)
      } catch {
        continue
      }
      for (const day of days) {
        if (!day.endsWith('.md')) continue
        try {
          const stat = await fs.stat(path.join(roomDir, day))
          out.push({ at: stat.mtimeMs, room: `${kind}-${room}` })
        } catch {
          // 读不到就跳过。
        }
      }
    }
  }
  return out
}

/** 把「回合的情绪能量」与「紧接着发出的回复长度」配对。 */
function pairEmotionLength(
  history: readonly { t: number; energy: number }[],
  sent: readonly { time: number; text: string }[],
): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const point of history) {
    // 一条回复算作「这次回合之后 60 秒内发出去的」。
    const hit = sent.find((entry) => entry.time >= point.t && entry.time - point.t <= 60_000)
    if (hit === undefined) continue
    xs.push(point.energy)
    ys.push([...hit.text].length)
  }
  return { xs: xs.slice(-STRATEGY_WINDOW), ys: ys.slice(-STRATEGY_WINDOW) }
}

/** 算一份报告（纯读盘 + 纯统计）。 */
export async function buildStrategyReport(deps: StrategyJobDeps, now: number): Promise<StrategyReport> {
  const workspace = deps.workspace()
  const phrases = await readPhrases(deps.dshHome, workspace)
  const sent = await readSent(deps.dshHome)
  const stats = phraseHits(phrases, sent.map((entry) => entry.text))
  const coverage = phraseCoverage(stats)

  const inbounds = await readInboundTimes(deps.dshHome, workspace)
  const gaps = pairProactive(
    sent.map((entry) => ({ at: entry.time, room: entry.room })),
    inbounds,
    { idleMs: PROACTIVE_IDLE_MS, replyWindowMs: PROACTIVE_REPLY_MS },
  )
  const reply = proactiveReplyRate(gaps)

  const emotion = await readEmotionHistory(deps.dshHome)
  const { xs, ys } = pairEmotionLength(emotion, sent)

  return {
    at: now,
    phrases: { total: coverage.total, covered: coverage.covered, rate: coverage.rate, top: stats.slice(0, 10) },
    proactive: reply,
    emotionLength: { samples: xs.length, r: pearson(xs, ys) },
  }
}

/** 注册 `metrics.strategy`。 */
export function registerStrategyJob(deps: StrategyJobDeps): () => void {
  return registerJob('metrics.strategy', async (ctx: JobContext): Promise<JobOutcome> => {
    const report = await buildStrategyReport(deps, ctx.now.getTime())
    const file = strategyFileOf(deps.dshHome)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await atomicWriteFile(file, JSON.stringify(report, null, 2) + '\n')
    return {
      note: `策略度量：口癖 ${report.phrases.covered}/${report.phrases.total}`
        + ` · 主动被回复 ${report.proactive.replied}/${report.proactive.total}`
        + ` · 情绪-长度 r=${report.emotionLength.r === null ? '样本不足' : report.emotionLength.r.toFixed(2)}`,
    }
  })
}
