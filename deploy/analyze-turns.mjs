/**
 * Per-turn table for a QQ session: duration, steps, prompt size, compaction.
 *
 * Why: "replies take ages / answer the wrong thing" needs numbers, not a
 * narrative. This prints one row per turn with the wall-clock duration, the
 * number of steps, the largest prompt the model was sent, token totals, whether a
 * context compaction fired, and what the turn was actually responding to.
 *
 * Real QQ intake is recognised by the line shape `HH:MM 昵称(QQ号)…：正文`
 * (see `formatLine` in bridge.ts); everything else is a harness-injected prompt
 * (scheduled tick, patrol, dream, evolution), which also arrives with
 * `source.plugin === 'channel-qq'`.
 *
 *   node analyze-turns.mjs <sessionId> [rows] --file /tmp/s.jsonl
 */

import { promises as fs } from 'node:fs'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const fileFlag = process.argv.indexOf('--file')
const file = fileFlag >= 0 ? process.argv[fileFlag + 1] : null
const wantRows = Number(args[1] ?? 25)
if (file === null) {
  console.error('需要 --file <已解压的 JSONL>')
  process.exit(2)
}

const jsonl = await fs.readFile(file, 'utf8')
const records = []
for (const line of jsonl.split('\n')) {
  if (line.trim() === '') continue
  try { records.push(JSON.parse(line)) } catch { /* partial */ }
}

const SEND_TOOLS = new Set([
  'qq_send_text', 'qq_reply_quote', 'qq_send_emoji', 'qq_send_voice',
  'qq_send_ai_voice', 'qq_send_music_card', 'qq_send_music_voice', 'qq_send_image',
])

// A real QQ line: "HH:MM 昵称(123456)...：正文" somewhere in the text.
const QQ_LINE = /\d{1,2}:\d{2}\s[^\n]*\(\d{4,}\)[^\n]*：/

const hhmmss = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

const turns = []
let cur = null
for (const r of records) {
  const t = r.type
  const time = r.time ?? null
  if (t === 'turn/start') {
    cur = {
      n: r.data?.turn ?? turns.length + 1, start: time, end: null, steps: 0,
      intake: [], sends: 0, promptTokens: 0, outputTokens: 0, cacheRead: 0,
      compactions: 0, reason: null, requests: 0,
    }
    turns.push(cur)
    continue
  }
  if (cur === null) continue
  if (t === 'turn/end') { cur.end = time; cur.reason = r.data?.reason?.kind ?? r.data?.reason ?? null; continue }
  if (t === 'step/end') { cur.steps += 1; continue }
  if (t === 'compaction/prune') { cur.compactions += 1; continue }
  if (t === 'request/header') { cur.requests += 1; continue }
  if (t === 'user/message') {
    const text = (r.data?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
    if (text !== '') cur.intake.push(text)
    continue
  }
  if (t === 'assistant/message') {
    const u = r.data?.usage
    if (u) {
      cur.promptTokens = Math.max(cur.promptTokens, Number(u.inputTokens ?? 0) + Number(u.cacheReadTokens ?? 0))
      cur.outputTokens += Number(u.outputTokens ?? 0)
      cur.cacheRead += Number(u.cacheReadTokens ?? 0)
    }
    for (const b of r.data?.message?.content ?? []) {
      if (b.type === 'tool-call' && SEND_TOOLS.has(b.name)) cur.sends += 1
    }
  }
}

const kindOf = (turn) => {
  for (const text of turn.intake) {
    if (QQ_LINE.test(text)) return '真人'
    if (text.includes('【主动巡逻】')) return '巡逻'
    if (text.includes('【自省进化】')) return '自省'
    if (text.includes('【做梦时间】')) return '做梦'
    if (text.includes('【主动找主人】')) return '找主人'
    if (text.includes('【群事件】')) return '群事件'
    if (text.includes('【每日早报】')) return '早报'
    if (text.includes('【自主发现】')) return '自主'
  }
  return '—'
}

const bar = (n, max) => '█'.repeat(Math.max(1, Math.round((n / Math.max(1, max)) * 28)))

console.log(`会话文件 ${file}：${records.length} 条记录，${turns.length} 轮\n`)
const maxDur = Math.max(...turns.map((t) => (t.start && t.end ? (t.end - t.start) / 1000 : 0)))
console.log(' 轮  开始      耗时(s)  步  请求  提示token  输出  压缩  发言  类型')
console.log(' ' + '─'.repeat(86))
for (const t of turns.slice(-wantRows)) {
  const dur = t.start !== null && t.end !== null ? Math.round((t.end - t.start) / 1000) : -1
  console.log(
    `${String(t.n).padStart(3)}  ${t.start === null ? '??:??:??' : hhmmss(t.start)}  ` +
    `${String(dur < 0 ? '?' : dur).padStart(6)}  ${String(t.steps).padStart(2)}  ` +
    `${String(t.requests).padStart(4)}  ${String(t.promptTokens).padStart(9)}  ` +
    `${String(t.outputTokens).padStart(4)}  ${String(t.compactions).padStart(4)}  ` +
    `${String(t.sends).padStart(4)}  ${kindOf(t)}`,
  )
}

const real = turns.filter((t) => kindOf(t) === '真人')
const durs = turns.filter((t) => t.start !== null && t.end !== null).map((t) => Math.round((t.end - t.start) / 1000)).sort((a, b) => a - b)
const pick = (p) => durs[Math.min(durs.length - 1, Math.floor(durs.length * p))] ?? 0
const prompts = turns.map((t) => t.promptTokens).filter((n) => n > 0).sort((a, b) => a - b)
console.log('\n汇总')
console.log(`  轮次耗时 中位 ${pick(0.5)}s / 75分位 ${pick(0.75)}s / 90分位 ${pick(0.9)}s / 最长 ${durs[durs.length - 1] ?? 0}s`)
console.log(`  提示 token 中位 ${prompts[Math.floor(prompts.length / 2)] ?? 0} / 最大 ${prompts[prompts.length - 1] ?? 0}`)
console.log(`  真人消息轮次 ${real.length} 轮，其中发言 ${real.filter((t) => t.sends > 0).length} 轮`)
console.log(`  触发上下文压缩 ${turns.reduce((n, t) => n + t.compactions, 0)} 次，涉及 ${turns.filter((t) => t.compactions > 0).length} 轮`)
if (real.length > 0) {
  console.log('\n真人消息轮次明细（最近 8 条）')
  for (const t of real.slice(-8)) {
    const dur = t.start !== null && t.end !== null ? Math.round((t.end - t.start) / 1000) : -1
    const first = t.intake.find((x) => QQ_LINE.test(x)) ?? ''
    const line = first.split('\n').find((l) => QQ_LINE.test(l)) ?? first.split('\n')[0]
    console.log(`  ${t.start === null ? '??' : hhmmss(t.start)}  ${String(dur).padStart(4)}s  发言${t.sends}  ${line.slice(0, 68)}`)
  }
}
console.log('\n耗时分布（每格 1 轮，按发生顺序）')
console.log('  ' + turns.map((t) => (t.start === null || t.end === null ? '·' : t.end - t.start > 120000 ? 'X' : t.end - t.start > 45000 ? 'x' : '.')).join(''))
console.log('  X = 超过 2 分钟，x = 超过 45 秒，. = 正常')
console.log(`  ${bar(durs[durs.length - 1] ?? 0, maxDur)}  最长一轮 ${durs[durs.length - 1] ?? 0}s`)