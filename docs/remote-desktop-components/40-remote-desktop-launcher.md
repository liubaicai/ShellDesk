# 远程桌面启动器功能设计与开发计划

## 定位

远程桌面启动器是连接后的工作台首页，展示最近文件、最近命令、常用服务、常用路径、告警摘要和常用组件入口。它不是营销页，而是提高远程桌面启动效率的实用面板。

## 目标用户场景

- 进入远程桌面后快速继续上次工作。
- 打开常用路径、日志、服务、数据库。
- 查看当前主机的简短健康摘要。
- 从一个地方进入常用组件。
- 对新连接提供清晰的起点。

## 首版功能范围

- 概览：
  - 主机名、系统类型、连接时间。
  - CPU/内存/磁盘简要状态。
- 快捷入口：
  - 固定组件。
  - 最近打开的应用。
  - 最近文件路径。
  - 常用命令。
- 提醒：
  - 磁盘高使用率。
  - 失败服务数量，后续从服务管理器获取。
- 个性化：
  - 简单固定/取消固定。

## 交互设计

启动器可以作为默认打开的桌面组件，也可以嵌入桌面空状态：

- 顶部：主机摘要和健康小卡片。
- 中部：常用组件和固定快捷方式。
- 底部：最近活动。

它应保持紧凑，避免 landing page 风格。用户双击桌面应用仍然直接打开组件。

## 数据模型

```ts
interface DesktopLauncherState {
  pinnedAppKeys: string[];
  recentAppKeys: string[];
  recentPaths: string[];
  commandShortcuts: string[];
}

interface LauncherHealthSummary {
  cpu?: string;
  memory?: string;
  disk?: string;
  warnings: string[];
}
```

## IPC 与集成设计

复用：

- `getMetrics` 获取指标。
- 文件管理器和记事本打开路径事件记录最近路径。
- 任务仪表盘或命令收藏夹提供常用命令。

需要 `RemoteDesktopShell` 增加轻量最近活动记录：

- 打开 app 时记录 appKey。
- 打开文件时记录 path。
- 可先存内存，后续持久化到 vault/settings。

## 代码落点

- `src/components/remote-desktop/RemoteDesktopLauncher.tsx`
- `src/styles/remote-desktop/_desktop-launcher.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`
- 后续持久化涉及 vault/settings。

## 开发计划

1. 实现启动器组件和桌面入口。
2. 实现主机摘要和 metrics 小卡片。
3. 实现常用组件入口。
4. 实现最近应用记录。
5. 实现最近路径记录和打开。
6. 实现固定快捷入口。
7. 评估是否作为新连接默认窗口。

## 验收标准

- 启动器能显示当前连接主机信息。
- 能从启动器打开其他组件。
- 打开过的应用能进入最近列表。
- 最近路径能跳转文件管理器或记事本。
- UI 在桌面窗口内保持紧凑，不遮挡 Dock。

## 后续增强

- 默认首页模式。
- 与健康报告联动。
- 与命令收藏夹/任务仪表盘联动。
- 每个主机独立快捷方式。
