---
title: "DeepSeek Harness 拆解：一个 Java 后端的视角"
description: "从 Java 后端视角拆解 DeepSeek 官方开源的插件式 Agent 运行时：一切皆插件、16+ 可替换接缝、Session Log 的 WAL 式设计，并用 Spring 类比讲清架构与选型信号。"
date: 2026-09-01
tags: ["Agent 运行时", "插件化", "Java"]
categories: ["AI 工程"]
---

# DeepSeek Harness 拆解：一个 Java 后端的视角

## 为什么关注一个 Agent 运行时

模型能力在快速逼近，但决定 Agent 上限的不只是模型。同一个模型放在不同的运行外壳里，自主性可以差很远——harness 质量决定 agent 自主性上限。

2026-08-13，DeepSeek 在 V4 Pro 转正的同时开源了 DeepSeek Harness（v0.1，MIT 协议，npm 包 `@deepseek-ai/dsh`），底层是元框架 Cordis。作为一个长期写 Java 的人，我拆解它的方式是找类比：它和 Spring 是什么关系？和 LangChain、Spring AI 的边界在哪？

## 一切皆插件：Cordis 是 Agent 版的 Spring

官方定位一句话：模型之外的 Agent 运行外壳。模型接入、工具、日志、主循环、沙箱、审批、UI，所有能力都是插件。

对 Java 开发者来说，Cordis 可以类比为 Spring IoC 容器加 SPI：负责插件的注册、生命周期、依赖注入与销毁，支持热插拔。

4 类核心插件：

- **LLM 适配器**：对接模型，OpenAI / Anthropic 双协议兼容
- **Tool 注册**：文件、Shell、LSP、Web 等工具按插件注册
- **Session Log**：仅追加日志，类比数据库 WAL
- **Agent Loop**：主循环本身可替换，默认循环之外可挂自定义循环

连主循环都是插件：模型怎么思考、怎么编排步骤，这套逻辑可以被整体替换。

## seam 接缝：可替换的 16+ 个接口

框架预留了 16+ 个可替换接缝（seam）：`llm` / `fs` / `shell` / `subprocess` / `sandbox` / `approval` / `codeRuntime` / `subagents` / `workflowEngine` / `lsp` / `web` / `compaction`。

换一个接缝的提供方，就改变产品行为。Java 开发者很熟：`javax.sql.DataSource` 是接口，HikariCP、Druid 是可插拔实现，业务代码不感知切换。

seam 的意义在于：运行时只定义接缝在哪，不定义接缝里是什么。命令执行、文件访问、审批这些高风险能力，都可以换提供方，不必改框架。

## Session Log：Agent 版的 WAL

Session Log 只做追加写，类比数据库 WAL（Write-Ahead Log），三个收益：

- **崩溃后可恢复**：进程挂了，会话可从日志重建
- **可回放**：复现 Agent 的完整决策过程
- **可审计**：每一步操作都有记录

追加写还有一个工程红利：没有随机写、没有锁竞争，写入路径简单可靠。

## 运行形态与预设模式

6 种运行形态：`dsh web`（Web GUI，默认 127.0.0.1:3080）、TUI、Headless（CI/CD 无界面执行）、ACP（Agent Client Protocol）、JSON-RPC、Python SDK。同一个运行时，从交互式开发到无人值守流水线都能覆盖。

4 种预设模式对应 4 份 YAML 配置：

- **Standard**：默认完整能力
- **PTC**：Code Mode SDK，写 TypeScript 程序，一次 `run_code` 组合多步操作
- **Minimal**：仅 Bash + str_replace_editor，benchmark 场景用（V4 Flash 基准即此模式）
- **Cordis**：创造模式，允许 Agent 改装自身运行时

模式不是代码分支，是配置组合，自定义模式的门槛因此很低。

## 和 LangChain / Spring AI 的边界

| 框架 | 定位 |
|---|---|
| LangChain / LangGraph | 编排层（DAG / 状态机） |
| Spring AI | 集成层 |
| Claude Code / Codex | 产品层，闭源 |
| DeepSeek Harness | 插件化运行时，开源 |

选型时最容易犯的错是拿它们横向对比。编排层解决多步任务怎么组织，集成层解决模型和工具怎么接，运行时解决 Agent 进程怎么搭，产品层解决用户怎么用。定位不同，谈不上替代。

## 与 V4 Pro 的协同，和一个迁移坑

模型与框架正在双向协同。V4 Pro：1.6T MoE、激活约 49B，1M 上下文、最大输出 384K，OpenAI + Anthropic 双协议；DeepSWE 基准从 12.8 升到 62.7。

信号是：只看模型跑分选型的时代过去了，harness 能力要和模型一起评估。

迁移坑：`deepseek-chat` / `deepseek-reasoner` 进入 3 个月过渡期，预计 2026-10 下旬下线。V4 Pro 双协议兼容，OpenAI SDK 接入只需改 model name，切换成本很低；如果线上还在用旧 endpoint 且没预留抽象层，过渡期结束前必须动一次。

## 快速上手

```bash
npm install -g @deepseek-ai/dsh
```

配置文件 `.dsh/config.yaml`；插件即 npm 包加 `definePlugin`。参考资料：

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：官方仓库、文档与插件开发指南
- [dsh-handbook](https://github.com/Electricitysheep/dsh-handbook)：第三方中文深度手册，覆盖安装、插件开发、性能调优与实测对比
- [DeepSeek Harness | AI 原生全景图](https://landscape.jimmysong.io/zh/projects/deepseek-harness/)

## 小结

DeepSeek Harness 的价值不在多了一个 Agent 框架，而在它是 Agent 运行时设计的开源一手案例：一切皆插件、16+ 可替换接缝、WAL 式会话日志、模型与框架协同选型。

对 Java 后端来说，这些设计都能用熟悉的类比快速理解：Cordis 对应 Spring IoC 与 SPI，seam 对应 DataSource 的可插拔实现，Session Log 对应数据库 WAL。理解了接缝在哪，Agent 运行时就从黑盒变成一张可替换部件的结构图。
