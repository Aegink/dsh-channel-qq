#!/usr/bin/env bash
# ============================================================================
# dsh：确保 docker 网桥都有网关地址（= 宿主机到容器网段的路由）
#
# 为什么需要它：这台机器每次重启后，docker 网桥（docker0 / br-*）会**丢掉 IP**，
# 于是宿主机没有进入容器网段的网关，表现是
#   - `ip route get 172.21.0.2` 走到公网网关（没有 dev br-* 的直连路由）
#   - 所有「发布到 127.0.0.1」的容器端口都变成"TCP 能连上、请求没响应"：
#     docker-proxy 接了连接，再往容器 IP 转发时没路可走
#   - 协议端（SnowLuma/NapCat）的 OneBot 端口因此连不上，QQ 整条通道全废
# 2026-10-31 实测：四个网桥（含 docker0）地址全空，而容器内部自访问正常。
#
# 做法：只补**缺的**网关地址（幂等）；不碰镜像/容器/数据卷，也不重启 docker。
# 每次修复都写日志——下次再丢时，日志时间就是"什么时候丢的"的证据。
#
# 安装：见 deploy/host/README.md（systemd unit + timer，开机 30s 与每 5 分钟各跑一次）
# ============================================================================
set -uo pipefail

LOG=/var/log/dsh-docker-bridge-guard.log
stamp() { date '+%Y-%m-%d %H:%M:%S%z'; }

command -v docker >/dev/null 2>&1 || { echo "[$(stamp)] 没有 docker，跳过" >>"$LOG"; exit 0; }
docker info >/dev/null 2>&1 || { echo "[$(stamp)] docker 不可用，跳过" >>"$LOG"; exit 0; }

repairs=0
while read -r id; do
  [ -z "$id" ] && continue
  name=$(docker network inspect "$id" --format '{{.Name}}' 2>/dev/null) || continue
  br=$(docker network inspect "$id" --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null)
  [ -z "$br" ] && br="br-$(printf '%s' "$id" | cut -c1-12)"
  gw=$(docker network inspect "$id" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
  subnet=$(docker network inspect "$id" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null)
  [ -z "$gw" ] || [ -z "$subnet" ] && continue
  prefix=${subnet#*/}
  if ! ip link show "$br" >/dev/null 2>&1; then
    echo "[$(stamp)] 网桥 $br 不存在（网络 $name），跳过" >>"$LOG"
    continue
  fi
  if ip -br addr show "$br" | grep -q "${gw}/"; then
    continue
  fi
  if ip addr add "${gw}/${prefix}" dev "$br" 2>>"$LOG"; then
    echo "[$(stamp)] 修复 $name：$br += ${gw}/${prefix}" >>"$LOG"
    repairs=$((repairs + 1))
  else
    echo "[$(stamp)] 修复 $name 失败：$br += ${gw}/${prefix}" >>"$LOG"
  fi
done < <(docker network ls --filter driver=bridge --format '{{.ID}}')

if [ "$repairs" -gt 0 ]; then
  echo "[$(stamp)] 本轮修复 ${repairs} 个网桥" >>"$LOG"
fi
exit 0
