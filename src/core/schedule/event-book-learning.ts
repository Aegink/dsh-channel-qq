/** 学习闭环的六个 job 事件（M1–M3）。
 *
 * 单独一个文件的原因很实在：`event-book.ts` 已经贴着 400 行的硬上限，再往里塞六个
 * 事件就会顶穿。这里是**纯数据**（`BookEvent` 的声明），与书本身怎么解析、怎么跑
 * 无关，所以搬出来不影响任何语义。
 *
 * 时间表刻意错开（04:50 → 06:20）：它们在夜里各自读同一批文件，串行跑比并行跑更
 * 好排查——`skipped:<原因>` 一看就知道是哪一步没跑。
 */

import type { BookEvent } from './event-book.js'

export const LEARNING_JOB_EVENTS: readonly BookEvent[] = [
  {
    id: 'memory-eval', enabled: true, kind: 'job',
    trigger: { type: 'window', from: '04:50', to: '05:20' },
    quietHours: [], target: null, template: null, materials: [], requires: [],
    job: 'memory.eval', script: null,
  },
  {
    id: 'memory-promote', enabled: true, kind: 'job',
    trigger: { type: 'window', from: '05:05', to: '05:35' },
    quietHours: [], target: null, template: null, materials: [], requires: [],
    job: 'memory.promote', script: null,
  },
  {
    id: 'memory-lessons', enabled: true, kind: 'job',
    trigger: { type: 'window', from: '05:20', to: '05:50' },
    quietHours: [], target: null, template: null, materials: [], requires: [],
    job: 'memory.lessons', script: null,
  },
  {
    id: 'memory-gaps', enabled: true, kind: 'job',
    trigger: { type: 'window', from: '05:30', to: '06:00' },
    quietHours: [], target: null, template: null, materials: [], requires: [],
    job: 'memory.gaps', script: null,
  },
  {
    id: 'metrics-strategy', enabled: true, kind: 'job',
    trigger: { type: 'window', from: '05:40', to: '06:10' },
    quietHours: [], target: null, template: null, materials: [], requires: [],
    job: 'metrics.strategy', script: null,
  },
  {
    id: 'memory-idle', enabled: true, kind: 'job',
    trigger: { type: 'window', from: '05:50', to: '06:20' },
    quietHours: [], target: null, template: null, materials: [], requires: [],
    job: 'memory.idle', script: null,
  },
]
