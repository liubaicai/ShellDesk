# 虚拟机管理器

> 当前状态：P0 与 P1 已接入远程桌面（appKey: `vm-manager`），实现入口为 `src/components/remote-desktop/RemoteVirtualMachineManager.tsx`。

## 定位

通过远端 Linux 主机上的 `virsh` 管理 libvirt，不新增系统 SSH 或本地 libvirt 依赖。所有命令继续经 ShellDesk 的 russh 命令通道执行；权限不足时复用现有 sudo 提示。

## 当前实现范围

### P0：连接、清单和生命周期

- 自动探测 `virsh`，显示 libvirt URI、版本、Hypervisor、主机 CPU 与内存摘要。
- 默认连接 `qemu:///system`，支持 `qemu:///session`、Xen、LXC 或自定义 URI。
- 虚拟机列表、名称/UUID 搜索，并展示状态、vCPU、内存、IP 与自启动信息。
- 列表底部和详情侧栏同时提供与当前选择联动的生命周期操作栏。
- 启动、关机、重启、暂停、恢复、重置、强制停止和自启动开关。
- 串口控制台联动 ShellDesk 终端；VNC 图形控制台联动现有 VNC Viewer 并预填 SSH 隧道目标。
- 重置和强制停止必须在自定义确认弹窗中输入虚拟机名。

### P1：详情、快照、网络和存储

- 详情侧栏提供概览、性能统计、磁盘、网卡/IP、快照和只读 XML。
- 创建磁盘快照，支持 guest quiesce；支持回滚和删除快照。
- libvirt 虚拟网络列表、启停与自启动开关。
- 存储池列表、启停、刷新、自启动开关，以及池内卷和容量信息。
- 所有危险写操作都通过 Portal 自定义弹窗确认，不使用浏览器原生 `confirm()`。

## 代码落点

- `src/components/remote-desktop/RemoteVirtualMachineManager.tsx`
- `src/components/remote-desktop/VirtualMachineDetailPanel.tsx`
- `src/components/remote-desktop/VirtualMachineDialogs.tsx`
- `src/components/remote-desktop/virshCommands.ts`
- `src/components/remote-desktop/virshParsers.ts`
- `src/components/remote-desktop/virshTypes.ts`
- `src/styles/remote-desktop/_vm-manager.scss`
- `src/assets/desktop-icons/vm-manager.png`

## 命令与数据边界

- 所有非交互命令显式使用 `virsh --connect <URI>`，并设置 `LC_ALL=C` 以稳定解析边界。
- 虚拟机定义 XML 使用浏览器 `DOMParser` 解析；性能使用 `domstats`；IP 优先读取 guest agent，再回退 DHCP lease。
- 组件不直接调用 Tauri API，只通过既有 `window.guiSSH.connections.runCommand()` 路径。
- Windows SSH 目标显示不支持提示，不尝试安装 WSL、libvirt 或其他依赖。

## 设计边界

- 主界面采用约 68:32 的清单/详情分栏、蓝色选中态、六项资源摘要和紧凑单列详情，布局以 1584 × 992 设计稿为主基准，并在 980 × 760 保持无横向溢出。
- 当前不负责安装 libvirt/virsh，也不在 UI 中创建或编辑虚拟机定义。
- “新建虚拟机”当前作为 P2 入口提示，不会发送未实现的创建命令。
- VNC 仅复用现有 Viewer；SPICE 图形控制台尚未接入。
- 统计数据为刷新时快照，不是持续采样曲线。
- 网络页当前管理虚拟网络本身，不提供 DHCP 租约编辑。

## 后续增强

- 虚拟机创建/克隆向导、CPU/内存热调整和设备挂载。
- SPICE 控制台、实时性能曲线、迁移与备份任务。
- 网络 XML、DHCP 租约和存储卷创建/删除。
