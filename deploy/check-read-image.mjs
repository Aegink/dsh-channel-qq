/**
 * Did `read_image` actually work? Prints read_image tool calls and their results
 * from a session transcript.
 *
 * Run: /opt/node22/bin/node /root/.push-out/check-read-image.mjs [room]
 */
import { execFileSync } from 'node:child_process'

const room = process.argv[2] ?? 'qq-dm-ADMIN_QQ'
const zst = `~/.dsh/sessions/--opt-dsh-workspace-tongling--/${room}/session.v4.jsonl.zstd`
const jsonl = execFileSync('/usr/bin/zstd', ['-dc', zst], { maxBuffer: 1 << 28 }).toString('utf8')

const calls = new Map()
const hits = []
let turns = 0
let toolNames = []
for (const line of jsonl.split('\n')) {
  if (line.trim() === '') continue
  let r
  try { r = JSON.parse(line) } catch { continue }
  if (r.type === 'assistant/message') {
    for (const b of r.data?.message?.content ?? []) {
      if (b.type !== 'tool-call') continue
      calls.set(b.id, { name: b.name, args: b.arguments })
      toolNames.push(b.name)
    }
  }
  if (r.type === 'turn/end') turns++
  if (r.type === 'tool/result') {
    const m = r.data?.message ?? {}
    const call = calls.get(m.toolCallId ?? r.data?.toolCallId)
    if (call === undefined || call.name !== 'read_image') continue
    const text = Array.isArray(m.content)
      ? m.content.map((c) => c.text ?? JSON.stringify(c)).join('\n')
      : String(m.content ?? '')
    hits.push({ at: r.time, args: call.args, isError: m.isError === true, text })
  }
}

console.log(`${room}: ${turns} turns, ${toolNames.length} tool calls`)
console.log('last 12 tools: ' + toolNames.slice(-12).join(', '))
console.log(`${hits.length} read_image call(s)\n`)
for (const h of hits.slice(-4)) {
  const when = h.at === undefined ? '?' : new Date(h.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  console.log('-'.repeat(70))
  console.log(`${when}  isError=${h.isError}`)
  console.log('args: ' + String(h.args).slice(0, 160))
  console.log('result: ' + h.text.replace(/\s+/g, ' ').slice(0, 900))
}
if (hits.length === 0) console.log('(no read_image call found)')