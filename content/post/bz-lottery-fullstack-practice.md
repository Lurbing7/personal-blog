---
title: "抽奖平台从开发到上线：全栈 + CI/CD + 服务器部署实践"
description: "Spring Boot 3 + Vue 3 抽奖平台：双端 Web 规划、GitHub Actions + SSH + Docker Compose 发布链路，以及阿里云 ECS 拉取 Docker Hub 镜像失败后的打包方案。"
date: 2026-09-01
tags: ["Spring Boot", "Vue 3", "GitHub Actions", "Docker", "CI/CD", "项目实践"]
categories: ["项目实践"]
---

# 抽奖平台从开发到上线：全栈 + CI/CD + 服务器部署实践

## 项目是什么

`bz-lottery` 是一个基于 Spring Boot 3 + Vue 3 的个人抽奖平台项目。定位不是练习 Demo，而是打磨成可演示、可复用、可接单改造的小型业务系统模板。

适用场景很广：年会抽奖、社群活动抽奖、商家营销活动、会员积分抽奖、直播间抽奖后台、小型活动运营系统。

项目仓库：[Lurbing7/bz-lottery](https://github.com/Lurbing7/bz-lottery)（公开）

产品上规划了双端 Web：

```text
/admin   PC 运营后台（活动运营、奖品中心、中奖记录、AI 分析）
/app     手机 Web 用户端（活动首页、抽奖页、我的记录）
/login   共用登录入口
```

PC 端定位运营后台，信息密度高、管理效率优先，风格偏 SaaS 后台；手机端定位用户参与，移动优先，抽奖按钮、奖池、结果反馈要突出，底部 Tab 导航，不依赖 PC hover。

App 化走渐进路线：手机 H5 → PWA → Capacitor 包壳，每一步都有可展示成果，不一开始陷入多端工程复杂度。

## 技术栈与第一版架构

- 后端：Spring Boot 3，按微服务规划拆分（gateway / user / award / lottery / ai）
- 前端：Vue 3，一套项目同时承载 PC 后台和手机 H5
- 基础设施：Nginx（入口）、PostgreSQL 17（数据）、Redis 7（缓存和登录态）

第一版先上线最小闭环，而不是把所有服务一次性推上去：

```text
Nginx(80) → 前端 dist（Vue build）
          → gateway（lottery-gateway.jar 打镜像）
          → PostgreSQL / Redis
```

完整业务微服务（lottery-user、lottery-award、lottery-lottery、lottery-ai）、Nacos、消息队列留到后续逐步补。

## AI 辅助开发

这个项目也是 AI 辅助全栈实践：开发过程中使用 Claude 和 Codex 辅助编码、问题排查和文档撰写。

AI 的定位是效率工具：

- 重复性代码和排障交给 AI，提升开发速度
- 关键设计决策（服务边界、部署方案）由我判断
- AI 输出一律人工核验，以真实构建和线上结果为准

## 上线链路：GitHub Actions + SSH + Docker Compose

第一版发布方案是 GitHub Actions + SSH + Docker Compose，目标是把网站跑到阿里云 ECS 上。

Workflow 在 `.github/workflows/deploy-prod.yml`，两种触发：推送到 `main` 且改动命中部署路径，或手动点击 `Run workflow`。

仓库配置五个 Secrets：

- `ALIYUN_HOST`：ECS 公网 IP
- `ALIYUN_USER`：SSH 用户
- `ALIYUN_SSH_KEY`：SSH 私钥
- `ALIYUN_SSH_PORT`：SSH 端口
- `ALIYUN_DEPLOY_DIR`：部署目录

整个发布分三个阶段：

```text
构建：checkout → setup Java 25 → mvn package gateway jar
      → setup Node → npm ci → npm run build
打包：gateway jar + 前端 dist + 运行镜像 → release bundle
部署：scp 上传 → 解压到 releases/<commit-sha>
      → 更新 current 软链接 → 执行 deploy-prod.sh
```

服务器侧脚本做四件事：前端 dist 拷到 Nginx html、`prod.env` 缺失时从模板复制、创建数据目录、`docker compose up -d --no-build` 拉起 postgres/redis/gateway/nginx。

服务器目录约定：

```text
/opt/bz-lottery
├─ packages/      上传的压缩包
├─ releases/      每次发布的版本
└─ current -> releases/<commit-sha>
```

`current` 永远指向当前运行版本，回滚时指回上一个 `releases/<sha>` 再执行部署脚本即可。这套结构天然支持版本化发布和回滚。

## 最大的坑：ECS 拉不动 Docker Hub 镜像

上线时遇到一连串镜像解析失败。

先是 Redis：

```text
failed to resolve reference "docker.io/library/redis:7.4-alpine": not found
```

改成 `redis:7-alpine` 仍然失败。把 Redis 镜像放进 release bundle 后成功加载，紧接着 Nginx 又失败：

```text
failed to resolve reference "docker.io/library/nginx:1.29-alpine": not found
```

排查结论：不是单个镜像 tag 的问题，而是 ECS 当前 Docker registry 链路对 Docker Hub 官方镜像解析不稳定。

处理方式：**不让 ECS 侧拉取生产运行镜像**。

- GitHub Actions 在 runner 上拉取 Nginx、PostgreSQL、Redis
- GitHub Actions 在 runner 上构建 Gateway 镜像
- 用 `docker save | gzip` 把镜像打进 release bundle
- ECS 部署时先 `docker load`，再 `docker compose up -d --no-build`

这个方案适合早期个人项目：不用先接入镜像仓库，部署链路就能跑通。代价是 release bundle 变大、上传时间增加。项目稳定后应升级为推送到阿里云容器镜像服务 ACR。

## 服务器准备踩坑

第一次碰 Linux 服务器部署，接连遇到好几个问题：

- **部署用户没有 sudo**：`deploy is not in the sudoers file`，系统软件改用 root 安装，`deploy` 只负责 Docker 部署
- **Ubuntu 没有 yum**：`Command 'yum' not found`，Ubuntu/Debian 系用 `apt`
- **Docker 官方源握手失败**：GPG key / TLS 握手问题，不纠结官方源，直接用阿里云 Ubuntu 镜像源安装 `docker.io docker-compose-v2`
- **docker-compose 旧命令不存在**：Compose v2 已装，用 `docker compose`
- **加入 docker 组后要重新登录**：`usermod -aG docker` 后必须重新 SSH 登录，权限才生效
- **安全组最小开放**：只开 22 和 80；PostgreSQL 5432、Redis 6379 不暴露公网

安装验证输出：

```text
Docker version 29.1.3
Docker Compose version 2.40.3
```

## 现状与后续

第一版上线后的验证方式：服务器 `docker ps` 看容器、浏览器打开 ECS 公网 IP 看页面、`/actuator/health` 看 gateway 健康检查。

一个典型的判断：页面能打开但登录或抽奖接口失败，说明前端静态站点已经上线，业务微服务还需要继续部署。

后续增强清单：

- 补齐所有业务微服务的 Compose 服务
- 接入 Nacos 服务发现
- 接入 HTTPS
- 增加数据库备份脚本和失败回滚流程
- 用阿里云容器镜像服务替代镜像打包传输

## 小结

这个项目的收获不在功能，而在一人项目的工程决策：

1. **不先上 Jenkins 和镜像仓库**：GitHub Actions 免费额度 + SSH + Docker Compose，够早期使用，出问题能直接 SSH 看日志
2. **镜像传输方案**：生产环境网络拉不动 Docker Hub 时，用 `docker save/load` 把镜像随发布包传过去，是真实生产里会遇到的网络约束
3. **版本化发布**：`releases/<sha>` + `current` 软链接，回滚路径从一开始就存在

先跑通最小闭环，再逐步补微服务、HTTPS 和监控，每一步都有可演示的成果。
