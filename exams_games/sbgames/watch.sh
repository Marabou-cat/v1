#!/bin/bash
# 看门狗：每分钟检查一次，挂了就拉起来（由 crontab 调用）
#   */1 * * * * /volume1/.../sbgames/watch.sh >> /volume1/.../sbgames/data/watch.log 2>&1
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${SB_PORT:-9001}"
if ! curl -s --max-time 4 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "[watch] $(date '+%F %T') 守护进程无响应，重启"
  bash "$DIR/start.sh" "$PORT"
else
  # 顺手清理 2 天前的日志（避免占满空间）
  find "$DIR/data" -name '*.log' -mtime +2 -delete 2>/dev/null
  find "$DIR/data" -name 'daemon.out' -size +5M -exec truncate -s 0 {} \; 2>/dev/null
fi
