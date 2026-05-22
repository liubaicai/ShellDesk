# 健康检查卡片生成器功能设计与开发计划

## 定位

健康检查卡片生成器用于把系统、网络、磁盘、服务、端口和安全等检查项组合成一份可读报告。它面向日常巡检、交接和问题排查前的快速体检。

## 目标用户场景

- 一键生成当前服务器健康报告。
- 自定义检查项和阈值。
- 查看异常项和建议。
- 将报告复制为 Markdown。
- 后续对比两次检查结果。

## 首版功能范围

- 内置检查项：
  - CPU、内存、磁盘、负载。
  - 系统版本、运行时间。
  - 关键服务状态。
  - 监听端口摘要。
  - 登录失败摘要。
- 卡片展示：
  - 正常、警告、危险、未知。
  - 原始输出可展开。
- 报告导出：
  - 复制 Markdown。
  - 当前会话保存最近报告。

## 交互设计

顶部是运行按钮和检查项选择。主体为卡片网格：

- 每个卡片有标题、状态、摘要、关键指标。
- 点击展开详情和原始输出。
- 右侧报告摘要统计通过/警告/失败数量。

整体要像工作台报告，不做厚重图表。卡片圆角和密度遵循现有远程桌面样式。

## 数据模型

```ts
interface HealthCheckDefinition {
  id: string;
  title: string;
  category: 'system' | 'network' | 'disk' | 'service' | 'security';
  enabledByDefault: boolean;
}

interface HealthCheckResult {
  id: string;
  status: 'ok' | 'warning' | 'danger' | 'unknown';
  summary: string;
  metrics: Record<string, string | number>;
  rawOutput?: string;
  suggestions: string[];
}
```

## 远程命令设计

复用现有监控和其他组件命令：

- 系统：`uptime`、`uname -a`、`free -m`。
- 磁盘：`df -P -h`。
- 端口：`ss -tunlp`。
- 服务：`systemctl is-active <service>`。
- 登录失败：`lastb -n 20`。

Windows：

- `Get-ComputerInfo`、`Get-PSDrive`、`Get-Process`、`Get-Service`。

## IPC 与代码落点

首版复用 `runCommand` 和现有 `getMetrics`。检查项定义应模块化，后续可以复用安全巡检、端口管理器、服务管理器的解析器。

文件建议：

- `src/components/remote-desktop/RemoteHealthReport.tsx`
- `src/components/remote-desktop/healthChecks.ts`
- `src/styles/remote-desktop/_health-report.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现检查项定义和运行框架。
2. 实现系统、磁盘、端口基础检查。
3. 实现关键服务检查配置。
4. 实现卡片网格和状态统计。
5. 实现 Markdown 报告复制。
6. 增加 Windows 基础检查。
7. 抽取可复用解析器。

## 验收标准

- 能生成一份包含系统、磁盘、端口的报告。
- 异常项有状态和建议。
- 单项命令失败不影响整份报告。
- 报告可复制为 Markdown。
- Windows 主机至少能生成系统和磁盘摘要。

## 后续增强

- 报告历史对比。
- 自定义检查项。
- 阈值配置。
- 多主机批量健康报告。
