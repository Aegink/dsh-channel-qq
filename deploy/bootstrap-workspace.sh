#!/bin/bash
# 新建工作区骨架
set -euo pipefail

WS=/path/to/workspace
mkdir -p "$WS"/{memory/dreams,knowledge,downloads,inbox,quotes}

# 从上传的模板放置初始文件（只在缺失时写入，不覆盖已有内容）
install -m 644 -n /root/ws-AGENTS.md "$WS/AGENTS.md" 2>/dev/null || \
  { [ -f "$WS/AGENTS.md" ] || cp /root/ws-AGENTS.md "$WS/AGENTS.md"; }
install -m 644 -n /root/ws-MEMORY.md "$WS/MEMORY.md" 2>/dev/null || \
  { [ -f "$WS/MEMORY.md" ] || cp /root/ws-MEMORY.md "$WS/MEMORY.md"; }

echo "=== 工作区结构 ==="
find "$WS" -maxdepth 2 | sort
echo "=== 大小 ==="
du -sh "$WS"
