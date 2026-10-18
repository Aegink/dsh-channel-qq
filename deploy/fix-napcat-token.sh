#!/bin/bash
# 修复 NapCat token：之前空的 token 文件导致 WebUI 无口令，必须重建容器。
set -euo pipefail

ROOT=/opt/napcat

echo "=== 停止并删除旧容器 ==="
cd "$ROOT"
docker compose down 2>/dev/null || docker rm -f napcat 2>/dev/null || true

echo "=== 清掉空 token 与已初始化的配置 ==="
rm -f /root/.napcat-webui-token /root/.onebot-token
rm -rf "$ROOT/data/config" "$ROOT/data/qq"
mkdir -p "$ROOT/data/qq" "$ROOT/data/config" "$ROOT/data/plugins"

echo "=== 生成新 token ==="
openssl rand -hex 24 > /root/.napcat-webui-token
openssl rand -hex 24 > /root/.onebot-token
chmod 600 /root/.napcat-webui-token /root/.onebot-token
WEBUI_TOKEN=$(cat /root/.napcat-webui-token)
ONEBOT_TOKEN=$(cat /root/.onebot-token)

# 校验确实非空
if [ ${#WEBUI_TOKEN} -ne 48 ] || [ ${#ONEBOT_TOKEN} -ne 48 ]; then
  echo "token 生成异常：webui=${#WEBUI_TOKEN} onebot=${#ONEBOT_TOKEN}"
  exit 1
fi

echo "=== 写 compose ==="
cat > "$ROOT/compose.yaml" <<EOF
services:
  napcat:
    image: mlikiowa/napcat-docker:v4.15.0
    container_name: napcat
    restart: unless-stopped
    environment:
      MODE: ws
      WEBUI_TOKEN: '${WEBUI_TOKEN}'
    ports:
      - "127.0.0.1:6099:6099"
      - "127.0.0.1:3001:3001"
    volumes:
      - ./data/qq:/app/.config/QQ
      - ./data/config:/app/napcat/config
      - ./data/plugins:/app/napcat/plugins
EOF

echo "=== 启动 ==="
docker compose up -d
sleep 25

echo "=== 校验容器里的 token ==="
docker inspect napcat --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'WEBUI_TOKEN|MODE'

echo "=== 端口 ==="
ss -tln | grep -E ':(6099|3001)\b' || echo "(端口未监听)"

echo "=== 日志尾部 ==="
docker logs --tail 15 napcat 2>&1 | tail -15

echo "=== 二维码 URL 行 ==="
docker logs napcat 2>&1 | grep -o 'https://txz.qq.com/p?k=[^ ]*' | tail -1 || echo "(暂无)"

echo "=== 供配置使用 ==="
echo "WEBUI_TOKEN=$WEBUI_TOKEN"
echo "ONEBOT_TOKEN=$ONEBOT_TOKEN"
