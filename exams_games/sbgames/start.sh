#!/bin/bash
# 启动 / 重启「超级乱斗」联机守护进程（WSL 与 Synology NAS 通用）
#  用法: bash start.sh [端口]
#  环境: SB_NODE=/path/to/node  SB_PORT=9001
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${SB_PORT:-${1:-9001}}"
PIDF="$DIR/data/daemon.pid"

# --- 找 node：环境变量 → 常见路径（Synology 在 /usr/local/bin/node）→ PATH ---
NODE_BIN="${SB_NODE:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN=""
  for c in /usr/local/bin/node /var/packages/Node.js_v20/target/bin/node \
           /var/packages/Node.js_v18/target/bin/node /usr/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then echo "找不到 node，请用 SB_NODE=/path/to/node 指定"; exit 1; fi

mkdir -p "$DIR/data"

# --- 结束旧进程：PID 文件优先，fuser 兜底（Synology 无 pgrep）---
if [ -f "$PIDF" ]; then
  kill "$(cat "$PIDF")" 2>/dev/null && sleep 0.6
fi
if command -v fuser >/dev/null 2>&1; then
  OLD="$(fuser -n tcp "$PORT" 2>/dev/null | tr -d ' \n')"
  [ -n "$OLD" ] && kill "$OLD" 2>/dev/null && sleep 0.4
fi
rm -f "$PIDF" 2>/dev/null

cd "$DIR"
SB_QUIET=1 SB_PORT="$PORT" nohup "$NODE_BIN" daemon.js "$PORT" >> "$DIR/data/daemon.out" 2>&1 &
echo $! > "$PIDF"
echo "started pid=$(cat "$PIDF") node=$NODE_BIN port=$PORT"
sleep 1.5
if curl -s --max-time 4 "http://127.0.0.1:$PORT/health"; then echo; else echo "!! health 未响应"; tail -5 "$DIR/data/daemon.out" 2>/dev/null; fi
