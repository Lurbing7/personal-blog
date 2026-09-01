---
title: "Nginx 网关进阶：auth_request 前置鉴权与日志轮转"
description: "用 auth_request 把鉴权前置到 Nginx 网关：子请求 200 放行、401/403 拦截；再讲日志为什么不能直接 rm，以及 logrotate 轮转与 Docker 挂载的要点。"
date: 2026-09-01
tags: ["Nginx", "鉴权", "日志"]
categories: ["运维"]
---

# Nginx 网关进阶：auth_request 前置鉴权与日志轮转

## 网关要解决的两件事

Nginx 常被当作 API 网关使用：轻量、高性能，单机可扛数万并发，内存占用低，配置灵活。静态资源、反向代理、负载均衡、限流鉴权，都可以在这一层统一收口。

流量收口后，有两件事绕不开。一是鉴权：每个后端服务各自实现一遍校验，重复且容易漏，不如在网关前置统一裁决。二是日志：access.log 和 error.log 只增不减，处理不当会占满磁盘。这篇讲 auth_request 前置鉴权和日志轮转这两个基础能力。

## auth_request：子请求鉴权

auth_request 的思路是「子请求鉴权」：正式转发前，Nginx 先向一个内部 location 发一个子请求，由鉴权服务裁决。

```text
客户端请求 /api/xxx
    ↓
Nginx 先发子请求到 /auth → 鉴权服务返回 200 则通过
    ↓
鉴权通过 → 转发原请求到后端 /api/xxx
鉴权失败 → 返回 401/403
```

子请求返回 200，原请求照常转发到后端；返回 401/403，客户端直接收到鉴权失败，请求到不了后端。

## 配置与要点

```nginx
server {
    listen       80;
    server_name  api.example.com;

    location /api/ {
        auth_request /auth;
        proxy_pass http://backend-server:8080/;
    }

    location = /auth {
        internal;
        proxy_pass http://auth-server:8080/verify$is_args$args;
        proxy_pass_request_body off;
        proxy_set_header Content-Type "";
    }
}
```

关键配置项：

- `auth_request /auth`：指定鉴权子请求的 internal location，转发前先执行
- `internal`：`/auth` 只接受内部子请求，外部访问不到；`=` 精确匹配优先级最高，不会被其他 location 拦截
- `proxy_pass_request_body off`：鉴权请求不携带原始 body，避免把大请求体重复传给鉴权服务
- `proxy_set_header Content-Type ""`：清空 Content-Type，避免鉴权服务误读
- `$is_args$args`：把原请求的查询参数拼到鉴权路径上，鉴权服务可按参数校验

两个实操要点。一是改完配置先 `nginx -t` 检查语法，确认无误再 `nginx -s reload` 热重载，reload 不会中断服务。二是 `internal` 不能省，它保证鉴权路径只能被内部子请求访问。

## 日志轮转：不能直接删

access.log 和 error.log 会持续增长，长期不处理会占满磁盘。最直觉的清理方式是 `rm`，但这对 Nginx 行不通：进程持有文件句柄，删了文件磁盘空间也不会释放，日志还直接丢了。

正确的手动清空是不动文件、只清内容：

```bash
truncate -s 0 /var/log/nginx/access.log
truncate -s 0 /var/log/nginx/error.log
```

`truncate` 把文件截断为 0 字节，不影响 Nginx 进程。

误删了可以补救：重建空文件、恢复属主、再 reload 刷新文件句柄。

```bash
touch /var/log/nginx/access.log
chown nginx:nginx /var/log/nginx/access.log
nginx -s reload
```

手动清理只能应急，常态还是要交给 logrotate 自动轮转。

## logrotate 自动轮转

在 `/etc/logrotate.d/nginx` 写一个轮转配置，logrotate 会按计划自动执行：

```nginx
/var/log/nginx/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0640 nginx nginx
    postrotate
        if [ -f /var/run/nginx.pid ]; then
            kill -USR1 `cat /var/run/nginx.pid`
        fi
    endscript
}
```

指令含义：`daily` 每天轮转一次；`rotate 7` 保留 7 份旧日志；`compress` 压缩旧日志；`delaycompress` 延迟一天压缩，保证当天日志可读；`missingok` 文件不存在不报错；`notifempty` 空文件不轮转；`create` 指定新文件的权限和属主。

轮转后日志文件被改名，Nginx 还握着旧句柄，所以 `postrotate` 里用 `kill -USR1` 通知 Nginx 重新打开日志文件。

测试配置：

```bash
logrotate -d /etc/logrotate.d/nginx   # 模拟执行，不实际生效
logrotate -f /etc/logrotate.d/nginx   # 强制执行一次
```

Docker 环境注意：logrotate 配置在宿主机上，日志路径要写成挂载的宿主机目录，而不是容器内的 `/var/log/nginx`。

## 小结

网关统一收口后，横切逻辑就能前置。鉴权交给 auth_request：子请求 200 放行、401/403 拦截，后端不用各写一套。日志交给 logrotate：truncate 应急、daily + rotate 7 自动兜底，旧日志压缩保留。

两个必须记住的点：鉴权入口要配 `internal`；日志文件永远不要直接 `rm`。
