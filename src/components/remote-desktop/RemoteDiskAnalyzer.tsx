import { useCallback, useEffect, useMemo, useState } from 'react';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface RemoteDiskAnalyzerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenFileManager?: (path: string) => void;
}

interface DiskUsageMount {
  filesystem: string;
  mountPoint: string;
  size: string;
  used: string;
  available: string;
  usePercent: number;
}

interface DirectorySizeEntry {
  path: string;
  name: string;
  type: 'directory' | 'file' | 'unknown';
  sizeBytes: number;
  sizeText: string;
  modifiedAt?: string;
}

type DiskPanel = 'children' | 'large';

const duMarker = '__SHELLDESK_DU__';
const metaMarker = '__SHELLDESK_DU_META__';

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error(tCurrent('auto.remoteDiskAnalyzer.g77vf3'));
  }

  return api.runCommand(connectionId, command);
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatBytes(bytes: number) {
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

function getBaseName(path: string) {
  const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizedPath.split('/').filter(Boolean).pop() || normalizedPath || '/';
}

function getParentPath(path: string, isWindowsHost: boolean) {
  const trimmedPath = path.trim();

  if (!trimmedPath || trimmedPath === '.' || trimmedPath === '/') {
    return trimmedPath || '.';
  }

  if (isWindowsHost) {
    const normalizedPath = trimmedPath.replace(/\//g, '\\').replace(/\\+$/, '');
    const driveMatch = normalizedPath.match(/^[A-Za-z]:\\?$/);
    if (driveMatch) return normalizedPath;
    const index = normalizedPath.lastIndexOf('\\');
    if (index <= 2) return normalizedPath.slice(0, 3);
    return normalizedPath.slice(0, index);
  }

  const normalizedPath = trimmedPath.replace(/\/+$/, '');
  const index = normalizedPath.lastIndexOf('/');
  return index <= 0 ? '/' : normalizedPath.slice(0, index);
}

function parsePercent(value: string) {
  const parsedValue = Number.parseFloat(value.replace('%', ''));
  return Number.isFinite(parsedValue) ? Math.min(Math.max(parsedValue, 0), 100) : 0;
}

function parseUnixMounts(stdout: string): DiskUsageMount[] {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const mountPoint = parts.slice(5).join(' ') || parts[5] || '-';

      return {
        filesystem: parts[0] || '-',
        size: parts[1] || '-',
        used: parts[2] || '-',
        available: parts[3] || '-',
        usePercent: parsePercent(parts[4] || '0'),
        mountPoint,
      };
    });
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }

  return '';
}

function readNumber(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsedValue = Number.parseFloat(value);
      if (Number.isFinite(parsedValue)) return parsedValue;
    }
  }

  return 0;
}

function parseJsonRows(stdout: string): Record<string, unknown>[] {
  const trimmedText = stdout.trim();

  if (!trimmedText) {
    return [];
  }

  const parsedJson = JSON.parse(trimmedText) as unknown;
  return (Array.isArray(parsedJson) ? parsedJson : [parsedJson])
    .map(toRecord)
    .filter((record): record is Record<string, unknown> => Boolean(record));
}

function parseWindowsMounts(stdout: string): DiskUsageMount[] {
  return parseJsonRows(stdout).map((record) => {
    const used = readNumber(record, 'Used');
    const free = readNumber(record, 'Free');
    const total = used + free;

    return {
      filesystem: readString(record, 'Name') || readString(record, 'Root') || '-',
      mountPoint: readString(record, 'Root') || readString(record, 'Name') || '-',
      size: formatBytes(total),
      used: formatBytes(used),
      available: formatBytes(free),
      usePercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  });
}

function createUnixMountCommand() {
  return 'df -P -h';
}

function createWindowsMountCommand() {
  return powershellCommand('Get-PSDrive -PSProvider FileSystem | Select-Object Name,Root,Used,Free | ConvertTo-Json -Depth 3');
}

function createUnixScanCommand(path: string) {
  const quotedPath = shellSingleQuote(path);
  return [
    `echo ${duMarker}`,
    `du -x -d 1 -B1 ${quotedPath} 2>/dev/null | sort -nr | head -n 160`,
    `echo ${metaMarker}`,
    `find ${quotedPath} -maxdepth 1 -mindepth 1 -printf '%y\\t%TY-%Tm-%Td %TH:%TM\\t%p\\n' 2>/dev/null | head -n 300`,
  ].join('; ');
}

function createWindowsScanCommand(path: string) {
  return powershellCommand(`
$target = ${powershellSingleQuote(path)}
$items = Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue | Select-Object -First 120
$rows = foreach ($item in $items) {
  $size = if ($item.PSIsContainer) {
    (Get-ChildItem -LiteralPath $item.FullName -Force -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  } else {
    $item.Length
  }
  if ($null -eq $size) { $size = 0 }
  [PSCustomObject]@{
    Path = $item.FullName
    Name = $item.Name
    Type = if ($item.PSIsContainer) { 'directory' } else { 'file' }
    SizeBytes = [int64]$size
    ModifiedAt = $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
  }
}
$rows | Sort-Object SizeBytes -Descending | ConvertTo-Json -Depth 4
`);
}

function parseUnixScan(stdout: string, currentPath: string): DirectorySizeEntry[] {
  const sections = stdout.split(metaMarker);
  const duText = sections[0].replace(duMarker, '').trim();
  const metaText = sections[1] ?? '';
  const metaByPath = new Map<string, { type: DirectorySizeEntry['type']; modifiedAt?: string }>();
  const entries: DirectorySizeEntry[] = [];

  metaText.split(/\r?\n/).forEach((line) => {
    const [typeText, modifiedAt, path] = line.split('\t');
    if (!path) return;
    metaByPath.set(path, {
      type: typeText === 'd' ? 'directory' : typeText === 'f' ? 'file' : 'unknown',
      modifiedAt,
    });
  });

  duText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) return;
      const sizeBytes = Number.parseInt(match[1], 10);
      const path = match[2];
      if (path === currentPath) return;
      const meta = metaByPath.get(path);
      entries.push({
        path,
        name: getBaseName(path),
        type: meta?.type ?? 'unknown',
        sizeBytes,
        sizeText: formatBytes(sizeBytes),
        modifiedAt: meta?.modifiedAt,
      });
    });

  return entries.sort((left, right) => right.sizeBytes - left.sizeBytes);
}

function parseWindowsScan(stdout: string): DirectorySizeEntry[] {
  return parseJsonRows(stdout)
    .map((record) => {
      const sizeBytes = readNumber(record, 'SizeBytes');
      const path = readString(record, 'Path');
      return {
        path,
        name: readString(record, 'Name') || getBaseName(path),
        type: readString(record, 'Type') === 'directory' ? 'directory' : 'file',
        sizeBytes,
        sizeText: formatBytes(sizeBytes),
        modifiedAt: readString(record, 'ModifiedAt'),
      } satisfies DirectorySizeEntry;
    })
    .filter((entry) => Boolean(entry.path));
}

function createUnixLargeFileCommand(path: string, minMb: number) {
  return `find ${shellSingleQuote(path)} -type f -size +${minMb}M -printf '%s\\t%TY-%Tm-%Td %TH:%TM\\t%p\\n' 2>/dev/null | sort -nr | head -n 100`;
}

function createWindowsLargeFileCommand(path: string, minMb: number) {
  return powershellCommand(`
$target = ${powershellSingleQuote(path)}
$minBytes = ${minMb} * 1MB
Get-ChildItem -LiteralPath $target -Force -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -gt $minBytes } |
  Sort-Object Length -Descending |
  Select-Object -First 100 @{Name='Path';Expression={$_.FullName}},@{Name='Name';Expression={$_.Name}},@{Name='SizeBytes';Expression={$_.Length}},@{Name='ModifiedAt';Expression={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')}} |
  ConvertTo-Json -Depth 4
`);
}

function parseUnixLargeFiles(stdout: string): DirectorySizeEntry[] {
  const entries: DirectorySizeEntry[] = [];

  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [sizeText, modifiedAt, path] = line.split('\t');
      const sizeBytes = Number.parseInt(sizeText, 10);
      if (!path || !Number.isFinite(sizeBytes)) return;
      entries.push({
        path,
        name: getBaseName(path),
        type: 'file',
        sizeBytes,
        sizeText: formatBytes(sizeBytes),
        modifiedAt,
      });
    });

  return entries;
}

function parseWindowsLargeFiles(stdout: string): DirectorySizeEntry[] {
  return parseJsonRows(stdout)
    .map((record) => {
      const path = readString(record, 'Path');
      const sizeBytes = readNumber(record, 'SizeBytes');
      return {
        path,
        name: readString(record, 'Name') || getBaseName(path),
        type: 'file' as const,
        sizeBytes,
        sizeText: formatBytes(sizeBytes),
        modifiedAt: readString(record, 'ModifiedAt'),
      };
    })
    .filter((entry) => Boolean(entry.path));
}

function RemoteDiskAnalyzer({ connectionId, systemType, onOpenFileManager }: RemoteDiskAnalyzerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [mounts, setMounts] = useState<DiskUsageMount[]>([]);
  const [currentPath, setCurrentPath] = useState(isWindowsHost ? 'C:\\' : '/');
  const [pathDraft, setPathDraft] = useState(isWindowsHost ? 'C:\\' : '/');
  const [entries, setEntries] = useState<DirectorySizeEntry[]>([]);
  const [largeFiles, setLargeFiles] = useState<DirectorySizeEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [activePanel, setActivePanel] = useState<DiskPanel>('children');
  const [minLargeFileMb, setMinLargeFileMb] = useState('100');
  const [mountLoading, setMountLoading] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  const [largeLoading, setLargeLoading] = useState(false);
  const [scanTargetPath, setScanTargetPath] = useState('');
  const [largeTargetPath, setLargeTargetPath] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selectedEntry = useMemo(() => {
    const allEntries = activePanel === 'children' ? entries : largeFiles;
    return allEntries.find((entry) => entry.path === selectedPath) ?? allEntries[0] ?? null;
  }, [activePanel, entries, largeFiles, selectedPath]);

  const maxEntrySize = useMemo(() => {
    return Math.max(...entries.map((entry) => entry.sizeBytes), 1);
  }, [entries]);

  const refreshMounts = useCallback(async () => {
    setMountLoading(true);
    setError('');

    try {
      const result = await runCmd(connectionId, isWindowsHost ? createWindowsMountCommand() : createUnixMountCommand());
      const nextMounts = isWindowsHost ? parseWindowsMounts(result.stdout) : parseUnixMounts(result.stdout);
      setMounts(nextMounts);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setMountLoading(false);
    }
  }, [connectionId, isWindowsHost]);

  const scanPath = useCallback(async (path: string) => {
    const nextPath = path.trim() || (isWindowsHost ? 'C:\\' : '/');
    setScanLoading(true);
    setScanTargetPath(nextPath);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, isWindowsHost ? createWindowsScanCommand(nextPath) : createUnixScanCommand(nextPath));
      const nextEntries = isWindowsHost ? parseWindowsScan(result.stdout) : parseUnixScan(result.stdout, nextPath);
      setCurrentPath(nextPath);
      setPathDraft(nextPath);
      setEntries(nextEntries);
      setSelectedPath(nextEntries[0]?.path ?? '');
      if (result.stderr.trim()) {
        setNotice(result.stderr.trim());
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setScanLoading(false);
      setScanTargetPath('');
    }
  }, [connectionId, isWindowsHost]);

  const searchLargeFiles = useCallback(async () => {
    const minMb = Math.min(Math.max(Number.parseInt(minLargeFileMb, 10) || 100, 1), 102400);
    setLargeLoading(true);
    setLargeTargetPath(currentPath);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, isWindowsHost ? createWindowsLargeFileCommand(currentPath, minMb) : createUnixLargeFileCommand(currentPath, minMb));
      const nextFiles = isWindowsHost ? parseWindowsLargeFiles(result.stdout) : parseUnixLargeFiles(result.stdout);
      setLargeFiles(nextFiles);
      setActivePanel('large');
      setSelectedPath(nextFiles[0]?.path ?? '');
      if (result.stderr.trim()) {
        setNotice(result.stderr.trim());
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLargeLoading(false);
      setLargeTargetPath('');
    }
  }, [connectionId, currentPath, isWindowsHost, minLargeFileMb]);

  useEffect(() => {
    void refreshMounts();
  }, [refreshMounts]);

  useEffect(() => {
    void scanPath(currentPath);
  }, [scanPath]);

  const copySelectedPath = async () => {
    if (!selectedEntry) return;
    await navigator.clipboard.writeText(selectedEntry.path);
    setNotice(tCurrent('auto.remoteDiskAnalyzer.dledl'));
  };

  const visibleEntries = activePanel === 'children' ? entries : largeFiles;
  const isResultLoading = scanLoading || largeLoading;
  const resultLoadingTitle = scanLoading ? tCurrent('auto.remoteDiskAnalyzer.v1yhzx') : tCurrent('auto.remoteDiskAnalyzer.q6fncc');
  const resultLoadingPath = scanLoading ? scanTargetPath || pathDraft || currentPath : largeTargetPath || currentPath;

  return (
    <section className="disk-analyzer">
      <header className="disk-toolbar">
        <div className="disk-path-bar">
          <button type="button" onClick={() => scanPath(getParentPath(currentPath, isWindowsHost))} disabled={scanLoading}>{tCurrent('auto.remoteDiskAnalyzer.1cs0t8u')}</button>
          <input value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void scanPath(pathDraft); }} />
          <button type="button" className="primary" onClick={() => scanPath(pathDraft)} disabled={scanLoading}>{scanLoading ? tCurrent('auto.remoteDiskAnalyzer.15wbj2u') : tCurrent('auto.remoteDiskAnalyzer.1myljr3')}</button>
        </div>
        <div className="disk-toolbar-actions">
          <input className="disk-threshold" inputMode="numeric" value={minLargeFileMb} onChange={(event) => setMinLargeFileMb(event.target.value)} title={tCurrent('auto.remoteDiskAnalyzer.1y5m4ea')} />
          <button type="button" onClick={searchLargeFiles} disabled={largeLoading}>{largeLoading ? tCurrent('auto.remoteDiskAnalyzer.5wh38i') : tCurrent('auto.remoteDiskAnalyzer.bdfoan')}</button>
          <button type="button" onClick={refreshMounts} disabled={mountLoading}>{mountLoading ? tCurrent('auto.remoteDiskAnalyzer.1taxqz1') : tCurrent('auto.remoteDiskAnalyzer.rnv4w3')}</button>
        </div>
      </header>

      {error ? <DismissibleAlert className="disk-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="disk-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      {mounts.length ? (
        <div className="disk-mount-strip" aria-label={tCurrent('auto.remoteDiskAnalyzer.1yik7h0')}>
          {mounts.map((mount) => (
            <button
              key={`${mount.filesystem}-${mount.mountPoint}`}
              type="button"
              title={`${mount.mountPoint} ${mount.filesystem} ${mount.used} / ${mount.size}`}
              onClick={() => scanPath(mount.mountPoint)}
            >
              <span><strong>{mount.mountPoint}</strong><em>{mount.filesystem}</em></span>
              <small>{mount.used} / {mount.size}</small>
              <i><b style={{ width: `${mount.usePercent}%` }} /></i>
              <mark>{mount.usePercent}%</mark>
            </button>
          ))}
        </div>
      ) : null}

      <div className="disk-layout">
        <aside className="disk-side">
          <div className="disk-side-title">
            <strong>{tCurrent('auto.remoteDiskAnalyzer.c8pdny')}</strong>
            <span>{currentPath}</span>
          </div>
          <button type="button" onClick={() => scanPath(isWindowsHost ? 'C:\\' : '/')}>{tCurrent('auto.remoteDiskAnalyzer.fn3h29')}</button>
          <button type="button" onClick={() => scanPath(isWindowsHost ? 'C:\\Users' : '/home')}>{isWindowsHost ? 'C:\\Users' : '/home'}</button>
          <button type="button" onClick={() => scanPath(isWindowsHost ? 'C:\\Windows\\Temp' : '/var')}>{isWindowsHost ? 'Temp' : '/var'}</button>
          <button type="button" onClick={() => scanPath(isWindowsHost ? 'C:\\Program Files' : '/tmp')}>{isWindowsHost ? 'Program Files' : '/tmp'}</button>
        </aside>

        <main className="disk-main">
          <div className="disk-tabs">
            <button type="button" className={activePanel === 'children' ? 'active' : ''} onClick={() => setActivePanel('children')}>{tCurrent('auto.remoteDiskAnalyzer.65vdry')}</button>
            <button type="button" className={activePanel === 'large' ? 'active' : ''} onClick={() => setActivePanel('large')}>{tCurrent('auto.remoteDiskAnalyzer.bdfoan2')}</button>
          </div>
          <div className="disk-entry-list" aria-busy={isResultLoading}>
            {visibleEntries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={selectedEntry?.path === entry.path ? 'active' : ''}
                onClick={() => setSelectedPath(entry.path)}
                onDoubleClick={() => entry.type === 'directory' && scanPath(entry.path)}
              >
                <span className={`disk-entry-type ${entry.type}`}>{entry.type === 'directory' ? 'DIR' : entry.type === 'file' ? 'FILE' : 'ITEM'}</span>
                <span className="disk-entry-name" title={entry.path}>
                  <strong>{entry.name}</strong>
                  <small>{entry.path}</small>
                </span>
                <span className="disk-entry-size">{entry.sizeText}</span>
                <span className="disk-size-bar"><i style={{ width: `${Math.max(4, (entry.sizeBytes / maxEntrySize) * 100)}%` }} /></span>
              </button>
            ))}
            {isResultLoading ? (
              <div className="disk-entry-loading" role="status" aria-live="polite">
                <div className="disk-entry-loading-card">
                  <span className="disk-entry-loading-spinner" aria-hidden="true" />
                  <strong>{resultLoadingTitle}</strong>
                  <span title={resultLoadingPath}>{resultLoadingPath}</span>
                </div>
              </div>
            ) : null}
            {!isResultLoading && visibleEntries.length === 0 ? <div className="disk-empty">{tCurrent('auto.remoteDiskAnalyzer.fgatcs')}</div> : null}
          </div>
        </main>

        <aside className="disk-detail">
          {selectedEntry ? (
            <>
              <div className="disk-detail-title">
                <span>{selectedEntry.type === 'directory' ? tCurrent('auto.remoteDiskAnalyzer.b9mnzg') : tCurrent('auto.remoteDiskAnalyzer.1aybos0')}</span>
                <strong title={selectedEntry.path}>{selectedEntry.name}</strong>
              </div>
              <dl>
                <div><dt>{tCurrent('auto.remoteDiskAnalyzer.1i41a3v')}</dt><dd>{selectedEntry.sizeText}</dd></div>
                <div><dt>{tCurrent('auto.remoteDiskAnalyzer.c8pdny2')}</dt><dd>{selectedEntry.path}</dd></div>
                <div><dt>{tCurrent('auto.remoteDiskAnalyzer.gdxblm')}</dt><dd>{selectedEntry.modifiedAt || '-'}</dd></div>
              </dl>
              <div className="disk-detail-actions">
                <button type="button" onClick={copySelectedPath}>{tCurrent('auto.remoteDiskAnalyzer.cbzts1')}</button>
                <button type="button" onClick={() => selectedEntry.type === 'directory' ? scanPath(selectedEntry.path) : scanPath(getParentPath(selectedEntry.path, isWindowsHost))}>{tCurrent('auto.remoteDiskAnalyzer.10tg474')}</button>
                <button type="button" disabled={!onOpenFileManager} onClick={() => onOpenFileManager?.(selectedEntry.type === 'directory' ? selectedEntry.path : getParentPath(selectedEntry.path, isWindowsHost))}>{tCurrent('auto.remoteDiskAnalyzer.1c01v4l')}</button>
              </div>
              <div className="disk-suggestion">
                <strong>{tCurrent('auto.remoteDiskAnalyzer.mvhjgi')}</strong>
                <p>{tCurrent('auto.remoteDiskAnalyzer.iuxxnn')}</p>
              </div>
            </>
          ) : (
            <div className="disk-empty detail">{tCurrent('auto.remoteDiskAnalyzer.2mkybx')}</div>
          )}
        </aside>
      </div>
    </section>
  );
}

export default RemoteDiskAnalyzer;
