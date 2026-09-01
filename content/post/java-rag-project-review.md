---
title: "从 0 到 1：把个人知识库做成 RAG 问答服务"
description: "用 Spring Boot 3 + Spring AI + pgvector 把 400 多篇 Obsidian 笔记变成可问答的知识服务。复盘结构化切分、混合检索与 RRF 融合、防幻觉设计，以及真实踩过的坑。"
date: 2026-09-01
tags: ["RAG", "Java", "Spring Boot", "pgvector", "项目复盘"]
categories: ["项目复盘"]
---

# 从 0 到 1：把个人知识库做成 RAG 问答服务

## 为什么做这个项目

我平时用 Obsidian 维护个人技术知识库，`domain/` 下有 421 篇 Markdown 笔记，覆盖 Java、Spring、数据库、AI 等主题，每篇都带 frontmatter 元数据和标题层级。

笔记越攒越多，问题出现了：grep 和全文搜索只能按关键词命中，找不到语义相关的内容。比如搜「数据库锁」，找不到讲「并发控制」的笔记。标题和正文措辞不一样，关键词就断了。

目标很明确：做一个 RAG 问答服务，用自然语言提问，返回带引用来源的回答。回答能精确到「哪篇笔记、哪个章节」。

## 整体架构

一句话：Spring Boot 3 + Spring AI 1.1，把笔记结构化切分后 embedding 进 PostgreSQL pgvector，问答时用**向量检索 + 关键词检索双路召回、RRF 融合**，拼 RAG prompt 交给大模型生成，回答强制带 `[来源N]` 引用。

```text
离线索引：
domain/**/*.md → MarkdownChunker(标题栈) → embedding → pgvector

在线问答：
用户提问 → 混合检索(向量+关键词) → RRF 融合 → RAG prompt → LLM → 带引用回答
```

两个模型各司其职：embedding 用智谱 `embedding-3`（1024 维），chat 用 DeepSeek `deepseek-chat`。为什么拆开，后面复盘部分细说。

## 三个关键设计

### 1. 结构化切分：MarkdownChunker

固定长度切分（按字符硬切）会切断标题和内容的归属，检索命中后不知道是哪一章的。我写了一个结构感知的切分器：

- 解析 frontmatter 作为 chunk 元数据（tags、maturity），可用于检索过滤
- 维护标题栈生成 `titlePath`（如 `RAG > 核心流程`），内容归属最近的标题
- 超长块在段落边界二次切分，带 100 字符 overlap，避免切断语义

参数：`maxCharsPerChunk=1500`，`overlap=100`。纯 JDK 实现，不依赖第三方，单测覆盖 frontmatter 提取、标题归属、超长切分三个用例。

好处是引用能精确到「笔记 > 章节」，回答可追溯、可核验。

### 2. 混合检索 + RRF 融合

纯向量检索的短板：精确术语（类名、API、报错信息）在向量空间里容易被语义稀释，中文 embedding 对专业缩写不敏感。所以做了双路召回：

- 向量路：pgvector 余弦相似度，topK=6
- 关键词路：pg_trgm 相似度 + ILIKE，topK=12
- RRF 融合：`score = Σ 1/(k + rank)`，k=60，融合后取 top 6

RRF 的关键认知：**不比较两路的原始分数，只比较排名位置**。向量余弦相似度和 pg_trgm similarity 量纲不同，直接加权没有意义；而排名位置是可比的——文档在两路都靠前，融合分就高。实现是纯函数 `RrfMerger`，单测覆盖融合排序和边界。

另外，pg_trgm 是字符三元组，对中文按字切分天然生效，不需要分词插件，这是选它的原因之一。

### 3. 防幻觉设计

System prompt 三条硬规定：

1. 只能基于参考资料回答
2. 回答用 `[来源N]` 标注出处
3. 参考资料不足时明确回答「知识库中没有相关内容」

检索空结果时不硬答，直接拒绝。回答接口返回 `{answer, citations[]}`，citations 带来源文件路径和 titlePath。

诚实边界：这是工程约束，不是模型保证。所以预留了后续用 RAGAS 评估的扩展点，不夸大效果。

## 实测数据

| 指标 | 数值 |
|---|---|
| 扫描文件 | 421 篇 |
| 生成 chunk | 5624 个（含元数据 + titlePath） |
| 全量索引耗时 | 约 1 分钟 |
| embedding 全量成本 | < 1 元（约 170 万 token） |
| 隐私检查 | `private/` 等目录 0 泄露 |

端到端验证三个典型场景：

- 有依据回答：「什么是 RAG？」→ 精准命中多篇笔记，回答带 `[来源1][来源3]`
- 跨笔记综合：「synchronized 和 ReentrantLock 的区别」→ 从多篇并发笔记综合回答
- 越界拒绝：「如何造永动机」→ 明确回答知识库中没有相关内容，不幻觉

## 踩过的坑

### 国产 OpenAI 兼容端点的路径坑

Spring AI 默认假设 OpenAI 的路径结构，会自动拼 `/v1/...`。智谱的端点是 `open.bigmodel.cn/api/paas/v4/`，直接配 base-url 会 404。处理方式：base-url 配到 `/api/paas`，显式覆盖 `chat.completions-path=/v4/chat/completions` 和 `embedding.embeddings-path=/v4/embeddings`。

接国产兼容服务时，这个路径问题很常见，生产环境里也会遇到。

### 框架抽象 ≠ 文档一致

计划代码基于 Spring AI 1.1 稳定 API 编写，实际仍有两处差异：

- `Document.getContent()` 不存在，用 `getText()`
- `VectorStore.get(ids)` 接口没有，改为向量路大 topK 回取后按融合 id 组装

结论：依赖版本 API 要以实际编译为准，先跑通最小闭环，再全量实现。

### 智谱 embedding-3 的两个坑

- 单次 input 上限 64 条，一次传全部会报 400，分批 50 条入库
- 默认 2048 维，pgvector 表建的是 1024 维，报 `expected 1024, not 2048`，需显式配置 `dimensions: 1024`

### 网络环境决定选型

本机无法直连 OpenAI，也没有 DashScope 的 key，最终选了已有的智谱 GLM key（OpenAI 兼容，切换成本几乎为零）。后来 chat 又切到 DeepSeek：成本更低、中文质量好；embedding 保留智谱，因为 DeepSeek 官方 API 没有 embedding 模型，这是硬约束。

选型故事里最有说服力的是：接口兼容让供应商切换的成本趋近于零。

### 其他小坑

- Docker 无法直连 docker.io，镜像改用 DaoCloud 加速源
- 中文请求体编码：curl 必须 UTF-8（`--data-binary @file.json`），否则中文乱码导致检索失败——测试期最大的「假故障」
- API key 放 `application-local.yml`，必须激活 `SPRING_PROFILES_ACTIVE=local` 才加载

## 后续方向

- **增量同步**：当前是全量幂等重建。笔记更新频率低所以够用；后续按文件 mtime/hash 检测变更，只对变更文件重新切分入库
- **RAGAS 评估**：检索侧看 Context Precision/Recall、MRR；生成侧看 Faithfulness、Answer Relevance。交叉诊断：Recall 高 + Faithfulness 低 → 收紧 prompt；Recall 低 → 换 embedding 或调 chunk

## 小结

这个项目用真实需求驱动：知识库检索痛点 → 混合检索方案 → 端到端可验证。全量索引成本不到 1 元，验证了个人规模 RAG 的可行性。

最大的收获不是架构，而是处理第三方 API 兼容、框架版本差异、网络环境约束这些问题的过程。这些细节在面试和实际交付里最容易见高下。
