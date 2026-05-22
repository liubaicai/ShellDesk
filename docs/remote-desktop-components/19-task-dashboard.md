# 任务仪表盘功能设计与开发计划

## 定位

任务仪表盘用于把常用操作变成连接内的快捷控制台。它更像“服务器工作台首页”，将命令、服务、路径和检查项组织成可点击卡片。

## 目标用户场景

- 打开连接后立即看到常用服务状态。
- 一键执行清缓存、重启服务、查看状态。
- 将高频命令固定成按钮。
- 快速跳转常用目录、日志、数据库、浏览器地址。
- 组合几个检查项形成轻量巡检。

## 首版功能范围

- 卡片类型：
  - 命令卡片。
  - 服务状态卡片。
  - 路径快捷卡片。
  - 应用跳转卡片。
- 布局：
  - 可添加、编辑、删除。
  - 简单排序。
- 执行：
  - 命令卡片运行命令并显示结果。
  - 路径卡片打开文件管理器。
  - 应用卡片打开指定远程桌面组件。

## 交互设计

仪表盘是网格布局，但保持运维工具密度：

- 顶部：当前主机摘要、编辑模式开关、添加卡片。
- 主区域：卡片网格。
- 右侧或弹窗：卡片配置表单。

命令卡片执行时在卡片内展示状态，也可以打开详情抽屉查看完整输出。

## 数据模型

```ts
type DashboardCardKind = 'command' | 'service' | 'path' | 'app';

interface DashboardCard {
  id: string;
  kind: DashboardCardKind;
  title: string;
  description?: string;
  command?: string;
  path?: string;
  appKey?: string;
  refreshIntervalSeconds?: number;
}
```

## IPC 与能力设计

- 命令卡片复用 `runCommand`。
- 服务卡片可复用服务管理器的命令构建逻辑。
- 路径和应用跳转需要 `RemoteDesktopShell` 支持统一 `openDesktopWindow(appKey, payload)`。
- 持久化建议和 command snippets 类似，放入 vault 或 settings 扩展。

## 代码落点

- `src/components/remote-desktop/RemoteTaskDashboard.tsx`
- `src/styles/remote-desktop/_task-dashboard.scss`
- `src/components/remote-desktop/dashboardPresets.ts`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现仪表盘入口和默认卡片。
2. 实现命令卡片执行和输出详情。
3. 实现路径卡片和应用跳转卡片。
4. 实现添加、编辑、删除卡片。
5. 实现简单排序。
6. 设计持久化结构。
7. 增加主题和响应式网格。

## 验收标准

- 能添加命令卡片并执行。
- 能从路径卡片打开文件管理器。
- 能从应用卡片打开目标组件。
- 命令执行失败能显示错误。
- 编辑模式和运行模式清晰区分。

## 后续增强

- 自动刷新卡片。
- 卡片导入导出。
- 巡检组合。
- 与命令收藏夹共用模板。
- 连接首页默认展示。
