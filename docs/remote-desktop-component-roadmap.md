# ShellDesk 远程桌面组件路线图

截至 2026-07-05，ShellDesk 远程桌面已经接入 39 个远程桌面 appKey，另有 1 个设置页登录会话面板。本文档用于说明当前应用目录、组件文档位置和后续维护规则；单组件细节放在 `remote-desktop-components/`。

## 事实源

远程桌面组件是否真实接入，以代码里的注册表为准：

- `src/RemoteDesktopShell.tsx`
  - `desktopApps`
  - `desktopAppIconSources`
  - `defaultWindowFrames`
  - `renderWindowContent`
  - `desktopAppCatalogVersion`
  - `appCatalogMigrationKeys`
- `src/vite-env.d.ts` 的 `ShellDeskDesktopAppKey`
- `src-tauri/src/vault.rs` 默认远程桌面布局和 `src-tauri/src/vault/normalize.rs` 的远程组件白名单
- `src/components/remote-desktop/index.ts` 的组件导出
- `src/styles/index.scss` 的远程桌面样式入口

`docs/remote-desktop-components/_example.md` 是新增或更新组件文档时的模板与检查清单。

## 当前已接入组件

| 编号 | appKey | 组件 | 文档 | 当前设计重点 |
| --- | --- | --- | --- | --- |
| 01 | `terminal` | 终端 | [终端组件重设计](./remote-desktop-components/01-terminal-redesign.md) | xterm.js 会话、russh PTY 后端、终端工具菜单、可选 tmux 默认会话、命令请求、文件/记事本/AI 协作 |
| 02 | `files` | 文件管理器 | [文件管理器组件重设计](./remote-desktop-components/02-file-explorer-redesign.md) | SFTP 导航、传输、压缩解压、权限、打开方式和路径联动 |
| 03 | `browser` | 浏览器 | [浏览器组件重设计](./remote-desktop-components/03-browser-redesign.md) | Tauri 代理、远程网络上下文、书签、错误诊断 |
| 04 | `notepad` | 记事本 | [记事本组件重设计](./remote-desktop-components/04-notepad-redesign.md) | 远程文本编辑、多标签、语法高亮、冲突提示、自定义模态 |
| 05 | `vnc` | VNC Viewer | [VNC Viewer 组件重设计](./remote-desktop-components/05-vnc-viewer-redesign.md) | VNC 探测、SSH 隧道、noVNC、缩放和输入控制 |
| 06 | `monitor` | 系统监视器 | [系统监视器组件重设计](./remote-desktop-components/06-system-monitor-redesign.md) | 实时指标、SQLite 历史、阈值告警、服务健康、进程管理器跳转 |
| 07 | `mysql` | MySQL | [MySQL 管理器组件重设计](./remote-desktop-components/07-mysql-redesign.md) | SSH 隧道连接、schema 浏览、SQL 查询、结果查看、编辑和 CSV/JSON 导入导出 |
| 08 | `redis` | Redis | [Redis 管理器组件重设计](./remote-desktop-components/08-redis-redesign.md) | SCAN 浏览、类型化值查看、命令执行和风险操作 |
| 09 | `sqlite` | SQLite | [SQLite 管理器组件重设计](./remote-desktop-components/09-sqlite-redesign.md) | 远程 SQLite 文件入口、对象树、查询、表预览和单元格编辑 |
| 10 | `procmanager` | 进程管理器 | [进程管理器组件重设计](./remote-desktop-components/10-process-manager-redesign.md) | 进程搜索、资源排序、详情、终止操作、端口联动 |
| 11 | `settings` | 系统设置 | [系统设置组件重设计](./remote-desktop-components/11-system-settings-redesign.md) | 系统信息、网络、DNS、镜像源、更新、Hosts、路由、磁盘视图 |
| 12 | `service-manager` | 服务管理器 | [服务管理器](./remote-desktop-components/12-service-manager.md) | systemd / Windows Services 列表、状态、日志、启停和 enable/disable |
| 13 | `log-viewer` | 日志查看器 | [日志查看器](./remote-desktop-components/13-log-viewer.md) | journalctl、文件日志、手动路径、关注置顶、Windows Event Log、搜索和分页 |
| 14 | `container-manager` | Docker / Podman 管理器 | [Docker / Podman 管理器](./remote-desktop-components/14-docker-podman-manager.md) | 容器、镜像、卷、网络、日志、inspect 和常用操作 |
| 15 | `port-manager` | 端口与监听管理器 | [端口与监听管理器](./remote-desktop-components/15-port-listener-manager.md) | `ss` / `netstat` / PowerShell 端口列表、连接状态、进程跳转 |
| 16 | `network-diagnostics` | 网络诊断工具箱 | [网络诊断工具箱](./remote-desktop-components/16-network-diagnostics.md) | Ping、DNS、Trace、HTTP、TCP、路由表诊断 |
| 17 | `disk-analyzer` | 磁盘空间分析器 | [磁盘空间分析器](./remote-desktop-components/17-disk-space-analyzer.md) | 目录体积扫描、大文件定位、文件管理器联动 |
| 18 | `package-manager` | 包管理器中心 | [包管理器中心](./remote-desktop-components/18-package-manager-center.md) | apt/yum/dnf/pacman/zypper/apk/winget/choco 检测、搜索和操作命令 |
| 19 | `scheduled-tasks` | 计划任务管理器 | [计划任务管理器](./remote-desktop-components/19-scheduled-task-manager.md) | crontab、systemd timer、Windows Task Scheduler |
| 20 | `postgres` | PostgreSQL 管理器 | [PostgreSQL 管理器](./remote-desktop-components/20-postgresql-manager.md) | PostgreSQL 连接、schema/表浏览、SQL 查询、CSV/JSON 导入 |
| 21 | `firewall-manager` | 防火墙管理器 | [防火墙管理器](./remote-desktop-components/21-firewall-manager.md) | ufw、firewalld、Windows Firewall 状态、规则、新增/删除确认 |
| 22 | `security-audit` | 安全巡检面板 | [安全巡检面板](./remote-desktop-components/22-security-audit-panel.md) | SSH 配置、高权限账号、失败登录、端口、敏感权限和报告复制 |
| 23 | 设置页 `loginsessions` | 登录会话设置面板 | [登录会话查看器](./remote-desktop-components/23-login-session-viewer.md) | 已迁入系统设置页，提供在线用户、成功登录、失败登录、来源聚合和详情复制 |
| 24 | `api-debugger` | API 调试器 | [API 调试器](./remote-desktop-components/24-api-debugger.md) | 远程 curl 请求、Header/Body、响应查看、JSON 格式化和历史 |
| 25 | `iptables-manager` | iptables 管理器 | [iptables 管理器](./remote-desktop-components/25-iptables-manager.md) | IPv4/IPv6 iptables 规则链、默认策略、运行时新增/删除、nft 提示 |
| 26 | `mongo` | MongoDB 管理器 | [MongoDB 管理器](./remote-desktop-components/26-mongodb-manager.md) | SSH 隧道连接、数据库/集合浏览、文档查询和索引查看 |
| 27 | `search-cluster` | Elasticsearch / OpenSearch 面板 | [Elasticsearch / OpenSearch 面板](./remote-desktop-components/27-elasticsearch-opensearch-panel.md) | 集群健康、索引、分片和 `_search` 查询诊断 |
| 28 | `message-queue` | RabbitMQ / Kafka 面板 | [RabbitMQ / Kafka 简易面板](./remote-desktop-components/28-message-queue-panel.md) | RabbitMQ 队列、Kafka topic、consumer group lag 和原始诊断输出 |
| 29 | `git-manager` | Git 仓库管理器 | [Git 仓库管理器](./remote-desktop-components/29-git-repository-manager.md) | 分支、变更、Diff、提交历史、暂存/提交、fetch、pull、push |
| 30 | `nginx-manager` | Nginx 管理器 | [Nginx 管理器](./remote-desktop-components/30-nginx-apache-caddy-manager.md) | Nginx 站点扫描、模板、可视化编辑、配置测试和 reload |
| 31 | `s3-browser` | MinIO / S3 浏览器 | [MinIO / S3 浏览器](./remote-desktop-components/31-minio-s3-browser.md) | 远程 `mc` / `aws` CLI 浏览 bucket、prefix、对象，删除和下载 |
| 32 | `disk-manager` | 磁盘管理器 | [磁盘管理器](./remote-desktop-components/32-disk-manager.md) | 物理磁盘、分区、挂载/卸载、格式化、分区维护和 Linux LVM |
| 33 | `clickhouse` | ClickHouse 管理器 | [ClickHouse 管理器](./remote-desktop-components/33-clickhouse-manager.md) | ClickHouse HTTP 接口、库表列浏览、SQL 查询、CSV/JSON 导入、只读表预览和可视化表结构编辑 |
| 34 | `code-editor` | 代码编辑器 | [代码编辑器](./remote-desktop-components/34-code-editor.md) | 远程项目树、多标签编辑、内嵌终端、远程变更提示和 SD-Agent |
| 35 | `cert-manager` | 证书管理器 | [证书管理器](./remote-desktop-components/35-certificate-manager.md) | TLS 证书扫描、Certbot 续期、续期任务、受信任根证书维护 |
| 36 | `caddy-manager` | Caddy 管理器 | [Caddy 管理器](./remote-desktop-components/36-caddy-manager.md) | Caddyfile 站点块、模板、配置测试、保存和 reload |
| 37 | `apache-manager` | Apache 管理器 | [Apache 管理器](./remote-desktop-components/37-apache-manager.md) | Apache/httpd 虚拟主机、模板、启用/禁用、配置测试和 reload |
| 38 | `frp-manager` | FRP 客户端 | [FRP 客户端](./remote-desktop-components/38-frp-client-manager.md) | frpc 检测/安装、proxy 配置、状态、日志、自启动和 admin API |
| 39 | `frps-manager` | FRP 服务端 | [FRP 服务端](./remote-desktop-components/39-frp-server-manager.md) | frps 检测/安装、Dashboard、proxy 状态、日志、自启动和连接示例 |
| 40 | `ai-chat` | AI 助手 | [AI 助手](./remote-desktop-components/40-ai-assistant.md) | 远程上下文对话、共享工具、Markdown 渲染、打开设置和组件 |

## Dock 与桌面布局

- Dock 固定应用：`files`、`terminal`、`browser`。
- Dock 位置、大小、自动隐藏和固定应用由应用设置里的“桌面”子菜单配置；远程桌面窗口最大化和拖拽边界会按 Dock 所在边和大小预留空间。
- 其他应用默认从桌面、Launchpad 或文件夹打开；窗口打开后会动态加入 Dock，关闭后消失。
- 默认桌面布局仍只放 `files`、`terminal`、`browser`、`settings`，新增应用通过目录迁移进入可用应用集合。
- 当前 app catalog version 为 `13`。新增 appKey 时必须同步迁移版本和白名单，避免用户拖到桌面的图标被 vault 清洗掉。

## 文档维护规则

新增或修改远程桌面组件时，同步检查：

- 单组件文档顶部必须写清楚 `appKey` 和实现入口。
- 若组件已实现，不要只保留“首版计划”；要补 `当前实现范围`、代码落点和设计边界。
- 如果一个旧组件拆分成多个实际 app，应明确旧文件是否仅保留历史说明。
- README 里的功能概览要与本路线图一致。
- 更新后至少运行 `pnpm check:desktop-apps`，涉及类型、翻译或 IPC 时运行对应检查。
