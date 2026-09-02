---
title: "用 /loop 让 AI 定时自己干活：状态文件驱动的 Agent 自动化"
description: "用公众号监控案例拆解 Claude Code /loop：本质是 cron + prompt，定时唤醒 agent 读取状态文件、按当前情况决策。覆盖状态文件设计、错误分类与重试策略，让定时任务可恢复、可观测。"
date: 2026-09-01
tags: ["Claude Code", "Loop", "自动化"]
categories: ["AI 工程"]
---

# 用 /loop 让 AI 定时自己干活：状态文件驱动的 Agent 自动化

## 定时任务的老问题

脚本化的定时任务有两个老毛病。

一是错误处理硬编码。cron 脚本遇到没预见到的返回值，要么重试到死，要么直接挂掉。

二是失败静默。任务挂了通常没人知道，人往往是第二天才从日志里发现。

监控类任务尤其明显：任务本身不复杂，复杂的是「什么时候该重试、什么时候该停、什么时候该喊人」。这些判断写死在脚本里，改一次需求就得改一次代码。

Claude Code 的 `/loop` 换了一种思路：定时唤醒一个 agent，让它在每次唤醒时自己判断该做什么。

## /loop 的本质：cron + prompt

`/loop 30m <prompt>`，30 分钟唤醒一次，每次都执行同一段 prompt。调度器本身做的是件「蠢事」：

```text
/loop 30m <prompt>
  → 解析 interval=30m → cron="*/30 * * * *"
  → 创建定时任务（recurring=true）
  → 立刻执行一次 prompt（不等第一个 tick）
  → 之后每秒检查一次
  → 到期 → 把 prompt 注入消息队列 → agent 开始新的一轮
```

关键认知：**/loop 里没有 evaluator，没有任何自动判断「是否达标」的系统组件**。它做的唯一一件事，就是定时唤醒 prompt。

循环的智能全部在 prompt 里。什么条件下该做事、什么条件下该停、什么条件下该喊人，都由那段 prompt 承载。调度器只负责到点喊人，判断力在 agent 手里。

Claude Code 里 agent 的自动化触发不止这一种：定时触发的 Scheduled Loop、干到达标为止的 Goal Loop、事件驱动的 hooks、spawn 子 agent 并行执行、以及让 LLM 动态编排的 workflow。实际使用会组合，比如每周五定时触发主 agent，分析本周 PR、识别缺失的 skill，再 spawn 多个子 agent，每个子 agent 用 goal loop 验证 skill 可用性。本文聚焦 `/loop` 这一种。

## 状态文件：loop 的记忆

每次唤醒都从零开始，agent 就不知道上一次发生了什么。状态文件解决这个问题：每轮结束把结果写进 `sync_state.json`，下一轮先读它，再基于上一次的结果做增量决策。

```json
{
  "status": "success",
  "last_check_time": "2026-06-24T22:44:00",
  "check_count": 1,
  "articles_synced": 8,
  "known_articles": [
    "一文搞懂！Loop Engineering的进化史和本质",
    "刚刚，全网爆火的Loop Engineering，保姆教程来了！"
  ]
}
```

状态文件是 loop 的记忆。有了它，agent 才能区分「上次一切正常，继续同步」和「上次凭证过期，先做轻量检测」。

## 案例：公众号监控

这个案例来自一篇公开教程，完整演示了 /loop 从设计到运行的全过程（[Loop Engineering 保姆教程](https://mp.weixin.qq.com/s/-zNyfvaPMGAJrKThPRZWkA)）。

场景是监控两个 AI 方向公众号的文章更新：不是刷到了才被动看，而是有更新就知道。工具是基于微信公众平台 API 的文章获取工具，扫码登录获取 token，有效期约 3 天。

### 决策流程

```text
/loop 30m 你是一个公众号文章同步 agent。工作目录是当前目录。
每次被唤醒时执行以下决策流程：
1. 读取 sync_state.json 检查上次状态
   - 上次 token_expired → 先测试 token 是否恢复，未恢复则报告"仍在等待扫码"并退出
   - 上次 success → 继续正常同步
2. 请求两个公众号的最新文章
3. 对比 known_articles，识别新增
4. 根据结果决策：
   - API 返回 ret=200003/invalid session → 标记 token_expired，通知用户扫码，不重试
   - 有新文章 → 更新 sync_state，输出新文章标题
   - 无新文章 → 简短报告"无更新"
5. 更新 sync_state.json（status, last_check_time, known_articles, check_count）
```

### 三轮运行实录

第一轮，正常同步：发现 4 篇新文章，初始化状态文件，token 正常。

第二轮，无更新：输出只有一行「同步结果：无更新」，状态文件只改了 `check_count` 和 `last_check_time`。决策路径最短，token 消耗最低。

第三轮，token 失效：API 返回 `ret=200003 (invalid session)`。agent 判断这是凭证过期，不是内容问题，**不重试**，把状态改为 `token_expired` 并提示重新扫码。下一轮唤醒时先读状态文件，做轻量检测，未恢复就直接跳过，不再空转。

## 踩坑：错误类型决定要不要重试

失败不能一概重试。同样是「执行失败」，要区分两种：

- 内容层面的失败：可重试。比如 API 返回空，可能是临时网络抖动。
- 基础设施层面的失败：不能重试。标记状态、停止重试、通知人。比如 token 过期，重试只会重复失败。

判断是运行时做的：agent 看到未预见的返回值，基于对上下文的理解做出合理决策，不需要在 prompt 里逐一列举所有错误码。这和 cron 脚本的硬编码错误处理有本质区别。

另一个经验：设计 loop 的第一步不是设计 loop 本身，而是先写处理问题的 skill。你得先有解决问题的方法，再谈定时唤醒。

## Loop 与 Cron 的本质区别

| 维度 | Cron 脚本 | /loop |
|---|---|---|
| 错误处理 | 硬编码，遇到未预见错误就挂 | 运行时判断，能区分错误类型 |
| 失败恢复 | 静默失败，人第二天才发现 | 标记状态，下一轮自动检测恢复 |
| 无更新时 | 全量执行完整逻辑 | 最短决策路径，token 消耗极低 |
| 可观测性 | 日志里一行 traceback | 主动通知 + 状态文件可见 |

cron 脚本是「执行指令」，loop 是「执行决策」。每次唤醒，agent 重新判断当前状态该做什么，而不是机械执行预设流程。

## 小结

/loop 的威力不在调度本身，而在「prompt + 状态文件」构成的决策循环：调度器负责唤醒，prompt 负责判断，状态文件负责记忆。

想落地，记住三件事：先写好处理问题的 skill；把状态写进文件，让每一轮都基于上一轮的结果；把失败分类，基础设施问题直接标记并喊人，不要盲目重试。
