/** 提醒的存储：一个 JSON 文件（路径见 ReminderStore 构造函数），读写容错照
 * sent-log 的范式：读失败 → 空数组并重建文件，绝不抛。
 *
 * P4 搬迁注记：逻辑与路径解析（file 为 null / 相对 / 绝对三种）逐字来自
 * `src/reminders.ts`——落盘字节与形状被 `test/store-migration.test.ts` 钉住，
 * 一个字节都不许动。
 */

import * as path from 'node:path'
import type { ReminderConfig } from '../../config.js'
import { shortId } from '../../adapters/dsh-host/tools.js'
import { JsonStore } from '../../adapters/fs-store/json-store.js'
import { DAY_MS, WEEK_MS } from './parse-when.js'

export interface Reminder {
  id: string
  text: string
  at: number
  room: 'group' | 'dm'
  target: number
  createdBy: number
  created: number
  fired: boolean
  firedAt: number | null
  repeat: 'none' | 'daily' | 'weekly'
}

export type Repeat = 'none' | 'daily' | 'weekly'

/** 逐字段洗数据：磁盘上可能是手改过的、旧版本的、半截写入的 JSON。 */
function normalizeReminder(value: unknown, index: number): Reminder | null {
  if (value === null || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  const at = Number(raw.at ?? 0)
  if (text === '' || !Number.isFinite(at) || at <= 0) return null
  const repeat = raw.repeat === 'daily' || raw.repeat === 'weekly' ? raw.repeat : 'none'
  const created = Number(raw.created ?? 0)
  const firedAt = Number(raw.firedAt ?? 0)
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `r_recovered_${String(index)}`,
    text,
    at,
    room: raw.room === 'dm' ? 'dm' : 'group',
    target: Number(raw.target ?? 0),
    createdBy: Number(raw.createdBy ?? 0),
    created: Number.isFinite(created) ? created : Date.now(),
    fired: raw.fired === true,
    firedAt: typeof raw.firedAt === 'number' && Number.isFinite(firedAt) ? firedAt : null,
    repeat,
  }
}

export class ReminderStore {
  private readonly file: string
  private readonly store: JsonStore<unknown>
  private readonly log: (line: string) => void
  private items: Reminder[] = []

  constructor(config: ReminderConfig, opts: { workspacePath: string | null; dshHome: string; log: (l: string) => void }) {
    this.log = opts.log
    const base = opts.workspacePath ?? path.join(opts.dshHome, 'channel-qq')
    // file 可能是相对路径（"reminders.json"），一律相对 workspace 解析。
    const configured = config.file
    this.file = configured === null || configured === undefined
      ? path.join(base, 'reminders.json')
      : (path.isAbsolute(configured) ? configured : path.join(base, configured))
    this.store = new JsonStore<unknown>(this.file, { log: opts.log })
  }

  async load(): Promise<void> {
    const raw = await this.store.load(null)
    // 兼容历史两种形状（裸数组 / { version, reminders }）；洗数据照样逐字段来，
    // 磁盘上的东西不可信，坏一条不能带崩整库。
    try {
      const list: unknown[] = Array.isArray(raw)
        ? raw
        : (raw !== null && typeof raw === 'object' && Array.isArray((raw as { reminders?: unknown }).reminders)
          ? (raw as { reminders: unknown[] }).reminders
          : [])
      this.items = list
        .map((item, index) => normalizeReminder(item, index))
        .filter((item): item is Reminder => item !== null)
    } catch {
      this.items = []
    }
    // 文件不存在/读不出来：空表起步并重建文件，绝不把启动流程带崩。
    if (raw === null) {
      try {
        await this.store.save({ version: 1, reminders: [] })
      } catch (error) {
        this.log(`reminders: rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.log(`reminders: loaded ${String(this.items.length)} item(s)`)
  }

  async save(): Promise<void> {
    try {
      await this.store.save({ version: 1, reminders: this.items })
    } catch (error) {
      this.log(`reminders save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async add(input: {
    text: string
    at: number
    room: 'group' | 'dm'
    target: number
    createdBy: number
    repeat?: Repeat
  }): Promise<Reminder> {
    const text = String(input.text ?? '').trim()
    if (text === '') throw new Error('提醒内容不能为空：告诉咱要到点提醒你什么。')
    const at = Number(input.at)
    if (!Number.isFinite(at) || at <= 0) throw new Error('提醒时间无效：请给 Unix 毫秒时间戳或 "YYYY-MM-DD HH:mm"。')
    const item: Reminder = {
      id: shortId('r'),
      text,
      at,
      room: input.room,
      target: Number(input.target),
      createdBy: Number(input.createdBy ?? 0),
      created: Date.now(),
      fired: false,
      firedAt: null,
      repeat: input.repeat ?? 'none',
    }
    this.items.push(item)
    await this.save()
    return item
  }

  /** 到点且没触发过的。repeat 的推进在 markFired 里做，这里保持纯查询。 */
  due(now = Date.now()): Reminder[] {
    return this.items.filter((r) => !r.fired && r.at <= now)
  }

  /**
   * 标记已触发。daily/weekly 不置 fired，而是把 at 推到下一轮 ——
   * 否则一个"每天早上7点"的提醒只会在今天响一次就消失。
   */
  async markFired(id: string): Promise<void> {
    const item = this.items.find((r) => r.id === id)
    if (item === undefined) return
    if (item.repeat === 'none') {
      item.fired = true
      item.firedAt = Date.now()
    } else {
      const step = item.repeat === 'daily' ? DAY_MS : WEEK_MS
      const now = Date.now()
      let at = item.at
      // 可能已经错过了好几轮，推进到第一个未来时刻，避免"补课"刷屏。
      do { at += step } while (at <= now)
      item.at = at
      item.fired = false
      item.firedAt = Date.now()
    }
    await this.save()
  }

  /** 列表：未触发的优先，其次按到点时间从近到远。 */
  list(limit = 50): Reminder[] {
    return [...this.items]
      .sort((a, b) => (Number(a.fired) - Number(b.fired)) || (a.at - b.at))
      .slice(0, Math.max(0, limit))
  }

  async remove(id: string): Promise<boolean> {
    const before = this.items.length
    this.items = this.items.filter((r) => r.id !== id)
    if (this.items.length === before) return false
    await this.save()
    return true
  }
}
