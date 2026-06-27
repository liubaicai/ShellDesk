# 代码编辑器组件说明

> 当前状态：已接入远程桌面（appKey: `code-editor`），实现入口为 `src/components/remote-desktop/RemoteCodeEditor.tsx`。

## 定位

代码编辑器用于在远程主机上进行轻量项目维护。它不是完整 IDE，而是把远程目录树、多标签文件编辑、项目终端和 AI 编程助手放进同一个远程桌面窗口，适合直接修配置、查代码、跑脚本和处理小型变更。

## 当前实现范围

- 项目根目录：
  - 通过远程文件选择器打开目录。
  - 使用远程组件连接配置保存最近项目根目录（profile key: `projectRoot`）。
- 文件树：
  - 基于 SFTP 列目录。
  - 过滤 `.git`、`node_modules`、`dist`、`target`、`vendor` 等常见大目录。
  - 读取 `.gitignore` 的常用规则并限制扫描规模。
- 编辑器：
  - 复用 `NotepadEditor`，支持多标签、语言检测、保存、关闭标签和远程变更提示。
  - 通过文件 watch 周期检测远程文件变化，避免本地编辑覆盖远端新内容。
- 项目终端：
  - 内嵌 `RemoteTerminal`，支持多个终端 tab。
  - 终端工作目录跟随当前项目根目录。
- AI 面板：
  - 复用 `RemoteAiChat` 的 Markdown 渲染和共享工具。
  - 给 AI 注入当前项目根目录上下文，适合解释代码、检查文件和执行用户确认的命令。

## 代码落点

- `src/components/remote-desktop/RemoteCodeEditor.tsx`
- `src/components/remote-desktop/directoryWatchUtils.ts`
- `src/components/remote-desktop/RemoteFilePicker.tsx`
- `src/components/remote-desktop/NotepadEditor.tsx`
- `src/components/remote-desktop/RemoteTerminal.tsx`
- `src/styles/remote-desktop/_code-editor.scss`
- `src/assets/desktop-icons/code-editor.png`
- `src/RemoteDesktopShell.tsx`

## 设计边界

- 不做完整 LSP、断点调试、复杂重构和插件生态。
- 不把大型仓库索引常驻内存；目录和文件监听都有数量上限。
- AI 能力依赖应用设置中的模型和 API key；未配置时只展示配置提示。
- 写文件仍走远程文件 API，保存失败不能丢弃当前编辑内容。

## 后续增强

- 项目级搜索。
- Git 管理器联动：从变更文件打开代码编辑器。
- 远程命令任务面板。
- 更细的冲突 diff 和合并处理。
