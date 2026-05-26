# ShellDesk 远程桌面组件路线图

截至 2026-05-27，ShellDesk 远程桌面工作台已经形成一组可直接使用的内置应用，并保留一组按优先级排序的扩展组件设计文档。

本文档包含两组材料：

- `remote-desktop-existing-components/`：已实现或已纳入远程桌面的组件文档，当前编号 `01-31`。
- `remote-desktop-components/`：尚未实现的扩展组件设计文档，保留原优先级编号；完成项会迁移到 existing 归档。

组件排序综合考虑：

- 与 ShellDesk 图形化 SSH 客户端定位的契合度。
- 用户日常运维、开发和排障的使用频率。
- 对现有 `runCommand`、SFTP、终端、数据库、VNC、浏览器和窗口系统能力的复用程度。
- 实现复杂度与短期收益比例。
- 后续插件化、组件化时的示范价值。

## 已实现与归档组件

下列组件已经作为远程桌面现有能力管理，相关文档集中放在 `remote-desktop-existing-components/`。其中前 11 项偏“已有组件重设计”，后续项为已经从扩展清单中完成并归档的远程工具。

| 编号 | 组件 | 文档 | 当前设计重点 |
| --- | --- | --- | --- |
| 01 | 终端 | [终端组件重设计](./remote-desktop-existing-components/01-terminal-redesign.md) | 多会话、输出检索、终端工具菜单、与文件/记事本协作 |
| 02 | 文件管理器 | [文件管理器组件重设计](./remote-desktop-existing-components/02-file-explorer-redesign.md) | SFTP 导航、传输、压缩解压、详情与打开方式入口 |
| 03 | 浏览器 | [浏览器组件重设计](./remote-desktop-existing-components/03-browser-redesign.md) | 远程网络上下文、书签、错误诊断、安全边界 |
| 04 | 记事本 | [记事本组件重设计](./remote-desktop-existing-components/04-notepad-redesign.md) | 远程文本编辑、保存安全、代码高亮、自定义模态 |
| 05 | VNC Viewer | [VNC Viewer 组件重设计](./remote-desktop-existing-components/05-vnc-viewer-redesign.md) | VNC 探测、代理连接、缩放和输入控制 |
| 06 | 系统监视器 | [系统监视器组件重设计](./remote-desktop-existing-components/06-system-monitor-redesign.md) | 系统状态、指标摘要、进程跳转 |
| 07 | MySQL | [MySQL 管理器组件重设计](./remote-desktop-existing-components/07-mysql-redesign.md) | schema 浏览、SQL 查询、结果查看和基础编辑 |
| 08 | Redis | [Redis 管理器组件重设计](./remote-desktop-existing-components/08-redis-redesign.md) | SCAN 浏览、类型化值查看、命令执行和风险操作 |
| 09 | SQLite | [SQLite 管理器组件重设计](./remote-desktop-existing-components/09-sqlite-redesign.md) | 远程 SQLite 文件入口、对象树、查询和单元格编辑 |
| 10 | 进程管理器 | [进程管理器组件重设计](./remote-desktop-existing-components/10-process-manager-redesign.md) | 资源排序、进程详情、信号操作、端口组件联动 |
| 11 | 系统设置 | [系统设置组件重设计](./remote-desktop-existing-components/11-system-settings-redesign.md) | 系统配置边界、草稿应用、危险变更提示 |
| 12 | 服务管理器 | [服务管理器](./remote-desktop-existing-components/12-service-manager.md) | systemd / Windows Services 列表、状态、日志和启停操作 |
| 13 | 日志查看器 | [日志查看器](./remote-desktop-existing-components/13-log-viewer.md) | journalctl、文件日志、Windows Event Log、搜索和分页 |
| 14 | Docker / Podman 管理器 | [Docker / Podman 管理器](./remote-desktop-existing-components/14-docker-podman-manager.md) | 容器、镜像、卷、网络和常用容器操作 |
| 15 | 端口与监听管理器 | [端口与监听管理器](./remote-desktop-existing-components/15-port-listener-manager.md) | `ss` / `netstat` / PowerShell 端口列表、进程详情跳转 |
| 16 | 网络诊断工具箱 | [网络诊断工具箱](./remote-desktop-existing-components/16-network-diagnostics.md) | Ping、DNS、Trace、HTTP、TCP、路由表诊断 |
| 17 | 磁盘空间分析器 | [磁盘空间分析器](./remote-desktop-existing-components/17-disk-space-analyzer.md) | 目录体积扫描、大文件定位、文件管理器联动 |
| 18 | 包管理器中心 | [包管理器中心](./remote-desktop-existing-components/18-package-manager-center.md) | apt/yum/dnf/pacman/zypper/winget/choco 检测、搜索和操作命令 |
| 19 | 计划任务管理器 | [计划任务管理器](./remote-desktop-existing-components/19-scheduled-task-manager.md) | crontab、systemd timer、Windows Task Scheduler |
| 20 | PostgreSQL 管理器 | [PostgreSQL 管理器](./remote-desktop-existing-components/20-postgresql-manager.md) | PostgreSQL 连接、schema/表浏览、SQL 查询 |
| 21 | 防火墙管理器 | [防火墙管理器](./remote-desktop-existing-components/21-firewall-manager.md) | ufw、firewalld、Windows Firewall 状态、规则、新增/删除确认 |
| 22 | 安全巡检面板 | [安全巡检面板](./remote-desktop-existing-components/22-security-audit-panel.md) | SSH 配置、高权限账号、失败登录、端口、敏感权限和报告复制 |
| 23 | 登录会话查看器 | [登录会话查看器](./remote-desktop-existing-components/23-login-session-viewer.md) | 在线用户、成功登录、失败登录、来源聚合和详情复制 |
| 24 | API 调试器 | [API 调试器](./remote-desktop-existing-components/24-api-debugger.md) | 远程 curl 请求、Header/Body、响应查看、JSON 格式化和历史 |
| 25 | iptables 管理器 | [iptables 管理器](./remote-desktop-existing-components/25-iptables-manager.md) | IPv4/IPv6 iptables 规则链、默认策略、运行时新增/删除、nft 兼容层提示 |
| 26 | MongoDB 管理器 | [MongoDB 管理器](./remote-desktop-existing-components/26-mongodb-manager.md) | SSH 隧道连接 MongoDB、数据库/集合浏览、文档查询和索引查看 |
| 27 | Elasticsearch / OpenSearch 面板 | [Elasticsearch / OpenSearch 面板](./remote-desktop-existing-components/27-elasticsearch-opensearch-panel.md) | 集群健康、索引、分片和 `_search` 查询诊断 |
| 28 | RabbitMQ / Kafka 简易面板 | [RabbitMQ / Kafka 简易面板](./remote-desktop-existing-components/28-message-queue-panel.md) | RabbitMQ 队列、Kafka topic、consumer group lag 和原始诊断输出 |
| 29 | Git 仓库管理器 | [Git 仓库管理器](./remote-desktop-existing-components/29-git-repository-manager.md) | 远程 Git 状态、变更文件、diff、提交记录、fetch、pull 和 checkout |
| 30 | Nginx / Apache / Caddy 管理器 | [Nginx / Apache / Caddy 管理器](./remote-desktop-existing-components/30-nginx-apache-caddy-manager.md) | Web 服务检测、站点配置摘要、配置测试、reload 和 restart |
| 31 | MinIO / S3 浏览器 | [MinIO / S3 浏览器](./remote-desktop-existing-components/31-minio-s3-browser.md) | 基于远程 `mc` / `aws` CLI 浏览 bucket、prefix、对象，支持删除、下载和复制 URL |

## 剩余扩展组件优先级

`remote-desktop-components/` 中保留的是尚未实现的扩展文档。下面的优先级沿用原始编号；已完成的 `02`、`04`、`21` 已迁移到 existing 归档。

| 优先级 | 组件 | 设计文档 | 简要功能介绍 |
| --- | --- | --- | --- |
| 01 | SSH 隧道管理器 | [SSH 隧道管理器](./remote-desktop-components/01-ssh-tunnel-manager.md) | 管理本地转发、远程转发和动态 SOCKS，支持保存常用隧道、启动停止和状态查看。 |
| 03 | 代码部署面板 | [代码部署面板](./remote-desktop-components/03-deployment-panel.md) | 将常用部署流程图形化，支持拉代码、构建、重启服务、回滚、查看执行日志和部署历史。 |
| 05 | 远程搜索器 | [远程搜索器](./remote-desktop-components/05-remote-searcher.md) | 按文件名、内容、扩展名、大小、修改时间搜索远程文件，结果可直接打开或定位目录。 |
| 06 | 文件差异比较器 | [文件差异比较器](./remote-desktop-components/06-file-diff-viewer.md) | 比较两个远程文件，或比较远程文件与本地缓存版本，适合配置文件变更检查。 |
| 07 | 备份/同步面板 | [备份/同步面板](./remote-desktop-components/07-backup-sync-panel.md) | 图形化管理 rsync、scp、tar 等备份同步任务，显示历史、体积、耗时和执行结果。 |
| 08 | 命令收藏夹 / Snippet 面板 | [命令收藏夹 / Snippet 面板](./remote-desktop-components/08-command-snippets.md) | 保存常用命令模板，支持变量填充、分类、复制、执行和连接维度沉淀。 |
| 09 | 任务仪表盘 | [任务仪表盘](./remote-desktop-components/09-task-dashboard.md) | 将常用命令和检查项变成按钮或卡片，例如清缓存、重启服务、查看状态、拉取代码。 |
| 10 | 多主机批量执行器 | [多主机批量执行器](./remote-desktop-components/10-multi-host-runner.md) | 对多个主机同时执行命令，实时汇总输出、成功失败状态和耗时。 |
| 11 | 证书管理器 | [证书管理器](./remote-desktop-components/11-certificate-manager.md) | 查看 TLS 证书有效期、证书链、域名匹配、Nginx/Apache 证书路径和 certbot 状态。 |
| 12 | 环境变量管理器 | [环境变量管理器](./remote-desktop-components/12-environment-variable-manager.md) | 管理 `.env`、shell profile、systemd service env 等配置，支持敏感字段遮蔽和修改前后对比。 |
| 13 | JSON / YAML / TOML 编辑器 | [JSON / YAML / TOML 编辑器](./remote-desktop-components/13-structured-config-editor.md) | 面向远程配置文件的结构化编辑器，支持格式化、语法校验、折叠、搜索和差异预览。 |
| 14 | 密钥与授权管理器 | [密钥与授权管理器](./remote-desktop-components/14-authorized-keys-manager.md) | 管理远程 `authorized_keys`、用户 SSH 登录权限、密钥注释、启用状态和最后修改信息。 |
| 15 | 权限编辑器 | [权限编辑器](./remote-desktop-components/15-permission-editor.md) | 图形化修改 chmod、chown、ACL 等权限信息，可作为文件管理器增强入口。 |
| 16 | 压缩包浏览器 | [压缩包浏览器](./remote-desktop-components/16-archive-browser.md) | 查看 zip、tar、gz 等压缩包内容，支持选择性解压、整体解压和基础元信息查看。 |
| 17 | 批量重命名工具 | [批量重命名工具](./remote-desktop-components/17-batch-rename-tool.md) | 对远程文件批量重命名，支持规则预览、编号、替换、大小写转换和撤销提示。 |
| 18 | 健康检查卡片生成器 | [健康检查卡片生成器](./remote-desktop-components/18-health-check-report.md) | 自定义检查项并生成服务器健康报告，覆盖系统、网络、磁盘、服务、端口和安全摘要。 |
| 19 | 会话录制/回放 | [会话录制/回放](./remote-desktop-components/19-session-recorder.md) | 记录终端命令、关键输出、文件操作和诊断步骤，用于审计、复盘或交接。 |
| 20 | 远程剪贴板 / 临时便签 | [远程剪贴板 / 临时便签](./remote-desktop-components/20-remote-notes-clipboard.md) | 保存当前连接相关的临时命令、路径、账号提示、排查笔记和待办事项。 |
| 22 | 正则 / 文本处理工具箱 | [正则 / 文本处理工具箱](./remote-desktop-components/22-text-processing-toolbox.md) | 图形化封装 grep、sed、awk、jq 等文本处理能力，用于日志分析、配置提取和批量转换。 |
| 23 | Hosts / DNS 工具 | [Hosts / DNS 工具](./remote-desktop-components/23-hosts-dns-tool.md) | 专注 hosts 和 DNS 解析诊断，支持解析链路检查、hosts 修改、DNS 服务器测试和缓存提示。 |
| 24 | 远程桌面启动器 | [远程桌面启动器](./remote-desktop-components/24-remote-desktop-launcher.md) | 作为连接后的工作台首页，展示最近文件、最近命令、常用服务、常用路径和告警摘要。 |

## 分阶段建议

下一阶段优先做剩余 `01-10`：这些组件补齐隧道、部署、搜索、备份和多主机执行能力，能直接建立远程工作台的日常操作闭环。

随后推进 `11-20`：重点增强证书、环境变量、结构化配置、授权密钥、权限、压缩包、批量文件操作、健康报告和会话审计，让安全与配置维护更完整。

最后推进剩余 `22-24`：覆盖文本处理、Hosts/DNS 和工作台首页体验，适合作为后续插件化生态的候选组件。
