# 远程桌面组件文档模板与维护清单

本文是 `docs/remote-desktop-components/` 的组件文档模板，也记录当前远程桌面应用目录。新增或更新组件说明时，先对照这里，再更新 `../remote-desktop-component-roadmap.md` 和 README。

## 当前事实源

- 组件注册：`src/RemoteDesktopShell.tsx` 的 `desktopApps`、`desktopAppIconSources`、`defaultWindowFrames`、`renderWindowContent`。
- 类型白名单：`src/vite-env.d.ts` 的 `ShellDeskDesktopAppKey`。
- 持久化白名单：`src-tauri/src/vault.rs` 默认布局与 `src-tauri/src/vault/normalize.rs`。
- 默认布局与迁移：`src/App.tsx`、`src/RemoteDesktopShell.tsx` 的 `remoteDesktopAppCatalogVersion` / `desktopAppCatalogVersion` 和 migration key。
- 导出入口：`src/components/remote-desktop/index.ts`。
- 样式入口：`src/styles/index.scss`。
- 自动检查：`pnpm check:desktop-apps`。

## 已接入组件速查

| appKey | 中文名 | 实现入口 | 文档 |
| --- | --- | --- | --- |
| `files` | 文件管理 | `RemoteFileExplorer.tsx` | `02-file-explorer-redesign.md` |
| `terminal` | 终端 | `RemoteTerminal.tsx` | `01-terminal-redesign.md` |
| `notepad` | 记事本 | `RemoteNotepad.tsx` | `04-notepad-redesign.md` |
| `code-editor` | 代码编辑器 | `RemoteCodeEditor.tsx` | `34-code-editor.md` |
| `browser` | 浏览器 | `RemoteBrowser.tsx` | `03-browser-redesign.md` |
| `vnc` | VNC Viewer | `RemoteVncViewer.tsx` | `05-vnc-viewer-redesign.md` |
| `log-viewer` | 日志查看 | `RemoteLogViewer.tsx` | `13-log-viewer.md` |
| `monitor` | 系统监视器 | `RemoteMonitor.tsx` | `06-system-monitor-redesign.md` |
| `mysql` | MySQL | `RemoteMySQL.tsx` | `07-mysql-redesign.md` |
| `clickhouse` | ClickHouse | `RemoteClickHouse.tsx` | `33-clickhouse-manager.md` |
| `redis` | Redis | `RemoteRedis.tsx` | `08-redis-redesign.md` |
| `service-manager` | 服务管理 | `RemoteServiceManager.tsx` | `12-service-manager.md` |
| `container-manager` | 容器管理 | `RemoteContainerManager.tsx` | `14-docker-podman-manager.md` |
| `port-manager` | 端口监听 | `RemotePortManager.tsx` | `15-port-listener-manager.md` |
| `firewall-manager` | 防火墙 | `RemoteFirewallManager.tsx` | `21-firewall-manager.md` |
| `iptables-manager` | iptables 管理 | `RemoteIptablesManager.tsx` | `25-iptables-manager.md` |
| `network-diagnostics` | 网络诊断 | `RemoteNetworkDiagnostics.tsx` | `16-network-diagnostics.md` |
| `disk-analyzer` | 磁盘分析 | `RemoteDiskAnalyzer.tsx` | `17-disk-space-analyzer.md` |
| `disk-manager` | 磁盘管理 | `RemoteDiskManager.tsx` | `32-disk-manager.md` |
| `package-manager` | 包管理器 | `RemotePackageManager.tsx` | `18-package-manager-center.md` |
| `git-manager` | Git 仓库 | `RemoteGitManager.tsx` | `29-git-repository-manager.md` |
| `cert-manager` | 证书管理 | `RemoteCertManager.tsx` | `35-certificate-manager.md` |
| `nginx-manager` | Nginx 管理 | `RemoteNginxManager.tsx` | `30-nginx-apache-caddy-manager.md` |
| `caddy-manager` | Caddy 管理 | `RemoteCaddyManager.tsx` | `36-caddy-manager.md` |
| `apache-manager` | Apache 管理 | `RemoteApacheManager.tsx` | `37-apache-manager.md` |
| `scheduled-tasks` | 计划任务 | `RemoteScheduledTasks.tsx` | `19-scheduled-task-manager.md` |
| `postgres` | PostgreSQL | `RemotePostgres.tsx` | `20-postgresql-manager.md` |
| `mongo` | MongoDB | `RemoteMongo.tsx` | `26-mongodb-manager.md` |
| `search-cluster` | Elasticsearch / OpenSearch | `RemoteSearchCluster.tsx` | `27-elasticsearch-opensearch-panel.md` |
| `message-queue` | 消息队列 | `RemoteMessageQueuePanel.tsx` | `28-message-queue-panel.md` |
| `s3-browser` | S3 对象管理 | `RemoteS3Browser.tsx` | `31-minio-s3-browser.md` |
| `frp-manager` | FRP 客户端 | `RemoteFrpManager.tsx` | `38-frp-client-manager.md` |
| `frps-manager` | FRP 服务端 | `RemoteFrpsManager.tsx` | `39-frp-server-manager.md` |
| `security-audit` | 安全巡检 | `RemoteSecurityAudit.tsx` | `22-security-audit-panel.md` |
| 设置页 `loginsessions` | 登录会话 | `SettingsLoginSessionsPanel.tsx` | `23-login-session-viewer.md` |
| `api-debugger` | API 调试 | `RemoteApiDebugger.tsx` | `24-api-debugger.md` |
| `procmanager` | 进程管理 | `RemoteProcessManager.tsx` | `10-process-manager-redesign.md` |
| `ai-chat` | AI 助手 | `RemoteAiChat.tsx` | `40-ai-assistant.md` |
| `settings` | 系统设置 | `RemoteSettings.tsx` | `11-system-settings-redesign.md` |
| `sqlite` | SQLite | `RemoteSqlite.tsx` | `09-sqlite-redesign.md` |

## 组件文档模板

```md
# 组件名称

> 当前状态：已接入远程桌面（appKey: `example-key`），实现入口为 `src/components/remote-desktop/RemoteExample.tsx`。

## 定位

说明这个组件解决什么问题，主要用户场景是什么，和相邻组件的边界在哪里。

## 当前实现范围

- 已经可用的核心功能。
- 已经接入的系统类型或后端能力。
- 与其他组件的联动。

## 代码落点

- `src/components/remote-desktop/RemoteExample.tsx`
- `src/components/remote-desktop/exampleProviders.ts`
- `src/styles/remote-desktop/_example.scss`
- `src/assets/desktop-icons/example.png`
- `src/RemoteDesktopShell.tsx`

## 设计边界

- 当前不做什么。
- 哪些操作有安全确认。
- 哪些平台只是降级支持。

## 后续增强

- 短期可做但尚未落地的事项。
```

## 新增或改名检查清单

- 在 `src/components/remote-desktop/` 新增组件和必要的 parser/provider/utils。
- 在 `src/components/remote-desktop/index.ts` 导出组件。
- 在 `src/RemoteDesktopShell.tsx` 添加 lazy import、`desktopApps`、图标、默认窗口尺寸和 `renderWindowContent` 分支。
- 在 `src/vite-env.d.ts` 更新 `ShellDeskDesktopAppKey`。
- 在 `src/assets/desktop-icons/` 增加图标。
- 在 `src/styles/remote-desktop/` 增加样式，并在 `src/styles/index.scss` 中 `@use`。
- 在 `src/i18nCatalog.ts` 增加中英文 label、description 和组件文案。
- 在 `src-tauri/src/vault.rs` 与 `src-tauri/src/vault/normalize.rs` 更新默认布局和白名单。
- 如果默认要迁移到现有用户布局，更新 `src/App.tsx` 和 `src/RemoteDesktopShell.tsx` 的 catalog version 与 migration key。
- 更新本文、单组件文档、`../remote-desktop-component-roadmap.md` 和 README。
- 跑 `pnpm check:desktop-apps`，涉及类型或文案时再跑对应检查。
