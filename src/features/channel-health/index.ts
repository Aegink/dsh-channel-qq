/** 渠道健康告警子插件：WS 断线超过阈值时私聊管理员。
 *
 * 补的缺口：QQ 掉线时插件只会闷头重连，无人知晓。本插件每分钟核一次
 * 「WS 是否连着 + 是否还有心跳」，超过阈值仍不通就私聊管理员一句；
 * 恢复后再报一句，并对同一场故障限频（默认 30 分钟），不刷屏。
 *
 * 边界：只新增一个守望循环，不动授权面、不动沙箱、不发群。
 * 默认关：`channelHealth.enabled` 为 false 时不启动定时器。
 */

import type { OneBotClient } from '../../onebot.js'
import type { QQApi } from '../../ports/platform.js'
import type { OutboundQueue } from '../../outbound.js'
import type { SubPlugin } from '../plugin-kit.js'

const DEFAULT_THRESHOLD_MS = 90 * 1000
const DEFAULT_REALERT_MS = 30 * 60 * 1000

export interface ChannelHealthOptions {
  client: OneBotClient
  api: QQApi
  out: OutboundQueue
  enabled: () => boolean
  admins: () => readonly number[] | null | undefined
  log: (line: string) => void
  thresholdMs?: number
  realertMs?: number
}

export class ChannelHealthMonitor {
  private readonly client: OneBotClient
  private readonly api: QQApi
  private readonly out: OutboundQueue
  private readonly enabled: () => boolean
  private readonly admins: () => readonly number[] | null | undefined
  private readonly log: (line: string) => void
  private readonly thresholdMs: number
  private readonly realertMs: number
  private timer: NodeJS.Timeout | null = null
  private alerting = false
  private lastAliveAt = Date.now()
  private lastAlertAt = 0

  constructor(opts: ChannelHealthOptions) {
    this.client = opts.client
    this.api = opts.api
    this.out = opts.out
    this.enabled = opts.enabled
    this.admins = opts.admins
    this.log = opts.log
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS
    this.realertMs = opts.realertMs ?? DEFAULT_REALERT_MS
  }

  start(): void {
    if (this.timer !== null) return
    if (!this.enabled()) return
    // 起手宽限：让它跑满一个阈值再判，避免刚启动就误报。
    this.lastAliveAt = Date.now()
    this.timer = setInterval(() => { void this.tick() }, 60_000)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** 入站事件到达即视为活；由 inbound 在事件分发时回调。 */
  onInbound(): void {
    this.lastAliveAt = Date.now()
    if (this.alerting) {
      this.alerting = false
      this.lastAlertAt = 0
      this.log('health: 渠道已恢复，告警解除')
      this.notice('渠道已恢复（WS 重连且心跳正常），告警解除。')
    }
  }

  async tick(): Promise<void> {
    if (!this.enabled()) return
    if (Date.now() - this.lastAliveAt < this.thresholdMs) return
    const alive = await this.probe()
    if (alive) {
      this.lastAliveAt = Date.now()
      if (this.alerting) {
        this.alerting = false
        this.lastAlertAt = 0
        this.log('health: 渠道已恢复（探针通），告警解除')
        this.notice('渠道已恢复（探针通），告警解除。')
      }
      return
    }
    const downFor = Date.now() - this.lastAliveAt
    if (!this.alerting) {
      this.alerting = true
      this.lastAlertAt = Date.now()
      this.log(`health: 渠道断线超过阈值（已断 ${Math.round(downFor / 60000)} 分钟），开始告警`)
      this.notice(`渠道断线已 ${Math.round(downFor / 60000)} 分钟：QQ 侧未通，我在自愈重连。若五分钟内没恢复，八成需要重登。`)
      return
    }
    if (Date.now() - this.lastAlertAt >= this.realertMs) {
      this.lastAlertAt = Date.now()
      this.log(`health: 渠道仍未恢复（已断 ${Math.round(downFor / 60000)} 分钟）`)
      this.notice(`渠道仍未恢复（已断 ${Math.round(downFor / 60000)} 分钟），仍候重登。`)
    }
  }

  /** 复合探针：WS readyState 与一次 get_status 都通过才算活。 */
  private async probe(): Promise<boolean> {
    try {
      if (this.client.isConnected()) return true
    } catch {
      // 落到后面的探针
    }
    try {
      const res = await this.api.getStatus()
      return res !== null && res !== undefined
    } catch {
      return false
    }
  }

  /** 只发给管理员本人；不走 agent 回合（运维通知，不是模型发言）。 */
  private notice(text: string): void {
    const master = this.admins()?.[0]
    if (master === undefined || master === null) {
      this.log('health: 未配置 admins[0]，告警只落日志，不发私聊')
      return
    }
    try {
      void this.out.push(() => this.api.sendPrivateMessage(master, [{ type: 'text', data: { text: `【通道告警】${text}` } }]))
    } catch (error) {
      this.log(`health: 告警发送失败 ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export const channelHealthPlugin: SubPlugin = {
  name: 'channel-health',
  watches: ['channelHealth'],
  requires: ['platform'],
  apply(host) {
    const { client, api, out } = host.need('platform')
    const monitor = new ChannelHealthMonitor({
      client,
      api,
      out,
      enabled: () => host.config.channelHealth.enabled,
      admins: () => host.config.admins,
      log: host.log,
      thresholdMs: host.config.channelHealth.thresholdMs,
      realertMs: host.config.channelHealth.realertMs,
    })
    monitor.start()
    return () => monitor.dispose()
  },
}