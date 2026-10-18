# dsh-channel-qq

把 QQ 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的渠道插件：
通过 **OneBot v11**（协议端用 [NapCat](https://github.com/NapNeko/NapCatQQ)）收发消息，
以插件形式挂进 dsh，提供工具面、长期记忆、主动行为与管理后台。

> 非官方项目，与腾讯 / QQ 无隶属关系。请自行遵守 QQ 用户协议与当地法律。
> **账号风控风险客观存在**：协议端属于非官方实现，掉线/被要求重新验证是常态。

## 它能做什么

| 能力 | 说明 |
|---|---|
| **收发消息** | 群聊 / 私聊、图片、语音、文件、引用回复、戳一戳；自动分句发送 |
| **工具面** | 86 个细粒度工具，`tools.v2` 下合并为 17 个动作组（`qq_message`、`qq_lookup`…） |
| **群聊准入** | 进 agent 之前先判"要不要说话"：被叫必回、其余看情况、别的 bot 与纯表情直接挡下 |
| **长期记忆** | 日记 → 结构化记录 → 检索；夜间巩固、遗忘曲线、DIGEST |
| **主动行为** | 事件书驱动：巡逻、早报、主动私聊、夜间巩固——时间表是数据，不是代码 |
| **管理后台** | 26 个页面：状态、配置（112 项）、日志、审计、会话重建、模型供应商 |
| **模型供应商** | 三种协议（OpenAI Chat Completions / Responses、Anthropic Messages）+ 自定义请求头，内置 CC / Codex 预设，带五档实测 |

## 环境要求

- Node.js **22.x**（`node --test` 与内置 `WebSocket` 需要）
- 一个 dsh 宿主（本插件以 cordis `Service` 形式挂载）
- 一个 OneBot v11 协议端（推荐 NapCat，正向 WebSocket，默认 `ws://127.0.0.1:3001`）

## 快速开始

```bash
npm install          # 只装两个运行时依赖（silk-wasm / ws）
npm run build        # 生成管理后台前端 + 编译 TypeScript
npm run verify       # 类型检查 + 全部测试 + 层规则 + 体积棘轮
```

把仓库目录放进 dsh 的插件搜索路径，或用 `cordis.patch.yml` 作为 profile 补丁挂载。
最小配置（`<dshHome>/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: channel-qq
  config:
    connection:
      mode: forward
      url: ws://127.0.0.1:3001
    accessToken: <OneBot 的 access token>
    selfId: <机器人 QQ 号>
    admins: [<管理员 QQ 号>]
    primaryGroup: <主群号>
    workspacePath: /path/to/agent-workspace
```

完整配置项见 `DEPLOY.md`，或在管理后台逐项查看（每项都有中文说明与生效方式）。

## 测试

```bash
npm run verify   # 门禁：后台产物一致 → 语法 → 类型 → 测试 → 层规则 → 体积
npm run eval     # 行为评测（60 例，金标准对比）
npm run audit    # 静态审计（未使用导出、危险模式等）
```

- `test/golden/**` 是**逐字节快照**：改动输出必须先解释差异，不能静默 `--update`。
- `scripts/check-size.mjs` 是体积棘轮（单文件 ≤400 行、单函数 ≤60 行，只减不增）。

## 目录结构

```
src/
  adapters/      宿主与外部世界的实现（OneBot、http、fs、人格包、凭据）
  app/           应用层：入站流水线、组包、回合、策略
  core/          纯逻辑（可重放：不读时钟、不掷随机、不碰 node:* 之外的 IO）
  config/        配置 schema 与页面清单（后台 UI 的单一事实来源）
  features/      子插件：每个功能一个目录（工具、记忆、主动行为、后台…）
  admin/         管理后台的 HTTP 面与前端（原生 ES 模块，无框架）
assets/persona/  人格与提示词（纯文本，可整体替换）
deploy/          部署与发布脚本
eval/            行为评测
scripts/         构建与门禁脚本
```

## 安全

管理后台是一个**远程控制面**：默认只监听 `127.0.0.1`，请通过 SSH 隧道访问；
口令只从环境变量读取，不要在配置里写明文。详见 `SECURITY.md`。

## 许可

[MIT](LICENSE)
