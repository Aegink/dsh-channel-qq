/** 房间：一次对话的标识（群聊一个、每个私聊对象一个）。
 *
 * 这个字符串的拼法是**承重结构**，不是随手起的名字：同一时刻它同时是
 *
 *   - 会话 id 的后缀（`qq-<key>`，见 `sessionIdOf`）；
 *   - 磁盘上会话目录的名字（`<sessionsRoot>/qq-<key>/`）；
 *   - 后台「重建会话」按钮的入参；
 *   - 定时任务（巡逻 / 做梦 / 早报）落点。
 *
 * 所以改动它等于**把所有人的聊天历史弄丢**（新 id = 新目录 = 新会话）。P3 只把
 * 它从 `bridge.ts` 搬到这里，拼法一个字符没动；要改得等 [06 §P7](../../refactor-plan/06-迁移路线.md)
 * 的运维阶段配一次迁移脚本。
 *
 * 纯函数、零 IO、零宿主依赖：`bridge.ts` 的黄金快照包含这些字符串，
 * 这里写错的代价是快照全红，而不是线上才发现。
 */

import type { OneBotEvent } from '../types.js'

/** 会话 id 的前缀；与磁盘目录名、`qq-` 开头的会话名一致。 */
export const SESSION_PREFIX = 'qq-'

/** 群聊房间键。 */
export function groupRoom(groupId: number): string {
  return `group-${groupId}`
}

/** 私聊房间键。 */
export function dmRoom(userId: number): string {
  return `dm-${userId}`
}

/** 会话 id（宿主侧的 `SessionId`，这里只给字符串；品牌化在 `adapters/dsh-host`）。 */
export function sessionIdOf(room: string): string {
  return `${SESSION_PREFIX}${room}`
}

/** 从一条入站消息推出房间键；既不是群聊也不是私聊时为 `null`。 */
export function roomOf(event: OneBotEvent): string | null {
  if (event.message_type === 'group' && typeof event.group_id === 'number') return groupRoom(event.group_id)
  if (event.message_type === 'private' && typeof event.user_id === 'number') return dmRoom(event.user_id)
  return null
}

/**
 * 房间键 → 它指向哪个房间。
 *
 * 定时任务可能在**任何一条消息到达之前**就触发（刚部署、群里还没人说话），
 * 那时房间记录得凭键本身合成出来，而不是等一条真实消息。
 */
export function splitRoom(room: string): { isGroup: boolean; chatId: number } | null {
  const group = /^group-(\d+)$/.exec(room)
  if (group !== null) return { isGroup: true, chatId: Number(group[1]) }
  const dm = /^dm-(\d+)$/.exec(room)
  if (dm !== null) return { isGroup: false, chatId: Number(dm[1]) }
  return null
}

/**
 * 告诉模型"你在哪个房间、该往哪发"的那一行。
 *
 * 没有它，群聊与私聊的入站行长得一模一样（`HH:MM 昵称(QQ号)…：正文`），而指令
 * 只说"发到本会话"却没给目标——模型只能猜 `isGroup` 和 `target`。它真的猜错过：
 * 2026-10-14 学弟在私聊问了一句，回答发到了主群，因为群聊在上下文里更显眼。
 * 现在每一条把回合交给模型的路径（群包、私聊、主动私聊、后台指令、巡逻）都带上
 * 这一行，猜测被彻底去掉。
 */
export function roomDirectiveFor(isGroup: boolean, chatId: number): string {
  return isGroup
    ? `【这是群聊】群号 ${chatId}。要发言必须用 qq_send_text / qq_reply_quote，且 isGroup=true、target=${chatId}；不要发到私聊。`
    : `【这是私聊】对方 QQ ${chatId}。要发言必须用 qq_send_text / qq_reply_quote，且 isGroup=false、target=${chatId}；不要发到任何群里。`
}
