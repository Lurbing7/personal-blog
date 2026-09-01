---
title: "Kafka 生产级配置实战：幂等、手动提交与 Topic 自动初始化"
description: "Spring Boot 集成 Kafka 的生产级配置实战：生产者开幂等防重复，消费者关自动提交改手动 ack 防丢消息，启动时自动初始化 Topic。附完整 yaml 与 Java 代码和踩坑总结。"
date: 2026-09-01
tags: ["Kafka", "Spring Boot", "可靠性"]
categories: ["消息队列"]
---

# Kafka 生产级配置实战：幂等、手动提交与 Topic 自动初始化

## 背景与问题

Kafka 接入 Spring Boot，默认配置能跑通 demo，但离生产要求还差得远。

三个典型问题：生产者重试可能造成重复消息；消费者自动提交 offset，处理失败时消息会丢；topic 依赖自动创建，分区和副本参数不可控。

这套配置整理自一台三 broker 的 Kafka 集群，Kafka 本身的安装部署不在本文范围。示例基于 Spring Boot 2.2.5.RELEASE 与 spring-kafka，项目依赖 `spring-boot-starter-web` 和 `spring-kafka`，版本由 `spring-boot-starter-parent` 统一管理。下面按生产者、消费者、topic 三个环节展开。

## 生产者：幂等 + acks=all

生产者的核心是两件事：消息不丢、不重。`enable.idempotence: true` 开启幂等，防止重试造成重复写入，但它要求 `acks` 必须是 `-1`（all），两者要一起配。

```yaml
spring:
  kafka:
    bootstrap-servers: broker1:9092,broker2:9092,broker3:9092
    producer:
      retries: 3
      batch-size: 16384
      buffer-memory: 33554432
      acks: -1
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.apache.kafka.common.serialization.StringSerializer
      properties:
        enable.idempotence: true
```

`acks` 的三种取值对应三档可靠性：

- `0`：客户端把消息发出去就算成功
- `1`：分区 Leader 收到并写入本地磁盘就算成功
- `-1`（all）：Leader 写入后，ISR 里保持同步的 Follower 全部同步过去才算成功

其余参数各有分工：

- `retries: 3`：设为大于 0 后，发送失败的记录会被客户端自动重新发送
- `batch-size: 16384`（16KB）：发往同一分区的消息打包成批次，减少请求交互，而不是一条条发
- `buffer-memory: 33554432`（32MB）：约束 Producer 能使用的内存缓冲大小

幂等配置放在 `properties` 下，因为它直接对应 Kafka Producer 的原始配置项；更多可配置项可以在 `org.apache.kafka.clients.producer.ProducerConfig` 中查看。`retries` 只管把失败的记录重发出去，能不能做到不重，还得靠幂等兜底，两者配合才是完整的发送可靠性。示例中事务配置（`transaction-id-prefix`）保持注释状态，需要事务语义时再开启。

发送代码用 `KafkaTemplate.send(topic, key, msg)` 一行即可，发送端是一个 HTTP 接口，用 Postman 请求就能验证消息收发：

```java
@RestController
public class KafkaController {

    private final static String TOPIC_NAME = "test-topic";

    @Autowired
    private KafkaTemplate<String, String> kafkaTemplate;

    @RequestMapping("/send")
    public String send(@RequestParam("msg") String msg) {
        kafkaTemplate.send(TOPIC_NAME, "name", msg);
        return String.format("消息 %s 发送成功！", msg);
    }
}
```

## 消费者：关自动提交，手动 ack

消费者默认自动提交 offset。一旦提交，消费者进程挂了或者业务处理失败，消息就找不回来。所以把自动提交关掉，改为处理成功后再手动提交：

```yaml
spring:
  kafka:
    consumer:
      group-id: consumer-group
      enable-auto-commit: false
      auto-commit-interval: 5000
      auto-offset-reset: latest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.apache.kafka.common.serialization.StringDeserializer
    listener:
      ack-mode: manual_immediate
```

`enable-auto-commit: false` 保证消费消息不丢失。`auto-commit-interval: 5000` 是自动提交模式下的提交间隔，默认 5 秒。

`auto-offset-reset` 决定没有已提交 offset 时从哪开始：

- `earliest`：从头开始消费
- `latest`：只消费新产生的数据
- `none`：只要有一个分区没有已提交 offset，直接抛异常

示例选 `latest`：没有已提交 offset 时只消费新产生的数据，不会一启动就把历史消息重放一遍。

`ack-mode` 决定何时提交，Spring Kafka 提供多种模式：

- `RECORD`：每处理一条记录提交一次
- `BATCH`：每处理完一批 poll() 的数据提交
- `TIME`：处理完一批后，距上次提交超过设定时间才提交
- `COUNT`：处理数量达到设定值才提交
- `COUNT_TIME`：时间或数量任一满足即提交
- `MANUAL`：手动调用 `acknowledge()` 后提交
- `MANUAL_IMMEDIATE`：手动调用后立即提交，一般使用这种

自动提交的时机和业务处理结果无关；手动提交把「处理成功」作为提交前提，所以更可靠。监听器拿到 `Acknowledgment`，业务处理成功后才提交：

```java
@Component
public class MyConsumer {

    @KafkaListener(topics = "test-topic")
    public void test(ConsumerRecord<String, String> record, Acknowledgment ack) {
        String value = record.value();
        System.out.println("message: " + value);
        ack.acknowledge();
    }
}
```

核心约束：`ack.acknowledge()` 必须在业务处理成功之后调用。提交前失败，offset 不前进，消息不会丢。

## Topic 自动初始化

消费者监听不存在的 topic 时默认直接报错，`missing-topics-fatal` 默认为 true。设为 false 可以让消费者自动创建主题，但该配置不建议使用。

更可控的做法是启动时主动注册 topic：把参数从代码里抽到配置文件，启动时统一创建，一眼就能看清。先引入配置注解处理器：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-configuration-processor</artifactId>
    <optional>true</optional>
</dependency>
```

主题参数写在配置文件里：

```yaml
kafka:
  topics:
    - name: topic1
      num-partitions: 6
      replication-factor: 1
    - name: topic2
      num-partitions: 6
      replication-factor: 1
```

配置类用 `@ConfigurationProperties(prefix = "kafka")` 读取，`Topic` 有三个属性：`name`、`numPartitions`（默认 3）、`replicationFactor`（默认 1）。

```java
@Data
@Configuration
@ConfigurationProperties(prefix = "kafka")
public class MyTopicConfig {

    private List<Topic> topics;

    @Data
    public static class Topic {
        String name;
        Integer numPartitions = 3;
        Short replicationFactor = 1;

        NewTopic newTopic() {
            return new NewTopic(this.name, this.numPartitions, this.replicationFactor);
        }
    }
}
```

注册逻辑：容器加载时（`@PostConstruct`）把每个 topic 以 `NewTopic` 类型注册进 Spring 上下文，bean 名就是 topic 名，topic 随之创建。`GenericWebApplicationContext` 是 web 容器上下文；`registerBean` 的三个参数分别是 bean 名、bean 类型和 bean 来源，这里用 `topic::newTopic` 提供：

```java
@Configuration
@EnableConfigurationProperties(MyTopicConfig.class)
public class MyTopicManager {

    private final MyTopicConfig myTopicConfig;
    private final GenericWebApplicationContext context;

    public MyTopicManager(MyTopicConfig myTopicConfig, GenericWebApplicationContext context) {
        this.myTopicConfig = myTopicConfig;
        this.context = context;
    }

    private void initialize(List<MyTopicConfig.Topic> topics) {
        topics.forEach(topic ->
            context.registerBean(topic.name, NewTopic.class, topic::newTopic)
        );
    }

    @PostConstruct
    public void init() {
        initialize(myTopicConfig.getTopics());
    }
}
```

**分区和副本怎么定**

分区数：集群较小时（少于 6 个 broker）按 `2 × broker 数` 配置，主要考虑后续扩展——集群将来扩展一倍（比如从 6 台到 12 台），也不用担心分区不足。集群较大时（超过 12 个 broker）按 `1 × broker 数` 配置，因为不再考虑扩展，与 broker 数相同的分区已足够应付常规场景，有必要再手动调整。

副本数建议至少 2，一般 3，最高 4。副本数 N 意味着系统更稳定、允许 N-1 个 broker 宕机；代价是 `acks=all` 下写入延时更高，磁盘占用也更多——RF 为 3 相对 RF 为 2 多占 50% 磁盘空间。

**参数创建后不可随意改**

topic 初始化之后修改配置，只有一部分生效：

- `num-partitions` 调大：生效
- `num-partitions` 调小：不生效
- `replication-factor` 修改：不生效

所以分区和副本要在创建前定好。创建后只能扩分区，不能缩，副本数无法修改。

## 小结

三个配置对应三个可靠性环节：生产者开幂等配合 `acks=all` 防重复；消费者关自动提交、手动 ack 防丢消息；topic 启动时自动初始化，让分区和副本参数显式可控。示例里发送端用 HTTP 接口触发、Postman 验证，消费端打印日志确认处理与提交。

三处配置还是咬合的：`acks=all` 依赖 ISR 中副本同步完成，副本数又决定了集群能容忍几个 broker 宕机。默认配置只适合 demo，可靠是配置组合出来的结果，而且 topic 参数创建后不可逆——先把参数想清楚，再让它上线。
