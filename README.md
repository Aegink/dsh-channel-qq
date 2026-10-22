# dsh-channel-qq

[![CI](https://github.com/Aegink/dsh-channel-qq/actions/workflows/ci.yml/badge.svg)](https://github.com/Aegink/dsh-channel-qq/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

把 QQ 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的渠道插件。
通过 **OneBot v11**（协议端默认用 [SnowLuma](https://github.com/SnowLuma/SnowLuma)，
NapCat 仍可作回滚方案）收发消息，
以 cordis `Service` 形式挂进 dsh，提供工具面、长期记忆、主动行为与管理后台。

> 非官方项目，与腾讯 / QQ 无隶属关系。协议端属于非官方实现，**账号风控、掉线、
> 要求重新验证都是常态**——请自行遵守 QQ 用户协议与当地法律。

## 特性

- **消息**：群聊 / 私聊、图片、语音、文件、引用回复、戳一戳，自动分句发送
- **工具面**：90 个细粒度工具；`tools.v2` 下合并为 17 个动作组（`qq_message`、`qq_lookup`…）
- **群聊准入**：进 agent 之前先判"要不要说话"；非 @ 消息不进队列，省上下文与模型调用
- **长期记忆**：日记 → 结构化记录 → 检索；夜间九个任务（分块 / 抽取 / 反思 / 遗忘 / 摘要 / 向量重建）
  - 每回合自动注入 3–8 条证据（≤600 字）；`qq_memory_search` 深召回原文块（带文件行号）
  - 可选向量检索：本机 embed 服务（`deploy/embed-server/`），不开就退回关键词
- **主动行为**：事件书驱动巡逻、早报、主动私聊——时间表是数据，不是代码
- **技能**：磁盘上的 Agent Skills 目录包（`SKILL.md`），按房间定可见范围
  （全部 / 仅私聊 / 指定群 / 指定房间 / 仅管理员），模型自动发现 + `/名字` 直接触发；
  后台可增删改、从 URL 或粘贴导入（先落待审区）
- **管理后台**：27 个页面，配置热生效、审计、会话重建、模型供应商管理
- **发送侧探针**：`/api/healthz` 用一次 `get_status` 往返判断"消息发不发得出去"，
  不产生消息、只接受本机请求
- **曲库账号**：后台「音乐」页扫码登录网易云 / 酷狗（二维码在浏览器本地生成），
  可看登录态、清除登录、先搜一首歌自检，不必等群里点歌才发现没登录
- **审批网关**：高危命令 L0–L3 分级 + 一次性令牌；管理员在 QQ 私聊回一句「批准」即可执行
  （`待批 / 申请 / 批准 / 拒绝`，全程不经模型）
- **交互提示（可选，默认关）**：私聊回合显示「正在输入」，群里给触发消息贴一个表情回应
- **合并转发（可选，默认关）**：长清单/日志/总结改发一张聊天记录卡片，失败自动回退逐条
- **指标（可选，默认关）**：回合耗时 p50/p90、token 四个桶、发送/工具失败，后台按房间与天看
- **原话簿（可选，默认关）**：按群按日保存原始消息流水（`<工作区>/chatlog`，默认保留 14 天），
  `qq_group_digest` 可按日期翻某群聊了什么
- **人物档（可选，默认关）**：`qq_person_note` 手动记录「谁爱用什么说法、忌讳什么」，
  按群分开存，与自动侧写互补
- **渠道健康告警（可选，默认关）**：消息链路失联超过阈值私聊管理员，恢复后再报，同场故障限频
- **访问门控（默认开）**：陌生人私聊 / 未批准的群只回一句「待主人批准」，不进 agent；
  后台「安全」页批准后才放行（也可切白名单或全放行）

## 与其它 QQ 接入方案的分工

dsh 生态里已经有几种 QQ 接入，定位不同：

| 方案 | 接入 | 适合 |
|---|---|---|
| [官方 dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) | QQ Bot API v2 | 官方机器人身份、扫码、流式回复；不接个人号 |
| [dsh-im](https://github.com/xmanrui/dsh-im) | 13 个 IM 渠道 | 一个插件同时接多种平台，广而薄 |
| **本项目** | OneBot v11（SnowLuma） | **个人 QQ 号 + 完整群能力**：长期记忆、知识库、主动行为、审批、技能包、群运营 |

选型建议：要官方身份与流式，用官方插件；要一次接多个平台，用 dsh-im；
要一个「住在群里」的长期陪伴/群运营机器人，用本项目。

## 快速开始

需要 **Node.js 22+**、一个 dsh 宿主、一个 OneBot v11 协议端。

```bash
npm install
npm run build      # 生成后台前端 + 编译 TypeScript
npm run verify     # 类型 + 测试 + 分层 + 体积，全绿再继续
```

挂载（`<dshHome>/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: channel-qq
  config:
    connection: { mode: forward, url: ws://127.0.0.1:3001 }
    accessToken: <OneBot access token>
    selfId: <机器人 QQ 号>
    admins: [<管理员 QQ 号>]
    primaryGroup: <主群号>
    workspacePath: /path/to/agent-workspace
```

部署与运维细节见 [docs/deployment.md](docs/deployment.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 分层、消息旅程、关键决定、往哪里加东西 |
| [docs/configuration.md](docs/configuration.md) | 配置三层覆盖、生效方式、环境变量 |
| [docs/deployment.md](docs/deployment.md) | 部署、发布、回滚、故障排查 |
| [docs/memory.md](docs/memory.md) | 记忆系统：夜间任务、embed 服务、评测与限制 |
| [docs/memory-standalone.md](docs/memory-standalone.md) | 记忆库插件化：脱离 cordis 独立使用 |
| [SECURITY.md](SECURITY.md) | 威胁模型与部署清单 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 门禁、硬规则、提交信息 |

## 开发

```bash
npm run verify        # 门禁
npm run eval          # 行为评测（红队 7 + 场景 15 + 人格 30 + 转录 8 + 记忆基准）
npm run audit         # 静态审计
npm run probe:admin   # 后台浏览器回归（headless Chrome）
```

- `test/golden/**` 是逐字节快照：改动输出必须先解释差异，不能静默更新。
- 每个改变行为的升级都必须带独立开关、默认关——关着时与旧版逐字节一致。

## 目录

```
src/
  core/       纯逻辑（可重放）
  app/        入站流水线、组包、回合
  features/   子插件（工具、记忆、主动行为、后台、审批…）
  adapters/   宿主与外部世界
  config/     配置 schema 与页面清单
assets/persona/  人格与提示词（纯文本）
deploy/          发布、备份、审批执行器
eval/            行为评测
scripts/         构建与门禁
```

## 安全

管理后台是**远程控制面**：默认只监听 `127.0.0.1`，请通过 SSH 隧道访问；口令只从
环境变量读取。详见 [SECURITY.md](SECURITY.md)。

**访问门控**：默认 `access.mode = pairing`——陌生 QQ 的私聊、以及尚未批准的群里的
消息，只会收到一句「待主人批准」，不会进入 agent；主人在后台「安全」页批准后放行。
管理员始终允许。需要预先授权时可把模式改成 `allowlist`，用 `access.allowUsers` /
`access.allowGroups` 指定名单；`open` 是旧的全放行行为，不建议在公网使用。

管理员也可以直接私聊机器人处理，不必开后台：

| 私聊命令 | 作用 |
|---|---|
| `待批访问` / `访问请求` | 列出待批的人/群，并给出可复制的放行命令 |
| `放行 999` | 批准某个 QQ 的私聊 |
| `放行群 107` | 批准某个群 |
| `拒绝访问 999` / `拒绝访问群 107` | 拒绝 |

这些命令只认管理员私聊，且在高危命令审批网关之前处理（动词刻意用「放行」，
不与网关的「批准/拒绝」冲突）。

**群策略** `access.groupPolicy`：

| 值 | 行为 |
|---|---|
| `member`（推荐） | 机器人已经在的群直接放行——加群本身就是主人操作，不用逐群批准 |
| `pairing`（默认） | 未批准的群先申请，和私聊一样待主人批准 |
| `allowlist` | 群只认 `allowGroups` 与后台已批准列表 |

私聊始终按 `mode` 走配对/白名单。群消息仍然受 `groupEnabled`、`requireMention`
与「群聊与房间」里的按群覆盖约束——那两处管的是“怎么回”，访问门控管的是“能不能触发”。

**未批准的群默认完全安静**：只有真正 @ 或命中关键词的消息才会生成一条请求并私聊通知
主人，群里不回「待主人批准」（`access.replyPendingInGroups` 可打开，且每个请求只回一次）。
没人叫机器人的闲聊不会触发配对，也不会刷屏。

## 许可

[MIT](LICENSE)
