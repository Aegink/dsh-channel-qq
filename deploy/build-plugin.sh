#!/bin/bash
# 在服务器上构建 dsh-channel-qq。
# 目录布局必须与 package.json 的 link: devDeps 一致：
#   /srv/dsh/dsh-channel-qq  →  ..\dsh\vendor\cordis = /srv/dsh/dsh/vendor/cordis
#
# 源码通过 base64 文本通道传输（/root/payload.b64），避免 SFTP 大文件超时。
set -euo pipefail

export PATH=/opt/node22/bin:$PATH
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

DIR=/srv/dsh/dsh-channel-qq
mkdir -p "$DIR"
cd "$DIR"

echo "=== 解码并校验 ==="
tr -d '\r' < /root/payload.b64 | base64 -d > /root/dsh-channel-qq.tar.gz
tar -tzf /root/dsh-channel-qq.tar.gz > /dev/null && echo "tar 完整: $(stat -c%s /root/dsh-channel-qq.tar.gz) bytes"

echo "=== 解包 ==="
rm -rf src lib
tar -xzf /root/dsh-channel-qq.tar.gz

echo "=== 校验 link: 目标存在 ==="
test -f /srv/dsh/dsh/vendor/cordis/package.json && echo "cordis OK" || { echo "缺少 /srv/dsh/dsh/vendor/cordis"; exit 1; }
test -f /srv/dsh/dsh/packages/llm/llm/package.json && echo "dsh-llm OK" || { echo "缺少 /srv/dsh/dsh/packages/llm/llm"; exit 1; }

echo "=== pnpm install ==="
corepack pnpm install

echo "=== tsc 构建 ==="
corepack pnpm run build

echo "=== 产物 ==="
ls lib | head -8
echo "=== BUILD OK ==="
