#!/usr/bin/env bash
#
# 桌面版截图（依赖无头 Chrome）。
# 交互副本由 tools/gen-preview.js 生成在 /tmp，本脚本只负责拍照。
#
#   用法：bash tools/screenshot-desktop.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/docs/screenshots"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ ! -x "$CHROME" ]; then
  echo "找不到 Chrome（$CHROME）。可用 CHROME=/path/to/chrome 指定，或跳过这一步。"
  exit 1
fi
mkdir -p "$OUT"

shot() { # $1=预览名 $2=窗口宽高
  "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-software-rasterizer \
    --hide-scrollbars --screenshot="$OUT/$3.png" --window-size="$2" \
    --virtual-time-budget=9000 "file:///tmp/$1.html" >/dev/null 2>&1
  printf '  ✓ %s\n' "$3.png"
}

echo "桌面截图 -> docs/screenshots/"
shot preview-paste      1120,960  01-import-empty-desktop
shot preview-step2      1120,1220 02-review-courses-desktop
shot preview-step4      1120,1260 03-export-events-desktop
shot preview-slots      1120,1000 04-schedule-editor
shot preview-template3  1120,1360 05-format-guide