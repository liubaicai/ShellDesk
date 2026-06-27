# 计划任务管理器功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `scheduled-tasks`），实现入口为 `src/components/remote-desktop/RemoteScheduledTasks.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

计划任务管理器用于统一管理远程主机的定时任务。它覆盖 Linux crontab、systemd timer，以及 Windows Task Scheduler，帮助用户查看、编辑、启停和诊断定时任务。

## 目标用户场景

- 查看当前用户 crontab 中有哪些任务。
- 新增或编辑一个定时脚本。
- 禁用某个任务但保留配置。
- 查看 systemd timer 下次运行时间。
- 查看 Windows 计划任务状态。

## 首版功能范围

- Linux crontab：
  - 列表解析。
  - 新增、编辑、删除、禁用、启用。
  - 表达式人类可读提示。
- systemd timer：
  - 列表展示。
  - 查看详情和关联 service。
  - 启动、停止、启用、禁用。
- Windows Task Scheduler：
  - 列表展示。
  - 启用、禁用、运行。

首版编辑 crontab 时应保存原始文本备份，降低误改风险。

## 交互设计

顶部 tabs：

- Crontab
- systemd Timer
- Windows 任务

Crontab 视图：

- 左侧任务列表。
- 右侧编辑表单：分钟、小时、日期、月份、星期、命令。
- 原始 crontab 文本可展开查看。
- 操作：新增、保存、禁用、删除。

Timer 视图：

- 表格展示 timer、下次运行、上次运行、状态、关联 unit。

## 数据模型

```ts
interface CronTask {
  id: string;
  enabled: boolean;
  expression: string;
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
  command: string;
  raw: string;
}

interface SystemdTimerSummary {
  name: string;
  next?: string;
  left?: string;
  last?: string;
  passed?: string;
  unit?: string;
  activates?: string;
}
```

## 远程命令设计

Crontab：

- 读取：`crontab -l`。
- 写入：把新内容写入临时文件，然后 `crontab <tempfile>`。
- 备份：写入前保存当前内容到用户 home 下的临时备份，或仅在 UI 中保留本次会话备份。

systemd timer：

- 列表：`systemctl list-timers --all --no-pager --plain`。
- 详情：`systemctl status <timer> --no-pager`。
- 操作：`systemctl start|stop|enable|disable <timer>`。

Windows：

- 列表：`Get-ScheduledTask`。
- 详情：`Get-ScheduledTaskInfo`。
- 操作：`Enable-ScheduledTask`、`Disable-ScheduledTask`、`Start-ScheduledTask`。

## IPC 与代码落点

首版可复用 `runCommand` 和 SFTP/临时文件写入。更安全的 crontab 写入可以在 Rust 后端新增专用 IPC，避免前端拼接复杂 shell。

建议首版优先用：

- `runCommand` 读取。
- `runCommand` 配合 here-doc 写入，但要严格转义。

首版文件建议：

- `src/components/remote-desktop/RemoteScheduledTasks.tsx`
- `src/styles/remote-desktop/_scheduled-tasks.scss`
- `src/components/remote-desktop/cronUtils.ts`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现 crontab 解析和展示。
2. 实现 crontab 新增、编辑、禁用、删除。
3. 增加保存前预览和确认。
4. 实现 systemd timer 列表和详情。
5. 实现 timer 启停和启用禁用。
6. 实现 Windows 计划任务基础列表和操作。
7. 增加表达式提示和校验。

## 验收标准

- Linux 能读取当前用户 crontab。
- 修改 crontab 后再次读取内容一致。
- 注释行和空行不会丢失。
- 禁用任务采用注释方式，能恢复。
- systemd timer 能正确列出下次运行时间。
- Windows 至少能列出计划任务。

## 后续增强

- cron 表达式可视化编辑器。
- 任务执行历史。
- 从任务跳转日志查看器。
- 支持 root crontab 或指定用户 crontab。
- systemd timer 创建向导。
