/**
 * Regression test: TTS backend dispatch and fallback.
 *
 * Why this exists: `src/tts.ts` exports two seams —
 * `__setBackendForTest(fn)` (replaces the per-backend synthesiser) and
 * `__setFetchForTest(fn)` (replaces the HTTP fetch the baidu/google backends use)
 * — and its own comment says they are there "so unit tests can verify provider
 * dispatch and fallback without a network or a mocked WebSocket". No such test
 * existed, which left both exports with zero callers and the fallback path
 * unverified. This is that test.
 *
 * Everything runs offline: the fake backend never touches the network, and the
 * fake fetch returns canned responses.
 *
 * Run on the server against the compiled output:
 *   /opt/node22/bin/node /root/tts-fallback-test.mjs
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { synthesize, __setBackendForTest, __setFetchForTest } from '#lib/adapters/providers/tts/index.js'

const ZH = 'zh-CN-XiaoxiaoNeural'
const EN = 'en-US-JennyNeural'

let pass = 0
const failures = []

async function check(name, fn) {
  try {
    const detail = await fn()
    pass += 1
    console.log(`PASS  ${name}${detail === undefined ? '' : '  ' + detail}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}  ${error.message}`)
  }
}

const eq = (actual, expected, label = '') => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label}expected ${e}, got ${a}`)
}

async function throws(fn, want) {
  try {
    await fn()
  } catch (error) {
    if (want !== undefined && !error.message.includes(want)) {
      throw new Error(`threw, but ${JSON.stringify(error.message)} lacks ${JSON.stringify(want)}`)
    }
    return error.message
  }
  throw new Error('expected a throw, none happened')
}

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-test-'))
const opts = (voice) => ({ text: '你好', voice, outDir, log: () => {} })

/** Records the order backends were asked for, failing exactly the named ones. */
function recorder(failFor) {
  const seen = []
  const fn = async (backend) => {
    seen.push(backend)
    if (failFor.includes(backend)) throw new Error(`${backend} 故意失败`)
    return Buffer.from(`audio-from-${backend}`)
  }
  return { seen, fn }
}

// ── 1/2. auto: fallback order depends on the voice's language ──────────────
await check('auto + 中文音色：edge 失败后回退到 baidu', async () => {
  const r = recorder(['edge'])
  __setBackendForTest(r.fn)
  const res = await synthesize('你好', opts(ZH), 'auto')
  eq(r.seen, ['edge', 'baidu'], 'attempt order:')
  eq(res.provider, 'baidu', 'winner:')
  return r.seen.join(' -> ')
})

await check('auto + 英文音色：edge 失败后回退到 google（小语种覆盖更稳）', async () => {
  const r = recorder(['edge'])
  __setBackendForTest(r.fn)
  const res = await synthesize('hello', opts(EN), 'auto')
  eq(r.seen, ['edge', 'google'], 'attempt order:')
  eq(res.provider, 'google', 'winner:')
  return r.seen.join(' -> ')
})

await check('auto + edge 成功：不回退，只试一次', async () => {
  const r = recorder([])
  __setBackendForTest(r.fn)
  const res = await synthesize('你好', opts(ZH), 'auto')
  eq(r.seen, ['edge'], 'attempt order:')
  eq(res.provider, 'edge', 'winner:')
})

// ── 3. explicit provider: no fallback (排障时行为可预期) ────────────────────
await check('显式 provider=edge + edge 失败：不回退，直接抛', async () => {
  const r = recorder(['edge'])
  __setBackendForTest(r.fn)
  const msg = await throws(() => synthesize('你好', opts(ZH), 'edge'), '语音合成全部失败')
  eq(r.seen, ['edge'], 'attempt order (must be exactly one):')
  if (!msg.includes('edge=')) throw new Error(`错误信息没带后端与原因：${msg}`)
  return msg.slice(0, 60)
})

// ── 4. every backend fails: the error must name each one and why ────────────
await check('全部后端失败：错误信息逐个列出后端与原因', async () => {
  const r = recorder(['edge', 'baidu', 'google'])
  __setBackendForTest(r.fn)
  const msg = await throws(() => synthesize('你好', opts(ZH), 'auto'), '语音合成全部失败')
  for (const b of ['edge', 'baidu', 'google']) {
    if (!msg.includes(`${b}=`)) throw new Error(`错误信息漏了 ${b}：${msg}`)
  }
  return msg.slice(0, 90)
})

// ── 5. zero-length audio is treated as failure, not written as a silent file ─
await check('后端返回 0 字节：判为失败并说明"没返回音频数据"', async () => {
  __setBackendForTest(async () => Buffer.alloc(0))
  const msg = await throws(() => synthesize('你好', opts(ZH), 'baidu'), '没有返回音频数据')
  return msg.slice(0, 60)
})

// ── 6. __setFetchForTest really swaps the HTTP fetch ───────────────────────
await check('__setFetchForTest：注入的 fetch 被 HTTP 后端真正使用（离线）', async () => {
  __setBackendForTest(null) // 用真实后端，只换 fetch
  let called = []
  __setFetchForTest(async (url, init) => {
    called.push(String(url))
    return new Response('nope', { status: 500 })
  })
  // 后端在错误信息里用的是中文显示名（百度/谷歌），不是内部 id（baidu/google）——
  // 所以这里断言"HTTP 500 是我注入的 fetch 造成的"，那才是本测试要证的事。
  const msg = await throws(() => synthesize('你好', opts(ZH), 'baidu'), 'HTTP 500')
  if (called.length === 0) throw new Error('注入的 fetch 一次都没被调用')
  return `fetch 调用 ${called.length} 次，首个 host=${new URL(called[0]).host}；${msg.slice(0, 34)}`
})

// ── 7. restoration ────────────────────────────────────────────────────────
await check('__setBackendForTest(null) 恢复真实实现（注入器不再被调用）', async () => {
  let calledAfterRestore = 0
  __setBackendForTest(async () => { calledAfterRestore += 1; return Buffer.from('x') })
  __setBackendForTest(null)
  // 真实实现会被调起来（然后因为没网/没 key 之类失败），关键点是它不再走我们那个假实现
  await synthesize('你好', opts(ZH), 'baidu').catch(() => {})
  eq(calledAfterRestore, 0, 'fake backend calls after restore:')
})

__setFetchForTest(null)
await fs.rm(outDir, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failures.length} failed`)
for (const f of failures) console.log('  - ' + f)
process.exit(failures.length === 0 ? 0 : 1)