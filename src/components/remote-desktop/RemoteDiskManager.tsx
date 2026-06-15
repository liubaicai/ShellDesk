import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';
import { useSudoCommand } from './sudoPrompt';

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
import { tCurrent } from '../../i18n';

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

function isSudoPrivilegeFailure(error: unknown) {
  const message = getErrorMessage(error);

  if (/su root|root 密码|SHELLDESK_SU_ROOT/i.test(message)) {
    return /authentication fail|incorrect password|permission denied|不能通过 su root|无法.*su root|密码验证失败|认证失败|权限不足/i.test(message);
  }

  return /sudo|sudoers/i.test(message) && (
    /sudoers/i.test(message) ||
    /may not run/i.test(message) ||
    /not allowed/i.test(message) ||
    /not permitted/i.test(message) ||
    /permission denied/i.test(message) ||
    /authentication fail/i.test(message) ||
    /incorrect password/i.test(message) ||
    /sorry,\s*try again/i.test(message) ||
    /不在.*sudoers/i.test(message) ||
    /不允许|未授权|认证失败|密码验证失败|权限不足/i.test(message)
  );
}

function DiskInfoList({ disk }: { disk: ManagedDisk }) {
  return (
    <dl className="disk-manager-facts">
      <div><dt>{tCurrent('diskManager.field.capacity')}</dt><dd>{disk.sizeText}</dd></div>
      <div><dt>{tCurrent('diskManager.field.model')}</dt><dd>{disk.model || '-'}</dd></div>
      <div><dt>{tCurrent('diskManager.field.serial')}</dt><dd>{disk.serial || '-'}</dd></div>
      <div><dt>{tCurrent('diskManager.field.bus')}</dt><dd>{disk.transport || '-'}</dd></div>
      <div><dt>{tCurrent('diskManager.field.partitionTable')}</dt><dd>{disk.partitionStyle || '-'}</dd></div>
      <div><dt>{tCurrent('diskManager.field.status')}</dt><dd>{disk.health || disk.state || '-'}</dd></div>
    </dl>
  );
}

function PartitionInfoList({ partition }: { partition: ManagedPartition }) {
  return (
    <dl className="disk-manager-facts">
      <div><dt>{tCurrent('diskManager.field.device')}</dt><dd>{partition.device || partition.path}</dd></div>
      <div><dt>{tCurrent('diskManager.field.capacity')}</dt><dd>{partition.sizeText}</dd></div>
      <div><dt>{tCurrent('diskManager.field.fileSystem')}</dt><dd>{partition.fsType || '-'}</dd></div>
      <div><dt>{tCurrent('diskManager.field.mountPoint')}</dt><dd>{formatMountTargets(partition)}</dd></div>
      <div><dt>{tCurrent('diskManager.field.label')}</dt><dd>{partition.label || '-'}</dd></div>
      <div><dt>UUID</dt><dd>{partition.uuid || '-'}</dd></div>
    </dl>
  );
}

function MountInfoList({ mount }: { mount: ManagedMount }) {
  return (
    <dl className="disk-manager-facts">
      <div><dt>{tCurrent('diskManager.field.source')}</dt><dd>{mount.source || '-'}</dd></div>
      <div><dt>{tCurrent('diskManager.field.mountPoint')}</dt><dd>{mount.target || '-'}</dd></div>
      <div><dt>{tCurrent('diskManager.field.fileSystem')}</dt><dd>{mount.fsType || '-'}</dd></div>
      <div><dt>{tCurrent('diskManager.field.capacity')}</dt><dd>{mount.usedText} / {mount.sizeText}</dd></div>
      <div><dt>{tCurrent('diskManager.field.available')}</dt><dd>{mount.availableText}</dd></div>
      <div><dt>{tCurrent('diskManager.field.options')}</dt><dd>{mount.options || '-'}</dd></div>
    </dl>
  );
}

function RemoteDiskManager({ connectionId, systemType, onOpenFileManager }: RemoteDiskManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
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
    ?? tCurrent('diskManager.status.notSelected');

  const refreshSnapshot = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const command = createDiskManagerSnapshotCommand(isWindowsHost);
      const result = await runCommand(command);

      if (result.code !== 0 && !result.stdout.trim()) {
        throw new Error(result.stderr || tCurrent('diskManager.error.readFailed'));
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
  }, [isWindowsHost, runCommand]);

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
          tCurrent('diskManager.confirm.mountWindows.title', { name: selectedPartition.name }),
          tCurrent('diskManager.confirm.mountWindows.detail', { name: selectedPartition.name, letter: driveLetter.toUpperCase() }),
          createWindowsMountCommand(diskNumber, partitionNumber, driveLetter),
        );
        return;
      }

      prepareAction(
        tCurrent('diskManager.confirm.mountLinux.title', { device: selectedPartition.device }),
        tCurrent('diskManager.confirm.mountLinux.detail', { device: selectedPartition.device, mountPoint }),
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
          tCurrent('diskManager.confirm.unmountWindows.title', { name: selectedPartition.name }),
          tCurrent('diskManager.confirm.unmountWindows.detail', { path: accessPath }),
          createWindowsUnmountCommand(diskNumber, partitionNumber, accessPath),
          true,
        );
        return;
      }

      const target = selectedMount?.target || selectedPartition?.mountPoints[0] || selectedPartition?.device || '';
      prepareAction(
        tCurrent('diskManager.confirm.unmountLinux.title', { target }),
        tCurrent('diskManager.confirm.unmountLinux.detail', { target }),
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
          tCurrent('diskManager.confirm.formatWindows.title', { letter: letter.toUpperCase() }),
          tCurrent('diskManager.confirm.formatWindows.detail', { letter: letter.toUpperCase(), fs: windowsFormatFs, label: formatLabel || '-' }),
          createWindowsFormatCommand(letter, windowsFormatFs, formatLabel),
          true,
        );
        return;
      }

      prepareAction(
        tCurrent('diskManager.confirm.formatLinux.title', { device: selectedPartition.device }),
        tCurrent('diskManager.confirm.formatLinux.detail', { device: selectedPartition.device, fs: linuxFormatFs }),
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
          tCurrent('diskManager.confirm.createPartitionWindows.title', { disk: selectedDisk.path }),
          windowsPartitionSizeGb.trim()
            ? tCurrent('diskManager.confirm.createPartitionWindows.detailSized', { disk: selectedDisk.path, size: windowsPartitionSizeGb })
            : tCurrent('diskManager.confirm.createPartitionWindows.detailRemaining', { disk: selectedDisk.path }),
          createWindowsCreatePartitionCommand(selectedDisk.path, windowsPartitionSizeGb, windowsAssignDriveLetter),
          true,
        );
        return;
      }

      prepareAction(
        tCurrent('diskManager.confirm.createPartitionLinux.title', { disk: selectedDisk.path }),
        tCurrent('diskManager.confirm.createPartitionLinux.detail', { disk: selectedDisk.path, start: partitionStart, end: partitionEnd }),
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
          tCurrent('diskManager.confirm.deletePartitionWindows.title', { name: selectedPartition.name }),
          tCurrent('diskManager.confirm.deletePartitionWindows.detail', { diskNumber, partitionNumber }),
          createWindowsDeletePartitionCommand(diskNumber, partitionNumber),
          true,
        );
        return;
      }

      prepareAction(
        tCurrent('diskManager.confirm.deletePartitionLinux.title', { device: selectedPartition.device }),
        tCurrent('diskManager.confirm.deletePartitionLinux.detail', { device: selectedPartition.device }),
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
        tCurrent('diskManager.confirm.pvCreate.title', { device: selectedPartition.device }),
        tCurrent('diskManager.confirm.pvCreate.detail', { device: selectedPartition.device }),
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
        tCurrent('diskManager.confirm.vgCreate.title', { name: lvmVgName }),
        tCurrent('diskManager.confirm.vgCreate.detail', { devices: lvmPvDevices }),
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
        tCurrent('diskManager.confirm.lvCreate.title', { name: lvmLvName }),
        tCurrent('diskManager.confirm.lvCreate.detail', { vg: lvmVgName, size: lvmLvSize }),
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
        tCurrent('diskManager.confirm.lvExtend.title', { path: lvmLvPath }),
        tCurrent('diskManager.confirm.lvExtend.detail', { path: lvmLvPath, size: lvmLvSize }),
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
        tCurrent('diskManager.confirm.lvRemove.title', { path: lvmLvPath }),
        tCurrent('diskManager.confirm.lvRemove.detail', { path: lvmLvPath }),
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
      const result = await runCommand(pendingAction.command);
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || tCurrent('diskManager.error.commandFailed'));
      }

      setNotice(result.stdout.trim() || result.stderr.trim() || tCurrent('diskManager.notice.operationExecuted'));
      setPendingAction(null);
      await refreshSnapshot();
    } catch (error) {
      if (isSudoPrivilegeFailure(error)) {
        setPendingAction(null);
      }
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const copyPendingCommand = async () => {
    if (!pendingAction) return;
    await navigator.clipboard.writeText(getCommandPreview(pendingAction.command));
    setNotice(tCurrent('diskManager.notice.commandCopied'));
  };

  const copySelectedInfo = async () => {
    const lines = [
      tCurrent('diskManager.copy.selection', { value: selectedTitle }),
      selectedDisk ? tCurrent('diskManager.copy.disk', { path: selectedDisk.path, size: selectedDisk.sizeText, model: selectedDisk.model }) : '',
      selectedPartition ? tCurrent('diskManager.copy.partition', { device: selectedPartition.device, size: selectedPartition.sizeText, fs: selectedPartition.fsType, mounts: formatMountTargets(selectedPartition) }) : '',
      selectedMount ? tCurrent('diskManager.copy.mount', { source: selectedMount.source, target: selectedMount.target, used: selectedMount.usedText, size: selectedMount.sizeText }) : '',
      selectedLogicalVolume ? `LV: ${selectedLogicalVolume.path} ${selectedLogicalVolume.sizeText}` : '',
    ].filter(Boolean).join('\n');

    await navigator.clipboard.writeText(lines);
    setNotice(tCurrent('diskManager.notice.selectionCopied'));
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
          <strong>{isWindowsHost ? tCurrent('diskManager.ui.windowsTitle') : tCurrent('diskManager.ui.linuxTitle')}</strong>
          <em>{lastRefreshedAt ? tCurrent('diskManager.status.refreshedAt', { time: lastRefreshedAt }) : tCurrent('diskManager.status.waiting')}</em>
        </div>
        <div className="disk-manager-metrics">
          <span><strong>{diskStats.diskCount}</strong> {tCurrent('diskManager.metric.disks')}</span>
          <span><strong>{diskStats.partitionCount}</strong> {tCurrent('diskManager.metric.partitions')}</span>
          <span><strong>{diskStats.mountedCount}</strong> {tCurrent('diskManager.metric.mounted')}</span>
          <span><strong>{diskStats.diskText}</strong> {tCurrent('diskManager.metric.totalCapacity')}</span>
        </div>
        <button type="button" className="primary" onClick={refreshSnapshot} disabled={loading}>
          {loading ? tCurrent('diskManager.ui.loading') : tCurrent('diskManager.ui.refresh')}
        </button>
      </header>

      {error ? <DismissibleAlert className="disk-manager-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="disk-manager-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="disk-manager-layout">
        <aside className="disk-manager-sidebar">
          <div className="disk-manager-panel-heading">
            <span>{tCurrent('diskManager.ui.deviceTree')}</span>
            <strong>{tCurrent('diskManager.ui.physicalDisks')}</strong>
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
                    {!partitions.length ? <div className="disk-manager-empty-branch">{tCurrent('diskManager.empty.noPartitions')}</div> : null}
                  </div>
                </div>
              );
            })}
            {!loading && !snapshot?.disks.length ? <div className="disk-manager-empty">{tCurrent('diskManager.empty.noDisks')}</div> : null}
          </div>
        </aside>

        <main className="disk-manager-main">
          <div className="disk-manager-tabs">
            <button type="button" className={activeTab === 'topology' ? 'active' : ''} onClick={() => setActiveTab('topology')}>{tCurrent('diskManager.tab.topology')}</button>
            <button type="button" className={activeTab === 'mounts' ? 'active' : ''} onClick={() => setActiveTab('mounts')}>{tCurrent('diskManager.tab.mounts')}</button>
            <button type="button" className={activeTab === 'lvm' ? 'active' : ''} onClick={() => setActiveTab('lvm')}>LVM</button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>{tCurrent('diskManager.tab.raw')}</button>
          </div>

          {activeTab === 'topology' ? (
            <div className="disk-manager-table-wrap">
              <table className="disk-manager-table">
                <thead>
                  <tr>
                    <th>{tCurrent('diskManager.field.device')}</th>
                    <th>{tCurrent('diskManager.field.type')}</th>
                    <th>{tCurrent('diskManager.field.capacity')}</th>
                    <th>{tCurrent('diskManager.field.fileSystem')}</th>
                    <th>{tCurrent('diskManager.field.mountOrLetter')}</th>
                    <th>{tCurrent('diskManager.field.status')}</th>
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
                          <td>{tCurrent('diskManager.table.physicalDisk')}</td>
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
                              <td><span className={`disk-manager-status-pill ${partition.isMounted ? 'ready' : 'idle'}`}>{partition.isMounted ? tCurrent('diskManager.status.mounted') : tCurrent('diskManager.status.unmounted')}</span></td>
                            </tr>
                          );
                        })}
                        {!partitions.length ? (
                          <tr className={`disk-manager-partition-row empty ${isDiskGroupActive ? 'group-active' : ''}`} onClick={() => setSelection({ kind: 'disk', id: disk.id })}>
                            <td colSpan={6}>
                              <span className="disk-manager-device-cell child empty">
                                <span className="disk-manager-tree-branch" aria-hidden="true" />
                                <span>{tCurrent('diskManager.empty.noPartitions')}</span>
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
              {!snapshot?.mounts.length ? <div className="disk-manager-empty">{tCurrent('diskManager.empty.noMounts')}</div> : null}
            </div>
          ) : null}

          {activeTab === 'lvm' ? (
            <div className="disk-manager-lvm">
              {isWindowsHost ? (
                <div className="disk-manager-empty">{tCurrent('diskManager.empty.windowsNoLvm')}</div>
              ) : (
                <>
                  <section>
                    <div className="disk-manager-section-heading">
                      <span>Physical Volumes</span>
                      <strong>{tCurrent('diskManager.lvm.pvCount', { count: snapshot?.lvm.physicalVolumes.length ?? 0 })}</strong>
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
                      <strong>{tCurrent('diskManager.lvm.vgCount', { count: snapshot?.lvm.volumeGroups.length ?? 0 })}</strong>
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
                      <strong>{tCurrent('diskManager.lvm.lvCount', { count: snapshot?.lvm.logicalVolumes.length ?? 0 })}</strong>
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
            <pre className="disk-manager-raw">{snapshot?.rawOutput || tCurrent('diskManager.empty.noOutput')}</pre>
          ) : null}
        </main>

        <aside className="disk-manager-action-panel">
          <div className="disk-manager-panel-heading">
            <span>{tCurrent('diskManager.ui.console')}</span>
            <strong title={selectedTitle}>{selectedTitle}</strong>
          </div>

          <div className="disk-manager-detail-card">
            {selectedDisk ? <DiskInfoList disk={selectedDisk} /> : null}
            {selectedPartition ? <PartitionInfoList partition={selectedPartition} /> : null}
            {selectedMount ? <MountInfoList mount={selectedMount} /> : null}
            {selectedLogicalVolume ? (
              <dl className="disk-manager-facts">
                <div><dt>{tCurrent('diskManager.field.path')}</dt><dd>{selectedLogicalVolume.path}</dd></div>
                <div><dt>VG</dt><dd>{selectedLogicalVolume.vgName}</dd></div>
                <div><dt>{tCurrent('diskManager.field.capacity')}</dt><dd>{selectedLogicalVolume.sizeText}</dd></div>
                <div><dt>{tCurrent('diskManager.field.attributes')}</dt><dd>{selectedLogicalVolume.attr || '-'}</dd></div>
              </dl>
            ) : null}
            {!selectedDisk && !selectedPartition && !selectedMount && !selectedLogicalVolume ? <div className="disk-manager-empty detail">{tCurrent('diskManager.empty.selectDiskOrPartition')}</div> : null}
            <div className="disk-manager-inline-actions">
              <button type="button" onClick={copySelectedInfo} disabled={!selection}>{tCurrent('diskManager.action.copyInfo')}</button>
              <button type="button" onClick={openSelectedMount} disabled={!onOpenFileManager || (!selectedMount && !selectedPartition?.mountPoints.length)}>{tCurrent('diskManager.action.openDirectory')}</button>
            </div>
          </div>

          {selectedDisk ? (
            <div className="disk-manager-action-card">
              <strong>{tCurrent('diskManager.action.createPartition')}</strong>
              {isWindowsHost ? (
                <>
                  <label><span>{tCurrent('diskManager.field.capacityGb')}</span><input value={windowsPartitionSizeGb} onChange={(event) => setWindowsPartitionSizeGb(event.target.value)} placeholder={tCurrent('diskManager.placeholder.remainingSpace')} /></label>
                  <label className="disk-manager-check"><input type="checkbox" checked={windowsAssignDriveLetter} onChange={(event) => setWindowsAssignDriveLetter(event.target.checked)} />{tCurrent('diskManager.field.autoAssignDriveLetter')}</label>
                </>
              ) : (
                <>
                  <label><span>{tCurrent('diskManager.field.fileSystemHint')}</span><input value={partitionFsHint} onChange={(event) => setPartitionFsHint(event.target.value)} /></label>
                  <div className="disk-manager-two-col">
                    <label><span>{tCurrent('diskManager.field.start')}</span><input value={partitionStart} onChange={(event) => setPartitionStart(event.target.value)} /></label>
                    <label><span>{tCurrent('diskManager.field.end')}</span><input value={partitionEnd} onChange={(event) => setPartitionEnd(event.target.value)} /></label>
                  </div>
                </>
              )}
              <button type="button" className="danger" onClick={prepareCreatePartition}>{tCurrent('diskManager.action.previewCreatePartition')}</button>
            </div>
          ) : null}

          {selectedPartition ? (
            <>
              <div className="disk-manager-action-card">
                <strong>{tCurrent('diskManager.action.mountSection')}</strong>
                {isWindowsHost ? (
                  <label><span>{tCurrent('diskManager.field.driveLetter')}</span><input value={driveLetter} onChange={(event) => setDriveLetter(event.target.value)} /></label>
                ) : (
                  <label><span>{tCurrent('diskManager.field.mountDirectory')}</span><input value={mountPoint} onChange={(event) => setMountPoint(event.target.value)} /></label>
                )}
                <div className="disk-manager-two-buttons">
                  <button type="button" className="primary" onClick={prepareMount}>{tCurrent('diskManager.action.previewMount')}</button>
                  <button type="button" className="danger" onClick={prepareUnmount} disabled={!selectedPartition.isMounted}>{tCurrent('diskManager.action.previewUnmount')}</button>
                </div>
              </div>

              <div className="disk-manager-action-card">
                <strong>{tCurrent('diskManager.action.format')}</strong>
                <div className="disk-manager-two-col">
                  <label>
                    <span>{tCurrent('diskManager.field.fileSystem')}</span>
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
                  <label><span>{tCurrent('diskManager.field.volumeLabel')}</span><input value={formatLabel} onChange={(event) => setFormatLabel(event.target.value)} /></label>
                </div>
                <button type="button" className="danger" onClick={prepareFormat}>{tCurrent('diskManager.action.previewFormat')}</button>
              </div>

              <div className="disk-manager-action-card">
                <strong>{tCurrent('diskManager.action.partitionMaintenance')}</strong>
                <button type="button" className="danger" onClick={prepareDeletePartition}>{tCurrent('diskManager.action.previewDeletePartition')}</button>
                {!isWindowsHost ? <button type="button" onClick={preparePvCreate}>{tCurrent('diskManager.action.initLvmPv')}</button> : null}
              </div>
            </>
          ) : null}

          {selectedMount && !selectedPartition ? (
            <div className="disk-manager-action-card">
              <strong>{tCurrent('diskManager.action.mountMaintenance')}</strong>
              <button type="button" className="danger" onClick={prepareUnmount}>{tCurrent('diskManager.action.previewUnmount')}</button>
            </div>
          ) : null}

          {!isWindowsHost ? (
            <div className="disk-manager-action-card">
              <strong>{tCurrent('diskManager.action.lvmConfig')}</strong>
              <label><span>{tCurrent('diskManager.field.pvDevices')}</span><input value={lvmPvDevices} onChange={(event) => setLvmPvDevices(event.target.value)} placeholder="/dev/sdb1 /dev/sdc1" /></label>
              <div className="disk-manager-two-col">
                <label><span>VG</span><input value={lvmVgName} onChange={(event) => setLvmVgName(event.target.value)} /></label>
                <label><span>LV</span><input value={lvmLvName} onChange={(event) => setLvmLvName(event.target.value)} /></label>
              </div>
              <div className="disk-manager-two-col">
                <label><span>{tCurrent('diskManager.field.capacity')}</span><input value={lvmLvSize} onChange={(event) => setLvmLvSize(event.target.value)} /></label>
                <label><span>{tCurrent('diskManager.field.lvPath')}</span><input value={lvmLvPath} onChange={(event) => setLvmLvPath(event.target.value)} /></label>
              </div>
              <div className="disk-manager-grid-buttons">
                <button type="button" onClick={prepareVgCreate}>{tCurrent('diskManager.action.createVg')}</button>
                <button type="button" onClick={prepareLvCreate}>{tCurrent('diskManager.action.createLv')}</button>
                <button type="button" onClick={prepareLvExtend}>{tCurrent('diskManager.action.extendLv')}</button>
                <button type="button" className="danger" onClick={prepareLvRemove}>{tCurrent('diskManager.action.deleteLv')}</button>
              </div>
            </div>
          ) : null}
        </aside>
      </div>

      {pendingAction ? createPortal(
        <div className="disk-manager-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !actionRunning) setPendingAction(null); }}>
          <section className="disk-manager-confirm" role="dialog" aria-modal="true" aria-label={pendingAction.title}>
            <div className="disk-manager-confirm-header">
              <span>{pendingAction.danger ? tCurrent('diskManager.confirm.highRisk') : tCurrent('diskManager.confirm.execute')}</span>
              <strong>{pendingAction.title}</strong>
            </div>
            <p>{pendingAction.detail}</p>
            <pre>{getCommandPreview(pendingAction.command)}</pre>
            <div className="disk-manager-confirm-actions">
              <button type="button" onClick={copyPendingCommand}>{tCurrent('diskManager.action.copyCommand')}</button>
              <button type="button" onClick={() => setPendingAction(null)} disabled={actionRunning}>{tCurrent('diskManager.action.cancel')}</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? tCurrent('diskManager.action.running') : tCurrent('diskManager.action.execute')}
              </button>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
      {sudoPrompt}
    </section>
  );
}

export default RemoteDiskManager;
