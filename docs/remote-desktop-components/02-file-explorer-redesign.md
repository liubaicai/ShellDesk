# 文件管理器组件重设计文档

> 当前状态：已接入远程桌面（appKey: `files`），实现入口为 `src/components/remote-desktop/RemoteFileExplorer.tsx` 与 `RemoteFileExplorerCore.tsx`。本文保留重设计背景，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

文件管理器是 ShellDesk 远程桌面的文件工作台。重新设计时应覆盖浏览、传输、批量操作、预览、打开方式和与其他工具协作，而不是只做目录列表。

## 重新设计目标

- 让远程文件定位、整理、传输和打开更接近日常桌面体验。
- 让高风险文件操作可预览、可确认、可追踪。
- 让文件管理器成为记事本、SQLite、Diff、权限编辑器、压缩包浏览器的入口。
- 在 SFTP 能力限制下保持可靠，不假装远程文件系统就是本地磁盘。

## 功能架构

### 浏览与导航

- 面包屑路径、地址栏、历史后退前进、收藏路径。
- 文件表格与可选双栏模式，便于目录间搬运。
- 排序、筛选、搜索当前目录、显示隐藏文件。
- Windows/Linux 路径语义分支和 home/root 快捷入口。

### 文件操作

- 新建文件/目录、重命名、删除、复制、移动。
- 上传、下载、传输队列、失败重试、取消。
- 批量选择和批量操作预览。
- 属性面板：大小、mtime、权限、owner/group、链接目标。

### 打开方式

- 文本文件打开记事本或结构化配置编辑器。
- SQLite 文件打开数据库管理器。
- 压缩包打开压缩包浏览器。
- 两个文件进入 Diff。
- 文件或目录进入权限编辑器、批量重命名、远程搜索。

## 交互设计

- 顶部工具栏放路径、刷新、新建、上传、下载、视图切换。
- 左侧放快捷路径、收藏、传输队列入口。
- 主区域使用高密度文件列表。
- 右侧可选详情面板，避免每个文件都弹窗。
- 右键菜单使用 portal 渲染，批量危险操作统一进入确认弹窗。

## 数据与状态

```ts
interface FileExplorerLocation {
  path: string;
  systemType?: RemoteSystemType;
}

interface FileExplorerSelection {
  entries: ShellDeskRemoteFileEntry[];
  primaryPath?: string;
}

interface FileTransferTask {
  id: string;
  direction: 'upload' | 'download';
  path: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'canceled';
}
```

## 能力与集成设计

- 基础 CRUD、目录读取和传输继续走 SFTP IPC。
- 复杂功能优先通过“打开到对应组件”完成，避免文件管理器膨胀。
- 复制/移动若跨目录且 SFTP 缺少服务端 copy，需要明确实现策略和进度。
- 删除、覆盖、重命名冲突都应由文件管理器统一处理。

## 开发计划

1. 重整导航模型和路径历史。
2. 引入可选详情面板与批量选择操作栏。
3. 抽象打开方式 registry。
4. 增强传输队列、错误重试和进度可见性。
5. 补属性、权限、压缩包、Diff 跳转。
6. 评估双栏模式与收藏路径持久化。
7. 针对 Windows/Linux 路径和权限差异补测试。

## 验收标准

- 大目录浏览、排序、刷新稳定。
- 批量上传下载和取消状态可见。
- 危险操作有清晰确认和失败反馈。
- 不同文件类型能路由到合适组件。
- 目录跳转 payload 可从其他组件正常打开。

## 设计取舍

- 首版不做完整本地文件管理器镜像，远程能力优先。
- 文件预览只做轻量摘要，编辑交给专门组件。
- 双栏模式可以晚于打开方式和传输队列。
