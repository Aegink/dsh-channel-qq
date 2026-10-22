/** 访问门控（安全）：谁能触发 agent。
 *
 * 判定发生在**入站分发最前面**：不通过的消息既不进组包、也不进 agent，
 * 只按模式回一句「待主人批准」并记一条待批请求。
 *
 * 三个模式见 `config/sections/access.ts`；管理员始终允许（否则主人会被自己锁在外面）。
 */

import type { OneBotEvent } from '../../types.js'
import type { QQChannelConfig } from '../../config.js'
import type { PersonaPack } from '../../ports/persona.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import type { AccessKind, AccessStore } from './store.js'

export interface AccessDeps {
  readonly api: () => QQApi | null
  readonly out: () => OutboundQueue | null
  readonly persona: () => PersonaPack | null
  readonly config: () => QQChannelConfig['access']
  readonly admins: () => readonly number[]
  readonly store: AccessStore
  readonly now: () => number
  readonly log: (line: string) => void
}

export class AccessService {
  constructor(private readonly deps: AccessDeps) {}

  /** 这条事件能不能进 agent；不通过时负责回「待批准」与通知主人。 */
  allow(event: OneBotEvent): boolean {
    if (event.post_type !== 'message' && event.post_type !== 'notice') return true
    // 自己发的消息（协议端回显）永远放行，否则未批准的群里会被自己的回声触发配对。
    if (event.user_id !== undefined && event.user_id === event.self_id) return true
    const config = this.deps.config()
    if (config.mode === 'open') return true
    const isGroup = event.message_type === 'group'
      || (event.post_type === 'notice' && typeof event.group_id === 'number')
    const id = isGroup ? event.group_id : event.user_id
    if (typeof id !== 'number') return true
    if (isGroup ? this.groupAllowed(id, config) : this.userAllowed(id, config)) return true
    if (config.mode === 'pairing') {
      void this.request(isGroup ? 'group' : 'user', id, this.nameOf(event, isGroup), event)
    } else {
      this.deps.log(`access: 拒绝 ${isGroup ? 'group' : 'user'} ${id}（allowlist 未命中）`)
    }
    return false
  }

  /** 批准并通知对方。 */
  async approve(kind: AccessKind, id: number): Promise<{ ok: true }> {
    await this.deps.store.approve(kind, id)
    this.deps.log(`access: approved ${kind} ${id}`)
    this.send(id, kind, 'access/approved')
    return { ok: true }
  }

  /** 拒绝（只移除请求，不回消息）。 */
  async reject(kind: AccessKind, id: number): Promise<{ ok: true }> {
    await this.deps.store.reject(kind, id)
    this.deps.log(`access: rejected ${kind} ${id}`)
    return { ok: true }
  }

  list(): { mode: string; users: readonly number[]; groups: readonly number[]; pending: readonly unknown[] } {
    return {
      mode: this.deps.config().mode,
      users: this.deps.store.users(),
      groups: this.deps.store.groups(),
      pending: this.deps.store.pending(),
    }
  }

  private userAllowed(id: number, config: QQChannelConfig['access']): boolean {
    return this.deps.admins().includes(id) || config.allowUsers.includes(id) || this.deps.store.userApproved(id)
  }

  private groupAllowed(id: number, config: QQChannelConfig['access']): boolean {
    return config.allowGroups.includes(id) || this.deps.store.groupApproved(id)
  }

  private nameOf(event: OneBotEvent, isGroup: boolean): string {
    if (isGroup) return `群 ${String(event.group_id ?? '')}`
    return event.sender?.card ?? event.sender?.nickname ?? ''
  }

  /** 记请求、按冷却回一句、只在首次通知主人。 */
  private async request(kind: AccessKind, id: number, name: string, event: OneBotEvent): Promise<void> {
    const now = this.deps.now()
    const cooldown = Math.max(1, this.deps.config().replyCooldownMin) * 60_000
    const existing = this.deps.store.pending().find((item) => item.kind === kind && item.id === id)
    const shouldReply = existing === undefined || now - existing.lastNoticeAt >= cooldown
    const { isNew } = await this.deps.store.request(kind, id, name, now)
    if (isNew) this.deps.log(`access: pending ${kind} ${id}${name === '' ? '' : ` (${name})`}`)
    if (shouldReply) this.replyPending(kind, id, event)
    if (isNew && this.deps.config().notifyOwner) this.notifyOwner(kind, id, name)
  }

  private replyPending(kind: AccessKind, id: number, event: OneBotEvent): void {
    const isGroup = kind === 'group' || event.message_type === 'group'
    this.send(id, isGroup ? 'group' : 'user', 'access/pending')
  }

  private notifyOwner(kind: AccessKind, id: number, name: string): void {
    const owner = this.deps.admins()[0]
    const api = this.deps.api()
    const out = this.deps.out()
    if (owner === undefined || api === null || out === null) return
    if (kind === 'user' && owner === id) return
    const cmd = kind === 'group' ? `放行群 ${id}` : `放行 ${id}`
    const text = `新的访问请求：${kind === 'user' ? 'QQ' : '群'} ${id}${name === '' ? '' : `（${name}）`}。`
      + `回复「${cmd}」或在后台「安全」页批准。`
    void out.push(() => api.sendPrivateMessage(owner, [{ type: 'text', data: { text } }]))
      .catch((error: unknown) => this.deps.log(`access: 通知主人失败：${error instanceof Error ? error.message : String(error)}`))
  }

  private send(id: number, kind: 'user' | 'group', key: string): void {
    const api = this.deps.api()
    const out = this.deps.out()
    const persona = this.deps.persona()
    if (api === null || out === null || persona === null) return
    let text = ''
    try {
      text = persona.render(key).trim()
    } catch (error) {
      this.deps.log(`access: 人格包缺 ${key}：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (text === '') return
    const message = [{ type: 'text' as const, data: { text } }]
    void out.push(() => kind === 'user' ? api.sendPrivateMessage(id, message) : api.sendGroupMessage(id, message))
      .catch((error: unknown) => this.deps.log(`access: 回复 ${kind} ${id} 失败：${error instanceof Error ? error.message : String(error)}`))
  }
}
