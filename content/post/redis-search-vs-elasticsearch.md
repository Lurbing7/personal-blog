---
title: "Redis Search 还是 Elasticsearch？全文检索选型边界"
description: "数据本来就在 Redis，还要为全文检索引入 Elasticsearch 吗？本文梳理 Redis Search 的索引机制、中文分词限制与版本差异，拆解两套系统的适用边界，指出官方基准的局限，附实践检查清单。"
date: 2026-09-01
tags: ["Redis", "Elasticsearch", "全文检索"]
categories: ["技术选型"]
---

# Redis Search 还是 Elasticsearch？全文检索选型边界

商品数据已经躺在 Redis 的 Hash 里，现在要按名称做全文搜索。第一反应通常是上 Elasticsearch：成熟、生态全、文档多。

但问题来了：数据本来就在 Redis，为检索再引入一套独立的搜索系统，意味着数据双写、请求多一跳、运维多一套。Redis Search 提供了另一条路——在 Redis 内部对已有数据建索引。

Redis Search 是 Redis 的查询与索引能力，可对 Hash 和 JSON 文档建立二级索引，支持全文、标签、数值、地理位置和向量检索。它适合数据已经位于 Redis、要求低延迟且搜索模型相对简单的场景。它不是 Elasticsearch 的通用平替。本文讲清楚边界在哪。

选择不只有二选一。数据量不大、查询模式简单时，Redis Search 足够；数据量起来、查询复杂后，ES 的成本才值得付。先搞清楚自己的数据规模和查询复杂度，再谈选型。

## 先确认版本：RediSearch 和 Redis 8

旧资料通常称这项能力为 RediSearch，并通过 Redis Stack 加载模块。这个说法已经过时。

Redis 8 已将 Search、JSON、Time Series 等能力集成到 Redis Open Source，不再需要额外加载模块。Redis Stack 主要对应 Redis 7.4 及更早版本。查资料时先区分这两代，否则会看到互相矛盾的部署方式。

新项目应先确认 Redis 主版本，再选择部署方式：

- Redis 8 及以上：直接使用 Redis Open Source
- Redis 7.4 及以下：可使用带 Search 模块的 Redis Stack
- Redis Cloud 或 Redis Software：按产品文档确认集群、持久化和高可用能力

版本判断错了，后面所有命令和部署配置都会对不上。第一件事是 `redis-server --version`。

## 核心机制：在 Redis 内部维护二级索引

Redis Search 为 Hash 或 JSON 文档自动维护索引。写入数据时索引同步更新，业务侧不需要单独调用索引接口，主数据还是原来的 Hash 或 JSON。

能力面：

- `FT.SEARCH`：执行全文和结构化查询
- `FT.AGGREGATE`：做过滤、分组和聚合
- 支持中文分词、模糊匹配、自动补全和同义词
- 支持向量相似度，以及全文与向量的混合检索

中文是重点。索引必须显式指定 `LANGUAGE chinese`，Redis Search 使用 Friso 进行中文分词，效果依赖内置或自定义词典。它不等同于 Elasticsearch 的完整中文插件生态——品牌名、产品型号这类专有词，上线前必须验证召回。

需要向量检索时，同一套索引里就能做全文与向量的混合检索，不用为向量再单独搭一套系统。

## 基本操作：一个商品索引的完整示例

为 `goods:` 前缀的 Hash 创建中文商品索引：

```bash
FT.CREATE idx:goods ON HASH PREFIX 1 goods: LANGUAGE chinese SCHEMA goodsName TEXT SORTABLE tag TAG
```

写入两条商品数据：

```bash
HSET goods:1001 goodsName "小米手机" tag "phone"
HSET goods:1002 goodsName "华为手机" tag "phone"
```

执行中文全文检索：

```bash
FT.SEARCH idx:goods "手机" LANGUAGE chinese
```

查看索引信息：

```bash
FT.INFO idx:goods
```

删除索引但保留源数据：

```bash
FT.DROPINDEX idx:goods
```

注意：`FT.DROPINDEX idx:goods DD` 会同时删除已索引文档。执行前必须确认数据边界，排查问题时顺手敲下去，后果是源数据直接消失。

从建索引到查数据，这五条命令就是一个最小闭环。不需要任何额外组件，数据写进 Redis 即可被检索到。

## 选型边界：什么场景选谁

Redis Search 更合适的场景：

- 数据本来就在 Redis，希望避免同步到另一套搜索系统
- 商品名称、标签、实时状态等中小规模查询
- 延迟敏感，且能够接受以内存为主的成本模型
- 需要全文与向量混合检索的实时应用

Elasticsearch 更合适的场景：

- 大规模日志检索、复杂分析和长期数据留存
- 依赖成熟的分词器、插件、可视化和搜索运维生态
- 数据量超过内存预算，需要以磁盘存储为主
- 需要成熟的分布式搜索、冷热分层和复杂相关性调优

选型不能只比较单次查询吞吐量。还要评估内存成本、索引大小、写入放大、持久化、故障恢复、扩容方式、查询复杂度和团队运维能力。Redis 的内存模型决定了数据量是硬约束：量级上来以后，省掉一套系统省下的运维成本，可能被内存账单吃掉。

每个维度都对应真实成本：内存对应账单，写入放大对应磁盘和 CPU，持久化和故障恢复对应可用性目标，扩容方式对应增长路径。

## 性能数字：58% 和 4 倍是怎么来的

网上流传的「索引快 58%、查询吞吐量快 4 倍」出自 Redis 官方 2019 年基准：RediSearch 1.4.3 对比 Elasticsearch 6.6.0，数据集是 560 万篇 Wikipedia 文档，查询是 32 个客户端发起的双词搜索。

这组数字只能说明特定测试条件下的性能，不代表当前版本、所有查询类型或真实业务负载。两个产品此后迭代了多个大版本，基准场景也远不是真实业务的查询分布。另外 Redis 是被比较产品的厂商，结论天然有立场。

引用这组数字时要带上条件：2019 年、RediSearch 1.4.3 对 Elasticsearch 6.6.0、Wikipedia 数据集、双词查询。条件一换，结论可能完全不同。

正确做法：用自己的数据、自己的查询、自己的硬件复测。

## 上线前的实践检查

选型结论要用实测支撑。建议按这个清单过一遍：

1. 使用真实数据建立最小索引
2. 同时测试查询延迟、写入延迟和内存增长——只测查询会漏掉写入放大
3. 加入中文专有词，检查分词召回率
4. 模拟重启、主从切换和索引重建
5. 根据业务峰值测试并发和尾延迟，而不只看平均值
6. 确认备份、持久化和集群能力满足生产要求

这六项都过了，才轮到比吞吐量。

## 小结

一句话边界：数据已经在 Redis、中小规模、延迟敏感、搜索模型简单，选 Redis Search；大规模日志、磁盘为主、需要成熟生态，选 Elasticsearch。

Redis Search 的价值是省掉一套系统，代价是内存成本和能力上限。性能数字只能做参考，用真实数据跑一遍实践检查，边界自然清晰。

## 参考资料

- [Redis Search 官方文档](https://redis.io/docs/latest/develop/ai/search-and-query/)
- [FT.CREATE 命令](https://redis.io/docs/latest/commands/ft.create/)
- [中文检索支持](https://redis.io/docs/latest/develop/ai/search-and-query/advanced-concepts/chinese/)
- [2019 年 RediSearch 与 Elasticsearch 基准](https://redis.io/blog/search-benchmarking-redisearch-vs-elasticsearch/)
