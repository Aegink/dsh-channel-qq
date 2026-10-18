/**
 * Improved tool-error scanner.
 *
 * Compared with the first version this one is designed to find the failures the
 * model *actually* saw, including the ones a naive `isError` check misses:
 *
 *   1. a tool-call block with no matching tool/result  -> the turn died mid-call
 *   2. a tool/result whose `isError` flag is absent but whose text is an error
 *   3. results that are technically ok but carry a failure payload
 *      (OneBot `retcode != 0`, `status:"failed"`, `"failed"` inside JSON)
 *   4. duplicate result records for a single call id
 *
 * Usage: node scan2.mjs <decompressed.jsonl> [...more]
 */
import { promises as fs } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scan2.mjs <decompressed.jsonl> [...]')
  process.exit(2)
}

const textOf = (v, depth = 0) => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (depth > 6) return ''
  if (Array.isArray(v)) return v.map(x => textOf(x, depth + 1)).join('\n')
  if (typeof v === 'object') {
    for (const k of ['text', 'content', 'message', 'error', 'result', 'output']) {
      if (v[k] !== undefined) return textOf(v[k], depth + 1)
    }
    try { return JSON.stringify(v) } catch { return '' }
  }
  return ''
}

const ERROR_HEAD = /^\s*(Error|error|ERROR|TypeError|RangeError|SyntaxError|ReferenceError|URIError|AggregateError|EvalError|UnhandledPromiseRejection|Cannot |cannot |Failed |failed |ENOENT|EACCES|EPERM|ETIMEDOUT|ECONNREFUSED|HTTP \d{3}|Unable to)\b/

/** Failure shapes that hide behind `isError:false`. */
function payloadFailure(text) {
  const hits = []
  if (/"retcode"\s*:\s*-?\d{1,}/.test(text)) {
    const m = text.match(/"retcode"\s*:\s*(-?\d+)/)
    if (m && m[1] !== '0') hits.push('retcode=' + m[1])
  }
  if (/"status"\s*:\s*"failed"/.test(text)) hits.push('status=failed')
  if (/"wording"\s*:\s*"[^"]+"/.test(text)) {
    const m = text.match(/"wording"\s*:\s*"([^"]{0,80})"/)
    if (m) hits.push('wording=' + m[1])
  }
  if (/\b识别URL失败\b/.test(text)) hits.push('识别URL失败')
  if (/\bfailed ""/.test(text)) hits.push('failed ""')
  if (/does not declare image input/.test(text)) hits.push('no image input')
  if (/session already exists/.test(text)) hits.push('session-exists (benign)')
  if (/file has not been read/.test(text)) hits.push('read-before-edit guardrail')
  if (/file changed since it was read/.test(text)) hits.push('changed-since-read guardrail')
  if (/\bENOENT\b/.test(text)) hits.push('ENOENT')
  return hits
}

const perFile = []

for (const file of files) {
  const jsonl = await fs.readFile(file, 'utf8')
  const records = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try { records.push(JSON.parse(line)) } catch { /* partial trailing frame */ }
  }

  const calls = new Map()
  const results = new Map()
  for (const r of records) {
    if (r.type === 'assistant/message') {
      for (const b of r.data?.message?.content ?? []) {
        if (b.type !== 'tool-call') continue
        let args = b.arguments
        if (typeof args === 'string') { try { args = JSON.parse(args) } catch { /* keep */ } }
        calls.set(b.id, { name: b.name, args, at: r.time })
      }
    }
    if (r.type === 'tool/result') {
      const d = r.data ?? {}
      const msg = d.message ?? {}
      const id = msg.toolCallId ?? d.toolCallId ?? d.id ?? d.callId
      const rec = { at: r.time, rec: r, msg, d }
      if (!results.has(id)) results.set(id, [])
      results.get(id).push(rec)
    }
  }

  const errors = []
  const noResult = []
  const payloadFlagged = []

  for (const [id, meta] of calls) {
    const rs = results.get(id)
    if (!rs || rs.length === 0) { noResult.push({ id, ...meta }); continue }
    for (const r of rs) {
      const { msg, d } = r
      const text = textOf(msg.content ?? d.result ?? d.content ?? d.output ?? d)
      let flagged = false
      if (typeof msg.isError === 'boolean') flagged = msg.isError
      else if (typeof d.isError === 'boolean') flagged = d.isError
      else if (d.status === 'error' || d.ok === false || d.error !== undefined) flagged = true
      else if (ERROR_HEAD.test(text)) flagged = true
      if (flagged) {
        errors.push({ at: r.at, id, name: meta.name, args: meta.args, text, kind: 'isError' })
      } else {
        const hints = payloadFailure(text)
        if (hints.length > 0) payloadFlagged.push({ at: r.at, id, name: meta.name, args: meta.args, text, hints })
      }
    }
  }

  // Results with no matching call (attribution lost) — usually a resumed turn.
  const orphan = [...results.keys()].filter(k => k !== undefined && !calls.has(k)).length

  perFile.push({ file, records: records.length, calls: calls.size, results: results.size, errors, noResult, payloadFlagged, orphan })
}

let totalCalls = 0, totalErrors = 0, totalNoResult = 0
for (const f of perFile) {
  totalCalls += f.calls
  totalErrors += f.errors.length
  totalNoResult += f.noResult.length
  console.log('='.repeat(78))
  console.log(`${f.file}`)
  console.log(`  records=${f.records}  tool/call=${f.calls}  tool/result=${f.results}  orphanResults=${f.orphan}`)
  console.log(`  isError=${f.errors.length}  noResult=${f.noResult.length}  payloadFlagged=${f.payloadFlagged.length}`)

  const byName = new Map()
  for (const e of f.errors) {
    const k = e.name ?? '?'
    byName.set(k, (byName.get(k) ?? 0) + 1)
  }
  if (byName.size > 0) {
    console.log('  -- 真失败按工具 --')
    for (const [n, c] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`     ${n}: ${c}`)
  }
  if (f.noResult.length > 0) {
    console.log('  -- 有调用无结果 --')
    const m = new Map()
    for (const n of f.noResult) m.set(n.name ?? '?', (m.get(n.name ?? '?') ?? 0) + 1)
    for (const [n, c] of [...m].sort((a, b) => b[1] - a[1])) console.log(`     ${n}: ${c}`)
  }
  if (f.payloadFlagged.length > 0) {
    console.log('  -- isError=false 但载荷可疑 --')
    const m = new Map()
    for (const p of f.payloadFlagged) {
      for (const h of p.hints) m.set(h, (m.get(h) ?? 0) + 1)
    }
    for (const [h, c] of [...m].sort((a, b) => b[1] - a[1])) console.log(`     ${h}: ${c}`)
  }
}

console.log('='.repeat(78))
console.log(`TOTAL calls=${totalCalls} isError=${totalErrors} noResult=${totalNoResult}`)

// Full, de-duplicated error bodies so the actual causes are visible.
const seen = new Set()
console.log('\n===== 失败详情（去重） =====')
for (const f of perFile) {
  for (const e of f.errors) {
    const norm = e.text.replace(/\s+/g, ' ').trim().slice(0, 300)
    const key = (e.name ?? '?') + '||' + norm
    if (seen.has(key)) continue
    seen.add(key)
    const stamp = e.at === undefined ? '?' : new Date(e.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    console.log('-'.repeat(70))
    console.log(`[${f.file}] ${stamp}  ${e.name}`)
    console.log(`  args: ${JSON.stringify(e.args)?.slice(0, 200)}`)
    console.log(`  text: ${e.text.replace(/\n{2,}/g, ' | ').slice(0, 400)}`)
  }
}

console.log('\n===== 载荷可疑详情（去重，最多 25 条） =====')
const seen2 = new Set()
let shown = 0
for (const f of perFile) {
  for (const p of f.payloadFlagged) {
    const norm = p.text.replace(/\s+/g, ' ').trim().slice(0, 200)
    const key = (p.name ?? '?') + '||' + p.hints.join(',') + '||' + norm
    if (seen2.has(key)) continue
    seen2.add(key)
    if (shown++ >= 25) break
    const stamp = p.at === undefined ? '?' : new Date(p.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    console.log('-' .repeat(70))
    console.log(`[${f.file}] ${stamp}  ${p.name}  hints=${p.hints.join(',')}`)
    console.log(`  args: ${JSON.stringify(p.args)?.slice(0, 200)}`)
    console.log(`  text: ${p.text.replace(/\n{2,}/g, ' | ').slice(0, 300)}`)
  }
}