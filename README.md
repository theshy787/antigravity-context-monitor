# Antigravity Context & Token Monitor

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Antigravity-blue.svg)](#快速安装)
[![Protocol](https://img.shields.io/badge/MCP%20Apps-SEP--1865-green.svg)](#架构设计)
[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)

**Antigravity Context & Token Monitor** 是一套 **100% 遵循 Antigravity 官方插件规范** 的实时上下文与 Token 用量监控方案，包含两部分：

1. **官方 MCP App 插件（`context-token-monitor`）**：原生挂载在 Antigravity 侧边栏 `+` 菜单与左侧全局导航栏，自动跟随客户端浅色/深色主题。
2. **macOS 原生顶部悬浮外挂条（`TokenHUD.app`）**：原生 Swift 编写的高对比度深色胶囊，停靠在屏幕顶部，**自动跟随 Antigravity 窗口显隐/最小化**，一眼查看剩余 Token。

> **安全边界**：与需要修改 `app.asar` 或通过 CDP 注入宿主进程的第三方补丁不同，本项目**完全不篡改 Antigravity 客户端文件、不注入运行中进程、不破坏 macOS 应用签名**，仅以**只读方式**解析本地 `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl` 日志。

---

## 核心功能

- **实时上下文占用 & 剩余 Token**：精确汇总每轮 `input_tokens + cache_read_tokens`，按模型自动匹配上下文上限（Gemini 系列 1M、Claude/GPT 系列 200K，支持手动覆盖），超过 65% / 85% 自动变色预警。
- **Google AI Pro / Ultra 双层滚动窗口追踪**：按每轮精确时间戳实时统计 **近 5 小时滚动消耗/剩余** 与 **近 7 天周滚动消耗/剩余**，内置 `Google AI Pro` / `Google AI Ultra` 一键预设并支持自由微调。
- **Prompt 缓存命中率 & 生成速度（TPS）**：展示当前会话缓存命中率、估算输出速度（`tok/s`）与思考内容占比。
- **可视化图表与会话明细**：
  - 当前会话每轮上下文与缓存增长柱状图
  - 近 28 天 5 档色阶 Token 活跃热力图
  - 按模型分布表与历史会话一键切换
- **macOS 顶部悬浮外挂条（`TokenHUD.app`）**：
  - 高对比度 `.darkAqua` 毛玻璃胶囊，每 3 秒自动刷新
  - 默认跟随 Antigravity 前后台与最小化状态自动显隐，支持右上角 `✕` 一键隐藏、菜单栏快捷控制
  - 与 MCP 看板共享同一份预算配置，支持安全同步本机 `gcloud` 账号标签（不读取浏览器 Cookie 或私有 OAuth 凭证）

---

## 数据准确性说明

- **完全准确（来自官方日志原始字段）**：当前上下文已用 Token、Prompt 缓存命中率、每轮与累计输入/缓存/输出 Token、近 5 小时 / 近 7 天真实累计消耗。
- **参考/估算值**：Google AI Pro 官方采用动态 5 小时 + 每周额度且未公开固定 Token 常数，因此「5h / 7d 剩余额度」与「参考 API 费用」属于基于本地预算与单价的参考值；**官方服务端精确余量请以 Antigravity 内置 `/quota` 为准**。

---

## 快速安装

### 环境要求
- Node.js 18+（推荐 Node.js 22+）
- macOS 13.0+ 与 Xcode Command Line Tools（仅编译 `TokenHUD.app` 需要）

### 1. 安装 Antigravity 官方 MCP App 插件

```bash
git clone https://github.com/theshy787/antigravity-context-monitor.git
cd antigravity-context-monitor
chmod +x install-plugin.sh
./install-plugin.sh
```

安装完成后无需重启客户端，在 Antigravity 右侧辅助栏 **`+`** 菜单或左侧边栏选择 **「Token 监控看板」** 即可打开。

### 2. 编译并启动 macOS 顶部悬浮外挂条（可选）

```bash
chmod +x build-hud.sh
./build-hud.sh --run
```

---

## 目录结构

```text
antigravity-context-monitor/
├── plugin.json             # Antigravity 插件清单
├── mcp_config.json         # MCP 服务端配置
├── server.mjs              # MCP 服务端 + 本地 transcript.jsonl 实时解析引擎
├── bin/start.sh            # Node 启动包装脚本
├── src/ui.ts               # MCP App 交互式看板前端源码
├── scripts/build-ui.mjs    # esbuild 单文件 HTML 构建脚本
├── hud/TokenHUD.swift      # macOS 原生顶部悬浮外挂条源码
├── install-plugin.sh       # 一键安装 MCP 插件脚本
├── build-hud.sh            # 一键编译 TokenHUD.app 脚本
├── LICENSE                 # MIT 开源许可证
└── README.md
```

---

## 法律风险与免责说明（Legal Disclaimer）

在使用、修改或分发本软件前，请仔细阅读以下条款：

1. **按「现状」提供，无任何担保（AS-IS）**
   本软件依据 [MIT License](LICENSE) 开源，按「现状（AS IS）」提供。作者及贡献者不对本软件的适销性、特定用途适用性、数据完全一致性或持续可用性作出任何明示或暗示的担保。因使用或无法使用本软件导致的任何直接、间接、附带或后果性损失，作者不承担法律责任。
2. **与官方无隶属关系**
   本项目为社区独立开源工具，与 Google、Google DeepMind 或 Antigravity 官方无任何官方隶属、背书或授权关系。所有商标均归其各自所有者所有。
3. **额度与费用统计免责**
   本软件展示的「Google AI Pro / Ultra 剩余额度」及「参考 API 费用」均基于本机日志与用户自定义参数估算，**不代表官方实际计费、订阅扣费或服务端真实剩余配额**。任何费用结算与额度限制均以官方服务商后台及客户端 `/quota` 显示为准。
4. **本地隐私与只读原则**
   本软件仅在本地只读解析 `~/.gemini/antigravity/brain/` 下的对话日志与统计字段，不包含任何联网上报、遥测或数据收集逻辑，也不读取或解密浏览器 Cookie、系统钥匙串或私有认证令牌。用户在截图、录屏或分享看板时，请自行注意隐藏可能包含敏感信息的会话标题或邮箱标签。

---

## License

本项目采用 [MIT License](LICENSE) 开源许可协议。
