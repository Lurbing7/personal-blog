---
title: "MCP 配置实战：三层作用域与六个真实踩坑"
description: "Claude Code 的 MCP 配置分三层作用域：项目级、全局、.mcp.json，优先级从高到低。文章讲清每层配置方式与验证命令，复盘六个真实踩坑，从被静默忽略的 settings.local.json 到 AI 误写的 ~/.mcp.json。"
date: 2026-09-01
tags: ["MCP", "配置", "排障"]
categories: ["AI 工程"]
---

# MCP 配置实战：三层作用域与六个真实踩坑

## 背景：MCP 配置为什么会乱

Claude Code 通过 MCP（Model Context Protocol）接入外部工具：浏览器自动化、IDE 集成、数据库连接。配置入口多、层级多，最常见的体验是配置了但 `claude mcp list` 看不到，或者改完不生效。

更麻烦的是 AI 助手经常建议写到错误路径。Claude Code 对不认识的配置文件不报错，只静默不加载，排查全靠猜。

这篇文章先讲清三层作用域的配置方式、优先级和验证命令，再复盘六个实际遇到的问题。

## 三层作用域

Claude Code 的 MCP Server 配置分三个层级，按优先级从高到低：

| 层级 | 配置文件 | 优先级 |
|---|---|---|
| 项目级 | `~/.claude.json` → `projects.<项目路径>.mcpServers` | 最高 |
| 全局 | `~/.claude.json` → `mcpServers` | 中 |
| 项目共享 | 项目根目录 `.mcp.json` | 最低 |

其中 `~/.claude.json` 位于 `C:\Users\<用户名>\.claude.json`。

选择依据很简单：只有当前项目用，放项目级；所有项目通用，放全局；需要团队协作，放 `.mcp.json`。三层不是并列关系，同名时会互相覆盖，优先级在后面的小节单独讲。

## 全局配置：所有项目通用

全局配置对所有项目生效，适合浏览器自动化（playwright）、IDE 集成这类通用工具。添加时显式指定 `--scope user`：

```bash
# 全局添加 stdio 类型的 MCP Server
claude mcp add --scope user playwright -- npx @playwright/mcp@latest

# 全局添加 SSE 类型的 MCP Server
claude mcp add --scope user --transport sse intellij-idea http://127.0.0.1:64342/sse
```

也可以手动编辑 `~/.claude.json`，在根级别的 `mcpServers` 字段添加：

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      "env": {}
    },
    "intellij-idea": {
      "type": "sse",
      "url": "http://127.0.0.1:64342/sse"
    },
    "webstorm": {
      "type": "sse",
      "url": "http://127.0.0.1:64343/sse"
    }
  }
}
```

全局配置修改后，重启 Claude Code 会话即可生效。

## 项目级配置：只对当前项目生效

项目级配置只对特定项目生效，其他项目不加载，适合项目专用的数据库连接、业务工具。进入项目目录直接添加：

```bash
cd /path/to/project
claude mcp add my-db -- npx @anthropic/mcp-server-postgres --connection-string "postgresql://..."
```

命令会把配置写入 `~/.claude.json` 的 `projects.<项目路径>.mcpServers`。也可以手动编辑该字段，效果相同。

注意：`claude mcp add` 不加 `--scope user` 时，默认就是项目级（`--scope project`）。

## 项目共享配置：.mcp.json

在项目根目录创建 `.mcp.json`，可提交到 Git 仓库，团队共享：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "./data"]
    }
  }
}
```

配置文件本身在仓库中可见，但每个开发者通过 `claude mcp add` 的交互提示，独立控制是否启用。

## 作用域优先级

当同一名称的 MCP Server 在多个层级中配置时，按以下顺序覆盖：

```text
项目级 > 全局级 > .mcp.json
```

即项目级配置会覆盖全局同名配置。

## 验证与日常命令

```bash
# 列出所有 MCP Server 及其连接状态
claude mcp list

# 添加（默认项目级）
claude mcp add <名称> -- <命令> [参数...]

# 添加 SSE 类型
claude mcp add --transport sse <名称> <URL>

# 指定作用域
claude mcp add --scope project <名称> -- <命令>
claude mcp add --scope user <名称> -- <命令>

# 删除
claude mcp remove <名称>
```

## 六个真实踩坑

**坑一：AI 把配置写进了 `~/.mcp.json`**

让 Claude 帮忙配置 MCP Server（如 `chrome-devtools-mcp`）时，AI 建议写入 `~/.mcp.json`。写入后 MCP 不生效，`claude mcp list` 也看不到。

根因：`~/.mcp.json` 不是 Claude Code 认可的配置文件。这个路径来自其他 MCP 客户端（如 Claude Desktop）的习惯，Claude Code 不识别。有效路径只有三个：

| 路径 | 作用域 |
|---|---|
| 项目根 `.mcp.json` | 项目级 |
| `~/.claude/mcp.json` | 全局 |
| `~/.claude.json` → `mcpServers` | 全局 |

解决：改用 `claude mcp add --scope user chrome-devtools -- chrome-devtools-mcp --autoConnect`，或手动创建 `~/.claude/mcp.json`。以后 AI 再建议写 `~/.mcp.json`，要纠正它。

验证：重启会话后执行 `claude mcp list`，应看到 `chrome-devtools: chrome-devtools-mcp --autoConnect - ✓ Connected`。

**坑二：配置写进 `settings.local.json` 被静默忽略**

Claude Code 2.1.x 不再从 `settings.local.json` 的 `mcpServers` 字段读取 MCP 配置。写在这里的配置会被静默忽略，不报任何错。MCP 配置必须走 `claude mcp add` 命令、`~/.claude.json` 或 `.mcp.json`。

容易混淆的是几个文件名接近的配置：

| 文件 | 用途 | 是否提交 |
|---|---|---|
| `.mcp.json` | MCP Server 配置 | 可提交，团队共享 |
| `.claude/settings.local.json` | 项目级本地设置 | 不提交，个人私有 |
| `.claude/settings.json` | 项目级共享设置 | 可提交 |

`.mcp.json` 管 MCP Server，`settings` 系列管项目设置，别混用。

**坑三：项目级和全局同名冲突**

同一名称的 Server 在项目级和全局同时配置时，项目级会覆盖全局，容易以为配置丢了。解决：明确指定作用域，或删除其中一个。

**坑四：配置了但不生效，先查写入位置**

配置了但不生效时，第一个排查点：是否写入了正确的 `~/.claude.json` 位置。合法路径只有坑一表格里的三条，写错位置就不会被加载。

**坑五：MCP Server 进程没有运行**

部分 Server 依赖外部进程，比如 IDE 集成的 SSE Server，需要保持 IDE 打开。进程退出后配置自然失效，`claude mcp list` 会显示连接失败。

**坑六：改完配置不重启会话**

MCP 配置在会话启动时加载。修改 `~/.claude.json` 或 `.mcp.json` 后，需要重启 Claude Code 会话才能生效。验证方法是重启后执行 `claude mcp list`，看到 `✓ Connected` 才算配置成功。

## 小结

MCP 配置的核心就三件事：三层作用域、同名覆盖优先级、三条合法路径。

这些问题的共性都是「静默」：Claude Code 对不认识的路径不报错，只不加载。所以每次改完配置，用 `claude mcp list` 验证是否出现且连接成功，是成本最低的排查手段。

标准动作是：改配置 → 重启会话 → `claude mcp list` 确认 `✓ Connected`。三步走完，配置问题基本都能定位。
