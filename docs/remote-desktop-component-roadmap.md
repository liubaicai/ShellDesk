# ShellDesk 远程桌面组件路线图

截至 2026-05-27，ShellDesk 远程桌面工作台已经形成一组可直接使用的内置应用，并保留一组按优先级排序的扩展组件设计文档。

本文档包含材料：

- `remote-desktop-components/`：已实现或已纳入远程桌面的组件文档，当前编号 `01-31`。

组件排序综合考虑：

- 与 ShellDesk 图形化 SSH 客户端定位的契合度。
- 用户日常运维、开发和排障的使用频率。
- 对现有 `runCommand`、SFTP、终端、数据库、VNC、浏览器和窗口系统能力的复用程度。
- 实现复杂度与短期收益比例。
- 后续插件化、组件化时的示范价值。

## 已实现与归档组件

下列组件已经作为远程桌面现有能力管理，相关文档集中放在 `remote-desktop-components/`。

| 编号 | 组件 | 文档 | 当前设计重点 |
| --- | --- | --- | --- |
| 01 | 终端 | [终端组件重设计](./remote-desktop-components/01-terminal-redesign.md) | 多会话、输出检索、终端工具菜单、与文件/记事本协作 |
| 02 | 文件管理器 | [文件管理器组件重设计](./remote-desktop-components/02-file-explorer-redesign.md) | SFTP 导航、传输、压缩解压、详情与打开方式入口 |
| 03 | 浏览器 | [浏览器组件重设计](./remote-desktop-components/03-browser-redesign.md) | 远程网络上下文、书签、错误诊断、安全边界 |
| 04 | 记事本 | [记事本组件重设计](./remote-desktop-components/04-notepad-redesign.md) | 远程文本编辑、保存安全、代码高亮、自定义模态 |
| 05 | VNC Viewer | [VNC Viewer 组件重设计](./remote-desktop-components/05-vnc-viewer-redesign.md) | VNC 探测、代理连接、缩放和输入控制 |
| 06 | 系统监视器 | [系统监视器组件重设计](./remote-desktop-components/06-system-monitor-redesign.md) | 系统状态、指标摘要、进程跳转 |
| 07 | MySQL | [MySQL 管理器组件重设计](./remote-desktop-components/07-mysql-redesign.md) | schema 浏览、SQL 查询、结果查看和基础编辑 |
| 08 | Redis | [Redis 管理器组件重设计](./remote-desktop-components/08-redis-redesign.md) | SCAN 浏览、类型化值查看、命令执行和风险操作 |
| 09 | SQLite | [SQLite 管理器组件重设计](./remote-desktop-components/09-sqlite-redesign.md) | 远程 SQLite 文件入口、对象树、查询和单元格编辑 |
| 10 | 进程管理器 | [进程管理器组件重设计](./remote-desktop-components/10-process-manager-redesign.md) | 资源排序、进程详情、信号操作、端口组件联动 |
| 11 | 系统设置 | [系统设置组件重设计](./remote-desktop-components/11-system-settings-redesign.md) | 系统配置边界、草稿应用、危险变更提示 |
| 12 | 服务管理器 | [服务管理器](./remote-desktop-components/12-service-manager.md) | systemd / Windows Services 列表、状态、日志和启停操作 |
| 13 | 日志查看器 | [日志查看器](./remote-desktop-components/13-log-viewer.md) | journalctl、文件日志、Windows Event Log、搜索和分页 |
| 14 | Docker / Podman 管理器 | [Docker / Podman 管理器](./remote-desktop-components/14-docker-podman-manager.md) | 容器、镜像、卷、网络和常用容器操作 |
| 15 | 端口与监听管理器 | [端口与监听管理器](./remote-desktop-components/15-port-listener-manager.md) | `ss` / `netstat` / PowerShell 端口列表、进程详情跳转 |
| 16 | 网络诊断工具箱 | [网络诊断工具箱](./remote-desktop-components/16-network-diagnostics.md) | Ping、DNS、Trace、HTTP、TCP、路由表诊断 |
| 17 | 磁盘空间分析器 | [磁盘空间分析器](./remote-desktop-components/17-disk-space-analyzer.md) | 目录体积扫描、大文件定位、文件管理器联动 |
| 18 | 包管理器中心 | [包管理器中心](./remote-desktop-components/18-package-manager-center.md) | apt/yum/dnf/pacman/zypper/winget/choco 检测、搜索和操作命令 |
| 19 | 计划任务管理器 | [计划任务管理器](./remote-desktop-components/19-scheduled-task-manager.md) | crontab、systemd timer、Windows Task Scheduler |
| 20 | PostgreSQL 管理器 | [PostgreSQL 管理器](./remote-desktop-components/20-postgresql-manager.md) | PostgreSQL 连接、schema/表浏览、SQL 查询 |
| 21 | 防火墙管理器 | [防火墙管理器](./remote-desktop-components/21-firewall-manager.md) | ufw、firewalld、Windows Firewall 状态、规则、新增/删除确认 |
| 22 | 安全巡检面板 | [安全巡检面板](./remote-desktop-components/22-security-audit-panel.md) | SSH 配置、高权限账号、失败登录、端口、敏感权限和报告复制 |
| 23 | 登录会话查看器 | [登录会话查看器](./remote-desktop-components/23-login-session-viewer.md) | 在线用户、成功登录、失败登录、来源聚合和详情复制 |
| 24 | API 调试器 | [API 调试器](./remote-desktop-components/24-api-debugger.md) | 远程 curl 请求、Header/Body、响应查看、JSON 格式化和历史 |
| 25 | iptables 管理器 | [iptables 管理器](./remote-desktop-components/25-iptables-manager.md) | IPv4/IPv6 iptables 规则链、默认策略、运行时新增/删除、nft 兼容层提示 |
| 26 | MongoDB 管理器 | [MongoDB 管理器](./remote-desktop-components/26-mongodb-manager.md) | SSH 隧道连接 MongoDB、数据库/集合浏览、文档查询和索引查看 |
| 27 | Elasticsearch / OpenSearch 面板 | [Elasticsearch / OpenSearch 面板](./remote-desktop-components/27-elasticsearch-opensearch-panel.md) | 集群健康、索引、分片和 `_search` 查询诊断 |
| 28 | RabbitMQ / Kafka 简易面板 | [RabbitMQ / Kafka 简易面板](./remote-desktop-components/28-message-queue-panel.md) | RabbitMQ 队列、Kafka topic、consumer group lag 和原始诊断输出 |
| 29 | Git 仓库管理器 | [Git 仓库管理器](./remote-desktop-components/29-git-repository-manager.md) | Sourcetree 风格 Git 状态、分支管理、变更文件、diff、暂存/提交、fetch、pull、push |
| 30 | Nginx / Apache / Caddy 管理器 | [Nginx / Apache / Caddy 管理器](./remote-desktop-components/30-nginx-apache-caddy-manager.md) | Web 服务检测、站点配置摘要、记事本配置修改、配置测试、reload 和 restart |
| 31 | MinIO / S3 浏览器 | [MinIO / S3 浏览器](./remote-desktop-components/31-minio-s3-browser.md) | 基于远程 `mc` / `aws` CLI 浏览 bucket、prefix、对象，支持删除、下载和复制 URL |
