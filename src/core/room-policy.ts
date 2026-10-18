/** 按群覆盖：把"全局默认 + 单个群的例外"解析成这个群真正生效的一组值。
 *
 * 为什么需要：一个号会被拉进很多群，而"这个群要不要说话、要不要 @ 才理、接话
 * 概率多少"不该全局一刀切。优先级沿用 04 §目标架构的约定：
 *
 *     单个群（`rooms[群号]`） > 全局（`groupEnabled` / `requireMention` / `talkValue`）
 *
 * 纯函数：非法值（类型不对、概率越界）一律当"没有覆盖"，绝不因为一个手滑的配置
 * 把某个群变成静音或刷屏。
 */

export interface RoomOverride {
  /** 是否处理这个群的消息；缺省 = 跟全局。 */
  readonly enabled?: boolean
  /** 是否必须 @ 才理；缺省 = 跟全局。 */
  readonly requireMention?: boolean
  /** 接话概率 0–1；缺省 = 跟全局（主群仍可被 primaryTalkValue 覆盖）。 */
  readonly talkValue?: number
}

export interface RoomPolicyConfig {
  readonly groupEnabled: boolean
  readonly requireMention: boolean
  readonly talkValue: number
  readonly primaryTalkValue?: number | null
  readonly primaryGroup: number | null
  readonly rooms?: Readonly<Record<string, RoomOverride>>
}

export interface RoomPolicy {
  readonly enabled: boolean
  readonly requireMention: boolean
  readonly talkValue: number
}

function boolOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function chanceOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined
  return value
}

/** 这个群最终生效的策略。`groupId` 为 null（私聊）时只返回全局值。 */
export function resolveRoomPolicy(config: RoomPolicyConfig, groupId: number | null): RoomPolicy {
  const override = groupId !== null && config.rooms !== undefined
    ? config.rooms[String(groupId)]
    : undefined
  const primaryChance = groupId !== null && config.primaryGroup !== null && groupId === config.primaryGroup
    ? (typeof config.primaryTalkValue === 'number' ? config.primaryTalkValue : config.talkValue)
    : config.talkValue
  return {
    enabled: boolOf(override?.enabled) ?? config.groupEnabled,
    requireMention: boolOf(override?.requireMention) ?? config.requireMention,
    talkValue: chanceOf(override?.talkValue) ?? primaryChance,
  }
}
