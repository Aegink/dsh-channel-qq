#!/bin/bash
# 通过镜像加速源拉取 NapCat，成功后就地打回官方 tag
set -uo pipefail

for m in docker.m.daocloud.io docker.1ms.run docker.xuanyuan.me; do
  echo "=== 尝试镜像源 $m ==="
  if timeout 900 docker pull "$m/mlikiowa/napcat-docker:v4.15.0"; then
    docker tag "$m/mlikiowa/napcat-docker:v4.15.0" mlikiowa/napcat-docker:v4.15.0
    docker rmi "$m/mlikiowa/napcat-docker:v4.15.0" >/dev/null 2>&1 || true
    echo "=== 拉取成功（$m）==="
    docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -i napcat
    exit 0
  fi
  echo "--- $m 未成功，换下一个 ---"
done

echo "所有镜像源均失败"
exit 1
