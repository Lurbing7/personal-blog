---
title: "ConcurrentHashMap：类安全不等于逻辑安全"
description: "ConcurrentHashMap 单方法原子，但组合起来的业务逻辑不一定安全。用库存扣减拆解检查-执行缝隙、merge 无边界、嵌套容器三大陷阱，给出 CAS 自旋与 computeIfAbsent 等正确写法。"
date: 2026-09-01
tags: ["并发", "ConcurrentHashMap", "缓存"]
categories: ["Java"]
---

# ConcurrentHashMap：类安全不等于逻辑安全

## 一个常见的错觉

写服务端代码时，只要涉及并发，很多人第一反应是：把 HashMap 换成 ConcurrentHashMap，线程安全就解决了。

这个想法只对了一半。ConcurrentHashMap 的每个方法（get、put、remove、replace）确实是原子操作，单个方法调用不会出并发问题。但多个原子操作组合出来的业务逻辑，不一定安全。

本文用最常见的库存扣减场景，拆开三个典型陷阱：检查-执行的缝隙、merge 缺边界、嵌套容器。

每个陷阱先看错误写法，再看正确写法，最后统一落到原子性边界这个本质上。

## 线程安全到底保证了什么

先明确边界：ConcurrentHashMap 保证的是"单个方法调用的原子性"。

也就是说，并发下多个线程同时 get、put、remove 同一个 key，不会出现数据损坏。方法级操作由容器内部机制保证，这点可信赖。

但业务逻辑通常不是单个方法，而是"检查-执行"这类复合操作。复合操作跨多个原子步骤，步骤之间有时间缝隙，其他线程可以插进来改数据。缝隙存在，方法级的线程安全就保护不了业务逻辑。

**类安全 ≠ 逻辑安全**，这是本文的结论。要保证复合操作的原子性，需要额外控制。

## 陷阱一：检查-执行的缝隙

最经典的超卖问题：

```java
if (map.get(key) > 0) {
    map.put(key, map.get(key) - 1);
}
```

get 和 put 之间有时间缝隙。两个线程同时读到库存 1，都判断 `> 0`，都执行扣减，结果卖出 2 件商品，库存只减了 1。

换种说法：第一次 get 读到的值，到 put 执行时可能已经过期。这种"读旧值、写新值"的读-改-写模式，在并发下必然丢更新，容器无法替你消除。

正确写法是 CAS 自旋，把"检查 + 更新"合并成单个原子操作：

```java
while (true) {
    Integer oldValue = map.get(key);
    if (oldValue == null || oldValue <= 0) {
        return false; // 库存不足
    }
    if (map.replace(key, oldValue, oldValue - 1)) {
        return true; // 扣减成功
    }
    // 失败重试
}
```

要点有两个。

一是 `replace(key, oldValue, newValue)` 是原子操作：只有当前值等于 oldValue 时才替换，比较与替换一步完成，没有缝隙。

二是替换失败说明值已被其他线程改过，需要读新值重试，自旋直到成功或边界条件退出。

边界检查不能省：`null` 和 `<= 0` 都要处理，否则可能对不存在的 key 或零库存继续扣减。

整体思路是：比较-替换由容器一步完成，重试交给自旋循环，业务只关心最终成功或失败。

## 陷阱二：merge 原子，但不带边界

有人觉得用 merge 一步到位更简洁：

```java
// 超卖：没有边界检查
map.merge(key, -1, Integer::sum);
```

merge 本身是原子操作，不会数据错乱，但问题出在业务逻辑：库存已经是 0 时，扣减依然执行，结果变成 -1，直接违反业务下限约束。

原因在于 merge 只保证方法原子性，不保证业务逻辑正确性。它内部没有、也无法知道你的库存下限。

适合 merge 的是没有下限约束的计数场景：

```java
// 适合计数场景（无下限约束）
map.merge(key, 1, Integer::sum); // 计数 +1
```

结论：有边界约束的场景不能直接 merge，需要额外的检查，或者回到陷阱一的 CAS 自旋。

## 陷阱三：外层安全不等于内层安全

容器嵌套容器是最隐蔽的坑：

```java
ConcurrentHashMap<String, List<String>> map = new ConcurrentHashMap<>();
```

这里有两个问题同时存在。

问题一，初始化覆盖：多个线程同时读到 `map.get(key) == null`，各自 new 一个 ArrayList 再 put，后写入的覆盖前面的，先初始化的结果被丢弃。

问题二，内层容器非线程安全：就算初始化成功，`list.add(value)` 操作的还是 ArrayList，并发写会导致数据错乱。ConcurrentHashMap 管不到它内部的元素。

原因在于 ConcurrentHashMap 的原子性只覆盖 map 自身的操作，value 对象内部的修改不经过它。外层管不到内层，两层必须分别保证安全。

正确写法是两件事一起做：

```java
// computeIfAbsent 保证初始化原子性
List<String> list = map.computeIfAbsent(key, k -> new CopyOnWriteArrayList<>());
// 内部使用线程安全容器
list.add(value);
```

- `computeIfAbsent` 保证初始化原子性：只有 key 不存在时才执行映射函数，多个线程竞争时只初始化一次
- 内部容器必须使用线程安全实现：CopyOnWriteArrayList、ConcurrentLinkedQueue 等

一句话：外层安全不等于内层安全，嵌套容器的每一层都要自己负责。

## 安全使用姿势

三个陷阱背后是同一个原则：**检查-执行这类复合操作，必须整体原子化**。

落到 API 层面：

- 需要"读-改-写"时，优先用现成的原子方法：replace、compute、computeIfAbsent、merge
- 有边界约束的业务（库存扣减），用 CAS 自旋显式处理失败重试
- 嵌套容器时每层都选线程安全实现，初始化用 computeIfAbsent

不要用 get + put 自己拼"看起来对"的逻辑，JUC 里这些原子方法基本都提供了。

## 从单机到分布式

ConcurrentHashMap 的适用边界是单机内存，它的原子性只在 JVM 内有效。

常见的单机场景：

- 本地缓存：热点数据缓存，减少下游压力
- 热点拦截：缓存空值或标记，防止缓存穿透
- 限流器：单机限流计数，统计单位时间内的请求数

跨进程的场景，比如多实例部署，ConcurrentHashMap 就无能为力了：每个 JVM 各有一份数据，原子操作只对本实例有效。

这时需要分布式方案：Redis 的原子操作或 Lua 脚本、分布式锁。一个常见组合是本地缓存 + 分布式锁或 Redis：本地缓存挡掉大部分流量，Redis 兜底保证跨实例一致。

判断标准很直接：这份数据跨实例不一致能不能接受。不能接受，才需要 Redis 或分布式锁；能接受，本地缓存就够了。

理解原子性的边界，才能判断什么该用 ConcurrentHashMap，什么该上分布式。

## 小结

ConcurrentHashMap 的线程安全是方法级的，不是业务级的。

三个陷阱各有解法：检查-执行缝隙用 CAS 自旋；merge 缺边界约束要自己校验；嵌套容器每层都要线程安全实现。

并发编程里，工具本身的安全只是基础，业务逻辑的组合方式才是关键。理解原子操作的边界，别停在"API 舒适区陷阱"里。

参考：[java.util.concurrent.ConcurrentHashMap 官方文档](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/concurrent/ConcurrentHashMap.html)
