/** 入站子插件（P5.1）：会话运行时（登记表 / 回合 / 通知 / 组包 / 流水线）、
 * QQ 事件分发、以及主 sent-log（工具面与后台都读它）。
 *
 * 装配工厂从 `src/plugin.ts` 搬来（那里的 `createRuntime()` 是 P3 拆 `bridge.ts`
 * 的产物；P5 把它收进本子插件）。事件分发原来长在 `ChannelQQ.onEvent` 里：
 * 旁路观察先跑（同步、发射后不管），通知走裁决，消息进流水线。
 */

import { ConversationRegistry } from '../../app/conversation/registry.js'
import { GatewayHealth } from '../../app/conversation/gateway-health.js'
import { PromptComposer } from '../../app/conversation/prompt-composer.js'
import { syncInstructionRegion } from './instruction-region.js'
import { TurnLauncher } from '../../app/conversation/turns.js'
import { InboundPipeline } from '../../app/inbound/pipeline.js'
import { NoticeHandler } from '../../app/inbound/notices.js'
import { PacketComposer } from '../../app/inbound/packet-composer.js'
import { compileSignatures, type OutputSignatureRules } from '../../core/injection/signatures.js'
import { RuleInjectionScanner } from '../../core/injection/scan.js'
import { createPolicyScreening, policyEnabled, TrustTrackingTurns, type PolicyScreening } from '../../app/policy/tool-policy.js'
import { turnTrust } from '../../core/trust.js'
import { createBlobStore } from '../../adapters/fs-store/blob-store.js'
import { findPackageRoot } from '../../adapters/persona/fs-pack.js'
import { systemClock, systemRandom } from '../../ports/clock.js'
import { systemHttp } from '../../adapters/http/client.js'
import { transcribeVoiceMessage } from '../../adapters/providers/stt.js'
import { createSentLogHub } from '../../sent-log.js'
import { readJson } from '../../read-json.js'
import { atomicWriteFile, readTextFileOrNull } from '../../adapters/fs-store/atomic.js'
import { announceToolsV2Switch, syncToolsRegion } from '../tools-v2/index.js'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OneBotEvent } from '../../types.js'
import type { InjectionScanner } from '../../ports/injection.js'
import type { ConversationRecord } from '../../app/conversation/registry.js'
import type { ComposeInput, DmComposeInput, InjectComposeInput, PacketComposerDeps } from '../../app/inbound/packet-composer.js'
import type { SentLogReader } from '../../app/conversation/turns.js'
import type { createAgentGateway } from '../../adapters/dsh-host/agents.js'
import type { QQChannelConfig } from '../../config.js'
import type { ChatPlatform } from '../../ports/platform.js'
import type { MemoryEvidence } from '../../ports/memory.js'
import type { GatewayErrorBus, SubHost, SubPlugin } from '../plugin-kit.js'
import { createAdminCommand, startReceiptPoller } from '../approval/index.js'
import { approvalEnabled } from '../approval/store.js'
export { syncInstructionRegion, writeInstructionRegion, type InstructionRegionStatus } from './instruction-region.js'

/** 组装出来的一套入站侧对象。 */
export interface ChannelRuntime {
  readonly registry: ConversationRegistry
  readonly turns: TurnLauncher
  readonly notices: NoticeHandler
  readonly pipeline: InboundPipeline
}

interface RuntimeDeps {
  readonly config: QQChannelConfig
  readonly platform: ChatPlatform
  readonly gateway: ReturnType<typeof createAgentGateway>
  readonly health: GatewayHealth
  readonly prompts: PromptComposer
  readonly log: (line: string) => void
  /** 每包的知识库召回（memory 子插件提供，晚于本插件挂载，所以是取值函数）。 */
  readonly knowledge: () => { readonly entries: unknown[]; search(q: string, top?: number): Array<{ content: string }> } | null
  /** 记忆证据（memory 子插件提供；没装就是 undefined，组包退回旧的关键词召回）。 */
  readonly memoryEvidence?: MemoryEvidence
  /** 语音转写（provider 的事，装配时从 stt 适配器接过来）。 */
  readonly transcribe: (messageId: number) => Promise<string | null>
  /** 注入特征扫描器（P6c；表坏掉时为 null = 不打标、不拦截）。 */
  readonly screen?: { readonly scanner: InjectionScanner | null }
  /** 取某个房间的出站消息日志（"她最近说过什么"）。文件位置是部署知识。 */
  readonly openSentLog: (room: string) => Promise<SentLogReader>
  /** 管理员本地命令（审批网关）；未启用的部署为 undefined。 */
  readonly adminCommand?: (text: string, userId: number) => Promise<string | null>
  /** 模型错误投递（换血看门狗消费）。 */
  readonly onGatewayError?: (room: string, detail: string) => void
}

/** 会话登记表：房间 → 会话，四条件路径共用同一份并发保护。 */
function createRegistry(deps: RuntimeDeps, gateway: ReturnType<typeof createAgentGateway>): ConversationRegistry {
  return new ConversationRegistry({
    gateway,
    health: deps.health,
    clock: systemClock,
    random: systemRandom,
    log: deps.log,
    config: () => deps.config,
    nudge: () => deps.prompts.gatewayNudge(),
    ...deps.onGatewayError === undefined ? {} : { onGatewayError: deps.onGatewayError },
  })
}

/** 发起回合：主动私聊 / 定时任务 / 后台指令，投递状态归回合账本。 */
function createTurns(registry: ConversationRegistry, deps: RuntimeDeps): TurnLauncher {
  // P6c：包装类在每次 submit 前把"发起人档位 + 包污点"落进信任账本（policy.v2 关着时直通）。
  return new TrustTrackingTurns({
    registry,
    prompts: deps.prompts,
    clock: systemClock,
    log: deps.log,
    config: () => deps.config,
    openSentLog: deps.openSentLog,
  }, {
    ledger: turnTrust,
    admins: () => deps.config.admins,
    enabled: () => policyEnabled(deps.config),
  })
}

/** 通知：戳一戳裁决与群事件合并。 */
function createNotices(registry: ConversationRegistry, turns: TurnLauncher, deps: RuntimeDeps): NoticeHandler {
  return new NoticeHandler({
    registry,
    turns,
    prompts: deps.prompts,
    platform: () => deps.platform,
    clock: systemClock,
    config: () => deps.config,
    log: deps.log,
  })
}

// ── 注入特征（P6c policy.v2） ────────────────────────────────────────────────

/** 规则表的加载结果：入站扫描器 + 出站规则；坏表加载不出来时整份为 null。 */
export interface SignatureBundle {
  readonly scanner: RuleInjectionScanner
  readonly output: OutputSignatureRules
}

/** 默认路径的加载缓存（规则表是发布物，运行中不重读；改规则要重启）。 */
let signaturesCache: { bundle: SignatureBundle | null } | null = null

/**
 * 读插件自带的注入特征表（`assets/injection/signatures.json`）并编译。
 *
 * 为什么读盘在这里（features 侧）：`src/core/` 是可重放层，不许碰文件（R8）。
 * **坏表绝不挡对话**：读不到、解析不了、版本不认识，一律降级为"没有规则"，
 * 记一行日志继续跑（规则表是第二道防线，不是对话的前置条件）。
 *
 * @param file 指定文件（测试用）；缺省走包内资产并缓存。
 */
export async function loadSignatureBundle(
  log: (line: string) => void,
  file?: string,
): Promise<SignatureBundle | null> {
  if (file === undefined && signaturesCache !== null) return signaturesCache.bundle
  // 包根的找法沿用 fs-pack 的向上查找：源码树 / lib / lib-test 三种深度都要能命中。
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url))) ?? '.'
  const target = file ?? path.join(root, 'assets', 'injection', 'signatures.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(target, 'utf8'))
  } catch (error) {
    log(`policy: 注入特征表读取失败（${target}），本次按没有规则处理：${error instanceof Error ? error.message : String(error)}`)
    if (file === undefined) signaturesCache = { bundle: null }
    return null
  }
  const compiled = compileSignatures(parsed)
  if (!compiled.ok) {
    log(`policy: 注入特征表未通过校验（${compiled.reason}），本次按没有规则处理`)
    if (file === undefined) signaturesCache = { bundle: null }
    return null
  }
  const bundle: SignatureBundle = {
    scanner: new RuleInjectionScanner(compiled.value.input),
    output: compiled.value.output,
  }
  if (file === undefined) signaturesCache = { bundle }
  return bundle
}

/**
 * 组包包装：`policy.v2` 打开时给三条入站路径（群攒批 / 私聊直投 / 注入）附上
 * 注入信号，并把本包的发送者污点预登记进回合账本（提交时与发起人档位合流）。
 * 关着时三条路径原样透传——扫描器一次都不被调用，输出与旧版逐字节一致。
 */
export class ScreeningPacketComposer extends PacketComposer {
  constructor(deps: PacketComposerDeps, private readonly screening: PolicyScreening) {
    super(deps)
  }

  override async compose(
    conversation: ConversationRecord,
    input: ComposeInput = {},
  ): Promise<{ text: string; imageRefs: unknown[] }> {
    const scan = this.screening.scan(conversation.queue.join('\n'))
    const result = await super.compose(conversation, this.screening.merge(input, scan))
    this.screening.stage(conversation.sessionId, result.text)
    return result
  }

  override async composeDm(conversation: ConversationRecord, input: DmComposeInput): Promise<string> {
    const scan = this.screening.scan(input.line ?? '')
    const result = await super.composeDm(conversation, this.screening.merge(input, scan))
    this.screening.stage(conversation.sessionId, result)
    return result
  }

  override composeInject(conversation: ConversationRecord, input: InjectComposeInput): string {
    const scan = this.screening.scan(input.body)
    const result = super.composeInject(conversation, this.screening.merge(input, scan))
    this.screening.stage(conversation.sessionId, result)
    return result
  }
}

/** 组装整套入站侧对象。 */
function createRuntime(deps: RuntimeDeps): ChannelRuntime {
  const gateway = deps.gateway
  const registry = createRegistry(deps, gateway)
  const turns = createTurns(registry, deps)
  const notices = createNotices(registry, turns, deps)
  const packets = new ScreeningPacketComposer({
    prompts: deps.prompts,
    clock: systemClock,
    config: () => deps.config,
    log: deps.log,
    knowledge: deps.knowledge,
    ...(deps.memoryEvidence === undefined ? {} : { memoryEvidence: deps.memoryEvidence }),
    sentBlockFor: (room: string) => turns.sentBlockFor(room),
  }, createPolicyScreening({
    enabled: () => policyEnabled(deps.config),
    scanner: () => deps.screen?.scanner ?? null,
    admins: () => deps.config.admins,
    ledger: turnTrust,
  }))
  const pipeline = new InboundPipeline({
    config: () => deps.config,
    registry,
    turns,
    prompts: deps.prompts,
    platform: () => deps.platform,
    gateway,
    // 收件箱与宿主的本机文件：IO 全在适配器里（app/ 不许碰 node:*，见 R8）。
    blobs: createBlobStore(() => deps.config.workspacePath ?? ''),
    http: systemHttp,
    clock: systemClock,
    random: systemRandom,
    health: deps.health,
    log: deps.log,
    transcribe: deps.transcribe,
    knowledge: deps.knowledge,
    packets,
    ...deps.adminCommand === undefined ? {} : { adminCommand: deps.adminCommand },
  })
  return { registry, turns, notices, pipeline }
}

/** 事件分发：旁路观察先跑（同步、发射后不管），通知进裁决，消息进流水线。 */
async function dispatch(host: SubHost, runtime: ChannelRuntime, event: OneBotEvent): Promise<void> {
  try {
    if (event.post_type === 'message' && event.message_type === 'group') {
      host.get('observers')?.observe(event)
    }
    if (event.post_type === 'notice') {
      await runtime.notices.handle(event)
      return
    }
    if (event.post_type !== 'message') return
    await runtime.pipeline.handle(event)
  } catch (error) {
    host.bridge.logHostError(`channel-qq: event handling failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 后台「机器人发送记录」资源：读 `<dshHome>/channel-qq/sent-*.json`。 */
function registerSendlResource(host: SubHost): void {
  host.registerResource('sendl', {
    label: '机器人发送记录',
    list: async () => {
      const dir = path.join(host.dshHome, 'channel-qq')
      const names = await fs.readdir(dir).catch(() => [] as string[])
      const out: Record<string, unknown> = {}
      for (const name of names) {
        if (!name.startsWith('sent-') || !name.endsWith('.json')) continue
        const entries = await readJson<unknown[]>(path.join(dir, name), [])
        out[name.replace('sent-', '').replace('.json', '')] = entries.slice(-30)
      }
      return out
    },
  })
}

/**
 * 记忆证据的**惰性**取值。装载表里 inbound 在 memory 之前，apply 时记忆插件还没
 * provide——从前这里是直接 `host.get(...)`，于是 `memory.v2` 打开后证据一次都没注入过
 * （2026-10-19 线上实测发现：两个回合的会话里没有任何「记忆检索」块）。
 *
 * 现在每次组包现查：晚挂的记忆插件、以及之后的重挂，都能立刻被读到。
 * 没装记忆服务时返回空串，组包会照旧退回旧知识库召回。
 */
export function lazyMemoryEvidence(host: { get(name: string): unknown }): (input: {
  readonly text: string; readonly room: string; readonly isGroup: boolean;
}) => Promise<string> {
  return async (input) => {
    const evidence = host.get('memoryEvidence') as
      | ((arg: typeof input) => Promise<string>) | undefined
    return evidence === undefined ? '' : await evidence(input)
  }
}

export const inboundPlugin: SubPlugin = {
  name: 'inbound',
  // context.v2 翻开关时要重写工作区 AGENTS.md 的指令受管区（组包行为是现取配置，不用重挂）。
  // tools.v2 同理：它决定受管区里的工具名，改开关后必须重写，否则 AGENTS.md 留着旧名字。
  watches: ['context.v2', 'tools.v2'],
  requires: ['platform', 'persona', 'observers'],
  async apply(host) {
    const { config } = host
    const parts = host.need('platform')
    const health = new GatewayHealth()
    // 换血看门狗订阅模型错误：inbound 提供、session-reset 消费（后者挂载更晚）。
    const gatewayErrors: GatewayErrorBus = {}
    host.provide('gatewayErrors', gatewayErrors)
    // 同一房间只建一次 sent-log；读写共用（写侧按房间记账见 messaging/tools.ts）。
    const sentLogHub = createSentLogHub(host.dshHome, host.log)
    // 注入特征表（P6c）：坏表/版本不认识 → 降级为"没有规则"，绝不挡对话（loader 内记日志）。
    const bundle = await loadSignatureBundle(host.log)
    host.log(bundle === null
      ? 'policy: 注入特征不可用（坏表或读不到），入站不打标、出站不拦特征'
      : `policy: 注入特征表已加载（入站规则 ${bundle.scanner.ruleCount} 条）`)
    const runtime = createRuntime({
      config,
      platform: parts.platform,
      gateway: host.bridge.agentGateway(),
      health,
      prompts: host.need('persona').composer,
      log: host.log,
      knowledge: () => host.get('knowledge')?.store ?? null,
      memoryEvidence: lazyMemoryEvidence(host),
      screen: { scanner: bundle === null ? null : bundle.scanner },
      transcribe: async (messageId: number) => {
        const result = await transcribeVoiceMessage(parts.api, config.stt, messageId, host.log)
        return result === null ? null : result[0]
      },
      openSentLog: (room: string) => sentLogHub.for(room),
      onGatewayError: (room, detail) => gatewayErrors.handler?.(room, detail),
      // 审批网关（默认关；CHANNEL_QQ_APPROVAL=1 时生效）。命令先于 agent 处理、不经模型。
      // 传取值函数而不是 `config.admins`：撤掉管理员后必须立刻失效。
      ...approvalEnabled() ? { adminCommand: createAdminCommand(() => host.config.admins, host.log) } : {},
    })
    host.provide('inbound', {
      registry: runtime.registry,
      turns: runtime.turns,
      notices: runtime.notices,
      pipeline: runtime.pipeline,
    })
    parts.client.on('event', (event: OneBotEvent) => {
      void dispatch(host, runtime, event)
    })
    // 主 sent-log：工具面（qq_search_history 等）与后台资源共用同一份。
    const primary = await sentLogHub.for(config.primaryGroup !== null ? `group-${config.primaryGroup}` : 'group-none')
    host.provide('sentLog', primary)
    host.provide('sentLogHub', sentLogHub)
    registerSendlResource(host)
    // 指令层与工具面的落点：两个受管区各随挂载同步一次（翻开关走 reload，不重挂子插件）。
    host.log(`instruction region (AGENTS.md): ${await syncInstructionRegion(host)}`)
    host.log(`tools region (AGENTS.md): ${await syncToolsRegion(host)}`)
    const stopApproval = approvalEnabled() ? startReceiptPoller(host) : undefined
    return () => { runtime.notices.dispose(); stopApproval?.() }
  },
  // context.v2 翻动时重写指令受管区；组包行为本身是现取配置，无需重挂。
  async reload(host) {
    return [`context.v2 → 指令受管区：${await syncInstructionRegion(host)}`]
  },
  // 与原实现一致：client.start() 之后立刻重挂历史会话（发射后不管）。
  start(host) {
    const registry = host.need('inbound').registry
    void (async () => {
      await registry.reattachAll()
      await announceToolsV2Switch(host, registry) // 切换日说明（tools.v2）：一次性，内部自行记日志
    })()
  },
}
