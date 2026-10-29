/** 学习闭环的夜间 job 装配（M1–M3）。
 *
 * 从 `memory/index.ts` 搬出来：那边的 `apply` 已经很长，再塞两个注册块就顶穿
 * 60 行的函数上限。搬出来之后 `apply` 里只剩一行 `wireLearningJobs(...)`，
 * 而"学习闭环到底注册了哪些 job"在这里一眼看完。
 *
 * 全部依赖都是**取值函数**：`store` 由 memory 子插件在 v2 打开后才填，
 * 配置每次现取（后台改完立即生效）。
 */

import * as path from 'node:path'
import type { SubHost } from '../plugin-kit.js'
import type { MemoryStore } from './store.js'
import { registerEvalJob, resolveRunner } from './eval-job.js'
import { registerLearningJobs } from './learning-jobs.js'

/** 注册评测 + 学习三件套；返回一次性反注册函数。 */
export function wireLearningJobs(host: SubHost, store: () => MemoryStore | null): () => void {
  const offEval = registerEvalJob({
    enabled: () => host.config.memory.evalEnabled,
    regressPercent: () => host.config.memory.evalRegressPercent,
    dshHome: host.dshHome,
    workspace: () => host.config.workspacePath,
    log: host.log,
    runner: resolveRunner,
    notify: (text: string) => notifyAdmin(host, text),
  })
  const offLearning = registerLearningJobs({
    store,
    drafts: () => host.get('skillDrafts'),
    workspace: () => host.config.workspacePath,
    log: host.log,
    config: () => ({
      promoteEnabled: host.config.memory.promoteEnabled,
      promoteMinHits: host.config.memory.promoteMinHits,
      lessonsEnabled: host.config.memory.lessonsEnabled,
      archiveIdleDays: host.config.memory.archiveIdleDays,
      archiveMinImportance: host.config.memory.archiveMinImportance,
    }),
    metricsFile: () => path.join(host.dshHome, 'channel-qq', 'metrics.json'),
    random: Math.random,
  })
  return () => {
    offEval()
    offLearning()
  }
}

/** 私聊管理员（退化告警用）；没配管理员或平台没就绪时只记日志。 */
async function notifyAdmin(host: SubHost, text: string): Promise<void> {
  const admin = host.config.admins[0]
  const api = host.get('platform')?.api
  if (admin === undefined || api === undefined) {
    host.log(`alert (no admin/api): ${text.split('\n')[0] ?? ''}`)
    return
  }
  await api.sendPrivateMessage(admin, [{ type: 'text', data: { text } }])
}
