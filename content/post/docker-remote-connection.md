---
title: "Docker 远程连接：2375 配置、验证与 CA 证书加固"
description: "从 systemd 单元文件入手给 dockerd 开启 TCP 2375 监听，用 curl 访问 /version 验证远程可用，再讲裸端口不加密不鉴权的风险，以及按官方文档用 CA 证书做 TLS 加固的思路。"
date: 2026-09-01
tags: ["Docker", "TLS", "安全"]
categories: ["运维"]
---

# Docker 远程连接：2375 配置、验证与 CA 证书加固

## 为什么要开远程连接

Docker 装好后，daemon 默认只监听本机的 unix socket。本机的 docker 命令和容器都能正常用，但换一台机器就完全连不上。

最常见的场景：开发机上用 IDE 的 Docker 插件直接操作服务器上的 daemon，改完配置直接推上去跑，不用每次 ssh 敲命令。

做法分三步：开 TCP 监听、验证远程可访问、最后补上安全措施。

## 开启 TCP 监听

daemon 由 systemd 管理，监听地址写在单元文件里。修改 `/lib/systemd/system/docker.service`，在 `ExecStart=` 后追加 `-H tcp://0.0.0.0:2375`：

```bash
vi /lib/systemd/system/docker.service

# 修改后形如
# ExecStart=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock -H tcp://0.0.0.0:2375
```

注意是追加参数，原有的 unix socket 参数要保留，否则本机命令也会失效。改完重新加载并重启：

```bash
systemctl daemon-reload
systemctl restart docker
```

`0.0.0.0` 表示监听所有网卡，包括公网接口，端口一开就暴露在整个网络上。

## 验证远程访问

在另一台机器上直接访问 HTTP 接口：

```text
http://<ip-address>:2375/version
```

能返回 JSON 就说明远程通道通了。实际返回节选如下：

```json
{
  "Version": "27.3.1",
  "ApiVersion": "1.47",
  "MinAPIVersion": "1.24",
  "Os": "linux",
  "Arch": "amd64",
  "GoVersion": "go1.22.7",
  "KernelVersion": "5.14.0-522.el9.x86_64",
  "Components": [
    { "Name": "Engine", "Version": "27.3.1" },
    { "Name": "containerd", "Version": "1.7.22" },
    { "Name": "runc", "Version": "1.1.14" },
    { "Name": "docker-init", "Version": "0.19.0" }
  ]
}
```

版本号对得上，说明连的就是目标机器的真实 daemon。

## IDEA 连接 Docker

开发侧用 IDEA 的 Docker 插件。装好插件后添加 Docker 服务，编辑连接时把地址指向刚开好的 TCP 2375 端点，保存后就能在 IDEA 里看到远程镜像和容器。

对开发学习来说，到这里远程连接已经够用了。

## 裸 2375 的风险

2375 走的是 HTTP 明文，且没有任何鉴权。只要能访问到这个端口，任何人都能直接调用 Docker API。

Docker API 是完整的管理面：拉镜像、起容器、挂载目录、执行命令都包含在内。端口一旦暴露在公网，等于把服务器的控制权交出去。所以裸 2375 只适合内网或本机开发环境，公网可到达的场景都应先加固。

## 用 CA 证书加固

加固的思路是给 TCP 通道加 TLS：创建 CA 证书，再用它分别签发服务端和客户端证书，让 daemon 与客户端互相验证身份。生成步骤以官方文档为准：

- 官方文档：[Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/#create-a-ca-server-and-client-keys-with-openssl)（用 openssl 创建 CA、服务端和客户端密钥）
- 中文参考：[CSDN 参考步骤](https://blog.csdn.net/sg_knight/article/details/126319965)

证书生成后按官方文档把证书配置到 daemon 和客户端，连接就从明文变成双向认证的 TLS。客户端侧的环境变量可等真正用到时再配置。

## 小结

流程本身不长：改 systemd 单元文件给 dockerd 加 TCP 监听，用 `http://ip:2375/version` 验证，再让 IDEA 这类工具直连。

关键认知有两条。一是 `0.0.0.0` 监听所有网卡，端口一开就全网络可达；二是裸 2375 只有方便、没有安全，开发学习够用，任何公网或生产场景都要用 CA 证书做 TLS 双向认证。
