# 日志查看器功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `log-viewer`），实现入口为 `src/components/remote-desktop/RemoteLogViewer.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

日志查看器用于统一查看远程主机系统日志、服务日志和常见应用日志。它的目标不是替代专业日志平台，而是在 SSH 会话中提供最快的排障入口。

## 目标用户场景

- 查看系统最近错误，不需要记住 `journalctl` 参数。
- 打开 `/var/log/nginx/error.log`、应用日志或 Windows Event Log。
- 手动添加常看的日志文件路径，并在下次进入时保留。
- 关注关键日志，让它们固定显示在左侧顶部。
- 搜索关键字、过滤等级、定位异常堆栈。
- 按服务名查看日志，例如 `nginx.service`、`docker.service`。
- 复制一段日志给同事或 AI 分析。

## 首版功能范围

- 日志来源：
  - Linux `journalctl`。
  - Linux 文件日志：`/var/log` 下常见文件。
  - Windows Event Log：System、Application。
- 查询能力：
  - 最近 N 行，默认 300 行。
  - 关键字搜索。
  - 时间范围：最近 15 分钟、1 小时、24 小时、自定义起止。
  - 等级筛选：error、warning、info。
- 展示能力：
  - 日志行虚拟滚动或轻量分页。
  - 关键字高亮。
  - 自动识别 error/warn 颜色。
  - 复制选中行、复制全部结果。
  - 手动选择日志文件并持久化。
  - 关注日志来源并置顶显示。
  - 实时跟随开关在切换日志来源时保持当前状态。

## 交互设计

窗口分为左侧来源栏和右侧日志区：

- 左侧：
  - `journalctl` 快捷入口。
  - `/var/log` 文件树。
  - 手动添加的日志文件。
  - 关注日志置顶区。
  - 服务日志快捷入口。
  - Windows Event Log 分类。
- 顶部查询栏：
  - 来源类型、服务名/文件路径、关键字、时间范围、行数。
  - 执行查询、刷新、清空。
- 主区域：
  - 日志列表。
  - 空状态提示。
  - 错误状态提示命令失败原因。

首版可以不做真正实时 tail，用“刷新查询”满足大多数排障场景。实时跟随作为第二阶段。

## 数据模型

```ts
type LogSourceType = 'journal' | 'file' | 'windows-event';

interface LogSource {
  id: string;
  type: LogSourceType;
  label: string;
  value: string;
  description?: string;
}

interface LogQuery {
  source: LogSource;
  keyword: string;
  level: 'all' | 'error' | 'warning' | 'info';
  since?: string;
  until?: string;
  lines: number;
}

interface LogLine {
  id: string;
  timestamp?: string;
  level?: string;
  service?: string;
  message: string;
  raw: string;
}
```

## 远程命令设计

Linux `journalctl`：

- 最近日志：`journalctl -n <lines> --no-pager --output=short-iso`。
- 服务日志：`journalctl -u <unit> -n <lines> --no-pager --output=short-iso`。
- 时间范围：`--since`、`--until`。
- 等级：`-p err..alert`、`-p warning`。

Linux 文件日志：

- 文件列表：`find /var/log -maxdepth 2 -type f`，限制数量和输出长度。
- 最近行：`tail -n <lines> <file>`。
- 搜索：优先 `grep -i -- <keyword> <file> | tail -n <lines>`。

Windows：

- `Get-WinEvent -LogName System -MaxEvents <n>`。
- 按等级筛选 `LevelDisplayName`。
- 输出 JSON，前端解析。

## IPC 与代码落点

首版可以复用 `runCommand`。实时 tail 需要新增流式命令能力，否则 `runCommand` 会等待命令结束，不适合 `tail -f`。

建议后续 IPC：

- `connection:start-command-stream`
- `connection:write-command-stream`
- `connection:stop-command-stream`
- 或专用 `connection:tail-log`

首版文件建议：

- `src/components/remote-desktop/RemoteLogViewer.tsx`
- `src/styles/remote-desktop/_log-viewer.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 接入桌面入口和基础布局。
2. 实现 `journalctl` 最近日志查询。
3. 实现 `/var/log` 文件发现和文件日志读取。
4. 实现搜索、等级筛选、时间范围。
5. 实现 Windows Event Log 基础查询。
6. 加入复制、刷新、错误处理、空状态。
7. 优化长日志显示性能，必要时加分页。

## 验收标准

- Linux 主机能查看系统日志和指定服务日志。
- 能打开常见 `/var/log` 文件。
- 能通过远程文件选择器添加任意日志文件路径，下次进入仍可使用。
- 关注后的日志来源显示在左侧顶部，下次进入仍保持。
- 打开实时跟随后切换日志来源，实时状态不会被自动关闭。
- 关键字搜索和等级筛选有效。
- Windows 主机能查看 System 和 Application 日志。
- 大量日志不会把窗口撑爆或明显卡顿。
- 命令参数经过转义，文件路径不会造成注入。

## 后续增强

- 使用后端流式命令替代当前轮询式实时跟随。
- 多标签日志对比。
- 异常堆栈折叠。
- 日志时间轴。
- 从服务管理器跳转到对应服务日志。
