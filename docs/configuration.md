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
