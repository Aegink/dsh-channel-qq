/** 交互提示子插件（A1）：回合进行中的「正在输入」与表情回应。
 *
 * 两件都是**感知层**：
 *   - 私聊回合开始时 `set_input_status 1`、结束时 `0`；
 *   - 回合开始时给触发消息贴一个表情，结束时撤掉。
 *
 * 三条硬规则：
 *   1. 配置关着时**一个协议动作都不发**（默认关，golden 不动）；
 *   2. 任何失败只写一行日志，绝不影响回合（这是提示，不是消息）；
 *   3. `end` 撤销的是**当时真的发出去的那一个**——回合中途改配置也不会撤错表情。
 */

import type { QQChannelConfig } from '../../config.js'
import type { QQApi } from '../../ports/platform.js'
import type { TurnHooks } from '../../ports/turn-hooks.js'
import type { OneBotEvent } from '../../types.js'
import type { SubPlugin } from '../plugin-kit.js'

/** 一个房间里已经发出去的提示（end 按它逐项撤销）。 */
interface ActiveHint {
  /** 开始过输入状态；`userId` 是私聊对方。 */
  readonly typingUserId: number | null
  /** 贴过表情；带上当时的 emoji id。 */
  readonly reaction: { readonly messageId: number; readonly emojiId: string } | null
}

export interface InteractionDeps {
  readonly api: () => QQApi | null
  readonly config: () => QQChannelConfig['interaction']
  readonly log: (line: string) => void
}

export class Interaction implements TurnHooks {
  /** 房间 → 已发出的提示。 */
  private readonly active = new Map<string, ActiveHint>()

  constructor(private readonly deps: InteractionDeps) {}

  /** 用户回合开始：按开关发提示。 */
  begin(room: string, event: OneBotEvent): void {
    // 同一房间上一轮还没撤销（例如 idle 丢失）时先撤，避免两次提示叠加。
    this.end(room)
    const config = this.deps.config()
    const api = this.deps.api()
    if (api === null) return
    const isGroup = event.message_type === 'group'
    const userId = typeof event.user_id === 'number' ? event.user_id : null
    const messageId = typeof event.message_id === 'number' ? event.message_id : null
    const typingUserId = config.typingIndicator && !isGroup ? userId : null
    // 2026-10-22 实测：SnowLuma 对私聊消息回 retcode 100
    // 「emoji reactions are not supported on private messages」——只在群里贴。
    const reaction = config.ackReaction && isGroup && messageId !== null
      ? { messageId, emojiId: config.ackEmojiId }
      : null
    if (typingUserId === null && reaction === null) return
    this.active.set(room, { typingUserId, reaction })
    if (typingUserId !== null) {
      this.call(room, 'input status on', () => api.setInputStatus(typingUserId, 1))
    }
    if (reaction !== null) {
      this.call(room, 'reaction on', () => api.setMessageEmojiLike(reaction.messageId, reaction.emojiId, true))
    }
  }

  /** 回合结束（成功/失败/释放）：撤销这个房间里已发出的提示。 */
  end(room: string): void {
    const hint = this.active.get(room)
    if (hint === undefined) return
    this.active.delete(room)
    const api = this.deps.api()
    if (api === null) return
    if (hint.typingUserId !== null) {
      const userId = hint.typingUserId
      this.call(room, 'input status off', () => api.setInputStatus(userId, 0))
    }
    if (hint.reaction !== null) {
      const { messageId, emojiId } = hint.reaction
      this.call(room, 'reaction off', () => api.setMessageEmojiLike(messageId, emojiId, false))
    }
  }

  /** 发一个提示动作；失败只记日志。 */
  private call(room: string, what: string, run: () => Promise<unknown>): void {
    void run().catch((error: unknown) => {
      this.deps.log(`interaction ${what} failed for ${room}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

export const interactionPlugin: SubPlugin = {
  name: 'interaction',
  watches: ['interaction'],
  requires: ['platform'],
  apply(host) {
    const interaction = new Interaction({
      api: () => host.get('platform')?.api ?? null,
      config: () => host.config.interaction,
      log: host.log,
    })
    host.provide('interaction', interaction)
  },
}
