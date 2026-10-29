/** 情绪面：**这一刻**的心情与能量。
 *
 * 与「好感度」刻意分成两个 store，因为它们回答的不是同一个问题：
 *
 *   - `AffectionStore`（`src/affection.ts`）记**关系**：分数 + 阶段，由模型自己
 *     记账（`qq_set_affection` / `qq_set_stage`），叙事上只往前走；
 *   - `EmotionStore`（`features/emotion/`）记**当下**：心情 + 能量，按入站文字
 *     自动触发、随时间自己回落，影响这一回合的语气与要不要主动开口。
 *
 * 混成一个的代价很具体：一句气话既掉关系又掉心情，而关系本来不该因为一句话
 * 掉档——这正是原来「只有好感度」时那个别扭之处（`emotionHint` 槽位留了却一直
 * 没人填，见 `app/conversation/prompt-composer.ts`）。
 *
 * `app/` 只认这个形状（可重放层不 import features），实现在
 * `features/emotion/engine.ts`。
 */

/** 心情基调。取值固定，不开放自由文本：提示词里要按档位给建议，档位得能穷举。 */
export type Mood = '开心' | '得意' | '委屈' | '生气' | '平静' | '兴奋' | '害羞'

/** 一回合要用到的情绪读写口。 */
export interface EmotionSurface {
  /** 按一条入站文字记账（触发器命中才变；同步、尽力而为，不许抛）。 */
  observe(text: string): void
  /** 花掉一个回合的力气（说话本身要耗能量）。 */
  spend(): void
  /** 此刻的一行提示；关着时返回空串。 */
  hint(): string
  /** 此刻的能量（0–100；主动性闸门读它）。 */
  energy(): number
}

/**
 * 组包器要的取值函数。
 *
 * 情绪子插件晚于 inbound 挂载（装载表顺序见 `src/sections.ts`），所以这里只能
 * 传取值函数而不是实例——与 `KnowledgeSource` 同一个理由。返回 `null` 表示
 * 「这一包没有情绪提示」，组包产物与从前**逐字节一致**（golden 盯着这一点）。
 */
export type EmotionSource = () => EmotionSurface | null
