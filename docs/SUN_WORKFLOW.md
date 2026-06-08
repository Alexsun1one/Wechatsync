# Sun 多平台文章发布工作流

目标：不再把同一篇文章手工复制到公众号、知乎、小红书、X、今日头条。底座使用 Wechatsync 的 Chrome Extension + CLI/MCP，利用浏览器已登录状态把文章保存到各平台草稿。

## 最短路径

1. 安装 Chrome 扩展并登录各平台账号。
2. 在扩展设置里开启 MCP/同步桥接，设置 `WECHATSYNC_TOKEN`。
3. 构建本仓库或安装 CLI。
4. 用 Sun 预设同步：

```bash
WECHATSYNC_TOKEN=<token> wechatsync sync article.md --preset sun
```

`sun` 等价于：

```text
weixin, zhihu, xiaohongshu, x, toutiao
```

## 为什么用这个而不是重新写一个

- 它已经是浏览器扩展架构，能复用真实浏览器登录态。
- 它默认草稿优先，适合发文前最后人工确认。
- 它已有 CLI、MCP、Chrome Extension 三层，不需要从零搭桥。
- 它已经覆盖 Sun 常用平台名：公众号、知乎、小红书、X、今日头条。

## 平台策略

| 平台 | 平台 ID | 推荐模式 |
|------|---------|----------|
| 微信公众号 | `weixin` | 草稿优先，发布前人工确认封面/摘要/原创/转载声明 |
| 知乎 | `zhihu` | 草稿优先，人工确认话题和首图 |
| 小红书 | `xiaohongshu` | 草稿优先，人工确认图片比例、话题和敏感词 |
| X/Twitter | `x` | 可直接发 thread，但仍建议先预览 |
| 今日头条 | `toutiao` | 草稿优先，人工确认分类、封面、声明 |

## Codex/Agent 用法

当文章已经在本地 Markdown 文件里：

```bash
wechatsync sync /absolute/path/to/article.md --preset sun --dry-run
wechatsync sync /absolute/path/to/article.md --preset sun
```

当文章已经在公众号后台或浏览器当前页面：

```bash
wechatsync extract -o article.md
wechatsync sync article.md --preset sun
```

## 当前改动

- CLI 新增 `--preset <name>`。
- CLI 新增 `wechatsync presets`。
- 内置 `sun / longform / social / tech` 四个发布预设。

## 现实边界

公开仓库里的 `packages/core/src/adapters/platforms/private` 是私有 submodule，本机无权限拉取。因此从源码构建时，部分 README 里列出的平台适配器可能不在公开代码中；但发布版 Chrome 扩展/CLI 文档仍宣称支持这些平台。真正使用前以扩展里 `wechatsync platforms --auth` 的登录状态为准。
