/** 情绪：1 个工具。
 *
 * 与好感度的工具**故意分开**：`qq_affection` 记的是「关系走到哪一步」（长期、
 * 由她声明阶段），`qq_emotion` 记的是「这一刻什么状态」（会自己回落、影响语气
 * 与要不要主动开口）。合成一个会让一句气话同时掉关系又掉心情——而关系本来
 * 不该因为一句话掉档。
 *
 * 为什么还需要这个工具（正则触发器不是已经在了吗）：正则**猜**，她**知道**。
 * 「我不生气」会命中 `生气`，而她自己读得懂上下文。工具给的是覆盖权，不是替代。
 */

import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** 心情词表（与 `engine.ts` 的 `MOODS` 一致；schema 里也要能穷举，模型才知道填什么）。 */
const MOODS = ['开心', '得意', '委屈', '生气', '平静', '兴奋', '害羞'] as const

/** `qq_set_emotion` — 【此刻的心情】一句话让咱心里变了味的时候记账：心情 + 能量增减。 */
function qqSetEmotion(deps: QQToolDeps): ToolSpec {
  const { emotion } = deps
  return {
    name: 'qq_set_emotion',
    description: '【此刻的心情】一句话让咱心里变了味的时候，用这个记下「这一刻」的状态：心情 + 能量增减。'
      + '它和 qq_set_affection 是两本账：那个记关系（走到哪一步、阶段），这个记当下（现在什么心情、还有多少力气）。'
      + '被扎到、被夸到、被逗笑、聊到累——都该记；日常寒暄不用记。',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'string', enum: [...MOODS], description: '此刻的心情基调' },
        energy: { type: 'number', description: '能量增减：被点燃 +5~15，被耗到 -5~15，不填算 0（范围 -30~30）' },
        reason: { type: 'string', description: '为什么变了，一句话（会进提示行，20 字内）' },
      },
      required: ['mood', 'reason'],
    },
    run: async (args) => {
      if (emotion === undefined || emotion === null) return { ok: false, note: '情绪系统未启用' }
      return emotion.book(String(args.mood ?? ''), Number(args.energy ?? 0), String(args.reason ?? ''))
    },
  }
}

/** 组装这一组工具。 */
export function emotionTools(deps: QQToolDeps): ToolSpec[] {
  return [qqSetEmotion(deps)]
}
