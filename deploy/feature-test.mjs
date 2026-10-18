/**
 * Feature smoke test — runs the *compiled* lib/ modules on the real server with
 * real network and real ffmpeg. Prints one line per check.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-feature-'))
const results = []
const noop = () => {}

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    record(name, true, detail === undefined ? '' : String(detail).slice(0, 220))
  } catch (error) {
    record(name, false, (error && error.message ? error.message : String(error)).slice(0, 300))
  }
}

const mod = async (p) => await import(`#lib/${p}`)

// ── 1. link resolve ─────────────────────────────────────────────────────────
const link = await mod('link-resolve.js')

await check('extractUrls: 文本抽链', () => {
  const urls = link.extractUrls('看看这个 https://www.bilibili.com/video/BV1GJ411x7h7 还有 b23.tv/abc123', 3)
  if (urls.length < 2) throw new Error('只抽到 ' + urls.length + ' 条: ' + JSON.stringify(urls))
  return JSON.stringify(urls)
})

await check('resolveLink: B站 BV（含风控回退）', async () => {
  const card = await link.resolveLink('https://www.bilibili.com/video/BV1GJ411x7h7')
  if (card.kind !== 'bilibili') throw new Error('kind=' + card.kind)
  if (card.title === '') throw new Error('标题为空')
  const tier = card.extra.coverUnavailable === true ? 'open-endpoints(no-cover)' : 'view(full)'
  return `${card.title} | dur=${card.extra.durationSec ?? '?'}s | cover=${card.cover !== null} | tier=${tier}`
})

await check('resolveLink: 网易云歌曲', async () => {
  const card = await link.resolveLink('https://music.163.com/#/song?id=347230')
  if (card.kind !== 'music163') throw new Error('kind=' + card.kind)
  if (card.title === '') throw new Error('标题为空')
  return `${card.title} | ${card.desc} | cover=${card.cover !== null}`
})

await check('resolveLink: 通用网页', async () => {
  const card = await link.resolveLink('https://example.com/')
  if (card.kind !== 'web') throw new Error('kind=' + card.kind)
  return `${card.title} | ${card.desc.slice(0, 60)}`
})

// ── 2. meme (ffmpeg drawtext) ───────────────────────────────────────────────
const meme = await mod('meme.js')

await check('resolveFont: 自动探测中文字体', async () => {
  const font = await meme.resolveFont(null, noop)

// ── 1b. lossless JSON guard (the qq_recall_memory bug) ──────────────────────
const toolkit = await mod('tool-kit.js')

await check('lossless: 剔除 undefined / NaN，且能无损往返', () => {
  const raw = {
    count: 1,
    note: undefined,            // ← 就是这一行让 qq_recall_memory 报错
    rows: [{ text: 'x', extra: undefined, score: Number.NaN }, undefined],
    when: new Date('2026-01-02T03:04:05Z'),
    deep: { a: undefined, b: 1 },
  }
  const clean = toolkit.lossless(raw)
  const text = JSON.stringify(clean)
  const round = JSON.parse(text)
  if (JSON.stringify(round) !== text) throw new Error('往返后有差异')
  if ('note' in clean) throw new Error('note 没被剔除')
  if (clean.rows[0].extra !== undefined && 'extra' in clean.rows[0]) throw new Error('嵌套 undefined 没被剔除')
  if (clean.rows[0].score !== null) throw new Error('NaN 没转成 null')
  if (clean.rows[1] !== null) throw new Error('数组里的 undefined 没转成 null（会移位）')
  if ('a' in clean.deep) throw new Error('深层 undefined 没被剔除')
  if (typeof clean.when !== 'string') throw new Error('Date 没转成字符串')
  return `round-trip ok, JSON ${text.length} 字节`
})

await check('lossless: 空记忆命中路径（原报错场景）', () => {
  // Exactly the shape qq_recall_memory returned when the query DID match.
  const withHits = { count: 1, query: '师父', note: undefined, memories: [{ id: 'k1', content: '师父的资料' }] }
  const clean = toolkit.lossless(withHits)
  JSON.stringify(clean) // would have thrown in the validator, not here — assert shape:
  if ('note' in clean) throw new Error('仍有 undefined 字段')
  if (clean.memories.length !== 1) throw new Error('丢数据')
  return '有命中时返回体也是无损 JSON'
})
  if (!fs.existsSync(font)) throw new Error('字体不存在: ' + font)
  return font
})

await check('makeMeme: 中文配字出图', async () => {
  const src = path.join(tmp, 'src.jpg')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=600x600', '-frames:v', '1', '-y', src])
  const outDir = path.join(tmp, 'memes')
  const res = await meme.makeMeme({ image: src, top: '今天也要好好摸鱼', bottom: '但是我先睡了', outDir, log: noop })
  if (!fs.existsSync(res.file)) throw new Error('产物不存在: ' + res.file)
  if (res.bytes < 5000) throw new Error('产物过小: ' + res.bytes + ' bytes')
  return `${path.basename(res.file)} ${res.bytes}B`
})

// ── 3. tts (edge-tts with free HTTP fallback) ───────────────────────────────
const tts = await mod('tts.js')

await check('tts: 音色表', () => {
  if (!Array.isArray(tts.POPULAR_VOICES) || tts.POPULAR_VOICES.length < 10) throw new Error('音色表过小')
  return `${tts.POPULAR_VOICES.length} voices, first=${tts.POPULAR_VOICES[0].name}`
})

await check('synthesize: 中文语音（auto 回退）', async () => {
  const res = await tts.synthesize('测试一下语音条，这是服务器上的真实合成。', { outDir: path.join(tmp, 'tts'), log: noop })
  if (!fs.existsSync(res.file)) throw new Error('产物不存在')
  if (res.bytes < 2000) throw new Error('音频过小: ' + res.bytes)
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name', '-of', 'default=nw=1', res.file], { encoding: 'utf8' }).replace(/\n/g, ' ').trim()
  return `${path.basename(res.file)} ${res.bytes}B provider=${res.provider} :: ${probe}`
})

await check('synthesize: 指定 provider=edge 时如实报错', async () => {
  try {
    const res = await tts.synthesize('强制走 edge', { outDir: path.join(tmp, 'tts2'), log: noop }, 'edge')
    return `edge 竟然可用: ${res.bytes}B`
  } catch (error) {
    const msg = String(error.message)
    if (!/edge|403|握手/.test(msg)) throw new Error('错误信息没提到 edge: ' + msg)
    return '出发边缘拒绝，已如实报错：' + msg.slice(0, 120)
  }
})

// ── 4. imagegen (pollinations) ──────────────────────────────────────────────
const imagegen = await mod('imagegen.js')

await check('generateImage: pollinations 生成 512x512', async () => {
  const res = await imagegen.generateImage('a cute orange cat sitting on a keyboard', {
    config: { enabled: true, provider: 'pollinations', baseUrl: null, apiKey: null, model: 'flux', width: 512, height: 512 },
    outDir: path.join(tmp, 'gen'),
    log: noop,
  })
  if (!fs.existsSync(res.file)) throw new Error('产物不存在')
  if (res.bytes < 5000) throw new Error('图片过小: ' + res.bytes)
  return `${path.basename(res.file)} ${res.bytes}B provider=${res.provider}`
})

// ── 5. rss ──────────────────────────────────────────────────────────────────
const rss = await mod('rss.js')

for (const url of ['https://feeds.bbci.co.uk/news/world/rss.xml', 'https://www.ruanyifeng.com/blog/atom.xml', 'https://sspai.com/feed']) {
  await check('fetchFeed: ' + new URL(url).host, async () => {
    const feed = await rss.fetchFeed(url, noop)
    if (feed.items.length === 0) throw new Error('没有条目')
    return `title=${feed.title} items=${feed.items.length} first=${feed.items[0].title.slice(0, 40)}`
  })
}

// ── 6. reminders parseWhen ──────────────────────────────────────────────────
const reminders = await mod('reminders.js')
const now = new Date(2025, 9, 15, 10, 0, 0) // 2025-10-15 10:00 local (Wed)
const fmt = (t) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const cases = [
  ['明天9点', '2025-10-16 09:00'],
  ['晚上8点', '2025-10-15 20:00'],
  ['9点', '2025-10-16 09:00'],
  ['后天中午', '2025-10-17 12:00'],
  ['30秒后', '2025-10-15 10:00'],
  ['15号9点半', '2025-10-15 09:30'],
  ['2026-10-15 09:00', '2026-10-15 09:00'],
  ['每周一晚上8点', '2025-10-20 20:00'],
]

await check('parseWhen: 8 条算例', () => {
  const bad = []
  for (const [input, want] of cases) {
    const got = reminders.parseWhen(input, now)
    if (got === null) { bad.push(`${input} -> null`); continue }
    const text = fmt(got.at)
    if (text !== want) bad.push(`${input} -> ${text} (want ${want})`)
  }
  if (bad.length > 0) throw new Error(bad.join('; '))
  return '全部命中'
})

await check('parseWhen: 说不出时间返回 null', () => {
  if (reminders.parseWhen('随便什么时候', now) !== null) throw new Error('应该返回 null')
  return 'ok'
})

// ── 7. quotes store round-trip ──────────────────────────────────────────────
const quotes = await mod('quotes.js')
await check('QuoteStore: 增/查/随机/统计/去重', async () => {
  const qs = new quotes.QuoteStore({ enabled: true, dir: path.join(tmp, 'quotes'), autoCapture: false }, { workspacePath: tmp, dshHome: tmp, log: noop })
  await qs.load()
  const a = await qs.add({ text: '人活着就是为了摸鱼', speaker: '群友A', speakerId: 111, groupId: 222, tags: ['摸鱼'] })
  const dup = await qs.add({ text: '人活着就是为了摸鱼', speaker: '群友A', speakerId: 111, groupId: 222 })
  if (dup.id !== a.id) throw new Error('去重失败')
  const hits = qs.search('摸鱼', 5)
  if (hits.length === 0) throw new Error('搜索不到')
  if (qs.random() === null) throw new Error('随机取不到')
  const stats = qs.stats()
  if (stats.total !== 1) throw new Error('统计 total=' + stats.total)
  return `total=${stats.total} dupSameId=true search=${hits.length}`
})

// ── 8. learn store ──────────────────────────────────────────────────────────
const learn = await mod('learn.js')
await check('LearnStore: 学口癖 + flush + top', async () => {
  const ls = new learn.LearnStore({ enabled: true, file: null, autoCapture: true, minOccurrences: 3 }, { workspacePath: tmp, dshHome: tmp, log: noop })
  await ls.load()
  for (let i = 0; i < 4; i++) ls.observe({ text: '绝绝子', userId: 111 + i, groupId: 222 })
  for (let i = 0; i < 4; i++) ls.observe({ text: '确实', userId: 111, groupId: 222 })
  await ls.flush()
  const top = ls.top(10)
  if (top.length === 0) throw new Error('没学到任何短语')
  return top.map((p) => `${p.text}x${p.count}`).join(',')
})

// ── 9. flood guard ──────────────────────────────────────────────────────────
const flood = await mod('flood.js')
await check('FloodGuard: 复读触发 + 豁免 + 冷却', () => {
  const cfg = {
    flood: { enabled: true, windowSec: 30, maxMessages: 4, action: 'warn', muteSeconds: 60, exempt: [] },
    admins: [999],
    primaryGroup: 222,
  }
  const guard = new flood.FloodGuard(cfg, noop)
  let hit = null
  for (let i = 0; i < 4; i++) {
    const d = guard.observe({ groupId: 222, userId: 111, text: '复读机', selfId: 888 })
    if (d !== null) hit = d
  }
  if (hit === null) throw new Error('复读未触发')
  if (guard.observe({ groupId: 222, userId: 999, text: 'x', selfId: 888 }) !== null) throw new Error('管理员未豁免')
  if (guard.observe({ groupId: 222, userId: 888, text: 'y', selfId: 888 }) !== null) throw new Error('机器人自己未豁免')
  if (guard.observe({ groupId: 222, userId: 111, text: '复读机', selfId: 888 }) !== null) throw new Error('冷却期内重复触发')
  const stats = guard.stats()
  guard.dispose()
  return `triggered=${stats.triggered} tracked=${stats.tracked}`
})

// ── summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok)
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`)
if (failed.length > 0) {
  console.log('FAILED:')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
}
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)