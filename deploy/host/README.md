# 宿主机运维脚本

这些脚本**不进发布包**，由部署者手工装到宿主机（它们动的是宿主网络/服务，不是插件）。

## docker-bridge-guard：重启后补回 docker 网桥地址

### 它解决什么

这台机器**每次重启后** docker 网桥（`docker0` / `br-*`）会丢掉 IP 地址：

```
$ ip -br addr show br-xxxxxxxxxxxx
br-xxxxxxxxxxxx   UP            ← 地址没了
$ ip route get 172.21.0.2
172.21.0.2 via <公网网关> dev eth0    ← 走到公网网关，没有直连路由
```

后果不是"报错"，而是**静默失效**：

- 所有「只发布到 127.0.0.1」的容器端口变成 *TCP 能连上、请求没响应*——
  `docker-proxy` 接住连接后往容器 IP 转发时无路可走；
- 协议端（SnowLuma/NapCat）的 OneBot 端口因此永远连不上，QQ 整条通道全废；
- 容器内部自访问正常（`docker exec … curl 127.0.0.1:5099` = 200），所以很容易误判成
  "WebUI 坏了 / QQ 没登录"。

2026-10-31 实测：四个网桥（含 `docker0`）地址全空，而容器本身跑得好好的。

### 安装

```bash
install -m 755 deploy/host/docker-bridge-guard.sh /usr/local/bin/dsh-docker-bridge-guard.sh
install -m 644 deploy/host/dsh-docker-bridge-guard.service /etc/systemd/system/
install -m 644 deploy/host/dsh-docker-bridge-guard.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dsh-docker-bridge-guard.timer
systemctl start dsh-docker-bridge-guard.service   # 立刻跑一次
tail -5 /var/log/dsh-docker-bridge-guard.log
```

### 验证

```bash
# 1) 健康时不做事（日志无新增）
systemctl start dsh-docker-bridge-guard.service && tail -1 /var/log/dsh-docker-bridge-guard.log

# 2) 故意删掉一个网桥地址，再跑一次，应被补回
ip addr del 172.21.0.1/16 dev br-xxxxxxxxxxxx
systemctl start dsh-docker-bridge-guard.service
ip -br addr show br-xxxxxxxxxxxx | awk '{print $3}'   # 应打印 172.21.0.1/16
```

### 注意

- 脚本**只补缺的地址**，幂等；不碰镜像、容器、数据卷，也不重启 docker。
- 每 5 分钟跑一次是"保险"：真出问题时最坏 5 分钟内自愈。修复时间都写进
  `/var/log/dsh-docker-bridge-guard.log`——如果它频繁修复，说明还有别的东西在清地址，
  日志时间就是查凶手的线索。
- 根因（谁把地址清掉的）截至 2026-10-31 未定位：`/usr/local/bin` 下没有 `ip addr flush`，
  cron/systemd timer 里也没有可疑项；dockerd 开机日志只有 nftables 清理报错。

## qq-login-watch：开机后 QQ 没登录就重启一次协议端

### 它解决什么

2026-10-31 实测：QQ 的「自动登录」在这个无头容器里**不会自己提交**。

- 账号信息是记得的（登录页预填；`QQ/auth/login.enc` 只在**人工登录那一刻**更新）；
- 开机后 SnowLuma 一直停在 `[Hook] awaiting login`，连续 16 小时没有 `login detected`；
- 网络不是原因：`network-online.target` 在容器启动前 7 秒就绪；
- 机器每天被正常 poweroff 一次，于是每次重启都要人工点一次「登录」。

守护行为（每个 boot 最多一次，防循环）：

1. 开机 3 分钟后若容器里 `3001` 没监听 → `docker restart snowluma`；
2. 等 2 分钟再查 → 结果写 `/var/log/dsh-qq-login-watch.log`；
3. 若仍没起来，日志里直接写**人工指引**（noVNC 地址 + 点登录），不再让人猜。

### 安装

```bash
install -m 755 deploy/host/qq-login-watch.sh /usr/local/bin/dsh-qq-login-watch.sh
install -m 644 deploy/host/dsh-qq-login-watch.service /etc/systemd/system/
install -m 644 deploy/host/dsh-qq-login-watch.timer   /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now dsh-qq-login-watch.timer
```

### 注意

- 「热重启后 QQ 能自动登录」是**假设**，不是已验证的事实：下一个重启周期的日志会证实或推翻。
- 如果证实无效，下一步才是给容器装 `xdotool` 去点登录按钮（镜像里目前没有，重建容器会丢，
  需要每次注入，属于更脏的手段）。
- 这个守护只判断「OneBot 端口有没有起来」，不判断登录态真假；登录态真假由插件的
  `channelHealth` 探针（`get_status` 往返）负责。

### 实测结果（2026-10-31 21:35 重启，一次通过）

| 时间（+08） | 事件 |
|---|---|
| 21:35:13 | 机器重启完成 |
| 21:35:43 | QQ 冷启动 → `[Hook] awaiting login`（**不自动登录**） |
| 21:38:25 | 守护触发：`协议端未就绪…重启一次 snowluma` |
| 21:38:33 | 容器重启 → 又一次 `awaiting login` |
| 21:39:39 | **`login detected: UIN=1000000001`**（热重启后 66 秒自动登录成功） |
| 21:40:04 | 插件 `socket open` → `QQ link ready` |

**结论：冷启动那次自动登录必然失败，热重启必定成功。** 全程 4 分 51 秒、无人干预。
据此把触发时间从「开机 3 分钟」提前到 **90 秒**（冷启动 30 秒就能判定失败）。
