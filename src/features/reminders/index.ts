/** 提醒子插件（P5.1）：存储 + 到点轮询器 + 工具面 + 后台资源 + 投递。
 *
 * 投递是**直发**（不过 agent）：提醒是对一个时刻的承诺，让模型决定要不要
 * 转达会把它变成 best-effort（原 `deliverReminder` 的注释即此意）。
 * 原文案与日志一字未改。
 */

import { ReminderStore, type Reminder } from './store.js'
import { ReminderRunner } from './runner.js'
import { registerReminderTools } from './tools.js'
import { storeOptions } from '../plugin-kit.js'
import type { OneBotMessageSegment } from '../../types.js'
import type { SubHost, SubPlugin } from '../plugin-kit.js'

async function deliver(host: SubHost, reminder: Reminder): Promise<void> {
  const parts = host.get('platform')
  if (parts === undefined) return
  const { api, out } = parts
  const message: OneBotMessageSegment[] = [{ type: 'text', data: { text: `⏰ 到点了：${reminder.text}` } }]
  await out.push(() => api.sendTo(reminder.room === 'group', reminder.target, message))
  host.log(`reminder delivered to ${reminder.room}-${reminder.target}: ${reminder.text.slice(0, 40)}`)
}

export const remindersPlugin: SubPlugin = {
  name: 'reminders',
  watches: [],
  requires: ['platform'],
  async apply(host) {
    const store = new ReminderStore(host.config.reminders, storeOptions(host))
    await store.load()
    // 一次性提醒触发后保留 7 天给主人回看，之后清掉（否则文件无界增长）。
    const pruned = await store.pruneFired().catch(() => 0)
    if (pruned > 0) host.log(`reminders: pruned ${pruned} fired one-shot reminder(s)`)
    host.provide('reminders', store)
    host.registerResource('reminders', {
      label: '提醒',
      list: () => ({ count: store.list(300).length, reminders: store.list(300) }),
      remove: async (id) => ({ removed: await store.remove(id) }),
    })
    const { api, out } = host.need('platform')
    const runner = new ReminderRunner(store, async (reminder) => { await deliver(host, reminder) }, host.log)
    runner.start()
    const disposeTools = registerReminderTools(host.bridge.toolHost(), host.config, api, out, host.log, store)
    return async () => {
      disposeTools()
      runner.dispose()
      await store.save().catch(() => {})
    }
  },
}
