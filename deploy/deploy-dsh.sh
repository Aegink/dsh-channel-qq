#!/bin/bash
# 部署 dsh 本体（与开发环境完全同版本：dsh-v0.2.1-alpha.2）
set -euo pipefail

export PATH=/opt/node22/bin:$PATH
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

DSH_ROOT=/srv/dsh
DSH_DIR=$DSH_ROOT/dsh
REF=dsh-v0.2.1-alpha.2

mkdir -p "$DSH_ROOT"

if [ ! -d "$DSH_DIR/.git" ]; then
  echo "=== 克隆 deepseek-harness @ $REF ==="
  git clone --depth 1 --branch "$REF" https://github.com/deepseek-ai/deepseek-harness.git "$DSH_DIR"
else
  echo "=== 已存在，跳过克隆 ==="
fi

cd "$DSH_DIR"
echo "=== 版本确认 ==="
git log -1 --format='commit=%H date=%ci'
node -e "console.log('pkg version:', require('./package.json').version, '| engines:', JSON.stringify(require('./package.json').engines))"

echo "=== pnpm install ==="
corepack pnpm install

echo "=== pnpm run build ==="
corepack pnpm run build

echo "=== 完成 ==="
du -sh "$DSH_DIR"
df -h / | tail -1
echo "=== BUILD DONE ==="
