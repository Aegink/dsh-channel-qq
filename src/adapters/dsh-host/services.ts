/** 宿主服务的"接线面"：tools / agentPresets / agents / llm，以及工具闸门的事件接缝。
 *
 * 与 `agent.ts` 同一件事，只是对象不同：宿主把服务挂在 `ctx` 上，但类型是
 * 可选的（不同 profile 装的服务不一样）。业务代码不该关心"这台机器上装没装"，
 * 只该拿到 `undefined` 然后决定降级还是继续——这个"取服务"的动作收在这里，
 * "宿主长什么样"的知识也就只出现在这个目录里。
 *
 * 每个取值都**不抛错**：拿不到服务是一等公民（不是异常路径），调用方据此降级。
 * 这些接口刻意写得窄（只声明本项目真正用到的那几个方法）：宿主加了新方法我们
 * 也不需要知道，缩窄比放宽更容易在宿主升级时发现变化。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentsService } from '../../services.js'

/** `ctx.tools` —— 全局工具注册表。 */
export interface ToolRegistry {
  register(definition: Record<string, unknown>): () => void
}

/** `ctx.agentPresets` —— 人格预设注册表。 */
export interface PresetRegistry {
  list(): Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>
  readDocument(
    agentPreset: string,
  ): Promise<{ agentPreset: string; content: string; name?: string; description?: string }>
  resolve(id?: string): Promise<{ id: string }>
}

/** `ctx.agents` —— 会话注册表；只用来看某个会话是否还活着。 */
export interface AgentRegistry {
  get(id: unknown): { dispose?: () => Promise<void> } | undefined
}

/** `ctx.llm.stream()` 返回的流：只需要按块迭代出文本。 */
export type LlmStream = AsyncIterable<{ text?: string }>

/** LLM 接缝：直接发一次补全（表情包打标），以及当前的默认选型。 */
export interface LlmSeam {
  llm?: { stream(options: Record<string, unknown>): LlmStream }
  agentDefaultModel?: { currentSelection(): { provider: string; model: string } }
  /**
   * 视觉消息要用的附件存储。`llm.stream` 的 content block 是**宿主形状**
   * `{type:'image', attachment}`（附件由 `ctx.attachments.saveImage` 落盘），
   * 不是 OpenAI 的 `image_url`——给错形状模型会回「未收到图片」。
   */
  attachments?: AttachmentsService
}

/** 全局工具注册表；这台机器没装 tools 服务时为 undefined。 */
export function toolRegistry(ctx: Context): ToolRegistry | undefined {
  return (ctx as unknown as { tools?: ToolRegistry }).tools
}

/** 人格预设注册表。 */
export function presetRegistry(ctx: Context): PresetRegistry | undefined {
  return (ctx as unknown as { agentPresets?: PresetRegistry }).agentPresets
}

/** 会话（agent）注册表。 */
export function agentRegistry(ctx: Context): AgentRegistry | undefined {
  return (ctx as unknown as { agents?: AgentRegistry }).agents
}

/** LLM 接缝。 */
export function llmSeam(ctx: Context): LlmSeam {
  return ctx as unknown as LlmSeam
}

// ── 工具闸门（P6c policy.v2 的宿主接缝） ─────────────────────────────────────

/** 一次工具执行的只读快照（宿主 `ToolExecution` 里我们用到的那几个字段）。 */
export interface HostToolCall {
  readonly name: string
  readonly args: unknown
  /** `exec.agent.id`：替哪个 agent 跑这次调用；我们的 QQ 会话形如 `qq-group-<群号>`。 */
  readonly agentId: string | undefined
}

/** 闸门裁决：pass 继续瀑布；deny 作为工具错误交给模型（理由要能读、能照做）。 */
export type HostToolDecision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'deny'; readonly reason: string }

/** 闸门本体（两个回调都由 `app/policy/tool-policy.ts` 提供）。 */
export interface HostToolGate {
  decide(call: HostToolCall): HostToolDecision
  record(call: HostToolCall, ok: boolean): void
}

/** `ctx.on()` 的最小形状；监听器的具体签名由宿主的 Events 表决定，这里只负责注册。 */
interface HostEventSeam {
  on?(event: string, listener: (...args: never) => unknown, options?: { prepend?: boolean }): unknown
}

/** 宿主 `ToolExecution` 上我们读的三个字段（缺一个都不抛，读不到就是 undefined）。 */
interface HostToolExecutionShape {
  readonly name?: unknown
  readonly arguments?: unknown
  readonly agent?: { readonly id?: unknown } | undefined
}

function readToolCall(exec: unknown): HostToolCall {
  const shape = (exec ?? {}) as HostToolExecutionShape
  const agent = shape.agent
  return {
    name: typeof shape.name === 'string' ? shape.name : '',
    args: shape.arguments,
    agentId: typeof agent?.id === 'string' ? agent.id : undefined,
  }
}

function runDisposer(off: unknown): void {
  if (typeof off === 'function') (off as () => void)()
  else if (off !== null && typeof off === 'object' && typeof (off as { dispose?: unknown }).dispose === 'function') {
    (off as { dispose: () => void }).dispose()
  }
}

/**
 * 把工具闸门挂上宿主的 `tools/pre-execute`（瀑布：放行要 `return next()`，拒绝返回
 * `{ kind:'deny', reason }`——模型据此改正）与 `tools/post-execute`（只记账、永远
 * `next()`）。`policy.v2` 关着时**不要调用**：关着时一个监听器都不许注册。
 *
 * @returns 卸载器；宿主没有事件接缝（或注册抛错）时返回 null——调用方据此把
 *          高危动作交回旧总闸门（fail-closed，而不是放行）。
 */
export function installToolGate(ctx: Context, gate: HostToolGate, log: (line: string) => void): (() => void) | null {
  const seam = ctx as unknown as HostEventSeam
  if (typeof seam.on !== 'function') return null
  try {
    const offPre = seam.on('tools/pre-execute', (exec: unknown, next: () => Promise<unknown>) => {
      let decision: HostToolDecision
      try {
        decision = gate.decide(readToolCall(exec))
      } catch (error) {
        // 闸门自己坏了也不能变成"所有工具都放行"：fail-closed，并把原因记全。
        log(`policy: 闸门判定异常，按拒绝处理：${error instanceof Error ? error.message : String(error)}`)
        return { kind: 'deny', reason: '工具策略内部异常，这次调用先被拦下了（fail-closed）。' }
      }
      if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
      return next()
    })
    const offPost = seam.on('tools/post-execute', (exec: unknown, result: unknown, next: () => Promise<unknown>) => {
      try {
        const isError = (result as { isError?: unknown } | null)?.isError === true
        gate.record(readToolCall(exec), !isError)
      } catch (error) {
        // 记账失败只影响出站复读判据的精度，绝不能把一次成功的调用变成错误。
        log(`policy: 闸门记账异常（已忽略）：${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    })
    return () => { runDisposer(offPre); runDisposer(offPost) }
  } catch (error) {
    log(`policy: 安装工具闸门失败：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
