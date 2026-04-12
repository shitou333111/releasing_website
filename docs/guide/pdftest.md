---
outline: false
notesEnabled: false
pdfViewerId: pdftest-main
pdfOutline:
  - '"封面" 1'
  - '"前言" 3'
  - '"第一章" 200'
  - '"第二章" 400'
  - '"第三章  它符合人体有吗人发贴用户对人体冯太后的然后对方同意后" 250'
---

# 共享阅读标注系统演示

欢迎使用共享阅读标注系统！这个系统支持：

- 文本高亮和笔记
- PDF 文件标注
- 高亮颜色选择
- 隐私设置（公开/私密）
- 回复和点赞
- 用户筛选
- Supabase 云端账号与云同步
- PDF 全文搜索

## 文本标注演示

试试选中这段文字，然后添加您的笔记！您可以选择不同的高亮颜色。

### 功能特点

1. **精准定位**：使用 Recogito 标注库，精准记录位置
2. **模糊匹配**：文章修改后仍能找到标注位置
3. **多用户支持**：不同用户可以添加自己的标注
4. **隐私控制**：可以选择公开或私密标注

### 继续尝试

选中任意文本段落，体验标注功能！您可以：
- 选择高亮颜色
- 设置隐私权限
- 与其他用户互动

## PDF 标注（需要 PDF 文件）

提示：要体验 PDF 标注功能，请将 PDF 文件放入 `public` 目录，然后使用组件嵌入页面。

### 内嵌 PDF 示例（固定区域，区域内滚动）
<!-- <PDFViewer src="/PDFs/a1.pdf" embedMode="contained" height="72vh" :trimX="100" /> -->



### 全页铺展 PDF 示例（从第一页到最后一页）

<PDFViewer
	src="/PDFs/guide/pdftest.pdf"
	viewer-id="pdftest-main"
	background="#F8FAFC"
	embedMode="fullpage"
	:enable-crop="false"
	:show-page-separators="true"
	:show-crop-guides="false"
	:lazy-page-buffer="2"
	lazy-root-margin="180% 0px"
	:crop-odd ="{ top: 200, right: 80, bottom: 150, left: 134 }"
	:crop-even="{ top: 200, right: 134, bottom: 150, left: 80 }"
/>

## 功能实现状态（2026-04）

- 已实现：文本标注与 PDF 标注的统一存储和展示
- 已实现：右侧栏支持 `On this page` / `标注笔记` 两个卡片切换
- 已实现：标注支持颜色、公开/私密、回复、点赞、展开/收起
- 已实现：私密标注仅创建者可见，可按用户筛选
- 已实现：仅登录用户可创建标注
- 已实现：正文点击标注与右侧列表激活联动
- 已实现：模糊匹配已接入标注恢复流程，文章改动后可自动重定位

## Supabase 云端接入

1. 在 Supabase 免费创建项目。
2. 打开 SQL Editor，执行项目内 `supabase/schema.sql`。
3. 根目录复制 `.env.example` 为 `.env.local`，填入：
	- `VITE_SUPABASE_URL`
	- `VITE_SUPABASE_ANON_KEY`
4. 重启 `npm run docs:dev`。
5. 在右侧栏点击 `注册/登录`，输入用户名和密码。
	- 用户名已存在且密码正确：直接登录
	- 用户名不存在：自动注册并登录
	- 用户名支持汉字，最多 10 个字符

说明：
- 未配置 Supabase 时，注册/登录与标注创建会被禁用。
- 配置 Supabase 后，公开标注可被所有访问者读取，私密标注只对创建者可见。
- 只有已登录用户可以创建标注。

## 页面/目录开关

通过 `docs/.vitepress/config/annotations.config.ts` 控制开关。

```ts
export const annotationConfig = {
	enabled: true,
	paths: {
		enabled: ['/guide/*', '/**'],
		disabled: ['/private/**']
	},
	features: {
		pdfAnnotation: true,
		replies: true,
		likes: true,
		privacy: true
	}
};
```

- `enabled`: 全局总开关
- `paths.enabled`: 允许开启的路径（支持 `*` 与 `**`）
- `paths.disabled`: 强制关闭的路径（优先级高于 enabled）
- `features`: 功能级开关（回复/点赞/隐私/PDF 标注）

