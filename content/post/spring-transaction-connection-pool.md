---
title: "一次连接池被占满的事故复盘：Spring 长事务治理"
description: "注册接口把 OSS 上传和 RPC 调用包进事务，长事务占满数据库连接池导致服务崩溃。复盘根因、注解/编程式/事件三种治理方案，以及事务失效与回滚规则的常见坑。"
date: 2026-09-01
tags: ["Spring", "事务", "连接池", "故障排查"]
categories: ["Java"]
---

# 一次连接池被占满的事故复盘：Spring 长事务治理

## 事故背景

某天服务突然大面积超时，数据库连接池被占满，TPS 急剧下降，随后服务崩溃。排查后定位到用户注册接口：方法上直接加了 `@Transactional`，事务里除了写库，还包了 OSS 文件上传和 RPC 远程调用，全是网络 IO。

问题不在数据库，而在事务边界。这起事故背后是 Spring 事务的一个基本特性：事务不提交，连接不释放。

## 根因：事务占住连接直到提交

Spring 声明式事务基于 AOP 代理实现，这是代理机制最典型的应用之一。进入 `@Transactional` 方法时开启事务，从连接池取走一个连接；事务提交或回滚时，连接才归还连接池。

也就是说，事务持续时间就是连接占用时间。注册接口的事务耗时约 1.5 秒；对比方案二的数据，只包数据库操作的事务耗时 10 毫秒，差距全在网络 IO。连接池只有 10 个连接，最大 TPS ≈ 10 / 1.5 ≈ 6.6。并发一上来，连接被全部占住，新请求拿不到连接，只能排队超时，服务整体响应瘫痪。

事务基础（ACID、隔离级别）可以参考[什么是事务](https://zhuanlan.zhihu.com/p/450092356)。数据库连接是稀缺资源，占用时间越短，并发能力越高。

## 方案一：把网络 IO 移出事务

先看事故代码：

```java
@Service
public class UserService {
    @Transactional
    public void register(User user) {
        userDao.save(user);                  // 数据库操作
        ossService.upload(user.getAvatar()); // 网络 IO
        rpcService.call(user.getId());       // 网络 IO
    }
}
```

直觉做法是把上传和 RPC 挪到事务外，再调用事务方法：

```java
public void register(User user) {
    ossService.upload(user.getAvatar());
    rpcService.call(user.getId());
    this.saveUser(user); // 事务失效！
}

@Transactional
public void saveUser(User user) {
    userDao.save(user);
}
```

这样事务会失效。Spring 事务基于代理，`this.saveUser()` 是内部调用，不走代理，注解不生效。

注解的落点也要记住：`@Transactional` 可以标在类或方法上。标在类上，该类的所有 public 方法都生效；方法上的配置覆盖类级配置。标在接口上不推荐，使用 CGLib 动态代理时注解会失效。

正确做法是注入另一个 Bean，让调用经过代理：

```java
@Service
public class UserService {
    @Autowired
    private UserTransactionService userTransactionService;

    public void register(User user) {
        ossService.upload(user.getAvatar());
        rpcService.call(user.getId());
        userTransactionService.saveUser(user);
    }
}

@Service
public class UserTransactionService {
    @Transactional
    public void saveUser(User user) {
        userDao.save(user);
    }
}
```

这个方案解决了长事务，但事务边界仍然隐式。网络 IO 和写库之间一旦插入别的逻辑，容易再次把事务范围撑大。

## 方案二：编程式事务，精确控制边界

用 `TransactionTemplate` 显式圈定事务范围，只包数据库操作：

```java
@Service
public class UserService {
    @Autowired
    private TransactionTemplate transactionTemplate;

    public void register(User user) {
        ossService.upload(user.getAvatar());
        rpcService.call(user.getId());

        transactionTemplate.execute(status -> {
            userDao.save(user);
            return null;
        });
    }
}
```

效果直接：事务耗时从 1.5 秒缩短到 10 毫秒，性能提升约 150 倍。事务范围精确可控，是大多数场景的推荐做法。

`@Transactional` 的典型用武之地是转账这类纯数据库操作：扣钱、加钱两步要么都成功，要么都回滚。注册这类带外部依赖的流程，就不该整体包进事务。

注意一点：RPC 写操作要放在事务之后，避免远程调用失败时事务已提交、两边数据不一致。必要时要靠事务消息（如 RocketMQ）保证最终一致性。兜底机制也要提前设计：失败后重试，必要时人工干预。

## 方案三：事件机制，提交后再异步

高并发、业务链长的场景，可以用事件把非核心操作彻底解耦。事务内只写库、发布事件，事务提交后再异步执行：

```java
@Transactional
public void register(User user) {
    userDao.save(user);
    eventPublisher.publishEvent(new UserRegisterEvent(user.getId()));
}
```

```java
@Component
public class UserRegisterListener {
    @Async("customThreadPool")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void handleUserRegister(UserRegisterEvent event) {
        smsService.sendWelcomeSms(event.getUserId());
        emailService.sendWelcomeEmail(event.getUserId());
    }
}
```

`@TransactionalEventListener(phase = AFTER_COMMIT)` 保证事务提交后才触发，配合 `@Async` 异步执行，不阻塞主流程。短信、邮件这类非核心操作丢进自定义线程池：

```java
@Bean("customThreadPool")
public Executor customThreadPool() {
    ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(10);
    executor.setMaxPoolSize(20);
    executor.setQueueCapacity(100);
    executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
    executor.setThreadNamePrefix("async-");
    return executor;
}
```

非核心操作还可以做降级：失败只记日志，不影响主流程。适用边界要分清：事件适合可容忍丢失的操作，核心数据链路不要依赖内存事件。局限也要说清：事件基于内存，宕机会丢，高可靠性场景需要结合 MQ 落盘。线程池里的 `CallerRunsPolicy` 是兜底：队列满时任务由调用线程执行，宁可慢一点也不丢任务。

## 防坑：回滚规则与事务失效

事务范围之外，回滚规则是第二个高频事故点。

默认情况下 Spring 只回滚 `RuntimeException` 和 `Error`，受检异常（比如 `IOException`）不会触发回滚。RPC 调用常抛受检异常，事务里的写库已经提交，数据就脏了。要么显式配置：

```java
@Transactional(rollbackFor = Exception.class)
```

要么在编程式事务里手动标记：

```java
transactionTemplate.execute(status -> {
    try {
        userDao.save(user);
    } catch (Exception e) {
        status.setRollbackOnly();
        throw e;
    }
    return null;
});
```

另外记住三个会让 `@Transactional` 失效的场景：非 public 方法；`propagation` 配成 `SUPPORTS` / `NOT_SUPPORTED` / `NEVER`；以及类内部调用不走代理。

传播行为也要理解：默认 `REQUIRED`，存在事务就加入，A 方法里调 B 方法会把两者合并成一个事务；`REQUIRES_NEW` 暂停当前事务另开一个，内层先提交，外层回滚不影响它。

`isolation` 默认 `DEFAULT`，跟随数据库默认级别，MySQL 默认可重复读。四种隔离级别从低到高是读未提交、读已提交、可重复读、串行化，依次阻止脏读、不可重复读、幻读，级别越高并发能力越差。`timeout` 默认 -1，超过限制自动回滚；`readOnly` 默认 false，纯查询方法可以设为 true，通知框架这是只读事务。

底层对应关系也值得清楚：MySQL 默认自动提交，显式事务用 `BEGIN` / `COMMIT` / `ROLLBACK` 控制；Spring 的事务代理只是把这套流程包起来。事务管理的对象是 insert、update、delete 这类写语句，读操作一般不需要开事务。

| 方案 | 要点 | 风险 |
|---|---|---|
| 全包裹 @Transactional | 简单，含网络 IO | 高并发必崩 |
| 内部调用 this.方法() | 事务失效 | 数据不一致 |
| 编程式事务 | 手动控制范围 | 低 |
| 事件监听 | 解耦异步，提交后触发 | 内存事件可能丢 |

## 小结

这次事故的教训有三条。

底线原则：严禁把网络 IO（RPC、HTTP、文件上传）放进事务，事务里只放数据库操作。

演进路径：注解事务 → 编程式事务 → 事件驱动，按业务复杂度逐步升级。大多数场景编程式事务就够，事件机制留给复杂业务链。连接池大小也要根据业务压力配置。最佳实践收成清单：事务范围最小化、网络 IO 异步化、异常处理完善、监控到位。

最后是监控：盯住事务耗时和连接池使用率，设置合理阈值告警。等连接池被占满才发现，事故已经发生了。
