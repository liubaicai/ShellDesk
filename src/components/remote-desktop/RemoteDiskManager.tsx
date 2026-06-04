import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  createDiskManagerSnapshotCommand,
  createLinuxCreatePartitionCommand,
  createLinuxDeletePartitionCommand,
  createLinuxFormatCommand,
  createLinuxLvCreateCommand,
  createLinuxLvExtendCommand,
  createLinuxLvRemoveCommand,
  createLinuxMountCommand,
  createLinuxPvCreateCommand,
  createLinuxUnmountCommand,
  createLinuxVgCreateCommand,
  createWindowsCreatePartitionCommand,
  createWindowsDeletePartitionCommand,
  createWindowsFormatCommand,
  createWindowsMountCommand,
  createWindowsUnmountCommand,
  formatDiskBytes,
  parseLinuxDiskManagerSnapshot,
  parseWindowsDiskManagerSnapshot,
  type DiskManagerSnapshot,
  type LinuxFormatFileSystem,
  type ManagedDisk,
  type ManagedMount,
  type ManagedPartition,
  type WindowsFormatFileSystem,
} from './diskManagerProviders';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import type { RemoteSystemType } from './types';

interface RemoteDiskManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenFileManager?: (path: string) => void;
}

type DiskManagerTab = 'topology' | 'mounts' | 'lvm' | 'raw';
type DiskManagerSelection =
  | { kind: 'disk'; id: string }
  | { kind: 'partition'; id: string }
  | { kind: 'mount'; id: string }
  | { kind: 'lv'; id: string };

interface PendingDiskAction {
  title: string;
  command: RemoteCommandInput;
  detail: string;
  danger?: boolean;
}

const linuxFormatOptions: LinuxFormatFileSystem[] = ['ext4', 'xfs', 'btrfs', 'vfat', 'swap'];
const windowsFormatOptions: WindowsFormatFileSystem[] = ['NTFS', 'ReFS', 'exFAT', 'FAT32'];

function runCmd(connectionId: string, input: RemoteCommandInput) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('当前环境不支持远程命令执行');
  }

  return api.runCommand(connectionId, input.command, input.stdin);
}

function getPartitionKey(partition: ManagedPartition) {
  return partition.path || partition.device || partition.id;
}

function getDiskHealthTone(disk: ManagedDisk) {
  const text = `${disk.state} ${disk.health ?? ''}`.toLowerCase();
  if (text.includes('fail') || text.includes('error') || text.includes('degraded')) return 'danger';
  if (text.includes('warning') || text.includes('offline') || text.includes('unknown')) return 'warning';
  return 'ready';
}

function getUseTone(percent: number) {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warning';
  return 'ready';
}

function formatMountTargets(partition: ManagedPartition) {
  return partition.mountPoints.length ? partition.mountPoints.join(', ') : '-';
}

function getWindowsPartitionNumbers(partition: ManagedPartition) {
  const [diskNumber = '', partitionNumber = ''] = partition.path.split(':');
  return { diskNumber, partitionNumber };
}

function getCommandPreview(command: RemoteCommandInput) {
  return command.stdin ? `${command.command}\n\nstdin:\n${command.stdin}` : command.command;
}

function DiskInfoList({ disk }: { disk: ManagedDisk }) {
  return (
    <dl className="disk-manager-facts">
      <div><dt>容量</dt><dd>{disk.sizeText}</dd></div>
      <div><dt>模型</dt><dd>{disk.model || '-'}</dd></div>
      <div><dt>序列号</dt><dd>{disk.serial || '-'}</dd></div>
      <div><dt>总线</dt><dd>{disk.transport || '-'}</dd></div>
      <div><dt>分区表</dt><dd>{disk.partitionStyle || '-'}</dd></div>
      <div><dt>状态</dt><dd>{disk.health || disk.state || '-'}</dd></div>
    </dl>
  );
}

function PartitionInfoList({ partition }: { partition: ManagedPartition }) {
  return (
    <dl className="disk-manager-facts">
      <div><dt>设备</dt><dd>{partition.device || partition.path}</dd></div>
      <div><dt>容量</dt><dd>{partition.sizeText}</dd></div>
      <div><dt>文件系统</dt><dd>{partition.fsType || '-'}</dd></div>
      <div><dt>挂载点</dt><dd>{formatMountTargets(partition)}</dd></div>
      <div><dt>标签</dt><dd>{partition.label || '-'}</dd></div>
      <div><dt>UUID</dt><dd>{partition.uuid || '-'}</dd></div>
    </dl>
  );
}

function MountInfoList({ mount }: { mount: ManagedMount }) {
  return (
    <dl className="disk-manager-facts">
      <div><dt>源</dt><dd>{mount.source || '-'}</dd></div>
      <div><dt>挂载点</dt><dd>{mount.target || '-'}</dd></div>
      <div><dt>文件系统</dt><dd>{mount.fsType || '-'}</dd></div>
      <div><dt>容量</dt><dd>{mount.usedText} / {mount.sizeText}</dd></div>
      <div><dt>可用</dt><dd>{mount.availableText}</dd></div>
      <div><dt>选项</dt><dd>{mount.options || '-'}</dd></div>
    </dl>
  );
}

function RemoteDiskManager({ connectionId, systemType, onOpenFileManager }: RemoteDiskManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [snapshot, setSnapshot] = useState<DiskManagerSnapshot | null>(null);
  const [selection, setSelection] = useState<DiskManagerSelection | null>(null);
  const [activeTab, setActiveTab] = useState<DiskManagerTab>('topology');
  const [loading, setLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingDiskAction | null>(null);
  const [mountPoint, setMountPoint] = useState('/mnt/data');
  const [driveLetter, setDriveLetter] = useState('E');
  const [linuxFormatFs, setLinuxFormatFs] = useState<LinuxFormatFileSystem>('ext4');
  const [windowsFormatFs, setWindowsFormatFs] = useState<WindowsFormatFileSystem>('NTFS');
  const [formatLabel, setFormatLabel] = useState('DATA');
  const [partitionStart, setPartitionStart] = useState('1MiB');
  const [partitionEnd, setPartitionEnd] = useState('100%');
  const [partitionFsHint, setPartitionFsHint] = useState('ext4');
  const [windowsPartitionSizeGb, setWindowsPartitionSizeGb] = useState('');
  const [windowsAssignDriveLetter, setWindowsAssignDriveLetter] = useState(true);
  const [lvmPvDevices, setLvmPvDevices] = useState('');
  const [lvmVgName, setLvmVgName] = useState('vg_data');
  const [lvmLvName, setLvmLvName] = useState('lv_data');
  const [lvmLvSize, setLvmLvSize] = useState('10G');
  const [lvmLvPath, setLvmLvPath] = useState('/dev/vg_data/lv_data');

  const selectedDisk = useMemo(() => (
    selection?.kind === 'disk'
      ? snapshot?.disks.find((disk) => disk.id === selection.id) ?? null
      : null
  ), [selection, snapshot?.disks]);
  const selectedPartition = useMemo(() => (
    selection?.kind === 'partition'
      ? snapshot?.partitions.find((partition) => partition.id === selection.id) ?? null
      : null
  ), [selection, snapshot?.partitions]);
  const selectedMount = useMemo(() => (
    selection?.kind === 'mount'
      ? snapshot?.mounts.find((mount) => mount.id === selection.id) ?? null
      : null
  ), [selection, snapshot?.mounts]);
  const selectedLogicalVolume = useMemo(() => (
    selection?.kind === 'lv'
      ? snapshot?.lvm.logicalVolumes.find((volume) => volume.id === selection.id) ?? null
      : null
  ), [selection, snapshot?.lvm.logicalVolumes]);
  const diskStats = useMemo(() => {
    const diskBytes = snapshot?.disks.reduce((total, disk) => total + disk.sizeBytes, 0) ?? 0;
    const mountedCount = snapshot?.partitions.filter((partition) => partition.isMounted).length ?? 0;

    return {
      diskBytes,
      diskText: formatDiskBytes(diskBytes),
      diskCount: snapshot?.disks.length ?? 0,
      partitionCount: snapshot?.partitions.length ?? 0,
      mountedCount,
      lvmCount: snapshot ? snapshot.lvm.volumeGroups.length + snapshot.lvm.logicalVolumes.length : 0,
    };
  }, [snapshot]);
  const partitionByDiskId = useMemo(() => {
    const groups = new Map<string, ManagedPartition[]>();

    snapshot?.partitions.forEach((partition) => {
      groups.set(partition.diskId, [...(groups.get(partition.diskId) ?? []), partition]);
    });

    return groups;
  }, [snapshot?.partitions]);
  const selectedDiskGroupId = selectedDisk?.id ?? selectedPartition?.diskId ?? '';
  const selectedTitle = selectedDisk?.name
    ?? selectedPartition?.name
    ?? selectedMount?.target
    ?? selectedLogicalVolume?.name
    ?? '未选择';

  const refreshSnapshot = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const command = createDiskManagerSnapshotCommand(isWindowsHost);
      const result = await runCmd(connectionId, command);

      if (result.code !== 0 && !result.stdout.trim()) {
        throw new Error(result.stderr || '磁盘信息读取失败');
      }

      const nextSnapshot = isWindowsHost
        ? parseWindowsDiskManagerSnapshot(result.stdout, result.stderr)
        : parseLinuxDiskManagerSnapshot(result.stdout, result.stderr);
      setSnapshot(nextSnapshot);
      setSelection((currentSelection) => {
        if (currentSelection?.kind === 'disk' && nextSnapshot.disks.some((disk) => disk.id === currentSelection.id)) return currentSelection;
        if (currentSelection?.kind === 'partition' && nextSnapshot.partitions.some((partition) => partition.id === currentSelection.id)) return currentSelection;
        if (currentSelection?.kind === 'mount' && nextSnapshot.mounts.some((mount) => mount.id === currentSelection.id)) return currentSelection;
        if (currentSelection?.kind === 'lv' && nextSnapshot.lvm.logicalVolumes.some((volume) => volume.id === currentSelection.id)) return currentSelection;

        const firstPartition = nextSnapshot.partitions[0];
        const firstDisk = nextSnapshot.disks[0];
        if (firstPartition) return { kind: 'partition', id: firstPartition.id };
        if (firstDisk) return { kind: 'disk', id: firstDisk.id };
        return null;
      });
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      if (nextSnapshot.notice) {
        setNotice(nextSnapshot.notice);
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [connectionId, isWindowsHost]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    if (selectedPartition && !isWindowsHost) {
      setLvmPvDevices(selectedPartition.device);
      if (!selectedPartition.isMounted) {
        setMountPoint(`/mnt/${selectedPartition.name.replace(/[^A-Za-z0-9_.-]/g, '') || 'disk'}`);
      }
    }
  }, [isWindowsHost, selectedPartition]);

  useEffect(() => {
    if (selectedPartition?.driveLetter) {
      setDriveLetter(selectedPartition.driveLetter);
    }
  }, [selectedPartition?.driveLetter]);

  useEffect(() => {
    if (selectedLogicalVolume?.path) {
      setLvmLvPath(selectedLogicalVolume.path);
      setLvmVgName(selectedLogicalVolume.vgName);
      setLvmLvName(selectedLogicalVolume.name);
    }
  }, [selectedLogicalVolume]);

  const prepareAction = (title: string, detail: string, command: RemoteCommandInput, danger = false) => {
    setPendingAction({ title, detail, command, danger });
  };

  const prepareMount = () => {
    if (!selectedPartition) return;

    try {
      if (isWindowsHost) {
        const { diskNumber, partitionNumber } = getWindowsPartitionNumbers(selectedPartition);
        prepareAction(
          `挂载 ${selectedPartition.name}`,
          `为 ${selectedPartition.name} 分配 ${driveLetter.toUpperCase()}: 盘符。`,
          createWindowsMountCommand(diskNumber, partitionNumber, driveLetter),
        );
        return;
      }

      prepareAction(
        `挂载 ${selectedPartition.device}`,
        `将 ${selectedPartition.device} 挂载到 ${mountPoint}。`,
        createLinuxMountCommand(selectedPartition.device, mountPoint),
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareUnmount = () => {
    if (!selectedPartition && !selectedMount) return;

    try {
      if (isWindowsHost && selectedPartition) {
        const { diskNumber, partitionNumber } = getWindowsPartitionNumbers(selectedPartition);
        const accessPath = selectedPartition.mountPoints[0] ?? `${selectedPartition.driveLetter}:\\`;
        prepareAction(
          `取消挂载 ${selectedPartition.name}`,
          `移除 ${accessPath} 访问路径。`,
          createWindowsUnmountCommand(diskNumber, partitionNumber, accessPath),
          true,
        );
        return;
      }

      const target = selectedMount?.target || selectedPartition?.mountPoints[0] || selectedPartition?.device || '';
      prepareAction(
        `取消挂载 ${target}`,
        `对 ${target} 执行 umount。`,
        createLinuxUnmountCommand(target),
        true,
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareFormat = () => {
    if (!selectedPartition) return;

    try {
      if (isWindowsHost) {
        const letter = selectedPartition.driveLetter || driveLetter;
        prepareAction(
          `格式化 ${letter.toUpperCase()}:`,
          `将 ${letter.toUpperCase()}: 格式化为 ${windowsFormatFs}，卷标为 ${formatLabel || '-' }。`,
          createWindowsFormatCommand(letter, windowsFormatFs, formatLabel),
          true,
        );
        return;
      }

      prepareAction(
        `格式化 ${selectedPartition.device}`,
        `将 ${selectedPartition.device} 格式化为 ${linuxFormatFs}，现有数据会被清空。`,
        createLinuxFormatCommand(selectedPartition.device, linuxFormatFs, formatLabel),
        true,
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareCreatePartition = () => {
    if (!selectedDisk) return;

    try {
      if (isWindowsHost) {
        prepareAction(
          `新建分区 Disk ${selectedDisk.path}`,
          windowsPartitionSizeGb.trim()
            ? `在 Disk ${selectedDisk.path} 上新建 ${windowsPartitionSizeGb} GB 分区。`
            : `在 Disk ${selectedDisk.path} 上使用剩余空间新建分区。`,
          createWindowsCreatePartitionCommand(selectedDisk.path, windowsPartitionSizeGb, windowsAssignDriveLetter),
          true,
        );
        return;
      }

      prepareAction(
        `新建分区 ${selectedDisk.path}`,
        `在 ${selectedDisk.path} 上创建 ${partitionStart} 到 ${partitionEnd} 的 primary 分区；如果磁盘没有可识别分区表，会先初始化 GPT 分区表。`,
        createLinuxCreatePartitionCommand(selectedDisk.path, partitionFsHint, partitionStart, partitionEnd),
        true,
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareDeletePartition = () => {
    if (!selectedPartition) return;

    try {
      if (isWindowsHost) {
        const { diskNumber, partitionNumber } = getWindowsPartitionNumbers(selectedPartition);
        prepareAction(
          `删除 ${selectedPartition.name}`,
          `删除 Disk ${diskNumber} Partition ${partitionNumber}，分区内数据会丢失。`,
          createWindowsDeletePartitionCommand(diskNumber, partitionNumber),
          true,
        );
        return;
      }

      prepareAction(
        `删除 ${selectedPartition.device}`,
        `从所属磁盘的分区表中删除 ${selectedPartition.device}。`,
        createLinuxDeletePartitionCommand(selectedPartition.device),
        true,
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const preparePvCreate = () => {
    if (!selectedPartition) return;

    try {
      prepareAction(
        `初始化 PV ${selectedPartition.device}`,
        `把 ${selectedPartition.device} 初始化为 LVM Physical Volume。`,
        createLinuxPvCreateCommand(selectedPartition.device),
        true,
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareVgCreate = () => {
    try {
      prepareAction(
        `创建 VG ${lvmVgName}`,
        `使用 ${lvmPvDevices} 创建 Volume Group。`,
        createLinuxVgCreateCommand(lvmVgName, lvmPvDevices),
        true,
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareLvCreate = () => {
    try {
      prepareAction(
        `创建 LV ${lvmLvName}`,
        `在 ${lvmVgName} 中创建 ${lvmLvSize} 的 Logical Volume。`,
        createLinuxLvCreateCommand(lvmVgName, lvmLvName, lvmLvSize),
        true,
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareLvExtend = () => {
    try {
      prepareAction(
        `扩容 ${lvmLvPath}`,
        `对 ${lvmLvPath} 增加 ${lvmLvSize}，并尝试在线扩展文件系统。`,
        createLinuxLvExtendCommand(lvmLvPath, lvmLvSize),
        true,
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareLvRemove = () => {
    try {
      prepareAction(
        `删除 ${lvmLvPath}`,
        `删除 Logical Volume ${lvmLvPath}，其中数据会丢失。`,
        createLinuxLvRemoveCommand(lvmLvPath),
        true,
      );
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const executePendingAction = async () => {
    if (!pendingAction) {
      return;
    }

    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, pendingAction.command);
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || '命令执行失败');
      }

      setNotice(result.stdout.trim() || result.stderr.trim() || '操作已执行');
      setPendingAction(null);
      await refreshSnapshot();
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const copyPendingCommand = async () => {
    if (!pendingAction) return;
    await navigator.clipboard.writeText(getCommandPreview(pendingAction.command));
    setNotice('命令已复制');
  };

  const copySelectedInfo = async () => {
    const lines = [
      `选择项: ${selectedTitle}`,
      selectedDisk ? `磁盘: ${selectedDisk.path} ${selectedDisk.sizeText} ${selectedDisk.model}` : '',
      selectedPartition ? `分区: ${selectedPartition.device} ${selectedPartition.sizeText} ${selectedPartition.fsType} ${formatMountTargets(selectedPartition)}` : '',
      selectedMount ? `挂载: ${selectedMount.source} -> ${selectedMount.target} ${selectedMount.usedText}/${selectedMount.sizeText}` : '',
      selectedLogicalVolume ? `LV: ${selectedLogicalVolume.path} ${selectedLogicalVolume.sizeText}` : '',
    ].filter(Boolean).join('\n');

    await navigator.clipboard.writeText(lines);
    setNotice('当前选择信息已复制');
  };

  const openSelectedMount = () => {
    const target = selectedMount?.target || selectedPartition?.mountPoints[0] || '';
    if (target) {
      onOpenFileManager?.(target);
    }
  };

  return (
    <section className="disk-manager">
      <header className="disk-manager-toolbar">
        <div className="disk-manager-status">
          <span>Disk Manager</span>
          <strong>{isWindowsHost ? 'Windows 存储管理' : 'Linux 磁盘与 LVM'}</strong>
          <em>{lastRefreshedAt ? `刷新于 ${lastRefreshedAt}` : '等待读取磁盘信息'}</em>
        </div>
        <div className="disk-manager-metrics">
          <span><strong>{diskStats.diskCount}</strong> 磁盘</span>
          <span><strong>{diskStats.partitionCount}</strong> 分区</span>
          <span><strong>{diskStats.mountedCount}</strong> 已挂载</span>
          <span><strong>{diskStats.diskText}</strong> 总容量</span>
        </div>
        <button type="button" className="primary" onClick={refreshSnapshot} disabled={loading}>
          {loading ? '读取中' : '刷新'}
        </button>
      </header>

      {error ? <DismissibleAlert className="disk-manager-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="disk-manager-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="disk-manager-layout">
        <aside className="disk-manager-sidebar">
          <div className="disk-manager-panel-heading">
            <span>设备树</span>
            <strong>物理磁盘与分区</strong>
          </div>
          <div className="disk-manager-tree" aria-busy={loading}>
            {snapshot?.disks.map((disk) => {
              const partitions = partitionByDiskId.get(disk.id) ?? [];
              const diskTone = getDiskHealthTone(disk);

              return (
                <div className="disk-manager-tree-group" key={disk.id}>
                  <button
                    type="button"
                    className={`disk-manager-disk-node ${selection?.kind === 'disk' && selection.id === disk.id ? 'active' : ''}`}
                    onClick={() => setSelection({ kind: 'disk', id: disk.id })}
                  >
                    <span className={`disk-manager-node-tone ${diskTone}`} />
                    <span className="disk-manager-disk-node-content">
                      <strong>{disk.name}</strong>
                      <span className="disk-manager-disk-size">{disk.sizeText}</span>
                      <small title={[disk.name, disk.sizeText, disk.model].filter(Boolean).join(' · ')}>
                        {disk.model ? <span className="disk-manager-disk-model">{disk.model}</span> : null}
                      </small>
                    </span>
                  </button>
                  <div className="disk-manager-partition-children">
                    {partitions.map((partition) => (
                      <button
                        type="button"
                        key={partition.id}
                        className={selection?.kind === 'partition' && selection.id === partition.id ? 'active' : ''}
                        onClick={() => setSelection({ kind: 'partition', id: partition.id })}
                      >
                        <span className={partition.isMounted ? 'mounted' : ''}>{partition.isMounted ? 'MNT' : 'PART'}</span>
                        <strong>{partition.name}</strong>
                        <small>{partition.sizeText} · {partition.fsType || '-'}</small>
                      </button>
                    ))}
                    {!partitions.length ? <div className="disk-manager-empty-branch">暂无分区</div> : null}
                  </div>
                </div>
              );
            })}
            {!loading && !snapshot?.disks.length ? <div className="disk-manager-empty">未读取到磁盘</div> : null}
          </div>
        </aside>

        <main className="disk-manager-main">
          <div className="disk-manager-tabs">
            <button type="button" className={activeTab === 'topology' ? 'active' : ''} onClick={() => setActiveTab('topology')}>拓扑</button>
            <button type="button" className={activeTab === 'mounts' ? 'active' : ''} onClick={() => setActiveTab('mounts')}>挂载</button>
            <button type="button" className={activeTab === 'lvm' ? 'active' : ''} onClick={() => setActiveTab('lvm')}>LVM</button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>原始输出</button>
          </div>

          {activeTab === 'topology' ? (
            <div className="disk-manager-table-wrap">
              <table className="disk-manager-table">
                <thead>
                  <tr>
                    <th>设备</th>
                    <th>类型</th>
                    <th>容量</th>
                    <th>文件系统</th>
                    <th>挂载点 / 盘符</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot?.disks.map((disk) => {
                    const partitions = partitionByDiskId.get(disk.id) ?? [];
                    const isDiskActive = selection?.kind === 'disk' && selection.id === disk.id;
                    const isDiskGroupActive = selectedDiskGroupId === disk.id;

                    return (
                      <Fragment key={disk.id}>
                        <tr
                          className={`disk-manager-disk-row ${isDiskActive ? 'active' : ''} ${isDiskGroupActive ? 'group-active' : ''}`}
                          onClick={() => setSelection({ kind: 'disk', id: disk.id })}
                          aria-selected={isDiskActive}
                        >
                          <td>
                            <span className="disk-manager-device-cell root">
                              <span className={`disk-manager-node-tone ${getDiskHealthTone(disk)}`} />
                              <span>
                                <strong>{disk.path || disk.name}</strong>
                                <small>{disk.model}</small>
                              </span>
                            </span>
                          </td>
                          <td>物理磁盘</td>
                          <td>{disk.sizeText}</td>
                          <td>{disk.partitionStyle || '-'}</td>
                          <td>{disk.transport || '-'}</td>
                          <td><span className={`disk-manager-status-pill ${getDiskHealthTone(disk)}`}>{disk.health || disk.state || '-'}</span></td>
                        </tr>
                        {partitions.map((partition) => {
                          const isPartitionActive = selection?.kind === 'partition' && selection.id === partition.id;

                          return (
                            <tr
                              key={partition.id}
                              className={`disk-manager-partition-row ${isPartitionActive ? 'active' : ''} ${isDiskGroupActive ? 'group-active' : ''}`}
                              onClick={() => setSelection({ kind: 'partition', id: partition.id })}
                              aria-selected={isPartitionActive}
                            >
                              <td>
                                <span className="disk-manager-device-cell child">
                                  <span className="disk-manager-tree-branch" aria-hidden="true" />
                                  <span className={`disk-manager-table-badge ${partition.isMounted ? 'mounted' : ''}`}>{partition.isMounted ? 'MNT' : 'PART'}</span>
                                  <span>
                                    <strong>{partition.device || partition.name}</strong>
                                    <small>{partition.label || partition.uuid || getPartitionKey(partition)}</small>
                                  </span>
                                </span>
                              </td>
                              <td>{partition.type || 'partition'}</td>
                              <td>{partition.sizeText}</td>
                              <td>{partition.fsType || '-'}</td>
                              <td>{formatMountTargets(partition)}</td>
                              <td><span className={`disk-manager-status-pill ${partition.isMounted ? 'ready' : 'idle'}`}>{partition.isMounted ? '已挂载' : '未挂载'}</span></td>
                            </tr>
                          );
                        })}
                        {!partitions.length ? (
                          <tr className={`disk-manager-partition-row empty ${isDiskGroupActive ? 'group-active' : ''}`} onClick={() => setSelection({ kind: 'disk', id: disk.id })}>
                            <td colSpan={6}>
                              <span className="disk-manager-device-cell child empty">
                                <span className="disk-manager-tree-branch" aria-hidden="true" />
                                <span>暂无分区</span>
                              </span>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {activeTab === 'mounts' ? (
            <div className="disk-manager-mount-grid">
              {snapshot?.mounts.map((mount) => (
                <button
                  type="button"
                  key={mount.id}
                  className={selection?.kind === 'mount' && selection.id === mount.id ? 'active' : ''}
                  onClick={() => setSelection({ kind: 'mount', id: mount.id })}
                >
                  <span>
                    <strong>{mount.target}</strong>
                    <small>{mount.source} · {mount.fsType}</small>
                  </span>
                  <em>{mount.usedText} / {mount.sizeText}</em>
                  <i><b className={getUseTone(mount.usePercent)} style={{ width: `${mount.usePercent}%` }} /></i>
                  <mark>{mount.usePercent}%</mark>
                </button>
              ))}
              {!snapshot?.mounts.length ? <div className="disk-manager-empty">暂无挂载点</div> : null}
            </div>
          ) : null}

          {activeTab === 'lvm' ? (
            <div className="disk-manager-lvm">
              {isWindowsHost ? (
                <div className="disk-manager-empty">Windows 主机不提供 LVM。请使用分区、盘符和卷格式化操作。</div>
              ) : (
                <>
                  <section>
                    <div className="disk-manager-section-heading">
                      <span>Physical Volumes</span>
                      <strong>{snapshot?.lvm.physicalVolumes.length ?? 0} 个 PV</strong>
                    </div>
                    <div className="disk-manager-mini-table">
                      {snapshot?.lvm.physicalVolumes.map((pv) => (
                        <div key={pv.id}>
                          <strong>{pv.name}</strong>
                          <span>{pv.vgName}</span>
                          <span>{pv.freeText} / {pv.sizeText}</span>
                          <em>{pv.attr || '-'}</em>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section>
                    <div className="disk-manager-section-heading">
                      <span>Volume Groups</span>
                      <strong>{snapshot?.lvm.volumeGroups.length ?? 0} 个 VG</strong>
                    </div>
                    <div className="disk-manager-mini-table">
                      {snapshot?.lvm.volumeGroups.map((vg) => (
                        <div key={vg.id}>
                          <strong>{vg.name}</strong>
                          <span>{vg.lvCount} LV / {vg.pvCount} PV</span>
                          <span>{vg.freeText} / {vg.sizeText}</span>
                          <em>{vg.attr || '-'}</em>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section>
                    <div className="disk-manager-section-heading">
                      <span>Logical Volumes</span>
                      <strong>{snapshot?.lvm.logicalVolumes.length ?? 0} 个 LV</strong>
                    </div>
                    <div className="disk-manager-mini-table">
                      {snapshot?.lvm.logicalVolumes.map((lv) => (
                        <button type="button" key={lv.id} className={selection?.kind === 'lv' && selection.id === lv.id ? 'active' : ''} onClick={() => setSelection({ kind: 'lv', id: lv.id })}>
                          <strong>{lv.path}</strong>
                          <span>{lv.vgName}/{lv.name}</span>
                          <span>{lv.sizeText}</span>
                          <em>{lv.attr || '-'}</em>
                        </button>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </div>
          ) : null}

          {activeTab === 'raw' ? (
            <pre className="disk-manager-raw">{snapshot?.rawOutput || '暂无输出'}</pre>
          ) : null}
        </main>

        <aside className="disk-manager-action-panel">
          <div className="disk-manager-panel-heading">
            <span>操作台</span>
            <strong title={selectedTitle}>{selectedTitle}</strong>
          </div>

          <div className="disk-manager-detail-card">
            {selectedDisk ? <DiskInfoList disk={selectedDisk} /> : null}
            {selectedPartition ? <PartitionInfoList partition={selectedPartition} /> : null}
            {selectedMount ? <MountInfoList mount={selectedMount} /> : null}
            {selectedLogicalVolume ? (
              <dl className="disk-manager-facts">
                <div><dt>路径</dt><dd>{selectedLogicalVolume.path}</dd></div>
                <div><dt>VG</dt><dd>{selectedLogicalVolume.vgName}</dd></div>
                <div><dt>容量</dt><dd>{selectedLogicalVolume.sizeText}</dd></div>
                <div><dt>属性</dt><dd>{selectedLogicalVolume.attr || '-'}</dd></div>
              </dl>
            ) : null}
            {!selectedDisk && !selectedPartition && !selectedMount && !selectedLogicalVolume ? <div className="disk-manager-empty detail">选择左侧磁盘或分区</div> : null}
            <div className="disk-manager-inline-actions">
              <button type="button" onClick={copySelectedInfo} disabled={!selection}>复制信息</button>
              <button type="button" onClick={openSelectedMount} disabled={!onOpenFileManager || (!selectedMount && !selectedPartition?.mountPoints.length)}>打开目录</button>
            </div>
          </div>

          {selectedDisk ? (
            <div className="disk-manager-action-card">
              <strong>新建分区</strong>
              {isWindowsHost ? (
                <>
                  <label><span>容量 GB</span><input value={windowsPartitionSizeGb} onChange={(event) => setWindowsPartitionSizeGb(event.target.value)} placeholder="留空使用剩余空间" /></label>
                  <label className="disk-manager-check"><input type="checkbox" checked={windowsAssignDriveLetter} onChange={(event) => setWindowsAssignDriveLetter(event.target.checked)} />自动分配盘符</label>
                </>
              ) : (
                <>
                  <label><span>文件系统提示</span><input value={partitionFsHint} onChange={(event) => setPartitionFsHint(event.target.value)} /></label>
                  <div className="disk-manager-two-col">
                    <label><span>开始</span><input value={partitionStart} onChange={(event) => setPartitionStart(event.target.value)} /></label>
                    <label><span>结束</span><input value={partitionEnd} onChange={(event) => setPartitionEnd(event.target.value)} /></label>
                  </div>
                </>
              )}
              <button type="button" className="danger" onClick={prepareCreatePartition}>预览新建分区</button>
            </div>
          ) : null}

          {selectedPartition ? (
            <>
              <div className="disk-manager-action-card">
                <strong>挂载 / 取消挂载</strong>
                {isWindowsHost ? (
                  <label><span>盘符</span><input value={driveLetter} onChange={(event) => setDriveLetter(event.target.value)} /></label>
                ) : (
                  <label><span>挂载目录</span><input value={mountPoint} onChange={(event) => setMountPoint(event.target.value)} /></label>
                )}
                <div className="disk-manager-two-buttons">
                  <button type="button" className="primary" onClick={prepareMount}>预览挂载</button>
                  <button type="button" className="danger" onClick={prepareUnmount} disabled={!selectedPartition.isMounted}>预览卸载</button>
                </div>
              </div>

              <div className="disk-manager-action-card">
                <strong>格式化</strong>
                <div className="disk-manager-two-col">
                  <label>
                    <span>文件系统</span>
                    <select value={isWindowsHost ? windowsFormatFs : linuxFormatFs} onChange={(event) => {
                      if (isWindowsHost) {
                        setWindowsFormatFs(event.target.value as WindowsFormatFileSystem);
                      } else {
                        setLinuxFormatFs(event.target.value as LinuxFormatFileSystem);
                      }
                    }}>
                      {(isWindowsHost ? windowsFormatOptions : linuxFormatOptions).map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  <label><span>卷标</span><input value={formatLabel} onChange={(event) => setFormatLabel(event.target.value)} /></label>
                </div>
                <button type="button" className="danger" onClick={prepareFormat}>预览格式化</button>
              </div>

              <div className="disk-manager-action-card">
                <strong>分区维护</strong>
                <button type="button" className="danger" onClick={prepareDeletePartition}>预览删除分区</button>
                {!isWindowsHost ? <button type="button" onClick={preparePvCreate}>初始化为 LVM PV</button> : null}
              </div>
            </>
          ) : null}

          {selectedMount && !selectedPartition ? (
            <div className="disk-manager-action-card">
              <strong>挂载点维护</strong>
              <button type="button" className="danger" onClick={prepareUnmount}>预览取消挂载</button>
            </div>
          ) : null}

          {!isWindowsHost ? (
            <div className="disk-manager-action-card">
              <strong>LVM 配置</strong>
              <label><span>PV 设备</span><input value={lvmPvDevices} onChange={(event) => setLvmPvDevices(event.target.value)} placeholder="/dev/sdb1 /dev/sdc1" /></label>
              <div className="disk-manager-two-col">
                <label><span>VG</span><input value={lvmVgName} onChange={(event) => setLvmVgName(event.target.value)} /></label>
                <label><span>LV</span><input value={lvmLvName} onChange={(event) => setLvmLvName(event.target.value)} /></label>
              </div>
              <div className="disk-manager-two-col">
                <label><span>容量</span><input value={lvmLvSize} onChange={(event) => setLvmLvSize(event.target.value)} /></label>
                <label><span>LV 路径</span><input value={lvmLvPath} onChange={(event) => setLvmLvPath(event.target.value)} /></label>
              </div>
              <div className="disk-manager-grid-buttons">
                <button type="button" onClick={prepareVgCreate}>创建 VG</button>
                <button type="button" onClick={prepareLvCreate}>创建 LV</button>
                <button type="button" onClick={prepareLvExtend}>扩容 LV</button>
                <button type="button" className="danger" onClick={prepareLvRemove}>删除 LV</button>
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      {pendingAction ? createPortal(
        <div className="disk-manager-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !actionRunning) setPendingAction(null); }}>
          <section className="disk-manager-confirm" role="dialog" aria-modal="true" aria-label={pendingAction.title}>
            <div className="disk-manager-confirm-header">
              <span>{pendingAction.danger ? '高风险操作确认' : '执行确认'}</span>
              <strong>{pendingAction.title}</strong>
            </div>
            <p>{pendingAction.detail}</p>
            <pre>{getCommandPreview(pendingAction.command)}</pre>
            <div className="disk-manager-confirm-actions">
              <button type="button" onClick={copyPendingCommand}>复制命令</button>
              <button type="button" onClick={() => setPendingAction(null)} disabled={actionRunning}>取消</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? '执行中' : '执行'}
              </button>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default RemoteDiskManager;
