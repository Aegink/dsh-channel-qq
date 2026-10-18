/**
 * Session transcript analyzer for the QQ channel: turn timings, what the bot was
 * handed, and what it actually sent.
 *
 * The session artifact is a *multi-frame* zstd stream (one frame per append — 690
 * in the group session) and Node's zstd decoder stops after the first frame, so
 * decompress with the CLI first:
 *
 *   zstd -dc ~/.dsh/sessions/--opt-dsh-workspace-tongling--/<id>/session.v4.jsonl.zstd > /tmp/s.jsonl
 *   node dump-session.mjs <id> [turns] --file /tmp/s.jsonl
 *
 * Record types used (dsh session format v4):
 *   turn/start · turn/end            turn boundaries + completion reason
 *   user/message                     intake; `source.plugin === 'channel-qq'` means it came from QQ
 *   assistant/message                model output: text and tool-call blocks
 */

import { promises as fs } from 'node:fs'

const SESSIONS = '~/.dsh/sessions/--opt-dsh-workspace-tongling--'
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const fileFlag = process.argv.indexOf('--file')
const plainFile = fileFlag >= 0 ? process.argv[fileFlag + 1] : null
const sessionId = args[0] ?? 'qq-group-PRIMARY_GROUP'
const wantTurns = Number(args[1] ?? 5)

let jsonl
if (plainFile !== null) {
  jsonl = await fs.readFile(plainFile, 'utf8')
} else {
  const dir = `${SESSIONS}/${sessionId}`
  const files = await fs.readdir(dir).catch(() => [])
  const zst = files.filter((f) => f.endsWith('.zstd')).sort()
  if (zst.length === 0) {
    console.error(`没有会话文件：${dir}（或用 --file 指定已解压的 JSONL）`)
    process.exit(1)
  }
  console.error('提示：多帧 zstd 需要先用 zstd CLI 解压，再用 --file 传入。')
  jsonl = ''
}

const records = []
for (const line of jsonl.split('\n')) {
  if (line.trim() === '') continue
  try { records.push(JSON.parse(line)) } catch { /* trailing partial line */ }
}

/** Tools that put something into a QQ room. */
const SEND_TOOLS = new Set([
  'qq_send_text', 'qq_reply_quote', 'qq_send_emoji', 'qq_send_voice',
  'qq_send_ai_voice', 'qq_send_music_card', 'qq_send_music_voice', 'qq_send_image',
])

const clock = (ms) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const hhmmss = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

const turns = []
let current = null

for (const r of records) {
  const t = r.type
  const time = r.time ?? null
  if (t === 'turn/start') {
    current = { turn: r.data?.turn ?? turns.length + 1, start: time, intake: [], sends: [], said: [], steps: 0, end: null, reason: null }
    turns.push(current)
    continue
  }
  if (current === null) continue

  if (t === 'turn/end') {
    current.end = time
    current.reason = r.data?.reason?.kind ?? r.data?.reason ?? null
    continue
  }
  if (t === 'step/end') { current.steps += 1; continue }

  if (t === 'user/message') {
    const fromQQ = r.data?.source?.plugin === 'channel-qq'
    const text = (r.data?.content ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
    if (text !== '') current.intake.push({ fromQQ: fromQQ, at: time, text: text })
    continue
  }

  if (t === 'assistant/message') {
    for (const block of r.data?.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        current.said.push(block.text)
      }
      if (block.type === 'tool-call' && SEND_TOOLS.has(block.name)) {
        let parsed = {}
        try { parsed = JSON.parse(block.arguments ?? '{}') } catch { /* keep raw */ }
        current.sends.push({ tool: block.name, args: parsed, at: time })
      }
    }
  }
}

// ── aggregate ───────────────────────────────────────────────────────────────
const finished = turns.filter((t) => t.start !== null && t.end !== null)
const durations = finished.map((t) => Math.round((t.end - t.start) / 1000)).sort((a, b) => a - b)
const pct = (p) => (durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor(durations.length * p))])
const withIntake = turns.filter((t) => t.intake.some((i) => i.fromQQ))
const spoke = withIntake.filter((t) => t.sends.length > 0)

console.log(`会话 ${sessionId}：${records.length} 条记录，${turns.length} 轮（有 QQ 输入 ${withIntake.length} 轮）\n`)
console.log(`轮次耗时（秒）：中位 ${pct(0.5)} / 90分位 ${pct(0.9)} / 最长 ${durations[durations.length - 1] ?? 0}`)
console.log(`有 QQ 输入且真的发言：${spoke.length}/${withIntake.length} 轮`)
const quiet = withIntake.filter((t) => t.sends.length === 0)
console.log(`有 QQ 输入但一句话没说：${quiet.length} 轮`)
const reasons = new Map()
for (const t of finished) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1)
console.log(`结束原因：${[...reasons].map(([k, n]) => `${k}=${n}`).join(' ')}\n`)

// ── recent turns ────────────────────────────────────────────────────────────
for (const turn of turns.slice(-wantTurns)) {
  const dur = (turn.start !== null && turn.end !== null) ? `  用时 ${Math.round((turn.end - turn.start) / 1000)} 秒` : ''
  console.log('═'.repeat(78))
  console.log(`轮次 ${turn.turn}  ${turn.start === null ? '?' : clock(turn.start)}${dur}  步数 ${turn.steps}  结束 ${turn.reason ?? '进行中'}`)
  console.log('═'.repeat(78))
  for (const i of turn.intake) {
    const tag = i.fromQQ ? '【QQ 进来的】' : '【系统/工具】'
    console.log(`\n${tag} ${i.at === null ? '' : hhmmss(i.at)}\n${i.text.length > 900 ? i.text.slice(0, 900) + ' …' : i.text}`)
  }
  for (const s of turn.sends) {
    const a = s.args ?? {}
    const where = a.isGroup === true ? `群 ${a.target ?? '?'}` : `私聊 ${a.target ?? '?'}`
    const body = a.text ?? a.file ?? a.song ?? a.message ?? JSON.stringify(a)
    console.log(`\n【发给 ${where}】${s.at === null ? '' : hhmmss(s.at)}\n${String(body).slice(0, 700)}`)
  }
  if (turn.said.length > 0) {
    console.log(`\n【它对自己说的话（未发出）】\n${turn.said.join('\n').slice(0, 500)}`)
  }
  if (turn.sends.length === 0) console.log('\n（这一轮没有调用任何发送工具）')
  console.log('')
}