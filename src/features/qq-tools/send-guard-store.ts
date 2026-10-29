/** 复读守卫的状态落盘：换血/重启之后不把同一条再发一遍。
 *
 * 为什么放 features 而不是 core：`core/guards` 的判据是纯函数（R8：无时钟、无 IO），
 * 这里只负责读写与节流。**坏数据一律忽略**——状态丢了只会让复读检测从新开始，
 * 不该因为它读不起来就把插件拖挂。
 *
 * 背景（2026-10-29 实测）：守卫的房间状态原本纯内存，会话被看门狗"强制换血"后
 * 清零，于是 08:10 又把 06:00 那条"早安 学弟 今天要带伞了"原样发了一遍。
 */

import * as path from 'node:path'
import { atomicWriteJson, readJsonFileOrNull } from '../../adapters/fs-store/atomic.js'
import type { SendSignatureGuard } from '../../core/guards/output-signatures.js'

/** `<dshHome>/channel-qq/send-guard.json`。 */
export function sendGuardFile(dshHome: string): string {
  return path.join(dshHome, 'channel-qq', 'send-guard.json')
}

/** 回灌上一次落盘的状态；文件不存在是正常状态（第一次启动就是这样）。 */
export async function restoreSendGuard(
  guard: SendSignatureGuard,
  file: string,
  log: (line: string) => void,
): Promise<number> {
  const data = await readJsonFileOrNull(file)
  if (data === null) return 0
  const restored = guard.restore(data)
  if (restored > 0) log(`send-guard: 恢复 ${restored} 个房间的复读状态（换血/重启后不会重发同一条）`)
  return restored
}

/**
 * 造一个"状态变了就存盘"的回调，带节流。
 *
 * 一个回合里可能连续触发几十次（每次拦截都算变化），不能每次都写盘；这里
 * 合并成 `delayMs` 一次。写盘失败只记一行日志——它不该影响对话。
 * 用 `atomicWriteJson`：进程死在写一半时留下半截文件，回灌会读不回来。
 */
export function createSendGuardSaver(
  snapshot: () => unknown,
  file: string,
  log: (line: string) => void,
  delayMs = 1000,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing = false
  const flush = async (): Promise<void> => {
    if (writing) return
    writing = true
    try {
      await atomicWriteJson(file, snapshot())
    } catch (error) {
      log(`send-guard: 落盘失败（已忽略）：${String(error)}`)
    } finally {
      writing = false
    }
  }
  return () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, delayMs)
    // 别让一个待写盘把进程吊住。
    timer.unref?.()
  }
}
