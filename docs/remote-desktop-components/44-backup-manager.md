# 备份管理器

<!-- current-implementation:start -->
## 当前实现状态

- 接入状态：已接入远程桌面目录，appKey 为 `backup-manager`；注册、窗口、图标、翻译和渲染分支由合同检查覆盖。
- 能力声明：平台 `linux / windows / macos`；模式 `management`；权限 `sudo-optional`。
- 依赖探测：Linux `—`；Windows `—`；macOS `—`。存在依赖时由 Launchpad 连接级探测并显示缺失原因。
- 验证边界：启动合同为 `automated-contract`；完整业务流程仍为 `environment-required`，没有真实主机证据时不得写成已验证通过。
- 最后同步：2026-07-28；详见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
<!-- current-implementation:end -->

> 当前状态：已接入远程桌面（appKey: `backup-manager`），实现入口为 `src/components/remote-desktop/RemoteBackupManager.tsx`。

## 定位

备份管理器统一处理远程文件目录和 MySQL、PostgreSQL、MongoDB、SQLite 数据库的备份、校验、下载、对象存储传输与恢复。它复用 ShellDesk 已有的 SSH 命令流、SFTP 下载、S3 / MinIO 命令和计划任务入口，不替代数据库工作台、文件管理器或对象浏览器。

## 当前实现范围

- 创建文件 / 目录 `tar.gz` 备份，并在 Unix 主机上支持 GNU tar listed-incremental 快照。
- 使用 `mysqldump`、`pg_dump`、`mongodump` 和 SQLite `.backup` 创建数据库备份。
- 在当前 ShellDesk 备份目录中列出、搜索、校验、下载、恢复和删除历史备份。
- 校验 SHA-256，并按备份类型执行 tar / gzip、`pg_restore --list`、`mongorestore --dryRun` 或 SQLite `quick_check`。
- 备份完成后可保留在远端、通过现有 SFTP 下载到本机，或通过现有 S3 / MinIO provider 上传。
- Unix 使用带 ShellDesk 标记的 crontab 与远程包装脚本；Windows 使用当前用户的 Task Scheduler 与 PowerShell 包装脚本创建定时计划。
- 计划任务不保存当前输入的数据库密码，并可跳转到计划任务管理器继续维护。
- Windows 和 Unix 分别生成原生脚本；执行过程通过 `runCommandStream` 持续显示输出。
- 响应式布局以备份组件窗口自身宽度为准，窄窗口会重排统计卡、表单、预览和历史操作区。

## 代码落点

- `src/components/remote-desktop/RemoteBackupManager.tsx`
- `src/components/remote-desktop/backupCommands.ts`
- `src/components/remote-desktop/backupParsers.ts`
- `src/components/remote-desktop/backupTypes.ts`
- `src/styles/remote-desktop/_backup-manager.scss`
- `src/assets/desktop-icons/backup-manager.png`
- `src/RemoteDesktopShell.tsx`

## 命令与安全

- 所有远程操作复用 `window.guiSSH.connections`，不新增系统 SSH fallback。
- 数据库密码只进入远程命令的 stdin 脚本，不出现在安全预览、确认弹窗、备份历史或计划定义中。
- 保存的备份配置只包含非敏感连接参数；S3 / MinIO 密钥仅保留在当前组件会话。
- 删除、恢复和删除计划均使用渲染到 `document.body` 的自定义确认弹窗。
- 名称、路径、数据库参数和计划 ID 在生成脚本前执行长度、字符或 shell 转义约束。
- 计划任务需要远程主机已配置 `.my.cnf`、`.pgpass` 或其他无交互认证方式，不会把临时密码固化到脚本。

## 设计边界

- 当前历史列表只扫描配置的 ShellDesk 备份目录，不建立额外的远程索引数据库。
- 文件增量备份依赖 Unix 主机的 GNU tar；Windows 文件备份为完整归档。
- S3 / MinIO 上传依赖远端已有并配置可用的 `mc` 或 `aws` CLI。
- 恢复数据库前会先执行格式校验，但不会替代业务级一致性检查或恢复后的验收。
- 不安装数据库客户端、压缩工具或对象存储 CLI；缺少工具时给出可见状态和错误。

## 后续增强

- 增加备份保留策略、自动清理和跨目录历史索引。
- 在后端支持可取消流式任务后，增加任务级取消和后台进度。
- 为大体积备份增加分段上传、断点续传和传输速率统计。
