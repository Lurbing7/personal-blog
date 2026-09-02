# AGENTS.md

本文件是 AI 代理在本仓库工作时的入口约定。

## 仓库定位

`Lurbing7/personal-blog` 个人技术博客（Astro 5 + React + TailwindCSS），内容在 `src/content/post/`，部署 GitHub Pages（`.github/workflows/deploy.yml`）。

## 提交约定

- 提交信息使用中文 Conventional Commit（`feat:` / `fix:` / `style:` / `docs:` / `chore:` 等）。
- **所有 AI 代理（DSH）实际参与的提交，commit body 必须追加 Co-authored-by 尾注**，标明由 DeepSeek Harness 共同提交：

  ```text
  Co-authored-by: DeepSeek Harness <deepseek-harness@users.noreply.github.com>
  ```

- 变更走分支 + PR 流程：新功能在分支上开发，提交后开 PR 到 `main`，由用户审批合并。

## 本地开发

```bash
npm install
npm run dev        # http://localhost:4321/personal-blog/
npm run build      # astro check && astro build && pagefind 索引
```

## 内容写作

文章位于 `src/content/post/*.md`，front matter：`title` / `description` / `date` / `tags` / `categories`（`featured: true` 进首页精选）。分类、标签页与首页筛选自动生成。
