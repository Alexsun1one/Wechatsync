/**
 * WechatSync CLI
 *
 * 命令行同步文章到多个内容平台
 *
 * 使用方式:
 *   wechatsync sync article.md --platforms zhihu,juejin
 *   wechatsync platforms
 *   wechatsync auth
 */
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import open from 'open'
import fs from 'fs'
import path from 'path'
import juice from 'juice'
import { ExtensionBridge } from '@wechatsync/mcp-server/bridge'
import type { PlatformInfo, SyncResult } from '@wechatsync/mcp-server/bridge'

const WS_PORT = parseInt(process.env.SYNC_WS_PORT || '9527', 10)

// 官网和安装地址
const WEBSITE_URL = 'https://www.wechatsync.com'
const EXTENSION_URL = 'https://www.wechatsync.com/#install'
const GITHUB_URL = 'https://github.com/wechatsync/Wechatsync'

const program = new Command()

const PLATFORM_PRESETS: Record<string, string[]> = {
  sun: ['weixin', 'zhihu', 'xiaohongshu', 'x', 'toutiao'],
  longform: ['weixin', 'zhihu', 'toutiao'],
  social: ['xiaohongshu', 'x', 'weibo'],
  tech: ['weixin', 'zhihu', 'juejin', 'csdn'],
}

function formatPresetList(): string {
  return Object.entries(PLATFORM_PRESETS)
    .map(([name, platforms]) => `${name}=${platforms.join(',')}`)
    .join(' | ')
}

function resolvePlatforms(options: { platforms?: string; preset?: string }): string[] {
  if (options.preset) {
    const preset = PLATFORM_PRESETS[options.preset]
    if (!preset) {
      console.error(chalk.red(`未知平台预设: ${options.preset}`))
      console.log(chalk.gray(`可用预设: ${formatPresetList()}`))
      process.exit(1)
    }
    return preset
  }

  return (options.platforms || 'zhihu,juejin')
    .split(',')
    .map((p: string) => p.trim().toLowerCase())
    .filter(Boolean)
}

// 默认超时时间
let connectionTimeout = 30000

program
  .name('wechatsync')
  .description('同步文章到多个内容平台 (知乎、掘金、CSDN 等)')
  .version('1.1.0')
  .option('--timeout <ms>', '等待 Extension 连接超时（毫秒）', '30000')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts()
    if (opts.timeout) {
      connectionTimeout = parseInt(opts.timeout)
    }
  })

/**
 * 显示 Extension 安装引导
 */
function showInstallGuide(): void {
  console.log()
  console.log(chalk.bgYellow.black(' 需要安装 Chrome 扩展 '))
  console.log()
  console.log('WechatSync CLI 需要配合 Chrome 扩展使用。')
  console.log('扩展负责处理各平台的登录状态和 API 调用。')
  console.log()
  console.log(chalk.bold('安装步骤:'))
  console.log()
  console.log(`  1. 访问官网安装扩展:`)
  console.log(`     ${chalk.cyan(EXTENSION_URL)}`)
  console.log()
  console.log(`  2. 在扩展设置中启用 ${chalk.cyan('MCP 连接')}，获取 Token`)
  console.log()
  console.log(`  3. 配置环境变量:`)
  console.log(`     ${chalk.cyan('export WECHATSYNC_TOKEN="你的token"')}`)
  console.log()
  console.log(`  4. 在各平台 (知乎、掘金等) 登录你的账号`)
  console.log()
  console.log(`  5. 重新运行此命令`)
  console.log()
  console.log(chalk.gray(`官网: ${WEBSITE_URL}`))
  console.log(chalk.gray(`GitHub: ${GITHUB_URL}`))
  console.log()
}

/**
 * 询问是否打开安装页面
 */
async function promptOpenInstallPage(): Promise<void> {
  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(chalk.yellow('是否打开扩展安装页面? (y/N) '), async (answer) => {
      rl.close()
      if (answer.toLowerCase() === 'y') {
        console.log(chalk.gray('正在打开浏览器...'))
        await open(EXTENSION_URL)
      }
      resolve()
    })
  })
}

// ============ 图片处理 ============

interface LocalImage {
  originalRef: string  // 原始引用，如 ![alt](./img.png) 或 <img src="./img.png">
  localPath: string    // 本地路径
  absolutePath: string // 绝对路径
}

/**
 * MIME 类型映射
 */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
}

/**
 * 查找内容中的本地图片引用
 */
function findLocalImages(content: string, basePath: string): LocalImage[] {
  const images: LocalImage[] = []
  const seen = new Set<string>()

  // Markdown 图片: ![alt](path)
  const mdImageRegex = /!\[[^\]]*\]\(([^)]+)\)/g
  let match
  while ((match = mdImageRegex.exec(content)) !== null) {
    const imgPath = match[1].trim()
    // 跳过网络图片和 data URI
    if (imgPath.startsWith('http://') || imgPath.startsWith('https://') || imgPath.startsWith('data:')) {
      continue
    }
    if (!seen.has(imgPath)) {
      seen.add(imgPath)
      images.push({
        originalRef: match[0],
        localPath: imgPath,
        absolutePath: path.resolve(basePath, imgPath),
      })
    }
  }

  // HTML 图片: <img src="path">
  const htmlImageRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  while ((match = htmlImageRegex.exec(content)) !== null) {
    const imgPath = match[1].trim()
    if (imgPath.startsWith('http://') || imgPath.startsWith('https://') || imgPath.startsWith('data:')) {
      continue
    }
    if (!seen.has(imgPath)) {
      seen.add(imgPath)
      images.push({
        originalRef: match[0],
        localPath: imgPath,
        absolutePath: path.resolve(basePath, imgPath),
      })
    }
  }

  return images
}

/**
 * 读取本地图片为 base64
 */
function readImageAsBase64(imagePath: string): { data: string; mimeType: string } | null {
  if (!fs.existsSync(imagePath)) {
    return null
  }

  const ext = path.extname(imagePath).toLowerCase()
  const mimeType = MIME_TYPES[ext]
  if (!mimeType) {
    return null
  }

  const buffer = fs.readFileSync(imagePath)
  return {
    data: buffer.toString('base64'),
    mimeType,
  }
}

/**
 * 将本地图片转换为 data URI（推荐方式）
 * 让各平台适配器自己处理图片上传，确保图片存储在目标平台的图床
 */
function convertImagesToDataUri(
  content: string,
  basePath: string
): { content: string; convertedCount: number; failedCount: number } {
  const images = findLocalImages(content, basePath)

  if (images.length === 0) {
    return { content, convertedCount: 0, failedCount: 0 }
  }

  let processedContent = content
  let convertedCount = 0
  let failedCount = 0

  for (const img of images) {
    const imageData = readImageAsBase64(img.absolutePath)
    if (!imageData) {
      console.log(chalk.yellow(`  ⚠ 跳过: ${img.localPath} (文件不存在或格式不支持)`))
      failedCount++
      continue
    }

    // 构建 data URI
    const dataUri = `data:${imageData.mimeType};base64,${imageData.data}`

    // 替换内容中的引用
    if (img.originalRef.startsWith('![')) {
      // Markdown 格式
      const newRef = img.originalRef.replace(img.localPath, dataUri)
      processedContent = processedContent.replace(img.originalRef, newRef)
    } else {
      // HTML 格式
      const newRef = img.originalRef.replace(img.localPath, dataUri)
      processedContent = processedContent.replace(img.originalRef, newRef)
    }

    console.log(chalk.green(`  ✓ 转换: ${img.localPath}`))
    convertedCount++
  }

  return { content: processedContent, convertedCount, failedCount }
}

/**
 * 上传图片到指定图床并替换内容中的引用（备用方式）
 */
async function processLocalImages(
  content: string,
  basePath: string,
  bridge: ExtensionBridge,
  platform: string = 'weibo'
): Promise<{ content: string; uploadedCount: number; failedCount: number }> {
  const images = findLocalImages(content, basePath)

  if (images.length === 0) {
    return { content, uploadedCount: 0, failedCount: 0 }
  }

  let processedContent = content
  let uploadedCount = 0
  let failedCount = 0

  for (const img of images) {
    const imageData = readImageAsBase64(img.absolutePath)
    if (!imageData) {
      console.log(chalk.yellow(`  ⚠ 跳过: ${img.localPath} (文件不存在或格式不支持)`))
      failedCount++
      continue
    }

    try {
      // 使用分片上传（大图片自动分片）
      const result = await bridge.uploadImageChunked(imageData.data, imageData.mimeType, platform)

      // 替换内容中的引用
      if (img.originalRef.startsWith('![')) {
        // Markdown 格式
        const newRef = img.originalRef.replace(img.localPath, result.url)
        processedContent = processedContent.replace(img.originalRef, newRef)
      } else {
        // HTML 格式
        const newRef = img.originalRef.replace(img.localPath, result.url)
        processedContent = processedContent.replace(img.originalRef, newRef)
      }

      console.log(chalk.green(`  ✓ 上传: ${img.localPath}`))
      uploadedCount++
    } catch (error) {
      console.log(chalk.red(`  ✗ 失败: ${img.localPath} - ${(error as Error).message}`))
      failedCount++
    }
  }

  return { content: processedContent, uploadedCount, failedCount }
}

// ============ Markdown/HTML 处理 ============

interface ParsedContent {
  title: string | null
  content: string
  format: 'markdown' | 'html'
  /** 从 HTML meta 提取的封面图 */
  cover?: string
  /** 从 HTML meta 提取的摘要 */
  summary?: string
}

/**
 * 解析文件内容，提取标题和正文
 */
function parseFileContent(filePath: string): ParsedContent {
  const content = fs.readFileSync(filePath, 'utf-8')
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.md' || ext === '.markdown') {
    return parseMarkdown(content)
  } else if (ext === '.html' || ext === '.htm') {
    return parseHtml(content, filePath)
  } else {
    // 当作纯文本处理
    return {
      title: path.basename(filePath, ext),
      content: content,
      format: 'markdown',
    }
  }
}

/**
 * 解析 Markdown 文件
 */
function parseMarkdown(content: string): ParsedContent {
  let title: string | null = null
  let body = content

  // 1. 尝试从 YAML front matter 提取
  const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (yamlMatch) {
    const frontMatter = yamlMatch[1]
    const titleMatch = frontMatter.match(/^title:\s*["']?(.+?)["']?\s*$/m)
    if (titleMatch) {
      title = titleMatch[1].trim()
    }
    // 移除 front matter
    body = content.slice(yamlMatch[0].length)
  }

  // 2. 尝试从 # 标题提取
  if (!title) {
    const h1Match = body.match(/^#\s+(.+)$/m)
    if (h1Match) {
      title = h1Match[1].trim()
      // 移除标题行（只移除第一个匹配的）
      body = body.replace(/^#\s+.+\n+/, '')
    }
  }

  // 3. 清理内容
  body = body.trim()

  // 4. 如果内容为空，返回原始内容
  if (!body) {
    body = content
  }

  return {
    title,
    content: body,
    format: 'markdown',
  }
}

/**
 * 解析 HTML 文件
 * 1. 提取标题（title > h1）、meta 信息（封面、摘要）
 * 2. 解析本地 <link rel="stylesheet"> 引用
 * 3. 将 <style> CSS 内联到元素的 style 属性上（juice）
 */
function parseHtml(content: string, filePath?: string): ParsedContent {
  let title: string | null = null

  // 从 <title> 标签提取
  const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleMatch) {
    title = titleMatch[1].trim()
  }

  // 从 <h1> 标签提取
  if (!title) {
    const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    if (h1Match) {
      title = h1Match[1].trim()
    }
  }

  // 从 <meta> 标签提取封面和摘要
  let cover: string | undefined
  let summary: string | undefined
  const ogImageMatch = content.match(/<meta\s[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || content.match(/<meta\s[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i)
  if (ogImageMatch) {
    cover = ogImageMatch[1]
  }
  const descMatch = content.match(/<meta\s[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || content.match(/<meta\s[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)
    || content.match(/<meta\s[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
  if (descMatch) {
    summary = (descMatch[1] || descMatch[2] || '').trim() || undefined
  }

  // 解析本地 <link rel="stylesheet"> 引用，读取并内联
  const fileDir = filePath ? path.dirname(filePath) : undefined
  if (fileDir) {
    content = content.replace(
      /<link\s[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi,
      (_match, href: string) => {
        // 只处理本地文件，跳过 http(s) 链接
        if (href.startsWith('http://') || href.startsWith('https://')) return _match
        const cssPath = path.resolve(fileDir, href)
        if (fs.existsSync(cssPath)) {
          const css = fs.readFileSync(cssPath, 'utf-8')
          return `<style>${css}</style>`
        }
        return _match
      }
    )
  }

  // 提取 <style> 标签（可能在 <head> 中），合并到 body
  const styles: string[] = []
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let styleMatch
  while ((styleMatch = styleRegex.exec(content)) !== null) {
    styles.push(styleMatch[0])
  }

  // 提取 body 内容
  let body = content
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) {
    body = bodyMatch[1].trim()
  }

  // 将 <head> 中的 <style> 合并到 body
  const bodyStyles = new Set<string>()
  const bodyStyleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let bs
  while ((bs = bodyStyleRegex.exec(body)) !== null) {
    bodyStyles.add(bs[0])
  }
  const extraStyles = styles.filter(s => !bodyStyles.has(s))
  if (extraStyles.length > 0) {
    body = extraStyles.join('\n') + '\n' + body
  }

  // 用 juice 将 <style> CSS 内联到元素的 style 属性
  // 这样即使平台删除 <style> 标签，样式也能保留
  try {
    body = juice(body, {
      removeStyleTags: true,
      preserveImportant: true,
      preserveMediaQueries: false,
      preserveFontFaces: false,
    })
  } catch (e) {
    // juice 失败不阻塞，保留原始 HTML
  }

  return {
    title,
    content: body,
    format: 'html',
    cover,
    summary,
  }
}

/**
 * 简单的 Markdown 转 HTML（用于需要 HTML 的平台）
 */
function markdownToHtml(markdown: string): string {
  let html = markdown

  // 代码块
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')

  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // 图片
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />')

  // 链接
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // 标题
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')

  // 粗体和斜体
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // 无序列表
  html = html.replace(/^\s*[-*+]\s+(.+)$/gm, '<li>$1</li>')
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')

  // 有序列表
  html = html.replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>')

  // 引用
  html = html.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>')

  // 水平线
  html = html.replace(/^---+$/gm, '<hr />')

  // 段落（连续的非空行）
  html = html.replace(/^(?!<[a-z])((?:[^\n]+\n?)+)/gm, (match) => {
    const trimmed = match.trim()
    if (trimmed && !trimmed.startsWith('<')) {
      return `<p>${trimmed}</p>\n`
    }
    return match
  })

  return html
}

// ============ Sun draft-first 发布包 ============

type PublishPolicy = 'manual-final-click' | 'authorized-direct-publish'

interface DraftFile {
  kind: 'source' | 'platform' | 'automation' | 'metadata'
  platform?: string
  path: string
  note?: string
}

interface DraftManifest {
  version: 1
  generatedAt: string
  source: string
  title: string
  platforms: string[]
  publishPolicy: PublishPolicy
  files: DraftFile[]
  xhs?: {
    title: string
    bodyChars: number
    imageCount: number
    images: string[]
    automation: string
  }
}

function slugify(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'article'
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function writeTextFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, 'utf-8')
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function makeXhsTitle(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim()
  return Array.from(normalized).slice(0, 20).join('')
}

function makeXhsBody(title: string, markdown: string, maxChars = 950): string {
  const plain = stripMarkdown(markdown)
  const tags = '#AI设计 #UI设计 #UX设计 #产品设计 #AI工具 #Cursor #Codex #设计系统 #前端开发'
  const intro = plain || title
  const budget = Math.max(80, maxChars - Array.from(tags).length - 2)
  const clipped = Array.from(intro).slice(0, budget).join('')
  return `${clipped}${Array.from(intro).length > budget ? '...' : ''}\n\n${tags}`
}

function resolveMaybeListFile(value: string | undefined, cwd: string): string[] {
  if (!value) return []
  const candidate = path.resolve(cwd, value)
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return fs.readFileSync(candidate, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((item) => path.resolve(path.dirname(candidate), item))
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(cwd, item))
}

function collectLocalImagePaths(content: string, basePath: string): string[] {
  return findLocalImages(content, basePath)
    .map((img) => img.absolutePath)
    .filter((imgPath) => fs.existsSync(imgPath))
}

function writeJsonFile(filePath: string, data: unknown): void {
  writeTextFile(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

function createXhsPlaywrightScript(): string {
  return `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const manifestPath = process.argv[2] || path.resolve('manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
if (!manifest.xhs) throw new Error('manifest.xhs is missing')

const cdpUrl = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222'
const browser = await chromium.connectOverCDP(cdpUrl)
const context = browser.contexts()[0] || await browser.newContext()
let page = context.pages().find((p) => p.url().includes('creator.xiaohongshu.com'))
if (!page) page = await context.newPage()

await page.goto('https://creator.xiaohongshu.com/publish/publish?from=tab_switch&target=image', {
  waitUntil: 'domcontentloaded',
})

const imageInput = page.locator('input[type="file"]').first()
await imageInput.setInputFiles(manifest.xhs.images)

await page.getByPlaceholder('填写标题会有更多赞哦').fill(manifest.xhs.title)

const body = fs.readFileSync(path.join(path.dirname(manifestPath), 'platforms/xiaohongshu/body.txt'), 'utf-8')
const bodyTargets = page.locator('textarea, [contenteditable="true"]')
const bodyCount = await bodyTargets.count()
if (bodyCount === 0) throw new Error('Could not find Xiaohongshu body editor')
await bodyTargets.nth(bodyCount - 1).fill(body)

console.log('Xiaohongshu draft is filled. Final publish was not clicked.')
await browser.close()
`
}

function relativeFrom(baseDir: string, filePath: string): string {
  return path.relative(baseDir, filePath) || path.basename(filePath)
}

function createDraftPackage(filePath: string, options: {
  title?: string
  platforms?: string
  preset?: string
  out?: string
  xhsImages?: string
  publishPolicy?: PublishPolicy
}): DraftManifest {
  const parsed = parseFileContent(filePath)
  const title = options.title || parsed.title
  if (!title) {
    throw new Error('无法从文件提取标题，请使用 --title 指定')
  }

  const platforms = resolvePlatforms({
    platforms: options.platforms || 'weixin,zhihu,xiaohongshu,x,toutiao',
    preset: options.preset,
  })
  const sourceDir = path.dirname(filePath)
  const slug = slugify(title)
  const outDir = path.resolve(options.out || path.join(process.cwd(), 'drafts', slug))
  const platformDir = path.join(outDir, 'platforms')
  const automationDir = path.join(outDir, 'automation')
  const files: DraftFile[] = []

  ensureDir(outDir)
  ensureDir(platformDir)

  const sourceCopy = path.join(outDir, `source${parsed.format === 'html' ? '.html' : '.md'}`)
  writeTextFile(sourceCopy, fs.readFileSync(filePath, 'utf-8'))
  files.push({ kind: 'source', path: relativeFrom(outDir, sourceCopy), note: '原始输入副本' })

  const html = parsed.format === 'html' ? parsed.content : markdownToHtml(parsed.content)
  const markdown = parsed.format === 'markdown' ? parsed.content : stripMarkdown(parsed.content)
  const weixinHtml = convertImagesToDataUri(html, sourceDir).content

  if (platforms.includes('weixin')) {
    const weixinPath = path.join(platformDir, 'weixin.html')
    writeTextFile(weixinPath, weixinHtml)
    files.push({ kind: 'platform', platform: 'weixin', path: relativeFrom(outDir, weixinPath), note: '公众号富文本 HTML，可复制到编辑器或交给后续适配器' })
  }

  if (platforms.includes('zhihu')) {
    const zhihuPath = path.join(platformDir, 'zhihu.md')
    writeTextFile(zhihuPath, `# ${title}\n\n${markdown}\n`)
    files.push({ kind: 'platform', platform: 'zhihu', path: relativeFrom(outDir, zhihuPath), note: '知乎草稿 Markdown' })
  }

  if (platforms.includes('toutiao')) {
    const toutiaoPath = path.join(platformDir, 'toutiao.md')
    writeTextFile(toutiaoPath, `# ${title}\n\n${markdown}\n`)
    files.push({ kind: 'platform', platform: 'toutiao', path: relativeFrom(outDir, toutiaoPath), note: '今日头条草稿 Markdown' })
  }

  if (platforms.includes('x')) {
    const xDir = path.join(platformDir, 'x')
    const xText = Array.from(stripMarkdown(markdown)).slice(0, 260).join('')
    writeTextFile(path.join(xDir, 'post.txt'), `${xText}${Array.from(stripMarkdown(markdown)).length > 260 ? '…' : ''}\n`)
    files.push({ kind: 'platform', platform: 'x', path: relativeFrom(outDir, path.join(xDir, 'post.txt')), note: 'X/Twitter 首条草稿，长文需后续 thread 拆分' })
  }

  let xhsManifest: DraftManifest['xhs']
  if (platforms.includes('xiaohongshu')) {
    const xhsDir = path.join(platformDir, 'xiaohongshu')
    const xhsTitle = makeXhsTitle(title)
    const xhsBody = makeXhsBody(title, markdown)
    const explicitImages = resolveMaybeListFile(options.xhsImages, process.cwd())
    const xhsImages = explicitImages.length > 0 ? explicitImages : collectLocalImagePaths(parsed.content, sourceDir)
    const missingImages = xhsImages.filter((img) => !fs.existsSync(img))
    if (missingImages.length > 0) {
      throw new Error(`小红书图片不存在: ${missingImages.join(', ')}`)
    }

    const titlePath = path.join(xhsDir, 'title.txt')
    const bodyPath = path.join(xhsDir, 'body.txt')
    const imagesPath = path.join(xhsDir, 'upload-files.txt')
    const scriptPath = path.join(automationDir, 'xhs-dom-upload.playwright.mjs')
    writeTextFile(titlePath, `${xhsTitle}\n`)
    writeTextFile(bodyPath, xhsBody)
    writeTextFile(imagesPath, `${xhsImages.join('\n')}\n`)
    writeTextFile(scriptPath, createXhsPlaywrightScript())
    fs.chmodSync(scriptPath, 0o755)

    files.push({ kind: 'platform', platform: 'xiaohongshu', path: relativeFrom(outDir, titlePath), note: '小红书标题，20 字以内' })
    files.push({ kind: 'platform', platform: 'xiaohongshu', path: relativeFrom(outDir, bodyPath), note: '小红书正文，1000 字以内' })
    files.push({ kind: 'platform', platform: 'xiaohongshu', path: relativeFrom(outDir, imagesPath), note: '小红书待上传图片绝对路径列表' })
    files.push({ kind: 'automation', platform: 'xiaohongshu', path: relativeFrom(outDir, scriptPath), note: 'DOM/file-input 上传脚本；需要 CHROME_CDP_URL 指向已登录 Chrome 调试端口；不会点击发布' })

    xhsManifest = {
      title: xhsTitle,
      bodyChars: Array.from(xhsBody).length,
      imageCount: xhsImages.length,
      images: xhsImages,
      automation: relativeFrom(outDir, scriptPath),
    }
  }

  const readmePath = path.join(outDir, 'README.md')
  writeTextFile(readmePath, `# ${title}

这是 WechatSync 的 draft-first 发布包。它只生成平台草稿素材和稳定自动化入口，不执行最终发布。

## 文件

${files.map((file) => `- \`${file.path}\`${file.platform ? ` (${file.platform})` : ''}${file.note ? ` - ${file.note}` : ''}`).join('\n')}

## 小红书自动化

如果需要自动填入小红书，请先用已登录 Chrome 启动调试端口，然后执行：

\`\`\`bash
CHROME_CDP_URL=http://127.0.0.1:9222 npx playwright install chromium
CHROME_CDP_URL=http://127.0.0.1:9222 node automation/xhs-dom-upload.playwright.mjs manifest.json
\`\`\`

脚本只填图、标题、正文，默认不会点击最终发布。
`)
  files.push({ kind: 'metadata', path: relativeFrom(outDir, readmePath), note: '草稿包说明' })

  const manifest: DraftManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: filePath,
    title,
    platforms,
    publishPolicy: options.publishPolicy || 'manual-final-click',
    files,
    xhs: xhsManifest,
  }

  const manifestPath = path.join(outDir, 'manifest.json')
  writeJsonFile(manifestPath, manifest)
  manifest.files.push({ kind: 'metadata', path: relativeFrom(outDir, manifestPath), note: '发布器 manifest' })
  writeJsonFile(manifestPath, manifest)

  return manifest
}

// ============ Bridge 连接 ============

/**
 * 检测占用端口的进程信息
 */
async function detectPortProcess(port: number): Promise<string | null> {
  const { execSync } = await import('child_process')
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8' })
      const pid = output.trim().split(/\s+/).pop()
      if (pid) {
        const info = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf-8' }).trim()
        return `PID ${pid} (${info.split(',')[0]?.replace(/"/g, '') || 'unknown'})`
      }
    } else {
      const output = execSync(`lsof -i :${port} -t 2>/dev/null`, { encoding: 'utf-8' }).trim()
      if (output) {
        const pid = output.split('\n')[0]
        const cmdline = execSync(`ps -p ${pid} -o command= 2>/dev/null`, { encoding: 'utf-8' }).trim()
        return `PID ${pid} (${cmdline.slice(0, 60)})`
      }
    }
  } catch {
    // 检测失败也没关系
  }
  return null
}

/**
 * 创建并连接 Bridge
 */
async function createBridge(): Promise<ExtensionBridge | null> {
  const bridge = new ExtensionBridge(WS_PORT, { silent: true })
  const timeout = connectionTimeout

  // 注册信号处理，确保进程退出时释放端口
  const cleanup = () => {
    bridge.stop()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  const spinner = ora('启动服务...').start()

  await bridge.start()

  if (bridge.getMode() === 'secondary') {
    spinner.text = '检测到已有实例，等待其完成或接管端口...'
  } else {
    spinner.text = '等待 Chrome Extension 连接...'
  }

  try {
    await bridge.waitForConnection(timeout)
    spinner.succeed(
      bridge.getMode() === 'secondary'
        ? 'Chrome Extension 已连接 (通过 PRIMARY 转发)'
        : 'Chrome Extension 已连接'
    )
    return bridge
  } catch (error) {
    spinner.stop()
    const errMsg = (error as Error).message || ''

    if (bridge.getMode() === 'secondary') {
      if (errMsg.includes('timeout:unreachable')) {
        // PRIMARY HTTP API 不可达 — 僵尸进程占了 WS 端口但没有 HTTP API
        console.log()
        console.log(chalk.red('连接超时: 端口被占用但无法与已有实例通讯'))
        console.log(chalk.gray('可能是旧的 wechatsync 进程未正常退出'))
        console.log()

        const processInfo = await detectPortProcess(WS_PORT)
        if (processInfo) {
          console.log(chalk.yellow(`  端口 ${WS_PORT} 占用进程: ${processInfo}`))
          console.log()
        }

        console.log(chalk.bold('解决方法:'))
        if (process.platform === 'win32') {
          console.log(`  1. 终止旧进程: ${chalk.cyan(`taskkill /F /PID <pid>`)}`)
        } else {
          console.log(`  1. 终止旧进程: ${chalk.cyan(`kill $(lsof -i :${WS_PORT} -t)`)}`)
        }
        console.log(`  2. 使用其他端口: ${chalk.cyan(`SYNC_WS_PORT=9600 wechatsync ...`)}`)
      } else {
        // PRIMARY 可达但 Extension 没连上
        console.log()
        console.log(chalk.red('连接超时: 已有实例正在运行但 Chrome Extension 未连接'))
        console.log(chalk.gray('请确保 Chrome 扩展已启用「同步桥接」并且 Token 正确'))
      }
    } else {
      // PRIMARY 模式超时：Extension 没连上来
      showInstallGuide()
      await promptOpenInstallPage()
    }

    console.log()
    bridge.stop()
    return null
  }
}

// ============ sync 命令 ============

program
  .command('sync <file>')
  .description('同步 Markdown/HTML 文件到平台（HTML 文件可保留自定义排版样式）')
  .option('-p, --platforms <platforms>', '目标平台，逗号分隔', 'zhihu,juejin')
  .option('--preset <preset>', `平台预设：${formatPresetList()}`)
  .option('-t, --title <title>', '文章标题（默认从文件提取）')
  .option('--cover <url>', '封面图 URL 或本地路径')
  .option('--dry-run', '仅显示将要执行的操作，不实际同步')
  .action(async (file: string, options) => {
    // 检查文件是否存在
    const filePath = path.resolve(file)
    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`文件不存在: ${filePath}`))
      process.exit(1)
    }

    // 解析文件
    const parsed = parseFileContent(filePath)

    // 确定标题
    const title = options.title || parsed.title
    if (!title) {
      console.error(chalk.red('无法从文件提取标题，请使用 --title 指定'))
      console.log(chalk.gray('提示: Markdown 文件需要包含 # 标题 或 YAML front matter'))
      process.exit(1)
    }

    // 处理封面图（优先使用命令行参数，回退到 HTML meta）
    let cover = options.cover || parsed.cover
    if (cover && !cover.startsWith('http') && !cover.startsWith('data:')) {
      // 本地文件，转为 base64
      const coverPath = path.resolve(cover)
      if (fs.existsSync(coverPath)) {
        const coverBuffer = fs.readFileSync(coverPath)
        const ext = path.extname(coverPath).toLowerCase()
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
        }
        const mimeType = mimeTypes[ext] || 'image/png'
        cover = `data:${mimeType};base64,${coverBuffer.toString('base64')}`
      } else {
        console.error(chalk.red(`封面图文件不存在: ${coverPath}`))
        process.exit(1)
      }
    }

    const platforms = resolvePlatforms(options)

    // 准备内容
    const markdown = parsed.format === 'markdown' ? parsed.content : undefined
    const html = parsed.format === 'html' ? parsed.content : markdownToHtml(parsed.content)

    console.log()
    console.log(chalk.bold('同步信息:'))
    console.log(`  文件: ${chalk.cyan(path.basename(filePath))}`)
    console.log(`  标题: ${chalk.cyan(title)}`)
    console.log(`  格式: ${chalk.cyan(parsed.format)}${parsed.format === 'html' ? chalk.green(' (保留原始排版)') : ''}`)
    console.log(`  平台: ${chalk.cyan(platforms.join(', '))}`)
    if (options.preset) {
      console.log(`  预设: ${chalk.cyan(options.preset)}`)
    }
    console.log(`  内容: ${chalk.gray(parsed.content.length + ' 字符')}`)
    if (cover) {
      console.log(`  封面: ${chalk.cyan(cover.startsWith('data:') ? '(本地图片)' : cover)}`)
    }
    console.log()

    if (options.dryRun) {
      console.log(chalk.yellow('(dry-run 模式，不实际同步)'))
      console.log()
      console.log(chalk.bold('内容预览:'))
      console.log(chalk.gray(parsed.content.slice(0, 300) + (parsed.content.length > 300 ? '...' : '')))
      process.exit(0)
    }

    const bridge = await createBridge()
    if (!bridge) {
      process.exit(1)
    }

    // 处理本地图片：上传到第一个目标平台作为图床
    const fileDir = path.dirname(filePath)
    const localImages = findLocalImages(parsed.content, fileDir)

    let processedMarkdown = markdown
    let processedHtml = html

    if (localImages.length > 0) {
      // 使用第一个目标平台作为图床
      const imageHost = platforms[0]
      console.log(chalk.bold(`发现 ${localImages.length} 张本地图片，上传到 ${imageHost}...`))
      console.log()

      const imageResult = await processLocalImages(parsed.content, fileDir, bridge, imageHost)

      if (imageResult.uploadedCount > 0) {
        // 更新内容
        if (parsed.format === 'markdown') {
          processedMarkdown = imageResult.content
          processedHtml = markdownToHtml(imageResult.content)
        } else {
          processedHtml = imageResult.content
        }
      }

      console.log()
      console.log(
        `图片上传完成: ${chalk.green(imageResult.uploadedCount + ' 成功')}, ${chalk.red(imageResult.failedCount + ' 失败')}`
      )
      if (platforms.length > 1) {
        console.log(chalk.gray(`(其他平台将从 ${imageHost} 图床转存)`))
      }
      console.log()
    }

    const syncSpinner = ora('正在同步...').start()

    try {
      const response = await bridge.request<{ results: SyncResult[]; syncId: string }>('syncArticle', {
        platforms,
        article: {
          title,
          markdown: processedMarkdown,
          content: processedHtml,
          cover,
        },
      })

      const results = response.results || []

      syncSpinner.stop()
      console.log()
      console.log(chalk.bold('同步结果:'))
      console.log()

      for (const result of results) {
        if (result.success) {
          console.log(
            chalk.green('  ✓'),
            chalk.bold(result.platform),
            result.draftOnly ? chalk.gray('(草稿)') : ''
          )
          if (result.postUrl) {
            console.log(`    ${chalk.cyan(result.postUrl)}`)
          }
        } else {
          console.log(chalk.red('  ✗'), chalk.bold(result.platform))
          console.log(`    ${chalk.red(result.error || '未知错误')}`)
        }
      }

      const successCount = results.filter((r) => r.success).length
      console.log()
      console.log(
        `同步完成: ${chalk.green(successCount + ' 成功')}, ${chalk.red((results.length - successCount) + ' 失败')}`
      )
    } catch (error) {
      syncSpinner.fail('同步失败')
      console.error(chalk.red((error as Error).message))
    } finally {
      bridge.stop()
      process.exit(0)
    }
  })

// ============ draft 命令 ============

program
  .command('draft <file>')
  .description('生成 draft-first 多平台发布包（不连接扩展，不点击最终发布）')
  .option('-p, --platforms <platforms>', '目标平台，逗号分隔', 'weixin,zhihu,xiaohongshu,x,toutiao')
  .option('--preset <preset>', `平台预设：${formatPresetList()}`)
  .option('-t, --title <title>', '文章标题（默认从文件提取）')
  .option('-o, --out <dir>', '输出目录（默认 drafts/<title-slug>）')
  .option('--xhs-images <pathsOrFile>', '小红书图片：逗号分隔路径，或包含图片路径的文本文件')
  .option('--publish-policy <policy>', '发布策略：manual-final-click 或 authorized-direct-publish', 'manual-final-click')
  .action((file: string, options) => {
    const filePath = path.resolve(file)
    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`文件不存在: ${filePath}`))
      process.exit(1)
    }

    if (!['manual-final-click', 'authorized-direct-publish'].includes(options.publishPolicy)) {
      console.error(chalk.red(`未知发布策略: ${options.publishPolicy}`))
      console.log(chalk.gray('可用策略: manual-final-click, authorized-direct-publish'))
      process.exit(1)
    }

    try {
      const manifest = createDraftPackage(filePath, {
        title: options.title,
        platforms: options.platforms,
        preset: options.preset,
        out: options.out,
        xhsImages: options.xhsImages,
        publishPolicy: options.publishPolicy,
      })
      const manifestFile = path.resolve(options.out || path.join(process.cwd(), 'drafts', slugify(manifest.title)), 'manifest.json')

      console.log()
      console.log(chalk.bold('发布草稿包已生成:'))
      console.log(`  标题: ${chalk.cyan(manifest.title)}`)
      console.log(`  平台: ${chalk.cyan(manifest.platforms.join(', '))}`)
      console.log(`  策略: ${chalk.cyan(manifest.publishPolicy)}`)
      console.log(`  Manifest: ${chalk.cyan(manifestFile)}`)
      if (manifest.xhs) {
        console.log(`  小红书: ${chalk.cyan(`${manifest.xhs.imageCount} 张图, ${manifest.xhs.bodyChars}/1000 字`)}`)
      }
      console.log(chalk.gray(`  输出目录: ${path.dirname(manifestFile)}`))
      console.log()
    } catch (error) {
      console.error(chalk.red((error as Error).message))
      process.exit(1)
    }
  })

// ============ presets 命令 ============

program
  .command('presets')
  .description('列出内置平台预设')
  .action(() => {
    console.log()
    console.log(chalk.bold('平台预设:'))
    console.log()
    for (const [name, platforms] of Object.entries(PLATFORM_PRESETS)) {
      console.log(`  ${chalk.cyan(name.padEnd(8))} ${platforms.join(', ')}`)
    }
    console.log()
    console.log(chalk.gray('示例: wechatsync sync article.md --preset sun'))
  })

// ============ platforms 命令 ============

program
  .command('platforms')
  .alias('ls')
  .description('列出所有支持的平台')
  .option('-a, --auth', '同时显示登录状态')
  .action(async (options) => {
    const bridge = await createBridge()
    if (!bridge) {
      process.exit(1)
    }

    const spinner = ora('获取平台列表...').start()

    try {
      const platforms = await bridge.request<PlatformInfo[]>('listPlatforms', {
        forceRefresh: options.auth,
      })

      spinner.stop()
      console.log()
      console.log(chalk.bold(`支持的平台 (${platforms.length}):`))
      console.log()

      for (const p of platforms) {
        const status = options.auth
          ? p.isAuthenticated
            ? chalk.green('✓ 已登录')
            : chalk.red('✗ 未登录')
          : ''
        const username = p.username ? chalk.gray(`(${p.username})`) : ''

        console.log(`  ${chalk.cyan(p.id.padEnd(15))} ${p.name.padEnd(10)} ${status} ${username}`)
      }
      console.log()
    } catch (error) {
      spinner.fail('获取失败')
      console.error(chalk.red((error as Error).message))
    } finally {
      bridge.stop()
      process.exit(0)
    }
  })

// ============ auth 命令 ============

program
  .command('auth [platform]')
  .description('检查平台登录状态')
  .option('-r, --refresh', '强制刷新状态')
  .action(async (platform: string | undefined, options) => {
    const bridge = await createBridge()
    if (!bridge) {
      process.exit(1)
    }

    const spinner = ora('检查登录状态...').start()

    try {
      if (platform) {
        const result = await bridge.request<PlatformInfo>('checkAuth', {
          platform,
        })

        spinner.stop()
        console.log()

        if (result.isAuthenticated) {
          console.log(chalk.green(`✓ ${platform} 已登录`))
          if (result.username) {
            console.log(`  用户: ${chalk.cyan(result.username)}`)
          }
        } else {
          console.log(chalk.red(`✗ ${platform} 未登录`))
          if (result.error) {
            console.log(`  错误: ${chalk.gray(result.error)}`)
          }
        }
      } else {
        const platforms = await bridge.request<PlatformInfo[]>('listPlatforms', {
          forceRefresh: options.refresh,
        })

        spinner.stop()

        const authenticated = platforms.filter((p) => p.isAuthenticated)
        const unauthenticated = platforms.filter((p) => !p.isAuthenticated)

        console.log()
        console.log(chalk.bold('登录状态:'))
        console.log()

        if (authenticated.length > 0) {
          console.log(chalk.green(`已登录 (${authenticated.length}):`))
          for (const p of authenticated) {
            const username = p.username ? chalk.gray(`(${p.username})`) : ''
            console.log(`  ${chalk.cyan(p.id.padEnd(15))} ${p.name} ${username}`)
          }
          console.log()
        }

        if (unauthenticated.length > 0) {
          console.log(chalk.red(`未登录 (${unauthenticated.length}):`))
          for (const p of unauthenticated) {
            console.log(`  ${chalk.gray(p.id.padEnd(15))} ${p.name}`)
          }
          console.log()
        }
      }
    } catch (error) {
      spinner.fail('检查失败')
      console.error(chalk.red((error as Error).message))
    } finally {
      bridge.stop()
      process.exit(0)
    }
  })

// ============ extract 命令 ============

program
  .command('extract')
  .description('从当前浏览器页面提取文章')
  .option('-o, --output <file>', '输出到文件')
  .action(async (options) => {
    const bridge = await createBridge()
    if (!bridge) {
      process.exit(1)
    }

    const spinner = ora('提取文章...').start()

    try {
      const article = await bridge.request<{
        title: string
        content: string
        markdown?: string
      } | null>('extractArticle')

      spinner.stop()

      if (!article) {
        spinner.fail('提取失败')
        console.error(chalk.red('无法从当前页面提取文章内容，请确认当前页面包含文章'))
        process.exit(1)
      }

      if (options.output) {
        const outputPath = path.resolve(options.output)
        const content = article.markdown || article.content
        const output = `# ${article.title}\n\n${content}`
        fs.writeFileSync(outputPath, output, 'utf-8')
        console.log(chalk.green(`✓ 已保存到: ${outputPath}`))
        console.log(chalk.gray(`  同步到平台: wechatsync sync ${options.output}`))
      } else {
        console.log()
        console.log(chalk.bold('标题:'), article.title)
        console.log()
        console.log(chalk.bold('内容预览:'))
        const preview = (article.markdown || article.content).slice(0, 500)
        console.log(chalk.gray(preview + (preview.length >= 500 ? '...' : '')))
        console.log()
        console.log(chalk.gray('提示: 使用 -o article.md 保存后可通过 wechatsync sync article.md 同步'))
      }
    } catch (error) {
      spinner.fail('提取失败')
      console.error(chalk.red((error as Error).message))
    } finally {
      bridge.stop()
      process.exit(0)
    }
  })

// ============ 默认行为 ============

if (process.argv.length <= 2) {
  console.log()
  console.log(chalk.bold('WechatSync CLI') + ' - 同步文章到多个内容平台')
  console.log()
  console.log(`官网: ${chalk.cyan(WEBSITE_URL)}`)
  console.log()
  console.log('支持的平台: 知乎、掘金、CSDN、头条、微博、B站、简书 等 20+ 平台')
  console.log()
  console.log(chalk.bold('快速开始:'))
  console.log(`  ${chalk.cyan('wechatsync sync article.md')}        同步 Markdown 文件`)
  console.log(`  ${chalk.cyan('wechatsync sync article.md --preset sun')}  同步到 Sun 常用平台`)
  console.log(`  ${chalk.cyan('wechatsync presets')}         查看平台预设`)
  console.log(`  ${chalk.cyan('wechatsync sync article.html')}      同步 HTML 文件 (保留自定义排版)`)
  console.log(`  ${chalk.cyan('wechatsync extract -o out.md')}      从浏览器提取文章`)
  console.log()
  program.outputHelp()
  process.exit(0)
}

program.parse()
