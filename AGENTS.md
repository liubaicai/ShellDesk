# ShellDesk — AI Agent Instructions

Electron 40 + React 19 + TypeScript + Vite 图形化 SSH 客户端。pnpm（当前 `pnpm@10.26.2`）为包管理器。

## 构建与运行

```bash
pnpm dev            # 并行启动 Vite (127.0.0.1:5173) + Electron
pnpm dev:electron   # 等待 Vite 就绪后启动 Electron（通常由 pnpm dev 调用）
pnpm typecheck      # tsc --noEmit
pnpm build          # pnpm typecheck && vite build
pnpm test           # 当前等同于 pnpm build
pnpm preview        # Vite preview，绑定 127.0.0.1
pnpm start          # 直接运行 Electron（需要已有构建或可加载入口）
pnpm rebuild        # electron-builder install-app-deps
pnpm release        # Windows x64 NSIS 安装包，publish=never
pnpm release:dir    # pnpm pack:dir 的别名
pnpm pack:dir       # 构建后输出 unpacked 目录
pnpm pack           # 构建后按 electron-builder 默认目标打包
pnpm pack:win       # Windows x64 + arm64
pnpm pack:win-x64   # Windows x64
pnpm pack:win-arm64 # Windows arm64
pnpm pack:mac       # macOS
pnpm pack:linux     # Linux
pnpm pack:linux-x64 # Linux x64
pnpm pack:linux-arm64 # Linux arm64
```

**已知坑**：`pnpm dev` 退出后 Vite 可能残留占用 5173 端口。先用 `netstat -ano | findstr :5173` 找到占用 PID，再只对该 PID 执行 `taskkill /PID <pid> /F` 或 `Stop-Process -Id <pid>`，不要粗暴 kill 全部 node 进程。

## AI 开发测试变量

- 如果仓库根目录存在 `.env` 文件，AI Agent 在需要连接测试服务器进行开发、调试或验证时，应先读取其中的测试 SSH 变量，用于自动填充测试服务器连接信息。
- 推荐变量名：`SHELLDESK_TEST_SSH_HOST`、`SHELLDESK_TEST_SSH_PORT`、`SHELLDESK_TEST_SSH_USERNAME`、`SHELLDESK_TEST_SSH_PASSWORD`。
- `.env` 只用于本地测试凭据，不要提交到仓库；提交的样例请使用 `.env.example`，并只放占位值。
- 不要在日志、终端输出、提交信息或回复中明文展示 `SHELLDESK_TEST_SSH_PASSWORD`。如果 `.env` 不存在或变量为空，应跳过自动连接并说明缺少测试凭据，不要臆造服务器信息。

## 架构概览

```
electron/
  main.cjs        # 主进程入口：应用生命周期、注册各类 handler、退出清理
  preload.cjs     # contextBridge 暴露 window.guiSSH 到渲染进程
  main/
    windows.cjs              # BrowserWindow 创建、窗口 IPC、导航保护、webContents guard
    ipc.cjs                  # registerIpcHandler 包装错误处理
    connectionManager.cjs    # 活跃 SSH 连接、terminal channel、SSH forwardOut、清理回调
    connectionHandlers.cjs   # SSH connect/disconnect/get-info、终端 IPC 能力
    remoteConnectionHandlers.cjs # 远程命令、SFTP、文件读写/传输、压缩解压、状态与指标
    databaseHandlers.cjs     # MySQL/PostgreSQL/Redis/SQLite 管理，数据库连接经 SSH 隧道或远程命令
    vncHandlers.cjs          # VNC 探测、SSH 隧道、noVNC/WebSocket 代理
    configHandlers.cjs       # 配置导入导出、密钥导入生成、日志、偏好、字体列表
    vaultStore.cjs           # 本地 vault/config/log/bookmark/settings 存取与校验
    aiHandlers.cjs           # AI 模型列表、chat、stream chat
    constants.cjs            # 共享常量、上限、枚举
    validation.cjs           # IPC 入参校验、命令/路径/字符串处理
    systemFonts.cjs          # 系统字体枚举
src/
  App.tsx                  # 主页：主机/密钥/日志/设置、vault 同步、连接入口
  main.tsx                 # React 入口，导入全局样式
  i18n.ts                  # zh-CN / en-US 文案与 useShellDeskI18n
  fontUtils.ts             # 字体工具
  RemoteDesktop.tsx        # re-export RemoteDesktopShell
  RemoteDesktopShell.tsx   # 远程桌面：桌面图标/文件夹/Launchpad、多窗口管理器、Dock、布局设置
  styles/
    index.scss      # 全局样式入口，按级联顺序 @use 模块
    _tokens.scss    # 字体、CSS 变量、主题 token
    foundations/    # reset、基础元素、全局行为
    layout/         # 应用壳、顶部栏、侧边导航
    pages/          # 主机、密钥、日志、设置等页面样式
    remote-desktop/ # 远程桌面 shell、Dock、终端、文件、数据库、监控、运维工具样式
    themes/         # 浅色主题与远程应用主题覆盖
  assets/
    desktop-icons/  # 远程桌面应用图标
    images/         # 应用图标、默认桌面壁纸
    os-icons/       # 主机系统图标
  vite-env.d.ts     # window.guiSSH 类型定义（ShellDeskApi）和全局类型
  components/
    navigation/NavIcon.tsx
    remote-desktop/
      index.ts            # 远程桌面组件 barrel export
      types.ts            # RemoteConnectionInfo / RemoteSystemType
      remoteSystem.ts     # Windows/Linux 命令差异与 PowerShell stdin command 工具
      desktopUtils.ts     # formatDateTime, getErrorMessage
      terminalPresets.ts  # xterm 主题与字体栈
      *Utils.ts / *Providers.ts / *Parsers.ts # 各远程应用的解析、provider、工具函数
      RemoteTerminal.tsx       # xterm.js 多会话终端
      RemoteFileExplorer.tsx   # SFTP 文件管理器（Windows 风格）
      RemoteFilePicker.tsx     # 远程文件选择器（SQLite 等复用）
      RemoteNotepad.tsx        # 远程记事本（highlight.js 代码高亮）
      RemoteBrowser.tsx        # Electron webview 浏览器
      RemoteVncViewer.tsx      # noVNC 远程桌面查看器
      RemoteMonitor.tsx        # 系统状态监控
      RemoteMySQL.tsx / RemotePostgres.tsx / RemoteRedis.tsx / RemoteSqlite.tsx
      RemoteProcessManager.tsx / RemoteServiceManager.tsx / RemoteContainerManager.tsx
      RemotePortManager.tsx / RemoteFirewallManager.tsx / RemoteNetworkDiagnostics.tsx
      RemoteDiskAnalyzer.tsx / RemoteDiskManager.tsx / RemotePackageManager.tsx / RemoteScheduledTasks.tsx
      RemoteSecurityAudit.tsx / RemoteLoginSessions.tsx / RemoteLogViewer.tsx
      RemoteApiDebugger.tsx / RemoteSettings.tsx
  pages/
    KeysPage.tsx    # SSH 密钥管理
    LogsPage.tsx    # 本地日志页
    SettingsPage.tsx # 应用设置页
  types/
    novnc.d.ts      # noVNC 类型补充
```

## 关键设计决策

### IPC 通信模式
- **主进程**：`electron/main.cjs` 调用 `registerConfigHandlers` / `registerAiHandlers` / `registerConnectionHandlers` / `registerRemoteConnectionHandlers` / `registerDatabaseHandlers` / `registerVncHandlers`，具体 IPC 放在 `electron/main/*.cjs`
- **IPC 包装**：优先使用 `registerIpcHandler(channel, handler)` 统一把异常转成可读错误；文件选择等少数场景直接 `ipcMain.handle`
- **预加载**：`electron/preload.cjs` 通过 `contextBridge.exposeInMainWorld('guiSSH', {...})` 暴露 API，分组为 `window` / `files` / `vault` / `logs` / `preferences` / `system` / `ai` / `connections` / `events`
- **渲染进程**：通过 `window.guiSSH.connections.xxx()`、`window.guiSSH.vault.xxx()` 等调用，不要直接使用 Node/Electron API
- **类型定义**：`src/vite-env.d.ts` 维护 `ShellDeskApi`、`ShellDeskConnectionControls`、数据库/VNC/AI/vault 等全局类型
- 新增 IPC 需同步修改：对应 `electron/main/*Handlers.cjs` handler + `electron/preload.cjs` bridge + `src/vite-env.d.ts` 类型；如涉及远程桌面应用，再同步组件调用和错误文案

### 远程桌面窗口系统
- `RemoteDesktopShell.tsx` 管理 `DesktopWindowState[]`，每个窗口有 `appKey`；当前应用包括 files/terminal/notepad/browser/vnc/log-viewer/monitor/mysql/redis/service-manager/container-manager/port-manager/firewall-manager/iptables-manager/network-diagnostics/disk-analyzer/disk-manager/package-manager/git-manager/web-server-manager/scheduled-tasks/postgres/mongo/search-cluster/message-queue/s3-browser/security-audit/login-sessions/api-debugger/procmanager/settings/sqlite
- `desktopApps`、`desktopAppIconSources`、`defaultWindowFrames`、`renderWindowContent` 是新增远程桌面应用时必须检查的核心位置
- `ShellDeskRemoteDesktopLayout` 保存桌面排序、应用图标和文件夹布局；默认桌面应用为 files/terminal/browser/settings
- 窗口支持拖拽移动、缩放、最大化，使用 `transform: translate3d` 定位
- **右键菜单/弹窗**必须用 `createPortal` 渲染到 `document.body`，否则受 `transform` 影响导致定位错乱
- **Dock 栏规则**：`dockPinnedApps` 定义固定显示在底部 Dock 的应用（files/terminal/browser），其他应用仅在桌面/Launchpad/文件夹中显示，但当其窗口打开时会动态追加到 Dock 栏（关闭后消失）
- 新增远程桌面应用通常要同步：组件文件、`src/components/remote-desktop/index.ts`、`RemoteDesktopShell.tsx` 注册/图标/窗口尺寸/渲染分支、`src/vite-env.d.ts` 的 `ShellDeskDesktopAppKey`、`src/assets/desktop-icons/` 图标、`src/styles/remote-desktop/_xxx.scss` 与 `src/styles/index.scss`
- 新增远程桌面 `appKey` 必须同时加入布局持久化白名单和迁移版本：`electron/main/constants.cjs` 的 `remoteDesktopAppKeys`、`remoteDesktopAppCatalogVersion`、`remoteDesktopAppCatalogMigrationKeys`，`src/RemoteDesktopShell.tsx` 的 `desktopAppCatalogVersion`、`appCatalogMigrationKeys`，以及 `src/App.tsx` 的默认 `remoteDesktopAppCatalogVersion`。否则图标拖到桌面后会在保存配置时被主进程清洗掉，重启或 vault 同步后消失。
- 新增迁移 `appKey` 后，还要检查 `App.tsx` 和 `RemoteDesktopShell.tsx` 的 `settings.remoteDesktopLayout` 回灌逻辑：来自 `vault:changed`、其他窗口或旧保存队列的快照不能把当前布局里已有的新迁移应用删掉，否则图标会在添加到桌面后一段时间又消失。

### Electron 沙箱限制
- `prompt()` / `confirm()` / `alert()` 在 sandbox 模式下被禁用，返回 `null`
- 需使用自定义模态对话框替代（见 RemoteNotepad 中的 `promptDialog` / `confirmDialog` 状态）

### 样式
- 使用 Sass / SCSS，入口为 `src/styles/index.scss`，由 `src/main.tsx` 导入
- `index.scss` 中 `@use` 顺序就是最终 CSS 级联顺序，调整模块顺序前需确认覆盖关系
- CSS 变量（`--bg`, `--surface`, `--text` 等）集中维护在 `src/styles/_tokens.scss`
- 页面级样式放在 `src/styles/pages/`，远程桌面及内置应用样式放在 `src/styles/remote-desktop/`
- 浅色主题覆盖放在 `src/styles/themes/`
- 当前视觉刷新与紧凑密度规则就近维护在对应模块文件末尾，不再新增全局 `overrides/` 补丁目录
- 深色主题为默认，浅色主题通过 `[data-theme="light"]` 选择器覆盖
- 新增样式需同时添加深色和浅色两套；远程桌面应用样式拆到独立 `_app-name.scss` 后，必须在 `src/styles/index.scss` 中按覆盖关系加入 `@use`

## 编码规范

- **语言**：React 19 + TypeScript strict，JSX 内使用中文 UI 文案
- **Electron 文件**：`.cjs` 后缀（CommonJS），前端文件 `.tsx`/`.ts`（ESM）
- **状态管理**：无 Redux/Zustand，全用 React useState/useCallback/useMemo
- **组件模式**：函数组件 + hooks，优先沿用现有组件组织方式；当组件文件过长、职责混杂或维护成本上升时，应拆分为子组件、hooks、工具函数等
- **文件长度**：代码文件和样式文件都应避免过长；过长时按功能、页面、组件或样式模块拆分，保持导出关系、样式级联顺序和命名边界清晰
- **样式**：SCSS + CSS 变量，无 CSS-in-JS / Tailwind，类名用 kebab-case
- **依赖**：最小化；核心运行依赖包含 react/react-dom、ssh2、@xterm/*、highlight.js、mysql2、pg、ioredis、@novnc/novnc、ws
- **错误处理**：`getErrorMessage(error)` 工具函数统一提取错误信息
- **记事本文件打开**：采用黑名单机制（`BINARY_EXTENSIONS`），排除图片/音视频/压缩包/可执行文件/数据库/二进制文档等，其余文件均可用记事本打开
