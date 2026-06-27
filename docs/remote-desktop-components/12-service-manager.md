# 服务管理器功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `service-manager`），实现入口为 `src/components/remote-desktop/RemoteServiceManager.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

服务管理器用于把远程主机上的常驻服务变成可扫描、可筛选、可控制、可追踪的图形界面。它优先覆盖 Linux `systemd`，同时兼容 Windows Services。它应成为 ShellDesk 远程桌面中最常用的运维入口之一。

## 目标用户场景

- 快速查看某台服务器上哪些服务正在运行、失败、禁用或开机自启。
- 对 Nginx、MySQL、Docker、业务服务等执行启动、停止、重启、reload。
- 查看某个服务最近日志，不需要手写 `systemctl status` 或 `journalctl`。
- 修改服务开机自启状态。
- 在服务异常时快速复制诊断信息。

## 首版功能范围

- 服务列表：
  - 名称、描述、加载状态、运行状态、子状态、是否开机自启。
  - 搜索服务名和描述。
  - 按状态筛选：全部、运行中、失败、已停止、已启用、已禁用。
- 服务详情：
  - 基础信息：名称、描述、状态、主 PID、内存、启动时间、单元文件路径。
  - 最近日志：默认最近 100 行。
  - 原始状态输出：保留 `systemctl status` 的文本视图。
- 服务操作：
  - 启动、停止、重启、reload。
  - enable、disable。
  - 刷新当前服务。
- Windows 兼容：
  - 使用 PowerShell `Get-Service` 展示服务列表。
  - 支持启动、停止、重启。
  - 开机自启可以作为第二阶段功能。

## 交互设计

窗口采用三栏结构：

- 顶部工具栏：刷新、搜索框、状态筛选、系统类型提示。
- 左侧服务列表：服务名、状态圆点、简短描述、启用标签。
- 右侧详情区：
  - 概览卡片：运行状态、启用状态、PID、启动耗时。
  - 操作按钮组：启动、停止、重启、Reload、启用、禁用。
  - 标签页：状态、日志、单元文件。

危险操作不使用 `confirm()`，采用自定义模态确认。停止和重启服务需要显示服务名，并提示可能影响远程连接。

## 数据模型

```ts
interface RemoteServiceSummary {
  name: string;
  displayName: string;
  description: string;
  loadState?: string;
  activeState: 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'unknown';
  subState?: string;
  enabledState?: 'enabled' | 'disabled' | 'static' | 'masked' | 'unknown';
  pid?: number;
}

interface RemoteServiceDetail extends RemoteServiceSummary {
  unitFilePath?: string;
  memory?: string;
  startedAt?: string;
  statusText: string;
  recentLogs: string;
}
```

## 远程命令设计

Linux 检测：

- 优先判断 `command -v systemctl`。
- 列表：`systemctl list-units --type=service --all --no-pager --plain`。
- 启用状态：`systemctl list-unit-files --type=service --no-pager --plain`。
- 详情：`systemctl status <service> --no-pager --lines=80`。
- 日志：`journalctl -u <service> -n 100 --no-pager --output=short-iso`。
- 操作：`systemctl start|stop|restart|reload|enable|disable <service>`。

Windows 检测：

- 列表：PowerShell `Get-Service | Select Name,DisplayName,Status,StartType`。
- 详情：`Get-CimInstance Win32_Service -Filter "Name='<name>'"`。
- 操作：`Start-Service`、`Stop-Service`、`Restart-Service`。

服务名必须做严格参数转义，禁止把用户输入拼接成裸命令。

## IPC 与代码落点

首版可以直接复用 `window.guiSSH.connections.runCommand`，不强制新增 IPC。为降低前端解析复杂度，建议后续新增专用 IPC：

- `connection:list-services`
- `connection:get-service-detail`
- `connection:service-action`

首版文件建议：

- `src/components/remote-desktop/RemoteServiceManager.tsx`
- `src/styles/remote-desktop/_service-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 接入桌面入口：
   - 新增 `service-manager` 应用入口、默认窗口尺寸和图标。
   - 创建基础空状态和加载状态。
2. 实现 Linux `systemd` 列表：
   - 拉取服务列表。
   - 合并启用状态。
   - 完成搜索和筛选。
3. 实现详情和日志：
   - 点击服务后加载状态文本和最近日志。
   - 增加刷新详情。
4. 实现操作按钮：
   - 启动、停止、重启、reload、enable、disable。
   - 操作完成后刷新列表和详情。
5. 加入 Windows 基础兼容：
   - PowerShell 服务列表。
   - 启动、停止、重启。
6. 视觉和主题：
   - 深色和浅色主题都补齐。
   - 操作按钮、状态标签、日志区域保持紧凑。

## 验收标准

- Linux 主机能列出服务并正确区分 running、failed、inactive。
- 点击服务能看到详情和最近日志。
- 对可控服务执行启动、停止、重启后 UI 状态能刷新。
- 服务名包含特殊字符时不会造成命令注入。
- Windows 主机至少能列出服务并执行基础控制。
- `pnpm build` 通过。

## 后续增强

- 支持 user service：`systemctl --user`。
- 支持编辑 unit 文件并 reload daemon。
- 支持实时日志 tail，需要新增流式命令 IPC。
- 支持服务依赖图。
- 支持失败服务一键诊断。
