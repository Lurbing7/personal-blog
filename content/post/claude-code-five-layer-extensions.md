---
title: "Claude Code 五层扩展体系：MCP/Skill/Hook/Subagent/Plugin 怎么选"
description: "Claude Code 的扩展能力不是装插件，而是一套分层 Agent 工程系统。拆解 MCP、Skill、Hook、Subagent、Plugin 五层各自解决的问题与选型信号，给出五问诊断框架和克制配置原则。"
date: 2026-09-01
tags: ["Claude Code", "MCP", "Hook", "Agent"]
categories: ["AI 工程"]
---

# Claude Code 五层扩展体系：MCP/Skill/Hook/Subagent/Plugin 怎么选

遇到 Claude Code，第一反应常是「装什么插件」。MCP、Skill、Hook、Subagent、Plugin 摆在面前，很容易逐个试一遍，最后配了一堆用不上的东西。

这套扩展不是插件市场，而是一套分层的 Agent 工程系统，每一层解决不同的问题。选错层的典型表现：该接 MCP 的时候靠 prompt 硬猜、该做 Hook 的规则靠人自觉。核心原则只有一条：**不要从「我能装什么」出发，要从「这个项目需要什么」出发**。

## 五层总览

| 层 | 解决什么问题 | 类比 |
|---|---|---|
| MCP | 缺少外部事实和操作能力 | 眼睛和手，让 Agent 看见真实世界 |
| Skill | 高频重复任务靠人临时描述 | 团队经验，把一次性 prompt 变成可复用流程 |
| Hook | 规则写在文档里但执行不稳定 | 团队纪律，把「应该做」变成「必然发生」 |
| Subagent | 不同性质的问题混在一起判断变浅 | 专业分工，不同视角并行审查 |
| Plugin | 每个人手动配一套能力不一致 | 团队分发，复用工程习惯 |

## 第一层：MCP，外部事实入口

MCP Server 不是插件，是外部事实入口。判断逻辑很直接：

```text
项目里已经存在某类外部系统
        ↓
Agent 需要和这个系统交互或读取事实
        ↓
推荐对应 MCP
```

常见映射：

| 项目信号 | 推荐 MCP | 为什么 |
|---|---|---|
| React/Vue/Next.js/Express/Prisma/Stripe | context7 | 防止模型凭训练记忆写过时 API |
| 前端应用 | Playwright MCP | 前端质量必须打开页面看真实 UI |
| Supabase/Postgres/Convex | 数据库 MCP | 需要读取真实数据结构 |
| GitHub/Linear/Sentry | 对应服务 MCP | 需要 issue、错误日志、PR 上下文 |
| Docker | Docker MCP | 需要管理容器状态 |

没有 MCP 的 Agent 只能靠代码和上下文猜测；接入合适 MCP 才能看见真实数据库、真实浏览器、真实错误日志。最常见的坑，是让模型凭训练记忆写 API。

## 第二层：Skill，可复用的工作方法

Skill 把重复出现的工程动作变成可调用的流程，例如 `api-doc` 生成 API 文档、`create-migration` 建数据库迁移（含 up/down）、`gen-test` 按现有测试风格补测试、`pr-check` 做 checklist 审查。

好的 Skill 要回答四个问题：什么时候触发、按什么步骤做、参考哪些模板或示例、做完后怎么验证。

Prompt 是一次性沟通，Skill 是团队流程资产：前者管「这次怎么做」，后者管「以后遇到这类任务都怎么做」。

## 第三层：Hook，把规范塞进执行链路

Hook 解决的是「规则写了，但执行不稳定」。规则在文档里，Agent 可以忽略；规则在 Hook 里，做完某类动作必须过这道门。

常见 Hook：

- `PostToolUse: Edit/Write` → 自动格式化（Prettier）
- `PostToolUse: Edit/Write` → 运行 lint 或 type-check
- `PreToolUse` → 阻止编辑 `.env`、`credentials`、lock files
- `PostToolUse: 修改测试文件` → 运行相关测试

Skill 告诉 Agent「遇到这类任务可以这样做」；Hook 告诉 Agent「做完某类动作必须经过这道门」。本质是把 CI、pre-commit、lint-staged 这套工程纪律，重建在 Agent 的工具事件上。

## 第四层：Subagent，专业判断的并行化

Subagent 不是「多叫几个模型来热闹」，而是把不同性质的判断拆开。大型代码库配 `code-reviewer`，认证/支付/用户数据配 `security-reviewer`，API 项目配 `api-documenter`，数据库和热点路径配 `performance-analyzer`，前端组件多配 `ui-reviewer`。

安全审查看权限边界、输入校验、密钥泄漏；性能分析看 N+1 查询、复杂度、缓存；UI 审查看可访问性、响应式。这些不是同一种思维负载，混在一个 Agent 里判断会变浅。

拆成 Subagent，等于把主 Agent 的「单线程判断」变成「多角色并行审查」。

## 第五层：Plugin，团队级分发单元

Plugin 把 MCP + Skill + Hook + Subagent 打包，让整个团队一致使用：

```text
plugin/
├── .claude-plugin/plugin.json
├── skills/
├── agents/
├── hooks/
├── commands/
└── .mcp.json
```

例如前端团队的 plugin，可以包含 UI review agent、component generator skill、Playwright 验收命令、自动格式化 hook。

## 怎么选：五问诊断框架

给项目做配置时，不问「装哪个插件」，先问五个问题：

1. Agent 经常因为缺少外部事实而猜错吗？ → 优先 MCP
2. 团队是否有反复出现的任务？ → 写成 Skill
3. 哪些规则每次都必须执行？ → 写成 Hook
4. 哪些判断需要专家视角？ → 设计 Subagent
5. 这套能力是否要给整个团队复用？ → 打包成 Plugin

## 克制原则

官方 [Claude Code Setup](https://github.com/anthropics/claude-code-setup) 的核心流程分四步：

```text
1. Scanner：读 package.json / pyproject.toml / go.mod / CI / Docker / Claude 配置
2. Signal Model：事实转结构化信号
3. Recommendation Engine：信号映射到五层能力
4. Ranker：按 impact + frequency + confidence - setup_cost - runtime_noise 排序
```

克制原则：每类只推荐 1-2 个最高价值选项，不把用户淹没。

## 小结

五层各解决一类问题：MCP 补外部事实，Skill 沉淀流程，Hook 强制纪律，Subagent 拆专业判断，Plugin 做团队分发。选型的正确顺序，是从项目信号出发、先诊断再配置，而不是反向堆插件。

记住开头那句话：从「这个项目需要什么」出发，而不是从「我能装什么」出发。
