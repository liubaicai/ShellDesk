# 端口与监听管理器功能设计与开发计划

## 定位

端口与监听管理器用于展示远程主机当前开放端口、监听进程和连接状态。它帮助用户快速判断服务是否监听、端口是否冲突、某个端口由哪个进程占用。

## 目标用户场景

- 查看 `80`、`443`、`3306`、`6379` 等端口是否正在监听。
- 找出某个端口被哪个进程占用。
- 按进程名、端口、协议筛选连接。
- 复制端口诊断信息。
- 从端口跳转到进程管理器或服务管理器。

## 首版功能范围

- 监听端口列表：
  - 协议、状态、本地地址、本地端口、进程名、PID。
  - 支持 TCP、UDP。
- 连接列表：
  - established、time-wait 等状态。
  - 远端地址和端口。
- 筛选：
  - 只看监听端口。
  - TCP/UDP。
  - 端口号、进程名、PID。
- 操作：
  - 刷新。
  - 复制行信息。
  - 终止进程，复用进程管理器逻辑或提供跳转。

## 交互设计

主界面为表格型工具：

- 顶部：刷新、搜索、协议筛选、状态筛选、仅监听开关。
- 表格：协议、状态、本地地址、端口、远端地址、PID、进程。
- 右侧详情抽屉：进程信息、命令行、建议诊断命令。

端口表应保持高密度，不做大卡片。端口状态用短标签展示。

## 数据模型

```ts
interface PortListenerEntry {
  protocol: 'tcp' | 'udp' | 'tcp6' | 'udp6' | 'unknown';
  state: string;
  localAddress: string;
  localPort: number | null;
  remoteAddress?: string;
  remotePort?: number | null;
  pid?: number;
  processName?: string;
  command?: string;
}
```

## 远程命令设计

Linux 优先：

- `ss -tunlp`
- 如果 `ss` 不存在，回退 `netstat -tunlp`。
- 进程补充：`ps -p <pid> -o pid,ppid,user,comm,args --no-headers`。

macOS/Unix 兼容可后续补：

- `lsof -i -P -n`

Windows：

- `Get-NetTCPConnection`
- `Get-NetUDPEndpoint`
- 进程名：`Get-Process -Id <pid>`。

解析策略：

- 对 Linux 的 `ss` 文本输出做稳定解析。
- 对 Windows 使用 PowerShell 输出 JSON，前端解析。

## IPC 与代码落点

首版可复用 `runCommand`。终止进程可以复用已有进程管理器中的远程命令模式，若未来抽共享工具，可以把进程 kill 能力移动到 `remoteProcess.ts`。

首版文件建议：

- `src/components/remote-desktop/RemotePortManager.tsx`
- `src/styles/remote-desktop/_port-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 桌面入口和表格布局。
2. Linux `ss` 解析和展示。
3. 搜索、协议筛选、监听筛选。
4. 进程详情加载。
5. Windows PowerShell 实现。
6. 复制、刷新、错误状态。
7. 可选：终止进程确认弹窗。

## 验收标准

- Linux 主机能看到 TCP/UDP 监听端口。
- 搜索端口号或进程名可以正确过滤。
- Windows 主机能展示 TCP 连接和 UDP 端点。
- `ss` 不存在时能回退到 `netstat` 或给出明确提示。
- PID 缺失时 UI 不崩溃。

## 后续增强

- 端口开放状态远程探测。
- 与防火墙管理器联动。
- 与服务管理器/进程管理器跳转。
- 端口历史变化记录。
