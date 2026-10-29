/** 文件接收链路的测试（2026-10-25 修复：SnowLuma 新版 get_file 不再解析文件 id；
 *  2026-10-29 增补：真实失败原因、截断保护、下载超时、群文件 busid）。
 *
 * 不能少的性质：
 *   1. **群文件走 `get_group_file_url`、私聊走 `get_private_file_url`**——
 *      SnowLuma 明确说 get_file 只认图片/语音缓存（NapCat 同语义）；
 *   2. **专用接口失败回退 get_file**：不让一个坏接口把文件弄丢；
 *   3. **CQ 码来源的文件段字段名是 `id`**（JSON 段是 file_id），两个都认；
 *   4. **失败必须是可读的原因**，不能一律 "no downloadable url"——2026-10-29 那次
 *      排查就是因为这句话把"超体积""超时""接口没给 url"全盖住了；
 *   5. **截断的响应不许落盘**（分块传输没有 content-length 时，闸门会静默截断）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { receiveFiles } = await import('../src/app/inbound/attachments.js')
const { parseInbound } = await import('../src/core/message/parse.js')

/** 最小 AttachmentDeps 替身：只实现 receiveFiles 触碰到的面。 */
function fakeDeps(opts: {
  groupUrl?: { url?: string } | Error
  privateUrl?: { url?: string } | Error
  getFile?: { file?: string; url?: string } | Error
  bytes?: Uint8Array
  failHttpRequest?: boolean
  httpStatus?: number
  truncated?: boolean
} = {}) {
  const calls: string[] = []
  const logs: string[] = []
  const seen: { busid?: number; timeouts: Array<number | undefined> } = { timeouts: [] }
  const bytes = opts.bytes ?? new Uint8Array([1, 2, 3])
  const deps = {
    api: {
      getFile: async () => {
        calls.push('get_file')
        if (opts.getFile instanceof Error) throw opts.getFile
        return opts.getFile ?? {}
      },
      getGroupFileUrl: async (_groupId: number, _fileId: string, busid?: number) => {
        calls.push('get_group_file_url')
        seen.busid = busid
        if (opts.groupUrl instanceof Error) throw opts.groupUrl
        return opts.groupUrl ?? {}
      },
      getPrivateFileUrl: async () => {
        calls.push('get_private_file_url')
        if (opts.privateUrl instanceof Error) throw opts.privateUrl
        return opts.privateUrl ?? {}
      },
    },
    http: {
      request: async (_url: string, options: { timeoutMs?: number } = {}) => {
        calls.push('http')
        seen.timeouts.push(options.timeoutMs)
        if (opts.failHttpRequest === true) throw new Error('network down')
        const status = opts.httpStatus ?? 200
        return {
          ok: status < 400,
          status,
          truncated: opts.truncated === true,
          bytes,
          text: () => '',
          json: () => ({}),
        }
      },
    },
    gateway: {},
    blobs: {
      writeInbox: async (input: { name: string }) => {
        calls.push(`inbox:${input.name}`)
        return `inbox/${input.name}`
      },
      readLocal: async () => Buffer.from(bytes),
    },
    config: () => ({ imageRecognition: { enabled: false, maxPerMessage: 4 } }),
    log: (line: string) => { logs.push(line) },
  }
  return { deps: deps as never, calls, logs, seen }
}

const FILE = { name: 'demo-1.0.0.apk', url: '', fileId: '/deadbeef-0000-4000-8000-000000000001' }
const GROUP = 2000000005

test('群文件：专用 URL 接口命中后下载落收件箱（修复主路径）', async () => {
  const h = fakeDeps({ groupUrl: { url: 'https://njc-download.ftn.qq.com/ftn_handler/xxx/' } })
  const saved = await receiveFiles(h.deps, { files: [FILE] } as never, 0, { groupId: GROUP })
  assert.deepEqual(saved, [`inbox/${FILE.name}`])
  assert.ok(h.calls.includes('get_group_file_url'), '走群文件 URL 接口')
  assert.ok(!h.calls.includes('get_file'), '主路径命中就不再兜底')
})

test('私聊文件：走 get_private_file_url', async () => {
  const h = fakeDeps({ privateUrl: { url: 'https://ftn.qq.com/x' } })
  const saved = await receiveFiles(h.deps, { files: [FILE] } as never, 0, {})
  assert.equal(saved.length, 1)
  assert.ok(h.calls.includes('get_private_file_url'))
  assert.ok(!h.calls.includes('get_group_file_url'), '私聊不调群接口')
})

test('专用接口失败回退 get_file（兼容还认文件 id 的旧实现）', async () => {
  const h = fakeDeps({ groupUrl: new Error('接口坏了'), getFile: { file: '/tmp/cached.apk' } })
  const saved = await receiveFiles(h.deps, { files: [FILE] } as never, 0, { groupId: GROUP })
  assert.equal(saved.length, 1, '兜底接住了')
  assert.ok(h.calls.includes('get_group_file_url') && h.calls.includes('get_file'))
})

test('两条路都失败：不落盘、不抛穿，且日志写明真实原因（不再是 no downloadable url）', async () => {
  const h = fakeDeps({ groupUrl: new Error('文件 file_id 错误'), getFile: new Error('不支持') })
  const saved = await receiveFiles(h.deps, { files: [FILE] } as never, 0, { groupId: GROUP })
  assert.deepEqual(saved, [])
  const failed = h.logs.find((line) => line.includes('download failed')) ?? ''
  assert.ok(failed.includes('getGroupFileUrl 失败：文件 file_id 错误'), `原因要可读，实际：${failed}`)
  assert.ok(failed.includes('get_file 失败：不支持'), `兜底原因也要带上，实际：${failed}`)
  assert.ok(!failed.includes('no downloadable url'), '旧兜底文案必须消失')
})

test('解析：CQ 码来源的字段名是 id，JSON 段是 file_id，两个都认', () => {
  const cq = parseInbound({
    message: [
      { type: 'file', data: { file: 'a.zip', id: '/aaa-bbb' } },
    ],
  } as never)
  assert.equal(cq.files[0]!.fileId, '/aaa-bbb', 'CQ 字段名 id')
  assert.equal(cq.files[0]!.name, 'a.zip')

  const json = parseInbound({
    message: [
      { type: 'file', data: { file: 'b.zip', file_id: '/ccc-ddd' } },
    ],
  } as never)
  assert.equal(json.files[0]!.fileId, '/ccc-ddd', 'JSON 字段名 file_id')
})

test('解析：保留 busid（群文件管理器靠它定位），没有就不带这个字段', () => {
  const withBusid = parseInbound({
    message: [{ type: 'file', data: { file: 'c.zip', file_id: '/eee', busid: 102 } }],
  } as never)
  assert.equal(withBusid.files[0]!.busid, 102)

  const asString = parseInbound({
    message: [{ type: 'file', data: { file: 'c.zip', file_id: '/eee', busid: '102' } }],
  } as never)
  assert.equal(asString.files[0]!.busid, 102, '字符串形态也认')

  const without = parseInbound({
    message: [{ type: 'file', data: { file: 'c.zip', file_id: '/eee' } }],
  } as never)
  assert.equal(without.files[0]!.busid, undefined)
})

test('群文件把 busid 传给 get_group_file_url', async () => {
  const h = fakeDeps({ groupUrl: { url: 'https://ftn.qq.com/x' } })
  await receiveFiles(h.deps, { files: [{ ...FILE, busid: 102 }] } as never, 0, { groupId: GROUP })
  assert.equal(h.seen.busid, 102)
})

test('消息段自带 url 时直接下载，不问任何文件接口', async () => {
  const h = fakeDeps({})
  const saved = await receiveFiles(
    h.deps,
    { files: [{ name: 'x.txt', url: 'http://43.129.138.119:80/asn.com/qqdownloadftnv5?ver=2', fileId: '/fid' }] } as never,
    0,
    {},
  )
  assert.equal(saved.length, 1)
  assert.ok(!h.calls.includes('get_private_file_url'), '有 url 就不该再问接口')
  assert.ok(!h.calls.includes('get_file'))
})

test('响应被截断时不落盘（宁可失败也不存坏文件）', async () => {
  const h = fakeDeps({ truncated: true })
  const saved = await receiveFiles(
    h.deps,
    { files: [{ name: 'big.bin', url: 'http://example.com/big.bin', fileId: '/fid' }] } as never,
    0,
    {},
  )
  assert.deepEqual(saved, [])
  const failed = h.logs.find((line) => line.includes('download failed')) ?? ''
  assert.ok(failed.includes('截断'), `要说明是截断，实际：${failed}`)
  assert.ok(!h.logs.some((line) => line.includes('file received')), '不能记成收到')
})

test('HTTP 非 2xx 要写明状态码', async () => {
  const h = fakeDeps({ httpStatus: 403 })
  const saved = await receiveFiles(
    h.deps,
    { files: [{ name: 'y.bin', url: 'http://example.com/y.bin', fileId: '/fid' }] } as never,
    0,
    {},
  )
  assert.deepEqual(saved, [])
  const failed = h.logs.find((line) => line.includes('download failed')) ?? ''
  assert.ok(failed.includes('403'), `要带状态码，实际：${failed}`)
})

test('文件下载用放宽的超时，而不是 HttpClient 的 15s 默认值', async () => {
  const h = fakeDeps({})
  await receiveFiles(
    h.deps,
    { files: [{ name: 'z.bin', url: 'http://example.com/z.bin', fileId: '/fid' }] } as never,
    0,
    {},
  )
  assert.ok(h.seen.timeouts.length > 0, '必须走到下载')
  assert.ok(h.seen.timeouts.every((t) => typeof t === 'number' && t >= 120_000), `实际：${h.seen.timeouts.join(',')}`)
})
