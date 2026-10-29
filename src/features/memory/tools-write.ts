/** 记忆的写入侧工具：忘掉一条、纠正一条（M2.3）。
 *
 * 为什么单独一个文件而不是塞进 `tools.ts`：那两个工具是**唯一会改记忆状态**的入口
 * （其它工具只读或只新增）。把它们放在一起，"谁能改记忆"这个问题一眼就能回答。
 *
 * 两条纪律：
 *   - **归档不是删除**：`forget` 把记录转 `archived`，历史仍在 `records.jsonl` 里；
 *   - **纠正不是覆盖**：`correct` 用新记录 supersede 旧的（旧的写 `validTo`），
 *     所以"上周我们以为是 X"永远查得回来。
 */

import type { ToolSpec } from '../../adapters/dsh-host/tools.js'
import type { QQToolDeps } from '../tool-deps.js'

/** `qq_forget_memory` — 【忘掉】按 id 或关键词把一条记忆归档（不删）。 */
function qqForgetMemory(deps: QQToolDeps): ToolSpec {
  const { memory } = deps
  return {
    name: 'qq_forget_memory',
    description: '【忘掉一条】发现记错了、或者记的是一句气话，用这个把那条记忆归档：'
      + '不再被检索到，但历史仍可回查（**不是删除**）。给 id 或关键词都行，关键词取命中最高的那条。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记录 id（从 qq_recall_memory 的返回里拿）' },
        query: { type: 'string', description: '没有 id 时用一句话描述那条记忆，取命中最高的' },
      },
      required: [],
    },
    run: async (args) => {
      if (memory === undefined || memory === null) return { ok: false, note: '记忆系统未启用（memory.v2）' }
      return memory.forget({
        ...(typeof args.id === 'string' ? { id: args.id } : {}),
        ...(typeof args.query === 'string' ? { query: args.query } : {}),
      })
    },
  }
}

/** `qq_correct_memory` — 【纠正】用新内容取代旧记忆（旧的转 superseded）。 */
function qqCorrectMemory(deps: QQToolDeps): ToolSpec {
  const { memory } = deps
  return {
    name: 'qq_correct_memory',
    description: '【纠正一条】发现记忆里的说法不对，用这个写一条新的取代它：'
      + '旧的会转成 superseded 并留下失效时间，所以"以前我们以为是什么"仍然查得到。'
      + '新内容要写成一句话（≤200 字）。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '新的说法，一句话' },
        id: { type: 'string', description: '要纠正的那条记录的 id' },
        query: { type: 'string', description: '没有 id 时用一句话描述要纠正的那条' },
      },
      required: ['content'],
    },
    run: async (args) => {
      if (memory === undefined || memory === null) return { ok: false, note: '记忆系统未启用（memory.v2）' }
      return memory.correct({
        content: String(args.content ?? ''),
        ...(typeof args.id === 'string' ? { id: args.id } : {}),
        ...(typeof args.query === 'string' ? { query: args.query } : {}),
      })
    },
  }
}

/** 组装这一组工具。 */
export function memoryWriteTools(deps: QQToolDeps): ToolSpec[] {
  return [qqForgetMemory(deps), qqCorrectMemory(deps)]
}
