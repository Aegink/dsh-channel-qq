/** 原话簿子插件：按群按日记录原始消息流水 + 跨群摘要工具。
 *
 * - 记录侧：`inbound` 的事件分发在群/私聊消息进来时调用 `chatlog.record(event)`，
 *   把非机器人的文本消息原样追加到 `<workspace>/memory/chatlog/<group|dm>/<id>/<day>.md`。
 *   写失败只记日志，绝不影响消息路径（发射后不管）。
 * - 工具侧：`qq_group_digest` 读原话簿按群返回指定日期的发言（默认关：只有
 *   `chatlog.enabled` 为 true 时才注册工具，golden 快照不含它）。
 *
 * 与记忆库的分工：记忆存蒸馏结论，原话簿存原文。默认关闭，打开后开始积累。
 */

import { appendChatLog, isPlaceholder, localClock, type ChatLogOptions } from './store.js'
import { registerChatLogTools } from './tools.js'
import { parseInbound } from '../../core/message/parse.js'
import type { OneBotEvent } from '../../types.js'
import type { SubPlugin } from '../plugin-kit.js'

/** 原话簿对外提供的记录服务（inbound 事件分发时取用）。 */
export interface ChatLogRecorder {
  /** 把一条入站消息追加进原话簿（群与私聊都记；非文本/占位跳过）。 */
  record(event: OneBotEvent): void
}

export const chatlogPlugin: SubPlugin = {
  name: 'chatlog',
  watches: ['chatlog'],
  requires: ['platform'],
  apply(host) {
    const opts = (): ChatLogOptions => {
      const dir = host.config.chatlog.dir ?? `${host.config.workspacePath ?? host.dshHome}/memory/chatlog`
      return { dir, maxChars: host.config.chatlog.maxChars }
    }

    host.provide('chatlog', {
      record(event: OneBotEvent): void {
        if (host.config.chatlog.enabled !== true) return
        if (event.message_type !== 'group' && event.message_type !== 'private') return
        if (event.user_id === undefined || event.user_id === host.config.selfId) return
        const text = parseInbound(event).text.trim()
        if (text === '' || isPlaceholder(text)) return
        const clock = localClock()
        const isGroup = event.message_type === 'group'
        const room = isGroup ? (event.group_id ?? 0) : event.user_id
        if (room === 0) return
        const nick = event.sender?.card?.trim() || event.sender?.nickname || `QQ${event.user_id}`
        void appendChatLog(opts(), {
          room,
          isGroup,
          qq: event.user_id,
          nick,
          hhmm: clock.hhmm,
          day: clock.day,
          text,
        }).then((ok) => {
          if (!ok) host.log(`chatlog append failed: ${isGroup ? 'group' : 'dm'} ${room} ${clock.day} ${clock.hhmm}`)
        })
      },
    })

    const disposeTools = registerChatLogTools(host.bridge.toolHost(), host.config, host.log)
    return disposeTools
  },
}