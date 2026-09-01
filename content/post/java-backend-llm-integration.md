---
title: "Java 后端集成 LLM 的工程化姿势：分层、降级与 Prompt 管理"
description: "Java 后端接入 LLM 的通用套路：AI 客户端下沉基础设施层、配置环境变量化、System Prompt 文件化管理；再讲 enabled 开关、异常捕获、输出校验三道降级防线，保证 AI 挂了业务不挂。"
date: 2026-09-01
tags: ["Spring Boot", "LLM", "降级"]
categories: ["AI 工程"]
---

# Java 后端集成 LLM 的工程化姿势：分层、降级与 Prompt 管理

## 背景：LLM 进业务系统，先回答三个问题

给业务系统接大语言模型，最常见的误区是把它当成一次普通 HTTP 调用：发请求、拿文本、完事。真正上线后会暴露三个问题：怎么调、调什么、出错了怎么办。

- 怎么调：官方 SDK 还是 HTTP 直连
- 调什么：System Prompt 定角色和输出格式，User Prompt 传业务数据
- 出错了怎么办：AI 超时、限流、返回垃圾内容时，系统靠什么兜底

为什么这三个问题值得单独拎出来？因为 LLM 调用和普通远程调用不一样：响应慢、成本随 token 增长、输出格式不受控，还会编造不存在的用户数据。任何一个环节失控，功能就废了。

下面以抽奖平台的「用户行为 AI 分析」为例展开：把用户的抽奖记录交给 LLM，生成自然语言洞察和建议。案例基于 Java 25 + Spring Boot 3.5 + Spring Cloud 微服务架构，AI 作为独立服务。这套做法不绑定具体业务，可以整体搬走。

## 分层：AI 只活在基础设施层

AI 代码最容易犯的错是到处散落：Controller 里拼 Prompt、Service 里调 SDK、实体里塞 AI 字段。干净的切法是四层职责分离：

```text
Controller       REST / SSE 端点
Application     业务编排、降级决策
Domain          纯业务逻辑（不依赖 AI）
Infrastructure  AI 客户端封装、Prompt 加载、配置管理
```

关键设计原则：AI 在 infrastructure 层，domain 层完全不感知 AI。即使 AI 服务整个挂掉，业务代码也照常编译、照常运行，只是走降级分支。

落到模块上，配置类（Key、模型、温度）集中在 config，AI 客户端封装独立成一个类，Prompt 加载器单独成类。业务层只依赖「一个能产出分析的客户端」，不关心背后是智谱还是别的模型。

这次用的官方 SDK（zai-sdk），选它有三条理由：官方维护、API 变更同步快；Builder 模式构建客户端，代码简洁；内置流式支持，不用手动处理 SSE。

## 配置：全部环境变量化，留一个总开关

AI 相关配置集中在一个 properties 类，前缀 `ai.glm`，每个配置项都带环境变量和默认值：

```yaml
ai:
  glm:
    enabled: ${GLM_ENABLED:true}              # 总开关：运行时一键关停
    api-key: ${GLM_API_KEY:your-key-here}     # 密钥走环境变量，不进代码仓库
    model: ${GLM_MODEL:glm-5.1}               # 模型名，可随时切换
    temperature: ${GLM_TEMPERATURE:0.6}
    max-tokens: ${GLM_MAX_TOKENS:1024}        # 控制单次成本
    connect-timeout: ${GLM_CONNECT_TIMEOUT:PT5S}
    read-timeout: ${GLM_READ_TIMEOUT:PT60S}
```

几点设计意图：

- `enabled` 是总开关，出问题可一键关停 AI，不用重启、不用改代码
- API Key 通过 `${GLM_API_KEY:...}` 注入，生产环境从配置中心或 Secret 挂载
- 每个配置都有默认值，本地开发零配置就能跑
- Prompt 文件路径也进配置，方便运维热更新

## AI 客户端封装：调用、解析、校验三段式

AI 客户端是核心封装，做三件事：构建请求、解析响应、校验输出。

构建请求就是拼消息，System 定角色和格式，User 传业务数据：

```java
ChatCompletionCreateParams request = ChatCompletionCreateParams.builder()
        .model(glmProperties.getModel())
        .messages(List.of(
            systemMessage(systemPromptProvider.loadSystemPrompt()),
            userMessage(buildUserPrompt(metrics, focus))
        ))
        .temperature(glmProperties.getTemperature())
        .maxTokens(glmProperties.getMaxTokens())
        .build();
```

LLM 返回的是纯文本，即使要求输出 JSON，也常带 ```json 包裹和解释文字，解析必须自己兜：

```java
String trimmed = content.trim();
int start = trimmed.indexOf('{');
int end = trimmed.lastIndexOf('}');
JsonNode node = objectMapper.readTree(trimmed.substring(start, end + 1));
```

解析完还要校验。LLM 可能照抄 Prompt 模板，返回占位符而不是真实内容：

```java
// 检测到占位符就抛异常，触发降级
if (overview.equals("80-140字中文摘要")
        || insights.contains("洞察 1")) {
    throw new BusinessException("GLM response still contains schema placeholders");
}
```

这条规则叫「不信任 LLM 输出」，检测到占位符就抛异常，交给降级逻辑处理。

流式场景同理：用 SSE 端点逐步推送文本，实现上用 `SseEmitter(0L)` 不限制超时，`CompletableFuture.runAsync()` 异步执行避免阻塞主线程，配虚拟线程支持。

## System Prompt 管理：文件化，不硬编码

Prompt 不该硬编码在 Java 字符串里，而是放在独立的 `.md` 文件，用加载器读取：

```java
public String loadSystemPrompt() {
    if (location.startsWith("classpath:")) {
        Resource resource = resourceLoader.getResource(location);
        try (InputStream is = resource.getInputStream()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
    return Files.readString(Path.of(location), StandardCharsets.UTF_8);
}
```

好处是实打实的：

- 可热更新：配 `file:` 协议后改 Prompt 不用重新编译部署
- 版本管理：Prompt 和代码一起进 Git，可 review、可回溯
- 多人协作：非开发人员也能直接编辑 `.md` 调 Prompt
- 可测试：准备多套 Prompt 做 A/B 对比

写 Prompt 有固定套路：先定义角色，再约束输出格式（严格 JSON、禁止 Markdown 和解释文字），给每个字段注明类型和长度要求，最后加行为规则——禁止编造事实、优先关注点、不要复述模板。最后一条「不要复述字段模板，请填充最终分析内容」是防占位符的关键，配合上面的占位符校验，双保险。

## 降级：三道防线，AI 挂了业务不挂

降级是整个设计里最值钱的部分，一共三层防线：

```text
第一层：enabled 开关     → AI 关闭时走降级
第二层：SDK 异常 catch   → 超时 / 限流 / 网络错误时降级
第三层：响应校验         → LLM 输出不合法时降级
```

业务层先查数据、本地算指标，再决定是否调 AI：

```java
// 先本地计算指标，不依赖 AI
LotteryUserAnalysisMetrics metrics = buildMetrics(userId, records);
LotteryUserAnalysisResponse fallback = buildFallbackResponse(metrics);

// AI 关闭 → 直接降级
if (!glmChatClient.isEnabled()) {
    return fallback;
}

// AI 异常 → 同样降级
try {
    GlmNarrative narrative = glmChatClient.generateNarrative(metrics, request.focus());
    return new LotteryUserAnalysisResponse(userId, "AI_GENERATED", modelName,
            narrative.overview(), narrative.insights(), narrative.suggestions(),
            metrics, LocalDateTime.now());
} catch (BusinessException ex) {
    log.warn("Falling back to local analysis: {}", ex.getMessage());
    return fallback;
}
```

降级方案用规则引擎生成结构化文本，模板加数据拼出来：

```java
"近 30 天趋势为 %s，说明近期参与度%s。".formatted(
        metrics.trendSummary(),
        metrics.recent30DayDrawCount() >= metrics.previous30DayDrawCount()
                ? "保持稳定或有所提升" : "有所回落"
)
```

同样的套路再拼出「当前最高命中奖项层级」「命中频次最高的奖品和时段」等洞察，全部由本地指标直接算出，不经过 LLM。

降级输出不够「聪明」，但保证任何情况下都有可用结果。三个原则：输出结构和 AI 完全一致（同一个 DTO）、带明显标识（如 `status: "FALLBACK"`）让调用方感知、记日志方便排查失败原因。

## SDK 还是 HTTP 直连

有官方 SDK 优先用：Builder 模式、内置反序列化和流式监听，开发效率高。没有 SDK 或 SDK 不成熟时，用 OkHttp / WebClient 直连 OpenAI 兼容端点——[智谱](https://open.bigmodel.cn/)、DeepSeek、Moonshot 都提供，切换成本低。SDK 的代价是大版本升级可能不兼容，直连则要自己维护 JSON 和 SSE 解析。

如果不想手写这些，也可以直接上 [Spring AI](https://spring.io/projects/spring-ai) 这样的官方集成框架，但分层和降级的思路不变。

## 常见陷阱

| 陷阱 | 表现 | 解法 |
|------|------|------|
| LLM 超时 | 请求超过 30s 未返回 | 设 read-timeout，超时降级 |
| Token 超限 | 返回被截断的 JSON | 限 max-tokens + 校验 JSON 完整性 |
| 占位符输出 | 返回「洞察 1」而非真实内容 | 校验残留模板文字 |
| 费用失控 | 调用量激增 | 限 max-tokens + 相同输入加缓存 |
| JSON 格式错误 | 缺引号、多注释 | 容错解析或让模型严格输出 |
| Prompt 泄漏 | 用户输入覆盖 System Prompt | 清洗输入 + 防御指令 |

## 小结

接 LLM 的工程化核心就三条：AI 隔离在基础设施层、配置全部可开关、降级永远有兜底。Prompt 文件化是配套工程，让调优从改代码变成改文档。

这套模式在抽奖平台里跑通了：AI 挂了用户照样拿到分析结果，只是措辞从「智能体」变成「规则引擎」。对业务系统来说，可用性永远优先于智能。
