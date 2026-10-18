/**
 * Scan a session transcript for failing tool calls.
 *
 * dsh records each tool invocation as `tool/call` and its outcome as
 * `tool/result`. A failing call is what the model actually sees as "工具调用出错",
 * so this is the authoritative place to look — the plugin log only carries what the
 * plugin itself logs.
 *
 *   zstd -dc <session>.jsonl.zstd > /tmp/s.jsonl
 *   node scan-tool-errors.mjs /tmp/s.jsonl
 */

import { promises as fs } from 'node:fs'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node scan-tool-errors.mjs <decompressed.jsonl>')
  process.exit(2)
}

const jsonl = await fs.readFile(file, 'utf8')
const records = []
for (const line of jsonl.split('\n')) {
  if (line.trim() === '') continue
  try { records.push(JSON.parse(line)) } catch { /* partial */ }
}

// Map tool call id -> {name, args} so results can be attributed.
// Tool invocations are recorded as `tool-call` blocks inside `assistant/message`
// (there is no separate `tool/call` record type — assuming one made every result
// unattributable), so the name/args map is built from those blocks.
const calls = new Map()
const results = []
for (const r of records) {
  if (r.type === 'assistant/message') {
    for (const b of r.data?.message?.content ?? []) {
      if (b.type !== 'tool-call') continue
      let args = b.arguments
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { /* keep the raw string */ }
      }
      calls.set(b.id, { name: b.name, args, at: r.time })
    }
  }
  if (r.type === 'tool/result') {
    results.push({ rec: r })
  }
}

const textOf = (v) => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(textOf).join('\n')
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text
    if (typeof v.content === 'string') return v.content
    if (Array.isArray(v.content)) return textOf(v.content)
    if (typeof v.message === 'string') return v.message
    if (typeof v.error === 'string') return v.error
    if (v.error !== undefined) return JSON.stringify(v.error)
  }
  return JSON.stringify(v)
}

/**
 * Decide whether a result failed.
 *
 * The record carries a structured `isError` flag and that is authoritative — an
 * earlier version of this script also pattern-matched the result *text*, which
 * flagged 27 healthy `bash` calls in the group session whose output merely
 * contained the word "failed" (the model was grepping source code). Text
 * heuristics only apply when the flag is genuinely absent.
 */
const isError = (r) => {
  const d = r.data ?? {}
  const msg = d.message ?? {}
  if (typeof msg.isError === 'boolean') return msg.isError
  if (typeof d.isError === 'boolean') return d.isError
  if (d.status === 'error' || d.ok === false) return true
  if (d.error !== undefined) return true
  // No structured flag: fall back to the leading token only, never a substring
  // search over the whole payload.
  const t = textOf(msg.content ?? d.result ?? d.content ?? d.output ?? d).trimStart()
  return /^(Error|error|ERROR|TypeError|RangeError)\b/.test(t)
}

const bad = []
for (const { rec } of results) {
  if (!isError(rec)) continue
  const d = rec.data ?? {}
  const msg = d.message ?? {}
  const callId = msg.toolCallId ?? d.toolCallId ?? d.id ?? d.callId
  const meta = calls.get(callId)
  bad.push({
    at: rec.time,
    callId,
    name: (meta?.name ?? d.name ?? d.toolName ?? '?'),
    args: meta?.args,
    text: textOf(msg.content ?? d.result ?? d.content ?? d.output ?? d).slice(0, 500),
  })
}

console.log(`文件 ${file}：${records.length} 条记录，tool/call ${calls.size} 次，tool/result ${results.length} 次`)
console.log(`判定失败 ${bad.length} 次\n`)

// Group by tool name, then show the most recent few in full.
const byName = new Map()
for (const b of bad) byName.set(b.name, (byName.get(b.name) ?? 0) + 1)
if (byName.size > 0) {
  console.log('按工具统计：')
  for (const [n, c] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`  ${n}: ${c}`)
  console.log('')
}

const stamp = (t) => (t === undefined ? '??' : new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))
for (const b of bad.slice(-12)) {
  console.log('─'.repeat(76))
  console.log(`${stamp(b.at)}  ${b.name}  ${b.args === undefined ? '' : String(b.args).slice(0, 160)}`)
  console.log(b.text.replace(/\n{2,}/g, '\n'))
}