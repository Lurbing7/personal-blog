---
title: "weave：给多个本地 Agent CLI 建统一桌面管理"
description: "给 Claude Code、Codex 等多个本地 Agent CLI 建统一桌面管理，核心是修正队列与中断注入、跨 Agent 记忆继承与 Agent 接力，规划中的可视化工作流编排。"
date: 2026-09-01
tags: ["Tauri", "Vue", "Agent"]
categories: ["项目实践"]
---

# weave：给多个本地 Agent CLI 建统一桌面管理

## 为什么做这个项目

本地 Agent CLI 越来越多：Claude Code、Codex、Gemini CLI、OpenCode、OpenClaw，各自占一个终端窗口。任务一多，来回切换就很烦。

实际使用中还有三个更麻烦的点：

1. 对话无法中断修正。Agent 执行中发现方向不对，只能等它跑完，或者 Ctrl+C 重来，不能随时插入修正消息。
2. 记忆不互通。Codex 额度用完切到 Claude Code，要手动导出记忆再导入，流程割裂。
3. 多 Agent 协作靠人肉串联，没有可视化编排。

Weave（中文名灵枢，取「调度枢纽」之意）就是为这个问题做的：一个统一入口，管理本地 Agent 的任务连续性，支持 Agent 接力、修正队列、记忆继承和可视化工作流编排。

## 技术选型与整体架构

桌面框架选 [Tauri v2](https://v2.tauri.app/)：打包体积小（约 5MB），Rust 做进程管理有天然优势，v2 已稳定。前端用 [Vue 3](https://cn.vuejs.org/)，工作流画布计划用 [Vue Flow](https://vueflow.dev/)。本地存储用 [SQLite + FTS5](https://www.sqlite.org/fts5.html)，零配置零依赖，全文搜索直接支撑记忆检索。

```text
┌─────────────────────────────────────────┐
│          Vue 3 前端                       │
│  Agent 管理 / 对话面板 / 工作流画布(v2)   │
└──────────────────┬──────────────────────┘
                   │ IPC（Tauri invoke）
┌──────────────────┴──────────────────────┐
│          Rust 后端                       │
│  Agent 管理器 / 记忆中心 / 对话管理器     │
└──────────────────┬──────────────────────┘
                   │
┌──────────────────┴──────────────────────┐
│        Agent 适配层                      │
│  Claude Code / Codex / Gemini / OpenCode │
└──────────────────┬──────────────────────┘
                   ↓
        多个 CLI 子进程
```

后端通过适配层统一接入各 CLI，前端只管界面，进程的启动、中断、监控都交给 Rust。

## 核心机制一：中断注入

Agent 执行中不能打断，是最影响体验的问题。v1 的方案是「队列 + 插入 + 重建」：

```text
用户发送修正消息 → 消息进入待插入队列
→ 用户点击「插入到当前对话」
→ 向 CLI 进程发送 SIGINT（Ctrl+C）
→ 把中断消息拼接到对话末尾
→ 自动发送 resume 命令 → 恢复对话
```

之所以先入队而不是立即打断，是避免误触。用户先把想法放进队列，确认后再触发中断，这个交互比直接打断安全。

v2 针对支持 PTY 的 CLI 做原生优化：通过 PTY stdin 直接写入消息，进程实时感知上下文修正，不用中断重建。

## 核心机制二：记忆中心

记忆分四类，各有生命周期和来源：

| 类型 | 内容 | 生命周期 |
|---|---|---|
| context | 项目背景、技术栈、规范 | 长期，手动管理 |
| session | 做了什么、输出什么、卡在哪 | 中期，自动生成 |
| decision | 做了什么选择、为什么 | 长期，自动归档 |
| discovery | 坑点、技巧、注意事项 | 长期，手动/自动 |

存储用 SQLite，记忆表加 FTS5 全文索引：

```sql
CREATE TABLE project_memory (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,      -- 关联项目
    type TEXT NOT NULL,         -- context / session / decision / discovery
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_agent TEXT,          -- 来源 Agent
    session_id TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE VIRTUAL TABLE memory_fts USING fts5(
    title, content, tags, content=project_memory
);
```

记忆注入在对话启动时做：按项目匹配相关记忆（context + 上次 session + 相关 decision），拼成「项目背景 + 上次进度 + 相关决策」的文本注入给 Agent。

跨 Agent 切换是核心场景：Claude Code 额度不足或卡住时，选择「让 Codex 接手」，Weave 自动提取会话摘要、匹配项目记忆、通过隔离子进程启动目标 Agent 并注入初始上下文，Codex 在同一个 Weave 会话里接着干。

v1 的记忆提取用规则匹配：扫描对话文本，匹配 `<!--DECISION:xxx-->`、`<!--DISCOVERY:xxx-->`、`<!--NOTE:xxx-->` 标记，自动提取最后几条消息作为会话摘要。v2 计划用本地小模型（Ollama + qwen2.5:0.5b）自动摘要。

## 版本规划

分三个阶段：

- **v0.5 原型验证**：验证核心技术风险——Tauri 在 Win/Mac 编译运行、Rust 启动 CLI 并捕获流式输出、前端流式 Markdown 渲染、修正消息队列、SQLite 读写对话历史。
- **v1.0 MVP**：Agent 检测与统一配置、多对话并行、修正队列与中断注入、记忆中心、Agent 接力池。
- **v2.0 工作流**：Vue Flow 画布节点编排，DAG 拓扑排序驱动执行引擎，JSON 序列化持久化，模板库与导入导出。

原型已做了静态版，覆盖四个状态：准备态、运行态、修正态、恢复态，先把交互确认清楚，再进入实现。

## 设计取舍与未决事项

几个关键取舍值得记录：

- **中断用通用方案先行**。v1 的 SIGINT + resume 对所有 CLI 通用，PTY 原生注入只针对支持 PTY 的 CLI，放在 v2。先用通用方案验证价值，再按 CLI 能力做优化。
- **不污染全局配置**。Headroom Bridge 通过托管 proxy/wrap 子进程接入，按会话分配端口（默认从 8787 开始），只通过子进程环境变量或临时参数传递，不修改 `~/.codex/config.toml` 或 Claude 配置；Headroom 不可用时降级为普通会话。
- **外部工具只作参考**。CC Switch 的 provider、MCP、skills 配置可以读取联动，但不接管 Weave 会话。

还没定的：v0.5 的具体实现步骤未拆解、各 Agent CLI 的参数适配方案未定、是否需要会话模板/预设功能待讨论。这些留在原型验证后处理。

## 小结

Weave 解决的是一个真实的日常痛点：多个本地 Agent CLI 之间切换、打断、记忆传递全靠手动。方案上不做普通 launcher，定位是任务连续性管理器：修正队列 + 中断注入解决「不能打断」，记忆中心解决「换 Agent 丢上下文」，接力池解决「额度用完卡住」。

当前进展到静态原型，v1 的核心机制设计已经完整，剩下的是把原型验证跑通、把未决事项逐个定掉。
