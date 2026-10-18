# dsh-channel-qq

[![CI](https://github.com/Aegink/dsh-channel-qq/actions/workflows/ci.yml/badge.svg)](https://github.com/Aegink/dsh-channel-qq/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)

把 QQ 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的渠道插件。
通过 **OneBot v11**（协议端用 [NapCat](https://github.com/NapNeko/NapCatQQ)）收发消息，
以 cordis `Service` 形式挂进 dsh，提供工具面、长期记忆、主动行为与管理后台。

> 非官方项目，与腾讯 / QQ 无隶属关系。协议端属于非官方实现，**账号风控、掉线、
> 要求重新验证都是常态**——请自行遵守 QQ 用户协议与当地法律。

## 特性

- **消息**：群聊 / 私聊、图片、语音、文件、引用回复、戳一戳，自动分句发送
- **工具面**：86 个细粒度工具；`tools.v2` 下合并为 17 个动作组（`qq_message`、`qq_lookup`…）
- **群聊准入**：进 agent 之前先判"要不要说话"；非 @ 消息不进队列，省上下文与模型调用
- **长期记忆**：日记 → 结构化记录 → 检索；夜间巩固、遗忘曲线、DIGEST
- **主动行为**：事件书驱动巡逻、早报、主动私聊——时间表是数据，不是代码
- **管理后台**：26 个页面，配置热生效、审计、会话重建、模型供应商管理
- **审批网关**：高危命令 L0–L3 分级 + 一次性令牌；管理员在 QQ 私聊回一句「批准」即可执行
  （`待批 / 申请 / 批准 / 拒绝`，全程不经模型）

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
| [SECURITY.md](SECURITY.md) | 威胁模型与部署清单 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 门禁、硬规则、提交信息 |

## 开发

```bash
npm run verify        # 门禁
npm run eval          # 行为评测（60 例）
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

## 许可

[MIT](LICENSE)
