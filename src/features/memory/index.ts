/** 记忆子插件：旧知识库（默认行为）+ 新记忆系统（`memory.v2`，P6e）。
 *
 * 两条轨并排跑，由 `memory.v2` 决定走哪条：
 *
 *   - **关**（默认）：阶段二知识库原样——`entries.json` + 关键词检索 + 后台
 *     「长期记忆」「日记」两张表。`qq_recall_memory` / `qq_memorize_fact` 走它。
 *   - **开**：`core/memory/*` 的结构化记录（双时间轴、矛盾退役、遗忘曲线）落
 *     `knowledge/records.jsonl`；每回合自动注入 3–8 条证据（≤600 字）；两个工具
 *     改走结构化召回与写入；**同时双写旧库**，所以后台那两张表不会空。
 *
 * 为什么不是"直接换掉"：换开关那天不该出现"记忆页空了"或"检索突然变了"两种
 * 意外同时发生。开关默认关（P6 的规矩），线上行为在打开之前逐字节不变。
 *
 * e1 只做到"记录模型 + 存储 + 关键词检索 + 注入"；e2 在其上加了向量：本机 embed
 * 服务客户端 + 分片 `vec.bin` + 混合打分，开关是 `memory.vectorEnabled`（默认关，
 * 关着时检索与 e1 逐字节一致；开着但服务不可用时自动退回关键词）；夜间巩固、
 * 遗忘与 MEMORY.md 迁移是 e3（见 refactor-plan/09 的落地分期）。
 */

import { KnowledgeStore, resolveExtractorRoute, extractFromText } from '../../knowledge.js'
import { createEmbedAdapter } from '../../adapters/providers/embed.js'
import { findConflicts } from '../../core/memory/nightly.js'
import type { Json } from '../../admin/config-engine.js'
import type { EmbedPort } from '../../ports/memory.js'
import { MemoryRetriever } from './retriever.js'
import { migrateMemoryFile } from './migrate.js'
import { registerNightlyJobs } from './nightly.js'
import { MemoryStore } from './store.js'
import { createMemoryService } from './service.js'
import {
  createVectorRecall, loadVectorIndex, VEC_FILE_NAME, VEC_MANIFEST_NAME, type VectorRecall,
} from './vector-store.js'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { SubHost, SubPlugin } from '../plugin-kit.js'

export const memoryPlugin: SubPlugin = {
  name: 'memory',
  // 这些点一变就重挂本插件：记忆系统的开关、注入预算、向量参数都是"改了要立刻生效"的。
  watches: [
    'memory.v2', 'memory.threshold', 'memory.maxRecords', 'memory.maxChars',
    'memory.vectorEnabled', 'memory.vectorUrl', 'memory.vectorDim', 'memory.vectorTimeoutMs', 'memory.vectorWeight',
  ],
  async apply(host) {
    const workspacePath = host.config.workspacePath
    const store = new KnowledgeStore(host.dshHome, workspacePath, host.log)
    await store.load()
    // One resolver, so "the extractor is misconfigured" is decided in exactly
    // one place and logged once rather than at every call site.
    const route = resolveExtractorRoute()
    if (route === null) {
      host.log('knowledge: extractor not configured (set CHANNEL_QQ_EXTRACTOR_BASE_URL and CHANNEL_QQ_EXTRACTOR_MODEL to enable)')
    }
    const extract = async (source: string, text: string): Promise<number> => {
      if (route === null) return 0
      const items = await extractFromText(route, source, text, host.log)
      return store.addMany(items)
    }
    host.provide('knowledge', { store, extract })

    // 夜间巩固的八个 job（P6e·e3）：**无条件注册**——默认事件书里一直列着它们，
    // 开关关着时每个 handler 自己回一句 `skipped:memory-v2-off`（比 unknown-job
    // 那种"看起来坏了"的结果清楚）。向量重建要的嵌入器在 v2 装配时才建，
    // 所以这里用取值函数，注册发生在装配之前也不会读到 undefined。
    const nightlyState: { store: MemoryStore | null; embed: EmbedPort | null } = { store: null, embed: null }
    const nightlyRoute = resolveExtractorRoute()
    const offNightly = registerNightlyJobs({
      store: () => nightlyState.store,
      legacy: store,
      log: host.log,
      workspace: () => host.config.workspacePath,
      extractorReady: () => nightlyRoute !== null,
      extract: async (source: string, text: string) => {
        if (nightlyRoute === null) return []
        return await extractFromText(nightlyRoute, source, text, host.log)
      },
      embed: () => nightlyState.embed,
      rooms: () => {
        const out: string[] = []
        if (host.config.primaryGroup !== null) out.push(`group-${host.config.primaryGroup}`)
        const master = host.config.admins[0]
        if (master !== undefined) out.push(`dm-${master}`)
        return out
      },
      random: Math.random,
    })

    if (host.config.memory.v2) {
      await attachMemoryV2(host, store, nightlyState)
    }

    registerPendingResource(host, nightlyState)
    registerLegacyResources(host, store, workspacePath)

    // 卸载时把八个 job 从注册表摘掉（同名重挂是"后者生效"，留着会让旧实例的
    // handler 继续接活——那时它的 store 引用已经过期了）。
    return () => { offNightly() }
  },
}

/**
 * 装配新记忆系统（`memory.v2`）。
 *
 * 三件东西一次挂上：
 *   - `memory`：工具面的召回与写入（`qq_recall_memory` / `qq_memorize_fact`）；
 *   - `memoryEvidence`：入站组包每回合的自动注入（3–8 条、≤600 字、按房间过滤）；
 *   - 后台「长期记忆」表改由 v2 记录填充（**不删旧库**，只是换数据源给它看）。
 *
 * 注入预算（条数/字数/阈值）取自配置：`segmentText` 那一课的教训是"面板上能改的
 * 东西必须真的被读到"，所以这里显式传下去，而不是用模块常量。
 */
async function attachMemoryV2(
  host: SubHost,
  legacy: KnowledgeStore,
  nightly: { store: MemoryStore | null; embed: EmbedPort | null },
): Promise<void> {
  const { memory } = host.config
  const store = new MemoryStore({ workspacePath: host.config.workspacePath, dshHome: host.dshHome, log: host.log })
  const count = await store.load()
  nightly.store = store
  host.log(`memory.v2: ${count} 条结构化记忆已加载（${store.file}）`)

  const renderTime = (at: number): string => new Date(at).toISOString().slice(0, 10)
  const clock = { now: () => Date.now() }
  const service = createMemoryService({ store, log: host.log, renderTime, clock, legacy })
  const { recall: vectors, embed } = await setupVectors(host, store.dir)
  nightly.embed = embed
  const retriever = new MemoryRetriever({
    store,
    log: host.log,
    renderTime,
    clock,
    ...(vectors === undefined ? {} : { vectors }),
  })

  host.provide('memory', service)
  host.provide('memoryEvidence', async (input) => {
    const got = await retriever.retrieve({
      text: input.text,
      room: input.room,
      now: Date.now(),
      budget: {
        threshold: memory.threshold,
        maxRecords: memory.maxRecords,
        maxChars: memory.maxChars,
      },
    })
    return got.evidence
  })
}

/**
 * 向量检索的装配（P6e·e2 / e3）：
 *
 *   - `memory.vectorEnabled` 关着 → 返回 `{recall: undefined, embed: null}`，检索走
 *     e1 的关键词路径（默认行为逐字节不变），夜间 `reindex` 也具名跳过；
 *   - 开着但索引为空 / 装配失败 → 记日志、照常退回关键词，**绝不挡启动**；
 *     但**嵌入器仍然返回**给夜间任务——索引为空正是 `reindex` 要去修的状态
 *     （只在装配失败时它才是 null）。
 *
 * 读配置一律走 `host.config.memory.vector*` 点路径（与后台静态审计的口径一致）。
 */
async function setupVectors(host: SubHost, dir: string): Promise<{ recall: VectorRecall | undefined; embed: EmbedPort | null }> {
  if (!host.config.memory.vectorEnabled) return { recall: undefined, embed: null }
  let embed: EmbedPort | null = null
  try {
    embed = createEmbedAdapter({
      baseUrl: host.config.memory.vectorUrl,
      dim: host.config.memory.vectorDim,
      timeoutMs: host.config.memory.vectorTimeoutMs,
      log: host.log,
    })
    const { index } = await loadVectorIndex({
      file: path.join(dir, VEC_FILE_NAME),
      manifestFile: path.join(dir, VEC_MANIFEST_NAME),
      dim: host.config.memory.vectorDim,
      log: host.log,
    })
    if (index.size() === 0) {
      host.log('memory.vector: 向量索引为空（夜间 reindex 任务会建它），本回合起退回关键词检索')
      return { recall: undefined, embed }
    }
    host.log(`memory.vector: ${index.size()} 条向量已加载（服务 ${host.config.memory.vectorUrl}，余弦权重 ${host.config.memory.vectorWeight}）`)
    return { recall: createVectorRecall(embed, index, host.config.memory.vectorWeight), embed }
  } catch (error) {
    host.log(`memory.vector: 装配失败，退回关键词检索：${error instanceof Error ? error.message : String(error)}`)
    return { recall: undefined, embed: null }
  }
}

/**
 * 「记忆审核」页的数据面（P6e·e3，D4）：候选记录与疑似冲突对。
 *
 * 待处理 = 两类还没被主人确认过的记录：反思产出的候选（`status='candidate'`）、
 * 疑似冲突的记录对。**每次现算**——扫描是确定性的（`findConflicts`），不另存一份
 * 会与记录库漂移的队列文件。
 */
function registerPendingResource(host: SubHost, nightly: { store: MemoryStore | null }): void {
  const storeOf = (): MemoryStore | null => nightly.store
  host.registerResource('memory-pending', {
    label: '记忆审核',
    list: () => {
      const store = storeOf()
      if (store === null) return { candidates: [], conflicts: [], note: 'memory.v2 关着' }
      const all = store.all()
      const candidates = all.filter((r) => r.status === 'candidate')
      const pairs = findConflicts(all).slice(0, 50)
      return {
        candidates: candidates.map((r) => ({
          id: r.id, kind: r.kind, content: r.content,
          date: new Date(r.recordedAt).toISOString().slice(0, 10), source: r.source.kind,
        })),
        conflicts: pairs.map((p) => ({
          left: { id: p.left.id, content: p.left.content },
          right: { id: p.right.id, content: p.right.content },
          overlap: Number(p.overlap.toFixed(2)),
        })),
      }
    },
    actions: {
      approve: (body) => decideCandidate(storeOf(), body, 'active'),
      reject: (body) => decideCandidate(storeOf(), body, 'archived'),
      resolve: (body) => resolveConflict(storeOf(), body),
      migrate: () => runMigration(host, storeOf()),
    },
  })
}

/**
 * 老知识库的两个资源页（「长期记忆」「日记」）。
 *
 * e1 起 v2 记录会双写老库，所以这两张表在开关打开后仍然有数据——换开关那天不该
 * 出现"记忆页空了"。它们读的始终是老库（`KnowledgeStore`），不是新记录库。
 */
function registerLegacyResources(host: SubHost, store: KnowledgeStore, workspacePath: string | null): void {
  host.registerResource('memories', {
    label: '长期记忆',
    list: (query) => {
      const q = (query.get('q') ?? '').trim()
      const entries = q === '' ? store.entries.slice(-300).reverse() : store.search(q, 50)
      return { count: store.entries.length, entries }
    },
    create: async (body) => ({
      added: await store.addManual({
        type: body.type === undefined ? undefined : String(body.type),
        content: String(body.content ?? ''),
        tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t)) : [],
        source: body.source === undefined ? undefined : String(body.source),
      }),
    }),
    remove: async (id) => ({ removed: await store.remove(id) }),
  })
  host.registerResource('diary', {
    label: '日记',
    list: async (query) => {
      if (workspacePath === null) return { diaries: [] }
      const dir = path.join(workspacePath, 'memory')
      const date = (query.get('date') ?? '').replace(/[^0-9-]/g, '')
      if (date !== '') {
        const content = await fs.readFile(path.join(dir, `${date}.md`), 'utf-8').catch(() => '')
        return { date, content }
      }
      const names = await fs.readdir(dir).catch(() => [] as string[])
      const diaries: Array<{ date: string; file: string }> = []
      for (const name of names) {
        if (!name.endsWith('.md') || !/^\d{4}-\d{2}-\d{2}/.test(name)) continue
        diaries.push({ date: name.slice(0, 10), file: path.join(dir, name) })
      }
      diaries.sort((a, b) => b.date.localeCompare(a.date))
      return { count: diaries.length, diaries: diaries.slice(0, 90) }
    },
  })
}

/** 通过/驳回一条候选：`candidate` → `active`（开始参与检索）或 `archived`（不删，可回查）。 */
async function decideCandidate(store: MemoryStore | null, body: Json, status: 'active' | 'archived'): Promise<unknown> {
  const record = store?.get(String(body.id ?? ''))
  if (store === null || record === undefined) return { ok: false, reason: '记录不存在' }
  if (status === 'active' && record.status !== 'candidate') return { ok: false, reason: `状态是 ${record.status}，不是候选` }
  await store.put({ ...record, status })
  return { ok: true, id: record.id, status }
}

/** 裁定一对疑似冲突：留下 keep，另一条 supersede（不删除，历史可回查）。 */
async function resolveConflict(store: MemoryStore | null, body: Json): Promise<unknown> {
  const winner = store?.get(String(body.keep ?? ''))
  const loser = store?.get(String(body.drop ?? ''))
  if (store === null || winner === undefined || loser === undefined) return { ok: false, reason: '记录不存在' }
  await store.put({ ...loser, status: 'superseded', supersededBy: winner.id, validTo: Date.now() })
  return { ok: true, kept: winner.id, superseded: loser.id }
}

/** D4 §7 的一次性迁移：冻结 MEMORY.md → 切分 → 落候选（等审核）。 */
async function runMigration(host: SubHost, store: MemoryStore | null): Promise<unknown> {
  if (store === null) return { ok: false, reason: 'memory.v2 关着' }
  return await migrateMemoryFile({
    workspace: host.config.workspacePath,
    dshHome: host.dshHome,
    store,
    log: host.log,
    now: new Date(),
    roll: Math.random,
  })
}
