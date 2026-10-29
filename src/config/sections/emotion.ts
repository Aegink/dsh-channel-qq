/** 情绪与能量段（`emotion.*`）：当下状态，与好感度分开记。
 *
 * 类型与字段放同一个文件，理由与 interaction/music/skills 相同：`src/config.ts`
 * 是全仓引用的类型入口，体积有硬上限——新增一段的做法是段连同类型一起放进来，
 * 那边只留一个 `import(...)`。
 *
 * 三个字段全是 `live`：引擎每次读配置都现取（`() => host.config.emotion`），
 * 所以后台改完立刻生效，不需要重连也不需要重挂。
 */

import { b, n, type FieldGroup } from '../dsl.js'

export interface EmotionConfig {
  /** 关掉后提示恒为空串，组包产物回到「没有这一行」的样子。 */
  enabled: boolean
  /** 能量每小时向静息值（60）靠拢多少。 */
  decayPerHour: number
  /** 低于这个能量算「累了」：提示里建议短句，主动巡逻与主动私聊直接跳过。 */
  lowEnergy: number
}

export const EMOTION_GROUPS: FieldGroup[] = [
  {
    id: 'emotion',
    label: '情绪与能量',
    page: 'persona',
    help: '这一回合的心情与能量：按入站文字自动变化、随时间自己回落。'
      + '它影响语气与要不要主动开口，但**不改好感度**——那是另一本账（好感度面板）。',
    fields: {
      enabled: b('情绪提示', true, {
        hot: 'live',
        help: '关掉后每包不再带「【此刻】心情…」这一行，其余行为不变。',
      }),
      decayPerHour: n('能量每小时回落', 6, {
        hot: 'live', min: 0, max: 60, step: 1,
        help: '能量向静息值 60 靠拢的速度：累了自己会缓过来，太兴奋也会平息。0 = 不回落。',
      }),
      lowEnergy: n('「累了」阈值', 30, {
        hot: 'live', min: 0, max: 100, step: 5,
        help: '低于这个值算累了：提示里建议短句，主动巡逻与主动私聊会跳过（日志会写原因）。',
        hiddenIf: { field: 'emotion.enabled', equals: false },
      }),
    },
  },
]
