---
title: "从 Java 后端到鸿蒙：零经验造一个 AI 知识库 App"
description: "四年 Java 后端零鸿蒙经验，从生态调研到技术选型，用 ArkTS + ArkUI 造本地 Markdown 知识库 + DeepSeek 问答的鸿蒙 App。复盘四阶段学习路径、命令行构建工具链，以及卡在 zip64 签名的真实坑。"
date: 2026-09-01
tags: ["鸿蒙", "ArkTS", "AI"]
categories: ["项目实践"]
---

# 从 Java 后端到鸿蒙：零经验造一个 AI 知识库 App

## 为什么做这个项目

我是 Java 后端出身，写了四年 Spring Boot。2026 年 8 月冒出个想法：做一个鸿蒙知识库 App，Markdown 笔记存在手机本地，填上 DeepSeek API key 就能对话式整理笔记，再接 GitHub/Gitee 同步，目标上架华为应用市场。

动手前先调研同类软件。鸿蒙上只能 Obsidian 加 MGit 手动同步；DeepSeek 集成都在桌面端（Obsidian 插件、Cherry Studio、思源笔记）；鸿蒙的 AI 客户端只有聊天，没有知识库。结论是「鸿蒙原生 + 本地知识库 + GitHub 联动 + DeepSeek AI」四者齐全的产品是空白。

真正的门槛在技术栈：HarmonyOS NEXT（5.0+ 纯血鸿蒙）已移除 Java API，四年 Java 经验不能直接迁移，必须重新评估语言路线。

## 技术选型：为什么是 ArkTS

调研出三条关键事实：HarmonyOS NEXT 移除了 Java API；Compose Multiplatform / Kotlin Multiplatform 官方不支持鸿蒙；官方语言路线是 ArkTS + ArkUI 与仓颉，Flutter 只有 OpenHarmony 社区的 ohos 分支。

针对「Java 后端、零鸿蒙经验、要上架」三个条件做路线对比：

| 路线 | 学习成本（Java 背景） | 结论 |
|---|---|---|
| ArkTS + ArkUI 原生 | 中，OOP 概念相通，2-4 周可上手 | 推荐 |
| 仓颉 | 中高，新语言 + 新生态 | 观望 |
| Flutter（ohos 分支） | 中高，Dart + 框架 | 备选 |
| React Native / uni-app x | 高，前端技术栈 | 排除 |
| Compose Multiplatform / KMP | 官方无支持 | 排除 |

最终选 ArkTS + ArkUI，理由四条：DevEco Studio 全链路（IDE → 模拟器 → 签名 → AGC 上架），上架审核最稳；类、接口、泛型、继承与 Java 概念相通；MVP 需要的文件、网络、存储都有官方 API；官方课程与社区资料最全。

还专门比过仓颉的性能叙事。官方口径仓颉有 AOT 编译、可调 C/C++，但本应用的性能画像其实是 I/O 密集：网络请求、文件读写、UI 渲染。DeepSeek API 响应几百毫秒到秒级，占绝对大头，与语言无关。

换仓颉的代价是新语言加初期生态，markdown、SSE、JSON 库都少。结论：性能用架构解决，不靠换语言——I/O 全异步、全文搜索建增量索引（FTS 思路）、长列表用 LazyForEach、首屏懒加载。

## MVP 设计

产品分两期：一期「本地知识库 + DeepSeek 问答」，二期 GitHub/Gitee 同步。

一期是 4 页面 + 3 服务层的结构：

```text
页面：Index(列表) / Editor(编辑) / Chat(问答) / Settings(设置)
服务：MarkdownStore(文件读写) / DeepSeekClient(API 调用) / SettingsStore(配置存储)
```

本地知识库：md 文件存在应用沙箱目录，用文件系统 API 读写、目录遍历；预览用 WebView 或社区 markdown 组件渲染。数据默认在本地，token 不落第三方服务，这是隐私优先的底子。

DeepSeek 问答：`@ohos.net.http` 直调 OpenAI 兼容接口（https://api.deepseek.com/v1/chat/completions），流式输出走 SSE；api key 存 Preferences，后续再升级系统加密存储。AI 助手覆盖三个场景：按主题起草扩写、对选中笔记提问总结、跨笔记整理提炼。

二期同步用 REST API 方案：Contents API 读写文件、Commits API 提交，token 本地存储，不用内置完整 git 客户端；Gitee API v5 与 GitHub 兼容，一套代码两个平台。

## 从 Java 到 ArkTS：最小学习路径

设计了一条四阶段路径，目标 1-1.5 个月（每天 1-2 小时）跑通最小技术验证：

- 阶段 0 环境（半天）：装 DevEco Studio，模拟器跑 Hello World
- 阶段 1 ArkTS 子集（1-2 周）：变量、函数、async/await（对应 Java 的 CompletableFuture）、类与泛型，验收是建模笔记数据完成增删查
- 阶段 2 ArkUI（1-2 周）：@Component、build()、@State，与 Jetpack Compose 同构（@Component ≈ Composable，@State ≈ mutableState），验收是双页应用流畅滚动
- 阶段 3 能力落地（1-2 周）：文件读写、网络调 DeepSeek、Preferences 存配置，验收是发起一次流式问答
- 阶段 4 收口：选中一篇 md 笔记 → 作为上下文发给 DeepSeek → 回答保存回笔记，闭环跑通即正式立项

首版代码实际是 AI 协作完成的，4 页面 3 服务层一次成型，命令行构建直接通过。学习路径保留为「先自己试、卡住再问」的验证脚本，每阶段验收不过就回退。官方资料以 [HarmonyOS 应用开发文档](https://developer.huawei.com/consumer/cn/doc/) 和 [DevEco Studio](https://developer.huawei.com/consumer/cn/deveco-studio/) 为准。

## 踩过的坑

### 命令行构建绕开 IDE

本机 DevEco Studio 安装不完整，最终靠官方 Command Line Tools for HarmonyOS 跑通：hvigorw 构建、sdkmgr 装 SDK、ohpm 包管理、hdc 连真机。命令行路径完全可行：

```bash
hvigorw assembleHap
```

产物 entry-default-unsigned.hap，BUILD SUCCESSFUL。

### 26 个 ArkTS 编译错误

首轮构建修了 26 个编译错误，典型三类：static 成员访问要把 this 换成类名、对象字面量要显式声明 interface、ListFileOptions 这类参数与文档不一致。这些错误只能靠编译期暴露，先跑通最小构建再铺功能是对的。

### 签名密码必须是加密密文

hvigor 6.x 不认明文签名密码，要求「DevEco 加密密文」。解法是自造 material 文件加 AES-128-GCM 密文，decryptPwd 验证通过后，构建能走到 SignHap 阶段。

### 当前卡点：zip64 签名失败

CLT 6.1.1 命令行打包的 HAP 不是 zip64，签名工具报错：

```text
Invalid CEN header (invalid zip64 extra data field size)
```

debug/release、手动 zip64 重打包都失败，疑似命令行打包与签名工具格式不匹配，DevEco Studio 环境无此问题。签名配置已可复用，AGC 签名、真机安装、上架都排在它后面。

## 小结

最大的收获不是鸿蒙语法，而是迁移方法论：先确认生态空白，再用「学习成本 × 上架稳定性 × 生态」比选路线，最后用性能画像排除语言争论。ArkTS 与 Java 的 OOP 概念相通，加上官方全链路支持，是零鸿蒙经验起步的最稳路径。

项目已正式立项，首版代码通过命令行构建；签名工具链是当前唯一硬卡点，解开后走真机安装、上架，二期再接 GitHub/Gitee 同步。
