/** 夜间记忆评测（M1.1/M1.2/M1.3）：把「变好还是变坏」变成能回答的问题。
 *
 * 为什么是**起子进程**而不是在插件里重算一遍：`eval/memory/run.mjs` 是那份 60 题基准
 * 的唯一实现（语料切分、锚点判定、预算口径都在里面）。在这里重写一份，两份实现迟早
 * 会分叉，而"评测说的"和"线上跑的"分叉之后，分数就没有意义了。`eval/` 随发布一起
 * 打包（`deploy/pack-release.mjs` 的 INCLUDE 里有它），所以子进程跑得起来。
 *
 * 评测测的是**检索侧**（recall@k / 延迟 / 注入预算），不调模型——所以它没有 token
 * 开销，`memory.evalEnabled` 可以默认开着。
 *
 * 三条纪律（与夜间其它 job 同源）：
 *   - **缺东西就具名跳过**（`no-runner` / `no-corpus` / `bench-failed`），绝不假装跑过；
 *   - **评测失败不拦任何东西**：它只写自己的历史文件与告警；
 *   - **首次运行就是建基线**，不报"掉了 100%"。
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import { findPackageRoot } from '../../adapters/persona/fs-pack.js'
import {
  HISTORY_KEEP, compareToBaseline, parseBenchReport,
  type BenchPoint, type BenchSample, type RegressionVerdict,
} from '../../core/memory/eval.js'
import { registerJob, type JobContext, type JobOutcome } from '../proactive/jobs.js'

/** 一次子进程执行的结果（测试可注入）。 */
export interface ExecResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

export interface EvalJobDeps {
  readonly enabled: () => boolean
  readonly regressPercent: () => number
  readonly dshHome: string
  readonly workspace: () => string | null
  readonly log: (line: string) => void
  /** 管理员私聊（退化告警）；发送失败只记日志。 */
  readonly notify: (text: string) => Promise<void> | void
  /** 评测脚本的绝对路径；null = 找不到（发布包没带 eval/ 或路径异常）。 */
  readonly runner: () => string | null
  /** 跑一次子进程（默认 `execFile`；测试注入假件）。 */
  readonly exec?: (args: readonly string[], timeoutMs: number) => Promise<ExecResult>
}

/** 评测目录：`<dshHome>/channel-qq/eval/`。 */
export function evalDirOf(dshHome: string): string {
  return path.join(dshHome, 'channel-qq', 'eval')
}

export function historyFileOf(dshHome: string): string {
  return path.join(evalDirOf(dshHome), 'history.jsonl')
}

export function baselineFileOf(dshHome: string): string {
  return path.join(evalDirOf(dshHome), 'baseline.json')
}

/** 默认执行器：`node <runner> --json --corpus <dir>`。 */
function defaultExec(args: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

/** 解析 `<root>/eval/memory/run.mjs`；找不到返回 null。 */
export function resolveRunner(): string | null {
  // `fileURLToPath` 而不是手撕 `URL.pathname`：Windows 上后者会给出 `/C:/...`。
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url))) ?? findPackageRoot(process.cwd())
  if (root === null) return null
  return path.join(root, 'eval', 'memory', 'run.mjs')
}

/** 读历史（后台资源与基线判定共用）。坏行跳过。 */
export async function readHistory(dshHome: string): Promise<BenchPoint[]> {
  const raw = await readTextFileOrNull(historyFileOf(dshHome))
  if (raw === null) return []
  const out: BenchPoint[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const sample = parseBenchReport(parsed)
      if (sample === null || typeof parsed.at !== 'number') continue
      out.push({ ...sample, at: parsed.at })
    } catch {
      // 坏行跳过：一份能读的历史比一份完整的历史更重要。
    }
  }
  return out
}

/** 读基线（没有就是 null）。 */
export async function readBaseline(dshHome: string): Promise<BenchSample | null> {
  const raw = await readTextFileOrNull(baselineFileOf(dshHome))
  if (raw === null) return null
  try {
    return parseBenchReport(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 把一条样本追加进历史，并裁剪到 `HISTORY_KEEP` 条。 */
async function appendHistory(dshHome: string, point: BenchPoint): Promise<void> {
  await fs.mkdir(evalDirOf(dshHome), { recursive: true })
  const existing = await readHistory(dshHome)
  const kept = [...existing, point].slice(-HISTORY_KEEP)
  // 整份重写而不是 appendFile：裁剪需要重写，而条目量级只有几百条。
  await atomicWriteFile(historyFileOf(dshHome), kept.map((p) => JSON.stringify(p)).join('\n') + '\n')
}

/** 写基线（只在还没有基线时写）。 */
async function ensureBaseline(dshHome: string, sample: BenchSample): Promise<boolean> {
  if (await readBaseline(dshHome) !== null) return false
  await fs.mkdir(evalDirOf(dshHome), { recursive: true })
  await atomicWriteFile(baselineFileOf(dshHome), JSON.stringify(sample, null, 2) + '\n')
  return true
}

/** 告警文案（给人看的一句话 + 建议动作）。 */
export function renderAlert(verdict: RegressionVerdict, sample: BenchSample): string {
  return [
    '【记忆评测退化】',
    verdict.reason,
    `样本 ${sample.recallSample} 题 · 记录 ${sample.activeRecords} 条 · p95 ${Math.round(sample.latencyP95Ms)}ms`,
    '建议：先看最近改过的记忆参数（threshold / maxRecords / 向量开关），再决定是否回滚。',
  ].join('\n')
}

/** 注册 `memory.eval`。 */
export function registerEvalJob(deps: EvalJobDeps): () => void {
  return registerJob('memory.eval', async (ctx: JobContext): Promise<JobOutcome> => {
    if (!deps.enabled()) return { skipped: 'eval-off' }
    const runner = deps.runner()
    if (runner === null) return { skipped: 'no-runner' }
    const workspace = deps.workspace()
    if (workspace === null || workspace === '') return { skipped: 'no-workspace' }
    const corpus = path.join(workspace, 'memory')
    if (!await existsDir(corpus)) return { skipped: 'no-corpus' }

    const exec = deps.exec ?? defaultExec
    const result = await exec([runner, '--json', '--corpus', corpus], 180_000)
    const sample = parseBenchReport(parseJson(result.stdout))
    if (sample === null) {
      // 子进程失败时**不静默**：把 stderr 头一行留在日志里，否则"评测挂了"只能靠猜。
      const why = result.ok ? '输出不是 JSON' : (result.stderr.split('\n')[0] ?? '未知错误').slice(0, 200)
      deps.log(`memory.eval: 评测没有产出可解析的结果（${why}）`)
      return { skipped: 'bench-failed' }
    }

    await appendHistory(deps.dshHome, { ...sample, at: ctx.now.getTime() })
    const baseline = await readBaseline(deps.dshHome)
    const fresh = await ensureBaseline(deps.dshHome, sample)
    const verdict = compareToBaseline(sample, baseline, deps.regressPercent())
    if (verdict.regressed) {
      try {
        await deps.notify(renderAlert(verdict, sample))
      } catch (error) {
        deps.log(`memory.eval: 告警发送失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      note: `评测：recall@${sample.k} ${sample.recallAtK}（样本 ${sample.recallSample}）`
        + `${fresh ? ' · 已建立基线' : ''}${verdict.regressed ? ' · **退化已告警**' : ''}`,
    }
  })
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function existsDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir)
    return stat.isDirectory()
  } catch {
    return false
  }
}
