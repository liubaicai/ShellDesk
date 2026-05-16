# GUI-SSH — AI Agent Instructions

Electron + React 19 + TypeScript 图形化 SSH 客户端。pnpm 为包管理器。

## 构建与运行

```bash
pnpm dev          # 并行启动 Vite (5173) + Electron，端口被占时先 kill node 进程
pnpm build        # tsc --noEmit && vite build
pnpm release      # 构建 + electron-builder --win nsis
```

**已知坑**：`pnpm dev` 退出后 Vite 可能残留占用 5173 端口，需手动 `taskkill` 或 `Stop-Process` 对应 PID。

## 架构概览

```
electron/
  main.cjs        # 主进程：窗口管理、SSH 连接、SFTP、IPC handler
  preload.cjs     # contextBridge 暴露 guiSSH API 到渲染进程
src/
  App.tsx         # 主页：主机列表、新建/编辑主机、导航、连接入口
  main.tsx        # React 入口
  RemoteDesktop.tsx → re-export RemoteDesktopShell
  RemoteDesktopShell.tsx  # 远程桌面：多窗口管理器 + Dock
  styles.css      # 全局样式（单文件，深色/浅色主题）
  vite-env.d.ts   # window.guiSSH 类型定义（GuiSshApi）
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
- **预加载** `electron/preload.cjs`：`contextBridge.exposeInMainWorld('guiSSH', {...})` 暴露 API
- **渲染进程**：通过 `window.guiSSH.connections.xxx()` 调用
- **类型定义** `src/vite-env.d.ts`：`GuiSshConnectionControls` 等接口
- 新增 IPC 需 **三处同步修改**：main.cjs handler + preload.cjs bridge + vite-env.d.ts 类型

### 远程桌面窗口系统
- `RemoteDesktopShell.tsx` 管理 `DesktopWindowState[]`，每个窗口有 `appKey`（files/terminal/notepad/browser/monitor）
- 窗口支持拖拽移动、缩放、最大化，使用 `transform: translate3d` 定位
- **右键菜单/弹窗**必须用 `createPortal` 渲染到 `document.body`，否则受 `transform` 影响导致定位错乱
- **Dock 栏规则**：`dockPinnedApps` 定义固定显示在底部 Dock 的应用（files/terminal/browser/monitor），其他应用（如 notepad）仅在桌面图标区显示，但当其窗口打开时会动态追加到 Dock 栏（关闭后消失）

### Electron 沙箱限制
- `prompt()` / `confirm()` / `alert()` 在 sandbox 模式下被禁用，返回 `null`
- 需使用自定义模态对话框替代（见 RemoteNotepad 中的 `promptDialog` / `confirmDialog` 状态）

### 样式
- 单文件 `src/styles.css`，使用 CSS 变量（`--bg`, `--surface`, `--text` 等）
- 深色主题为默认，浅色主题通过 `[data-theme="light"]` 选择器覆盖
- 新增样式需同时添加深色和浅色两套

## 编码规范

- **语言**：React 19 + TypeScript strict，JSX 内使用中文 UI 文案
- **Electron 文件**：`.cjs` 后缀（CommonJS），前端文件 `.tsx`/`.ts`（ESM）
- **状态管理**：无 Redux/Zustand，全用 React useState/useCallback/useMemo
- **组件模式**：函数组件 + hooks，大组件不拆文件（如 App.tsx、RemoteFileExplorer.tsx）
- **样式**：纯 CSS，无 CSS-in-JS / Tailwind，类名用 kebab-case
- **依赖**：最小化，核心依赖仅 react、ssh2、xterm、highlight.js、mysql2
- **错误处理**：`getErrorMessage(error)` 工具函数统一提取错误信息
