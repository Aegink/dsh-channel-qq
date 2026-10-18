import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import type { MemoryVectorConfig } from './config/sections/memory.js'
import type { SwitchSections } from './config/sections/switches.js'

/** Channel configuration. One row, one account. Values live in the profile's user patch layer. */
export interface ConnectionConfig {
  /** forward = the plugin dials NapCat's WS server; reverse = the plugin hosts a WS server NapCat dials into. */
  mode: 'forward' | 'reverse'
  /** forward: NapCat WS URL. reverse: listen URL, e.g. ws://127.0.0.1:8082 (port is the bind port). */
  url: string
}

export interface SegmentationConfig {
  enabled: boolean
  /** natural = 跟句号走; conservative = 太短的相邻句合并; active = 每句一条. */
  style: 'natural' | 'conservative' | 'active'
  /**
   * Sentences shorter than this are "tiny" for the `conservative` style, which
   * glues tiny neighbours into one message (`natural`/`active` ignore it).
   *
   * The field used to claim it gated ender-less texts, which the code never did
   * (an ender-less body is returned as one segment regardless), while the one
   * real threshold — the merge in `outbound.segmentReply` — was a hardcoded `8`.
   */
  minLength: number
  maxSegments: number
  removeTrailingPeriod: boolean
}

export interface PokeConfig {
  enabled: boolean
  /**
   * Coalescing window: pokes inside it collapse into one adjudication, so a
   * sticker-tap storm does not submit a turn per tap.
   *
   * `patience` and `pokeBack` used to live here — "how many pokes before 诺诺
   * reacts" and "poke the sender back". Adjudication mode removed auto-reaction
   * entirely (the plugin never pokes or speaks on its own; the model decides via
   * `qq_send_poke`), so both were read by nothing while still being rendered as
   * live controls in the admin panel. They are gone rather than left lying.
   */
  windowSec: number
}

export interface ImageConfig {
  /** Download inbound images and attach them to the model prompt (vision). */
  enabled: boolean
  /** Max images attached per message (extras stay noted as [图片]). */
  maxPerMessage: number
}

export interface GroupModelConfig {
  /** Group conversations run on this route; null = same as the default route. */
  provider: string | null
  model: string | null
}

export interface STTConfig {
  enabled: boolean
  /** OpenAI-compatible /audio/transcriptions base, e.g. https://host/v1 */
  baseUrl: string | null
  /** API key (plain, or $ENV to read from environment). */
  apiKey: string | null
  model: string
}

export interface BatchingConfig {
  /** Quiet-window: analyze the intake queue this long after the last message. */
  windowMs: number
  /** Flush early once this many lines accumulated. */
  maxMessages: number
  /** Flush early once this many characters accumulated. */
  maxChars: number
}

export interface InjectModeConfig {
  /** Bypass batching: every group message is injected into the agent context as it arrives. */
  enabled: boolean
  /** When the agent is idle, deliver immediately and wake it (steer) instead of parking it (inject). */
  wakeIdle: boolean
}

export interface EmojiConfig {
  /** Steal sticker images seen in the primary group into `dir`. */
  steal: boolean
  // `autoSend` / `autoSendProbability` were here: "after a reply, attach a random
  // registered sticker". Nothing ever read them — the plumbing was never written
  // — yet the admin panel rendered both as working switches. Removed so the panel
  // stops promising behaviour the plugin does not have. Stickers are sent when
  // the model asks, via `qq_send_sticker` / `qq_emoji_send`.
  /** Stolen/raw sticker directory (defaults to <dshHome>/channel-qq/emoji). */
  dir: string | null
  /** Registered sticker directory (defaults to <dshHome>/channel-qq/emoji-registered). */
  registeredDir: string | null
}

export interface KeywordReaction {
  keywords: string[]
  reaction: string
}

/** The 06:00 daily briefing. Every input is optional so a fresh deployment
 * never inherits another host's city or timetable file. */
export interface MorningReportConfig {
  enabled: boolean
  /** A wttr.in location string (e.g. `Lianjiang,Guangdong`), or null to skip weather. */
  weatherLocation: string | null
  /** Workspace-relative file holding the timetable text, or null to skip it. */
  scheduleFile: string | null
}

/** A periodic workspace script the scheduler runs and reports on. */
export interface CruiseTaskConfig {
  /** Stable id used for the once-per-interval bookkeeping. */
  id: string
  enabled: boolean
  /** Script path relative to the workspace. */
  script: string
  intervalMin: number
}

/** Admin/config UI: a password-gated HTTP panel. */
export interface AdminConfig {
  enabled: boolean
  /** Listen port. */
  port: number
  /**
   * Panel password.
   *
   * **Empty by default on purpose.** A shipped literal password is a published
   * credential — this panel can run workspace scripts and rewrite `AGENTS.md`,
   * so a default that is the same on every deployment is equivalent to no auth
   * at all. Prefer the environment (`CHANNEL_QQ_ADMIN_PASSWORD`, see
   * `admin.ts`); this field stays as the operator's own fallback for hosts that
   * have no env file. An empty password cannot log in (fail-closed) and forces
   * the listener onto loopback.
   */
  password: string
  /**
   * Bind address. **Only honoured when `CHANNEL_QQ_ADMIN_ALLOW_REMOTE=1`.**
   * The panel is a remote-control surface for the bot, so the default is
   * loopback + SSH tunnel; a persisted override must not be able to re-expose
   * it silently.
   */
  host: string
}

/** 高危群管动作（踢人 / 全员禁言 / 设管理员）的总开关。 */
export interface GroupAdminConfig {
  /**
   * Whether the destructive group-management tools may act.
   *
   * Default **false**. Those three tools take a target straight from the model,
   * and the model's input includes anything a group member types — so before
   * there is a trust tier (P6c), the only safe setting is off. 主人 can still
   * kick/mute by hand in the QQ client; nothing here removes that.
   */
  dangerous: boolean
}

/** Link card resolution (B站 / 网易云 / GitHub / 通用网页). */
export interface LinkResolveConfig {
  enabled: boolean
  /** Groups that get automatic link cards; empty = tools only, never automatic. */
  autoGroups: number[]
  /** Max links resolved per inbound message. */
  maxPerMessage: number
  /** Optional bilibili SESSDATA for higher rate limits and HD covers. */
  bilibiliCookie: string | null
}

/** Sticker meme maker (ffmpeg drawtext). */
export interface MemeConfig {
  enabled: boolean
  /** TTF/OTF used by drawtext; null = auto-detect an installed CJK font. */
  fontFile: string | null
  /** Output directory; null = <workspace>/downloads/memes. */
  dir: string | null
}

/** 群语录库. */
export interface QuoteConfig {
  enabled: boolean
  /** Storage directory; null = <workspace>/quotes. */
  dir: string | null
  /** Auto-capture messages that look like keepers. */
  autoCapture: boolean
}

/** edge-tts voice replies (free, no key, CPU-only). */
export interface TtsConfig {
  enabled: boolean
  /** edge-tts voice name, e.g. zh-CN-XiaoxiaoNeural. */
  voice: string
  /**
   * Which backend actually speaks.
   *
   * `auto` is the default because edge-tts is the best voice but its WebSocket
   * handshake is refused (HTTP 403) from most datacenter IPs, while the free
   * HTTP endpoints keep working there. `auto` tries edge first and falls back,
   * so a fresh deployment is never left with a TTS feature that silently cannot
   * produce audio.
   */
  provider: 'auto' | 'edge' | 'baidu' | 'google'
  /** edge-tts prosody knobs: rate/pitch/volume like "+10%", "-5Hz". */
  rate: string
  pitch: string
  volume: string
  /** Output directory; null = <dshHome>/channel-qq/tts. */
  dir: string | null
}

/** Natural-language reminders ("明天9点叫我"). */
export interface ReminderConfig {
  enabled: boolean
  /** Storage file; null = <workspace>/reminders.json. */
  file: string | null
}

/** One RSS/Atom feed bound to a room. */
export interface RssFeedConfig {
  id: string
  url: string
  /** Where new items go. */
  room: 'group' | 'dm'
  target: number
  enabled: boolean
  /** Last seen item guid; written back by the poller. */
  lastGuid: string | null
  title: string
}

export interface RssConfig {
  enabled: boolean
  pollIntervalMin: number
  /** Max items pushed per feed per poll. */
  maxPerPoll: number
  feeds: RssFeedConfig[]
}

/** 防刷屏风控. */
export interface FloodConfig {
  enabled: boolean
  windowSec: number
  maxMessages: number
  /** warn = 只在群里提醒; mute = 禁言; both = 提醒 + 禁言. */
  action: 'warn' | 'mute' | 'both'
  muteSeconds: number
  /** QQ numbers exempt from flood control (admins are always exempt). */
  exempt: number[]
}

/** 群内 AI 生图. */
export interface ImageGenConfig {
  enabled: boolean
  /** pollinations = 免 key 公开端点; openai = 任意 OpenAI 兼容 /images/generations. */
  provider: 'pollinations' | 'openai'
  baseUrl: string | null
  apiKey: string | null
  model: string
  width: number
  height: number
}

/** 群聊学习/口癖. */
export interface LearnConfig {
  enabled: boolean
  /** Learned-phrase store; null = <workspace>/learned-phrases.json. */
  file: string | null
  /** Passively collect candidate phrases from group traffic. */
  autoCapture: boolean
  /** Minimum occurrences before a phrase is offered to the model. */
  minOccurrences: number
}

/** 新记忆系统（P6e）：结构化记忆的检索、注入预算与向量检索参数（向量五项见 MemoryVectorConfig，字段说明在其本体处）。 */
export interface MemoryConfig extends MemoryVectorConfig {
  /** 关着时走旧的关键词知识库（entries.json）；打开后每回合注入结构化记忆证据。 */
  v2: boolean
  /** 检索分数阈值：低于它的证据不进注入包。 */
  threshold: number
  /** 每回合最多注入几条证据。 */
  maxRecords: number
  /** 每回合最多注入多少字。 */
  maxChars: number
}

/** 群事件监控 → 主动性话题素材. */
export interface EventMonitorConfig {
  enabled: boolean
  /** Which notice subtypes are fed to the agent. */
  kinds: string[]
  /** Coalesce window so a burst of events yields one adjudication. */
  windowSec: number
}

/** 上下文预算 (P2-2): step budget + context compaction. */
export interface ContextBudgetConfig {
  /** Max agent steps per turn; 0 = harness default. */
  maxSteps: number
  /** Compact the injected packet when it exceeds this many characters; 0 = off. */
  compactChars: number
}

/** 上下文 v2（P6b）：不可信信封 + 待回块；打开 = "指令层 + 信封 + 当前消息"结构 + AGENTS.md 受管区，关着时每包与旧行为逐字节一致。 */
export interface ContextV2Config {
  v2: boolean
}

/** 回合预算（P6b）：步数上限按会话类型分档；0 = 沿用 contextBudget.maxSteps。system 档为事件书 P6f 预留（当前无会话类型映射到它）。 */
export interface TurnConfig {
  maxSteps: { dm: number; group: number; system: number }
}

// 三个开关型段（policy / tools / proactive）的形状在本体处，见 switches.ts 的注记。
export interface QQChannelConfig extends SwitchSections {
  connection: ConnectionConfig
  accessToken?: string
  /** The bot's own QQ number, from NapCat lifecycle events or configured explicitly. */
  selfId: number
  /** QQ numbers allowed to use admin-flavoured tools. */
  admins: number[]
  /** Master switch for group-chat handling (DMs unaffected). */
  /** Loopback port of the master-only affection dashboard; 0 disables. */
  affectionPort: number
  groupEnabled: boolean
  /** The core group; talkValue/emoji/steal semantics key off it. */
  primaryGroup: number | null
  requireMention: boolean
  /** Base reply probability in groups; the primary group may override via primaryTalkValue. */
  talkValue: number
  primaryTalkValue?: number
  /** Workspace the QQ agents run in (main knowledge workspace). */
  workspacePath: string | null
  agentPreset: string
  permissionPreset: string
  rateLimitMs: number
  maxMessageLength: number
  segmentation: SegmentationConfig
  batching: BatchingConfig
  injectMode: InjectModeConfig
  imageRecognition: ImageConfig
  poke: PokeConfig
  stt: STTConfig
  groupModel: GroupModelConfig
  /** Additional group-level or user-level name triggers. */
  keywordTriggers: string[]
  keywordReactions: KeywordReaction[]
  morningReport: MorningReportConfig
  /** Periodic workspace scripts; empty by default so a bare deployment stays quiet. */
  cruises: CruiseTaskConfig[]
  emoji: EmojiConfig
  admin: AdminConfig
  linkResolve: LinkResolveConfig
  meme: MemeConfig
  quotes: QuoteConfig
  tts: TtsConfig
  reminders: ReminderConfig
  rss: RssConfig
  flood: FloodConfig
  imageGen: ImageGenConfig
  learn: LearnConfig
  memory: MemoryConfig
  eventMonitor: EventMonitorConfig
  contextBudget: ContextBudgetConfig
  context: ContextV2Config
  turn: TurnConfig
  groupAdmin: GroupAdminConfig
  debug: boolean
}

export { DEFAULT_CONFIG, resolveConfig } from './config/resolve.js'
// schema 的入口也从这里出：别处只会 `import { ... } from './config.js'`，
// 不需要知道它在 `config/` 目录下的哪个文件里。
export { SCHEMA, groupOf, sectionIds, type FieldSpec } from './config/schema.js'

/** Where the admin panel persists its overrides. */
export function adminOverridePath(dshHome: string): string {
  return path.join(dshHome, 'channel-qq', 'admin-config.json')
}

/**
 * Read the admin panel's persisted override layer.
 *
 * Synchronous on purpose: it runs once during plugin init, before the channel
 * starts, and a partial/ corrupt file must never take the boot down — an
 * unreadable override degrades to "no override", never to a crash.
 */
export function loadAdminOverride(dshHome: string): Partial<QQChannelConfig> {
  try {
    const raw = readFileSync(adminOverridePath(dshHome), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Partial<QQChannelConfig>
  } catch {
    return {}
  }
}
