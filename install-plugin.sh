#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DST="$HOME/.gemini/config/plugins/context-token-monitor"

echo "1/3 安装依赖并构建 MCP App 前端..."
cd "$DIR"
npm install --no-audit --no-fund
npm run build

echo "2/3 安装到 Antigravity 官方插件目录：$DST"
rm -rf "$DST"
mkdir -p "$DST/bin" "$DST/dist"
cp "$DIR/plugin.json" "$DIR/mcp_config.json" "$DIR/server.mjs" "$DIR/package.json" "$DST/"
cp "$DIR/bin/start.sh" "$DST/bin/start.sh"
chmod +x "$DST/bin/start.sh"
cp "$DIR/dist/dashboard.html" "$DST/dist/dashboard.html"
cp -R "$DIR/node_modules" "$DST/node_modules"

echo "3/3 完成！在 Antigravity 侧边栏 '+' 菜单或左侧导航栏打开「Token 监控看板」即可使用。"
echo "如需同时编译 macOS 顶部悬浮外挂条，请运行：./build-hud.sh --run"
