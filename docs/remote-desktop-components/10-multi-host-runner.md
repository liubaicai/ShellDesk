# 多主机批量执行器功能设计与开发计划

## 定位

多主机批量执行器用于对多个已保存主机同时执行命令并汇总结果。它属于 ShellDesk 从单连接工具向多主机运维工具扩展的关键能力。

## 目标用户场景

- 对多台服务器执行同一条巡检命令。
- 批量查看磁盘空间、系统版本、服务状态。
- 批量重启某个服务。
- 汇总成功失败和输出。
- 将结果导出或复制。

## 首版功能范围

- 主机选择：
  - 从已保存 hosts 中选择。
  - 按标签/分组作为后续增强。
- 命令配置：
  - 输入命令。
  - 执行前确认。
  - 并发数限制。
- 执行结果：
  - 每台主机状态：等待、连接中、执行中、成功、失败。
  - stdout/stderr。
  - 耗时。
- 控制：
  - 开始。
  - 停止未开始任务。
  - 复制汇总。

## 交互设计

这个组件更适合在主窗口或独立页面中使用，而不只是某个单连接远程桌面窗口。首版若放在远程桌面中，也应该明确它会使用 vault 里的其他主机配置。

布局：

- 左侧：主机选择列表。
- 顶部：命令输入、并发数、执行按钮。
- 主区域：主机结果表。
- 详情抽屉：单台主机完整输出。

危险命令需要强确认，并显示目标主机数量。

## 数据模型

```ts
interface MultiHostRunRequest {
  hostIds: string[];
  command: string;
  concurrency: number;
}

interface MultiHostRunResult {
  hostId: string;
  hostLabel: string;
  status: 'pending' | 'connecting' | 'running' | 'success' | 'failed' | 'canceled';
  stdout: string;
  stderr: string;
  code?: number;
  durationMs?: number;
  error?: string;
}
```

## IPC 与架构设计

当前 `connection:connect` 会为连接创建窗口，并围绕 activeConnections 管理。批量执行不应该为每台主机打开窗口，因此需要新增后台连接/一次性命令能力。

建议新增主进程能力：

- `batch:run-command`
- `batch:cancel`
- `batch:progress` 事件

主进程职责：

- 从 vault 读取 host 配置。
- 按并发数建立 SSH 连接。
- 执行命令。
- 关闭连接。
- 通过事件推送每台主机状态。

## 代码落点

- `electron/main.cjs`
- `electron/preload.cjs`
- `src/vite-env.d.ts`
- `src/components/remote-desktop/RemoteMultiHostRunner.tsx` 或主窗口页面组件
- `src/styles/remote-desktop/_multi-host-runner.scss`
- `src/components/remote-desktop/index.ts`

## 开发计划

1. 设计批量执行 IPC 和事件模型。
2. 主进程实现后台 SSH 连接和并发队列。
3. preload 和类型定义同步。
4. 前端实现主机选择和命令输入。
5. 实现结果表和详情输出。
6. 实现取消未开始任务。
7. 增加危险命令确认和结果复制。

## 验收标准

- 能选择至少两台主机并执行命令。
- 并发数限制有效。
- 单台失败不影响其他主机结果收集。
- 执行结束后后台连接关闭。
- 输出能按主机查看。

## 后续增强

- 主机分组和标签。
- 批量文件分发。
- 批量脚本执行。
- 结果导出 CSV/Markdown。
- 计划任务化巡检。
