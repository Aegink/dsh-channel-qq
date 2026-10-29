/** 情绪引擎：心情与能量的状态机。
 *
 * 三个设计取舍值得写下来，因为每一个都有人会想改回去：
 *
 *  1. **触发用正则，不调模型**。每包一次模型调用只为判断「她是不是被夸了」太贵，
 *     而正则只需要给出**便宜的方向感**——真正的语气由模型自己拿捏（它读得到
 *     `hint()` 那一行）。正则必然误判（「我不生气」也会命中 `生气`），这是明知
 *     的代价：心情只是提示，不是判决，误判的后果是语气略偏，而不是行为出错。
 *  2. **衰减是惰性的，不起定时器**。`hint()` 与 `energy()` 读的时候按「距上次
 *     记账过了多久」现算，状态里存的永远是**上次记账那一刻**的值。这样既不需要
 *     常驻 timer，也不会因为进程睡了 8 小时就把能量卡在入睡那一刻。
 *  3. **`lastEvent` 只存固定短语，不存用户原文**。心情会进提示词、也会进后台，
 *     没有理由把别人的原话抄一份到 `emotion.json` 里。
 *
 * 与好感度的分工见 `ports/emotion.ts` 的文件头：这里管「这一刻」，那里管「关系」。
 */

import * as path from 'node:path'
import { JsonStore } from '../../adapters/fs-store/json-store.js'
import type { EmotionSurface, Mood } from '../../ports/emotion.js'

/** 能量的静息值：没有事情发生时，能量往这里回（不是 100——她不是永动机）。 */
export const ENERGY_BASELINE = 60
/** 一个回合耗掉的能量。 */
export const TURN_COST = 2
/** 多久没有新事件，心情就淡回「平静」（毫秒）。 */
export const MOOD_STALE_MS = 3 * 60 * 60_000

const MOODS: readonly Mood[] = ['开心', '得意', '委屈', '生气', '平静', '兴奋', '害羞']

/** 落盘的状态。 */
export interface EmotionState {
  mood: Mood
  /** 0–100。 */
  energy: number
  /** 触发心情的那类事（固定短语，见文件头第 3 条）。 */
  lastEvent: string
  /** 最后一次**真的记账**的时间（衰减按它算时间差；读不刷新它）。 */
  updated: number
}

/** 引擎要的配置形状（`emotion` 段；取值函数是为了后台改完立即生效）。 */
export interface EmotionConfigLike {
  readonly enabled: boolean
  readonly decayPerHour: number
  readonly lowEnergy: number
}

interface Trigger {
  readonly pattern: RegExp
  readonly mood: Mood
  /** 能量增量。 */
  readonly energy: number
  /** 记账短语（不含匹配到的原文）。 */
  readonly note: string
}

/**
 * 触发器表：**先命中先算**，一条消息最多改变一次心情。
 *
 * 词表刻意短。「夸」类单字（夸 / 棒 / 厉害）在正常句子里几乎不会误伤；而
 * 「生气」「滚」这类词有反讽风险（「我不生气」），仍留着是因为漏判比误判更
 * 让人出戏——她的心情应该跟着话走，哪怕偶尔跟错。
 */
const TRIGGERS: readonly Trigger[] = [
  { pattern: /夸|厉害|真棒|好棒|聪明|天才|靠谱/, mood: '得意', energy: 6, note: '被夸了' },
  { pattern: /爱你|喜欢你|想你|抱抱|亲亲|贴贴/, mood: '害羞', energy: -3, note: '被撩了一下' },
  { pattern: /笨蛋|滚开|闭嘴|烦人|讨厌|不理你/, mood: '委屈', energy: -8, note: '被凶了' },
  { pattern: /谢谢|辛苦|麻烦你|拜托/, mood: '开心', energy: 4, note: '被道谢了' },
  { pattern: /早安|晚安|吃饭|睡觉|早点休息|别熬夜/, mood: '平静', energy: 2, note: '日常问候' },
  { pattern: /代码|bug|部署|上线|重构|工程/, mood: '兴奋', energy: 8, note: '聊到技术' },
]

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** 读盘时的形状校验：不认识就当没有（绝不让存储问题拦住插件启动）。 */
function isEmotionState(value: unknown): value is EmotionState {
  if (value === null || typeof value !== 'object') return false
  const raw = value as Partial<EmotionState>
  return typeof raw.energy === 'number'
    && Number.isFinite(raw.energy)
    && typeof raw.updated === 'number'
    && typeof raw.lastEvent === 'string'
    && MOODS.includes(raw.mood as Mood)
}

/** 心情的运行时校验（工具参数是外部输入，类型收窄必须在运行时做一次）。 */
function isMood(value: string): value is Mood {
  return (MOODS as readonly string[]).includes(value)
}

export class EmotionStore implements EmotionSurface {
  private state: EmotionState = {
    mood: '平静',
    energy: ENERGY_BASELINE,
    lastEvent: '',
    updated: Date.now(),
  }

  private readonly store: JsonStore<EmotionState>

  constructor(
    dshHome: string,
    private readonly log: (line: string) => void,
    private readonly config: () => EmotionConfigLike,
  ) {
    this.store = new JsonStore<EmotionState>(path.join(dshHome, 'emotion.json'), {
      validate: isEmotionState,
      log,
    })
  }

  /** 读盘。文件不存在/坏掉/形状不对 → 用初值（`JsonStore.load` 已经这么处理）。 */
  async load(): Promise<void> {
    this.state = await this.store.load(this.state)
  }

  // ── 配置 ──────────────────────────────────────────────────────────────────

  private enabled(): boolean {
    return this.config().enabled
  }

  private rate(): number {
    const rate = this.config().decayPerHour
    return Number.isFinite(rate) && rate > 0 ? rate : 0
  }

  // ── 惰性衰减 ──────────────────────────────────────────────────────────────

  /**
   * 按「距上次记账过了多久」算出**此刻**的读数（纯函数，不改状态、不落盘）。
   *
   * 能量向静息值靠拢（两边都靠：累了自己会缓过来，太兴奋也会平息）；心情在
   * `MOOD_STALE_MS` 之后淡回「平静」，`lastEvent` 一起清掉——不然「被夸了」
   * 会跟着她三天。
   */
  private effective(now: number): Pick<EmotionState, 'mood' | 'energy' | 'lastEvent'> {
    const elapsed = Math.max(0, now - this.state.updated)
    const hours = elapsed / 3_600_000
    const toward = ENERGY_BASELINE - this.state.energy
    const step = Math.sign(toward) * Math.min(Math.abs(toward), this.rate() * hours)
    const stale = elapsed >= MOOD_STALE_MS
    return {
      mood: stale ? '平静' : this.state.mood,
      energy: clamp(this.state.energy + step),
      lastEvent: stale ? '' : this.state.lastEvent,
    }
  }

  /** 把惰性衰减「落定」到状态里（写之前必须先做，否则增量会叠加错）。 */
  private materialize(now: number): void {
    const eff = this.effective(now)
    this.state = { ...eff, updated: now }
  }

  /** 落盘（发射后不管：情绪坏掉不该影响回话）。 */
  private save(): void {
    void this.store.save(this.state).catch((error: unknown) => {
      this.log(`emotion save failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // ── EmotionSurface ────────────────────────────────────────────────────────

  /**
   * 按一条入站文字记账。
   *
   * **没命中触发器就什么都不做**（也不落盘）：群里大多数话跟她无关，为了没有
   * 变化的消息写一次盘是纯浪费。
   */
  observe(text: string): void {
    if (!this.enabled() || text === '') return
    const trigger = TRIGGERS.find((entry) => entry.pattern.test(text))
    if (trigger === undefined) return
    const now = Date.now()
    this.materialize(now)
    this.state.mood = trigger.mood
    this.state.energy = clamp(this.state.energy + trigger.energy)
    this.state.lastEvent = trigger.note
    this.save()
  }

  /** 一个回合的力气：说完话就少一点。 */
  spend(): void {
    if (!this.enabled()) return
    this.materialize(Date.now())
    this.state.energy = clamp(this.state.energy - TURN_COST)
    this.save()
  }

  /**
   * 模型自己声明的状态（`qq_set_emotion`）。
   *
   * 与 `observe()` 并存，因为两者知道的东西不一样：正则**猜**（便宜的旁证），
   * 模型**知道**（它读了整段话，也清楚自己被哪句扎到）。所以这里是覆盖式的：
   * 心情直接写成她说的那个，能量在现值上加减，`lastEvent` 用她给的理由。
   *
   * 理由**截断到 20 字**：它会进每一包的提示行，不能让它变成一段长文；
   * 也因为它来自模型而不是用户原文，截断比清洗更有用（原文本来就不该在这）。
   */
  async book(
    mood: string,
    energyDelta: number,
    reason: string,
  ): Promise<{ ok: boolean; note: string; mood: Mood; energy: number }> {
    if (!this.enabled()) {
      return { ok: false, note: '情绪系统未启用（emotion.enabled）', mood: this.state.mood, energy: this.energy() }
    }
    if (!isMood(mood)) {
      return { ok: false, note: `心情只能是：${MOODS.join(' / ')}`, mood: this.state.mood, energy: this.energy() }
    }
    const delta = Number.isFinite(energyDelta) ? Math.max(-30, Math.min(30, energyDelta)) : 0
    this.materialize(Date.now())
    this.state.mood = mood
    this.state.energy = clamp(this.state.energy + delta)
    this.state.lastEvent = reason.trim().slice(0, 20)
    this.save()
    const energy = Math.round(this.state.energy)
    return { ok: true, note: `记下了：心情${mood}，能量 ${energy}/100`, mood, energy }
  }

  /**
   * 此刻的一行提示（关着时是空串）。
   *
   * 只给**方向**，不给台词：语气与内容仍然是模型自己的事。能量低时建议短句、
   * 别主动开话题——这就是「能量影响话多话少」的落点（硬闸门在主动行为那边）。
   */
  hint(): string {
    if (!this.enabled()) return ''
    const eff = this.effective(Date.now())
    const energy = Math.round(eff.energy)
    const band = energy >= 75 ? '足' : energy >= 45 ? '中' : energy >= 25 ? '偏低' : '低'
    const advice = energy >= 75
      ? '想多说就多说，也可以主动起个话头'
      : energy >= 45
        ? '正常说'
        : energy >= 25
          ? '句子短一点，少开新话题'
          : '只回必要的话，别主动找话'
    const event = eff.lastEvent === '' ? '' : `（${eff.lastEvent}）`
    return `【此刻】心情${eff.mood}${event}，能量 ${energy}/100（${band}）——${advice}`
  }

  /** 此刻的能量（主动性闸门读它）。 */
  energy(): number {
    if (!this.enabled()) return ENERGY_BASELINE
    return Math.round(this.effective(Date.now()).energy)
  }

  // ── 后台 ──────────────────────────────────────────────────────────────────

  /** 后台「人格」页读的投影（含惰性衰减后的当前值）。 */
  snapshot(): {
    enabled: boolean
    mood: Mood
    energy: number
    lastEvent: string
    updated: number
    lowEnergy: number
    baseline: number
  } {
    const eff = this.effective(Date.now())
    return {
      enabled: this.enabled(),
      mood: eff.mood,
      energy: Math.round(eff.energy),
      lastEvent: eff.lastEvent,
      updated: this.state.updated,
      lowEnergy: this.config().lowEnergy,
      baseline: ENERGY_BASELINE,
    }
  }
}
