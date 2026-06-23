import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage } from './desktopUtils';
import { formatBytes, readNumber, readString } from './parseUtils';
import { isWindowsSystem, powershellCommand, powershellSingleQuote } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import { useSudoCommand } from './sudoPrompt';
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

interface TreemapRect {
  entry: DirectorySizeEntry;
  x: number;
  y: number;
  width: number;
  height: number;
  colorIndex: number;
}

type DiskPanel = 'children' | 'large';

const duMarker = '__SHELLDESK_DU__';
const metaMarker = '__SHELLDESK_DU_META__';
const diskAnalyzerDiagnosticMarker = '__SHELLDESK_DISK_ANALYZER_DIAGNOSTICS__';

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

function createTreemapRects(entries: DirectorySizeEntry[], width: number, height: number) {
  const source = entries
    .filter((entry) => entry.sizeBytes > 0)
    .sort((first, second) => second.sizeBytes - first.sizeBytes)
    .slice(0, 28);
  const rects: TreemapRect[] = [];
  const walk = (items: DirectorySizeEntry[], x: number, y: number, rectWidth: number, rectHeight: number, depth: number) => {
    if (!items.length || rectWidth <= 2 || rectHeight <= 2) return;
    if (items.length === 1) {
      rects.push({ entry: items[0], x, y, width: rectWidth, height: rectHeight, colorIndex: depth + rects.length });
      return;
    }
    const total = items.reduce((sum, item) => sum + item.sizeBytes, 0);
    let splitIndex = 0;
    let runningTotal = 0;
    while (splitIndex < items.length - 1 && runningTotal < total / 2) {
      runningTotal += items[splitIndex].sizeBytes;
      splitIndex += 1;
    }
    const firstItems = items.slice(0, splitIndex);
    const secondItems = items.slice(splitIndex);
    const firstRatio = total > 0 ? runningTotal / total : 0.5;
    if (rectWidth >= rectHeight) {
      const firstWidth = Math.max(1, rectWidth * firstRatio);
      walk(firstItems, x, y, firstWidth, rectHeight, depth + 1);
      walk(secondItems, x + firstWidth, y, rectWidth - firstWidth, rectHeight, depth + 1);
    } else {
      const firstHeight = Math.max(1, rectHeight * firstRatio);
      walk(firstItems, x, y, rectWidth, firstHeight, depth + 1);
      walk(secondItems, x, y + firstHeight, rectWidth, rectHeight - firstHeight, depth + 1);
    }
  };
  walk(source, 0, 0, width, height, 0);
  return rects;
}

function drawTreemap(canvas: HTMLCanvasElement, entries: DirectorySizeEntry[], selectedPath: string, size: { width: number; height: number }, emptyLabel: string) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [] as TreemapRect[];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const rects = createTreemapRects(entries, width, height);
  const colors = ['#4cc49a', '#67b7ff', '#f08cc8', '#ffcf5a', '#a78bfa', '#f97316', '#22d3ee', '#70e3a2'];
  const fontFamily = getComputedStyle(canvas).getPropertyValue('--interface-font-family') || 'system-ui, sans-serif';
  ctx.font = `600 11px ${fontFamily}`;
  rects.forEach((rect) => {
    const padding = 2;
    const x = rect.x + padding;
    const y = rect.y + padding;
    const rectWidth = Math.max(0, rect.width - padding * 2);
    const rectHeight = Math.max(0, rect.height - padding * 2);
    const isSelected = rect.entry.path === selectedPath;
    ctx.fillStyle = colors[rect.colorIndex % colors.length];
    ctx.globalAlpha = isSelected ? 0.88 : 0.58;
    ctx.fillRect(x, y, rectWidth, rectHeight);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = isSelected ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, rectWidth - 1), Math.max(0, rectHeight - 1));
    if (rectWidth > 72 && rectHeight > 34) {
      ctx.fillStyle = 'rgba(4, 8, 13, 0.82)';
      ctx.fillRect(x + 5, y + 5, Math.min(rectWidth - 10, 160), 32);
      ctx.fillStyle = '#eef4ff';
      ctx.fillText(rect.entry.name || getBaseName(rect.entry.path), x + 9, y + 18, rectWidth - 18);
      ctx.fillStyle = 'rgba(238, 244, 255, 0.72)';
      ctx.fillText(rect.entry.sizeText, x + 9, y + 32, rectWidth - 18);
    }
  });
  if (rects.length === 0) {
    ctx.fillStyle = 'rgba(142, 160, 184, 0.86)';
    ctx.textAlign = 'center';
    ctx.fillText(emptyLabel, width / 2, height / 2);
    ctx.textAlign = 'left';
  }
  return rects;
}

function DiskTreemap({ entries, selectedPath, emptyLabel, onSelect, onOpenDirectory }: { entries: DirectorySizeEntry[]; selectedPath: string; emptyLabel: string; onSelect: (path: string) => void; onOpenDirectory: (entry: DirectorySizeEntry) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rectsRef = useRef<TreemapRect[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const updateSize = () => {
      const rect = canvas.getBoundingClientRect();
      setCanvasSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.width <= 0 || canvasSize.height <= 0) return;
    rectsRef.current = drawTreemap(canvas, entries, selectedPath, canvasSize, emptyLabel);
  }, [canvasSize, emptyLabel, entries, selectedPath]);

  const findEntryAtPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    return rectsRef.current.find((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)?.entry ?? null;
  };

  return (
    <div className="disk-treemap-panel">
      <canvas
        ref={canvasRef}
        className="disk-treemap-canvas"
        onClick={(event) => {
          const entry = findEntryAtPoint(event.clientX, event.clientY);
          if (entry) onSelect(entry.path);
        }}
        onDoubleClick={(event) => {
          const entry = findEntryAtPoint(event.clientX, event.clientY);
          if (entry?.type === 'directory') onOpenDirectory(entry);
        }}
      />
    </div>
  );
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
    const used = readNumber(record, 'Used') ?? 0;
    const free = readNumber(record, 'Free') ?? 0;
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
  return `
target=${quotedPath}
format_mtime() {
  mtime="$(stat -c '%y' "$1" 2>/dev/null | cut -c1-16)"
  if [ -z "$mtime" ]; then
    mtime="$(date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null)"
  fi
  printf '%s' "$mtime"
}
scan_children() {
  if [ "$target" = "/" ]; then
    for item in /* /.[!.]* /..?*; do
      [ -e "$item" ] || continue
      printf '%s\\n' "$item"
    done
  else
    base="\${target%/}"
    for item in "$base"/* "$base"/.[!.]* "$base"/..?*; do
      [ -e "$item" ] || continue
      printf '%s\\n' "$item"
    done
  fi
}
printf '%s\\n' ${shellSingleQuote(diskAnalyzerDiagnosticMarker)}
if ! command -v du >/dev/null 2>&1; then
  printf 'MISSING\\tdu\\t缺少 du，无法统计目录大小；Alpine 可安装 coreutils：apk add coreutils\\n'
fi
if [ ! -e "$target" ]; then
  printf 'NOTICE\\t路径不存在或不可访问：%s\\n' "$target"
fi
printf '%s\\n' ${shellSingleQuote(duMarker)}
if command -v du >/dev/null 2>&1 && [ -d "$target" ]; then
  scan_children | while IFS= read -r item; do
    size_kb="$(du -sk -x "$item" 2>/dev/null | awk 'NR==1 { print $1 }')"
    case "$size_kb" in ''|*[!0-9]*) size_kb="$(du -sk "$item" 2>/dev/null | awk 'NR==1 { print $1 }')" ;; esac
    case "$size_kb" in ''|*[!0-9]*) size_kb=0 ;; esac
    printf '%s\\t%s\\n' "$((size_kb * 1024))" "$item"
  done | sort -nr | head -n 160
fi
printf '%s\\n' ${shellSingleQuote(metaMarker)}
if [ -d "$target" ]; then
  scan_children | head -n 300 | while IFS= read -r item; do
    if [ -d "$item" ]; then type='d'; elif [ -f "$item" ]; then type='f'; else type='u'; fi
    printf '%s\\t%s\\t%s\\n' "$type" "$(format_mtime "$item")" "$item"
  done
fi
`.trim();
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

function parseDiskAnalyzerDiagnosticNotice(text: string) {
  const notices: string[] = [];

  text.split(/\r?\n/).forEach((line) => {
    const [kind, commandName, message] = line.split('\t');

    if (kind === 'MISSING' && message) {
      notices.push(message);
      return;
    }

    if (kind === 'NOTICE') {
      notices.push([commandName, message].filter(Boolean).join('\t'));
    }
  });

  return Array.from(new Set(notices)).join('\n');
}

function parseUnixScan(stdout: string, currentPath: string): { entries: DirectorySizeEntry[]; notice: string } {
  const [diagnosticPrefix = '', afterDiagnostic = stdout] = stdout.includes(diskAnalyzerDiagnosticMarker)
    ? stdout.split(diskAnalyzerDiagnosticMarker)
    : ['', stdout];
  void diagnosticPrefix;
  const [diagnosticText = '', scanText = afterDiagnostic] = afterDiagnostic.includes(duMarker)
    ? afterDiagnostic.split(duMarker)
    : ['', afterDiagnostic];
  const sections = scanText.split(metaMarker);
  const duText = sections[0].trim();
  const metaText = sections[1] ?? '';
  const metaByPath = new Map<string, { type: DirectorySizeEntry['type']; modifiedAt?: string }>();
  const entries: DirectorySizeEntry[] = [];
  const notice = parseDiskAnalyzerDiagnosticNotice(diagnosticText.trim());

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

  return {
    entries: entries.sort((left, right) => right.sizeBytes - left.sizeBytes),
    notice,
  };
}

function parseWindowsScan(stdout: string): DirectorySizeEntry[] {
  return parseJsonRows(stdout)
    .map((record) => {
      const sizeBytes = readNumber(record, 'SizeBytes') ?? 0;
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
  const minKb = Math.max(minMb * 1024, 1);
  return `
target=${shellSingleQuote(path)}
format_mtime() {
  mtime="$(stat -c '%y' "$1" 2>/dev/null | cut -c1-16)"
  if [ -z "$mtime" ]; then
    mtime="$(date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null)"
  fi
  printf '%s' "$mtime"
}
printf '%s\\n' ${shellSingleQuote(diskAnalyzerDiagnosticMarker)}
if ! command -v find >/dev/null 2>&1; then
  printf 'MISSING\\tfind\\t缺少 find，无法搜索大文件；Alpine 可安装 findutils：apk add findutils\\n'
fi
if [ ! -e "$target" ]; then
  printf 'NOTICE\\t路径不存在或不可访问：%s\\n' "$target"
fi
printf '%s\\n' ${shellSingleQuote(duMarker)}
if command -v find >/dev/null 2>&1 && [ -d "$target" ]; then
  find "$target" -type f -size +${minKb}k -exec sh -c '
    file=$1
    size=$(wc -c < "$file" 2>/dev/null || printf 0)
    case "$size" in ""|*[!0-9]*) size=0 ;; esac
    mtime=$(stat -c "%y" "$file" 2>/dev/null | cut -c1-16)
    if [ -z "$mtime" ]; then
      mtime=$(date -r "$file" "+%Y-%m-%d %H:%M" 2>/dev/null)
    fi
    printf "%s\\t%s\\t%s\\n" "$size" "$mtime" "$file"
  ' sh {} \\; 2>/dev/null | sort -nr | head -n 100
fi
`.trim();
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

function parseUnixLargeFiles(stdout: string): { entries: DirectorySizeEntry[]; notice: string } {
  const [, afterDiagnostic = stdout] = stdout.includes(diskAnalyzerDiagnosticMarker)
    ? stdout.split(diskAnalyzerDiagnosticMarker)
    : ['', stdout];
  const [diagnosticText = '', fileText = afterDiagnostic] = afterDiagnostic.includes(duMarker)
    ? afterDiagnostic.split(duMarker)
    : ['', afterDiagnostic];
  const entries: DirectorySizeEntry[] = [];
  const notice = parseDiskAnalyzerDiagnosticNotice(diagnosticText.trim());

  fileText
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

  return { entries, notice };
}

function parseWindowsLargeFiles(stdout: string): DirectorySizeEntry[] {
  return parseJsonRows(stdout)
    .map((record) => {
      const path = readString(record, 'Path');
      const sizeBytes = readNumber(record, 'SizeBytes') ?? 0;
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
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
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
      const result = await runCommand(isWindowsHost ? createWindowsMountCommand() : createUnixMountCommand());
      const nextMounts = isWindowsHost ? parseWindowsMounts(result.stdout) : parseUnixMounts(result.stdout);
      setMounts(nextMounts);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setMountLoading(false);
    }
  }, [isWindowsHost, runCommand]);

  const scanPath = useCallback(async (path: string) => {
    const nextPath = path.trim() || (isWindowsHost ? 'C:\\' : '/');
    setScanLoading(true);
    setScanTargetPath(nextPath);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(isWindowsHost ? createWindowsScanCommand(nextPath) : createUnixScanCommand(nextPath));
      const parsedUnixScan = isWindowsHost ? null : parseUnixScan(result.stdout, nextPath);
      const nextEntries = isWindowsHost ? parseWindowsScan(result.stdout) : parsedUnixScan?.entries ?? [];
      const nextNotice = [result.stderr.trim(), parsedUnixScan?.notice].filter(Boolean).join('\n');
      setCurrentPath(nextPath);
      setPathDraft(nextPath);
      setEntries(nextEntries);
      setSelectedPath(nextEntries[0]?.path ?? '');
      if (nextNotice) {
        setNotice(nextNotice);
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setScanLoading(false);
      setScanTargetPath('');
    }
  }, [isWindowsHost, runCommand]);

  const searchLargeFiles = useCallback(async () => {
    const minMb = Math.min(Math.max(Number.parseInt(minLargeFileMb, 10) || 100, 1), 102400);
    setLargeLoading(true);
    setLargeTargetPath(currentPath);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(isWindowsHost ? createWindowsLargeFileCommand(currentPath, minMb) : createUnixLargeFileCommand(currentPath, minMb));
      const parsedUnixFiles = isWindowsHost ? null : parseUnixLargeFiles(result.stdout);
      const nextFiles = isWindowsHost ? parseWindowsLargeFiles(result.stdout) : parsedUnixFiles?.entries ?? [];
      const nextNotice = [result.stderr.trim(), parsedUnixFiles?.notice].filter(Boolean).join('\n');
      setLargeFiles(nextFiles);
      setActivePanel('large');
      setSelectedPath(nextFiles[0]?.path ?? '');
      if (nextNotice) {
        setNotice(nextNotice);
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLargeLoading(false);
      setLargeTargetPath('');
    }
  }, [currentPath, isWindowsHost, minLargeFileMb, runCommand]);

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
          <DiskTreemap
            entries={visibleEntries}
            selectedPath={selectedEntry?.path ?? ''}
            emptyLabel={tCurrent('auto.remoteDiskAnalyzer.fgatcs')}
            onSelect={setSelectedPath}
            onOpenDirectory={(entry) => void scanPath(entry.path)}
          />
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
      {sudoPrompt}
    </section>
  );
}

export default RemoteDiskAnalyzer;
