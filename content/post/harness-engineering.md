---
title: "Harness Engineering：从 Prompt 到给 AI 装上缰绳、刹车和仪表盘"
description: "Harness Engineering 是 2026 年 AI 编程的核心方法论：用任务边界、硬约束、独立验证与人机 Gate，把模型之外的机制装成缰绳、刹车和仪表盘，让 Agent 在真实代码库里被信任地多轮干活。"
date: 2026-09-01
tags: ["AI 工程", "Agent", "约束"]
categories: ["AI 工程"]
---

# Harness Engineering：从 Prompt 到给 AI 装上缰绳、刹车和仪表盘

## 问题：模型够聪明了，为什么还是不敢放手

AI 编程的方法论三年换了三次主题。2023-2024 年大家研究 Prompt Engineering，琢磨怎么把任务跟模型说清楚；2025 年转向 Context Engineering，琢磨给模型喂什么资料。到了 2026 年，模型的代码能力已经足够强，瓶颈转移了：能不能让它在真实代码库里被信任地连续运行多轮。

一个典型场景：让 Agent 修一个 bug，它改完代码说「done」，但测试其实挂了，或者它顺手动了不该动的文件。在 prompt 里写一百遍「请小心」也没用。问题不在模型不够聪明，而在它干活的环境没有约束、没有反馈、没有检查点。

Martin Fowler 的定义点破了本质：**harness 是模型之外、帮助 agent 工作的所有外层机制**。模型只是引擎，方向盘、刹车、仪表盘和安全带全在引擎之外，这套东西就是 Harness Engineering。

## 核心公式：Agent 由什么组成

```text
Coding Agent = Model + Context + Tools + Constraints + Feedback + Human Control
                               └──────────── Harness ────────────┘
```

模型负责生成，其余每一项都是 harness 的组成部分。对照三层演进，位置关系更清楚：

| 层次 | 解决什么问题 | 类比 |
|------|------|------|
| Prompt Engineering | 你对模型说什么 | 给实习生写任务书 |
| Context Engineering | 模型能看到什么 | 给实习生准备资料 |
| Harness Engineering | 模型在什么约束下干活、什么时候 review、谁能拍板 | 定权限、排检查点、设审批 gate |

## 九维度框架：缰绳、刹车、仪表盘分别是什么

### 约束类：先划清不能做什么

任务边界：能改 bug、能写测试；不能改支付逻辑、不能直接 deploy。边界写清楚，Agent 一开始就知道哪些事不归它管。

硬约束：把规则从 prompt 搬进 linter 和 CI。「请遵守架构规范」是软约束，Agent 可能视而不见；CI 阻止跨层 import 才是硬约束，违反就失败。

权限与破坏半径：禁止 `rm -rf`、禁止直接 push main、敏感目录只读。权限决定了 Agent 最坏能把事情搞成什么样。

### 反馈类：让 Agent 看得见结果

工具集：grep、LSP、typecheck、test runner。工具产生的确定性反馈，比 prompt 里写「请小心」可靠一万倍。与其劝它小心，不如给它能自己检查的工具。

反馈闭环：差的反馈是 `Lint failed`，Agent 不知道错在哪；好的反馈是 `File: x.ts:42, use logger.info instead of console.log`，直接指出文件、行号和改法。反馈越具体，下一轮修正越快。

独立验证：Agent 自己说「done」不算数，必须由外部测试或 fixture 判定。典型做法是把输入和期望输出存成文件，每次跑 `xtask verify-cc-parity` 之类的命令自动 diff，通过才允许宣称完成。

### 协作类：人留在环上

可观测性：记录 Agent 读了哪些文件、调了哪些工具、哪些测试反复挂。这些日志是改进 harness 的唯一依据，没有它，所有优化都是猜。

上下文系统：CLAUDE.md / AGENTS.md 不是堆文档，而是指向结构化资料的地图。告诉 Agent 去哪找信息，而不是把所有信息塞进 prompt。

人机协作 Gate：formatter 这类低风险操作自动过；API change、DB migration 必须人工 review。Gate 按风险分级，把人的注意力留给真正危险的操作。

## 最小可行版本：不用上全家桶

九维度听起来很多，起步只需要四样东西：

```text
repo/
├── AGENTS.md                 # 100-200 行，agent 工作入口
├── .docs/{architecture,style,testing,domain}.md
├── scripts/check-agent-work.sh   # lint + typecheck + test + build
└── .github/workflows/ci.yml
```

AGENTS.md 里最关键的一句话：

> Before claiming the task is complete, run `./scripts/check-agent-work.sh`.
> Do not mark complete until all checks pass.

把「完成」的定义交给脚本，而不是交给 Agent 的自我感觉。这就是独立验证维度的最小落地。

## 一个真实证据：Anthropic 的 C 编译器项目

Anthropic 用一群并行的 Claude 写 C 编译器，3982 个 commit 几乎全部由 Claude 完成。这个项目证明了：**harness 的质量，决定了 agent 自主性的上限**。测试足够严、fixture 足够全、回退路径足够明确，Claude 就能跑几千个 commit 不翻车。

反过来看，如果反馈含糊、验证缺失，Agent 会在第一轮就开始积累错误。harness 不是锦上添花，而是自主性的地基。

## 它不限于代码仓库

同样的思路能落在个人知识库上，每个元素都能对上号：

- AGENTS.md / CLAUDE.md = 任务边界 + 上下文入口
- skills 目录（`.agents/skills/<name>/SKILL.md`）= 可复用流程
- 健康报告（`.wiki/HEALTH.md`）= 可观测性
- Git 提交前检查 = 硬约束
- 知识库增强边界 = 权限与破坏半径

任何需要 Agent 长期稳定干活的环境，都可以套这套框架。

## 小结

Harness Engineering 的答案不是更聪明的模型，而是把模型放进一个可信的环境。任务边界、硬约束、独立验证、可观测性、人机 Gate，每一样都是把「信任」变成工程手段。

从 prompt 到 harness，本质是视角的转变：别再问「怎么让模型更听话」，改问「怎么让环境不许它乱来」。

## 延伸阅读

- Birgitta Böckeler（Thoughtworks）：[Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html)
- Augment Code：[Harness Engineering for AI Coding Agents](https://www.augmentcode.com/guides/harness-engineering-ai-coding-agents)
- Milvus Blog：[What Is Harness Engineering for AI Agents?](https://milvus.io/blog/harness-engineering-ai-agents.md)
- Anthropic：[Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler)
