---
title: "根目录磁盘被撑爆实战复盘：29G 分区如何被填满并根治"
description: "Ubuntu 根分区 29G 被占满，Redis 写不了 RDB 快照直接报错。复盘 df/du 逐层定位 MySQL 数据与 systemd 日志两大元凶，并给出清理、迁移、扩容三种方案。"
date: 2026-09-01
tags: ["Linux", "MySQL", "日志", "排障"]
categories: ["运维"]
---

# 根目录磁盘被撑爆实战复盘：29G 分区如何被填满并根治

## 问题：29G 根分区被占满

一台 Ubuntu 服务器的根分区 `/dev/root` 只有 29G，被 100% 占满。最先报警的是 Redis：它无法写入 RDB 快照，直接触发报错。

复盘下来，根目录被撑爆是三个因素叠加的结果：

1. 根分区规划过小，撑不起 MySQL、Redis 等服务的长期数据累积
2. 核心服务都装在根目录下，数据文件全部落在根分区
3. 独立分区 `/data` 有 300G，使用率却只有 3%，长期闲置

排查思路遵循「从整体到局部、从目录到文件」。核心命令就两个：`df` 看磁盘整体使用，`du` 看目录和文件占用。另外要区分物理分区和虚拟文件系统——`tmpfs` 这类虚拟文件系统不占用物理磁盘，别被它误导。

## 排查：df 确认，du 逐层定位

第一步用 `df -h` 看所有挂载分区的空间占用，重点关注根目录的使用率和可用空间：

```bash
df -h
```

关键输出解读：

| 列名 | 本次异常点 |
|---|---|
| Filesystem | `/dev/root` 为根分区 |
| Size | 29G，容量偏小 |
| Use% | 100%，完全占满 |
| Mounted on | `/` 为根目录，`/data` 为独立大容量分区 |

第二步用 `du` 统计根目录下所有子目录的占用，按大小倒序取前 20：

```bash
sudo du -sh /* 2>/dev/null | sort -rh | head -20
```

这条命令值得拆解：`du -sh` 汇总目录大小并以易读单位显示；`/*` 遍历根目录下所有直接子目录；`2>/dev/null` 忽略无权限访问的报错；`sort -rh` 按大小倒序；`head -20` 只取前 20 行。

结果很快就出来了：`/var` 占用 14G，是根目录满的核心元凶。

第三步沿 `/var` 逐层深入：

```bash
sudo du -sh /var/* 2>/dev/null | sort -rh | head -20
sudo du -sh /var/lib/* 2>/dev/null | sort -rh | head -20
```

最终定位到两个占用源：

- `/var/lib/mysql`：10G，MySQL 数据目录
- `/var/log/journal`：1.5G，systemd 二进制日志

如果大目录下没有明显的大子目录，还有一招补充排查：直接找根目录下的超大文件，比如大于 100M 的：

```bash
sudo find / -type f -size +100M 2>/dev/null | xargs ls -lh
```

这招适合单个超大文件（旧备份、没清理的日志）把磁盘撑满的场景。

## 清理：三个场景，先止血

**systemd 日志：用 journalctl，别用 rm**

`/var/log/journal` 是系统服务日志，可以安全清理，但禁止直接 `rm -rf`，必须用 `journalctl` 自带命令：

```bash
# 按大小清理，保留 500M
sudo journalctl --vacuum-size=500M
# 按时间清理，保留 7 天
sudo journalctl --vacuum-time=7d
```

要永久生效，改 `/etc/systemd/journald.conf`：

```text
SystemMaxUse=1G        # 日志总大小上限
SystemMaxFileSize=200M # 单个日志文件上限
MaxRetentionSec=7day   # 日志保留天数
```

改完重启服务：`sudo systemctl restart systemd-journald`。

**MySQL 数据目录：先清 binlog，再处理大表**

`/var/lib/mysql` 不可直接删除，要针对性处理。如果开启了 binlog，旧日志可以安全清理：

```sql
SHOW MASTER STATUS;                      -- 查看当前 binlog
PURGE BINARY LOGS TO 'mysql-bin.000003'; -- 清理旧日志
SET GLOBAL expire_logs_days = 7;         -- 配置自动清理
```

永久生效要写进 `/etc/mysql/mysql.conf.d/mysqld.cnf`，加一行 `expire_logs_days = 7`。

大表处理看用途：无用大表或测试库，备份后删除；生产大表优先归档历史数据。删除测试库：

```sql
DROP DATABASE IF EXISTS test_db;
```

**Redis 旧测试文件：直接删**

本次排查里，Redis 测试目录下的旧 RDB 文件可以安全删除，保留核心数据文件：

```bash
sudo rm -rf /redis/redis-6.2.6/tests/assets/*.rdb
```

## 根治：利用闲置的 /data 分区

清理只是治标。数据还在增长，29G 的根分区迟早再满。根治思路只有一个：把闲置的 300G `/data` 用起来，把服务数据迁过去。

**迁移 MySQL 数据到 /data**

```bash
# 1. 备份 MySQL 数据
sudo mysqldump -u root -p --all-databases > /data/mysql_backup.sql
# 2. 停止服务
sudo systemctl stop mysql
# 3. 迁移数据文件
sudo mkdir -p /data/mysql
sudo rsync -av /var/lib/mysql/* /data/mysql/
sudo chown -R mysql:mysql /data/mysql
# 4. 修改配置：/etc/mysql/mysql.conf.d/mysqld.cnf 增加 datadir = /data/mysql
# 5. Ubuntu 特有：修改 AppArmor 权限 /etc/apparmor.d/usr.sbin.mysqld，增加
#    /data/mysql/ r,
#    /data/mysql/** rwk,
# 6. 重启并验证
sudo systemctl reload apparmor
sudo systemctl start mysql
mysql -u root -p -e "SHOW DATABASES;"
# 7. 确认正常后删除原目录，释放根分区空间
sudo rm -rf /var/lib/mysql
```

AppArmor 是 Ubuntu 上的一个坑：迁移 datadir 后如果忘了改 `/etc/apparmor.d/usr.sbin.mysqld` 的权限，MySQL 会起不来。

**迁移 Redis 数据到 /data**

```bash
sudo systemctl stop redis-server
sudo mkdir -p /data/redis
sudo chown -R redis:redis /data/redis
sudo mv /redis/bin/dump.rdb /data/redis/
```

改 `/etc/redis/redis.conf`，设置 `dir /data/redis`（RDB/AOF 存储目录）和 `dbfilename dump.rdb`，重启后用 `redis-cli set test 123` 验证写操作。

**云服务器扩容兜底**

如果 `/data` 也不够用，云服务器可以在控制台扩容根分区：先把容量从 29G 调到 50G，再在服务器内扩展文件系统：

```bash
sudo resize2fs /dev/root
```

## 踩过的坑与注意事项

1. 禁止直接删除核心目录。`/bin`、`/sbin`、`/usr`、`/boot` 删了系统直接崩溃
2. 删除前先备份。不确定的文件先复制到 `/data` 分区，再执行删除
3. 实时验证清理效果。每清理一次就跑一次 `df -h`，确认可用空间在涨
4. 优先用工具清理。日志、缓存优先用服务自带命令（如 `journalctl`），别一上来就 `rm -rf`
5. AppArmor 权限别漏。Ubuntu 上迁移 MySQL datadir，要同步改 `/etc/apparmor.d/usr.sbin.mysqld`

## 小结

这次排查的流程是：确认整体 → 定位目录 → 排查文件 → 针对性处理 → 长期优化。

临时清理治标，优先清日志、缓存等非核心文件，快速释放空间；架构优化治本，用大容量分区承载服务数据，从根源上避免磁盘再满。

这次排查最大的教训是分区规划：29G 的根分区既要跑系统，又要装 MySQL、Redis 的数据，旁边 300G 的 `/data` 却闲置着。资源不是没有，是用错了地方。
