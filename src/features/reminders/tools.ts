/** 提醒工具面：qq_remind / qq_remind_at / qq_remind_list / qq_remind_cancel。
 *
 * P4.2 判据：这 4 个工具的 name / description / parameters 一个字节都不许变 ——
 * `test/golden/tools/other-tools.txt` 的 reminders 段逐字节钉住了它们。拆法照
 * `features/messaging/tools.ts`：一个工具一个函数。
 *
 * api / out 这里用不上 —— 提醒是到点才发的，那条路由 ReminderRunner 的 send
 * 回调决定；但签名与其它模块保持一致，主控接线时不用分叉。
 */

import { registerSpecs, params, type ToolHost, type ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import { DAY_MS, humanTime, parseWhen } from './parse-when.js'
import type { ReminderStore, Repeat } from './store.js'

/** 配置里关了提醒时，四个工具的同一句拒绝。 */
function disabled(): { ok: boolean; note: string } {
  return { ok: false, note: '提醒功能已在配置里关闭' }
}

/** 人类可读时间：跨天也在文本里说清楚，模型因此知道要"明天"说。 */
function atText(at: number, now = new Date()): string {
  return humanTime(at, now)
}

/** qq_remind_at 的 at 参数：Unix 毫秒时间戳或 "YYYY-MM-DD HH:mm"。 */
function parseAt(input: string): number | null {
  const text = input.trim()
  if (text === '') return null
  if (/^\d{10,16}$/.test(text)) {
    const n = Number(text)
    if (!Number.isFinite(n)) return null
    return n < 10_000_000_000 ? n * 1000 : n
  }
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T ]?(\d{1,2})?[:：]?(\d{1,2})?/.exec(text)
  if (m === null) return null
  const at = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    m[4] === undefined ? 9 : Number(m[4]),
    m[5] === undefined ? 0 : Number(m[5]),
    0,
    0,
  )
  return Number.isNaN(at.getTime()) ? null : at.getTime()
}

const WHEN_HINT = [
  '咱认不出这个时间写法。支持的有：',
  '绝对时间：2026-10-15 09:00、10-15 09:00、10月15日9点、15号9点半；',
  '相对时间：5分钟后、30秒后、2小时后、3天后；',
  '时刻：9点、9:30、下午3点、晚上8点、明早7点、明天9点、今天晚上10点、后天中午；',
  '周期：句子里带"每天/每日"或"每周/每星期"。',
  '下次请按这些写法再试，或改用 qq_remind_at 给确切的 "YYYY-MM-DD HH:mm"。',
].join('\n')

/** 这一组工具要的依赖：config、store 与"往哪发"的解析。 */
interface ReminderToolDeps {
  readonly config: QQChannelConfig
  readonly store: ReminderStore
  /** 解析提醒投递房间；群默认落 primaryGroup，私聊必须显式给 target。 */
  readonly resolveRoom: (args: Record<string, unknown>) => { room: 'group' | 'dm'; target: number } | null
}

/** `qq_remind` — 用自然语言定一个提醒。 */
function qqRemind(deps: ReminderToolDeps): ToolSpec {
  const { config, store, resolveRoom } = deps
  return {
    name: 'qq_remind',
    description: '用自然语言定一个提醒（"明天9点叫我起床""30分钟后提醒我关火""每天晚上10点提醒我睡觉"）。when 支持中文时刻/相对时间/日期。到点由主控推送到指定房间。时间写法认不出来时会返回 ok:false + 支持的写法列表，这时改用 qq_remind_at。',
    parameters: params({
      when: { type: 'string', description: '什么时候提醒，如"明天9点"、"5分钟后"、"每天下午3点"' },
      text: { type: 'string', description: '提醒内容，如"起来上班"' },
      isGroup: { type: 'boolean', description: '是否发到群里（默认 true）' },
      target: { type: 'number', description: '群号或QQ号；省略则用 primaryGroup / 私聊需显式给' },
      createdBy: { type: 'number', description: '发起人QQ号' },
    }, ['when', 'text']),
    run: async (args) => {
      if (!config.reminders.enabled) return disabled()
      const when = String(args.when ?? '').trim()
      const text = String(args.text ?? '').trim()
      if (when === '') throw new Error('when 不能为空：说清楚什么时候提醒（如"明天9点"）。')
      if (text === '') throw new Error('text 不能为空：提醒什么内容？')
      const parsed = parseWhen(when)
      if (parsed === null) {
        return { ok: false, hint: WHEN_HINT, note: `没认出时间写法："${when}"` }
      }
      const dest = resolveRoom(args)
      if (dest === null) return { ok: false, note: '需要 isGroup + target（群号/QQ号），或在配置里设置 primaryGroup' }
      const item = await store.add({
        text,
        at: parsed.at,
        room: dest.room,
        target: dest.target,
        createdBy: Number(args.createdBy ?? 0),
        repeat: parsed.repeat,
      })
      return { ok: true, reminder: item, atText: atText(item.at), note: parsed.note }
    },
  }
}

/** `qq_remind_at` — 用一个确切时间定提醒（自然语言解析失败时的显式路径）。 */
function qqRemindAt(deps: ReminderToolDeps): ToolSpec {
  const { config, store, resolveRoom } = deps
  return {
    name: 'qq_remind_at',
    description: '用一个确切时间定提醒（自然语言解析失败时用这个）。at 传 Unix 毫秒时间戳或 "YYYY-MM-DD HH:mm"；repeat 可选 none/daily/weekly，做每天/每周的固定提醒。',
    parameters: params({
      at: { type: 'string', description: 'Unix 毫秒时间戳（如 1730000000000）或 "YYYY-MM-DD HH:mm"' },
      text: { type: 'string', description: '提醒内容' },
      repeat: { type: 'string', enum: ['none', 'daily', 'weekly'], description: '重复方式，默认 none' },
      isGroup: { type: 'boolean', description: '是否发到群里（默认 true）' },
      target: { type: 'number', description: '群号或QQ号；省略则用 primaryGroup' },
      createdBy: { type: 'number', description: '发起人QQ号' },
    }, ['at', 'text']),
    run: async (args) => {
      if (!config.reminders.enabled) return disabled()
      const atRaw = String(args.at ?? '').trim()
      const text = String(args.text ?? '').trim()
      if (atRaw === '') throw new Error('at 不能为空：给 Unix 毫秒时间戳或 "YYYY-MM-DD HH:mm"。')
      if (text === '') throw new Error('text 不能为空：提醒什么内容？')
      const at = parseAt(atRaw)
      if (at === null) return { ok: false, note: `没认出时间："${atRaw}"。请用 Unix 毫秒时间戳或 "YYYY-MM-DD HH:mm"。` }
      const dest = resolveRoom(args)
      if (dest === null) return { ok: false, note: '需要 isGroup + target（群号/QQ号），或在配置里设置 primaryGroup' }
      const repeat: Repeat = args.repeat === 'daily' || args.repeat === 'weekly' ? args.repeat : 'none'
      // 一次性提醒定在过去 = 立刻炸，肯定是算错了；重复提醒可以由 markFired 推进。
      if (at < Date.now() - 60_000 && repeat === 'none') {
        return { ok: false, note: `这个时间已经过去了（${atText(at)}）。请给未来的时间。` }
      }
      if (at > Date.now() + 5 * 365 * DAY_MS) {
        return { ok: false, note: '时间太远（超过 5 年），请确认年月日是否正确。' }
      }
      const item = await store.add({
        text,
        at,
        room: dest.room,
        target: dest.target,
        createdBy: Number(args.createdBy ?? 0),
        repeat,
      })
      return { ok: true, reminder: item, atText: atText(item.at) }
    },
  }
}

/** `qq_remind_list` — 看当前挂着哪些提醒（未触发的排前面）。 */
function qqRemindList(deps: ReminderToolDeps): ToolSpec {
  const { config, store } = deps
  return {
    name: 'qq_remind_list',
    description: '看当前挂着哪些提醒（未触发的排前面）。想取消某条就先看这个拿 id。',
    parameters: params({
      limit: { type: 'number', description: '返回条数，默认 50' },
    }),
    run: (args) => {
      if (!config.reminders.enabled) return disabled()
      const wanted = Number(args.limit)
      const limit = Number.isFinite(wanted) && wanted > 0 ? wanted : 50
      const now = new Date()
      const reminders = store.list(limit).map((r) => ({ ...r, atText: atText(r.at, now) }))
      return { count: reminders.length, reminders }
    },
  }
}

/** `qq_remind_cancel` — 取消一条提醒（id 来自 qq_remind_list）。 */
function qqRemindCancel(deps: ReminderToolDeps): ToolSpec {
  const { config, store } = deps
  return {
    name: 'qq_remind_cancel',
    description: '取消一条提醒（id 来自 qq_remind_list）。',
    parameters: params({
      id: { type: 'string', description: '提醒 id，形如 r_xxxx' },
    }, ['id']),
    run: async (args) => {
      if (!config.reminders.enabled) return disabled()
      const id = String(args.id ?? '').trim()
      if (id === '') throw new Error('id 不能为空：先用 qq_remind_list 找到要取消的那条。')
      const removed = await store.remove(id)
      return { ok: removed, note: removed ? '已取消' : `没找到 id=${id} 的提醒` }
    },
  }
}

/**
 * 注册提醒工具。
 *
 * client / out 这里用不上 —— 提醒是到点才发的，那条路由 ReminderRunner 的
 * send 回调决定；但签名与其它模块保持一致，主控接线时不用分叉。
 */
export function registerReminderTools(
  ctx: ToolHost,
  config: QQChannelConfig,
  api: QQApi,
  out: OutboundQueue,
  log: (line: string) => void,
  store: ReminderStore,
): () => void {
  /** 解析提醒投递房间；群默认落 primaryGroup，私聊必须显式给 target。 */
  const resolveRoom = (args: Record<string, unknown>): { room: 'group' | 'dm'; target: number } | null => {
    const isGroup = args.isGroup !== false
    const raw = args.target
    if (raw === undefined || raw === null || raw === '') {
      if (!isGroup) return null
      return config.primaryGroup === null ? null : { room: 'group', target: config.primaryGroup }
    }
    const target = Number(raw)
    if (!Number.isFinite(target) || target <= 0) return null
    return { room: isGroup ? 'group' : 'dm', target }
  }

  const deps: ReminderToolDeps = { config, store, resolveRoom }
  const specs: ToolSpec[] = [
    qqRemind(deps),
    qqRemindAt(deps),
    qqRemindList(deps),
    qqRemindCancel(deps),
  ]
  return registerSpecs(ctx, specs, log, 'reminders')
}
