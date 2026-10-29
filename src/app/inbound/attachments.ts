/** 入站素材：引用的那条消息、附带的图片、收到的文件。
 *
 * 这三件事都发生在"消息进来了、还没交给模型"之间，而且都是**慢 IO**（调 QQ 接口、
 * 下载、落盘）。原来它们躺在 `bridge.ts` 的文件级函数里，与流水线逻辑混在一起；
 * 搬出来之后它们各自有名字、可以被单独测，也不会让流水线读起来像一段下载脚本。
 *
 * 依赖都是端口（`QQApi` / `HttpClient` / `AgentGateway`）与一个收件箱适配器，
 * 所以这一层没有 `node:*`。
 */

import type { OneBotEvent } from '../../types.js'
import { parseInbound, type ParsedInbound } from '../../core/message/parse.js'
import { extensionOf, sniffMediaType } from '../../core/message/media.js'
import type { AgentGateway } from '../../ports/agent-gateway.js'
import type { HttpClient } from '../../ports/http.js'
import type { QQApi } from '../../ports/platform.js'
import type { BlobStore } from '../../ports/blob-store.js'

/**
 * 从消息里存下来的单个文件上限。
 *
 * 原来**没有上限**：一个大文件就能把内存吃掉（整份字节都在 Buffer 里）。
 * 30MB → 100MB（2026-10-29）：原来的 30MB 把 38MB 的技能包挡在外面，而日志里
 * 只显示 "no downloadable url"，看不出是体积问题。100MB 是"够收常见安装包与
 * 技能包、又不至于被一个文件拖垮进程"的折中。
 */
export const MAX_INBOUND_FILE_BYTES = 100 * 1024 * 1024

/**
 * 文件下载的超时（API 调用仍是 `HttpClient` 默认的 15s）。
 *
 * 2026-10-29 抓包实测：同一个私聊里 554KB 的文件秒下成功，而 23MB 的群文件
 * 在同一条链路上失败——几十 MB 走 QQ 的下载链很容易超过 15s，超时又被当成
 * "没有下载地址"，所以给文件单独放宽。
 */
const FILE_DOWNLOAD_TIMEOUT_MS = 120_000

/** 一条消息最多收几个文件（多的当没看见，免得一个人刷十几个文件把回合塞满）。 */
const MAX_FILES_PER_MESSAGE = 3

/** 这一层要的东西：三个端口 + 实时配置 + 日志。 */
export interface AttachmentDeps {
  readonly api: QQApi
  readonly http: HttpClient
  readonly gateway: AgentGateway
  /** 收件箱与本机文件（IO 全在适配器里，见 R8）。 */
  readonly blobs: BlobStore
  /** 实时读配置：看图开关与"每条最多几张"都要跟着后台改。 */
  readonly config: () => { readonly imageRecognition: { readonly enabled: boolean; readonly maxPerMessage: number } }
  readonly log: (line: string) => void
}

/** 引用上下文最多带多少字（模型只需要知道"在说哪件事"）。 */
const QUOTE_CHARS = 120

/**
 * 把被引用的那条消息拉成一行前缀（MaiBot 风格的灵活引用）。
 *
 * 拉不到就返回 null：引用是**锦上添花**，失败不该影响这一条消息本身。
 */
export async function fetchQuoted(
  deps: AttachmentDeps,
  event: OneBotEvent,
  parsed: ParsedInbound,
): Promise<string | null> {
  const { api, log } = deps
  if (parsed.replyToMessageId === null) return null
  try {
    const data = await api.getMessage(parsed.replyToMessageId) as {
      sender?: { user_id?: number; nickname?: string; card?: string }
      raw_message?: string
      message?: OneBotEvent['message']
    }
    const text = (data.raw_message
      ?? (data.message !== undefined ? parseInbound({ message: data.message } as OneBotEvent).text : '')).trim()
    const who = data.sender?.card?.trim() || data.sender?.nickname || `QQ${data.sender?.user_id ?? '?'}`
    if (text === '') {
      log?.(`quoted msg ${parsed.replyToMessageId}: fetched but empty text`)
      return null
    }
    log?.(`quoted msg ${parsed.replyToMessageId} from ${who}: ${text.slice(0, 60)}`)
    return `[引用 ${who}(${data.sender?.user_id ?? '?'}）：${text.slice(0, QUOTE_CHARS)}] `
  } catch (error) {
    log?.(`quoted msg ${parsed.replyToMessageId} fetch failed: ${String(error)}`)
    return null
  }
}

/** 下载一张图：先按消息里的地址取（带闸门），失败再问 NapCat 要本机文件。 */
async function downloadImage(deps: AttachmentDeps, url: string): Promise<Uint8Array | null> {
  if (url !== '') {
    // 消息里的图片地址 = 别人给的地址。
    const res = await deps.http.request(url, { limit: MAX_INBOUND_FILE_BYTES }).catch(() => null)
    if (res !== null && res.ok) return new Uint8Array(res.bytes)
  }
  // 兜底：让 NapCat 给出本机路径（同一台机器）。
  try {
    const data = await deps.api.getImage(url)
    if (typeof data?.file === 'string') return await deps.blobs.readLocal(data.file)
  } catch {
    // fall through
  }
  return null
}

/**
 * 把入站图片下载并**持久化**成附件，好让视觉模型原生看到它们。
 *
 * 关掉 `imageRecognition` 时直接返回空数组（不下载、不落盘）。
 */
export async function attachImages(deps: AttachmentDeps, urls: readonly string[]): Promise<unknown[]> {
  const vision = deps.config().imageRecognition
  if (!vision.enabled) return []
  const refs: unknown[] = []
  for (const url of urls.slice(0, vision.maxPerMessage)) {
    try {
      const bytes = await downloadImage(deps, url)
      if (bytes === null) continue
      const mediaType = sniffMediaType(bytes)
      const ref = await deps.gateway.saveImage({
        data: bytes,
        mediaType,
        name: `qq-image.${extensionOf(mediaType)}`,
      })
      refs.push(ref)
      deps.log(`image attached (${Math.round(bytes.length / 1024)} KB, ${mediaType})`)
    } catch (error) {
      deps.log(`image attach failed: ${String(error)}`)
    }
  }
  return refs
}

/** 文件下载的房间上下文：群文件要 group_id 才能换下载 URL。 */
export interface FileRoomContext {
  readonly groupId?: number
}

/**
 * 把消息里带的文件收进工作区收件箱，返回落盘路径（群聊与私聊都走这里）。
 *
 * 每个文件单独 try：一个坏链接不该让另外两个也收不到。
 */
export async function receiveFiles(
  deps: AttachmentDeps,
  parsed: ParsedInbound,
  nowMs: number,
  ctx: FileRoomContext = {},
): Promise<string[]> {
  if (parsed.files.length === 0) return []
  const saved: string[] = []
  for (const file of parsed.files.slice(0, MAX_FILES_PER_MESSAGE)) {
    try {
      const got = await downloadFileBytes(deps, file, ctx)
      if ('error' in got) throw new Error(got.error)
      const target = await deps.blobs.writeInbox({ name: file.name, bytes: got.bytes, nowMs })
      saved.push(target)
      deps.log(`file received: ${file.name} (${Math.round(got.bytes.length / 1024)}KB) → inbox`)
    } catch (error) {
      deps.log(`file ${file.name} download failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return saved
}

/** 下载结果的两种结局：拿到字节，或者**一条能读懂的原因**。 */
type FileBytes = { readonly bytes: Buffer } | { readonly error: string }

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 消息里的文件引用：地址、文件 id、群文件 busid（可能没有）。 */
type FileRef = { readonly url: string; readonly fileId: string; readonly busid?: number }

/**
 * 抓一个下载地址，带文件专用的体积上限与超时。
 *
 * 失败一律记进 `why` 并返回 null（由调用方决定要不要继续试下一条路）。
 * 体积超限、超时、非 2xx、SSRF 拦截都在这里分流——**以前它们全被压成
 * 一句 "no downloadable url"**，那是 2026-10-29 那次排查最大的障碍。
 */
async function fetchCapped(
  deps: AttachmentDeps,
  url: string,
  why: string[],
  allowPrivateHosts = false,
): Promise<Buffer | null> {
  try {
    const res = await deps.http.request(url, {
      limit: MAX_INBOUND_FILE_BYTES,
      timeoutMs: FILE_DOWNLOAD_TIMEOUT_MS,
      ...(allowPrivateHosts ? { allowPrivateHosts: true } : {}),
    })
    if (!res.ok) {
      why.push(`下载地址返回 HTTP ${res.status}`)
      return null
    }
    // 宁可报错，也不要把残缺文件当成功存下来。
    if (res.truncated === true) {
      why.push(`响应被截断：超过 ${MAX_INBOUND_FILE_BYTES} 字节上限`)
      return null
    }
    return Buffer.from(res.bytes)
  } catch (error) {
    why.push(`下载失败：${reasonOf(error)}`)
    return null
  }
}

/**
 * 专用 URL 接口（主路径）：群文件 `getGroupFileUrl`、私聊 `getPrivateFileUrl`。
 *
 * 日志里写的是**端口方法名**而不是 OneBot 动作名——R5 要求动作名只出现在
 * adapters/onebot 里，而排查时要看的正是"哪一步没给地址"。
 */
async function requestFileUrl(
  deps: AttachmentDeps,
  file: FileRef,
  ctx: FileRoomContext,
  why: string[],
): Promise<string | null> {
  const isGroup = ctx.groupId !== undefined
  const label = isGroup ? 'getGroupFileUrl' : 'getPrivateFileUrl'
  let via: { url?: string } | null = null
  try {
    via = isGroup
      ? await deps.api.getGroupFileUrl(ctx.groupId as number, file.fileId, file.busid)
      : await deps.api.getPrivateFileUrl(file.fileId)
  } catch (error) {
    why.push(`${label} 失败：${reasonOf(error)}`)
    return null
  }
  if (typeof via?.url === 'string' && via.url !== '') return via.url
  why.push(`${label} 没返回 url`)
  return null
}

/**
 * 最后兜底 `getFile`：本机缓存路径，或它自己给的 URL。
 *
 * 这一跳放行私网——NapCat/SnowLuma 的文件服务就可能跑在 127.0.0.1 上。
 */
async function readViaGetFile(
  deps: AttachmentDeps,
  file: FileRef,
  why: string[],
): Promise<Buffer | null> {
  try {
    const data = await deps.api.getFile(file.fileId)
    if (typeof data?.file === 'string' && !data.file.startsWith('http')) {
      const local = await deps.blobs.readLocal(data.file)
      if (local !== null) return Buffer.from(local)
      why.push('get_file 给的本机路径读不到')
      return null
    }
    if (typeof data?.file === 'string') return await fetchCapped(deps, data.file, why, true)
    if (typeof data?.url === 'string' && data.url !== '') return await fetchCapped(deps, data.url, why, true)
    why.push('get_file 没返回可下载内容')
    return null
  } catch (error) {
    why.push(`get_file 失败：${reasonOf(error)}`)
    return null
  }
}

/**
 * 一个入站文件的字节。解析顺序：
 *   1. 消息段里的地址（别人给的，过闸门）——**SnowLuma 实测这个分支能直接下**；
 *   2. 群文件 → `getGroupFileUrl`（带 busid）、私聊 → `getPrivateFileUrl`
 *      （新版语义：`getFile` 只认图片/语音缓存，文件 id 它解析不了）；
 *   3. 最后兜底 `getFile`（兼容还认文件 id 的旧实现）。
 *
 * 失败时返回**一条能读懂的原因**；以前返回 null，调用方统一报 "no downloadable
 * url"，看不出到底是哪一种（见 docs/deployment.md §14）。
 */
async function downloadFileBytes(
  deps: AttachmentDeps,
  file: FileRef,
  ctx: FileRoomContext = {},
): Promise<FileBytes> {
  const why: string[] = []
  if (file.url !== '') {
    const bytes = await fetchCapped(deps, file.url, why)
    if (bytes !== null) return { bytes }
  } else {
    why.push('消息段没有 url')
  }
  if (file.fileId === '') {
    why.push('消息段没有 file_id')
    return { error: why.join('；') }
  }
  const viaUrl = await requestFileUrl(deps, file, ctx, why)
  if (viaUrl !== null) {
    const bytes = await fetchCapped(deps, viaUrl, why)
    if (bytes !== null) return { bytes }
  }
  const viaGetFile = await readViaGetFile(deps, file, why)
  if (viaGetFile !== null) return { bytes: viaGetFile }
  return { error: why.join('；') }
}
