/** 出站特征拦截（P6c）：广告前缀、同一会话连续复读开头串。**命中即拦**。
 *
 * 方向与入站扫描相反：入站只打标（不可信输入不该被过滤改写），出站这条是模型
 * 自己生成的话——拦下来就是工具报错，模型据此改正（05 §4 的 `output-signatures`
 * 一行）。判据全是纯函数 + 一张有界的房间状态表：没有时钟、没有 IO（R8）。
 *
 * "连续"由**发送顺序**定义而不是时间：同一会话里连着几条开头一样，就是复读；
 * 跨会话不算（不同房间里说"早上好呀"是正常的）。
 */

import type { OutputSignatureRules } from '../injection/signatures.js'
import { dmRoom, groupRoom } from '../room.js'

/** 出站拦截的两个 reason key（文案在人格包的 `guards/output-*.txt`）。 */
export const OUTPUT_SIGNATURE_REASONS = {
  adPrefix: 'policy.output.ad-prefix',
  repeatOpening: 'policy.output.repeat-opening',
} as const

export type OutputSignatureReason = (typeof OUTPUT_SIGNATURE_REASONS)[keyof typeof OUTPUT_SIGNATURE_REASONS]

/**
 * 与发送工具一致的"剥壳"：`<思考>` 段落不会进消息，判据也不该看见它。
 *
 * 与 `qq_send_text` / `qq_reply_quote` 的清洗保持同一形状——闸门看到的是参数，
 * 而真正发出去的是剥壳并 trim 之后的文本，两处不一致会让复读判据记错开头。
 */
export function normalizeForSend(text: string): string {
  return text.replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim()
}

/** 开头串：不足 `minChars` 个字的消息没有"≥6 字的相同开头"，返回 null。 */
export function openingKeyOf(text: string, minChars: number): string | null {
  const t = normalizeForSend(text)
  return t.length < minChars ? null : t.slice(0, minChars)
}

interface RoomOpening {
  open: string | null
  run: number
}

/** 一次拦截的细节：撞的是哪个开头、这一轮第几次。 */
export interface BlockDetail {
  readonly opening: string
  readonly count: number
}

/** 落盘用的最小状态（只有"最近一次开头 + 连发数"，不含任何正文）。 */
export interface GuardSnapshot {
  readonly rooms: ReadonlyArray<{ readonly room: string; readonly open: string | null; readonly run: number }>
}

/**
 * 每房间"最近一次发送的开头串 + 连发计数"，外加"同一开头被拦了几次"。
 *
 * 房间表有界（默认最久未用的 200 个被淘汰）：这份状态是会话连续性的近似，丢一个
 * 房间只让复读检测从新开始，不影响任何其它行为。**不落盘也能跑**；落盘是为了
 * 会话换血/进程重启之后不把同一条再发一遍（2026-10-29 实测：换血后 08:10 又发了
 * 一条与 06:00 一模一样的"早安"）。
 */
export class SendSignatureGuard {
  private readonly rooms = new Map<string, RoomOpening>()
  /** 每个房间"同一开头被拦了几次"；真的发出去一条就清。 */
  private readonly blocks = new Map<string, { open: string; count: number }>()

  constructor(
    private readonly rules: OutputSignatureRules,
    private readonly maxRooms = 200,
    /** 状态变化时回调（用于落盘）。这里**不做 IO**，R8：判据是纯函数。 */
    private readonly onChange?: () => void,
  ) {}

  /**
   * 这次要发的文本该不该拦？命中返回 reason key，否则 null。
   *
   * 复读判据：这条与**已发出的**最近两条开头串相同（即这一条会是连续第
   * `minRun` 条），拦下。被拦下的发送不进账本（record 只记真的发出去的）。
   */
  check(room: string, text: string): OutputSignatureReason | null {
    const normalized = normalizeForSend(text)
    if (normalized === '') return null
    for (const rule of this.rules.adPrefix) {
      // `^` 锚点匹配剥壳后的开头（规则本身自带 ^；这里再 trim 一次防全角空格）。
      if (rule.pattern.test(normalized)) return OUTPUT_SIGNATURE_REASONS.adPrefix
    }
    const open = openingKeyOf(normalized, this.rules.repeatOpening.minChars)
    if (open === null) return null
    const state = this.rooms.get(room)
    if (state !== undefined && state.open === open && state.run >= this.rules.repeatOpening.minRun - 1) {
      return OUTPUT_SIGNATURE_REASONS.repeatOpening
    }
    return null
  }

  /**
   * 记一次拦截，返回"撞车的开头 + 这一轮第几次"。
   *
   * 为什么要计数：原来的文案只说"换个说法再发"，模型看不见自己刚发过什么，
   * 于是又生成同一句——2026-10-29 实测一小时被拦 474 次，**每次都是一整步
   * 模型调用**。把开头和次数告诉它，重试才有可改的锚点。
   */
  noteBlocked(room: string, text: string): BlockDetail {
    const normalized = normalizeForSend(text)
    const opening = openingKeyOf(normalized, this.rules.repeatOpening.minChars) ?? normalized.slice(0, 12)
    const prev = this.blocks.get(room)
    const next = prev !== undefined && prev.open === opening
      ? { open: opening, count: prev.count + 1 }
      : { open: opening, count: 1 }
    this.blocks.set(room, next)
    this.onChange?.()
    return { opening: next.open, count: next.count }
  }

  /** 这一轮同一开头连续被拦了几次（没有记录时为 0）。 */
  blockedRun(room: string): number {
    return this.blocks.get(room)?.count ?? 0
  }

  /** 记一条**真的发出去**的消息（失败的、被拦下的都不进账本）。 */
  record(room: string, text: string): void {
    const open = openingKeyOf(text, this.rules.repeatOpening.minChars)
    const prev = this.rooms.get(room)
    const next: RoomOpening = open !== null && prev !== undefined && prev.open === open
      ? { open, run: prev.run + 1 }
      : { open, run: open === null ? 0 : 1 }
    // 重新插入让 Map 的迭代顺序反映"最近用过"，淘汰时从头删。
    this.rooms.delete(room)
    this.rooms.set(room, next)
    while (this.rooms.size > this.maxRooms) {
      const oldest = this.rooms.keys().next().value
      if (oldest === undefined) break
      this.rooms.delete(oldest)
    }
    // 真的发出去了：这一轮的"被拦次数"清零。
    this.blocks.delete(room)
    this.onChange?.()
  }

  /** 落盘快照：只留房间 → 开头串与连发数（不含正文）。 */
  snapshot(): GuardSnapshot {
    return {
      rooms: [...this.rooms].map(([room, state]) => ({ room, open: state.open, run: state.run })),
    }
  }

  /**
   * 回灌快照。坏数据一律忽略（返回恢复的条数）：这份状态丢了只会让复读检测
   * 从新开始，不该因为它读不起来就把插件拖挂。
   */
  restore(snapshot: unknown): number {
    const rooms = (snapshot as GuardSnapshot | null)?.rooms
    if (!Array.isArray(rooms)) return 0
    let restored = 0
    for (const item of rooms) {
      if (item === null || typeof item !== 'object') continue
      const room = (item as { room?: unknown }).room
      const open = (item as { open?: unknown }).open
      const run = (item as { run?: unknown }).run
      if (typeof room !== 'string' || room === '') continue
      if (open !== null && typeof open !== 'string') continue
      if (typeof run !== 'number' || !Number.isFinite(run) || run < 0) continue
      this.rooms.set(room, { open, run })
      restored += 1
    }
    while (this.rooms.size > this.maxRooms) {
      const oldest = this.rooms.keys().next().value
      if (oldest === undefined) break
      this.rooms.delete(oldest)
    }
    return restored
  }
}

/**
 * 这个工具调用是不是"往某个会话发一段文本"？是就返回待发文本。
 *
 * 6d（工具合并 86→17）已落地：`qq_send_text` / `qq_reply_quote` 合并为
 * `qq_message` 的 `send` / `reply`，下面按两级匹配并存。旧名两个分支不能先删
 * ——tools.v2 默认关时它们就是现役表面；旧面整体退役时再逐条勾掉。
 */
export function textSentBy(tool: string, args: Readonly<Record<string, unknown>>): string | null {
  if (tool === 'qq_send_text' || tool === 'qq_reply_quote') return stringOf(args.text)
  if (tool === 'qq_message' && (args.action === 'send' || args.action === 'reply')) return stringOf(args.text)
  return null
}

/** 目标房间键（`group-…` / `dm-…`）；`target` 不是合法 QQ 号时返回 null。 */
export function roomKeyOf(args: Readonly<Record<string, unknown>>): string | null {
  const target = Number(args.target)
  if (!Number.isSafeInteger(target) || target <= 0) return null
  return args.isGroup === true ? groupRoom(target) : dmRoom(target)
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}
