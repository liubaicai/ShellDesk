# ShellDesk — AI Agent Instructions

Electron + React 19 + TypeScript 图形化 SSH 客户端。pnpm 为包管理器。

## 构建与运行

```bash
pnpm dev          # 并行启动 Vite (5173) + Electron，端口被占时只停止占用 5173 的 PID
pnpm build        # tsc --noEmit && vite build
pnpm release      # 构建 + electron-builder --win nsis
```

**已知坑**：`pnpm dev` 退出后 Vite 可能残留占用 5173 端口。先用 `netstat -ano | findstr :5173` 找到占用 PID，再只对该 PID 执行 `taskkill /PID <pid> /F` 或 `Stop-Process -Id <pid>`，不要粗暴 kill 全部 node 进程。

## 架构概览

```
electron/
  main.cjs        # 主进程：窗口管理、SSH 连接、SFTP、IPC handler
  preload.cjs     # contextBridge 暴露 ShellDesk API 到渲染进程
src/
  App.tsx         # 主页：主机列表、新建/编辑主机、导航、连接入口
  main.tsx        # React 入口
  RemoteDesktop.tsx → re-export RemoteDesktopShell
  RemoteDesktopShell.tsx  # 远程桌面：多窗口管理器 + Dock
  styles/
    index.scss      # 全局样式入口，按级联顺序 @use 模块
    _tokens.scss    # 字体、CSS 变量、主题 token
    foundations/    # reset、基础元素、全局行为
    layout/         # 应用壳、顶部栏、侧边导航
    pages/          # 主机、密钥、日志、设置等页面样式
    remote-desktop/ # 远程桌面及各内置应用样式
    themes/         # 浅色主题与远程应用主题覆盖
  vite-env.d.ts   # window.ShellDesk 类型定义（ShellDeskApi）
  components/
    navigation/NavIcon.tsx
    remote-desktop/
      index.ts            # barrel export
      types.ts            # RemoteConnectionInfo
      desktopUtils.ts     # formatDateTime, getErrorMessage
      RemoteTerminal.tsx  # xterm.js 终端
      RemoteFileExplorer.tsx  # SFTP 文件管理器（Windows 风格）
      RemoteNotepad.tsx   # 远程记事本（highlight.js 代码高亮）
      RemoteBrowser.tsx   # webview 远程浏览器
      RemoteMonitor.tsx   # 系统状态监控
      RemoteMySQL.tsx     # MySQL 数据库管理（SSH 隧道）
  pages/
    KeysPage.tsx    # SSH 密钥管理
    LogsPage.tsx    # 日志（占位）
    SettingsPage.tsx # 设置（占位）
```

## 关键设计决策

### IPC 通信模式
- **主进程** `electron/main.cjs`：`registerIpcHandler('connection:xxx', handler)` 注册 IPC
- **预加载** `electron/preload.cjs`：`contextBridge.exposeInMainWorld('ShellDesk', {...})` 暴露 API
- **渲染进程**：通过 `window.ShellDesk.connections.xxx()` 调用
- **类型定义** `src/vite-env.d.ts`：`ShellDeskConnectionControls` 等接口
- 新增 IPC 需 **三处同步修改**：main.cjs handler + preload.cjs bridge + vite-env.d.ts 类型

### 远程桌面窗口系统
- `RemoteDesktopShell.tsx` 管理 `DesktopWindowState[]`，每个窗口有 `appKey`（files/terminal/notepad/browser/monitor/mysql/procmanager/settings）
- 窗口支持拖拽移动、缩放、最大化，使用 `transform: translate3d` 定位
- **右键菜单/弹窗**必须用 `createPortal` 渲染到 `document.body`，否则受 `transform` 影响导致定位错乱
- **Dock 栏规则**：`dockPinnedApps` 定义固定显示在底部 Dock 的应用（files/terminal/browser），其他应用（如 notepad、mysql）仅在桌面图标区显示，但当其窗口打开时会动态追加到 Dock 栏（关闭后消失）

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
- 新增样式需同时添加深色和浅色两套

## 编码规范

- **语言**：React 19 + TypeScript strict，JSX 内使用中文 UI 文案
- **Electron 文件**：`.cjs` 后缀（CommonJS），前端文件 `.tsx`/`.ts`（ESM）
- **状态管理**：无 Redux/Zustand，全用 React useState/useCallback/useMemo
- **组件模式**：函数组件 + hooks，大组件不拆文件（如 App.tsx、RemoteFileExplorer.tsx）
- **样式**：SCSS + CSS 变量，无 CSS-in-JS / Tailwind，类名用 kebab-case
- **依赖**：最小化，核心依赖仅 react、ssh2、xterm、highlight.js、mysql2
- **错误处理**：`getErrorMessage(error)` 工具函数统一提取错误信息
- **记事本文件打开**：采用黑名单机制（`BINARY_EXTENSIONS`），排除图片/音视频/压缩包/可执行文件/数据库/二进制文档等，其余文件均可用记事本打开
