# @wechatsync/cli

命令行同步文章到多个内容平台。

## 安装

```bash
npm install -g @wechatsync/cli
```

## 快速开始

```bash
# 同步文章到知乎和掘金
wechatsync sync article.md --platforms zhihu,juejin

# Sun 常用发布矩阵：公众号、知乎、小红书、X、今日头条
wechatsync sync article.md --preset sun

# 更稳的 draft-first 工作流：先生成各平台草稿包，不连接扩展、不点发布
wechatsync draft article.md --preset sun

# 用隔离 Chrome profile 跑 DOM 草稿填充（以小红书为例）
wechatsync chrome-cdp start --open https://creator.xiaohongshu.com
wechatsync draft-run drafts/my-article/manifest.json --platform xiaohongshu
```

首次使用会提示安装 Chrome 扩展 - 访问 https://wechatsync.com/#install 安装。

## 命令

### sync - 同步文章

```bash
# 基本用法
wechatsync sync article.md -p zhihu,juejin

# 使用平台预设
wechatsync sync article.md --preset sun
wechatsync sync article.md --preset longform
wechatsync sync article.md --preset social
wechatsync sync article.md --preset tech

# 指定标题
wechatsync sync article.md -t "我的文章" -p zhihu

# 添加封面
wechatsync sync article.md -p juejin --cover https://example.com/cover.jpg

# 预览（不实际同步）
wechatsync sync article.md --dry-run
```

### draft - 生成 draft-first 发布包

`draft` 是更适合高精度发布流水线的入口：它只做内容编译和素材准备，不依赖 Chrome Extension，不读取浏览器登录态，也不会点击最终发布。

```bash
# 生成 Sun 常用矩阵的发布草稿包
wechatsync draft article.md --preset sun

# 指定输出目录
wechatsync draft article.md --preset sun -o ./drafts/my-article

# 给小红书指定图文卡片（逗号分隔）
wechatsync draft article.md --preset sun --xhs-images ./xhs-01.png,./xhs-02.png

# 或给一个图片列表文件，每行一个路径
wechatsync draft article.md --preset sun --xhs-images ./xhs-images.txt
```

输出目录包含：

| 文件 | 用途 |
|------|------|
| `manifest.json` | 后续浏览器适配器消费的结构化发布清单 |
| `platforms/weixin.html` | 公众号富文本 HTML，已尽量内联样式/本地图 |
| `platforms/zhihu.md` | 知乎草稿 Markdown |
| `platforms/toutiao.md` | 今日头条草稿 Markdown |
| `platforms/x/post.txt` | X/Twitter 首条草稿 |
| `platforms/xiaohongshu/title.txt` | 小红书标题，20 字以内 |
| `platforms/xiaohongshu/body.txt` | 小红书正文，1000 字以内 |
| `platforms/xiaohongshu/upload-files.txt` | 小红书待上传图片绝对路径列表 |
| `automation/xhs-dom-upload.playwright.mjs` | 小红书 DOM/file-input 上传脚本；停在最终发布前 |

推荐用 CLI 管理一个隔离的 CDP Chrome profile：

```bash
# 第一次会打开一个独立 Chrome；在这里登录小红书一次，后续复用这个 profile
wechatsync chrome-cdp start --open https://creator.xiaohongshu.com

# 检查 CDP 是否可用
wechatsync chrome-cdp check

# 读取 manifest 并填入小红书草稿；不点击最终发布
wechatsync draft-run drafts/my-article/manifest.json --platform xiaohongshu
```

如果你已经自己启动了带 remote-debugging-port 的 Chrome，也可以显式指定：

```bash
wechatsync draft-run drafts/my-article/manifest.json \
  --platform xiaohongshu \
  --cdp-url http://127.0.0.1:9222
```

这条路径使用 DOM selector 和 `input[type=file]`，不是屏幕坐标点击。默认 `publishPolicy` 是 `manual-final-click`，即只填草稿，不做最终发布。

### chrome-cdp - 启动或检查 CDP Chrome

```bash
# 检查默认 http://127.0.0.1:9222 是否可用
wechatsync chrome-cdp check

# 启动隔离 profile，避免污染你日常 Chrome
wechatsync chrome-cdp start --open https://creator.xiaohongshu.com

# 指定端口、profile 或 Chrome 路径
wechatsync chrome-cdp start \
  --port 9333 \
  --user-data-dir ~/.wechatsync-chrome \
  --chrome-path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# CI/smoke 可用无头模式
wechatsync chrome-cdp start --headless --port 9333 --user-data-dir /tmp/wechatsync-chrome-smoke
```

### draft-run - 自动填平台草稿

```bash
# 小红书：上传 manifest 中的图片，填标题和正文，停在最终发布前
wechatsync draft-run drafts/my-article/manifest.json --platform xiaohongshu

# 如果 CDP 不可用，自动启动隔离 Chrome
wechatsync draft-run drafts/my-article/manifest.json --platform xiaohongshu --start-chrome

# 只检查 manifest、CDP、适配器脚本，不填网页
wechatsync draft-run drafts/my-article/manifest.json --platform xiaohongshu --dry-run
```

### presets - 查看平台预设

```bash
wechatsync presets
```

内置预设：

| 预设 | 平台 |
|------|------|
| `sun` | `weixin`, `zhihu`, `xiaohongshu`, `x`, `toutiao` |
| `longform` | `weixin`, `zhihu`, `toutiao` |
| `social` | `xiaohongshu`, `x`, `weibo` |
| `tech` | `weixin`, `zhihu`, `juejin`, `csdn` |

### platforms - 查看平台

```bash
# 列出所有平台
wechatsync platforms

# 显示登录状态
wechatsync platforms --auth
wechatsync ls -a
```

### auth - 检查登录

```bash
# 检查所有平台
wechatsync auth

# 检查单个平台
wechatsync auth zhihu

# 强制刷新
wechatsync auth --refresh
```

### extract - 提取文章

```bash
# 从浏览器当前页面提取
wechatsync extract

# 保存到文件
wechatsync extract -o article.md
```

## 工作原理

```
┌──────────────┐     WebSocket     ┌───────────────────┐
│  wechatsync  │◄─────────────────►│  Chrome Extension │
│    (CLI)     │    port 9527      │   (同步助手)       │
└──────────────┘                   └───────────────────┘
                                            │
                                            ▼
                                   ┌───────────────────┐
                                   │  目标平台 API      │
                                   │  (知乎/掘金/...)   │
                                   └───────────────────┘
```

CLI 启动后监听 WebSocket 端口，等待 Chrome 扩展连接。
扩展连接后，CLI 通过 WebSocket 发送请求，扩展执行实际的平台 API 调用。

## 支持的平台

知乎、掘金、简书、头条、微博、B站、百家号、CSDN、语雀、豆瓣、搜狐、雪球、微信公众号、小红书、X、人人都是产品经理、大鱼号、一点资讯、51CTO、搜狐焦点、慕课网、开源中国、思否、博客园。

> 注意：部分平台适配器随 Chrome 扩展 Release 或私有适配器包分发；从公开源码仓库 shallow clone 时可能只看到公开平台代码。实际可用平台以 `wechatsync platforms --auth` 返回为准。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SYNC_WS_PORT` | WebSocket 端口 | 9527 |
| `WECHATSYNC_TOKEN` | 安全验证 token | - |
| `CHROME_CDP_URL` | draft-run 使用的 Chrome CDP 地址 | `http://127.0.0.1:9222` |
| `CHROME_PATH` | Chrome 可执行文件路径 | 自动探测 |

## 远程桥接

CLI 支持在服务器上运行，连接本地电脑上的 Chrome 扩展。适用于在远程开发机或 CI 环境中同步文章，同时利用本地浏览器的登录态。

### 架构

```
┌─────────────────┐                        ┌─────────────────────┐
│  远程服务器       │     WebSocket          │  本地电脑            │
│                 │     port 9527           │                     │
│  wechatsync CLI │◄───────────────────────►│  Chrome Extension   │
│  / MCP Server   │                         │  (浏览器登录态)      │
└─────────────────┘                         └─────────────────────┘
```

### 配置步骤

**1. 服务器端** - 正常启动 CLI 或 MCP Server：

```bash
# CLI
WECHATSYNC_TOKEN=your-token wechatsync sync article.md -p zhihu

# MCP Server
MCP_TOKEN=your-token node packages/mcp-server/dist/index.js
```

服务器默认监听 `0.0.0.0:9527`（所有网络接口），远程可直接连接。

**2. 本地浏览器** - 在 Chrome 扩展设置中：

1. 开启「同步桥接」开关
2. 在「服务器地址」输入框填入远程地址，例如 `ws://192.168.1.100:9527`
3. 确保 Token 与服务器端一致

扩展会自动连接远程服务器，连接成功后即可远程同步。

### 注意事项

- 确保服务器防火墙放行 9527 端口（可通过 `SYNC_WS_PORT` 自定义）
- Token 在传输中以明文发送，生产环境建议配合 SSH 隧道或 VPN 使用
- 每个 Token 只允许一个扩展连接

## Claude Code 集成

安装 Skill 插件：

```bash
/plugin marketplace add wechatsync/Wechatsync
/plugin install wechatsync
```

然后在 Claude Code 中可以直接说：
- "把这篇文章同步到掘金"
- "帮我看看哪些平台已登录"
- "从浏览器提取当前文章"

## License

MIT
