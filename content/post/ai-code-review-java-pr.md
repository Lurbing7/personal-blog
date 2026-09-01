---
title: "AI 代码审查：从看 Diff 到主动探索（Java PR 实践）"
description: "Copilot 代码审查升级后不再只看 Diff，而是用 grep、rg、glob、view 主动探索项目文件。本文用一个退款 PR 讲透机制、深度分档与配套指令、模板和流程，并说明审查边界。"
date: 2026-09-01
tags: ["AI 编程", "代码审查", "GitHub Copilot"]
categories: ["AI 工程"]
---

# AI 代码审查：从看 Diff 到主动探索（Java PR 实践）

GitHub Copilot Code Review 在 2026 年 6 月做了一次关键升级：审查不再只依赖文件 Diff，而是用 `grep`、`rg`、`glob`、`view` 等工具在审查过程中主动探索项目文件。AI 代码审查从"评论修改内容"转向"调查修改影响"。

这次升级对 Java 项目尤其重要。Java 的修改影响常常跨文件扩散：一个方法变了，调用方、Mapper、测试、配置都可能要跟着变，只看 Diff 很难发现这些。这篇文章用一个典型的退款 PR 场景，拆解这次升级解决了什么问题、怎么配置、边界在哪。

## 为什么 Java PR 很难只靠 Diff 审查

一个典型的 Spring Boot 退款 PR，可能只修改了 `RefundService` 里的几十行代码：

```java
@Transactional
public RefundResult createRefund(RefundCommand command) {
    Order order = orderRepository.findByOrderNo(command.orderNo());
    order.changeStatus(OrderStatus.REFUNDING);
    refundRepository.save(RefundRecord.create(order, command.amount()));
    refundMessageProducer.send(order.getOrderNo());
    return RefundResult.success(order.getOrderNo());
}
```

从 Diff 上看，逻辑清晰、能编译、有事务。但有经验的 Reviewer 会追问：

- `findByOrderNo` 查不到订单时返回 null 还是抛异常？
- `changeStatus` 是否允许从当前状态进入 `REFUNDING`？
- 退款金额是否判断超过可退金额？
- `save` 有没有唯一索引防止重复退款？
- 消息发送失败后，事务是否真的会回滚？

这些风险不一定出现在 Diff 里，可能藏在 Order 聚合对象、Mapper XML、MQ 生产者异常处理、数据库唯一索引和历史状态枚举中。它们分散在不同文件里：聚合对象定义状态转换，XML 写 SQL，生产者管消息，建表脚本定义索引。要回答这些问题，得把整条调用链读一遍。只看 Diff，AI 和人一样看不到 Diff 之外的事实。

## 升级核心：工具驱动的主动探索

早期 AI Code Review 更像静态检查器，只能看到修改附近的代码。看到下面这段，AI 可能建议用 `Objects.equals` 或封装领域方法：

```java
if (order.getStatus() != OrderStatus.PAID) {
    throw new BusinessException("订单状态不允许退款");
}
```

建议本身不一定错，但没发现真正关键的问题：项目里已经存在 `order.canRefund()` 方法，当前 PR 绕过了原有领域规则。

升级后，AI Review 会在审查过程中主动搜索：`canRefund` 在项目中的使用位置、`OrderStatus.PAID` 和 `REFUNDING` 的引用处、其他 Service 和测试里的相关代码。工具链是 `grep`（全文搜索）+ `rg`（高性能搜索）+ `glob`（文件匹配）+ `view`（文件查看）。

AI 不再只评价写出来的代码，而是检查它触碰了哪些既有约定，比如领域方法、状态机和历史数据格式。

另一个例子是 DTO 类型修改。开发者把订单详情响应的金额字段从 `Long` 改成 `BigDecimal`：

```java
public record OrderDetailResponse(
    String orderNo,
    BigDecimal amount,  // 从 Long 改为 BigDecimal
    String status
) {}
```

类型修改本身合理，但可能引发连锁影响：数据库金额以分存还是以元存、Mapper 是否做了单位转换、前端能否处理带小数的字符串、Feign Client 是否仍按旧类型反序列化、历史测试数据用 `10000L` 表示 100 元能否兼容、缓存里的旧 JSON 能否被新类型读取。升级后的 AI Review 可以主动追踪 Mapper、接口文档、Feign DTO、前端契约、缓存序列化和测试，发现这些间接影响。

## 审查深度分档

GitHub 正在推进多档位审查深度，不同风险的项目用不同档位：

| 档位 | 适用场景 |
|------|---------|
| 普通（Light） | README 修改、低风险仓库 |
| 中等（Medium） | 默认档位，平衡深度与速度 |
| 深度（Deep） | 支付、订单、权限等核心服务 |

组织管理员可以为不同仓库设置默认分析级别，仓库可以覆盖组织默认值。原因很直接：给 README 修改跑深度审查是浪费，给支付逻辑只用浅层审查是冒险。AI 审查不应该一套设置走天下，而应像测试覆盖率和 Sonar 规则一样，按风险分级配置。

## 可复用的实践

工具升级只是第一步。要让审查稳定产出有价值的意见，还需要三件配套的事：审查指令、PR 描述、分层流程。

### 1. 配置审查指令：`.github/copilot-instructions.md`

```markdown
# Java / Spring Boot Code Review Instructions

审查 Java 和 Spring Boot 代码时，请重点检查以下内容：

1. 公共接口、DTO 和枚举修改是否保持向后兼容。
2. 数据库写操作是否具有正确的事务边界。
3. 事务方法中是否包含可能导致长事务的远程调用。
4. MQ 消费者的幂等、重试和异常处理是否完整。
5. Redis 缓存修改是否考虑数据库一致性和过期策略。
6. MyBatis XML 是否可能出现全表扫描、N+1 或空集合问题。
7. 金额计算是否统一使用项目规定的单位和类型。
8. 是否为了让测试通过而削弱了原有业务校验。
9. 是否修改 application-prod.yml、生产密钥或敏感配置。
10. 新增业务分支是否有相应单元测试或集成测试。

对于订单、支付、库存和权限相关修改，
请明确指出需要人工确认的业务风险。
```

### 2. 改进 PR 描述

不要只写"新增退款接口，修复部分订单无法退款的问题"。更有效的 PR 描述模板：

```markdown
## 背景
部分历史订单使用旧支付渠道，退款资格判断错误，
导致符合条件的订单被拒绝。

## 修改范围
- 调整 RefundEligibilityService 的渠道判断；
- 保留现有退款金额计算逻辑；
- 不修改支付回调和库存回滚流程；
- 增加旧渠道订单的单元测试。

## 风险
- 涉及历史支付渠道枚举；
- 需要确认缓存中的旧订单快照能否正常反序列化；
- 不涉及数据库结构变更。

## 验证
- 已运行 order-service 单元测试；
- 已覆盖旧渠道、重复退款和金额超限场景。
```

### 3. 分层审查流程

```text
PR提交 → Copilot 第一轮审查（工具探索+指令检查）
      → CI 运行：编译 + 单元测试 + 集成测试 + 代码扫描 + 依赖安全检查
      → 开发者处理 AI 评论和 CI 问题
      → 人工 Reviewer 聚焦：需求正确性 + 领域模型 + 线上兼容 + 方案可维护性
      → 高风险仓库：至少 2 名 Reviewer + 专门负责人审批
```

不要把 AI 评论数量当成审查质量。一条"事务中包含远程调用"比二十条命名建议更有价值。

## 边界与局限

AI 审查的边界要诚实说清楚：

- AI 无法理解隐含业务规则，比如历史状态虽已废弃但数据库仍有旧数据。
- 支付、订单、权限等核心模块仍需熟悉业务的人最终审查，AI 的探索能力只能作为辅助。
- AI 负责代码探索和模式检查，是否符合业务目标需要人类判断。

这套实践还有几个环节没有定论：审查前需要提供哪些上下文、必须优先检查哪些风险类型、如何区分必须修复和建议修改、如何让多个 AI 交叉审查、如何把审查结论转成可执行任务。这几项是让 AI 审查从"能跑"走向"可信"的关键，目前还没有统一做法。

本文内容整理自[路条编程对 Copilot 这次升级的分析](https://mp.weixin.qq.com/s/URX7-Ug03A0CoQf2TcHl8g)。

## 小结

开发流程正在从"一个人写、另一个人看"变成多角色协作：Agent 写代码，另一个 Agent 先做工程审查，人类再完成业务判断。

AI 写代码的速度已经很快，新的瓶颈转移到 Review。下一阶段的竞争重点不只是谁能写更多代码，而是谁能更可靠地审查 AI 生成的代码。

流程从"一个人写、另一个人看"，逐渐变成多个自动化角色和人类共同完成。
