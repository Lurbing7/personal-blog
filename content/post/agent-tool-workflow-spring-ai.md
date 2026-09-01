---
title: "Agent、Tool、Workflow 到底什么区别？Spring AI 落地实践"
description: "Tool、Workflow、Agent 常被混用，实为层层递进的三层结构。用 Spring AI 注解、链式 API、工具调用示例讲清三者区别，给出选型建议与防死循环护栏。"
date: 2026-09-01
tags: ["Agent", "Spring AI", "RAG", "LLM"]
categories: ["AI 工程"]
---

# Agent、Tool、Workflow 到底什么区别？Spring AI 落地实践

## 背景：三个词，一个糊涂账

做 LLM 应用绕不开三个词：Agent、Tool、Workflow。面试问、项目评审问、技术文章里也到处是。但很多人把它们当成并列的三个方案来讨论，其实三者是层层递进的关系。

一句话概括：**Tools 是积木，Workflow 是按图纸拼好的流水线，Agent 是会自己看图纸自己拼的工人**。这个辨析思路最早来自一篇公开的[面试真题解析](https://mp.weixin.qq.com/s/EdF_pyb_Ci7BFGXQbRsRoA)。本文用 Spring AI 的代码，把三个概念落到具体 API 上。

## Tools：最小积木

Tool 是 LLM 可以调用的离散函数，本身没有智能，只是一个被动能力单元。它只负责执行具体动作——查数据库、调 API、读文件。什么时候调、调几次、结果怎么处理，是上层的事。

Spring AI 里定义一个 Tool 只需要一个注解：

```java
@Component
public class WeatherTools {

    @Tool(description = "查询指定城市的实时天气信息")
    public String getWeather(String city) {
        return WeatherApi.query(city);
    }

    @Tool(description = "查询指定城市的未来三天天气预报")
    public String getForecast(String city) {
        return WeatherApi.forecast(city, 3);
    }
}
```

一个坑：`description` 字段很关键，它直接决定 LLM 能不能选对工具。写得模糊或者重复，模型就会乱调。

## Workflow：固定编排的流水线

Workflow 是开发者预先设计好代码路径的多步流程。LLM 和 Tools 按写死的步骤一步步走，每一步做什么、结果往哪传，都是确定的。LLM 在里面只负责执行单步任务，不决定流程走向。

Spring AI 用 `ChatClient` 链式 API 实现一个 RAG Workflow：

```java
@Service
public class RagWorkflow {
    private final ChatClient chatClient;
    private final VectorStore vectorStore;

    public String answer(String question) {
        return chatClient.prompt()
            .user(question)
            .advisors(RagAdvisor.build(vectorStore))   // 步骤1：检索
            .call()
            .content();                                 // 步骤2：生成
    }
}
```

流程是写死的。LLM 没有权力决定要不要检索、检索几次、要不要再调一个 Tool。

适用场景：任务路径明确、可预测、对稳定性要求高的场景，比如 RAG 问答、文档抽取、意图路由。

## Agent：LLM 自己当司机

Agent 的核心特征是：LLM 自己决定调什么工具、什么时候调、调几次，靠"感知→思考→行动→观察"的循环往前推进，直到把任务做完。

这就是经典的 ReAct（Reasoning + Acting）循环：

```text
Think → Act → Observe → Think → Act → Observe → ... → Done
```

一句话对比：Workflow 是"直线"，Agent 是"圆环"。

Spring AI 里实现 Agent 的关键是 `defaultTools` 加系统提示词：

```java
@Service
public class ResearchAgent {
    private final ChatClient chatClient;

    public ResearchAgent(ChatClient.Builder builder,
                         WeatherTools weatherTools,
                         SearchTools searchTools) {
        this.chatClient = builder
            .defaultTools(weatherTools, searchTools)   // 配备一组工具
            .build();
    }

    public String research(String task) {
        return chatClient.prompt()
            .system("你是一个研究助手，可以根据任务自主选择工具，反复调用、观察结果、调整策略，直到完成任务。")
            .user(task)
            .call()
            .content();
    }
}
```

注意：开发者不写死任何路径，全部交给 LLM 决策。

适用场景：任务路径不明确、需要自适应推理的场景，比如复杂研究任务、多步骤问题求解、开放式探索。

## 三者关系与认知澄清

三层关系可以这样理解：

```text
第一层 Tools    构建一切的基础，被动能力插件
第二层 Workflow 把多个 Tools 按固定路径串起来，开发者是司机
第三层 Agent    把 Tools 全部交给 LLM，LLM 自己当司机
```

一个重要的认知澄清：**Tools 本身不是 Agent，调用 Tools 的 LLM 也不一定是 Agent**。只有"LLM 自主决策 + 循环执行"同时成立时，才叫 Agent。一次简单的 Function Calling，只要路径是开发者写死的，就仍然只是 Workflow 的一部分。

## 选型：简单胜于复杂

Anthropic 的《[Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)》核心建议是**简单胜于复杂**。选型可以按场景来：

| 场景 | 推荐形态 | 原因 |
|---|---|---|
| 单步任务（查天气、翻译） | 单次 Tool Calling | 杀鸡焉用牛刀 |
| 任务路径明确、步骤固定 | Workflow | 可控、可调试、可监控 |
| 任务路径不明确、需自适应 | Agent | 灵活，能处理开放问题 |
| 对稳定性、成本、延迟敏感 | Workflow | Agent 循环带来不可控的 Token 消耗 |

有个真实教训很能说明问题：某客服系统一开始上了纯 Agent 架构，线上 Token 消耗爆炸、偶发死循环，后来改回 Workflow 加分支路由，稳定性和成本都好很多。

## 生产环境的坑与护栏

Agent 会不会陷入死循环？会。生产环境必须加护栏：

- 限制最大循环次数（`max_iterations`）
- 限制单次任务的 Token 预算
- 对 Tool 调用结果做校验
- 失败 N 次就降级到人工的兜底逻辑

Workflow 和 Agent 能混用吗？能，而且这是 2025 年生产环境的主流形态。典型做法是外层 Workflow 编排、关键决策点交给 Agent。比如 RAG 主流程是 Workflow，但"查询改写"这一步用一个小 Agent 动态决定改写策略——这种模式叫 **"Agent with Guardrails"**。

Anthropic 还总结了 Workflow 的五种模式：Prompt Chaining、Routing、Parallelization、Orchestrator-Workers、Evaluator-Optimizer。

## 小结

记三个关键词：**积木、流水线、当家人**。

- Tools 是积木：被动能力单元
- Workflow 是流水线：人写死路径
- Agent 是当家人：LLM 自己决定路径

换个说法：Workflow 是人开车，Agent 是 LLM 开车，Tools 是车上的零件。判断一个系统是什么形态，只看路径是谁决定的。开发者写死的，是 Workflow；LLM 自主循环推进的，才是 Agent。
