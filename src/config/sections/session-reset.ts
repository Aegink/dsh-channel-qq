/** 会话换血（自动）：会话请求 token 接近模型窗口时，备份历史、重开会话。
 *
 * 为什么需要它：上下文压缩（compaction）在历史**已经超过窗口**时救不回来——
 * 它自己的摘要请求也超窗。换血是最后一道防线，必须在压缩之前生效。
 */

import { b, n, s, type FieldGroup } from '../dsl.js'

export interface SessionResetConfig {
  /** 总开关。 */
  enabled: boolean
  /** 触发比例：tokens ≥ 窗口 × ratio 时换血（0.1–0.95）。 */
  thresholdRatio: number
  /** 检查间隔（分钟）。 */
  checkIntervalMin: number
  /** 续接种子（空 = 用内置文案）。 */
  seed: string
}

export const SESSION_RESET_GROUPS: FieldGroup[] = [
  {
    id: 'sessionReset',
    label: '会话换血',
    page: 'messages',
    fields: {
      enabled: b('自动换血', true, {
        hot: 'live',
        help: '会话 token 接近模型窗口时自动备份历史并重开会话；关掉后只能手动跑 deploy/session-reset.mjs。',
      }),
      thresholdRatio: n('触发比例', 0.85, {
        hot: 'live', min: 0.1, max: 0.95, step: 0.05,
        help: '按模型声明的窗口计算。默认 0.85：让宿主的上下文压缩（约 0.8）先跑，压缩失败时这里才兜底换血。',
      }),
      checkIntervalMin: n('检查间隔', 5, {
        hot: 'live', min: 1, max: 60, unit: 'min',
        help: '每轮检查活跃会话的体积；只在回合空闲时动手。',
      }),
      seed: s('续接种子', '', {
        hot: 'live', advanced: true,
        help: '换血后注入下一轮的一句话（留空用内置文案：上下文已清空、人格与长期记忆不变）。',
      }),
    },
  },
]
