# 记忆系统

> 状态（2026-10-18）：**代码完整、默认关闭**。检索侧实测：
>
> | 路径 | recall@8 | p95 |
> |---|---|---|
> | 关键词 | 0.04 | 21ms |
> | 关键词 + 向量（bge-small-zh 512 维） | **0.14** | 115ms |
>
> 门槛是 0.85。向量把召回提高 3.5 倍，但语料是**日记原文句子**而不是抽取后的
> "一句话事实"，8 个注入位要从 5000+ 段里挑中证据仍然很难。因此 `memory.v2`
> 保持默认关，等抽取管线（模型产出的一句话事实）接上后再复测。

## 组成

| 层 | 位置 | 作用 |
|---|---|---|
| 模型 | `src/core/memory/model.ts` | 双时间轴（validFrom / recordedAt）、矛盾不删除（supersede）、遗忘曲线 `R = e^(−t/S)` |
| 检索 | `core/memory/{score,select,query}.ts` + `features/memory/retriever.ts` | 相关性 × 重要性 × 新近度；零相关性不注入；注入预算 600 字 |
| 存储 | `features/memory/store.ts` | `knowledge/records.jsonl`（追加式，定期压缩） |
| 向量 | `features/memory/vector-store.ts` | `knowledge/vec.bin` + `vec-index.json`，分片 + 暴力余弦，不引原生依赖 |
| 夜间任务 | `features/memory/nightly.ts` | 九个 job，挂在事件书上（见下表） |
| 审核 | 后台「记忆」页 | 候选通过/忽略、冲突裁定、MEMORY.md 迁移 |

## 夜间任务（事件书 `core/schedule/event-book.ts`）

| 时间 | job | 说明 |
|---|---|---|
| 03:50 | `memory.chunks` | 工作区 md（`memory/`、`knowledge/`、`learning/`）切 600 字块入索引，幂等；旧块归档不删 |
| 04:20 | `memory.diary-extract` | **昨天**的日记 → 结构化记录（当天凌晨跑，当天日记还没写完） |
| 04:40 | `memory.session-split` | 昨天的会话原件 → 回合块 → 记录 |
| 05:00 | `memory.reflect` | 高重要度记录 → 反思（产出候选，等审核） |
| 05:20 | `memory.links` | 相邻记录建链（A-MEM） |
| 05:40 | `memory.contradictions` | 检出疑似冲突（只报告，不自动改） |
| 06:05 | `memory.forget` | `R < 0.05` 且没钉住的 → 归档（写 `.jsonl.gz`，**不删除**） |
| 06:20 | `memory.digest` | 核心摘要 → `memory/DIGEST.md` |
| 06:30 | `memory.reindex` | 增量嵌新记录（embed 服务不在就具名跳过） |

## 打开它

1. 起本机 embed 服务（可选，但**不开就没有向量**）：
   ```bash
   bash deploy/embed-server/install.sh      # 监听 127.0.0.1:8801
   ```
2. 后台「记忆」页，把 `memory.v2` 打开；要向量就把
   `memory.vectorEnabled` 打开、`vectorUrl = http://127.0.0.1:8801/v1`、`vectorDim = 512`。
3. 首次打开会把旧库 `knowledge/entries.json` **自动导入**新库（按内容去重）；
   之后跑几天夜间任务，再看「待审核」里有没有候选。

**回滚**：把 `memory.v2` 关掉即可——新库文件保留，旧库一直没动。

## 评测

```bash
# 关键词（默认）
node eval/memory/run.mjs --corpus /path/to/workspace/memory

# 向量 + 关键词混合（需要 embed 服务）
node eval/memory/run.mjs --corpus /path/to/workspace/memory --vectors http://127.0.0.1:8801/v1
```

门槛见 `eval/memory/README.md`（recall@8 ≥ 0.85、p95 ≤ 300ms、注入 ≤ 600 字）。

## 与 KB Lite（chunk 检索）的对比（2026-10-18 实测）

外部方案 KB Lite 的索引粒度是 **600 字块 / 100 重叠**，同一份日记语料、同一个
embed 模型、同一套题目：

| 方案 | 粒度 | recall |
|---|---|---|
| 关键词（本模块） | 句子 | 0.04 |
| 关键词 + 向量（本模块） | 句子 | 0.14 |
| KB Lite（chunk） | 600 字块 | **0.28**（其 CLI 的 top-6） |

**但把 chunk 直接搬进"每回合自动注入"会失效**：我们的注入预算是 **600 字**，
一块就占 400 字 ⇒ 每回合只塞得进 1 块，实测 recall 反而 **0**。
KB 的 0.28 建立在**一次返回 6 块**上。

**⇒ 结构结论**：
- chunk 层适合当**深召回工具**（agent 主动搜、一次给 5–8 块），不适合挤进每回合的注入预算；
- 自动注入继续用结构化记录（短、带出处与时间）；**原文块在代码里被挡在注入与主动召回之外**
  （`accept` 过滤 + 服务层 `isChunkRecord`），只有 `qq_memory_search` 能看到它们；
- 真要提升自动注入的召回，方向是**更短的事实**（抽取管线）而不是更长的块。

块索引已实现（`memory.chunks`，03:50，幂等、旧块归档），并由 **`qq_memory_search`**
暴露给模型：一次返回 3–8 条原文块 + 出处（文件与行号），跨房间、不占每回合注入预算。
`memory.v2` 关着时这个工具返回「深召回未启用」而不是报错。

## 已知限制

- **检索是瓶颈**：语料是日记原文句子，不是抽取后的"一句话事实"；字面匹配对同义/上下位无效。
- **遗忘曲线依赖召回**：`S` 只在被召回时增长；检索不准时多数记录停在 S=1 → 3 天归档。
  缓解：偏好/人物/高重要性特质/`pin` 标签永不归档；归档不是删除。
- **`DIGEST.md` / `MEMORY.md` 目前没有注入路径**：它们只是给人看的落点。
- **审核是手动的**：反思产出的候选不会自动生效。
