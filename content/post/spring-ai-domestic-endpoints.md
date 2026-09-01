---
title: "Spring AI 接国产大模型兼容端点的踩坑实录"
description: "Spring AI 接国产大模型 OpenAI 兼容端点时，默认拼 /v1/ 路径导致 404、chat 与 embedding 分供应商、embedding 单次上限与维度默认值、local profile 失效四个真实踩坑，逐一给出 yaml 配置解法，附可验证的成本账。"
date: 2026-09-01
tags: ["Spring AI", "智谱", "DeepSeek"]
categories: ["AI 工程"]
---

# Spring AI 接国产大模型兼容端点的踩坑实录

## 背景：OpenAI 兼容，不等于配置兼容

做 RAG 问答服务时，我接了两家国产大模型的 OpenAI 兼容接口：chat 用 DeepSeek，embedding 用智谱。Spring AI 对这类服务的接入方式很简单——配好 base-url 和 api-key。

第一步就翻车了。Spring AI 默认在 base-url 后面拼 `/v1/`，智谱的端点路径是 `/api/paas/v4/...`，直接配 base-url 返回 404。

兼容只保证请求格式相似：路径结构、参数上限、维度默认值全是各家自己的规则。这篇按「机制 → 现象 → 解法」记录四个真实踩过的坑，是上一篇 [RAG 项目复盘](/post/java-rag-project-review/) 的集成细节补充。

## 坑一：自动拼 /v1/，智谱返回 404

Spring AI 的 OpenAI 客户端默认请求 `{base-url}/v1/chat/completions` 和 `{base-url}/v1/embeddings`。智谱端点是 `https://open.bigmodel.cn/api/paas/v4/...`，路径结构里没有 `/v1/`。

把 base-url 直接配成 `https://open.bigmodel.cn`，请求会打到不存在的 `/v1/` 路径，返回 404。

解法是拆两段配：base-url 只指到路径结构起点 `/api/paas`，具体路径用属性显式覆盖。

```yaml
spring:
  ai:
    openai:
      base-url: https://open.bigmodel.cn/api/paas
      chat:
        completions-path: /v4/chat/completions
      embedding:
        embeddings-path: /v4/embeddings
```

chat 和 embedding 的 path 要分别配。只改 base-url 不动 path，embedding 一样 404。

## 坑二：chat 和 embedding 分属两家供应商

选型时本机无法直连 OpenAI，也没有 DashScope 的 key，最终用了智谱 GLM key，实测 chat 和 embedding 都返回 200。

但 chat 也放智谱不划算：即使 `glm-4-flash` 有免费档，`deepseek-chat` 在价格和中文质量上更合适。于是 chat 切到 DeepSeek，embedding 留在智谱。

切不动的原因是个硬约束：DeepSeek 官方 API 只有 chat 模型，没有 embedding 模型和 `/embeddings` 端点。RAG 的向量化只能交给智谱。最终组合是「DeepSeek 出答案、智谱出向量」。

Spring AI 支持这种拆分：`spring.ai.openai.chat.*` 与 `spring.ai.openai.embedding.*` 两组前缀独立，base-url、api-key、模型名各配各的。

```yaml
spring:
  ai:
    openai:
      chat:
        base-url: <DeepSeek 的兼容端点>
        api-key: ${DEEPSEEK_API_KEY}
        options:
          model: deepseek-chat
      embedding:
        base-url: https://open.bigmodel.cn/api/paas
        api-key: ${ZHIPU_API_KEY}
        embeddings-path: /v4/embeddings
        options:
          model: embedding-3
          dimensions: 1024
```

key 只放 `application-local.yml`（git 忽略），不入远端。前缀独立意味着换供应商时切换成本几乎为零。

## 坑三：embedding 的单次上限和维度默认值

智谱 `embedding-3` 有两个坑，都在全量索引时暴露。

第一，单次 input 上限 64 条，Spring AI 把一批 chunk 一次性传过去就报 400。处理：分批入库，每批 50 条。

第二，默认维度是 2048，而 pgvector 表按 1024 维建的，插入时报 `expected 1024, not 2048`。处理：显式配置 `embedding.options.dimensions: 1024`，让请求和表结构一致。

兼容端点只保证协议格式兼容，参数上限和默认值各家不同。建表前先查默认维度，入库前先查接口上限，能省两轮调试。

## 坑四：key 放在 local profile，不激活就不加载

API key 放 `application-local.yml`。不激活 `local` profile 就不加载这个文件，启动直接报 `OpenAI API key must be set`。

注意报错文案是 OpenAI——兼容端点走的就是 OpenAI 客户端，容易误判成 key 配错，实际是 profile 没激活。

处理：启动和重建索引的命令都带 profile。

```bash
export SPRING_PROFILES_ACTIVE=local
mvn spring-boot:run
```

测试期还有一个「假故障」：中文请求体必须 UTF-8 编码，否则乱码导致检索失败，一度以为是检索逻辑写错了。

## 小结

四个坑串起来看就一句话：接口兼容只解决了「请求长得像」，路径结构、批量上限、维度默认值、profile 加载都是各家自己的规则。

配置层面，双供应商组合落地靠两组独立前缀，chat 和 embedding 互不干扰。

成本账公开可验证：全量索引 5624 个 chunk、约 170 万 token，智谱 `embedding-3` 约 0.5 元/百万 token，一次全量索引不到 1 元；`deepseek-chat` 输入约 1 元/百万 token、输出约 8 元/百万 token，日常问答用量极小。

排查顺序建议：先看真实请求 URL 拼得对不对，再查各家接口文档的上限和默认值，最后核对 profile 环境。官方入口：[智谱开放平台](https://open.bigmodel.cn/)、[DeepSeek 开放平台](https://platform.deepseek.com/)。
