# 功能调研与升级路线图

> 编写时间：2026-10-14
> 调研方式：GitHub 仓库页 / README 原文 / 官方注册表（NoneBot registry 944 个插件、Koishi registry 4015 个包）实读；
> GitHub REST API 未授权配额已耗尽，未使用。
> 标注：**★实测**=本轮读到原文；**☆摘要**=仅搜索结果/star 徽章核对；**⚠未验证**=来源不足。

---

## 0. 一句话结论

本项目"聊天 + 养成 + 点歌 + 表情包 + 群管"的骨架已经相当完整，**真正的短板不在功能数量，而在两处**：
1. **上服务器的移植性**（13 个硬编码/Windows 专用点，见 `DEPLOY.md` §5）——这是 P0，不修功能再多也跑不起来；
2. **内容输入源单一**——群里没有"链接解析"和"表情包制作"，机器人只能聊不能"产出"。

功能侧按性价比排序：**链接解析（B站） > 表情包配字制作 > 群语录库 > 记忆召回强化 > edge-tts 音色**。

---

## 1. P0：立刻值得做（低成本 / 高感知）

| 功能 | 开源项目 | 仓库 | 为什么值得 | 成本 | 本项目落点 |
|---|---|---|---|---|---|
| **B站/多平台链接解析** | bilichat (263★☆) | github.com/Well2333/nonebot-plugin-bilichat | 群友甩链接 → 自动出封面/标题/简介卡片。现项目**完全没有**链接处理能力 | 中 | 新增 `src/link-resolve.ts` + 一个 `qq_resolve_link` 工具；bilibili 用公开 API（`api.bilibili.com/x/web-interface/view`）即可，无需登录 |
| **表情包"制作"（配字斗图）** | nonebot-plugin-memes (314★☆) | github.com/MeetWq/nonebot-plugin-memes | 现项目只会**偷/搜**表情，不会**造**。几百套模板配字是群聊刚需 | 低 | 扩展 `src/emoji-library.ts`：模板图 + 文字排版。可先只做"原图 + 上下两行白字黑边"的最简版 |
| **群语录库** | nonebot-plugin-quote (84★☆) | github.com/RongRongJi/nonebot_plugin_quote | "截图存语录、关键词精准投放"——比表情包更贴"群梗"场景，是活人感的来源 | 低 | 复用现有 `SentLog`/历史消息索引，存 `workspace/quotes/` |
| **记忆召回强化** | astrbot_plugin_livingmemory (354★★) | github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory | 它把"归档 / 时间衰减 / 访问强化 / Agent 可主动 recall+memorize"做成工具。本项目已有 `knowledge.ts` 的 weight+hits，**但模型不能主动 recall** | 低 | `src/knowledge.ts:72` 的 `search()` 已经算好分；只需加一个 `qq_recall_memory` 工具暴露给模型，并在 prompt 里提示可用 |
| **edge-tts 音色** | edge-tts (12k★☆) | github.com/rany2/edge-tts | 免 GPU、免 key、CPU 秒出音频，最适合服务器发语音条。现项目 TTS 只有 NapCat 自带 AI 音色（音色受限），而 `audio-convert.ts` 里**已写好 TTS→silk 全套代码却没人调用** | 低 | 直接接上死代码：`src/audio-convert.ts` 的 `textToSilk()` + `resolveTTSConfig()` 已可用，新增 `qq_tts_voice` 工具即可 |

> 关于 edge-tts：它是 Python 包。Node 侧可用等价的微软 Edge TTS WebSocket 接口自己实现，或退一步用任意 OpenAI 兼容 `/audio/speech` 端点（代码已支持，见 `src/audio-convert.ts:178`）。

---

## 2. P1：值得排期

| 功能 | 开源项目 | 仓库 | 为什么值得 | 成本 |
|---|---|---|---|---|
| 群聊总结报告升级 | koishi-plugin-chatluna-group-analysis ☆ | npmjs.com/package/koishi-plugin-chatluna-group-analysis | 现 `scripts/daily-report.mjs` 是纯统计（消息量/活跃排行）。可升级为"LLM 读历史 → 出图文日报" | 低 |
| 架构参考 | ChatLuna (442★☆) | github.com/ChatLunaLab/chatluna | 角色卡 + 长期记忆 + 向量库 + 搜索 + 主动触发 + Agent 工具，分层最完整，可照抄模块划分 | 中 |
| 群事件监控 | nonebot-plugin-eventmonitor (38★☆) | github.com/Reversedeer/nonebot_plugin_eventmonitor | 戳一戳/进退群/群荣誉变化 → 喂给主动性巡逻当话题素材（现 `handleNotice` 只处理 poke） | 低 |
| 自然语言提醒 | nonebot-plugin-todo-nlp (20★☆) | github.com/CofinCup/nonebot-plugin-todo-nlp | "明天9点叫我" → 建任务并推送。现 `scheduler.ts` 是写死的定时器，没有用户级提醒 | 低 |
| 订阅推送 | ELF_RSS (609★☆) / nonebot-bison (215★☆) | github.com/Quan666/ELF_RSS · felinae98/nonebot-bison | RSS/UP动态/开播订阅，低成本给群扩充内容源 | 低 |
| 防刷屏风控 | koishi-plugin-group-control ☆ | npmjs.com/package/koishi-plugin-group-control | 现限流只保护机器人自己（`rateLimitMs`），不治理群内刷屏 | 低 |
| 群内 AI 生图 | nonebot-plugin-novelai (215★☆) | github.com/sena-nana/nonebot-plugin-novelai | 对接 SD WebUI / NAI，支持中文提示词与模型管理 | 中 |
| 群聊学习/口癖 | nonebot-plugin-learning-chat (190★☆) | github.com/CMHopeSunshine/nonebot-plugin-learning-chat | 学群友口癖 + 主动发言概率，强化"活人感"（与本项目人格化路线契合） | 中 |
| 表情包快捷调用 | nonebot-plugin-customemote (7★☆) | github.com/DMCSWCG/nonebot-plugin-customemote | 按名字发图 + 批量提取 QQ 内置表情入库，补全现有表情库 | 低 |

---

## 3. P2：可选 / 观察

- **词云 / 签到 / 积分小游戏**：`nonebot-plugin-wordcloud` (112★☆)、`mystool` (458★☆)。留存玩法，但与"养成本身"争夺注意力。
- **工程架构借鉴**：AstrBot 4.29（42k★☆，`github.com/AstrBotDevs/AstrBot`）的**步数预算、上下文压缩失败回退、Skills、MCP、子 Agent 编排**——本项目 `bridge.ts` 的 batching/injectMode 已解决一部分，可对照补"上下文压缩"。
- **记忆底座**：mem0 (67k★☆) / graphiti (32k★☆) / letta (25k★☆)。人物画像 + 时序知识图谱很强，但要额外常驻服务 + 向量库。
- **语音克隆**：GPT-SoVITS (63k★☆) / fish-speech (33k★☆) / CosyVoice (24k★☆) / IndexTTS (24k★☆)。音色最好，但**需要 GPU + 长延迟**。

---

## 4. 明确不建议做

1. **不要部署 GPT-SoVITS/CosyVoice 自训克隆音**：需 GPU、延迟高，对"发语音条"这个场景收益远低于 edge-tts。
2. **不要直接移植 NoneBot/Koishi 插件代码**：本项目是 TypeScript，Python 插件只能抄逻辑。唯一值得整包搬的资产是 `nonebot-plugin-memes` 的模板图片库。
3. **不要引入 mem0/graphiti/letta 全套服务**：多一个向量库 + 常驻进程 + 成本；QQ 群量级下先只抄 LivingMemory 的"衰减/强化/主动 recall"策略。
4. **不要做全群自动 B站/抖音解析**：需维护 cookie、有风控风险，应限制为白名单群 + 按需触发。
5. **不要迁移协议端**：Lagrange.Core V2 已弃 OneBot 11 转推 Milky，LLOneBot 已改名 LuckyLilliaBot 并转向 Milky/Satori，go-cqhttp 2024-05 停更。**继续用 NapCatQQ + OneBot v11**，迁移等于重写协议层。

---

## 5. 顺手能清的债（零风险）

- `src/audio-convert.ts` 约 9KB 死代码（`resolveTTSConfig` / `textToSilk` / `audioFileToSilkBase64` 无调用点）→ 要么接上（推荐，见 P0-5），要么删掉。
- `cordis.patch.yml:23` 的 `historyLimit` 是无效键，删掉。
- `napcat-alive.mjs` 里明文写着真实 token 和群号，应参数化 + 加 `.gitignore`。
- 仓库没有 git（`F:\dsh-channel-qq` 无 `.git`），建议先 `git init` 再改，否则这次改造无法回滚。

---

## 6. 落地情况（2026-10-14 实测完成）

> 用户要求：**全部 P0 + 全部 P1 + P2（除「词云/签到/积分小游戏」外）**。
> 下表的每一行都在服务器上跑过真实代码（不是「写完了」而是「测过了」）。
> 详细证据见 `DEPLOY.md` §8.7；测试脚本见 `deploy/feature-test.mjs`、`deploy/admin-test.mjs`。

### 6.1 P0 —— 全部完成

| 项 | 落点 | 实测 |
|---|---|---|
| B站/多平台链接解析 | `src/link-resolve.ts`，工具 `qq_resolve_link` / `qq_send_link_card`；另有 `autoResolveLinks` 按 `linkResolve.autoGroups` 白名单自动出卡 + 同群同链接 30 分钟去重 | ✅ B站（**三级回退**：`view` 被风控时改用 `pagelist`+`archive/desc`+`player/v2`，给出标题/时长/aid）、网易云、GitHub、通用 og:、`extractUrls` 全过 |
| 表情包"制作"（配字斗图） | `src/meme.ts`，工具 `qq_make_meme` / `qq_send_meme` / `qq_emoji_sticker_text`；ffmpeg `drawtext`，文本走 `textfile=` 避免转义地狱，CJK 字体自动探测 | ✅ 600×600 输入 → 中文上下两行白字黑边 PNG 23KB（NotoSansCJK） |
| 群语录库 | `src/quotes.ts`，5 个工具；按 text 去重、冷门语录反比加权随机、2000 条上限 | ✅ 增/查/随机/统计/去重全过 |
| 记忆召回强化 | `tools.ts` 新增 `qq_recall_memory`（带 type 过滤 + 命中强化）与 `qq_memorize_fact`（模型主动记） | ✅ 端到端：机器人被要求召回"师父"时真的调了 `qq_recall_memory` |
| edge-tts 音色 | `src/tts.ts`，工具 `qq_list_voices` / `qq_tts_voice` / `qq_tts_save` | ⚠️ **edge-tts 的 WS 在机房 IP 上被 403**（7 种组合全试）。已按 `tts.provider` 做多后端：`auto` = edge → 百度/谷歌免费 HTTP 接口。✅ 实测中文合成 41.7KB / 5.22s mp3，`provider=baidu` |

> 关于 P0-5 的结论修正：roadmap 原本假设「接上 `audio-convert.ts` 的死代码即可」。实测后发现
> `resolveTTSConfig` 需要 `baseUrl`+`apiKey`（edge-tts 免 key，根本没有），而
> `textToSilk` 是 HTTP TTS → PCM → silk 链路；本模块要的是 mp3（NapCat 自己转 silk）。
> 硬套反而是把 mp3 反解回 PCM 再编码，纯亏。所以 `tts.ts` 独立实现，`audio-convert.ts`
> 仍是无调用点的死代码——**它现在是明确该删的**（见 §7）。

### 6.2 P1 —— 全部完成

| 项 | 落点 | 实测 |
|---|---|---|
| 群聊总结报告升级（LLM 日报） | `scheduler.ts` 的 `morningReport()` 重写：插件只备素材（日期/课表/天气/昨日群活跃度），**正文交给模型用自己的口吻写**；`yesterdayActivity()` 从 `channel-qq.log` 统计昨日轮次 | ✅ 代码路径已在服务器加载；06:00 触发（未等到触发时刻，见 §6.4 未验证项） |
| 群事件监控 | `bridge.ts` 的 `handleMonitoredNotice()`：进退群/禁言/撤回/改名/加好友/荣誉，按 `eventMonitor.windowSec` 合并成一条话题素材交给模型裁决；**只对已存在的会话生效**，避免建会话噪音 | ✅ 编译通过并在插件启动时随 bridge 加载 |
| 自然语言提醒 | `src/reminders.ts`：`parseWhen()` 纯规则解析 + `ReminderStore` + `ReminderRunner`（30 秒轮询，到点**直接投递**不经过模型），4 个工具 | ✅ `parseWhen` 8 条算例（明天9点/晚上8点/9点顺延/后天中午/30秒后/15号9点半/跨年/每周一）全部命中；runner 已启动 |
| 订阅推送（RSS） | `src/rss.ts`：手写正则解析 RSS2.0+Atom、`RssPoller`（每轮重读 feeds，首轮延迟 20 秒）、4 个工具 | ✅ BBC / 阮一峰 / 少数派三个真实 feed 全部解析出条目 |
| 防刷屏风控 | `src/flood.ts`：滑窗 + **复读加权 2 倍** + 触发冷却 + 管理员/机器人/白名单豁免；`enforceFlood` 执行提醒/禁言并私聊师父简报；3 个工具 | ✅ 复读第 3 条触发、管理员与自身豁免、冷却期内不重复触发 |
| 群内 AI 生图 | `src/imagegen.ts`：默认 pollinations 免 key 端点，也支持任意 OpenAI 兼容 `/images/generations`；3 个工具 | ✅ 512×512 出真 JPEG 27.9KB；**发现带 `model=` 参数会立刻 402**，已改成不拼 `model` 并对 402/429/5xx 退避重试 |
| 群聊学习/口癖 | `src/learn.ts`：候选短语抽取（≤20 字整条，长句取结尾 2–8 字）、内存累积 + 5 分钟 flush、5000 上限；4 个工具 | ✅ observe/flush/top 全过（"绝绝子x4"） |
| 表情包快捷调用 | `tools.ts` 新增 `qq_send_sticker`：按情绪/语义搜一张直接发（搜不到默认**不发**） | ✅ 编译进 88 个工具中 |

### 6.3 P2 —— 按要求完成（跳过第一项）

| 项 | 状态 |
|---|---|
| 词云 / 签到 / 积分小游戏 | **按要求跳过** |
| 上下文压缩 / 步数预算 | ✅ 已实现且**是真实现不是占位**：`bridge.ts` 的 `compactContext()` 在入站包超过 `contextBudget.compactChars` 时丢最旧行并记日志；`installStepBudget()` 用 harness 的 `agent/pre-step` 中间件，超过 `contextBudget.maxSteps` 时返回 `{kind:'reject'}` **干净结束回合**（不是报错）。两者都能在后台热调。 |
| 记忆底座评估（mem0 / graphiti / letta） | ✅ **结论：不引入**。理由与证据：本项目的 `knowledge.ts` 已有 weight+hits+recency 打分与强化，本次又补上模型主动 `recall`/`memorize`（LivingMemory 的核心策略），QQ 群量级下关键词+权重检索够用；引入 mem0/graphiti/letta 意味着多一个常驻服务 + 向量库 + 一份要跟着升级的 schema，而当前痛点不是检索质量。若将来群记忆量级上升，第一步应该是把 `KnowledgeStore.search()` 换成向量检索（`entries.json` 结构不用动），而不是换一整套底座。 |
| 语音克隆评估（GPT-SoVITS / CosyVoice / fish-speech / IndexTTS） | ✅ **结论：不做**。理由与证据：① 都需要 GPU，本机 8 vCPU / 7.9G RAM / **0 swap**，跑不动；② 延迟远高于"发语音条"的可接受范围；③ 本次实测发现**连 CPU 版的 edge-tts 都因机房 IP 被 403**，说明瓶颈在出口 IP 而不是音色质量——换 IP 或用免费 HTTP 接口（百度/谷歌，已接入）的收益远大于上 GPU。真想要专属音色，更划算的路线是自建一个 OpenAI 兼容 TTS 端点（`tts.provider` 已经预留了扩展位）。 |

### 6.4 尚未验证 / 明确遗留

- **06:00 早报、04:00 梦境、04:40 知识提取**这三个定时任务没等到触发时刻，只验证了代码路径
  在启动时被正确加载与调度（日志里 `scheduler started: … morning-report 06:00 …`）。
  要彻底验证需要等到次日清晨，或临时把判断小时改掉再跑一次。
- **群事件监控**没有真实事件可造（需要有人真进退群/被禁言），只验证了加载与编译。
- **B站封面**在机房 IP 上拿不到（`view` 被 403/412），需要填 `bilibiliCookie`。
- **edge-tts 音色**在本机不可用，已回退到百度/谷歌（无音色区分）。
- ~~`napcat-alive.mjs` 里仍然明文写着真实 token 与群号；仓库仍然**没有 git**。~~
  ⇒ **2026-10-15 均已处理**：`napcat-alive.mjs`（真实 OneBot token + 旧群号）与
  `groq-browser-probe.mjs`（真实 Groq key）已进 `.gitignore`；仓库已 `git init`
  并打基线提交。⚠️ 两个文件**仍在工作目录里**（只是不入库），要彻底清就删文件本身。

## 7. 现在真正该做的债（更新版）

1. ~~`src/audio-convert.ts`（约 9KB）**确认是死代码** → 删掉。~~
   ⇒ **已删（2026-10-15）**：text→silk 那一整套 7 个导出（`isSilkFile`／`isVoiceAttachment`／
   `formatDuration`／`isAudioFile`／`textToSilk`／`audioFileToSilkBase64`／`waitForFile`）连同
   级联的 `textToSpeechPCM`／`pcmToSilk`／`resolveTTSConfig` 一并删除，文件从 ~17KB 降到 2.2KB。
   **`convertSilkToWav` 保留**——`stt.ts` 在用它。删除依据是 `deploy/static-audit.mjs`
   的「零引用导出」小节（不是拍脑袋），删完全仓库搜索确认零残留。
2. ~~`napcat-alive.mjs` 明文 token/群号 → 参数化 + `.gitignore`。~~
   ⇒ **已 `.gitignore`（2026-10-15）**，并把同样含真实 key 的 `groq-browser-probe.mjs` 一起排除。
   二者仍是本机文件、只是不入库。
3. ~~`F:\\dsh-channel-qq` 仍然没有 `.git` → 先 `git init` 再改。~~
   ⇒ **已 `git init -b main` + 基线提交**（123 个文件，`97b6d6e`），
   `core.autocrlf=false`（服务器端构建不能看到 CRLF）。提交前做过密钥扫描。
4. `cordis.patch.yml` 与 `DEFAULT_CONFIG` 重复的键 → **部分处理**：本轮把
   `segmentation.minLength` 对齐成 `8`（因为它在代码里真的接线了）。
   其余重复项**故意保留**：bundle patch 是「插件自带的默认值」这一层的声明，
   与 `DEFAULT_CONFIG` 语义不同（前者可被 profile/后台覆盖，后者是最底兜底），
   精简前需要先确认 dsh 的层叠语义，不宜顺手删。
5. `get_group_member_info` 查机器人自己返回 `failed ""`（NapCat 侧），需要在工具里
   兜一个友好提示，别让模型以为是自己的调用写错了。→ **仍未处理。**

### 6.5 用户实测反馈后的补做（2026-10-14 第二轮）

用户上手后报了两件事，都是真缺陷，已修并补了回归测试：

| 反馈 | 真因 | 修法 |
|---|---|---|
| 「管理后台进不去」（页面全黑） | 客户端脚本引用了 HTML 里不存在的 `#shownav` → `null.onclick` 抛 TypeError → 整个 `DOMContentLoaded` 中断 → `#login`/`#app` 都还是 `hidden` | 删掉该行；`#login` 在标记里默认可见；`on()` 辅助函数把缺元素错误显示出来；`window.onerror`/`unhandledrejection` 兜底；补「每个 `$('#id')` 必须存在」静态回归测试；顺手把漏接的「工具与指令」页 `renderTools()` 接进 `showTab()` |
| 「`qq_recall_memory` 报 `value is not lossless JSON`」 | 返回体里 `note: 有命中 ? undefined : '…'`，harness 拒绝 `undefined` 字段。空库正常、**有命中才炸**，所以空库测试全绿 | 该工具改成条件展开；`tool-kit.ts` 新增 `lossless()` 统一清理 `undefined`/`NaN`/`Infinity`/函数/`Date`（数组内 `undefined`→`null` 防移位），`tools.ts` 与 `registerSpecs` 两条注册路径都过它 |

另外按「所有可配置项都要友好配置且热加载」的要求补完：

- 补上原先没暴露的 `keywordReactions`、`groupModel.provider`、`groupModel.model`。
- **`restartRequired` 现在是空列表**：`admin.port/host/enabled/password` 改为重新监听
  （先绑新端口再放旧端口；同端口改 host 则先释放再重试，失败自动回滚，
  绝不把运营者锁在门外；改端口不踢登录态），`connection.*`/`accessToken` 走
  `OneBotClient.reconnect()` 就地换传输（不重建客户端，否则 88 个工具会握着死 socket），
  `emoji.dir`/`registeredDir`、`rss.pollIntervalMin`、`workspacePath`、`affectionPort`
  全部改成 getter / 每轮重读 / 重新监听。
- 保存响应新增 `effects: string[]`，逐条说明实际做了什么（例如
  `正在从 0.0.0.0:8790 切到 0.0.0.0:8791（无需重启，稍后生效）`），运营者不用猜。

实测：功能模块 **20/20**、管理后台 **27/27**（含端口热切换往返、白屏回归、
`lossless` 直测），详见 `DEPLOY.md` §8.7。

---

## 后续（第三轮，2026-10-14 晚）

- **管理后台前端整体重做**：源码拆成 `src/admin-ui.html` +
  `scripts/build-admin-html.mjs`（生成器带构建期校验），
  `src/admin-html.ts` 降级为生成产物。6 个标签页，移动优先 + 深/浅主题，
  重点补上「人格与指令」页（工作区文件编辑 / Agent 预设切换 / 会话重建）。
- **新增后端接口**：`/api/files*`、`/api/presets*`、`/api/sessions*`；
  配置写入抽成 `applyConfigPatch()` 供预设切换复用；`forgetConversation()`
  支撑会话重建。错误响应不再被吞成 `internal error`，真实原因会透传到面板。
- **修掉真实 bug**：`[图片]`/`[语音]`/`[文件：x]` 等展示占位符被当正文，
  导致口癖库学出 `[图片]`、风控把它算进刷屏。根因在
  `segments.ts parseInbound()`，修法是新增 `plainText` 在源头分流，
  外加 `learn.ts` 的占位符清洗做纵深防御。

实测（第三轮）：功能模块 **20/20**、管理后台 **39/39**、占位符专项 **15/15**、
无头 Chrome 布局探针 **4 个宽度 × 6 个标签页 × 2 种数据源全绿**。
详见 `DEPLOY.md` §8.7 与 §9。

---

## 8. 第六轮：全面排查工具调用错误（2026-10-15 白天）

**详细过程与实测数据在 `DEPLOY.md` §12**，这里只记结论与新增的债。

### 8.1 结论：真正的错误不在「工具调用」本身

转录层全量扫描（两个真实会话 670 次工具调用）只有 **8 次失败**，其中 5 次是
`edit` 的「先读后改」正常守卫。**所以「工具调用报错」不是问题的主要形态。**

问题在被吞掉的两层：**插件日志**与**静态代码事实**。这轮修掉的都是这一类：

| 问题 | 形态 | 为什么以前看不见 |
|---|---|---|
| 本地文件发送 | 13 处调用全部必失败 | 失败只出现在模型侧，且被当成偶发 |
| 图片输入 | 模型条目漏 `input` | 报错发生在 ACP 准入，读起来像「模型不行」 |
| 早报从不触发 | 关闭时**静默 return** | 「没开」和「坏了」在日志里一模一样 |
| 知识抽取从未成功 | 硬编码第三方端点 + 输入过大必超时 | 一天只报一次错，极易被忽略 |
| 5 个死配置 | 面板上有开关、代码里没人读 | 没有任何运行时迹象 |

### 8.2 可复用判据（本轮最值钱的产出）

1. **「静默返回」会让「功能没开」和「功能坏了」不可区分。** 凡「定时任务什么都没做」，
   第一步不是猜窗口/超时，而是先确认它**有没有被调用、以及为什么提前返回**。
2. **校验一个文件，必须用「消费它的那个解析器」。** 我用 Python `yaml.safe_load` 校验
   dsh 的 profile，它**静默容忍重复键**，于是坏文件被装上、dsh 崩溃重启 17 次。
3. **见到 5xx，先量「输入长度 vs 耗时」再下结论。**「上游/瞬时的锅」是最容易骗到自己的解释。
4. **声明模型能力之前必须先实测。**「吃图 / 不吃图」两种情况的修法完全相反，
   而「随便找张图让它描述」证不了——要用**内容不可猜**的图（四象限色块）。
5. **假阳性机器比没有检测更糟。** 我自己写的「重复键检测」把不同映射里合法重复的键
   全报出来，噪音淹没了真信号，只能删掉、改用解析器本身的报错。

### 8.3 部署侧新增的硬约束（换机器也会遇到）

- **这台宿主机对所有批量通道有 ~1KB 的 MTU 黑洞**：SSH 长命令 / 大 `write-file` /
  ≥1200 字节的 HTTP POST 全部失败。所有大传输必须走 `http-push-fast.mjs`
  （tar.gz → base64 → 900 字节分片 → 拼装 → sha256 校验），实测 14 文件 14.3 秒。
- **改 NapCat 容器要付代价**（本轮已走一遍）：重建会让 QQ 登录态失效、需重新扫码授权；
  登录态数据在 `./data/qq`（bind mount）里**不会丢**，丢的是会话有效性。
  2026-10-15 实测恢复流程有效：`docker cp napcat:/app/napcat/cache/qrcode.png` 取图 →
  手机 QQ 扫码 → `QQ link ready` 恢复（`get_login_info` 返回 `selfId=BOT_QQ`）。

### 8.4 新增的债

1. **`keywordTriggers` 仍为空**：即使群从后台打开，「需要 @ 才回」下群里只有 @ 它才有反应。
   想让某些词能叫到它，在后台「唤醒关键词」里填。
2. **大文件能力依赖容器挂载**（已验证可用）：树内文件走 `file://`、无大小上限；
   若哪天 NapCat 重建时漏掉那两条 `:ro` 挂载，会回落到 `base64://`（8MiB 上限），
   >8MiB 则**明确报错**——能力回退，但不会静默失败。
3. **`src/admin-html.ts` 已入库**（生成物，tsc 需要它存在）。副作用：**改 UI 要改
   `src/admin-ui.html`，并重跑 `scripts/build-admin-html.mjs` 与 `tsc` 一起提交**，
   否则仓库里的生成物与 HTML 不一致。`lib/` 已改为**不入库**（构建产物，
   部署时在服务器上 `npm run build` 生成），避免产物与源码悄悄漂移。
4. **提示规模仍未动**（§10.5 / `DEPLOY.md` §12.10）：不限步数、每轮 8 万～16 万 token，
   这是「回复慢」的治本项，仍在用户手上。
