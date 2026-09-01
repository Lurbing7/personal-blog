---
title: "Spring Cache + Redis 序列化 7 大坑：从 ClassCastException 到缓存穿透"
description: "从同类 ClassCastException 到缓存穿透，梳理 Spring Cache + Redis 序列化的 7 个真实踩坑：序列化不统一、集合属性全 null、SpEL 解析异常、缓存覆盖、切换序列化后报错、注解不生效、null 穿透。每个坑都讲清原因与解决方案，附可直接复用的配置和示例代码。"
date: 2026-09-01
tags: ["Spring Cache", "Redis", "缓存"]
categories: ["Java"]
---

# Spring Cache + Redis 序列化 7 大坑：从 ClassCastException 到缓存穿透

## 背景

`@Cacheable` 是 Spring Boot 提供的缓存注解，把方法返回值缓存到指定缓存（如 Redis），后续相同请求直接从缓存获取，避免重复查询数据库。底层依赖 CacheManager，分布式场景常用 RedisCacheManager 实现。

注解用起来简单，坑都藏在配置和序列化里。最常见的报错是同类 ClassCastException，接着是属性全 null、缓存覆盖、缓存穿透。这篇文章把遇到的 7 个坑拆开讲，每个坑都带原因和解决方案。

## 核心机制：两个 Bean 一条序列化链

先搞清楚两个 Bean 的分工。`@Cacheable` 本身只依赖 RedisCacheManager，只配置这一个 Bean，注解就能正常生效。RedisCacheManager 直接和 RedisConnectionFactory 交互，完成缓存的存取、序列化反序列化和规则管理，全程不经过 RedisTemplate。

那 RedisTemplate 为什么还要配置？两个原因。

第一，职责互补。RedisTemplate 是手动操作 Redis 的工具类，能覆盖注解缓存做不到的场景：存 Hash/List/Set 等结构、incr 自增、setnx 分布式锁、批量删除缓存。@Cacheable 只能缓存方法返回值，这些场景全靠 RedisTemplate。

第二，序列化统一。注解缓存和手动操作共存在一个项目里，序列化器不一致，一边写入的数据另一边就读不出来。比如 RedisCacheManager 用 FastJson 写入 userCache::123，RedisTemplate 用 JDK 序列化去读，就会抛 ClassCastException，或者解析出乱码、空数据。

配置上要保证 RedisCacheManager 和 RedisTemplate 序列化统一，优先使用 FastJson2JsonRedisSerializer，摒弃默认的 JDK 序列化。JDK 序列化存的是 Java 对象二进制，换 JSON 序列化后旧数据无法反序列化，这也是坑 1 和坑 5 的共同根源。

## Key 生成规则与 SpEL 语法

缓存 key 的最终格式是 `cacheNames::key`，`::` 是默认分隔符，不可省略。三种常见写法：

- 无参数方法：`key = "'allUserEmail'"`，生成 `emailCache::allUserEmail`
- 单参数方法：`key = "#userId"`，生成 `userCache::123`
- 多参数方法：`key = "'user_' + #userId + '_' + #status"`，生成 `userCache::user_123_0`

引号语法是两个系统叠加：外层双引号是 Java 字符串语法，包裹整个 SpEL 表达式；内层单引号是 SpEL 语法，包裹固定字符串。写错就会触发坑 3。

## 坑 1：同类 ClassCastException（最常见）

异常信息很怪：`User cannot be cast to User`，同一个类互相强转失败。

原因是 RedisCacheManager 与 RedisTemplate 序列化不统一：前者用 JDK 默认序列化，后者用 FastJson，两侧类加载器不一致。

解决方案两步：统一序列化器（用下面的配置）；清理 Redis 中的旧缓存，`del` 对应 key（如 `del emailCache::allUserEmail`）。旧数据不删，同样的错还会再报。

## 坑 2：缓存集合过滤，实体属性全 null

从缓存取回 List 再 stream 过滤，实体的属性全是 null。原因有两个：实体类不满足序列化要求，比如没实现 Serializable、没有无参构造、没有 getter/setter；序列化器没有配置泛型支持。

解决：实体类实现 Serializable，补无参构造和 getter/setter；用 FastJson 序列化配置，它自动支持泛型。

## 坑 3：SpEL 解析异常

报错长这样：`SpelEvaluationException: EL1008E: Property or field 'email' cannot be found`。原因是 key 里的固定字符串没加单引号。

`key = "email"` 时，SpEL 把 email 当成变量去找，找不到就报错；`key = "'email'"` 时，SpEL 才把它解析成固定字符串。

## 坑 4：缓存覆盖（key 不唯一）

现象：不同方法、不同参数，缓存互相覆盖，取到错误数据。原因：没显式配置 key，依赖 Spring 默认 Key 生成规则；或者同一 cacheNames 下 key 重复。

解决：显式配置 key，用业务相关命名，保证同一 cacheNames 下 key 唯一。比如单参数用 `key = "#userId"`，多参数把业务字段拼进 key。

## 坑 5：切换序列化后反序列化异常

现象：改完序列化配置，查询缓存报错，解析不了旧数据。原因：Redis 里还存着旧 JDK 序列化的缓存，和新的 JSON 序列化格式不兼容。

解决：进 Redis 客户端删除对应 key（`del cacheNames::key`），必要时清空整个 cacheNames 下的缓存。配置变更上线前，先想清楚旧数据怎么处理。

## 坑 6：@Cacheable 不生效

现象：每次调用方法都走数据库，缓存没起作用。常见原因四个：

1. 没加 `@EnableCaching`，注解直接失效
2. 方法是 private，AOP 无法拦截
3. 类内部调用缓存方法，AOP 无法拦截
4. unless/condition 条件不满足，结果没缓存

对应解决：启动类或配置类加 @EnableCaching；缓存方法改成 public；内部调用改成通过注入的 Bean 调；检查 unless/condition 配置是否符合预期。

## 坑 7：缓存穿透（缓存了 null）

现象：查询不存在的数据，每次都打数据库，缓存没拦住。原因：方法返回 null，没配 unless 过滤，null 被缓存，之后每次命中缓存取到的还是 null。

解决：注解上加 `unless = "#result == null"`；空集合也要处理，用 `unless = "#result == null or #result.isEmpty()"`。更彻底的做法是在缓存配置里调 `disableCachingNullValues()`，全局禁止缓存 null。

## 配置示例

先看 RedisCacheManager 和 RedisTemplate 的完整配置：

```java
import com.alibaba.fastjson2.support.spring.data.redis.FastJson2JsonRedisSerializer;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.cache.RedisCacheConfiguration;
import org.springframework.data.redis.cache.RedisCacheManager;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.serializer.RedisSerializationContext;
import org.springframework.data.redis.serializer.RedisSerializer;
import org.springframework.data.redis.serializer.StringRedisSerializer;

import java.time.Duration;

@Configuration
@EnableCaching // 必须开启，否则@Cacheable不生效
public class RedisCacheConfig {

    // 缓存管理器（@Cacheable依赖此Bean）
    @Bean
    public RedisCacheManager cacheManager(RedisConnectionFactory connectionFactory) {
        // 键序列化器：String类型，避免key乱码
        RedisSerializer<String> keySerializer = new StringRedisSerializer();
        // 值序列化器：FastJson2，与RedisTemplate保持一致
        FastJson2JsonRedisSerializer<Object> valueSerializer = new FastJson2JsonRedisSerializer<>(Object.class);

        // 缓存配置：序列化方式 + 全局过期时间（20分钟）+ 禁止缓存null
        RedisCacheConfiguration cacheConfig = RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(Duration.ofMinutes(20))
                .serializeKeysWith(RedisSerializationContext.SerializationPair.fromSerializer(keySerializer))
                .serializeValuesWith(RedisSerializationContext.SerializationPair.fromSerializer(valueSerializer))
                .disableCachingNullValues(); // 禁止缓存null，避免缓存穿透

        return RedisCacheManager.builder(connectionFactory)
                .cacheDefaults(cacheConfig)
                .build();
    }

    // RedisTemplate配置（与缓存管理器序列化统一）
    @Bean
    @SuppressWarnings({"unchecked", "rawtypes"})
    public RedisTemplate<Object, Object> redisTemplate(RedisConnectionFactory connectionFactory) {
        RedisTemplate<Object, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(connectionFactory);

        FastJson2JsonRedisSerializer serializer = new FastJson2JsonRedisSerializer(Object.class);
        // 键、值、Hash键/值均使用对应序列化器
        template.setKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(serializer);
        template.setHashKeySerializer(new StringRedisSerializer());
        template.setHashValueSerializer(serializer);

        template.afterPropertiesSet();
        return template;
    }
}
```

再看 @Cacheable 的两个典型用法：

```java
// 无参数：缓存列表，空集合不缓存
@Cacheable(
    cacheNames = "emailCache",
    key = "'allUserEmail'",
    unless = "#result == null or #result.isEmpty()"
)
public List<User> getUserEmail() {
    return userService.list(
        new LambdaQueryWrapper<User>()
            .eq(User::getDelFlag, 0)
            .groupBy(User::getEmail)
    );
}

// 单参数：缓存单个实体，高并发开启sync
@Cacheable(
    cacheNames = "userCache",
    key = "#userId",
    condition = "#userId != null and #userId > 0", // 过滤无效参数
    unless = "#result == null", // 不缓存null
    sync = true // 高并发开启，解决缓存击穿
)
public User getUserById(Long userId) {
    return userService.getById(userId);
}
```

要点：cacheNames 必填，key 保证唯一；condition 在方法执行前判断、不支持 #result；unless 在方法执行后判断、支持 #result。高并发热点数据可以开 `sync = true` 解决缓存击穿，注意开启后 unless 失效。

## 小结

7 个坑可以归成三类：序列化不统一是源头（坑 1、2、5），key 配置是细节（坑 3、4），null 与生效条件是取舍（坑 6、7）。

推荐排查顺序：先统一序列化器，再显式配置 key，最后处理 null 和空集合。按这个顺序过一遍，@Cacheable 基本不会出问题。
