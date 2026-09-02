# 云忆 · 个人技术博客（Astro 版）

Java 后端工程师的个人技术博客：记录技术学习、项目实践与踩坑经验。
基于 [nuonuo-888/Portfolio](https://github.com/nuonuo-888/portfolio)（Dark Minimal，MIT）改造为内容型博客。

## 技术栈

- [Astro 5](https://astro.build) + React + TypeScript + TailwindCSS（静态输出）
- [Pagefind](https://pagefind.app) 站内全文搜索
- 代码高亮：Shiki（github-dark）
- 代码字体：JetBrains Mono（本地自托管 woff2，来自 JetBrainsMono 2.304 官方字体包）
- 部署：GitHub Pages（`.github/workflows/deploy.yml`）

## 本地开发

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # astro check && astro build && pagefind 索引
npm run preview    # 预览构建产物
```

> 本地无 `ASTRO_BASE` 时 base 默认 `/personal-blog/`；部署时由 workflow 按仓库名注入。

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
- 文章支持标准 Markdown：代码块（自动高亮并带语言标签）、表格、引用、图片
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
├── lib/posts.ts         # 文章查询与工具函数
└── React/LetterGlitch.tsx
public/
├── fonts/               # JetBrains Mono woff2（自托管）
└── favicon.svg
```

## 许可

本项目基于 [Dark Minimal](https://astro.build/themes/details/dark-minimal/)（MIT）改造。
按 MIT 条款保留原作者版权声明（页面页脚与 LICENSE 文件）。
博客文章内容版权归作者（云忆 / Lurbing7）所有，转载按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 注明出处。
