# 系统监视器组件重设计文档

> 当前状态：已接入远程桌面（appKey: `monitor`），实现入口为 `src/components/remote-desktop/RemoteMonitor.tsx`。本文保留重设计背景，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

系统监视器默认以三张图表展示远程主机的 CPU 使用率、内存使用率和网络流量，其中网络上传、下载以双折线合并展示。用户可显式开启持久化分析，在目标机器本机保存 CPU、内存、根磁盘、网络与服务健康历史。

## 重新设计目标

- 三张图表网格排列：CPU、内存，以及合并上传/下载双折线的网络流量。
- 未开启持久化时只保留窗口内的实时采样，行为与旧版一致。
- 采样间隔可控，窗口失焦时降频。
- 在不同系统上优雅降级，指标不可用时图表留空而非报错。
- 持久化必须由用户首次确认，并且可以随时启停。
- 持久化数据保存在目标机器当前用户的 `~/.shelldesk/monitor/monitor.sqlite3`。

## 功能架构

### 折线图

- **CPU 使用率**：百分比折线图。
- **内存使用率**：百分比折线图。
- **网络流量**：网络上传、下载速率共用纵轴，在同一卡片中以两条折线展示，并自动换算 KB/s / MB/s。

### 采样与缓存

- 固定长度环形缓冲区存储最近 N 个采样点。
- 轮询间隔可配置，默认 2 秒；窗口失焦时降至 5 秒。
- 实时模式在窗口关闭后停止 polling。
- 持久化模式每 5 分钟由目标系统定时任务采样一次，默认保留 30 天；这个频率约为每月 8,640 个采样点，对 CPU、磁盘和数据库写入的影响较低。

### 持久化分析

- 首次打开且目标机器尚未配置时，询问用户是否开启。选择“仅使用实时监控”后，只在 ShellDesk 本机记录主机级选择，不向目标机器写文件。
- Linux / macOS 使用当前用户的 `crontab`；Windows 使用当前用户的计划任务 `ShellDesk Monitor Collector`。
- 采集器依赖目标机器已有的 Python 3，仅使用 `sqlite3` 等标准库，不自动安装依赖。
- 开启时先执行一次采样，再写入定时任务；任何一步失败都会在 UI 中显示错误。
- 关闭时只移除 ShellDesk 自己的定时任务，保留采集脚本和 SQLite 历史，便于继续查看或恢复。
- ShellDesk 通过独立 IPC 查询状态、历史和告警阈值；历史视图每 60 秒刷新一次，不与实时轮询并发。

### 告警与服务健康

- 默认阈值为 CPU 90%、内存 90%、根磁盘 85%，用户可在历史视图中调整为 1%–100%。
- 告警按“达到阈值开始、恢复后结束”记录到 SQLite，避免每个采样点重复生成告警。
- Linux 汇总 `systemd` 失败服务，Windows 汇总未运行的自动服务；其他系统显示不支持，不阻断指标采集。
- 采样点数量与最后采样时间显示在控制栏，不额外占用一行摘要区域；告警阈值仍可从历史视图工具栏配置。

## 交互设计

- 实时视图中 CPU、内存各占一张卡片，网络双折线卡片横跨整行；历史视图增加根磁盘曲线，以 2×2 网格展示四张卡片。
- 持久化历史增加根磁盘曲线、1h / 6h / 24h / 7d 范围和实时 / 历史数据源切换。
- 悬停图表时显示对应时间点的精确数值 tooltip。
- 图表支持响应式尺寸，随窗口大小自适应。

## 数据与状态

```ts
interface MonitorSample {
  timestamp: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  netRxBytesPerSec: number | null;
  netTxBytesPerSec: number | null;
}

interface ChartSeries {
  label: string;
  unit: string;
  data: { time: number; value: number | null }[];
  color: string;
  yMin: number;
  yMax: number;
}
```

## 能力与集成设计

- 复用现有系统状态和 metrics IPC 获取数据。
- 持久化功能使用 `connection:get-monitor-persistence-status`、`connection:set-monitor-persistence-enabled`、`connection:get-monitor-history` 和 `connection:set-monitor-thresholds`。
- 采样应有清理机制，组件卸载时停止 polling。
- 网络速率由前后两次采样的字节差除以时间间隔计算得出。
- 远端 SQLite 使用 WAL 与 `synchronous=NORMAL`，采集器每次运行后退出，不保留常驻 Agent。

## 开发计划

1. 实现环形采样缓冲区和 polling 生命周期。
2. 使用 Canvas 或 SVG 实现轻量折线图组件。
3. 排布 2×2 网格布局，添加标题和当前值标注。
4. 添加悬停 tooltip 和响应式尺寸。
5. 处理指标缺失、异常值的降级显示。
6. 深色/浅色主题校验。
7. 加入 opt-in 持久化、历史查询和阈值告警，并将采样点数量收进控制栏。

## 验收标准

- CPU、内存和网络双折线图持续刷新，组件关闭后停止请求。
- 指标不可用时对应图表显示空状态，不影响其他图表。
- 悬停 tooltip 正确显示时间点和数值。
- 网络速率单位自动换算正确。
- 窗口失焦时采样频率降低，聚焦后恢复。
- 首次拒绝后保持旧版实时体验，并可通过工具栏再次开启。
- 开启后目标机器存在 5 分钟定时任务和 `~/.shelldesk/monitor/monitor.sqlite3`，关闭后任务消失但历史保留。
- 历史范围、告警阈值和采样点数量能够从 SQLite 刷新。

## 设计取舍

- 折线图用轻量自绘实现，不引入大型图表库。
- 不自动安装 Python 或提升权限；缺少依赖时保留实时模式并给出明确错误。
- Prometheus / Grafana 仍作为可选外部集成，不纳入本机 SQLite MVP。
