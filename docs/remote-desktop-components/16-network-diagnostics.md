# 网络诊断工具箱功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `network-diagnostics`），实现入口为 `src/components/remote-desktop/RemoteNetworkDiagnostics.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

网络诊断工具箱提供常用网络排障命令的图形化入口。它强调低门槛、结果清晰和可复制，帮助用户从远程主机视角检查网络连通性、DNS、路由和 HTTP 服务。

## 目标用户场景

- 从服务器 ping 一个域名或 IP。
- 检查 DNS 解析是否正确。
- 查看访问某个 URL 的 HTTP 状态码、耗时和响应头。
- 追踪网络路径。
- 测试远端端口是否可连。
- 复制诊断结果。

## 首版功能范围

- 工具集合：
  - Ping
  - DNS 查询
  - Traceroute / Tracepath
  - Curl HTTP 检测
  - TCP 端口探测
  - 路由表查看
- 每个工具提供：
  - 输入区域。
  - 执行按钮。
  - 原始输出。
  - 简要结构化摘要。
- 历史记录：
  - 当前窗口内保留最近 20 次执行。

## 交互设计

使用左侧工具列表 + 右侧执行面板：

- 左侧：工具名称、简短说明、最近一次状态。
- 右侧：
  - 表单参数。
  - 执行按钮和加载状态。
  - 摘要卡片。
  - 原始输出区。

不要把所有工具堆在一个页面，避免表单过长。结果区应支持复制。

## 数据模型

```ts
type NetworkToolKey = 'ping' | 'dns' | 'trace' | 'curl' | 'tcp' | 'routes';

interface NetworkDiagnosticRun {
  id: string;
  tool: NetworkToolKey;
  input: Record<string, string | number | boolean>;
  startedAt: string;
  durationMs?: number;
  exitCode?: number;
  stdout: string;
  stderr: string;
  summary?: Record<string, string | number | boolean>;
}
```

## 远程命令设计

Ping：

- Linux：`ping -c <count> <host>`。
- Windows：`Test-Connection -Count <count> <host>`。

DNS：

- 优先 `dig <domain>`。
- 回退 `nslookup <domain>`。
- Windows 使用 `Resolve-DnsName`，失败回退 `nslookup`。

Trace：

- Linux 优先 `tracepath`，其次 `traceroute`。
- Windows `tracert`。

Curl：

- `curl -I -L --max-time <seconds> <url>`。
- 可选 GET：`curl -L --max-time <seconds> -o /dev/null -w ...`。

TCP：

- Linux 优先 `nc -vz <host> <port>`。
- 回退 bash `/dev/tcp`。
- Windows `Test-NetConnection -ComputerName <host> -Port <port>`。

路由：

- Linux `ip route`。
- Windows `Get-NetRoute`。

## IPC 与代码落点

首版复用 `runCommand`。命令有超时需求，目前若 `runCommand` 没有可配置超时，建议命令自身加 `timeout` 或平台参数，例如 `curl --max-time`、`ping -c`。

首版文件建议：

- `src/components/remote-desktop/RemoteNetworkDiagnostics.tsx`
- `src/styles/remote-desktop/_network-diagnostics.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 搭建工具箱基础布局和工具切换。
2. 实现 ping、DNS、curl 三个最高频工具。
3. 实现 TCP 探测和路由表查看。
4. 实现 trace 工具。
5. 加入历史记录、复制结果、错误提示。
6. 补 Windows 命令分支。
7. 统一命令构建和参数校验。

## 验收标准

- Linux 和 Windows 至少能执行 ping、DNS、curl 或等价检测。
- 输入为空、端口非法、URL 非法时有表单提示。
- 长时间命令有明确加载状态，并能自然结束。
- 结果能复制。
- 命令参数安全转义。

## 后续增强

- MTR 实时诊断。
- 网络测速。
- 多目标批量检测。
- 保存常用诊断模板。
- 从浏览器或端口管理器跳转带入目标。
