# SSH 隧道管理器功能设计与开发计划

## 定位

SSH 隧道管理器用于创建和管理基于当前 SSH 连接的端口转发。它把本地转发、远程转发和动态 SOCKS 代理图形化，适合访问远程内网服务、数据库、Web 管理后台和临时调试端口。

## 目标用户场景

- 把远程 `127.0.0.1:5432` 映射到本地端口。
- 创建动态 SOCKS 代理访问远程内网。
- 查看当前隧道是否运行、监听在哪个本地端口。
- 停止不再需要的隧道。
- 保存常用隧道模板。

## 首版功能范围

- 隧道类型：
  - 本地转发：local port -> remote host:remote port。
  - 动态 SOCKS：local port -> SSH dynamic proxy。
- 远程转发可作为第二阶段。
- 隧道列表：
  - 名称、类型、本地地址、本地端口、目标、状态、创建时间。
- 操作：
  - 新建、启动、停止、删除。
  - 复制代理地址。
  - 测试连通性。
- 模板：
  - 保存常用配置到本地 vault/settings，或先存在组件状态中，后续再持久化。

## 交互设计

窗口分为两部分：

- 左侧隧道列表：
  - 运行中标签。
  - 本地端口。
  - 类型图标。
- 右侧配置详情：
  - 类型选择。
  - 本地监听地址和端口。
  - 目标主机和端口。
  - 启停按钮。
  - 状态和错误信息。

新增隧道使用表单，不使用系统 prompt。端口冲突要给出明确错误。

## 数据模型

```ts
type SshTunnelType = 'local' | 'dynamic' | 'remote';

interface SshTunnelConfig {
  id: string;
  name: string;
  type: SshTunnelType;
  localHost: string;
  localPort: number;
  remoteHost?: string;
  remotePort?: number;
  createdAt: string;
}

interface SshTunnelRuntime {
  tunnelId: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  boundHost?: string;
  boundPort?: number;
  error?: string;
}
```

## IPC 与主进程设计

隧道管理必须放在 Electron 主进程，因为它需要创建本地 TCP server，并把连接转发到当前 SSH client。当前主进程已有 MySQL、Redis、VNC 的 SSH 隧道实现，可以提炼或复用类似逻辑。

新增 IPC：

- `connection:tunnel-start`
- `connection:tunnel-stop`
- `connection:tunnel-list`
- `connection:tunnel-test`

本地转发实现：

- 主进程创建 `net.createServer`。
- 每个本地连接进入后调用 `activeConnection.client.forwardOut`。
- 将本地 socket 和 remote stream 双向 pipe。

动态 SOCKS：

- 可以复用或抽取当前连接已有 SOCKS 代理思路。
- 首版如果复杂度过高，可以先只做本地转发。

远程转发：

- 需要 SSH `forwardIn`，安全和生命周期更复杂，建议第二阶段。

## 安全设计

- 默认本地监听 `127.0.0.1`，不默认暴露 `0.0.0.0`。
- 如果用户选择 `0.0.0.0`，显示风险提示。
- 端口范围限制 1-65535。
- 目标 host 限制长度，禁止空值。
- 连接关闭时自动停止相关隧道。

## 代码落点

- `electron/main.cjs`
- `electron/preload.cjs`
- `src/vite-env.d.ts`
- `src/components/remote-desktop/RemoteTunnelManager.tsx`
- `src/styles/remote-desktop/_tunnel-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 在主进程实现本地转发 runtime Map。
2. 新增 `tunnel-start`、`tunnel-stop`、`tunnel-list` IPC。
3. preload 和类型定义同步暴露。
4. 前端实现隧道列表和新建表单。
5. 实现启动、停止、状态刷新。
6. 连接关闭时清理该连接下所有隧道。
7. 增加连通性测试和复制地址。
8. 第二阶段实现动态 SOCKS 和配置持久化。

## 验收标准

- 能把本地端口转发到远程主机端口。
- 本地端口冲突时返回清晰错误。
- 停止隧道后本地端口释放。
- 关闭 SSH 连接后隧道自动清理。
- 默认只监听 `127.0.0.1`。
- `pnpm build` 通过。

## 后续增强

- 动态 SOCKS 隧道。
- 远程转发。
- 隧道模板持久化。
- 流量统计。
- 从数据库管理器或浏览器一键创建隧道。
