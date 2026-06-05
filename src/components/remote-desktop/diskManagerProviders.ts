import { powershellCommand, powershellSingleQuote, type RemoteCommandInput } from './remoteSystem';

export type DiskManagerPlatform = 'linux' | 'windows';

export interface ManagedDisk {
  id: string;
  name: string;
  path: string;
  model: string;
  serial: string;
  sizeBytes: number;
  sizeText: string;
  type: 'disk';
  transport: string;
  state: string;
  partitionStyle: string;
  rotational?: boolean;
  removable?: boolean;
  readOnly?: boolean;
  health?: string;
  partitionIds: string[];
}

export interface ManagedPartition {
  id: string;
  diskId: string;
  name: string;
  path: string;
  device: string;
  type: string;
  partType: string;
  fsType: string;
  label: string;
  uuid: string;
  sizeBytes: number;
  sizeText: string;
  mountPoints: string[];
  isMounted: boolean;
  driveLetter: string;
  accessPaths: string[];
  readOnly?: boolean;
  boot?: boolean;
  system?: boolean;
  active?: boolean;
}

export interface ManagedMount {
  id: string;
  source: string;
  target: string;
  fsType: string;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  sizeText: string;
  usedText: string;
  availableText: string;
  usePercent: number;
  options: string;
}

export interface LvmPhysicalVolume {
  id: string;
  name: string;
  vgName: string;
  sizeBytes: number;
  freeBytes: number;
  sizeText: string;
  freeText: string;
  attr: string;
}

export interface LvmVolumeGroup {
  id: string;
  name: string;
  pvCount: number;
  lvCount: number;
  sizeBytes: number;
  freeBytes: number;
  sizeText: string;
  freeText: string;
  attr: string;
}

export interface LvmLogicalVolume {
  id: string;
  name: string;
  vgName: string;
  path: string;
  sizeBytes: number;
  sizeText: string;
  attr: string;
}

export interface LvmSnapshot {
  available: boolean;
  physicalVolumes: LvmPhysicalVolume[];
  volumeGroups: LvmVolumeGroup[];
  logicalVolumes: LvmLogicalVolume[];
}

export interface DiskManagerSnapshot {
  platform: DiskManagerPlatform;
  disks: ManagedDisk[];
  partitions: ManagedPartition[];
  mounts: ManagedMount[];
  lvm: LvmSnapshot;
  rawOutput: string;
  notice?: string;
}

export type LinuxFormatFileSystem = 'ext4' | 'xfs' | 'btrfs' | 'vfat' | 'swap';
export type WindowsFormatFileSystem = 'NTFS' | 'ReFS' | 'exFAT' | 'FAT32';

const lsblkMarker = '__SHELLDESK_DISK_LSBLK__';
const findmntMarker = '__SHELLDESK_DISK_FINDMNT__';
const pvsMarker = '__SHELLDESK_DISK_LVM_PVS__';
const vgsMarker = '__SHELLDESK_DISK_LVM_VGS__';
const lvsMarker = '__SHELLDESK_DISK_LVM_LVS__';
const diskManagerSectionMarkers = [
  lsblkMarker,
  findmntMarker,
  pvsMarker,
  vgsMarker,
  lvsMarker,
];

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function withLinuxPrivilege(command: string) {
  return `if [ "$(id -u 2>/dev/null)" = "0" ]; then
${command}
else
sudo -n sh -c ${shellSingleQuote(command)}
fi`;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }

  return '';
}

function readBoolean(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalizedValue = value.trim().toLowerCase();
      if (['true', 'yes', '1'].includes(normalizedValue)) return true;
      if (['false', 'no', '0'].includes(normalizedValue)) return false;
    }
  }

  return false;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const parsedValue = parseNumericValue(record[key]);

    if (Number.isFinite(parsedValue)) {
      return parsedValue;
    }
  }

  return 0;
}

function parseNumericValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return Number.NaN;
  }

  const normalizedValue = value
    .trim()
    .replace(/[<>,]/g, '')
    .replace(/\s*B$/i, '');
  const parsedValue = Number.parseFloat(normalizedValue);

  return Number.isFinite(parsedValue) ? parsedValue : Number.NaN;
}

export function formatDiskBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision).replace(/\.0+$/, '')} ${units[unitIndex]}`;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmedText = text.trim();

  if (!trimmedText) {
    return {};
  }

  const parsedValue = JSON.parse(trimmedText) as unknown;
  return toRecord(parsedValue) ?? {};
}

function collectMarkedSections(stdout: string) {
  const sections = new Map<string, string>();
  let currentMarker = '';
  let normalizedStdout = stdout;

  for (const marker of diskManagerSectionMarkers) {
    normalizedStdout = normalizedStdout.split(marker).join(`\n${marker}\n`);
  }

  for (const line of normalizedStdout.split(/\r?\n/)) {
    const marker = diskManagerSectionMarkers.find((item) => line.trim() === item);

    if (marker) {
      currentMarker = marker;
      sections.set(currentMarker, '');
      continue;
    }

    if (!currentMarker) {
      continue;
    }

    sections.set(currentMarker, `${sections.get(currentMarker) ?? ''}${line}\n`);
  }

  return sections;
}

function parseUsePercent(value: string) {
  const parsedValue = Number.parseFloat(value.replace('%', ''));
  return Number.isFinite(parsedValue) ? Math.min(Math.max(parsedValue, 0), 100) : 0;
}

function parseMountPointArray(record: Record<string, unknown>) {
  const mountPoints = asArray(record.mountpoints ?? record.MountPoints)
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  const mountPoint = readString(record, 'mountpoint', 'MOUNTPOINT');

  return Array.from(new Set([...mountPoints, mountPoint].filter(Boolean)));
}

function parseLinuxMounts(findmntText: string): ManagedMount[] {
  const root = parseJsonObject(findmntText);
  const filesystems = asArray(root.filesystems);
  const mounts: ManagedMount[] = [];

  const visit = (value: unknown) => {
    const record = toRecord(value);
    if (!record) return;

    const source = readString(record, 'source', 'SOURCE');
    const target = readString(record, 'target', 'TARGET');
    const sizeBytes = readNumber(record, 'size', 'SIZE');
    const usedBytes = readNumber(record, 'used', 'USED');
    const availableBytes = readNumber(record, 'avail', 'AVAIL');

    if (source || target) {
      mounts.push({
        id: `${source}:${target}`,
        source,
        target,
        fsType: readString(record, 'fstype', 'FSTYPE') || '-',
        sizeBytes,
        usedBytes,
        availableBytes,
        sizeText: formatDiskBytes(sizeBytes),
        usedText: formatDiskBytes(usedBytes),
        availableText: formatDiskBytes(availableBytes),
        usePercent: parseUsePercent(readString(record, 'use%', 'USE%')),
        options: readString(record, 'options', 'OPTIONS'),
      });
    }

    asArray(record.children).forEach(visit);
  };

  filesystems.forEach(visit);
  return mounts;
}

function parseLinuxBlockDevices(lsblkText: string, mounts: ManagedMount[]) {
  const root = parseJsonObject(lsblkText);
  const disks = new Map<string, ManagedDisk>();
  const partitions = new Map<string, ManagedPartition>();

  const visit = (value: unknown, parentDiskId = '') => {
    const record = toRecord(value);
    if (!record) return;

    const name = readString(record, 'name', 'NAME');
    const path = readString(record, 'path', 'PATH') || (name ? `/dev/${name}` : '');
    const type = readString(record, 'type', 'TYPE') || 'unknown';
    const id = path || name;

    if (!id) {
      return;
    }

    if (type === 'disk') {
      const disk: ManagedDisk = {
        id,
        name: name || path,
        path,
        model: readString(record, 'model', 'MODEL') || '-',
        serial: readString(record, 'serial', 'SERIAL') || '-',
        sizeBytes: readNumber(record, 'size', 'SIZE'),
        sizeText: formatDiskBytes(readNumber(record, 'size', 'SIZE')),
        type: 'disk',
        transport: readString(record, 'tran', 'TRAN') || '-',
        state: readString(record, 'state', 'STATE') || '-',
        partitionStyle: '-',
        rotational: readBoolean(record, 'rota', 'ROTA'),
        removable: readBoolean(record, 'rm', 'RM'),
        readOnly: readBoolean(record, 'ro', 'RO'),
        partitionIds: [],
      };
      disks.set(id, disk);
      asArray(record.children).forEach((child) => visit(child, id));
      return;
    }

    const mountPoints = parseMountPointArray(record);
    const matchedMounts = mounts.filter((mount) => mount.source === path || mount.source === name || mount.source.endsWith(`/${name}`));
    const allMountPoints = Array.from(new Set([
      ...mountPoints,
      ...matchedMounts.map((mount) => mount.target),
    ].filter(Boolean)));
    const partition: ManagedPartition = {
      id,
      diskId: parentDiskId,
      name: name || path,
      path,
      device: path,
      type,
      partType: readString(record, 'parttype', 'PARTTYPE'),
      fsType: readString(record, 'fstype', 'FSTYPE') || '-',
      label: readString(record, 'label', 'LABEL'),
      uuid: readString(record, 'uuid', 'UUID'),
      sizeBytes: readNumber(record, 'size', 'SIZE'),
      sizeText: formatDiskBytes(readNumber(record, 'size', 'SIZE')),
      mountPoints: allMountPoints,
      isMounted: allMountPoints.length > 0,
      driveLetter: '',
      accessPaths: allMountPoints,
      readOnly: readBoolean(record, 'ro', 'RO'),
    };

    partitions.set(id, partition);

    const parentDisk = disks.get(parentDiskId);
    if (parentDisk && !parentDisk.partitionIds.includes(id)) {
      parentDisk.partitionIds.push(id);
    }

    asArray(record.children).forEach((child) => visit(child, parentDiskId));
  };

  asArray(root.blockdevices).forEach((device) => visit(device));

  return {
    disks: Array.from(disks.values()),
    partitions: Array.from(partitions.values()),
  };
}

function parseLvmReportArray(text: string, key: string) {
  const root = parseJsonObject(text);
  const reports = asArray(root.report);
  return reports.flatMap((item) => {
    const report = toRecord(item);
    return report ? asArray(report[key]).map(toRecord).filter((record): record is Record<string, unknown> => Boolean(record)) : [];
  });
}

function parseLinuxLvm(pvsText: string, vgsText: string, lvsText: string): LvmSnapshot {
  const physicalVolumes = parseLvmReportArray(pvsText, 'pv').map((record) => {
    const sizeBytes = readNumber(record, 'pv_size');
    const freeBytes = readNumber(record, 'pv_free');
    const name = readString(record, 'pv_name');

    return {
      id: name,
      name,
      vgName: readString(record, 'vg_name') || '-',
      sizeBytes,
      freeBytes,
      sizeText: formatDiskBytes(sizeBytes),
      freeText: formatDiskBytes(freeBytes),
      attr: readString(record, 'pv_attr'),
    } satisfies LvmPhysicalVolume;
  });
  const volumeGroups = parseLvmReportArray(vgsText, 'vg').map((record) => {
    const sizeBytes = readNumber(record, 'vg_size');
    const freeBytes = readNumber(record, 'vg_free');
    const name = readString(record, 'vg_name');

    return {
      id: name,
      name,
      pvCount: readNumber(record, 'pv_count'),
      lvCount: readNumber(record, 'lv_count'),
      sizeBytes,
      freeBytes,
      sizeText: formatDiskBytes(sizeBytes),
      freeText: formatDiskBytes(freeBytes),
      attr: readString(record, 'vg_attr'),
    } satisfies LvmVolumeGroup;
  });
  const logicalVolumes = parseLvmReportArray(lvsText, 'lv').map((record) => {
    const sizeBytes = readNumber(record, 'lv_size');
    const lvName = readString(record, 'lv_name');
    const vgName = readString(record, 'vg_name');
    const path = readString(record, 'lv_path') || (vgName && lvName ? `/dev/${vgName}/${lvName}` : lvName);

    return {
      id: path,
      name: lvName,
      vgName,
      path,
      sizeBytes,
      sizeText: formatDiskBytes(sizeBytes),
      attr: readString(record, 'lv_attr'),
    } satisfies LvmLogicalVolume;
  });

  return {
    available: physicalVolumes.length > 0 || volumeGroups.length > 0 || logicalVolumes.length > 0,
    physicalVolumes,
    volumeGroups,
    logicalVolumes,
  };
}

export function parseLinuxDiskManagerSnapshot(stdout: string, stderr = ''): DiskManagerSnapshot {
  const sections = collectMarkedSections(stdout);
  const mounts = parseLinuxMounts(sections.get(findmntMarker) ?? '');
  const { disks, partitions } = parseLinuxBlockDevices(sections.get(lsblkMarker) ?? '', mounts);
  const lvm = parseLinuxLvm(
    sections.get(pvsMarker) ?? '',
    sections.get(vgsMarker) ?? '',
    sections.get(lvsMarker) ?? '',
  );

  return {
    platform: 'linux',
    disks,
    partitions,
    mounts,
    lvm,
    rawOutput: stdout,
    notice: stderr.trim(),
  };
}

function createEmptyLvmSnapshot(): LvmSnapshot {
  return {
    available: false,
    physicalVolumes: [],
    volumeGroups: [],
    logicalVolumes: [],
  };
}

export function parseWindowsDiskManagerSnapshot(stdout: string, stderr = ''): DiskManagerSnapshot {
  const root = parseJsonObject(stdout);
  const volumeRecords = asArray(root.Volumes).map(toRecord).filter((record): record is Record<string, unknown> => Boolean(record));
  const volumeByDriveLetter = new Map<string, Record<string, unknown>>();

  volumeRecords.forEach((volume) => {
    const driveLetter = readString(volume, 'DriveLetter');
    if (driveLetter) {
      volumeByDriveLetter.set(driveLetter.toUpperCase(), volume);
    }
  });

  const disks: ManagedDisk[] = asArray(root.Disks)
    .map(toRecord)
    .filter((record): record is Record<string, unknown> => Boolean(record))
    .map((record) => {
      const number = readString(record, 'Number');
      const sizeBytes = readNumber(record, 'Size');

      return {
        id: `disk:${number}`,
        name: `Disk ${number}`,
        path: number,
        model: readString(record, 'FriendlyName') || '-',
        serial: readString(record, 'SerialNumber') || '-',
        sizeBytes,
        sizeText: formatDiskBytes(sizeBytes),
        type: 'disk' as const,
        transport: readString(record, 'BusType') || '-',
        state: readString(record, 'OperationalStatus') || '-',
        partitionStyle: readString(record, 'PartitionStyle') || '-',
        readOnly: readBoolean(record, 'IsReadOnly'),
        health: readString(record, 'HealthStatus') || '-',
        partitionIds: [],
      };
    });
  const diskById = new Map(disks.map((disk) => [disk.id, disk]));
  const mounts: ManagedMount[] = [];
  const partitions = asArray(root.Partitions)
    .map(toRecord)
    .filter((record): record is Record<string, unknown> => Boolean(record))
    .map((record) => {
      const diskNumber = readString(record, 'DiskNumber');
      const partitionNumber = readString(record, 'PartitionNumber');
      const driveLetter = readString(record, 'DriveLetter').toUpperCase();
      const accessPaths = asArray(record.AccessPaths).map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
      const volume = driveLetter ? volumeByDriveLetter.get(driveLetter) : undefined;
      const sizeBytes = readNumber(record, 'Size');
      const diskId = `disk:${diskNumber}`;
      const id = `${diskId}:partition:${partitionNumber}`;
      const mountPoints = Array.from(new Set([
        driveLetter ? `${driveLetter}:\\` : '',
        ...accessPaths,
      ].filter(Boolean)));

      if (volume) {
        const volumeSizeBytes = readNumber(volume, 'Size');
        const availableBytes = readNumber(volume, 'SizeRemaining');
        const usedBytes = Math.max(0, volumeSizeBytes - availableBytes);
        mounts.push({
          id: `${driveLetter}:\\`,
          source: `${driveLetter}:\\`,
          target: `${driveLetter}:\\`,
          fsType: readString(volume, 'FileSystem') || '-',
          sizeBytes: volumeSizeBytes,
          usedBytes,
          availableBytes,
          sizeText: formatDiskBytes(volumeSizeBytes),
          usedText: formatDiskBytes(usedBytes),
          availableText: formatDiskBytes(availableBytes),
          usePercent: volumeSizeBytes > 0 ? Math.round((usedBytes / volumeSizeBytes) * 1000) / 10 : 0,
          options: readString(volume, 'HealthStatus', 'OperationalStatus'),
        });
      }

      const partition: ManagedPartition = {
        id,
        diskId,
        name: `Partition ${partitionNumber}`,
        path: `${diskNumber}:${partitionNumber}`,
        device: `${diskNumber}:${partitionNumber}`,
        type: readString(record, 'Type') || 'partition',
        partType: readString(record, 'GptType'),
        fsType: volume ? readString(volume, 'FileSystem') || '-' : '-',
        label: volume ? readString(volume, 'FileSystemLabel') : '',
        uuid: readString(record, 'Guid'),
        sizeBytes,
        sizeText: formatDiskBytes(sizeBytes),
        mountPoints,
        isMounted: mountPoints.length > 0,
        driveLetter,
        accessPaths,
        readOnly: readBoolean(record, 'IsReadOnly'),
        boot: readBoolean(record, 'IsBoot'),
        system: readBoolean(record, 'IsSystem'),
        active: readBoolean(record, 'IsActive'),
      };
      const disk = diskById.get(diskId);
      if (disk && !disk.partitionIds.includes(id)) {
        disk.partitionIds.push(id);
      }

      return partition;
    });

  return {
    platform: 'windows',
    disks,
    partitions,
    mounts,
    lvm: createEmptyLvmSnapshot(),
    rawOutput: stdout,
    notice: stderr.trim(),
  };
}

export function createDiskManagerSnapshotCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return {
      command: powershellCommand(`
$disks = @(Get-Disk -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    Number = $_.Number
    FriendlyName = $_.FriendlyName
    SerialNumber = $_.SerialNumber
    BusType = $_.BusType.ToString()
    PartitionStyle = $_.PartitionStyle.ToString()
    OperationalStatus = ($_.OperationalStatus -join ',')
    HealthStatus = $_.HealthStatus.ToString()
    IsBoot = $_.IsBoot
    IsSystem = $_.IsSystem
    IsOffline = $_.IsOffline
    IsReadOnly = $_.IsReadOnly
    Size = [int64]$_.Size
  }
})
$partitions = @(Get-Partition -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    DiskNumber = $_.DiskNumber
    PartitionNumber = $_.PartitionNumber
    DriveLetter = [string]$_.DriveLetter
    Guid = [string]$_.Guid
    GptType = [string]$_.GptType
    Type = [string]$_.Type
    Size = [int64]$_.Size
    Offset = [int64]$_.Offset
    IsActive = $_.IsActive
    IsBoot = $_.IsBoot
    IsSystem = $_.IsSystem
    IsReadOnly = $_.IsReadOnly
    NoDefaultDriveLetter = $_.NoDefaultDriveLetter
    AccessPaths = @($_.AccessPaths)
  }
})
$volumes = @(Get-Volume -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{
    DriveLetter = [string]$_.DriveLetter
    FileSystemLabel = $_.FileSystemLabel
    FileSystem = $_.FileSystem
    HealthStatus = $_.HealthStatus.ToString()
    OperationalStatus = ($_.OperationalStatus -join ',')
    Size = if ($null -eq $_.Size) { 0 } else { [int64]$_.Size }
    SizeRemaining = if ($null -eq $_.SizeRemaining) { 0 } else { [int64]$_.SizeRemaining }
    Path = $_.Path
    UniqueId = $_.UniqueId
  }
})
[PSCustomObject]@{
  Disks = $disks
  Partitions = $partitions
  Volumes = $volumes
} | ConvertTo-Json -Depth 8 -Compress
`),
    };
  }

  return {
    command: [
      `printf '%s\\n' ${shellSingleQuote(lsblkMarker)}`,
      "lsblk -J -b -o NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINT,LABEL,UUID,MODEL,SERIAL,ROTA,RM,RO,TRAN,STATE,PARTTYPE 2>/dev/null || printf '%s\\n' '{\"blockdevices\":[]}'",
      `printf '%s\\n' ${shellSingleQuote(findmntMarker)}`,
      "findmnt -J -b -o TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%,OPTIONS 2>/dev/null || printf '%s\\n' '{\"filesystems\":[]}'",
      `printf '%s\\n' ${shellSingleQuote(pvsMarker)}`,
      "if command -v pvs >/dev/null 2>&1; then pvs --reportformat json --units b --nosuffix -o pv_name,vg_name,pv_size,pv_free,pv_attr 2>/dev/null || printf '%s\\n' '{\"report\":[{\"pv\":[]}]}'; else printf '%s\\n' '{\"report\":[{\"pv\":[]}]}'; fi",
      `printf '%s\\n' ${shellSingleQuote(vgsMarker)}`,
      "if command -v vgs >/dev/null 2>&1; then vgs --reportformat json --units b --nosuffix -o vg_name,pv_count,lv_count,vg_size,vg_free,vg_attr 2>/dev/null || printf '%s\\n' '{\"report\":[{\"vg\":[]}]}'; else printf '%s\\n' '{\"report\":[{\"vg\":[]}]}'; fi",
      `printf '%s\\n' ${shellSingleQuote(lvsMarker)}`,
      "if command -v lvs >/dev/null 2>&1; then lvs --reportformat json --units b --nosuffix -o lv_name,vg_name,lv_path,lv_size,lv_attr 2>/dev/null || printf '%s\\n' '{\"report\":[{\"lv\":[]}]}'; else printf '%s\\n' '{\"report\":[{\"lv\":[]}]}'; fi",
    ].join('; '),
  };
}

function ensureLinuxDevicePath(value: string) {
  const trimmedValue = value.trim();
  if (!/^\/dev\/[A-Za-z0-9_.+:/-]+$/.test(trimmedValue)) {
    throw new Error('设备路径必须是 /dev 下的绝对路径');
  }
  return trimmedValue;
}

function ensureLinuxMountPath(value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue.startsWith('/') || /[\r\n]/.test(trimmedValue)) {
    throw new Error('挂载目录必须是 Linux 绝对路径');
  }
  return trimmedValue;
}

function ensureSafeLvmName(value: string, label: string) {
  const trimmedValue = value.trim();
  if (!/^[A-Za-z0-9_.+-]{1,127}$/.test(trimmedValue)) {
    throw new Error(`${label} 只能包含字母、数字、点、下划线、加号和短横线`);
  }
  return trimmedValue;
}

function ensureLvmSize(value: string) {
  const trimmedValue = value.trim();
  if (!/^\+?\d+(?:\.\d+)?[KMGTPE]?$/i.test(trimmedValue)) {
    throw new Error('容量格式示例：10G、500M、+20G');
  }
  return trimmedValue.toUpperCase();
}

function ensureWindowsDiskNumber(value: string | number) {
  const normalizedValue = String(value).trim();
  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error('Windows 磁盘编号必须是数字');
  }
  return normalizedValue;
}

function ensureWindowsPartitionNumber(value: string | number) {
  const normalizedValue = String(value).trim();
  if (!/^\d+$/.test(normalizedValue)) {
    throw new Error('Windows 分区编号必须是数字');
  }
  return normalizedValue;
}

function ensureDriveLetter(value: string) {
  const trimmedValue = value.trim().replace(':', '').replace('\\', '').toUpperCase();
  if (!/^[A-Z]$/.test(trimmedValue)) {
    throw new Error('盘符必须是单个字母');
  }
  return trimmedValue;
}

function ensurePartitionRange(value: string, fallback: string) {
  const trimmedValue = value.trim() || fallback;
  if (!/^\d+(?:\.\d+)?(?:MiB|GiB|MB|GB|TB|%)$/i.test(trimmedValue)) {
    throw new Error('分区范围示例：1MiB、20GiB、100%');
  }
  return trimmedValue;
}

function ensureFileSystemLabel(value: string) {
  return value.trim().slice(0, 32);
}

function inferLinuxDiskAndPartitionNumber(devicePath: string) {
  const device = ensureLinuxDevicePath(devicePath);
  const match = device.match(/^(.*?)(?:p)?(\d+)$/);

  if (!match) {
    throw new Error('无法从设备路径识别分区编号');
  }

  return {
    diskPath: match[1],
    partitionNumber: match[2],
  };
}

export function createLinuxMountCommand(devicePath: string, mountPoint: string): RemoteCommandInput {
  const device = ensureLinuxDevicePath(devicePath);
  const target = ensureLinuxMountPath(mountPoint);

  return {
    command: withLinuxPrivilege(`mkdir -p ${shellSingleQuote(target)} && mount ${shellSingleQuote(device)} ${shellSingleQuote(target)}`),
  };
}

export function createLinuxUnmountCommand(targetPath: string): RemoteCommandInput {
  const target = targetPath.trim().startsWith('/dev/')
    ? ensureLinuxDevicePath(targetPath)
    : ensureLinuxMountPath(targetPath);

  return {
    command: withLinuxPrivilege(`umount ${shellSingleQuote(target)}`),
  };
}

export function createLinuxFormatCommand(devicePath: string, fsType: LinuxFormatFileSystem, label: string): RemoteCommandInput {
  const device = ensureLinuxDevicePath(devicePath);
  const safeLabel = ensureFileSystemLabel(label);
  const quotedDevice = shellSingleQuote(device);
  const labelByFs: Record<LinuxFormatFileSystem, string> = {
    ext4: safeLabel ? ` -L ${shellSingleQuote(safeLabel)}` : '',
    xfs: safeLabel ? ` -L ${shellSingleQuote(safeLabel)}` : '',
    btrfs: safeLabel ? ` -L ${shellSingleQuote(safeLabel)}` : '',
    vfat: safeLabel ? ` -n ${shellSingleQuote(safeLabel.slice(0, 11))}` : '',
    swap: safeLabel ? ` -L ${shellSingleQuote(safeLabel)}` : '',
  };
  const commandByFs: Record<LinuxFormatFileSystem, string> = {
    ext4: `mkfs.ext4 -F${labelByFs.ext4} ${quotedDevice}`,
    xfs: `mkfs.xfs -f${labelByFs.xfs} ${quotedDevice}`,
    btrfs: `mkfs.btrfs -f${labelByFs.btrfs} ${quotedDevice}`,
    vfat: `mkfs.vfat${labelByFs.vfat} ${quotedDevice}`,
    swap: `mkswap -f${labelByFs.swap} ${quotedDevice}`,
  };

  return {
    command: withLinuxPrivilege(commandByFs[fsType]),
  };
}

export function createLinuxCreatePartitionCommand(diskPath: string, fsHint: string, start: string, end: string): RemoteCommandInput {
  const disk = ensureLinuxDevicePath(diskPath);
  const safeFsHint = /^[A-Za-z0-9_-]{0,16}$/.test(fsHint.trim()) ? fsHint.trim() || 'ext4' : 'ext4';
  const startAt = ensurePartitionRange(start, '1MiB');
  const endAt = ensurePartitionRange(end, '100%');
  const quotedDisk = shellSingleQuote(disk);
  const command = [
    `label_error="$(LC_ALL=C parted -s ${quotedDisk} print 2>&1 >/dev/null)"`,
    'label_status=$?',
    'if [ "$label_status" -ne 0 ]; then',
    '  case "$label_error" in',
    `    *"unrecognised disk label"*|*"unrecognized disk label"*) LC_ALL=C parted -s ${quotedDisk} mklabel gpt ;;`,
    '    *) printf \'%s\\n\' "$label_error" >&2; exit "$label_status" ;;',
    '  esac',
    'fi',
    `LC_ALL=C parted -s ${quotedDisk} mkpart primary ${shellSingleQuote(safeFsHint)} ${shellSingleQuote(startAt)} ${shellSingleQuote(endAt)}`,
    `partprobe ${quotedDisk}`,
  ].join('\n');

  return {
    command: withLinuxPrivilege(command),
  };
}

export function createLinuxDeletePartitionCommand(devicePath: string): RemoteCommandInput {
  const { diskPath, partitionNumber } = inferLinuxDiskAndPartitionNumber(devicePath);

  return {
    command: withLinuxPrivilege(`parted -s ${shellSingleQuote(diskPath)} rm ${shellSingleQuote(partitionNumber)} && partprobe ${shellSingleQuote(diskPath)}`),
  };
}

export function createLinuxPvCreateCommand(devicePath: string): RemoteCommandInput {
  const device = ensureLinuxDevicePath(devicePath);

  return {
    command: withLinuxPrivilege(`pvcreate -y ${shellSingleQuote(device)}`),
  };
}

export function createLinuxVgCreateCommand(vgName: string, devicePaths: string): RemoteCommandInput {
  const name = ensureSafeLvmName(vgName, 'VG 名称');
  const devices = devicePaths
    .split(/[,\s]+/)
    .map((device) => device.trim())
    .filter(Boolean)
    .map(ensureLinuxDevicePath);

  if (!devices.length) {
    throw new Error('至少需要一个 PV 设备');
  }

  return {
    command: withLinuxPrivilege(`vgcreate ${shellSingleQuote(name)} ${devices.map(shellSingleQuote).join(' ')}`),
  };
}

export function createLinuxLvCreateCommand(vgName: string, lvName: string, size: string): RemoteCommandInput {
  const vg = ensureSafeLvmName(vgName, 'VG 名称');
  const lv = ensureSafeLvmName(lvName, 'LV 名称');
  const lvSize = ensureLvmSize(size);

  return {
    command: withLinuxPrivilege(`lvcreate -L ${shellSingleQuote(lvSize)} -n ${shellSingleQuote(lv)} ${shellSingleQuote(vg)}`),
  };
}

export function createLinuxLvExtendCommand(lvPath: string, size: string): RemoteCommandInput {
  const path = ensureLinuxDevicePath(lvPath);
  const increment = ensureLvmSize(size).replace(/^\+?/, '+');

  return {
    command: withLinuxPrivilege(`lvextend -r -L ${shellSingleQuote(increment)} ${shellSingleQuote(path)}`),
  };
}

export function createLinuxLvRemoveCommand(lvPath: string): RemoteCommandInput {
  const path = ensureLinuxDevicePath(lvPath);

  return {
    command: withLinuxPrivilege(`lvremove -y ${shellSingleQuote(path)}`),
  };
}

export function createWindowsMountCommand(diskNumber: string | number, partitionNumber: string | number, driveLetter: string): RemoteCommandInput {
  const disk = ensureWindowsDiskNumber(diskNumber);
  const partition = ensureWindowsPartitionNumber(partitionNumber);
  const letter = ensureDriveLetter(driveLetter);

  return {
    command: powershellCommand(`Add-PartitionAccessPath -DiskNumber ${disk} -PartitionNumber ${partition} -DriveLetter ${letter}`),
  };
}

export function createWindowsUnmountCommand(diskNumber: string | number, partitionNumber: string | number, accessPath: string): RemoteCommandInput {
  const disk = ensureWindowsDiskNumber(diskNumber);
  const partition = ensureWindowsPartitionNumber(partitionNumber);
  const path = accessPath.trim() || '';

  if (!/^[A-Za-z]:\\$/.test(path) && !/^\\\\\?\\Volume\{[A-Fa-f0-9-]+\}\\$/.test(path)) {
    throw new Error('卸载路径必须是盘符根路径或 Volume GUID 路径');
  }

  return {
    command: powershellCommand(`Remove-PartitionAccessPath -DiskNumber ${disk} -PartitionNumber ${partition} -AccessPath ${powershellSingleQuote(path)}`),
  };
}

export function createWindowsFormatCommand(driveLetter: string, fsType: WindowsFormatFileSystem, label: string): RemoteCommandInput {
  const letter = ensureDriveLetter(driveLetter);
  const safeLabel = ensureFileSystemLabel(label);

  return {
    command: powershellCommand(`Format-Volume -DriveLetter ${letter} -FileSystem ${fsType} -NewFileSystemLabel ${powershellSingleQuote(safeLabel)} -Confirm:$false -Force`),
  };
}

export function createWindowsCreatePartitionCommand(diskNumber: string | number, sizeGb: string, assignDriveLetter: boolean): RemoteCommandInput {
  const disk = ensureWindowsDiskNumber(diskNumber);
  const size = sizeGb.trim();
  const sizeArg = size ? ` -Size ${Number.parseFloat(size)}GB` : ' -UseMaximumSize';

  if (size && (!/^\d+(?:\.\d+)?$/.test(size) || Number.parseFloat(size) <= 0)) {
    throw new Error('Windows 分区容量必须是 GB 数字，留空则使用剩余空间');
  }

  return {
    command: powershellCommand(`New-Partition -DiskNumber ${disk}${sizeArg}${assignDriveLetter ? ' -AssignDriveLetter' : ''}`),
  };
}

export function createWindowsDeletePartitionCommand(diskNumber: string | number, partitionNumber: string | number): RemoteCommandInput {
  const disk = ensureWindowsDiskNumber(diskNumber);
  const partition = ensureWindowsPartitionNumber(partitionNumber);

  return {
    command: powershellCommand(`Remove-Partition -DiskNumber ${disk} -PartitionNumber ${partition} -Confirm:$false`),
  };
}
