---
title: "MCP 传输方式选型：stdio / SSE / Streamable HTTP 一篇讲清"
description: "一文讲清 MCP 三种传输方式：stdio 适合本地工具、SSE 已弃用、Streamable HTTP 是远程服务新标准。附选型决策树与常见接入失败排查思路。"
date: 2026-09-01
tags: ["MCP", "stdio", "SSE"]
categories: ["AI 工程"]
---

# MCP 传输方式选型：stdio / SSE / Streamable HTTP 一篇讲清

## 为什么传输方式值得单独讲

MCP（Model Context Protocol）是 AI 客户端与工具之间的标准协议。传输方式决定了一个 MCP Server 能跑在哪、怎么部署、怎么调试：本地进程间管道，还是走网络的 HTTP 请求。选型不只是选协议，也是在选部署形态和可扩展性。

选错传输方式最直接的后果是接不上：报错五花八门，排查半天，最后发现是客户端和服务端支持的传输版本不一致，而不是实现有 Bug。这篇文章梳理三种传输方式的机制、适用场景和常见问题。

## 现状：三种传输，两个时代

MCP 现行基础规范定义 stdio 和 Streamable HTTP 两种标准传输；旧版 HTTP + SSE 已弃用，但客户端和服务端仍可为兼容旧实现继续支持。三者状态如下：

| 传输方式 | 状态 | 适用场景 |
|---|---|---|
| stdio | 稳定，最常用 | 本地进程，同机运行 |
| HTTP + SSE | 已弃用 | 远程服务器，仅用于兼容旧实现 |
| Streamable HTTP | 规范当前推荐 | 远程服务器，新版标准 |

## stdio：本地工具的默认选择

stdio 是 MCP 最早也是最简单的传输方式。AI 客户端直接启动一个子进程，通过标准输入（stdin）发送 JSON-RPC 消息，从标准输出（stdout）读取响应，stderr 只写日志、不影响通信。

```text
AI 客户端                    MCP Server（子进程）
    │                              │
    │── JSON-RPC (stdin) ────────► │
    │◄── JSON-RPC (stdout) ────────│
    │                              │
    │    stderr → 日志（不影响通信）  │
```

优点很直接：零依赖，不需要 HTTP 服务器、端口和网络；启动即用，进程退出即断开；不暴露网络端口，没有远程攻击面；进程间管道通信，延迟最低。

缺点同样明显：Server 必须在同一台机器上；进程跟随客户端启动和退出，生命周期耦合；每个客户端启动一个独占进程，不能横向扩展。

本地安装的工具类 MCP Server 绝大多数走 stdio，例如 headroom、codegraph、playwright 这类本地工具。典型配置如下：

```text
{
  "headroom": {
    "command": "headroom",
    "args": ["mcp", "serve"]
  }
}
```

配置里的 command 和 args 就是要启动的子进程命令，客户端负责拉起进程，进程退出即断开。

## SSE：第一个远程方案，已被取代

SSE（Server-Sent Events）是 MCP 的第一个远程传输方案。它用 HTTP 建立连接，但通信模式不是常规的请求-响应，而是需要两条连接。

```text
AI 客户端                          MCP Server
    │                                  │
    │── GET /sse (建立 SSE 流) ──────► │  ① 客户端先发起 SSE 订阅
    │◄── endpoint: /message ───────────│  ② 服务器回复消息端点 URL
    │                                  │
    │── POST /message (发送请求) ────► │  ③ 客户端发请求
    │◄── SSE 事件 (接收响应) ──────────│  ④ 服务器通过 SSE 流推送响应
```

流程是固定的四步：客户端 GET `/sse` 订阅流；服务器保持连接长期打开，返回消息端点 `endpoint: /message`；客户端 POST 到 `/message` 发送 JSON-RPC 请求；服务器经已建立的 SSE 连接推送响应。

它的配置形如 type 标为 sse、url 指向 /sse 端点，与 stdio 的 command 形式完全不同。

这条链路的先天不足是它被取代的原因：两条连接管理复杂；半双工，服务器只能单向推送，客户端发请求必须走 POST；受 HTTP 1.1 同域名并发连接数限制；SSE 断开后要客户端自己处理重连；不同实现的端点路径、心跳机制不统一。

它原本用于远程 MCP Server，比如 JetBrains IDE 集成、OfficeMCP 的 SSE 模式，现在逐步被 Streamable HTTP 取代。

## Streamable HTTP：远程服务的当前标准

MCP 规范在 2025 年推出 Streamable HTTP，用来替代旧版 HTTP + SSE。它以 HTTP POST 为核心：服务端可用普通 JSON 响应，也可用 SSE 流式响应，并按规范提供 GET 端点用于服务端消息流。

变化在于：请求与响应可以在一次 HTTP POST 交换内完成，不再强制使用旧版固定的 `/sse` + `/message` 双端点模型。需要服务端主动推送消息时，仍可能建立独立的 GET SSE 流。

与旧 SSE 对比：

| 维度 | SSE（旧） | Streamable HTTP（新） |
|---|---|---|
| 连接模型 | 固定 SSE 长连接 + POST | POST 为核心，按需使用 SSE 流 |
| 负载均衡 | 困难（长连接） | 简单（无状态 HTTP） |
| 调试 | 需要 SSE 工具 | curl / Postman 即可 |

标准 HTTP 带来的好处是连锁的：无状态 HTTP 让负载均衡变简单，重连由 HTTP 天然支持，普通 HTTP 即可过防火墙，调试直接用 curl。远程新开发的服务应优先选它，它同样适合微服务架构中的 MCP 集成和需要负载均衡的场景。

```text
{
  "my-server": {
    "type": "http",
    "url": "http://127.0.0.1:8080/mcp"
  }
}
```

## 选型决策树

一句话版本：本地用 stdio，远程用 Streamable HTTP，工具固定了传输方式就按工具文档配置。整个决策树只围绕一个问题展开：Server 跑在哪、支持哪些协议。

```text
你的 MCP Server 要跑在哪？
│
├── 本地，和 AI 客户端同一台机器
│   └──→ stdio（最简单，性能最好）
│
├── 远程服务器
│   ├── Server 支持 Streamable HTTP？
│   │   ├── 是 → Streamable HTTP（推荐）
│   │   └── 否 → SSE（兼容旧服务）
│
└── 工具本身固定了传输方式（如 JetBrains IDE）
    └── 按工具文档配置
```

## 两个高频坑

第一个坑是「老版 SSE」这个说法。它指旧版 HTTP + SSE 传输，不是说 SSE 这种流式响应格式本身被禁止。现行 Streamable HTTP 仍可在响应中使用 SSE，别一听 SSE 就当成过时实现。

第二个坑是传输版本不匹配。实际场景：JetBrains IDE 的 MCP Server 只提供旧版 SSE 接口，而当时使用的 AI 客户端不支持该旧传输，导致 WebStorm、IntelliJ 无法接入。同期 headroom、chrome-devtools、wps-office 等本地工具走 stdio 一切正常，唯独 IDE 集成失败，问题全出在 SSE 上。这类错误通常是客户端与服务端支持的传输版本不一致，不一定是实现 Bug。再遇到时先核对双方当前文档和实际端点，别急着改代码。

## 小结

MCP 协议演进可以浓缩成一条时间线：2016 年 LSP 诞生（JSON-RPC + stdio）→ 2024 年 11 月 MCP 规范 v1 发布，支持 stdio + SSE → 2025 年 3 月引入 Streamable HTTP，标记 SSE 为 deprecated。现在两种现行标准传输与旧版兼容传输共存，新实现优先选 Streamable HTTP。

落到选型只有三条：自己开发 MCP Server，新项目直接用 Streamable HTTP；遇到 SSE 报错，先检查工具是否支持该传输方式；本地工具始终优先 stdio。

协议仍在演进，选型不是一劳永逸。判断标准始终是客户端和服务端各自支持什么，在交集里选更新的那一个。

官方资料：[MCP 2025-06-18 传输规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
