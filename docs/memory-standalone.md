# 记忆库插件化：独立使用指南

`src/standalone-memory.ts` 把记忆核心（`core/memory` + `features/memory`）以普通工厂函数暴露，
让它在 cordis 插件宿主之外也能被直接使用。

## 适用场景

- 把 dsh-channel-qq 的记忆能力接入**另一个宿主**（其他 bot 框架、自研 agent、CLI）。
- 在**测试夹具**里直接构造记忆库，不拉起整个 cordis 运行时。
- 把记忆库作为**可复用子包**发布，供多个项目共享。

## 零框架依赖

该入口只依赖：

- `node:fs` / `node:path` / `node:crypto`（Node 内置）
- 仓库内模块：`core/memory/*`、`features/memory/*`、`adapters/fs-store/*`、`core/schedule/stamp.ts`、`ports/memory.ts`

不 import `@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm` 或任何宿主服务。

## 用法（Node 22+ ESM）

```ts
import { createMemoryV2 } from 'dsh-channel-qq/build/lib/standalone-memory.js'

const mem = await createMemoryV2({
  dshHome: process.env.DSH_HOME ?? `${os.homedir()}/.dsh`,
  workspacePath: '/path/to/workspace',
  log: (line) => console.log('[memory]', line),
  legacyWriter: {
    // 可选：双写旧 KnowledgeStore（entries.json），平滑迁移
    addMany: async (items) => { /* 写旧库 */ return items.length },
  },
})

// 每回合证据注入（组包前）
const evidence = await mem.evidence({
  text: '用户说：今天想喝什么咖啡',
  room: 'qq-group-1000000003',
  isGroup: true,
})
// => "【记忆】…" 或空串

// 主动写入
await mem.memorize({ content: '用户喜欢黑咖啡不加糖', kind: 'preference', tags: ['咖啡'] })

// 主动召回
const hits = await mem.recall({ query: '咖啡', limit: 5 })
```

## 文件布局

- 记忆库数据：`<workspace>/knowledge/records.jsonl`（追加式 + 定期压缩）
- 旧库双写：`<workspace>/knowledge/entries.json`（与 `KnowledgeStore` 同目录）
- 向量索引（可选，未接 embed 时自动退回关键词）：`<workspace>/knowledge/vec.bin` + `vec-index.json`

## 与插件主体的关系

- 插件主体（`src/index.ts`）的 `MemoryService` 仍走 cordis 装配；本入口是同一实现的**第二种装配方式**。
- 两者共享同一套存储格式，可平滑互迁。
- 新增功能若只落在 `features/memory` 或 `core/memory`，两侧自动同时获得。