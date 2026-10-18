/**
 * Standalone memory entry — 让记忆核心可脱离 cordis 宿主独立使用。
 *
 * 插件主体（`src/index.ts`）仍通过 cordis Service 装配记忆；本入口把同一套
 * `core/memory` + `features/memory` 以普通工厂函数暴露，任何 Node 22+ 宿主
 * （其他 bot 框架、CLI 脚本、测试夹具）都能直接接入：
 *
 *   - 每回合证据注入（`evidence`）：组包前调一次，3–8 条、600 字预算、按房间过滤
 *   - 主动召回/写入（`recall` / `memorize`）：模型可调用的工具语义
 *   - 轻量搜索（`search`）：兼容旧 `KnowledgeStore.search` 的桥接退化
 *   - 双写旧库（`legacyWriter`）：新记录同时写旧 `entries.json` 形状，平滑迁移
 *
 * 零框架依赖：只 import `node:*` 与仓库内的 `core/memory`、`features/memory`、
 * `adapters/fs-store`、`ports/memory`。向量服务（`EmbedPort`）不传时自动走关键词路径。
 */

import { MemoryStore } from './features/memory/store.js'
import { createMemoryService, type LegacyWriter } from './features/memory/service.js'
import { MemoryRetriever } from './features/memory/retriever.js'
import { formatLocalStamp } from './core/schedule/stamp.js'
import { queryTerms, keywordRelevance } from './core/memory/score.js'
import type { MemoryService, MemoryEvidence, EmbedPort } from './ports/memory.js'
import type { MemoryRecord } from './core/memory/model.js'

export type { MemoryRecord } from './core/memory/model.js'
export type { MemoryService, MemoryEvidence, EmbedPort } from './ports/memory.js'
export type { LegacyWriter } from './features/memory/service.js'

export interface MemoryV2Options {
  /** dsh 宿主根（$DSH_HOME），用于缺省路径。 */
  readonly dshHome: string
  /** 工作区路径；null 时记忆库落在 dshHome/channel-qq/knowledge/。 */
  readonly workspacePath: string | null
  readonly log: (line: string) => void
  /** 旧 KnowledgeStore 兼容写入目标（双写，可空）。 */
  readonly legacyWriter?: LegacyWriter | null
  /** 向量服务（可选）；不传则永远走关键词路径。 */
  readonly embed?: EmbedPort | null
  /** 主体标签（检索证据渲染用，如「主人」）。 */
  readonly labelOfSubject?: (record: MemoryRecord) => string
}

export interface MemoryV2 {
  readonly store: MemoryStore
  readonly service: MemoryService
  readonly retriever: MemoryRetriever
  /** 组包前调用：本回合想起什么。返回空串 = 什么都没想起来。 */
  readonly evidence: MemoryEvidence
  /** 兼容旧 KnowledgeStore.search 的轻量召回（供桥接层退化使用）。 */
  search(query: string, top?: number): Array<{ id: string; content: string; source: string }>
  /** 主动写入一条记忆（自动双写旧库）。 */
  memorize(input: {
    content: string
    kind?: string | undefined
    tags?: readonly string[] | undefined
    source?: string | undefined
  }): Promise<{ id: string; total: number; created: boolean }>
  /** 主动召回。 */
  recall(input: { query: string; kind?: string | undefined; limit: number }): Promise<ReadonlyArray<{
    id: string
    kind: string
    content: string
    tags: readonly string[]
    source: string
    date: string
    hits: number
  }>>
}

export async function createMemoryV2(opts: MemoryV2Options): Promise<MemoryV2> {
  const store = new MemoryStore({
    dshHome: opts.dshHome,
    workspacePath: opts.workspacePath,
    log: opts.log,
  })
  await store.load()

  const renderTime = (at: number): string => formatLocalStamp(new Date(at))
  const clock = { now: (): number => Date.now() }
  const service = createMemoryService({
    store,
    log: opts.log,
    renderTime,
    clock,
    legacy: opts.legacyWriter ?? null,
  })
  const retriever = new MemoryRetriever({
    store,
    log: opts.log,
    renderTime,
    clock,
    ...(opts.labelOfSubject === undefined ? {} : { labelOfSubject: opts.labelOfSubject }),
  })

  const evidence: MemoryEvidence = async (input) => {
    try {
      const r = await retriever.retrieve({
        text: input.text,
        now: Date.now(),
        room: input.room,
      })
      return r.evidence
    } catch (err) {
      opts.log(`memory standalone evidence failed: ${String(err)}`)
      return ''
    }
  }

  const search = (query: string, top = 5): Array<{ id: string; content: string; source: string }> => {
    try {
      const terms = store.keepKnown(queryTerms(query))
      const scored = store
        .candidatesByTerms(terms)
        .map((r) => ({ r, s: keywordRelevance(terms, r, (t) => store.idfOf(t)) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, top)
      return scored.map((x) => ({ id: x.r.id, content: x.r.content, source: x.r.source.kind }))
    } catch {
      return []
    }
  }

  const memorize = async (input: {
    content: string
    kind?: string | undefined
    tags?: readonly string[] | undefined
    source?: string | undefined
  }): Promise<{ id: string; total: number; created: boolean }> => {
    return service.memorize({
      content: input.content,
      kind: input.kind,
      tags: input.tags,
      source: input.source,
    })
  }

  const recall = async (input: { query: string; kind?: string | undefined; limit: number }): Promise<ReadonlyArray<{
    id: string
    kind: string
    content: string
    tags: readonly string[]
    source: string
    date: string
    hits: number
  }>> => service.recall(input)

  return { store, service, retriever, evidence, search, memorize, recall }
}