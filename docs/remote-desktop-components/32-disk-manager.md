# 磁盘管理器功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `disk-manager`），实现入口为 `src/components/remote-desktop/RemoteDiskManager.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

磁盘管理器用于在远程桌面中查看和维护远程主机的块设备、分区、挂载点和 LVM。它补充“磁盘空间分析器”：空间分析器负责定位目录占用来源，磁盘管理器负责设备级存储操作。

## 目标用户场景

- 查看物理磁盘、容量、总线、健康状态和分区结构。
- 查看分区文件系统、卷标、UUID、挂载点或 Windows 盘符。
- 挂载和取消挂载分区。
- 格式化分区或卷。
- 新建和删除分区。
- 在 Linux 主机上初始化 PV、创建 VG、创建 / 扩容 / 删除 LV。
- 从挂载点跳转到文件管理器继续处理文件。

## 首版功能范围

- 磁盘与分区拓扑：
  - Linux 通过 `lsblk` 读取物理磁盘和分区。
  - Windows 通过 `Get-Disk`、`Get-Partition`、`Get-Volume` 读取磁盘、分区和卷。
- 挂载视图：
  - Linux 通过 `findmnt` 读取挂载点、容量、使用率和挂载选项。
  - Windows 通过卷盘符和 AccessPath 读取挂载关系。
- 分区操作：
  - Linux 使用 `parted` 新建 / 删除分区，并执行 `partprobe`。
  - Windows 使用 `New-Partition` / `Remove-Partition`。
- 挂载操作：
  - Linux 使用 `mount` / `umount`。
  - Windows 使用 `Add-PartitionAccessPath` / `Remove-PartitionAccessPath`。
- 格式化：
  - Linux 支持 ext4、xfs、btrfs、vfat、swap。
  - Windows 支持 NTFS、ReFS、exFAT、FAT32。
- LVM：
  - 读取 PV / VG / LV。
  - 支持 `pvcreate`、`vgcreate`、`lvcreate`、`lvextend -r`、`lvremove`。
- 安全边界：
  - 所有写操作先进入自定义确认弹窗。
  - 确认弹窗展示将执行的命令，并支持复制命令。
  - Linux 写操作通过 root 或 `sudo -n sh -c` 执行，仅适合免交互 sudo 环境。

## 交互设计

界面分三列：

- 左侧设备树：物理磁盘和分区层级。
- 中间主视图：拓扑表格、挂载卡片、LVM 列表和原始输出。
- 右侧操作台：根据当前选择显示新建分区、挂载、卸载、格式化、删除分区和 LVM 操作。

破坏性操作使用红色按钮和二次确认。LVM 配置区固定在右侧，便于从分区选择中带入 PV 设备路径。

## 数据模型

```ts
interface ManagedDisk {
  id: string;
  name: string;
  path: string;
  model: string;
  serial: string;
  sizeBytes: number;
  partitionIds: string[];
}

interface ManagedPartition {
  id: string;
  diskId: string;
  device: string;
  fsType: string;
  label: string;
  uuid: string;
  sizeBytes: number;
  mountPoints: string[];
}

interface LvmSnapshot {
  physicalVolumes: LvmPhysicalVolume[];
  volumeGroups: LvmVolumeGroup[];
  logicalVolumes: LvmLogicalVolume[];
}
```

## 远程命令设计

Linux 读取：

- `lsblk -J -b`
- `findmnt -J -b`
- `pvs --reportformat json`
- `vgs --reportformat json`
- `lvs --reportformat json`

Linux 操作：

- `parted -s <disk> print` 检测分区表；空白盘报 `unrecognised disk label` 时先 `parted -s <disk> mklabel gpt`，再 `mkpart primary <fs> <start> <end>`
- `parted -s <disk> rm <partition>`
- `mount <device> <mountPoint>`
- `umount <target>`
- `mkfs.ext4 -F`、`mkfs.xfs -f`、`mkfs.btrfs -f`、`mkfs.vfat`、`mkswap -f`
- `pvcreate -y`
- `vgcreate`
- `lvcreate -L`
- `lvextend -r -L +<size>`
- `lvremove -y`

Windows 读取：

- `Get-Disk`
- `Get-Partition`
- `Get-Volume`

Windows 操作：

- `New-Partition`
- `Remove-Partition`
- `Add-PartitionAccessPath`
- `Remove-PartitionAccessPath`
- `Format-Volume`

## IPC 与代码落点

首版复用 `window.guiSSH.connections.runCommand`，不新增后端 IPC。组件新增和接入文件：

- `src/components/remote-desktop/RemoteDiskManager.tsx`
- `src/components/remote-desktop/diskManagerProviders.ts`
- `src/styles/remote-desktop/_disk-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`
- `src/vite-env.d.ts`

## 开发计划

1. 已实现 Linux / Windows 磁盘、分区、挂载信息读取。
2. 已实现物理磁盘和分区拓扑视图。
3. 已实现挂载点容量视图和文件管理器跳转。
4. 已实现挂载、卸载、格式化、新建分区、删除分区确认流程。
5. 已实现 Linux LVM PV / VG / LV 读取与基础配置命令。
6. 已实现命令预览、复制命令、执行后刷新。

## 验收标准

- Linux 主机能展示 `lsblk` / `findmnt` 结果。
- Windows 主机能展示磁盘、分区和卷信息。
- 所有格式化、删除、LVM 变更必须经过确认弹窗。
- 操作失败时显示 stderr 或可读错误。
- 执行成功后自动刷新磁盘快照。

## 后续增强

- 交互式 sudo 命令转到终端中执行。
- 分区表初始化和 GPT / MBR 转换。
- Windows 动态磁盘和 Storage Spaces 支持。
- LUKS / BitLocker 状态查看。
- fstab / systemd mount unit 持久化挂载配置。
- LVM 快照、迁移和 VG 扩缩容向导。
