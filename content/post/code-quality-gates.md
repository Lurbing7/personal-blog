---
title: "代码质量门禁三件套：JaCoCo + SonarQube + Snyk"
description: "用 JaCoCo、SonarQube、Snyk 在 CI 搭质量门禁：JaCoCo 把关测试覆盖率，SonarQube 盯自己写的代码质量，Snyk 扫第三方依赖漏洞，提交后自动阻断问题代码。"
date: 2026-09-01
tags: ["JaCoCo", "SonarQube", "Snyk", "CI"]
categories: ["工程化"]
---

# 代码质量门禁三件套：JaCoCo + SonarQube + Snyk

代码能跑不等于能交付。写完单元测试，不知道测试写够了没有；代码越写越复杂，同样的 Bug 反复出现。依赖里的漏洞等到上线才发现，改起来代价最大。

这三类问题对应三个工具：JaCoCo 统计测试覆盖率，SonarQube 检查自己写的代码质量，Snyk 扫描引用的第三方依赖。把三者接进 CI，就是一套从提交到合并自动把关的质量门禁。

## JaCoCo：先回答「测试写够了没」

JaCoCo 是 Java 项目最常用的覆盖率统计工具。它插桩到编译后的字节码，在测试运行时收集哪些代码被执行了，生成可视化报告。写完测试打开 `target/site/jacoco/index.html`，哪些类测了、哪些没测、整体覆盖率多少，一目了然。

覆盖率有五种常用指标：

| 指标 | 含义 | 关注点 |
|---|---|---|
| 指令覆盖 | 字节码指令被执行的比例 | 最底层，基本指标 |
| 分支覆盖 | if/else、switch 分支是否都走到 | 逻辑完整性 |
| 行覆盖 | 源代码行是否被执行 | 最直观，看报表重点 |
| 方法覆盖 | 方法是否被调用过 | 粗略，总览用 |
| 类覆盖 | 类是否被加载执行 | 最粗粒度 |

实际项目中，质量门通常设行覆盖率 ≥ 80%、分支覆盖率 ≥ 70%。一个判断标准值得记住：覆盖率 80% 不等于代码质量高，但覆盖率 20% 一定意味着测试严重不足。

Maven 集成是在 `pom.xml` 加 `jacoco-maven-plugin`，示例版本 0.8.15，三个 execution 分工：

```text
prepare-agent → 测试前插桩，收集 target/jacoco.exec
report(phase: test) → 生成 target/site/jacoco/index.html
check(phase: verify) → BUNDLE 的 LINE COVEREDRATIO 低于 0.80 直接失败
```

跑 `mvn clean verify` 即可：测试执行 → 收集覆盖率 → 生成报告 → check 按规则判定，不达标直接失败，通过才打包。DTO、配置类、自动生成的代码用 `excludes` 排除，避免拉低覆盖率。

## SonarQube：质量门的裁判

SonarQube 是开源的代码质量和安全扫描平台，社区版免费。它通过质量门（Quality Gate）判定：每次扫描给出 Pass / Fail 结论，CI 里配置阻断，不达标不允许合并代码。

质量门规则可自定义，常见组合：新增代码覆盖率 < 80%、新增 Bug > 0、新增安全热点 > 0、重复代码比例 > 3%，任一触发即失败。

它盯七类指标：Bug、安全漏洞、安全热点、代码异味、覆盖率、重复代码、技术债务（按预计修复时间估算，如 "2d 5h"）。治理上推荐 Clean as You Code：存量问题允许慢慢修，新增代码必须过质量门，防止新写的代码继续制造技术债务。

与 JaCoCo 配合是 Java 项目的标准组合：JaCoCo 生成 `target/jacoco.exec`，SonarQube 读取后在 Web UI 展示，质量门直接引用覆盖率数据：

```bash
mvn clean verify sonar:sonar \
  -Dsonar.host.url=http://localhost:9000 \
  -Dsonar.login=my-token
```

SonarQube 本身是 Java Web 应用，社区版用 Docker 启动，最低建议 2 核 CPU + 4G 内存 + PostgreSQL。扫描由 Sonar Scanner 客户端执行，命令行或 CI 里跑都行，集成方式见 [CI 集成与质量门](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/ci-integration/overview)。

## Snyk：把安全检测左移

传统安全流程是上线前安全团队扫一遍，发现问题回去改，再扫一遍，慢而且堵。Snyk 的思路是把检测左移到开发流程：写代码时 IDE 标红，提交时 CI 里扫，PR 上直接挂结果。

四个扫描方向：开源依赖（已知 CVE，自动建议修复版本）、容器镜像（操作系统包漏洞）、基础设施即代码（S3 桶公开访问、Pod 以 root 运行等配置风险）、代码 SAST（SQL 注入、XSS、硬编码密码）。本地跑一次：

```bash
snyk test
# x High severity vulnerability found in lodash@4.17.15
#   Description: Prototype Pollution
#   Upgrade to: lodash@4.17.21
```

与 SonarQube 是互补关系，不是二选一：SonarQube 盯自己写的代码质量，Snyk 盯依赖、容器、配置这些「别人写的代码」。用法详见 [Snyk 文档](https://docs.snyk.io/)。

## 组合成一条流水线

三件套在 CI 里的完整链路：

```text
mvn clean test → JaCoCo 收集覆盖率(report)
    → SonarQube 扫描：展示覆盖率 + 质量门判定
    → JaCoCo check：覆盖率门禁，不达标直接失败
    → Snyk 扫描：依赖/容器漏洞，高危阻断
    → mvn package → 部署
```

GitHub Actions 里各自是一个 step，token 走 secrets：

```yaml
- name: SonarQube Scan
  uses: sonarsource/sonarqube-scan-action@master
  env:
    SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
    SONAR_HOST_URL: ${{ secrets.SONAR_HOST_URL }}
- name: Snyk Security Scan
  uses: snyk/actions/node@master
  env:
    SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
```

任一质量门失败，PR 就被打回，问题代码进不了主干。

## 踩坑与误区

JaCoCo 的误区最多。覆盖率越高越好是错的：100% 覆盖率也不能保证没 Bug，关键是关键逻辑测到位。只看行覆盖率也不行：行覆盖率高但 if 的 false 分支没走到，照样有 Bug。

为凑覆盖率写 `assert(true)` 这类无效测试更不可取，覆盖率虚高没有意义。记住定位：覆盖率是「测试写够了没」的参考，不是「代码好不好」的标准。

SonarQube 不是格式化工具。它管空指针风险、资源未关闭、equals() 未覆盖 hashCode()、SQL 注入、循环嵌套过深这类逻辑问题；缩进、命名、代码风格分别交给 Prettier、ESLint、EditorConfig。

它适合有 CI 基础设施的团队。个人项目或小团队投入产出比不高，没有 CI 时每次手动跑 Scanner 太麻烦；只需要偶尔扫一次，PMD 或 SpotBugs 更轻量。

Snyk 有两个现实约束：商业软件审核严格的场景下无法私有化部署（有私有化方案但限 Enterprise）；免费层的能力、测试次数会调整，采购以官方当前定价为准。

版本也要核对：JaCoCo 0.8.15 是 2026-06-04 发布的稳定版，复制配置时从[官方变更记录](https://www.jacoco.org/jacoco/trunk/doc/changes.html)核对当前稳定版，并确认目标 JDK 的兼容性。

## 小结

三个工具各管一段：JaCoCo 回答测试写够了没，SonarQube 盯自己写的代码质量，Snyk 盯引用的第三方漏洞。合起来，从提交到合并，每道门禁都在 CI 里自动把关。

配合的关键是数据互通：JaCoCo 的覆盖率数据被 SonarQube 引用，SonarQube 的质量门直接引用覆盖率，Snyk 在构建阶段阻断高危依赖。指标可以量化，趋势可以追踪，合并可以被阻断。
