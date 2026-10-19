# 配置

## 三层覆盖

```
内置默认（src/config）
   ↓ 被覆盖
cordis.patch.yml（部署级）
   ↓ 被覆盖
后台保存的覆盖层（<dshHome>/channel-qq/admin-config.json）
```

后一层永远赢。后台改完即时生效，不需要重启（少数标注「需重启」的项除外）。

**「自动重载」是真的重载**：标着它的开关，值一变宿主就把对应子插件卸载重挂
（`watches` 声明）。2026-10-19 修过两处**声明了却没接上**的：记忆证据的注入面
（`inbound` 早于 `memory` 挂载，取值写死在 apply 里）与工具面（`qq-tools` 没监听
`tools.v2` / `memory.v2`）。加配置项时顺手确认 watch 列表，别让徽章说谎。

**手改 `admin-config.json` 不会进审计**：审计与变更历史都记在后台的保存路径上。
要留痕就从后台改；直接改文件只适合"配置坏了要救回来"这种场合。

## 生效方式

每个配置项在后台都带一个徽章：

| 徽章 | 含义 |
|---|---|
| 立即生效 | 下一次使用该值时读到新值，不重挂插件 |
| 自动重载 | 值变化时对应子插件卸载重挂 |
| 需重启 | 写入 `dsh` 进程的环境/监听地址等，重启后生效 |

## 环境变量

| 变量 | 作用 |
|---|---|
| `CHANNEL_QQ_ADMIN_PASSWORD` / `_HASH` | 管理后台口令（哈希优先） |
| `CHANNEL_QQ_ADMIN_ALLOW_REMOTE` | 允许后台监听非本机地址（默认关） |
| `CHANNEL_QQ_NAPCAT_ROOTS` | 允许 NapCat 直接读取的宿主目录（冒号分隔） |
| `CHANNEL_QQ_EXTRACTOR_BASE_URL` / `_MODEL` / `_API_KEY` | 知识抽取的模型端点。后台「记忆」页可覆盖这三项（填了就不看环境变量） |
| `CHANNEL_QQ_APPROVAL` | 审批网关开关（`1` = 启用） |
| `CHANNEL_QQ_APPROVAL_DIR` | 审批目录（默认 `/var/lib/dsh-approval`） |
| `CHANNEL_QQ_PERSONA_DIR` | 人格包目录（默认 `assets/persona/default`） |
| `KUGOU_API_BASE` | 酷狗自建 API 的地址（默认 `http://127.0.0.1:4000`）。后台「音乐」页的
  `music.kugouApiBase` 填了就以配置为准；两项都空则用默认值 |

## 最小可用配置

```yaml
- id: channel-qq
  config:
    connection:
      mode: forward
      url: ws://127.0.0.1:3001
    accessToken: <OneBot access token>
    selfId: <机器人 QQ 号>
    admins: [<管理员 QQ 号>]
    primaryGroup: <主群号>
    workspacePath: /path/to/workspace
```

其余项都有可用默认值。完整字段见后台「配置」各页，或 `cordis.patch.yml` 的注释。

## 技能

技能是**磁盘上的目录包**，不是配置数组；后台「技能」页负责增删改与导入。

```
<dshHome>/channel-qq/skills/       ← 默认仓库（skills.dir 可改）
  <name>/SKILL.md                   ← 目录包（推荐；可带 scripts/ references/ assets/）
  <name>.md                         ← 扁平技能
  .staging/<name>/                  ← 导入待审区（不会被启用，确认后才转正）
```

**不要把仓库指到工作区里**：工作区是 `workspace-write`，模型手里的 `write`
能改那里，而技能正文是会进系统提示的指令——等于给注入留一条持久化后门。

`SKILL.md` 用 [Agent Skills](https://agentskills.io/specification) 格式：`---`
包住的 frontmatter（必填 `name`、`description`；可选 `whenToUse`）+ Markdown 正文。
本插件额外识别 `metadata` 下这几个键：

| 键 | 取值 | 含义 |
|---|---|---|
| `channel-qq.visibility` | `all` / `none` / `dm` / `groups` / `rooms` | 可见范围；默认 `all` |
| `channel-qq.rooms` | `group-123,dm-456` | `groups` / `rooms` 模式下的房间清单 |
| `channel-qq.admins-only` | `true` / `false` | 只有管理员发起的回合能加载/触发 |
| `channel-qq.enabled` | `true` / `false` | 停用（不出现在目录里，也不能触发） |
| `channel-qq.scripts` | `true` / `false` | 这个技能带可执行脚本（还要全局 `skills.allowScripts`） |
| `channel-qq.source` | 任意字符串 | 导入来源（审计用） |

**可见范围在每次加载/触发时现算**，不缓存：改后台、改 frontmatter、改组，下一
回合立即生效。三条入口都走同一个判据（`core/skills/model.ts` 的
`skillVisibleTo`）：

| 入口 | 行为 |
|---|---|
| 模型目录（宿主 `skill` 工具） | **只收 `visibility: all` 且非管理员专属**的技能，避免受限技能的描述出现在每个房间 |
| `qq_skill` 工具（list / load） | 按当前会话的房间与发起人身份过滤 |
| 用户消息第一行 `/名字` | 同上过滤；命中后把正文注入这一回合 |

系统回合（巡逻、早报）没有"谁在看"的概念，只看得见 `all`。

后台列表会显示每个技能被加载 / 被触发过几次，计数写在
`<dshHome>/channel-qq/skills-stats.json`（不写回 `SKILL.md`，否则每用一次都会
改正文、让目录签名抖动）。

导入支持三种：粘贴全文、单文件 URL（GitHub blob 链接自动换成 raw）、GitHub
目录（`…/tree/<ref>/<path>`，递归下载，最多 200 个文件）。三种都先落 `.staging`。

