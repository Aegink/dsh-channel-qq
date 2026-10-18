#!/bin/bash
# dsh CLI 包装：固定 Node 22 与仓库根目录，供交互使用和 systemd 调用。
cd /srv/dsh/dsh || exit 1
export PATH=/opt/node22/bin:$PATH
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
exec corepack pnpm dsh "$@"
