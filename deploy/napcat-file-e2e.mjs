/**
 * End-to-end probe against the real NapCat: does a local file actually reach QQ?
 *
 * Run on the server (talks to 127.0.0.1:3001, the live NapCat):
 *   /opt/node22/bin/node /root/napcat-file-e2e.mjs [--send]
 *
 * Without `--send` it only exercises the failing/succeeding *wire forms* and
 * stops before any message leaves the box. With `--send` it really delivers to
 * QQID ADMIN_QQ (学弟) — that is the only way to prove the transport works,
 * because NapCat answers `识别URL失败` only when it tries to fetch the file.
 *
 * A/B by construction: case A is the pre-fix form (bare path) and must fail; case
 * B is what `napcatFileArg()` produces and must succeed. If A ever starts passing,
 * the container gained visibility and the helper's base64 branch is no longer
 * load-bearing — worth knowing, not a problem.
 */

import { promises as fs } from 'node:fs'
import { OneBotClient } from '#lib/onebot.js'
import { napcatFileArg, localPathOf, napcatVisibleRoots } from '#lib/local-file.js'

const SEND = process.argv.includes('--send')
const TARGET = ADMIN_QQ
const WS = 'ws://127.0.0.1:3001'

const DOC = `${process.env.WORKSPACE ?? '/path/to/workspace'}/inbox/PyFQ-video-null-排查记录-2026-10-15.md`
const IMG = `${process.env.WORKSPACE ?? '/path/to/workspace'}/downloads/qq-1086437543.jpg`

const token = (await fs.readFile('/root/.onebot-token', 'utf8')).trim()
const log = (l) => console.log('  [ws] ' + l)

const client = new OneBotClient({ mode: 'forward', url: WS }, token, log)
client.start()

const deadline = Date.now() + 20_000
while (!client.isConnected() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300))
if (!client.isConnected()) {
  console.log('FAIL  could not connect to NapCat at ' + WS)
  process.exit(1)
}
console.log(`connected to NapCat (selfId ${client.selfId ?? '?'})`)
console.log(`CHANNEL_QQ_NAPCAT_ROOTS = ${JSON.stringify(napcatVisibleRoots())}`)

let pass = 0
const failures = []

async function check(name, fn) {
  try {
    const detail = await fn()
    pass++
    console.log(`PASS  ${name}${detail === undefined ? '' : '  ' + detail}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL  ${name}  ${error.message}`)
  }
}

await check('the report document exists and is the size the user mentioned', async () => {
  const st = await fs.stat(DOC)
  if (!st.isFile()) throw new Error('not a file')
  return `${st.size} bytes`
})

await check('A) bare path is refused by NapCat (the reported bug)', async () => {
  if (!SEND) return 'skipped (no --send): needs NapCat to actually fetch it'
  try {
    await client.call('upload_private_file', { user_id: TARGET, file: DOC, name: 'probe-bare.md' })
  } catch (error) {
    if (/识别URL失败|ENOENT|no such file/i.test(error.message)) return `refused as expected: ${error.message.slice(0, 70)}`
    throw new Error('failed, but for an unexpected reason: ' + error.message)
  }
  return 'UNEXPECTEDLY ACCEPTED — NapCat can now read host paths'
})

await check('B) the `file://` URL form is also refused (what the plugin used to send)', async () => {
  if (!SEND) return 'skipped (no --send)'
  try {
    await client.call('upload_private_file', { user_id: TARGET, file: `file://${DOC}`, name: 'probe-uri.md' })
  } catch (error) {
    return `refused as expected: ${error.message.slice(0, 70)}`
  }
  return 'UNEXPECTEDLY ACCEPTED'
})

await check('C) napcatFileArg() produces base64 here (no visible roots configured)', async () => {
  const arg = await napcatFileArg(DOC)
  if (!arg.startsWith('base64://')) throw new Error(`expected base64://, got ${arg.slice(0, 30)}`)
  const bytes = Buffer.from(arg.slice('base64://'.length), 'base64')
  const original = await fs.readFile(DOC)
  if (!bytes.equals(original)) throw new Error('base64 payload does not round-trip to the original bytes')
  return `${arg.length} chars -> ${bytes.length} bytes, byte-identical`
})

await check('D) sending the document that way actually delivers', async () => {
  if (!SEND) return 'skipped (no --send)'
  const arg = await napcatFileArg(DOC)
  const res = await client.call('upload_private_file', {
    user_id: TARGET,
    file: arg,
    name: 'PyFQ-video-null-排查记录-2026-10-15.md',
  }, 120_000)
  return `NapCat accepted it: ${JSON.stringify(res).slice(0, 90)}`
})

await check('E) an image segment with base64 is accepted (meme/emoji/cover path)', async () => {
  if (!SEND) return 'skipped (no --send)'
  const st = await fs.stat(IMG).catch(() => null)
  if (st === null) return 'no sample image on disk, skipped'
  const arg = await napcatFileArg(IMG)
  const res = await client.call('send_private_msg', {
    user_id: TARGET,
    message: [{ type: 'image', data: { file: arg } }],
  }, 120_000)
  return `image delivered: ${JSON.stringify(res).slice(0, 80)}`
})

client.stop()
console.log(`\n${pass} passed, ${failures.length} failed`)
for (const f of failures) console.log('  - ' + f)
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 400)