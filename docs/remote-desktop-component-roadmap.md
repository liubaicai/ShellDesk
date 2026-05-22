# ShellDesk 远程桌面组件优先级建议

本文档包含两组设计材料：

- 现有远程桌面组件的重新设计文档，不受当前已实现功能边界约束。
- 40 个可扩展远程桌面组件的优先级建议与详细设计文档。

40 个扩展组件的排序综合考虑：

- 与 ShellDesk 图形化 SSH 客户端定位的契合度
- 用户日常使用频率
- 对现有 `runCommand`、SFTP、数据库和 VNC IPC 能力的复用程度
- 实现复杂度与短期收益比例
- 后续插件化、组件化时的示范价值

## 现有组件重新设计

下列文档针对当前远程桌面已有应用重新设计，重点讨论它们作为 ShellDesk 基础工作台能力时应该承担的职责、边界和后续开发计划。

| 组件 | 重新设计文档 | 设计重点 |
| --- | --- | --- |
| 终端 | [终端组件重设计](./remote-desktop-existing-components/01-terminal-redesign.md) | 多会话、分屏、输出检索、与其他工具协作 |
| 文件管理器 | [文件管理器组件重设计](./remote-desktop-existing-components/02-file-explorer-redesign.md) | 导航、传输、批量操作、打开方式入口 |
| 浏览器 | [浏览器组件重设计](./remote-desktop-existing-components/03-browser-redesign.md) | 远程网络上下文、书签、错误诊断、安全边界 |
| 记事本 | [记事本组件重设计](./remote-desktop-existing-components/04-notepad-redesign.md) | 多文件编辑、保存安全、冲突处理、diff |
| VNC Viewer | [VNC Viewer 组件重设计](./remote-desktop-existing-components/05-vnc-viewer-redesign.md) | 连接诊断、输入控制、缩放、性能模式 |
| 系统监视器 | [系统监视器组件重设计](./remote-desktop-existing-components/06-system-monitor-redesign.md) | 健康摘要、趋势、诊断跳转 |
| MySQL | [MySQL 管理器组件重设计](./remote-desktop-existing-components/07-mysql-redesign.md) | schema 浏览、查询工作区、受控编辑 |
| Redis | [Redis 管理器组件重设计](./remote-desktop-existing-components/08-redis-redesign.md) | SCAN 浏览、类型化值查看、命令风险 |
| SQLite | [SQLite 管理器组件重设计](./remote-desktop-existing-components/09-sqlite-redesign.md) | 文件数据库入口、对象树、查询安全 |
| 进程管理器 | [进程管理器组件重设计](./remote-desktop-existing-components/10-process-manager-redesign.md) | 资源排序、详情、信号操作、组件联动 |
| 系统设置 | [系统设置组件重设计](./remote-desktop-existing-components/11-system-settings-redesign.md) | 系统配置边界、草稿应用、危险变更提示 |

## 推荐优先级

| 优先级 | 组件 | 简要功能介绍 |
| --- | --- | --- |
| 1 | 服务管理器 | 管理 Linux `systemd`、Windows Services 等服务，支持查看状态、启动、停止、重启、开机自启、查看最近日志。 |
| 2 | 日志查看器 | 聚合 `journalctl`、`/var/log/*`、Nginx/Apache/App 日志，支持实时 tail、搜索、过滤、错误高亮和快速定位。 |
| 3 | Docker / Podman 管理器 | 管理容器、镜像、卷、网络和 compose 项目，支持查看日志、进入容器、启动停止、删除和拉取镜像。 |
| 4 | 端口与监听管理器 | 查看远程主机监听端口、占用进程、协议、绑定地址，支持跳转进程详情或终止进程。 |
| 5 | 网络诊断工具箱 | 图形化封装 ping、traceroute、mtr、nslookup、dig、curl、tcping、speedtest 等常用网络诊断命令。 |
| 6 | 磁盘空间分析器 | 扫描目录体积，找出大目录、大文件、缓存、日志和构建产物，帮助快速清理磁盘空间。 |
| 7 | 包管理器中心 | 支持 `apt`、`yum`、`dnf`、`pacman`、`zypper`、`winget`、`choco` 等包管理器的搜索、安装、卸载和升级。 |
| 8 | 计划任务管理器 | 管理 crontab、systemd timer、Windows Task Scheduler，支持新增、编辑、启停、查看下次执行时间和执行历史。 |
| 9 | PostgreSQL 管理器 | 连接和管理 PostgreSQL，支持库表浏览、SQL 查询、结果查看、基础编辑和连接配置保存。 |
| 10 | SSH 隧道管理器 | 管理本地转发、远程转发和动态 SOCKS，支持保存常用隧道配置、启动停止和状态查看。 |
| 11 | Git 仓库管理器 | 查看远程目录中的 Git 状态、分支、diff、提交记录，支持 fetch、pull、checkout 等轻量维护操作。 |
| 12 | 代码部署面板 | 将常用部署流程图形化，支持拉代码、构建、重启服务、回滚、查看执行日志和部署历史。 |
| 13 | 防火墙管理器 | 管理 ufw、firewalld、iptables、nftables、Windows Firewall，支持开放/关闭端口、规则查看和基础校验。 |
| 14 | Nginx / Apache 管理器 | 查看站点配置、启停/reload 服务、配置测试、虚拟主机编辑、证书路径和访问/错误日志入口。 |
| 15 | 远程搜索器 | 按文件名、内容、扩展名、大小、修改时间搜索远程文件，结果可直接打开文件或定位目录。 |
| 16 | 文件差异比较器 | 比较两个远程文件，或比较远程文件与本地缓存版本，适合配置文件变更检查。 |
| 17 | 备份/同步面板 | 图形化管理 rsync、scp、tar 等备份同步任务，显示备份历史、体积、耗时和执行结果。 |
| 18 | 命令收藏夹 / Snippet 面板 | 保存常用命令模板，支持变量填充、分类、复制、执行和连接维度的常用命令沉淀。 |
| 19 | 任务仪表盘 | 将常用命令和检查项变成按钮或卡片，例如清缓存、重启服务、查看状态、拉取代码。 |
| 20 | 多主机批量执行器 | 对多个主机同时执行命令，实时汇总输出、成功失败状态和耗时，适合批量巡检与维护。 |
| 21 | 安全巡检面板 | 检查 SSH 配置风险、sudo 用户、弱权限文件、异常开放端口、登录失败记录等安全项。 |
| 22 | 登录会话查看器 | 汇总 `who`、`w`、`last`、`lastb` 等信息，查看当前登录用户、历史登录、失败登录和来源 IP。 |
| 23 | 证书管理器 | 查看 TLS 证书有效期、证书链、域名匹配、Nginx/Apache 证书路径和 certbot 状态。 |
| 24 | 环境变量管理器 | 管理 `.env`、shell profile、systemd service env 等配置，支持敏感字段遮蔽和修改前后对比。 |
| 25 | JSON / YAML / TOML 编辑器 | 面向远程配置文件的结构化编辑器，支持格式化、语法校验、折叠、搜索和差异预览。 |
| 26 | API 调试器 | 通过远程主机网络环境发起 HTTP 请求，适合测试内网 API、服务健康检查和接口调试。 |
| 27 | 密钥与授权管理器 | 管理远程 `authorized_keys`、用户 SSH 登录权限、密钥注释、启用状态和最后修改信息。 |
| 28 | 权限编辑器 | 图形化修改 chmod、chown、ACL 等权限信息，可作为文件管理器的增强入口。 |
| 29 | 压缩包浏览器 | 查看 zip、tar、gz 等压缩包内容，支持选择性解压、整体解压和压缩包基本信息查看。 |
| 30 | 批量重命名工具 | 对远程文件批量重命名，支持规则预览、编号、替换、大小写转换和撤销提示。 |
| 31 | 健康检查卡片生成器 | 自定义检查项并生成服务器健康报告，覆盖系统、网络、磁盘、服务、端口和安全摘要。 |
| 32 | 会话录制/回放 | 记录终端命令、关键输出、文件操作和诊断步骤，用于审计、复盘或交接。 |
| 33 | 远程剪贴板 / 临时便签 | 保存当前连接相关的临时命令、路径、账号提示、排查笔记和待办事项。 |
| 34 | MongoDB 管理器 | 管理 MongoDB 数据库、集合和文档，支持查询、查看索引、基础编辑和连接配置。 |
| 35 | Elasticsearch / OpenSearch 面板 | 查看集群健康、节点、索引、分片状态，支持基础查询和常见运维操作。 |
| 36 | RabbitMQ / Kafka 简易面板 | 查看队列、topic、consumer、consumer lag 和基础消息状态，适合中间件运维排查。 |
| 37 | MinIO / S3 浏览器 | 浏览对象存储 bucket 和对象，支持上传、下载、删除、预签名链接和基础元信息查看。 |
| 38 | 正则 / 文本处理工具箱 | 图形化封装 grep、sed、awk、jq 等文本处理能力，用于日志分析、配置提取和批量转换。 |
| 39 | Hosts / DNS 工具 | 专注 hosts 和 DNS 解析诊断，支持解析链路检查、hosts 修改、DNS 服务器测试和缓存提示。 |
| 40 | 远程桌面启动器 | 作为连接后的工作台首页，展示最近文件、最近命令、常用服务、常用路径和告警摘要。 |

## 分阶段建议

第一阶段优先做 1-8：这些组件最贴近日常运维，且大多可以复用现有 SSH 命令执行和文件能力，短期收益高。

第二阶段推进 9-20：补齐开发、部署、网络和批量管理能力，让 ShellDesk 从“连接工具”升级为“远程工作台”。

第三阶段考虑 21-33：强化安全、审计、配置维护和辅助工作流，提升专业用户黏性。

第四阶段扩展 34-40：覆盖更多中间件和工作台体验，适合作为后续插件化生态的候选方向。
