/** 入站流水线：一条 QQ 消息 → 一包交给模型的内容。
 *
 * 阶段是固定的七步，顺序**不能重排**（每一步都依赖前一步的产物）：
 *
 *   1. **准入** —— 不是消息、群被关掉、认不出房间 → 直接丢；
 *   2. **解析** —— 消息段 → 文字 / @ / 引用 / 图片 / 文件（`core/message/parse`）；
 *   3. **取材** —— 语音转写、收文件、拉引用、下载图片（`inbound/attachments`）；
 *   4. **渲染** —— 一行给模型看的入站行（`core/message/render`）；
 *   5. **判定** —— 私聊直投；群聊按"叫咱 / 注入模式 / 攒批"分三条路（`core/trigger`）；
 *   6. **攒批** —— 条数 / 字数触顶或安静窗口到期就成包（`core/batching`）；
 *   7. **组包投递** —— 文案取自人格包，拼装在 `conversation/prompt-composer`。
 *
 * 它原来是 `bridge.ts` 里一个 1282 行的类，同时管着会话生命周期、通知裁决、
 * 定时任务与后台指令。那些现在各有归属（`conversation/registry`、`inbound/notices`、
 * `conversation/turns`），这里只剩**入站**这一件事。
 *
 * 副作用与时间都经端口注入（`Clock` / `Random` / `HttpClient` / `AgentGateway`），
 * 所以这一层没有 `node:*`，也不需要真的 QQ 或真的宿主就能跑（见 R8）。
 */

import type { OneBotEvent } from '../../types.js'
import { parseInbound, type ParsedInbound } from '../../core/message/parse.js'
import { renderMessageLine } from '../../core/message/render.js'
import { decideFlush, isBatchFull, queueChars, type FlushDecision } from '../../core/batching.js'
import { plannerAllows } from './planner-gate.js'
import { isCalled, reactionHintOf } from '../../core/trigger.js'
import { resolveRoomPolicy } from '../../core/room-policy.js'
import { roomOf } from '../../core/room.js'
import type { AgentGateway } from '../../ports/agent-gateway.js'
import type { BlobStore } from '../../ports/blob-store.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { HttpClient } from '../../ports/http.js'
import type { Clock, Random } from '../../ports/clock.js'
import type { GatewayHealth } from '../conversation/gateway-health.js'
import type { ConversationRecord as Conversation, ConversationRegistry } from '../conversation/registry.js'
import type { PromptComposer } from '../conversation/prompt-composer.js'
import type { TurnLauncher } from '../conversation/turns.js'
import { attachImages, fetchQuoted, receiveFiles, type AttachmentDeps } from './attachments.js'
import { userOrigin } from './origin.js'
import { PacketComposer, type KnowledgeSource } from './packet-composer.js'

/** 流水线用到的配置（实时读，后台改了立即生效）。 */
export interface PipelineConfig {
  readonly groupEnabled: boolean
  readonly requireMention: boolean
  readonly debug: boolean
  readonly injectMode: { readonly enabled: boolean; readonly wakeIdle: boolean }
  readonly imageRecognition: { readonly enabled: boolean; readonly maxPerMessage: number }
  readonly batching: { readonly windowMs: number; readonly maxMessages: number; readonly maxChars: number }
  readonly contextBudget: { readonly compactChars: number }
  /** 上下文 v2（P6b）；缺省视为关（部分配置构造的旧测试不必补字段）。 */
  readonly context?: { readonly v2: boolean }
  /** 群聊准入（P6g）；同样是可选——缺省 = 关，旧测试不必补字段。 */
  readonly planner?: { readonly enabled: boolean }
  /** 自己的号（判自环；旧配置构造里可能没有）。 */
  readonly selfId?: number
  readonly primaryGroup: number | null
  readonly primaryTalkValue?: number | null
  readonly talkValue: number
  readonly keywordTriggers: readonly string[]
  readonly keywordReactions: ReadonlyArray<{ keywords: string[]; reaction: string }>
}

/** 一包的素材（步骤 3 的产物）。 */
interface Materials {
  readonly voiceText: string | null
  readonly receivedFiles: string[]
  readonly quoted: string | null
  readonly imageRefs: unknown[]
}

export interface PipelineDeps {
  readonly config: () => PipelineConfig
  readonly registry: ConversationRegistry
  readonly turns: TurnLauncher
  readonly prompts: PromptComposer
  readonly platform: () => ChatPlatform
  readonly gateway: AgentGateway
  readonly blobs: BlobStore
  readonly http: HttpClient
  readonly clock: Clock
  /** 退避抖动用的随机源；注入进来才能重放。 */
  readonly random: Random
  readonly health: GatewayHealth
  readonly log: (line: string) => void
  /**
   * 语音转写：一条语音消息 → 文字（没配服务或失败时返回 null）。
   *
   * 由组合根提供：`stt.ts` 是 provider（P4 会搬进 `adapters/providers/`），
   * `app/` 只该认识这个函数签名。
   */
  readonly transcribe: (messageId: number) => Promise<string | null>
  /** 知识库自动召回（没接上时返回 null——它在 `Service.init` 后半段才造出来）。 */
  readonly knowledge: KnowledgeSource
  /** 组包器：队列 → 一包（图片封顶与上下文预算都在它那里）。 */
  readonly packets: PacketComposer
  /**
   * 管理员本地命令（「待批 / 申请 / 批准 / 拒绝」）：先于 agent、不经模型。
   * 返回 null 表示不是命令，照常交给 agent。
   */
  readonly adminCommand?: (text: string, userId: number) => Promise<string | null>
}

export class InboundPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  /** 知识库召回（转发给组包器；流水线自己不关心它怎么算）。 */
  private knowledgeHint(text: string): string {
    return this.deps.packets.knowledgeOf(text)
  }

  /** STT 一条语音消息；失败只记日志，从不致命。 */
  private async transcribeVoice(event: OneBotEvent, parsed: ParsedInbound): Promise<string | null> {
    if (parsed.recordCount === 0 || typeof event.message_id !== 'number') return null
    try {
      const text = await this.deps.transcribe(event.message_id)
      if (text === null) return null
      this.deps.log(`voice ${event.message_id} transcribed: ${text.slice(0, 60)}`)
      return text
    } catch (error) {
      this.deps.log(`voice ${event.message_id} STT failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** 步骤 1：这条事件该不该进流水线（群聊按"这个群自己的开关"判）。 */
  private admits(event: OneBotEvent): boolean {
    if (event.post_type !== 'message' || event.message_type === undefined) return false
    if (event.message_type === 'group' && !resolveRoomPolicy(this.deps.config(), event.group_id ?? null).enabled) return false
    return true
  }

  /** 步骤 2+3：解析之后的取材（语音、文件、引用、图片）。 */
  private async gather(event: OneBotEvent, parsed: ParsedInbound): Promise<Materials> {
    const attachments: AttachmentDeps = {
      api: this.deps.platform().api,
      http: this.deps.http,
      gateway: this.deps.gateway,
      blobs: this.deps.blobs,
      config: () => this.deps.config(),
      log: this.deps.log,
    }
    // 语音条 → 文字，好让模型听见说了什么。
    const voiceText = await this.transcribeVoice(event, parsed)
    // 私聊里的文件落进工作区收件箱，交给 agent 处理。
    const receivedFiles = await receiveFiles(attachments, parsed, this.deps.clock.now())
    // 灵活引用上下文 + 视觉附件，两条路都要用。
    const quoted = await fetchQuoted(attachments, event, parsed)
    const imageRefs = await attachImages(attachments, parsed.imageUrls)
    return { voiceText, receivedFiles, quoted, imageRefs }
  }

  /**
   * 步骤 4：渲染一行入站行。
   *
   * 这个包装只做两件事：把配置翻译成"语气提示"，把"现在"取出来——两者都是副作用，
   * 而渲染本身是 `core/message/render.ts` 里的纯函数（黄金快照钉住它）。
   */
  private lineFor(
    event: OneBotEvent,
    parsed: ParsedInbound,
    called: boolean,
    quoted: string | null,
    voiceText: string | null = null,
    receivedFiles: string[] = [],
  ): string | null {
    return renderMessageLine({
      event,
      parsed,
      called,
      quoted,
      voiceText,
      receivedFiles,
      // 语气提示只在被叫到时才查：它会把模型带到某种语气上，混进无关消息里就是事故。
      reactionHint: called ? reactionHintOf(this.deps.config(), event) : null,
      nowMs: this.deps.clock.now(),
    })
  }

  /** 一条入站消息。 */
  async handle(event: OneBotEvent): Promise<void> {
    if (!this.admits(event)) return
    const key = roomOf(event)
    if (key === null) return
    const parsed = parseInbound(event)
    // 管理员本地命令：私聊、先于 agent、不经模型。命中就回一条、不进队列。
    if (event.message_type === 'private' && this.deps.adminCommand !== undefined) {
      const reply = await this.deps.adminCommand(parsed.plainText, event.user_id ?? 0)
      if (reply !== null) { await this.deps.platform().api.sendPrivateMessage(event.user_id ?? 0, [{ type: 'text', data: { text: reply } }]); return }
    }
    const materials = await this.gather(event, parsed)
    // 私聊直投：一条消息，一次分析。
    if (event.message_type === 'private') return await this.deliverDm(key, event, parsed, materials)
    return await this.deliverGroup(key, event, parsed, materials)
  }

  /** 私聊：不攒批、不看概率，直接成包。 */
  private async deliverDm(
    key: string,
    event: OneBotEvent,
    parsed: ParsedInbound,
    materials: Materials,
  ): Promise<void> {
    const line = this.lineFor(event, parsed, true, materials.quoted, materials.voiceText, materials.receivedFiles)
    if (line === null && materials.imageRefs.length === 0 && materials.receivedFiles.length === 0) return
    const conversation = await this.deps.registry.ensure(key, event)
    this.deps.turns.submit(
      conversation,
      // 组包统一经 PacketComposer：`context.v2` 的分支只剩组包器一处。
      this.deps.packets.composeDm(conversation, {
        line,
        knowledgeHint: this.knowledgeHint(parsed.plainText),
      }),
      materials.imageRefs,
      userOrigin(event),
    )
  }

  /** 群聊：叫咱就立刻分析，开了注入模式就逐条注入，否则攒批。 */
  private async deliverGroup(
    key: string,
    event: OneBotEvent,
    parsed: ParsedInbound,
    materials: Materials,
  ): Promise<void> {
    const conversation = this.deps.registry.getOrCreate(key, event)
    conversation.lastEvent = event
    const config = this.deps.config()
    const policy = resolveRoomPolicy(config, event.group_id ?? null)
    const called = isCalled(event, parsed, config)

    // P6g 群聊准入（默认关）：被挡下的消息不进队列，每一条都写清理由。
    if (!plannerAllows(this.deps, key, event, parsed, called, policy.requireMention)) return

    // "需要 @ 才回"：不认这个开关的话，她会在没人叫的时候按概率往群里说话，
    // 群友读起来就是"答非所问"。环境消息仍会被学习 / 风控 / 链接观察看到。
    if (policy.requireMention && !called) {
      if (config.debug) this.deps.log(`ignored group message (requireMention, not called) ${key}`)
      return
    }
    const line = this.lineFor(event, parsed, called, materials.quoted, materials.voiceText, materials.receivedFiles)
    if (config.injectMode.enabled) {
      await this.injectNow(conversation, event, line, materials.imageRefs, called)
      return
    }
    await this.enqueue(conversation, event, line, materials.imageRefs, called)
  }

  /** 注入模式：这条消息立刻进 agent 上下文，不走攒批也不看概率。 */
  private async injectNow(
    conversation: Conversation,
    event: OneBotEvent,
    line: string | null,
    imageRefs: readonly unknown[],
    called: boolean,
  ): Promise<void> {
    if (line === null && imageRefs.length === 0) return
    // 历史里每一张附件都会在**每个后续请求**里重放，而 provider 对每请求的图片数
    // 有上限（当前池子约 16 张）。所以只在直接被叫到时带图（且不在跑回合时），
    // 平时群聊里的图靠 `[图片含义]` 文本摘要。
    const deliverImages = (called && !conversation.tracker.running())
      ? imageRefs.slice(0, Math.max(1, this.deps.config().imageRecognition.maxPerMessage))
      : []
    const parts: string[] = []
    if (line !== null) parts.push(line)
    if (deliverImages.length > 0) parts.push(this.deps.prompts.imageNote())
    if (parts.length === 0) return
    const prompt = this.deps.packets.composeInject(conversation, {
      called,
      body: parts.join('\n'),
    })
    try {
      if (conversation.session === null) await this.deps.registry.ensure(conversation.key, event)
      this.deps.turns.submit(conversation, prompt, deliverImages, userOrigin(event))
    } catch (error) {
      this.deps.log(`inject deliver failed: ${String(error)}`)
    }
  }

  /**
   * 攒批：入队、去重、够数就发、否则起安静窗口。
   *
   * `calledLine` 在 P6b 接线：每次入队记录"最后一条是不是叫咱"（旧实现该标记从不
   * 置真、是走不到的死分支）。消费方是组包器，且只在 `context.v2` 打开时读它——
   * 关着时输出与旧行为逐字节一致。
   *
   * 是 `async` 而且**要 await**：被叫到的那条必须在这一步就把包发出去，
   * 否则调用方（与它后面的黄金快照）会看到一个"什么都没发生"的回合。
   */
  private async enqueue(
    conversation: Conversation,
    event: OneBotEvent,
    line: string | null,
    imageRefs: readonly unknown[],
    called: boolean,
  ): Promise<void> {
    if (line !== null) conversation.queue.push(line)
    if (imageRefs.length > 0) {
      const cap = this.deps.config().imageRecognition.maxPerMessage
      conversation.pendingImages.push(...imageRefs.slice(-cap))
    }
    // 跨窗口去重：同一个 QQ 消息号绝不入队两次（NapCat 重试与窗口回显会重复）。
    if (typeof event.message_id === 'number') {
      if (!conversation.seenMessageIds) conversation.seenMessageIds = new Set()
      if (conversation.seenMessageIds.has(event.message_id)) return
      if (conversation.seenMessageIds.size > 500) {
        conversation.seenMessageIds = new Set([...conversation.seenMessageIds].slice(-250))
      }
      conversation.seenMessageIds.add(event.message_id)
    }

    conversation.calledLine = called
    if (called) {
      // 跳过安静窗口：立刻分析，已入队的上下文一并带上。
      await this.flushNow(conversation, { immediate: true })
      return
    }
    if (conversation.queue.length === 0) return
    if (isBatchFull(conversation.queue, this.deps.config().batching)) {
      const { length } = conversation.queue
      this.deps.log(`batch full (${length} lines, ${queueChars(conversation.queue)} chars) — analyzing`)
      await this.flushNow(conversation, { immediate: false })
      return
    }
    this.scheduleBatch(conversation)
  }

  /** 重新武装安静窗口定时器。 */
  private scheduleBatch(conversation: Conversation): void {
    const windowMs = this.deps.config().batching.windowMs
    conversation.batchTimer?.cancel()
    conversation.batchTimer = this.deps.clock.setTimeout(() => {
      conversation.batchTimer = null
      void this.flushNow(conversation, { immediate: false }).catch((error: Error) => {
        this.deps.log(`batch flush failed: ${String(error)}`)
      })
    }, windowMs)
  }

  /**
   * 攒批闸门：把"现在几点、忙不忙、骰子面值"取出来，裁决交给 `core/batching.ts`。
   *
   * 四种分支（空包 / 忙 / 退避中 / 骰子没中）原本内联在 flush 里，只能靠跑真消息
   * 观察；搬成纯函数之后它们可以逐条测，而这里只剩"取值"这一件事。
   */
  private flushGate(conversation: Conversation, immediate: boolean): FlushDecision {
    return decideFlush({
      lines: conversation.queue.length,
      images: conversation.pendingImages.length,
      busy: conversation.tracker.busy(),
      immediate,
      nowMs: this.deps.clock.now(),
      backoffUntilMs: this.deps.health.deadline(),
      chance: resolveRoomPolicy(this.deps.config(), conversation.isGroup ? conversation.chatId : null).talkValue,
      roll: () => this.deps.random.next(),
    })
  }

  /**
   * 把入队的内容分析成一包。
   *
   * `immediate`（被叫到）跳过等待与概率闸门；**正在跑的回合不被打断**——一批会等它
   * 空下来再发，而不是排在它后面，那正是我们要躲开的堆积。
   */
  private async flushNow(conversation: Conversation, opts: { immediate: boolean }): Promise<void> {
    conversation.batchTimer?.cancel()
    conversation.batchTimer = null
    if (conversation.queue.length === 0 && conversation.pendingImages.length === 0) return
    if (conversation.tracker.busy() && !opts.immediate) {
      // 有回合在跑或有网关重试已武装：等它结束再看，而不是排队或重置重试链。
      this.scheduleBatch(conversation)
      return
    }
    const decision = this.flushGate(conversation, opts.immediate)
    if (decision.kind === 'empty') return
    // 忙或退避中：重新起一个安静窗口，而不是排队——排队就是我们要躲开的堆积。
    if (decision.kind === 'defer') { this.scheduleBatch(conversation); return }
    if (decision.kind === 'drop') {
      conversation.queue = []
      conversation.pendingImages = []
      conversation.calledLine = false
      this.deps.log(`batch of ${decision.lines} dropped by talk chance`)
      return
    }
    const packet = await this.deps.packets.compose(conversation)
    try {
      if (conversation.session === null) {
        await this.deps.registry.ensure(conversation.key, conversation.lastEvent)
      }
      this.deps.turns.submit(conversation, packet.text, packet.imageRefs, userOrigin(conversation.lastEvent))
    } catch (error) {
      this.deps.log(`bridge followup failed: ${String(error)}`)
    }
  }

}


