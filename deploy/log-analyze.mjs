/**
 * Classify the plugin log: for every distinct "error-ish" message shape, report
 * how often it happened and whether it is still happening (first/last stamp).
 *
 * The point is to separate *historical* failures (fixed during deployment) from
 * failures that are still live — the transcript scanner cannot see these at all
 * because they never reach a tool result.
 *
 * Usage: node log-analyze.mjs <logfile>
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const lines = readFileSync(file, 'utf8').split('\n')

const stampOf = (s) => (s.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/) ?? [])[1] ?? null

/** Normalise a message so different rooms/counts collapse to one shape. */
const shape = (s) =>
  s
    .replace(/qq-(dm|group)-[-\d]+/g, 'qq-ROOM')
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}/g, 'DATE')
    .replace(/[0-9]{2}:[0-9]{2}:[0-9]{2}/g, 'TIME')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)

const NOISE = [
  /create failed for qq-ROOM: session "[^"]*" already exists/,
  /admin login failed from/,
  /admin request failed \(N\): 路径越出了工作区/,
  /admin request failed \(N\): 只允许工作区内的相对路径/,
  /admin request failed \(N\): 文件不存在/,
  /admin request failed \(N\): 已经存在/,
  /admin request failed \(N\): 没有名为/,
  /admin request failed \(N\): Unknown agent preset/,
  /admin request failed \(N\): turn in flight/,
  /admin request failed: /,
  /resumed persisted session/,
]

const IGNORE = [
  /^registered N QQ tools/,
  /^turn done for/,
  /^scheduled tick submitted for/,
  /^self-heal: attached/,
  /^self-heal: N\/N qq sessions/,
  /^dialling NapCat/,
  /^session qq-ROOM ready/,
  /^ensureConversation/,
  /^dm proactive submitted/,
  /^admin: config updated/,
  /^scheduler started/,
  /^forward WS connected/,
  /^QQ link ready/,
  /^admin panel/,
  /^starting \(mode=/,
  /^tts: registered/,
  /^rss: /,
  /^reminders: /,
  /^quotes: /,
  /^meme: /,
  /^link-resolve: /,
  /^learn: /,
  /^imagegen: /,
  /^flood: /,
  /^emoji library/,
  /^knowledge/,
  /^admin prompt submitted/,
  /^inject/ ,
  /^batch/,
  /^learned/,
]

const groups = new Map()
let count = 0

for (const raw of lines) {
  if (raw.trim() === '') continue
  const at = stampOf(raw)
  const msg = at === null ? raw.trim() : raw.slice(at.length).trim()
  const sh = shape(msg)
  count++

  const isNoise = NOISE.some(re => re.test(sh))
  const isIgnore = IGNORE.some(re => re.test(sh))
  const isErr = /failed|error|ERR_|unhandled|reject|EINVAL|ENOENT|is not a function/i.test(msg)

  if (!isErr) continue

  let g = groups.get(sh)
  if (g === undefined) {
    g = { n: 0, first: at, last: at, sample: msg.slice(0, 200), noise: isNoise, ignore: isIgnore }
    groups.set(sh, g)
  }
  g.n++
  if (at !== null) { if (g.first === null || at < g.first) g.first = at; if (g.last === null || at > g.last) g.last = at }
  if (!isNoise && !isIgnore) g.sample = msg.slice(0, 200)
}

console.log(`${file}: ${lines.length} 行, ${count} 条非空记录\n`)

const real = []
const noise = []
for (const [sh, g] of groups) (g.noise || g.ignore ? noise : real).push([sh, g])

const show = (title, arr) => {
  console.log(`===== ${title} (${arr.length}) =====`)
  for (const [, g] of arr.sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${String(g.n).padStart(5)}  ${g.first} .. ${g.last}`)
    console.log(`       ${g.sample}`)
  }
  console.log('')
}

show('真正需要看的错误', real)
show('预期噪音（负向测试 / 正常 resume）', noise)