/**
 * Regression test: handing a local file to NapCat.
 *
 * Reported bug (2026-10-15, by the user): "直接发本地文件那条路是坏的". Every local
 * file send produced
 *
 *   Error: QQ API failed: 识别URL失败, uri= /path/to/workspace/inbox/x.md
 *   Error: ENOENT: no such file or directory, access 'file:///srv/dsh/...'
 *
 * because the plugin handed NapCat a *path* (or a `file://` URL) while NapCat runs
 * in a container that cannot see `/srv/dsh`. `napcatFileArg()` is now the single
 * place that decides the wire form, so this test pins both branches plus the
 * guards around them.
 *
 * Run on the server against the compiled output:
 *   /opt/node22/bin/node /root/local-file-test.mjs
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { napcatFileArg, localPathOf, napcatVisibleRoots, DEFAULT_MAX_INLINE_BYTES } from '#lib/local-file.js'

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

function eq(actual, expected, label = '') {
  if (actual !== expected) throw new Error(`${label}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function throws(fn, want) {
  try {
    await fn()
  } catch (error) {
    if (want !== undefined && !error.message.includes(want)) {
      throw new Error(`threw, but message ${JSON.stringify(error.message)} lacks ${JSON.stringify(want)}`)
    }
    return error.message
  }
  throw new Error('expected a throw, none happened')
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'localfile-test-'))
const visibleDir = path.join(tmp, 'visible')
await fs.mkdir(visibleDir, { recursive: true })
const visibleFile = path.join(visibleDir, 'in-visible.txt')
await fs.writeFile(visibleFile, 'inside the mounted root\n')

const hiddenDir = path.join(tmp, 'hidden')
await fs.mkdir(hiddenDir, { recursive: true })
const hiddenFile = path.join(hiddenDir, 'in-hidden.txt')
await fs.writeFile(hiddenFile, 'outside every mounted root\n')

const bigFile = path.join(hiddenDir, 'big.bin')
await fs.writeFile(bigFile, Buffer.alloc(64, 7))

// A sibling whose name merely *starts with* the root's name: prefix matching that
// forgets the separator would treat it as inside the root.
const siblingDir = `${visibleDir}X`
await fs.mkdir(siblingDir, { recursive: true })
const siblingFile = path.join(siblingDir, 'sibling.txt')
await fs.writeFile(siblingFile, 'sibling\n')

const originalRoots = process.env.CHANNEL_QQ_NAPCAT_ROOTS

// ── localPathOf: normalising what the caller passed ──────────────────────────
await check('bare absolute path is kept', async () => {
  eq(localPathOf('/srv/dsh/a.png'), path.resolve('/srv/dsh/a.png'))
})

await check('file:// URL resolves to a local path (this was the ENOENT)', async () => {
  eq(localPathOf('file:///srv/dsh/a.png'), path.resolve('/srv/dsh/a.png'))
})

await check('percent-encoded file:// URL is decoded', async () => {
  eq(localPathOf('file:///srv/dsh/a%20b.png'), path.resolve('/srv/dsh/a b.png'))
})

await check('http(s) URL passes through untouched', async () => {
  eq(localPathOf('https://example.com/a.png'), 'https://example.com/a.png')
})

await check('base64:// URL passes through untouched', async () => {
  eq(localPathOf('base64://AAAA'), 'base64://AAAA')
})

await check('surrounding whitespace is trimmed', async () => {
  eq(localPathOf('  /srv/dsh/a.png\n'), path.resolve('/srv/dsh/a.png'))
})

await check('empty input is rejected', async () => {
  const msg = await throws(() => localPathOf('   '), '不能为空')
  return msg
})

// ── no visible roots: everything must be inlined ────────────────────────────
delete process.env.CHANNEL_QQ_NAPCAT_ROOTS
await check('with no roots configured, a small file is inlined as base64', async () => {
  eq(napcatVisibleRoots().length, 0, 'roots:')
  const arg = await napcatFileArg(hiddenFile)
  if (!arg.startsWith('base64://')) throw new Error(`expected base64://, got ${arg.slice(0, 40)}`)
  const decoded = Buffer.from(arg.slice('base64://'.length), 'base64').toString('utf8')
  eq(decoded, 'outside every mounted root\n', 'round-trip:')
  return `${arg.length} chars on the wire for ${decoded.length} bytes of text`
})

await check('the `file://` form from the model is accepted and inlined', async () => {
  const arg = await napcatFileArg(`file://${hiddenFile}`)
  if (!arg.startsWith('base64://')) throw new Error(`expected base64://, got ${arg.slice(0, 40)}`)
})

await check('an http URL is passed straight through (not stat-ed, not inlined)', async () => {
  eq(await napcatFileArg('https://example.com/x.png'), 'https://example.com/x.png')
})

await check('a base64 URL is passed straight through', async () => {
  eq(await napcatFileArg('base64://QUJD'), 'base64://QUJD')
})

await check('a missing file reports ENOENT with the real path', async () => {
  const msg = await throws(() => napcatFileArg(path.join(hiddenDir, 'nope.txt')), 'ENOENT')
  return msg.slice(0, 70)
})

await check('a directory is rejected as "not a file"', async () => {
  const msg = await throws(() => napcatFileArg(hiddenDir), '不是文件')
  return msg
})

await check('over the inline cap with no visible root names BOTH remedies', async () => {
  const msg = await throws(() => napcatFileArg(bigFile, { maxInlineBytes: 16 }), '超过内联上限')
  if (!msg.includes('挂进 NapCat 容器')) throw new Error('message does not mention mounting')
  return msg.slice(0, 90)
})

await check('exactly at the cap still inlines (boundary)', async () => {
  const arg = await napcatFileArg(bigFile, { maxInlineBytes: 64 })
  if (!arg.startsWith('base64://')) throw new Error('expected base64:// at the exact cap')
})

await check('one byte over the cap throws (boundary)', async () => {
  await throws(() => napcatFileArg(bigFile, { maxInlineBytes: 63 }), '超过内联上限')
})

await check('the default cap is 8 MiB', async () => {
  eq(DEFAULT_MAX_INLINE_BYTES, 8 * 1024 * 1024)
})

// ── with a visible root: the path form is used again ────────────────────────
process.env.CHANNEL_QQ_NAPCAT_ROOTS = visibleDir
await check('a file under a configured root uses file://', async () => {
  eq(napcatVisibleRoots().length, 1, 'roots:')
  const arg = await napcatFileArg(visibleFile)
  eq(arg, `file://${visibleFile.split(path.sep).join('/')}`)
})

await check('a large file under a configured root is NOT size-capped', async () => {
  const arg = await napcatFileArg(visibleFile, { maxInlineBytes: 1 })
  if (!arg.startsWith('file://')) throw new Error(`expected file://, got ${arg.slice(0, 40)}`)
})

await check('a sibling prefix (root + "X") is NOT treated as inside the root', async () => {
  const arg = await napcatFileArg(siblingFile)
  if (!arg.startsWith('base64://')) {
    throw new Error(`prefix confusion: ${siblingDir} was accepted as under ${visibleDir}`)
  }
})

await check('multiple roots, separated by a colon, are all honoured', async () => {
  process.env.CHANNEL_QQ_NAPCAT_ROOTS = `${hiddenDir}:${visibleDir}`
  eq(napcatVisibleRoots().length, 2, 'roots:')
  if (!(await napcatFileArg(hiddenFile)).startsWith('file://')) throw new Error('first root ignored')
  if (!(await napcatFileArg(visibleFile)).startsWith('file://')) throw new Error('second root ignored')
})

await check('a trailing separator on a root does not break matching', async () => {
  process.env.CHANNEL_QQ_NAPCAT_ROOTS = `${visibleDir}${path.sep}`
  if (!(await napcatFileArg(visibleFile)).startsWith('file://')) throw new Error('root with trailing sep not matched')
})

// restore
if (originalRoots === undefined) delete process.env.CHANNEL_QQ_NAPCAT_ROOTS
else process.env.CHANNEL_QQ_NAPCAT_ROOTS = originalRoots
await fs.rm(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}