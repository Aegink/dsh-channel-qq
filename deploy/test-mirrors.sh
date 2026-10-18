#!/bin/bash
# 测试可用镜像加速源（不修改 daemon 配置，仅用于 docker pull 显式指定）
echo "=== 镜像源连通性 ==="
for m in docker.m.daocloud.io docker.1ms.run dockerproxy.net hub.rat.dev dockerpull.com docker.xuanyuan.me; do
  code=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "https://$m/v2/" 2>/dev/null)
  printf "%-26s v2=%s\n" "$m" "${code:-fail}"
done

echo
echo "=== 拉取进度 ==="
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -i napcat || echo "(napcat 镜像尚未落地)"
docker ps -a --filter name=napcat --format '{{.Names}} | {{.Status}}'
