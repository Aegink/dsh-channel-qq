/** 组合根（P5.1–P5.5）：解析配置、挂子插件、按段热重载。
 *
 * 这里原来是 778 行的 god class；P5 之后只剩四件事：
 *   - 解析两层配置（cordis 行 → 后台落盘覆盖）并起日志出口；
 *   - 把 `sections.ts` 的装载表交给 `SectionHost`，每个子插件包成一个真 cordis
 *     fiber（生命周期归 fiber：卸载就是执行 apply 返回的 disposer）；
 *   - 把宿主能力（工具表 / agent 网关 / 预设与会话注册表）经 `HostBridge`
 *     转成结构化接缝——features/ 里因此看不到一行 `@deepseek-ai/*`；
 *   - 配置保存后的热重载入口 `applyEffects(patch)`：只有声明关心补丁路径的
 *     子插件会动作。
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { loadAdminOverride, resolveConfig, type QQChannelConfig } from './config.js'
import { resolveDshHome } from './paths.js'
import { createLogSink, createLogger, defaultLogFiles } from './adapters/log/logger.js'
import type { LogSink } from './ports/logger.js'
import { createAgentGateway } from './adapters/dsh-host/agents.js'
import { createProvidersSurface } from './adapters/dsh-host/providers.js'
import { agentRegistry, installToolGate, presetRegistry } from './adapters/dsh-host/services.js'
import { installSkills } from './adapters/dsh-host/skills.js'
import { createSessionSizeProbe } from './adapters/dsh-host/session-size.js'
import { guardTemplateKey, policyEnabled } from './app/policy/tool-policy.js'
import { toolsV2Enabled } from './features/tools-v2/index.js'
import { SendSignatureGuard } from './core/guards/output-signatures.js'
import { turnTrust } from './core/trust.js'
import { loadSignatureBundle } from './features/inbound/index.js'
import { createToolGateHooks, ToolGateController } from './features/qq-tools/register.js'
import type { AdminResource } from './admin.js'
import { SectionHost } from './features/plugin-kit.js'
import type { Dispose, HostBridge, SectionHostEnv, SubHost, SubPlugin } from './features/plugin-kit.js'
import { SECTION_PLUGINS } from './sections.js'

export class ChannelQQ extends Service {
  static inject = [
    'llm',
    'agents',
    'agentPresets',
    'agentDefaultModel',
    'permissionPresets',
    'sessionTitle',
    'workspaceRegistry',
    'tools',
    'attachments',
  ]

  private readonly config: QQChannelConfig
  private readonly log: (line: string) => void
  private readonly logSink: { sink: LogSink; start: () => Promise<void> }
  /** 后台资源表：子插件各自 `registerResource` 的**活对象**，直接交给面板。 */
  private readonly resources: Record<string, AdminResource> = {}
  private sections: SectionHost | null = null
  private gateway: ReturnType<typeof createAgentGateway> | null = null
  /** 工具闸门（P6c policy.v2 / P6d tools.v2）；两个开关都关着时恒为 null——一个监听器都不注册。 */
  private toolGate: ToolGateController | null = null

  constructor(ctx: ConstructorParameters<typeof Service>[0], config: unknown) {
    super(ctx, 'channelQQ')
    // Two config layers, lowest first: the cordis row's user patch, then the
    // admin panel's persisted override (see `resolveConfig` in config.ts).
    this.config = resolveConfig(config as Partial<QQChannelConfig>, loadAdminOverride(resolveDshHome()))
    // The harness console logger only surfaces warnings by default; mirror
    // channel activity to a file so connection and reply-capture issues stay
    // debuggable（文本行照旧写 `channel-qq.log`，并排写结构化 JSONL）。
    this.logSink = createLogSink({
      ...defaultLogFiles(resolveDshHome()),
      onError: (message: string) => { ctx.logger.warn(`channel-qq: log write failed: ${message}`) },
    })
    const logger = createLogger(this.logSink.sink, 'qq')
    this.log = (line: string) => {
      ctx.logger.info(`channel-qq: ${line}`)
      // 时间戳由 logger 统一生成（本地时间 + 显式偏移，不是 `toISOString()` 的 UTC）。
      logger.line(line)
    }
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    const config = this.config
    // 日志封顶：启动时各裁一次（见 adapters/log/logger.ts），失败不影响启动。
    await this.logSink.start()
    this.log(`starting (mode=${config.connection.mode}, url=${config.connection.url}, selfId=${config.selfId}, admin=${config.admin.enabled ? config.admin.port : 'off'})`)
    const sections = new SectionHost(this.environment())
    this.sections = sections
    // 先交出卸载器再装载：任何一段挂不上时，已经挂上的段仍会被逆序卸干净。
    yield async () => {
      this.toolGate?.stop()
      await sections.disposeAll()
    }
    await sections.mountAll(SECTION_PLUGINS)
    // 工具闸门（policy.v2 / tools.v2）：都默认关 ⇒ 这里一个监听器都不注册。
    await this.syncToolGate()
    // 全部装配完成后再按装载顺序跑 start 钩子：client.start → reattachAll →
    // scheduler.start → admin.start（与原实现一致）。
    await sections.startAll()
  }

  /**
   * Apply a config change to the running process（P5.2）。
   *
   * The panel has already merged the patch into the live config and written it
   * to disk before this runs; only the sub-plugins that declared the touched
   * dot-paths in their `watches` do anything. Returns one human-readable line
   * per action, shown in the panel's save notice.
   */
  async applyEffects(patch: Record<string, unknown>): Promise<string[]> {
    const notes = this.sections === null ? [] : await this.sections.reloadAffected(patch)
    // policy.v2 / tools.v2 可能刚被翻动：闸门的装/卸跟着开关走（幂等）。
    await this.syncToolGate()
    return notes
  }

  /**
   * 工具闸门（P6c `policy.v2` / P6d `tools.v2`）：任一开关打开时把
   * `tools/pre-execute` / `tools/post-execute` 挂上宿主，都关着时卸掉——
   * **都关着时一个监听器都不注册**。安装只发生在这里（模块级"闸门在位"
   * 标记的单一来源，见 tool-policy.ts）。
   */
  private async syncToolGate(): Promise<void> {
    const wanted = policyEnabled(this.config) || toolsV2Enabled(this.config)
    if (this.toolGate === null) {
      if (!wanted) return // 两个开关都关着：连规则表都不读
      const bundle = await loadSignatureBundle(this.log)
      this.toolGate = new ToolGateController({
        hooks: createToolGateHooks({
          trustOf: (sessionId) => turnTrust.get(sessionId),
          guardText: (reasonKey) => this.guardText(reasonKey),
          workspacePath: () => this.config.workspacePath,
          sendGuard: bundle === null ? null : new SendSignatureGuard(bundle.output),
          switches: {
            policyOn: () => policyEnabled(this.config),
            toolsOn: () => toolsV2Enabled(this.config),
            admins: () => this.config.admins,
          },
          log: this.log,
        }),
        install: (hooks) => installToolGate(this.ctx, hooks, this.log),
        log: this.log,
      })
    }
    this.toolGate.sync(wanted)
  }

  /** reason key → 人格包里的拒绝文案；缺一段文案时退回功能性说明（绝不因此拦断对话）。 */
  private guardText(reasonKey: string): string {
    const template = guardTemplateKey(reasonKey)
    const pack = this.sections?.get('persona')?.pack
    if (template !== null && pack !== undefined) {
      try {
        return pack.render(template)
      } catch {
        // 人格包缺这一段：用下面的通用说明兜底（reason key 照常带出，便于排查）。
      }
    }
    return `【策略】这个动作在当前回合被拦下了（${reasonKey}）。换个合规的做法，或先把情况告诉学弟。`
  }

  /** 子插件能看到的全部世界（契约见 `features/plugin-kit.ts`）。 */
  private environment(): SectionHostEnv {
    return {
      config: this.config,
      dshHome: resolveDshHome(),
      log: this.log,
      resources: this.resources,
      bridge: this.bridge(),
      scope: async (plugin, host) => await this.mountOne(plugin, host),
    }
  }

  /** 宿主能力 → 结构化接缝；`ctx` 的宿主形状只出现在这个文件里。 */
  private bridge(): HostBridge {
    return {
      toolHost: () => this.ctx,
      tagContext: () => this.ctx,
      agentGateway: () => (this.gateway ??= createAgentGateway(this.ctx, this.log)),
      presetRegistry: () => presetRegistry(this.ctx),
      agentRegistry: () => agentRegistry(this.ctx),
      // 技能：provider 注册与 `/name` 触发都在适配器里接宿主；
      // 宿主没装 skill 服务时 install 返回 undefined，技能功能降级但后台不挂。
      skillsHost: () => ({
        install: (provider, trigger, log) => installSkills(this.ctx, provider, trigger, log),
      }),
      // 会话换血看门狗：tokenMeter 的估算 + 路由模型声明的窗口。
      sessionSize: () => createSessionSizeProbe(this.ctx),
      providersSurface: () => createProvidersSurface({
        // settings / credentials 用 get（可选查询）：宿主没装这两个服务时整页降级，
        // 但不能拦启动——属性访问（ctx.settings）要求先 inject，没声明会直接抛
        // "cannot get property without inject"（2026-10-18 上线时踩过）。
        settings: this.ctx.get('settings'),
        credentials: this.ctx.get('credentials'),
        agentDefaultModel: this.ctx.agentDefaultModel,
      }),
      logHostError: (message: string) => { this.ctx.logger.error(message) },
      reloadSections: async (patch: Record<string, unknown>) => await this.applyEffects(patch),
    }
  }

  /** 一个子插件 = 一个 cordis fiber；卸载器（fiber.dispose）交回 SectionHost。 */
  private async mountOne(plugin: SubPlugin, host: SubHost): Promise<Dispose> {
    const fiber = this.ctx.plugin({
      name: `qq-${plugin.name}`,
      apply: (_inner: Context, _config: QQChannelConfig) => plugin.apply(host),
    }, this.config)
    await fiber
    return () => fiber.dispose()
  }
}
