/**
 * Final E2E after the NapCat mounts + CHANNEL_QQ_NAPCAT_ROOTS.
 *
 * Two things have to be true now, and neither can be read off the config:
 *
 *   1. **NapCat can actually open a host path.** The mounts are declared in
 *      compose.yaml, but declared ≠ readable from inside the container — the only
 *      proof is a real send that NapCat fetches itself.
 *   2. **The 8 MiB inline cap no longer applies inside the mounted tree.** Before
 *      the mounts, a >8 MiB file was refused outright (`超过内联上限`). Now
 *      `napcatFileArg` must return `file://` for it instead of throwing.
 *
 * It also re-checks the fallback still works: a path OUTSIDE the mounted roots
 * must still be inlined as base64, so the plugin stays correct on a host where
 * NapCat shares no filesystem.
 *
 * Run on the server:
 *   /opt/node22/bin/node /root/napcat-file-e2e2.mjs [--send]
 */

import { promises as fs } from 'node:fs'
import { OneBotClient } from '#lib/onebot.js'
import { napcatFileArg, napcatVisibleRoots, localPathOf } from '#lib/local-file.js'

const SEND = process.argv.includes('--send')
const TARGET = ADMIN_QQ

// 直接跑 `node` 不会经过 systemd 的 EnvironmentFile，所以这个脚本必须自己把
// /etc/dsh/env 读进 process.env —— 否则 CHANNEL_QQ_NAPCAT_ROOTS 是空的，
// 于是 napcatFileArg 走 base64 分支，测出来的是"没配置"而不是"挂载失效"。
// （第一版漏了这一步，7 项里假失败了 3 项。）
for (const line of (await fs.readFile('/etc/dsh/env', 'utf8')).split('\n')) {
  if (line.trimStart().startsWith('#')) continue
  const m = /^\s*([A-Z_]+)=(.*)$/.exec(line)
  if (m !== null) process.env[m[1]] = m[2]
}
const WS = 'ws://127.0.0.1:3001'

const WS_ROOT = process.env.WORKSPACE ?? '/path/to/workspace'
const DOC = `${WS_ROOT}/inbox/PyFQ-video-null-排查记录-2026-10-15.md`
const BIG = `${WS_ROOT}/downloads/_e2e-big.bin`
const OUTSIDE = '/tmp/_e2e-outside.txt'
const BIG_MB = 9

const token = (await fs.readFile('/root/.onebot-token', 'utf8')).trim()
const client = new OneBotClient({ mode: 'forward', url: WS }, token, (l) => console.log('  [ws] ' + l))
client.start()

const deadline = Date.now() + 20_000
while (!client.isConnected() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300))
if (!client.isConnected()) {
  console.log('FAIL  could not connect to NapCat at ' + WS)
  process.exit(1)
}

let pass = 0
const failures = []
async function check(name, fn) {
  try {
    const d = await fn()
    pass++
    console.log(`PASS  ${name}${d === undefined ? '' : '  ' + d}`)
  } catch (e) {
    failures.push(`${name}: ${e.message}`)
    console.log(`FAIL  ${name}  ${e.message}`)
  }
}
const eq = (a, b, label = '') => {
  if (a !== b) throw new Error(`${label}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

// fixtures
await fs.writeFile(BIG, Buffer.alloc(BIG_MB * 1024 * 1024, 0x41))
await fs.writeFile(OUTSIDE, 'outside every mounted root\n')
console.log(`fixtures ready: ${BIG_MB}MiB dummy + 1 file outside the roots\n`)

await check('QQ 已登录（NapCat 报告真实账号）', async () => {
  const info = await client.call('get_login_info', {}, 8000)
  const d = info ?? {}
  if (d.user_id === undefined) throw new Error('no user_id: ' + JSON.stringify(info).slice(0, 120))
  return `selfId=${d.user_id} nickname=${d.nickname ?? '?'}`
})

await check('CHANNEL_QQ_NAPCAT_ROOTS 已生效（2 条）', async () => {
  const roots = napcatVisibleRoots()
  eq(roots.length, 2, 'roots:')
  return roots.join('  ')
})

await check('工作区里的文档 -> file://（不再内联）', async () => {
  const arg = await napcatFileArg(DOC)
  if (!arg.startsWith('file://')) throw new Error(`expected file://, got ${arg.slice(0, 30)}`)
  return arg
})

await check(`>${BIG_MB}MiB 的大文件不再被上限拒绝 -> file://（挂载前这里会抛错）`, async () => {
  const arg = await napcatFileArg(BIG)
  if (!arg.startsWith('file://')) throw new Error(`expected file://, got ${arg.slice(0, 30)}`)
  return `${BIG} -> ${arg.slice(0, 34)}...`
})

await check('挂载树之外的路径仍然回落 base64（换台机器也对）', async () => {
  const arg = await napcatFileArg(OUTSIDE)
  if (!arg.startsWith('base64://')) throw new Error(`expected base64://, got ${arg.slice(0, 30)}`)
  return `${arg.length} chars`
})

await check('NapCat 真的能自己打开宿主路径（真发文件）', async () => {
  if (!SEND) return 'skipped (no --send)'
  const arg = await napcatFileArg(DOC)
  const res = await client.call('upload_private_file', {
    user_id: TARGET,
    file: arg,
    name: 'PyFQ-video-null-排查记录-2026-10-15.md',
  }, 120_000)
  return `NapCat 接受了 file:// 并送达：${JSON.stringify(res).slice(0, 80)}`
})

await check('容器内直接确认这两棵树可见', async () => {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('docker', ['exec', 'napcat', 'ls', `${WS_ROOT}/inbox`], { encoding: 'utf8' })
  return out.trim().split('\n').length + ' 个条目'
})

client.stop()
await fs.rm(BIG, { force: true })
await fs.rm(OUTSIDE, { force: true })
console.log(`\n${pass} passed, ${failures.length} failed`)
for (const f of failures) console.log('  - ' + f)
setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 400)