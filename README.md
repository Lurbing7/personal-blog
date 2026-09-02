# 云忆 · 个人技术博客

> Java 后端工程师的个人技术博客：记录技术学习、项目实践与踩坑经验。

线上站点：<https://lurbing7.github.io/personal-blog/>

基于 [nuonuo-888/Portfolio](https://github.com/nuonuo-888/portfolio)（Dark Minimal，MIT）改造为内容型博客。

## 特性

- 🏠 **首页**：个人名片 Hero（LetterGlitch 毛刺特效 + 技术墙滚动条）、精选文章、分类筛选文章索引（计数联动）、联系区
- 📄 **文章页**：目录 TOC、阅读时间估算、上一篇/下一篇、CC BY-NC-SA 许可声明、Shiki 代码高亮（github-dark）并带语言标签
- 🗂 **归档体系**：分类页（13 个）、标签页（104 个）、按年归档页，全部由文章 front matter 自动生成
- 🔍 **站内搜索**：[Pagefind](https://pagefind.app) 全文搜索（中文可用，结果带摘要）
- 📡 **SEO**：RSS（`/rss.xml`）、sitemap.xml、OG/canonical/description
- 🔤 **代码字体**：JetBrains Mono 2.304 本地自托管（woff2），不依赖外部字体 CDN
- 🌓 **深色主题**：Dark Minimal 风格，跟随系统偏好（无明暗切换按钮，模板原生深色）

## 技术栈

- [Astro 5](https://astro.build)（静态输出）+ React + TypeScript + TailwindCSS
- [Pagefind](https://pagefind.app) 站内全文搜索
- [Shiki](https://shiki.style) 代码高亮
- 部署：GitHub Pages（`.github/workflows/deploy.yml`）

## 本地开发

```bash
npm install
npm run dev        # http://localhost:4321/personal-blog/
npm run build      # astro check && astro build && pagefind 索引
npm run preview    # 本地预览构建产物
```

> **base 路径说明**：站点部署在 GitHub Pages 项目子路径 `/personal-blog/` 下，本地未设置 `ASTRO_BASE` 时默认 `base = /personal-blog/`；部署时由 workflow 按仓库名自动注入。所有内部链接与静态资源（含字体）均带 base 前缀。

## 内容写作

文章放在 `src/content/post/*.md`，front matter：

```yaml
---
title: "文章标题"
description: "摘要，用于列表页与 SEO"
date: 2026-09-01
tags: ["标签1", "标签2"]
categories: ["Java"]
featured: true   # 首页精选（可选）
---
```

- 分类、标签页与首页筛选由 front matter 自动生成
- 支持标准 Markdown：代码块（自动高亮并带语言标签）、表格、引用、图片
- 标签/分类名若含 `/`（如 `CI/CD`），URL 会自动 slug 化为 `CI-CD`
- 发布后运行 `npm run build` 会重新生成 Pagefind 搜索索引

## 目录结构

```text
src/
├── content/
│   └── post/            # 博客文章（Markdown）
├── content.config.ts    # 文章集合 schema
├── layouts/
│   ├── Layout.astro     # 全局布局（导航/页脚/SEO/字体）
│   └── PostLayout.astro # 文章页（TOC/阅读时间/前后篇/许可）
├── components/          # 首页区块（hero/精选/文章索引/联系）
├── pages/               # 路由：首页/文章/分类/标签/归档/搜索/关于/404/RSS
├── lib/posts.ts         # 文章查询、slug 与工具函数
└── React/LetterGlitch.tsx
public/
├── fonts/               # JetBrains Mono woff2（自托管）
└── favicon.svg
```

## 部署

推送 `main` 分支自动触发 GitHub Pages 部署（`.github/workflows/deploy.yml`）：

1. `actions/configure-pages` 配置 Pages
2. `npm ci && npm run build`（含 `astro check` 类型检查与 Pagefind 索引）
3. 上传 `dist/` 并 `deploy-pages` 发布

## AI 代理约定

AI 代理在本仓库工作的约定（提交信息格式、Co-authored-by 尾注、分支 PR 流程）见 [AGENTS.md](./AGENTS.md)。

## 许可

本项目基于 [Dark Minimal](https://astro.build/themes/details/dark-minimal/)（MIT）改造。
按 MIT 条款保留原作者版权声明（页面页脚与 [LICENSE](./LICENSE) 文件）。
博客文章内容版权归作者（云忆 / Lurbing7）所有，转载按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 注明出处。
