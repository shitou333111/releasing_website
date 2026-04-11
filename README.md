# Releasing Website

基于 VitePress 的内容站点，内置共享阅读标注系统（文本 + PDF）、Supabase 云端账号与数据存储、移动端适配侧栏与自定义大纲。

本文档覆盖项目运行、部署、配置文件位置、参数说明，以及 `docs/guide/index.md` 中涉及的核心功能说明。

## 1. 项目目标

- 使用 VitePress 搭建可发布文档/内容站点。
- 支持文本标注与 PDF 标注统一展示和存储。
- 支持公开/私密标注、回复、点赞、用户筛选。
- 使用 Supabase 承载账号体系与云端数据。
- 通过 `vitepress-sidebar` 自动生成侧边栏目录，并支持中文目录/文件。

## 2. 技术栈

- 框架：VitePress `^1.6.3`
- 主题扩展：Vue 3 + Pinia
- 侧边栏插件：vitepress-sidebar `^1.33.1`
- 标注库：
	- `@recogito/text-annotator`
	- `@recogito/pdf-annotator`
- PDF 渲染：`@tato30/vue-pdf`
- 云端：`@supabase/supabase-js`

## 3. 快速开始

### 3.1 环境要求

- Node.js 18+（建议 LTS）
- npm 9+

### 3.2 安装依赖

```bash
npm install
```

### 3.3 本地开发

```bash
npm run docs:dev
```

默认监听：`0.0.0.0:5174`

### 3.4 构建与预览

```bash
npm run docs:build
npm run docs:preview
```

## 4. 脚本说明

`package.json` 中定义：

- `docs:dev`: `vitepress dev docs --host 0.0.0.0 --port 5174`
- `docs:build`: `vitepress build docs`
- `docs:preview`: `vitepress preview docs --host 0.0.0.0 --port 5174`

## 5. 目录结构

关键结构如下（省略部分细节）：

```text
.
├─ docs/
│  ├─ .vitepress/
│  │  ├─ config.mts
│  │  ├─ config/
│  │  │  └─ annotations.config.ts
│  │  └─ theme/
│  │     ├─ index.ts
│  │     ├─ Layout.vue
│  │     ├─ custom.css
│  │     ├─ components/
│  │     ├─ composables/
│  │     ├─ stores/
│  │     └─ utils/
│  ├─ guide/
│  │  ├─ index.md
│  │  └─ pdftest.md
│  ├─ 书/
│  ├─ public/
│  └─ index.md
├─ supabase/
│  └─ schema.sql
├─ .env.example
└─ README.md
```

## 6. 核心配置文件与参数

### 6.1 站点总配置

文件：`docs/.vitepress/config.mts`

作用：

- VitePress 基础站点配置（标题、导航、head、搜索、footer）
- 接入 `vitepress-sidebar` 自动侧边栏

关键参数：

- `lang`: 站点语言
- `title` / `description`: 站点标题与描述
- `head`: favicon、viewport、主题色、统计脚本等
- `themeConfig.nav`: 顶部导航
- `themeConfig.search.provider`: 本地搜索

`withSidebar(..., options)` 中关键参数：

- `documentRootPath: 'docs'`: 文档根目录
- `scanStartPath: '/'`: 从 docs 根开始扫描
- `resolvePath: '/'`: 链接解析基准
- `useTitleFromFrontmatter: true`: 侧边栏标题优先使用 frontmatter `title`
- `useTitleFromFileHeading: false`: 不再使用文件内 `# 一级标题` 作为侧边栏标题
	- 在该组合下，若 frontmatter 无 `title`，插件自动回退到文件名
- `useFolderLinkFromIndexFile: true`: 目录链接指向该目录 `index.md`
- `useFolderTitleFromIndexFile: false`: 目录标题不使用 `index.md` 标题，避免重复命名
- `includeRootIndexFile: false`: 不在侧边栏单独展示根 `index.md`
- `includeFolderIndexFile: false`: 不将各目录 `index.md` 再作为子项重复展示
- `excludeByGlobPattern: ['.vitepress/**', 'public/**']`: 排除非内容目录
- `collapsed: false`: 默认展开

### 6.2 标注功能开关配置

文件：`docs/.vitepress/config/annotations.config.ts`

作用：

- 全局控制标注系统是否启用
- 控制生效路径范围
- 控制功能级开关（PDF 标注、回复、点赞、隐私）

关键参数：

- `enabled`: 全局总开关
- `paths.enabled`: 允许路径模式（支持 `*` 与 `**`）
- `paths.disabled`: 强制禁用路径（优先级高）
- `features.pdfAnnotation`: PDF 标注开关
- `features.replies`: 回复开关
- `features.likes`: 点赞开关
- `features.privacy`: 公开/私密开关
- `defaultTagColors`: 默认标注色板

### 6.3 主题增强入口

文件：`docs/.vitepress/theme/index.ts`

作用：

- 扩展默认主题
- 注册 Pinia
- 全局注册 `PDFViewer` 组件

### 6.4 布局与交互逻辑

文件：`docs/.vitepress/theme/Layout.vue`

作用：

- 承载 aside 章节/笔记双 Tab
- 移动端 local nav 的章节与笔记交互
- frontmatter 页面级开关与 PDF 目录解析

读取的页面 frontmatter 字段：

- `notesEnabled`: 页面是否启用笔记（支持 boolean / 字符串）
- `outline: false`: 关闭默认大纲并启用自定义 PDF 大纲区
- `pdfViewerId`: 指定目标 PDFViewer
- `pdfOutline`: 自定义 PDF 目录

`pdfOutline` 支持格式：

- 对象格式：`{ title, page, level? }`
- 行内字符串格式：`"标题" 页码 [层级]`
	- 例如：`'"前言" 3'`

### 6.5 PDFViewer 组件参数（补充）

- `background`: PDF 阅读区域背景色（默认 `#ffffff`）
- 示例：`<PDFViewer src="/PDFs/a.pdf" background="#f8fafc" />`

## 7. Supabase 云端配置

### 7.1 环境变量

模板文件：`.env.example`

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

使用方式：

1. 复制 `.env.example` 为 `.env.local`
2. 填入 Supabase 项目地址与匿名密钥
3. 重启开发服务器

### 7.2 数据库初始化

文件：`supabase/schema.sql`

在 Supabase SQL Editor 执行此脚本，创建注释与用户资料等表结构。

### 7.3 认证模式说明

文件：`docs/.vitepress/theme/stores/userStore.ts`

- 当前仅支持 Supabase 云端认证。
- 若未配置环境变量：登录与创建标注会被禁用。
- 用户名登录策略：
	- 用户名存在且密码正确：登录
	- 用户名不存在：自动注册并登录
	- 用户名支持中文，最多 10 字符

## 8. guide/index 功能覆盖说明

`docs/guide/index.md` 展示并说明的能力，项目已覆盖：

- 文本高亮与笔记
- PDF 标注
- 高亮颜色选择
- 公开/私密标注
- 回复与点赞
- 用户筛选
- Supabase 云端账号与数据同步
- 模糊匹配重定位（内容变动后尽量恢复标注位置）

## 9. 页面 Frontmatter 速查

常见 frontmatter：

```yaml
---
outline: false
notesEnabled: true
pdfViewerId: pdftest-main
pdfOutline:
	- '"封面" 1'
	- '"前言" 3'
---
```

说明：

- `outline: false` 时，右侧章节区域可切换为自定义 PDF 大纲
- `notesEnabled` 控制页面初始笔记状态
- `pdfViewerId` 必须与页面里的 `<PDFViewer viewer-id="..." />` 对应

## 10. 侧边栏标题策略（当前）

当前策略为：

- 有 frontmatter `title`：使用该值
- 没有 frontmatter `title`：使用文件名

对应配置在：`docs/.vitepress/config.mts`

- `useTitleFromFrontmatter: true`
- `useTitleFromFileHeading: false`

## 11. 常见问题排查

### 11.1 侧边栏出现奇怪标题

检查：

- 是否误开启 `useTitleFromFileHeading`
- 文件 frontmatter 是否存在异常内容

建议：

- 采用当前配置：frontmatter 优先 + 文件名回退

### 11.2 某目录没有被侧边栏索引

检查：

- `scanStartPath` / `resolvePath`
- `excludeByGlobPattern` 是否误排除
- 目录中是否有可扫描的 `.md` 文件

### 11.3 build 报错但 dev 可运行

优先检查：

- frontmatter YAML 缩进（必须空格，不能 Tab）
- 自定义配置文件导入路径是否正确

## 12. 部署（GitHub Pages）

- 分支：`main`
- 工作流：`.github/workflows/deploy.yml`
- 自定义域名：`docs/public/CNAME`（当前为 `releasing.icu`）

部署步骤：

1. 推送代码到 `main`
2. 在 GitHub 仓库启用 Pages
3. Source 选择 `GitHub Actions`

## 13. 开发建议

- 新增页面优先补 frontmatter `title`，确保侧边栏命名可控。
- 需要页面级关闭标注时，建议在 `annotations.config.ts` 与页面 frontmatter 双层控制。
- 变更 Layout 或标注存储逻辑后，务必执行一次 `npm run docs:build` 回归验证。
