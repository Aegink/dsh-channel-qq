/**
 * 会话 token 构成报告（逐帧解码 + 按回合汇总）。
 *
 * 为什么单独一个脚本、而不是复用 `analyze-turns.mjs`：
 *   1. 会话文件是**多帧 zstd**（一个 append 一帧），而 `zstdDecompressSync` 只解第一帧
 *      —— 直接用 Node 原生解码得到的是"只有会话头的一行"。这里先扫魔数逐帧解开。
 *      （实测：DM 会话 1709 帧 / 整体解码 1 行 / 逐帧解码 3210 行。）
 *   2. `analyze-turns.mjs` 是按回合看耗时与步数；这个脚本要看的是**构成**：
 *      固定前缀（系统提示 + 工具定义）、缓存命中的前缀、注入包、历史、工具结果
 *      各占多少。它回答的是"回复为什么慢",不是"这一轮发生了什么"。
 *
 * 关键指标是 `cacheReadTokens`：它是服务端**缓存命中的前缀长度**，也就是
 * "每一轮都必须重发的固定部分"的实测值——不需要任何换算系数。
 *
 * 用法（在服务器上，直接吃会话文件）：
 *   /opt/node22/bin/node deploy/token-report.mjs <session.v4.jsonl.zstd> [maxTurns]
 * 只吃已解压的 JSONL：
 *   /opt/node22/bin/node deploy/token-report.mjs --file /tmp/s.jsonl [maxTurns]
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 扫魔数并逐帧解码；单帧文件同样适用。 */
function decodeSession(path) {
  const raw = readFileSync(path)
  if (!path.endsWith('.zstd')) return { text: raw.toString('utf8'), frames: 0 }
  const offsets = []
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i)
  }
  const parts = []
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length
    try {
      parts.push(zstdDecompressSync(raw.subarray(offsets[k], end)).toString('utf8'))
    } catch {
      /* 半截帧（进程正在写）跳过 */
    }
  }
  return { text: parts.join(''), frames: offsets.length }
}

const fileIndex = process.argv.indexOf('--file')
const source = fileIndex >= 0 ? process.argv[fileIndex + 1] : process.argv[2]
const maxTurns = Number(process.argv[fileIndex >= 0 ? fileIndex + 2 : 3] ?? 15) || 15
if (source === undefined) {
  console.error('用法: token-report.mjs [--file] <会话文件> [maxTurns]')
  process.exit(2)
}

const { text, frames } = decodeSession(source)
const records = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  try { records.push(JSON.parse(line)) } catch { /* 末尾半行 */ }
}

const bytes = (value) => (value === undefined || value === null ? 0 : JSON.stringify(value).length)
const median = (xs) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const p90 = (xs) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]
}

console.log(`\n会话文件  ${source}`)
console.log(`zstd 帧数 ${frames}（整体解码只能拿到第一帧；这里逐帧解开）`)
console.log(`记录行数  ${records.length}`)

// ── 固定前缀：工具定义（来自 request/header）+ 系统提示 ──────────────────────
const headers = records.filter((r) => r.type === 'request/header')
const tools = headers.length === 0 ? [] : (headers[headers.length - 1].data?.header?.tools ?? [])
const toolsChars = bytes(tools)
const toolsDescrChars = tools.reduce((n, t) => n + String(t.description ?? '').length, 0)
const toolsSchemaChars = tools.reduce((n, t) => n + bytes(t.parameters), 0)
const systemRecords = records.filter((r) => r.type === 'system/message')
const systemChars = systemRecords.reduce((n, r) => n + bytes(r.data), 0)

console.log(`\n── 固定前缀`)
console.log(`工具定义   ${tools.length} 个，JSON ${toolsChars} 字符（描述 ${toolsDescrChars} / 参数 schema ${toolsSchemaChars}）`)
console.log(`系统提示   system/message ${systemRecords.length} 条，JSON ${systemChars} 字符`)
console.log(`request/header ${headers.length} 次（每次工具集变化都会写一条）`)

// ── 逐回合 ──────────────────────────────────────────────────────────────────
const turns = new Map()
for (const r of records) {
  const t = r.data?.turn
  if (typeof t !== 'number') continue
  const list = turns.get(t) ?? []
  list.push(r)
  turns.set(t, list)
}

const rows = []
for (const [turn, list] of [...turns].sort((a, b) => a[0] - b[0])) {
  const starts = list.filter((r) => r.type === 'turn/start')
  const ends = list.filter((r) => r.type === 'turn/end')
  if (starts.length === 0) continue
  const steps = list.filter((r) => r.type === 'step/start').length
  const usages = list.filter((r) => r.type === 'assistant/message' && r.data?.usage !== undefined).map((r) => r.data.usage)
  const input = usages.map((u) => Number(u.inputTokens ?? 0))
  const cached = usages.map((u) => Number(u.cacheReadTokens ?? 0))
  const output = usages.map((u) => Number(u.outputTokens ?? 0))
  const startAt = Math.min(...starts.map((r) => r.time))
  const endAt = ends.length === 0 ? startAt : Math.max(...ends.map((r) => r.time))
  const firstUser = list.find((r) => r.type === 'user/message' || r.type === 'agent/inbox/spliced')
  const toolResults = list.filter((r) => r.type === 'tool/result')
  rows.push({
    turn,
    steps,
    seconds: (endAt - startAt) / 1000,
    inputMax: input.length === 0 ? 0 : Math.max(...input),
    cachedMax: cached.length === 0 ? 0 : Math.max(...cached),
    outputSum: output.reduce((a, b) => a + b, 0),
    packetChars: bytes(firstUser?.data?.message ?? firstUser?.data),
    toolResultChars: toolResults.reduce((n, r) => n + bytes(r.data), 0),
    toolCalls: list.filter((r) => r.type === 'tool/call').length,
    compactions: list.filter((r) => r.type === 'compaction/end').length,
    prunes: list.filter((r) => r.type === 'compaction/prune').length,
  })
}

if (rows.length === 0) {
  console.log('\n没有找到带 turn 的记录。')
  process.exit(0)
}

console.log(`\n── 逐回合（最近 ${Math.min(maxTurns, rows.length)} 轮）`)
console.log(' 轮  步  耗时(s)  输入token  其中缓存  输出  包字符  工具结果字符  工具调用  压缩')
for (const r of rows.slice(-maxTurns)) {
  console.log(
    String(r.turn).padStart(4) + String(r.steps).padStart(4) + String(r.seconds.toFixed(1)).padStart(9)
    + String(r.inputMax).padStart(10) + String(r.cachedMax).padStart(10) + String(r.outputSum).padStart(6)
    + String(r.packetChars).padStart(9) + String(r.toolResultChars).padStart(14)
    + String(r.toolCalls).padStart(10) + String(r.compactions).padStart(6),
  )
}

const inputs = rows.map((r) => r.inputMax)
const cacheds = rows.map((r) => r.cachedMax)
const seconds = rows.map((r) => r.seconds)
const steps = rows.map((r) => r.steps)
console.log(`\n── 汇总（${rows.length} 轮）`)
/** 实际提交量 = 未命中缓存的新增部分 + 命中的前缀。 */
const totals = rows.map((r) => r.inputMax + r.cachedMax)
console.log(`新增 token    中位 ${median(inputs)}   p90 ${p90(inputs)}   最大 ${Math.max(...inputs)}`)
console.log(`缓存前缀 token 中位 ${median(cacheds)}   p90 ${p90(cacheds)}   最大 ${Math.max(...cacheds)}`)
console.log(`总输入 token  中位 ${median(totals)}   p90 ${p90(totals)}   最大 ${Math.max(...totals)}（新增 + 缓存命中）`)
console.log(`耗时(s)      中位 ${median(seconds).toFixed(1)}   p90 ${p90(seconds).toFixed(1)}`)
console.log(`步数         中位 ${median(steps)}   p90 ${p90(steps)}   最大 ${Math.max(...steps)}`)
console.log(`工具结果字符 中位 ${median(rows.map((r) => r.toolResultChars))}`)
console.log(median(rows.map((r) => r.packetChars)) === 0
  ? `注入包字符   未采集到（注入的记录不带 turn 字段，度量口径待 P6b 调整）`
  : `注入包字符   中位 ${median(rows.map((r) => r.packetChars))}`)
console.log(`压缩次数     合计 ${rows.reduce((n, r) => n + r.compactions, 0)}（prune ${rows.reduce((n, r) => n + r.prunes, 0)}）`)
console.log(`工具定义     一轮固定 ${toolsChars} 字符 / ${tools.length} 个工具`)
