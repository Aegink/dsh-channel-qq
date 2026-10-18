/** Outbound message log: what the bot herself sent, persisted per conversation.
 *
 * Injected into every context packet so she always remembers her own recent
 * messages and what they quoted — even across session resets, which is where
 * quote chains used to break ("这句不是我发的").
 */

import * as path from 'node:path'
import { JsonStore } from './adapters/fs-store/json-store.js'

export interface SentEntry {
  /** Real QQ message id of the sent message (from OneBot response when available). */
  messageId: number | null
  /** The message this one quoted, if sent via qq_reply_quote. */
  quotedId: number | null
  text: string
  time: number
}

const MAX_ENTRIES = 50

export class SentLog {
  private readonly store: JsonStore<unknown>
  private entries: SentEntry[] = []

  constructor(dshHome: string, private readonly key: string, private readonly log: (line: string) => void) {
    this.store = new JsonStore<unknown>(
      path.join(dshHome, 'channel-qq', `sent-${key}.json`),
      { log },
    )
  }

  async load(): Promise<void> {
    // 历史文件是裸数组；`JsonStore` 只管"读得到/读不到 + 写原子"，
    // 形状是不是数组仍由这里判断——迁移不改文件形状。
    const raw = await this.store.load(null)
    this.entries = Array.isArray(raw) ? (raw as SentEntry[]) : []
  }

  async add(entry: SentEntry): Promise<void> {
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES)
    try {
      await this.store.save(this.entries)
    } catch (error) {
      this.log(`sent-log write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Rendered block for the context packet; empty string when nothing sent. */
  render(): string {
    if (this.entries.length === 0) return ''
    const lines = this.entries.slice(-12).map((e) => {
      const quoted = e.quotedId !== null ? `（引用#${e.quotedId}）` : ''
      const id = e.messageId !== null ? `#${e.messageId}` : '#?'
      const time = new Date(e.time)
      const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
      return `${hhmm} 咱发的 ${id}${quoted}：${e.text.slice(0, 80)}`
    })
    return `【咱最近在群里发过的消息（这就是引用链的源头，别再说不是咱发的）】\n${lines.join('\n')}`
  }
}
