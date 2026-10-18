#!/bin/bash
# 非侵入式安装 Node 22 到 /opt/node22（不覆盖系统 /usr/bin/node v18）
set -euo pipefail

V=v22.23.3
echo "=== 下载 Node $V ==="
cd /tmp
curl -fsSL -o node22.tar.xz "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"
ls -lh node22.tar.xz

echo "=== 解压到 /opt/node22 ==="
tar -xJf node22.tar.xz -C /opt
rm -rf /opt/node22
mv "/opt/node-$V-linux-x64" /opt/node22
rm -f node22.tar.xz

echo "=== 版本 ==="
/opt/node22/bin/node -v
/opt/node22/bin/npm -v

echo "=== 系统 node 未改动（应仍为 v18.19.1）==="
/usr/bin/node -v

echo "=== corepack 启用 pnpm/yarn ==="
/opt/node22/bin/corepack enable --install-directory /opt/node22/bin
export PATH=/opt/node22/bin:$PATH
corepack --version
echo "pnpm: $(pnpm --version)"

echo "=== 验证 zstd API（qq_search_history 依赖）==="
/opt/node22/bin/node -e "const z=require('node:zlib');console.log('zstdDecompressSync:',typeof z.zstdDecompressSync)"

echo "=== 完成 ==="
