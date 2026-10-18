/**
 * Does the configured gateway model actually accept image input?
 *
 * The bot's diagnosis was "the model entry just omits `input`, so pi-ai defaults
 * it to ['text']; it is a missing declaration, not a missing capability". That is
 * plausible but untested, and the two cases have opposite fixes:
 *
 *   - model truly supports vision -> declare `input: [text, image]` and the whole
 *     read_image / imageRecognition path starts working
 *   - it does not                -> declaring it would make every image turn fail
 *     at the provider instead of cleanly at the harness, which is worse
 *
 * So this asks the provider directly, with an image whose content cannot be
 * guessed: four quadrants in a fixed order (red, green, blue, yellow). A
 * text-only model cannot name them in order; a vision model has no trouble.
 *
 * Run: /opt/node22/bin/node /root/probe-vision.mjs
 */

import { deflateSync } from 'node:zlib'

const BASE = process.env.GATEWAY_BASE ?? 'http://YOUR_HOST:3123/v1'
const KEY = process.env.GATEWAY_KEY ?? 'sk-test-key'
const MODEL = process.env.GATEWAY_MODEL ?? 'cline-pass/deepseek-v4.1-flash'

// ── minimal PNG encoder (no deps) ───────────────────────────────────────────
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function pngQuadrants(size = 64) {
  const rows = []
  const QUAD = [[255, 0, 0], [0, 160, 0], [0, 0, 255], [255, 220, 0]] // TL, TR, BL, BR
  for (let y = 0; y < size; y++) {
    const row = [0] // filter type 0
    for (let x = 0; x < size; x++) {
      const i = (y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1)
      row.push(...QUAD[i])
    }
    rows.push(Buffer.from(row))
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function ask(label, content) {
  const body = { model: MODEL, max_tokens: 200, messages: [{ role: 'user', content }] }
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  const answer = parsed?.choices?.[0]?.message?.content ?? null
  console.log(`\n--- ${label} ---`)
  console.log(`HTTP ${res.status}`)
  if (answer === null) console.log('raw: ' + text.slice(0, 600))
  else console.log('answer: ' + String(answer).replace(/\s+/g, ' ').slice(0, 400))
  return { status: res.status, answer, error: parsed?.error }
}

const png = pngQuadrants()
const dataUrl = `data:image/png;base64,${png.toString('base64')}`
console.log(`model=${MODEL}`)
console.log(`probe image: 64x64 PNG, quadrants TL=red TR=green BL=blue BR=yellow (${png.length} bytes)`)

// 1) plain text, to prove the route itself works
const textOnly = await ask('1) text-only control', 'Reply with exactly: PONG')
console.log(`   -> route ${textOnly.status === 200 ? 'WORKS' : 'BROKEN'}`)

// 2) the actual question
const vision = await ask('2) image + "name the four quadrant colours, top-left first"', [
  { type: 'text', text: 'This image is split into four equal quadrants. Name their colours in reading order (top-left, top-right, bottom-left, bottom-right). Answer with just the four colour names separated by commas.' },
  { type: 'image_url', image_url: { url: dataUrl } },
])

console.log('\n================ 判定 ================')
if (vision.status === 200) {
  const a = String(vision.answer ?? '').toLowerCase()
  const hits = ['red', 'green', 'blue', 'yellow'].filter((c) => a.includes(c)).length
  console.log(`provider accepted the image (HTTP 200), answer: ${String(vision.answer).replace(/\s+/g, ' ').slice(0, 160)}`)
  console.log(hits >= 4
    ? `结论：模型真吃图（四个颜色全中）→ 可以把 input 声明为 [text, image]`
    : `结论：HTTP 200 但只命中 ${hits}/4 个颜色 → 疑似忽略图片（纯文本模型伪装），不应声明 image 输入`)
} else {
  console.log(`provider REJECTED the image: HTTP ${vision.status}`)
  if (vision.error !== undefined) console.log('error: ' + JSON.stringify(vision.error).slice(0, 400))
  console.log('结论：模型不吃图 → 不能声明 input: [text, image]；应换一个吃图的模型')
}