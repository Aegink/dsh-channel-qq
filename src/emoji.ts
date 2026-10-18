/** Sticker (emoji) store: steal images from the primary group, auto-attach on replies.
 *
 * Deliberately a lite port: the OpenClaw extension's VLM intensity scoring is
 * not carried over; stealing is keyword-free and sending is probability-based.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { resolveDshHome } from './paths.js'
import { napcatFileArg } from './local-file.js'
import { randomUUID } from 'node:crypto'
import type { EmojiConfig } from './config.js'
import type { QQApi } from './ports/platform.js'
import type { OneBotMessageSegment } from './types.js'
import type { HttpClient } from './ports/http.js'
import { systemHttp } from './adapters/http/client.js'
import type { OneBotEvent } from './types.js'
import { parseInbound } from './core/message/parse.js'
import type { EmojiLibrary, EmojiIndexEntry } from './emoji-library.js'
import { atomicWriteFile } from './adapters/fs-store/atomic.js'

/** 偷一张表情包的体积上限。 */
const MAX_STICKER_BYTES = 8 * 1024 * 1024

export class EmojiStore {
  constructor(
    private readonly config: EmojiConfig,
    private readonly api: QQApi,
    private readonly log: (line: string) => void,
    private readonly library?: EmojiLibrary,
    private readonly http: HttpClient = systemHttp,
  ) {}

  /**
   * Sticker directories, resolved from config on every access.
   *
   * Getters rather than constructor fields so `emoji.dir` / `emoji.registeredDir`
   * are editable live in the admin panel — a cached path would keep stealing
   * into the old directory until the plugin restarted.
   */
  private get dir(): string {
    return this.config.dir ?? path.join(resolveDshHome(), 'channel-qq', 'emoji')
  }

  private get registeredDir(): string {
    return this.config.registeredDir ?? path.join(this.dir, '..', 'emoji-registered')
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.mkdir(this.registeredDir, { recursive: true })
  }

  /** Steal the first image of a primary-group message into the raw sticker dir. */
  async steal(event: OneBotEvent): Promise<EmojiIndexEntry | null> {
    const parsed = parseInbound(event)
    const url = parsed.imageUrls[0]
    if (url === undefined) return null
    try {
      // The directory may be brand new (the panel can repoint `emoji.dir`).
      await fs.mkdir(this.dir, { recursive: true })
      const ext = path.extname(new URL(url).pathname).replace(/[^.\w]/g, '') || '.png'
      const target = path.join(this.dir, `stolen_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`)
      // 消息里的图片地址 = 别人给的地址，必须过闸门。
      const res = await this.http.request(url, { limit: MAX_STICKER_BYTES })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(res.bytes)
      await atomicWriteFile(target, buf)
      this.log(`stole sticker → ${path.basename(target)}`)
      if (this.library !== undefined) {
        const entry = await this.library.addFile(target, 'stolen')
        if (entry === null) {
          this.log('duplicate sticker (md5 known), not indexed again')
          return null
        }
        return entry
      }
      return null
    } catch (error) {
      this.log(`sticker steal failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

}
