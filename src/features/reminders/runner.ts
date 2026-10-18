/** 到点轮询器。只管"何时该响"，怎么发由主控的 send 决定 ——
 * 主控可能想走 agent（带人格再开口），也可能只想发一行裸文本。
 *
 * P4 搬迁注记：逐字来自 `src/reminders.ts`。
 */

import type { Reminder, ReminderStore } from './store.js'

export class ReminderRunner {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly store: ReminderStore
  private readonly send: (r: Reminder) => Promise<void>
  private readonly log: (line: string) => void

  constructor(store: ReminderStore, send: (r: Reminder) => Promise<void>, log: (line: string) => void) {
    this.store = store
    this.send = send
    this.log = log
  }

  start(intervalMs = 30_000): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    // 别让这个轮询把进程钉住：主控 dispose 时进程照常退出。
    // `unref` 在 Node 的 Timeout 上一定存在；`typeof` 只是防"跑在别的运行时上"。
    if (typeof this.timer.unref === 'function') this.timer.unref()
    this.log(`reminders: runner started (every ${String(intervalMs)}ms)`)
  }

  /** 每次轮询同一时刻的 due 快照；单条失败只记日志，其它条继续。 */
  private async tick(): Promise<void> {
    const pending = this.store.due()
    for (const reminder of pending) {
      try {
        await this.send(reminder)
        await this.store.markFired(reminder.id)
      } catch (error) {
        this.log(`reminders: send failed for ${reminder.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
