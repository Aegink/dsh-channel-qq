/** 会话换血看门狗：会话 token 接近模型窗口时，自动备份历史并重开会话。
 *
 * 为什么放在插件而不是宿主：宿主的压缩（compaction）是第一道防线，但历史一旦
 * **已经超过**窗口，压缩自己的摘要请求也会超窗——2026-10-20 的 400 就是这么来的。
 * 换血必须在压缩之前、按体积主动发生，而尺寸只有插件侧的 tokenMeter 能读到。
 *
 * 触发条件（全部满足才动手）：
 *   1. `sessionReset.enabled`；
 *   2. 会话当前没有回合在跑（`tracker.running()` 为假）；
 *   3. 模型**声明了**上下文窗口（未知时不动，避免误杀）；
 *   4. `tokens ≥ window × thresholdRatio`。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../../adapters/fs-store/atomic.js'
import { shouldResetSession } from '../../core/session-reset.js'
import { formatLocalStamp } from '../../core/schedule/stamp.js'
import { encodeSegment, sessionDir } from '../../paths.js'
import type { SessionSize } from '../../adapters/dsh-host/session-size.js'
import type { ConversationRegistry } from '../../app/conversation/registry.js'
import type { SessionResetConfig } from '../../config/sections/session-reset.js'
import type { SubHost, SubPlugin } from '../plugin-kit.js'

/** 默认续接种子。 */
const DEFAULT_SEED = [
  '【会话换血】上一段对话的上下文已经清空（历史已备份）。',
  '人格与长期记忆没有变：仍按 AGENTS.md 的约定说话，长期记忆按需检索。',
  '如果主人问起，说明这次是自动换血；不需要主动补发长报告。',
].join('\n')

/** 看门狗的固定 tick（配置的检查间隔在 tick 内部判断）。 */
const TICK_MS = 60_000

/** 换血：备份历史 → 释放会话 → 写种子。下一次消息会用新会话。 */
async function resetRoom(
  host: SubHost,
  registry: ConversationRegistry,
  room: string,
  size: SessionSize,
  config: SessionResetConfig,
): Promise<void> {
  const sessionId = `qq-${room}`
  const existed = registry.get(room) !== undefined
  if (existed) {
    await registry.dispose(room)
    registry.forget(room)
  }
  let moved = 0
  let backup = ''
  try {
    const dir = sessionDir(host.config.workspacePath ?? undefined, sessionId)
    moved = (await fs.readdir(dir)).length
    const stamp = formatLocalStamp(new Date()).replace(/[:.]/g, '-')
    backup = path.join(host.dshHome, 'channel-qq', 'backups', `session-auto-${stamp}-${encodeSegment(sessionId)}`)
    await fs.mkdir(path.dirname(backup), { recursive: true })
    await fs.rename(dir, backup)
  } catch (error) {
    // 目录不存在是正常状态（会话还没落盘）；别的错误记一行继续写种子。
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      host.log(`session-reset: 备份 ${sessionId} 失败：${(error as Error).message}`)
    }
  }
  const seed = config.seed.trim() === '' ? DEFAULT_SEED : config.seed.trim()
  await atomicWriteFile(
    path.join(host.dshHome, 'channel-qq', `session-seed-${sessionId}.json`),
    JSON.stringify({ sessionId, createdAt: new Date().toISOString(), seed }, null, 2),
  )
  host.log(
    `session-reset: ${sessionId} 换血（${size.tokens}/${size.contextWindow} tokens，`
    + `route ${size.provider}/${size.model}，备份 ${moved} 个文件${backup === '' ? '' : ` → ${backup}`}）`,
  )
}

/** 一轮检查。 */
async function tick(host: SubHost, seen: Set<string>): Promise<void> {
  const config = host.config.sessionReset as SessionResetConfig
  if (config.enabled !== true) return
  const registry = host.get('inbound')?.registry
  const probe = host.bridge.sessionSize?.()
  if (registry === undefined || probe === undefined) {
    if (!seen.has('__missing')) {
      seen.add('__missing')
      host.log(`session-reset: 探针不可用（registry=${registry !== undefined} probe=${probe !== undefined}）`)
    }
    return
  }
  const rooms = registry.keys()
  if (!seen.has('__tick')) {
    seen.add('__tick')
    host.log(`session-reset: 首轮检查，活跃房间 ${rooms.length} 个`)
  }
  for (const room of rooms) {
    const record = registry.get(room)
    if (record === undefined || record.tracker.running()) continue
    let size
    try {
      size = await probe.measure(`qq-${room}`)
    } catch (error) {
      if (!seen.has(`__err-${room}`)) {
        seen.add(`__err-${room}`)
        host.log(`session-reset: 测量 ${room} 失败：${(error as Error).message}`)
      }
      continue
    }
    if (size === null) continue
    if (!seen.has(room)) {
      seen.add(room)
      host.log(`session-reset: 探测 ${room} = ${size.tokens}/${size.contextWindow ?? '?'} tokens（${size.provider}/${size.model}）`)
    }
    if (!shouldResetSession(size.tokens, size.contextWindow, config.thresholdRatio)) continue
    try {
      await resetRoom(host, registry, room, size, config)
    } catch (error) {
      host.log(`session-reset: 处理 ${room} 失败：${(error as Error).message}`)
    }
  }
}

export const sessionResetPlugin: SubPlugin = {
  name: 'session-reset',
  watches: ['sessionReset'],
  requires: ['inbound'],
  apply(host) {
    let lastRun = 0
    let busy = false
    const seen = new Set<string>()
    const timer = setInterval(() => {
      if (busy) return
      const config = host.config.sessionReset as SessionResetConfig
      if (config.enabled !== true) return
      const intervalMs = Math.max(1, Number(config.checkIntervalMin ?? 5)) * 60_000
      if (Date.now() - lastRun < intervalMs) return
      lastRun = Date.now()
      busy = true
      void tick(host, seen).finally(() => { busy = false })
    }, TICK_MS)
    timer.unref?.()
    // 启动后先跑一次：重启后的第一分钟就发现超限会话。
    const kick = setTimeout(() => { lastRun = Date.now(); void tick(host, seen) }, 20_000)
    kick.unref?.()
    host.log(`session-reset: 看门狗已启动（每 ${host.config.sessionReset.checkIntervalMin} 分钟，比例 ${host.config.sessionReset.thresholdRatio}）`)
    return () => {
      clearInterval(timer)
      clearTimeout(kick)
    }
  },
}
