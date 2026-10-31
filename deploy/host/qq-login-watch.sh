#!/usr/bin/env bash
# ============================================================================
# dsh：开机后如果 QQ 没登录，自动重启一次协议端
#
# 背景（2026-10-31 实测）：QQ 的「自动登录」在这个无头容器里**不会自己提交**。
#   - 账号信息是记得的（登录页预填，`QQ/auth/login.enc` 在每次人工登录时更新）；
#   - 但开机后 SnowLuma 一直停在 `[Hook] awaiting login`，16 小时没有 login detected；
#   - 网络不是原因：`network-online.target` 在容器启动前 7 秒就绪。
# 也就是说：机器每天被正常关机重启一次 → 每次重启都要人工点一次「登录」。
#
# 这个守护做的事（每个 boot 最多一次，避免循环）：
#   开机 3 分钟后若协议端的 OneBot 端口（3001）没起来 →
#   `docker restart snowluma` → 等 2 分钟再查一次 → 结果写日志。
# 假设是"冷启动那次自动登录没成，环境热起来后重启能成"；下一轮重启的日志就能证实
# 或推翻它。查不到就写一条**明确的人工指引**，不再让人猜。
# ============================================================================
set -uo pipefail

LOG=/var/log/dsh-qq-login-watch.log
TRIED=/run/dsh-qq-login-watch.tried
CONTAINER=snowluma
PORT=3001

stamp() { date '+%Y-%m-%d %H:%M:%S%z'; }
log() { echo "[$(stamp)] $*" >>"$LOG"; }

command -v docker >/dev/null 2>&1 || { log "没有 docker，跳过"; exit 0; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { log "容器 $CONTAINER 不存在，跳过"; exit 0; }

# OneBot 端口在容器里是否监听（QQ 未登录时 SnowLuma 不会启动它）
onebot_up() {
  docker exec "$CONTAINER" sh -c "ss -ltn 2>/dev/null | grep -q ':${PORT} '" >/dev/null 2>&1
}

if onebot_up; then
  exit 0
fi

if [ -f "$TRIED" ]; then
  log "协议端仍未就绪，但本 boot 已经重启过一次（不重复重启）。需要人工登录："
  log "  ssh -p 22 -L 6081:127.0.0.1:6081 root@<host>  然后浏览器开 http://127.0.0.1:6081 点「登录」"
  exit 0
fi

: >"$TRIED"
log "协议端未就绪（容器里 ${PORT} 没监听，多半是 QQ 没自动登录），重启一次 $CONTAINER"
docker restart "$CONTAINER" >>"$LOG" 2>&1

# 给 QQ 两分钟：启动 + 自动登录 + SnowLuma 起 OneBot
for _ in $(seq 1 24); do
  sleep 5
  if onebot_up; then
    log "重启后已恢复：${PORT} 在监听（说明「热重启能自动登录」成立）"
    exit 0
  fi
done

log "重启后仍未恢复：QQ 仍停在登录页。自动登录在本环境不可用，需要人工点一次："
log "  1) ssh -p 22 -L 6081:127.0.0.1:6081 root@<host>"
log "  2) 浏览器打开 http://127.0.0.1:6081 ，点登录（账号已记住，通常一次点击即可）"
log "  3) 登录成功后插件会在 60 秒内自动 QQ link ready"
exit 0
