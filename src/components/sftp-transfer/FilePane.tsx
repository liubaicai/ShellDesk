import {
  memo,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  File,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  MoreHorizontal,
  RefreshCw,
  Search,
} from 'lucide-react';

import { formatBytes } from '../remote-desktop/fileExplorerUtils';
import { formatDateTime } from '../remote-desktop/desktopUtils';
import {
  getPaneTreePathChain,
  getParentPanePath,
  joinPanePath,
  normalizePaneTreePath,
  paneTreePathsEqual,
} from './pathUtils';
import type { FilePaneController } from './useFilePane';
import type { SftpMessageKey } from './messages';
import type { TransferFileEntry, TransferPaneKind } from './types';

interface FilePaneProps {
  kind: TransferPaneKind;
  controller: FilePaneController;
  windowsLocal: boolean;
  differences: Set<string>;
  showHidden: boolean;
  isActive: boolean;
  t: (key: SftpMessageKey, params?: Record<string, string | number>) => string;
  onNewFolder: () => void;
  onNewFile: () => void;
  onRename: (entry: TransferFileEntry) => void;
  onDelete: (entries: TransferFileEntry[]) => void;
  onProperties: (entry: TransferFileEntry) => void;
  onTransfer: (entries: TransferFileEntry[]) => void;
  onActivate: () => void;
}

const FILE_TABLE_HEADER_HEIGHT = 29;
const FILE_TABLE_ROW_HEIGHT = 32;
const FILE_TABLE_OVERSCAN_ROWS = 10;
const FILE_TABLE_INITIAL_ROWS = 40;
const DIRECTORY_TREE_MIN_WIDTH = 96;
const DIRECTORY_TREE_MAX_WIDTH = 340;
const FILE_TABLE_MIN_WIDTH = 240;
const PANE_RESIZER_WIDTH = 5;
const DIRECTORY_TREE_KEYBOARD_STEP = 12;

interface DirectoryTreeNodeState {
  expanded: boolean;
  loading: boolean;
  children?: Array<{ entry: TransferFileEntry; path: string }>;
  error?: string;
}

interface DirectoryTreeNodeProps {
  entry: TransferFileEntry;
  path: string;
  currentPath: string;
  depth: number;
  nodes: Map<string, DirectoryTreeNodeState>;
  isRoot?: boolean;
  kind: TransferPaneKind;
  windows: boolean;
  t: FilePaneProps['t'];
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}

function DirectoryTreeNode({ entry, path, currentPath, depth, nodes, isRoot = false, kind, windows, t, onToggle, onOpen }: DirectoryTreeNodeProps) {
  const state = nodes.get(path);
  const expanded = state?.expanded ?? false;
  const selected = paneTreePathsEqual(kind, path, currentPath, windows);
  return (
    <>
      <div
        className={`tree-row ${isRoot ? 'root' : ''} ${expanded ? 'expanded' : ''} ${selected ? 'selected' : ''}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        aria-current={selected ? 'location' : undefined}
      >
        <button
          type="button"
          className="tree-toggle"
          aria-expanded={expanded}
          aria-label={`${t(expanded ? 'collapse' : 'expand')} ${entry.name}`}
          onClick={() => onToggle(path)}
          disabled={state?.loading}
        >
          {state?.loading ? <RefreshCw className="spin" aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </button>
        <button type="button" className="tree-label" onClick={() => onOpen(path)} title={entry.name}>
          {isRoot && kind === 'local' ? <HardDrive aria-hidden="true" /> : expanded ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
          <span>{entry.name}</span>
        </button>
      </div>
      {expanded && state?.children?.map((child) => (
        <DirectoryTreeNode key={child.path} entry={child.entry} path={child.path} currentPath={currentPath} depth={depth + 1} nodes={nodes} kind={kind} windows={windows} t={t} onToggle={onToggle} onOpen={onOpen} />
      ))}
      {expanded && state?.children?.length === 0 ? <div className="tree-status" style={{ paddingLeft: 32 + depth * 14 }}>{t('empty')}</div> : null}
      {state?.error ? <div className="tree-status error" style={{ paddingLeft: 32 + depth * 14 }} title={state.error}>{state.error}</div> : null}
    </>
  );
}

function FileIcon({ entry }: { entry: TransferFileEntry }) {
  if (entry.type === 'directory') return <Folder aria-hidden="true" />;
  if (/\.(?:js|ts|tsx|jsx|rs|go|py|java|c|cpp|h|css|html|xml|ya?ml|json|sh|ps1)$/i.test(entry.name)) return <FileCode2 aria-hidden="true" />;
  if (/\.(?:txt|md|log|conf|ini|csv)$/i.test(entry.name)) return <FileText aria-hidden="true" />;
  return <File aria-hidden="true" />;
}

function entryTypeLabel(entry: TransferFileEntry, t: FilePaneProps['t']) {
  if (entry.type === 'directory') return t('folderType');
  if (entry.type === 'symlink') return t('symlinkType');
  const extension = entry.name.includes('.') ? entry.name.split('.').pop()?.toUpperCase() : '';
  return extension ? `${extension} ${t('fileType')}` : t('fileType');
}

function FilePane({
  kind,
  controller,
  windowsLocal,
  differences,
  showHidden,
  isActive,
  t,
  onNewFolder,
  onNewFile,
  onRename,
  onDelete,
  onProperties,
  onTransfer,
  onActivate,
}: FilePaneProps) {
  const { state, visibleEntries, selectedEntries } = controller;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: TransferFileEntry } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [treeNodes, setTreeNodes] = useState<Map<string, DirectoryTreeNodeState>>(() => new Map());
  const [treeWidth, setTreeWidth] = useState<number | null>(null);
  const [resizingTree, setResizingTree] = useState(false);
  const tableFrameRef = useRef<HTMLDivElement | null>(null);
  const paneContentRef = useRef<HTMLDivElement | null>(null);
  const directoryTreeRef = useRef<HTMLElement | null>(null);
  const treeResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const treeFilterGenerationRef = useRef(0);
  const isLocal = kind === 'local';
  const pathWindows = isLocal && windowsLocal;
  const displayEntries = useMemo(() => showHidden ? visibleEntries : visibleEntries.filter((entry) => !entry.name.startsWith('.')), [showHidden, visibleEntries]);
  const currentTreePath = useMemo(() => normalizePaneTreePath(kind, state.path, pathWindows), [kind, pathWindows, state.path]);
  const treeRootPath = '/';
  const treePathChain = useMemo(() => getPaneTreePathChain(kind, currentTreePath, pathWindows), [currentTreePath, kind, pathWindows]);
  const treeRootEntry = useMemo<TransferFileEntry>(() => ({
    name: treeRootPath,
    longname: treeRootPath,
    type: 'directory',
    size: 0,
    modifiedAt: '',
  }), [treeRootPath]);
  const columns: Array<'name' | 'size' | 'type' | 'permissions' | 'modifiedAt'> = isLocal
    ? ['name', 'size', 'type', 'modifiedAt']
    : ['name', 'size', 'permissions', 'modifiedAt'];
  const virtualWindow = useMemo(() => {
    const visibleRowCount = viewportHeight > 0
      ? Math.ceil(viewportHeight / FILE_TABLE_ROW_HEIGHT) + FILE_TABLE_OVERSCAN_ROWS * 2
      : FILE_TABLE_INITIAL_ROWS;
    const start = Math.max(0, Math.floor(Math.max(0, scrollTop - FILE_TABLE_HEADER_HEIGHT) / FILE_TABLE_ROW_HEIGHT) - FILE_TABLE_OVERSCAN_ROWS);
    const end = Math.min(displayEntries.length, start + visibleRowCount);
    return {
      start,
      entries: displayEntries.slice(start, end),
      topHeight: start * FILE_TABLE_ROW_HEIGHT,
      bottomHeight: Math.max(0, (displayEntries.length - end) * FILE_TABLE_ROW_HEIGHT),
    };
  }, [displayEntries, scrollTop, viewportHeight]);

  useEffect(() => {
    const element = tableFrameRef.current;
    if (!element) return;
    const updateHeight = () => setViewportHeight(element.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const clampTreeWidth = useCallback((width: number) => {
    const paneWidth = paneContentRef.current?.clientWidth ?? DIRECTORY_TREE_MAX_WIDTH + FILE_TABLE_MIN_WIDTH + PANE_RESIZER_WIDTH;
    const responsiveMaximum = Math.max(
      DIRECTORY_TREE_MIN_WIDTH,
      Math.min(DIRECTORY_TREE_MAX_WIDTH, paneWidth - FILE_TABLE_MIN_WIDTH - PANE_RESIZER_WIDTH),
    );
    return Math.min(responsiveMaximum, Math.max(DIRECTORY_TREE_MIN_WIDTH, width));
  }, []);

  useEffect(() => {
    const element = paneContentRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setTreeWidth((current) => current === null ? null : clampTreeWidth(current));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [clampTreeWidth]);

  const loadTreePath = useCallback(async (path: string, expanded: boolean, generation: number) => {
    setTreeNodes((nodes) => {
      const next = new Map(nodes);
      const current = next.get(path);
      next.set(path, { ...current, expanded, loading: true, error: undefined });
      return next;
    });
    try {
      const result = await controller.listPath(path);
      if (treeFilterGenerationRef.current !== generation) return;
      const children = result.entries
        .filter((entry) => entry.type === 'directory' && (showHidden || !entry.name.startsWith('.')))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        .map((entry) => ({
          entry,
          path: normalizePaneTreePath(kind, joinPanePath(kind, result.path, entry.name, pathWindows), pathWindows),
        }));
      setTreeNodes((nodes) => {
        const next = new Map(nodes);
        const current = next.get(path);
        next.set(path, { ...current, expanded, loading: false, children, error: undefined });
        return next;
      });
    } catch (error) {
      if (treeFilterGenerationRef.current !== generation) return;
      setTreeNodes((nodes) => {
        const next = new Map(nodes);
        const current = next.get(path);
        next.set(path, { ...current, expanded, loading: false, error: error instanceof Error ? error.message : String(error) });
        return next;
      });
    }
  }, [controller, kind, pathWindows, showHidden]);

  useEffect(() => {
    treeFilterGenerationRef.current += 1;
    setTreeNodes(new Map());
  }, [showHidden]);

  useEffect(() => {
    const generation = treeFilterGenerationRef.current;
    void Promise.all(treePathChain.map((path) => loadTreePath(path, true, generation)));
  }, [loadTreePath, treePathChain]);

  useEffect(() => {
    const selected = directoryTreeRef.current?.querySelector<HTMLElement>('.tree-row[aria-current="location"]');
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentTreePath, treeNodes]);

  useEffect(() => {
    const maxScrollTop = Math.max(0, FILE_TABLE_HEADER_HEIGHT + displayEntries.length * FILE_TABLE_ROW_HEIGHT - viewportHeight);
    if (scrollTop <= maxScrollTop) return;
    const nextScrollTop = Math.min(scrollTop, maxScrollTop);
    setScrollTop(nextScrollTop);
    if (tableFrameRef.current) tableFrameRef.current.scrollTop = nextScrollTop;
  }, [displayEntries.length, scrollTop, viewportHeight]);

  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    void controller.loadPath(state.draftPath).catch(() => undefined);
  };

  const openEntry = (entry: TransferFileEntry) => {
    if (entry.type === 'directory') {
      void controller.loadPath(joinPanePath(kind, state.path, entry.name, pathWindows)).catch(() => undefined);
    }
  };

  const openTreePath = useCallback((path: string) => {
    void controller.loadPath(path).catch(() => undefined);
  }, [controller]);

  const toggleTreePath = useCallback((path: string) => {
    const current = treeNodes.get(path);
    if (current?.loading) return;
    if (current?.expanded) {
      setTreeNodes((nodes) => {
        const next = new Map(nodes);
        next.set(path, { ...current, expanded: false });
        return next;
      });
      return;
    }
    if (current?.children) {
      setTreeNodes((nodes) => {
        const next = new Map(nodes);
        next.set(path, { ...current, expanded: true, error: undefined });
        return next;
      });
      return;
    }
    void loadTreePath(path, true, treeFilterGenerationRef.current);
  }, [loadTreePath, treeNodes]);

  const startTreeResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    onActivate();
    const startWidth = directoryTreeRef.current?.getBoundingClientRect().width ?? treeWidth ?? 154;
    treeResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingTree(true);
  };

  const moveTreeResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = treeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setTreeWidth(clampTreeWidth(resize.startWidth + event.clientX - resize.startX));
  };

  const finishTreeResize = (event: PointerEvent<HTMLDivElement>) => {
    if (treeResizeRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    treeResizeRef.current = null;
    setResizingTree(false);
  };

  const resizeTreeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const currentWidth = directoryTreeRef.current?.getBoundingClientRect().width ?? treeWidth ?? 154;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    setTreeWidth(clampTreeWidth(currentWidth + direction * DIRECTORY_TREE_KEYBOARD_STEP));
  };

  const openContextMenu = (event: MouseEvent, entry: TransferFileEntry) => {
    event.preventDefault();
    if (!state.selectedNames.has(entry.name)) controller.selectEntry(entry, false, false);
    setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 230), entry });
  };

  return (
    <section className={`sftp-file-pane ${kind} ${isActive ? 'active' : ''}`} onMouseDown={onActivate} onClick={() => setContextMenu(null)}>
      <header className="sftp-pane-heading">
        <span className="sftp-pane-title">
          {isLocal ? <HardDrive aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
          <strong>{t(isLocal ? 'local' : 'remote')}</strong>
        </span>
        <span className="sftp-pane-heading-actions">
          <span>{state.entries.length} {t('items')}</span>
          <button type="button" onClick={onNewFolder} aria-label={`${t(isLocal ? 'local' : 'remote')} · ${t('newFolder')}`} title={t('newFolder')}><FolderPlus aria-hidden="true" /></button>
          <button type="button" onClick={onNewFile} aria-label={`${t(isLocal ? 'local' : 'remote')} · ${t('newFile')}`} title={t('newFile')}><FilePlus2 aria-hidden="true" /></button>
        </span>
      </header>

      <div className="sftp-pane-navigation">
        <button type="button" onClick={() => void controller.goBack().catch(() => undefined)} disabled={state.historyIndex <= 0} title={t('back')}><ArrowLeft aria-hidden="true" /></button>
        <button type="button" onClick={() => void controller.goForward().catch(() => undefined)} disabled={state.historyIndex >= state.history.length - 1} title={t('forward')}><ArrowRight aria-hidden="true" /></button>
        <button type="button" onClick={() => void controller.loadPath(getParentPanePath(kind, state.path, pathWindows)).catch(() => undefined)} title={t('up')}><ArrowUp aria-hidden="true" /></button>
        <button type="button" onClick={() => void controller.loadPath(isLocal ? '/' : '.').catch(() => undefined)} title={t('home')}><Home aria-hidden="true" /></button>
        <form className="sftp-path-form" onSubmit={submitPath}>
          <input value={state.draftPath} onChange={(event) => controller.setDraftPath(event.target.value)} aria-label={`${t(isLocal ? 'local' : 'remote')} ${t('path')}`} />
        </form>
        <button type="button" onClick={() => void controller.refresh().catch(() => undefined)} title={t('refresh')}><RefreshCw aria-hidden="true" className={state.loading ? 'spin' : ''} /></button>
        <label className="sftp-search-field">
          <Search aria-hidden="true" />
          <input value={state.search} onChange={(event) => controller.setSearch(event.target.value)} placeholder={t('search')} />
        </label>
      </div>

      <div
        ref={paneContentRef}
        className={`sftp-pane-content ${resizingTree ? 'resizing-tree' : ''}`}
        style={treeWidth === null ? undefined : ({ '--sftp-tree-user-width': `${treeWidth}px` } as CSSProperties)}
      >
        <aside ref={directoryTreeRef} className="sftp-directory-tree" aria-label={`${t(isLocal ? 'local' : 'remote')} ${t('directoryTree')}`}>
          <DirectoryTreeNode entry={treeRootEntry} path={treeRootPath} currentPath={currentTreePath} depth={0} nodes={treeNodes} isRoot kind={kind} windows={pathWindows} t={t} onToggle={toggleTreePath} onOpen={openTreePath} />
        </aside>

        <div
          className="sftp-pane-resizer"
          role="separator"
          aria-label={`${t(isLocal ? 'local' : 'remote')} · ${t('resizeDirectoryTree')}`}
          aria-orientation="vertical"
          aria-valuemin={DIRECTORY_TREE_MIN_WIDTH}
          aria-valuemax={DIRECTORY_TREE_MAX_WIDTH}
          aria-valuenow={Math.round(treeWidth ?? 154)}
          tabIndex={0}
          onPointerDown={startTreeResize}
          onPointerMove={moveTreeResize}
          onPointerUp={finishTreeResize}
          onPointerCancel={finishTreeResize}
          onKeyDown={resizeTreeWithKeyboard}
          onDoubleClick={() => setTreeWidth(null)}
          title={t('resizeDirectoryTree')}
        />

        <div className="sftp-file-table-frame" ref={tableFrameRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
          <table className="sftp-file-table" aria-rowcount={displayEntries.length}>
            <thead>
              <tr>
                {columns.map((field) => (
                  <th key={field} onClick={() => controller.setSort(field === 'permissions' ? 'type' : field)}>
                    <span>{field === 'name' ? t('name') : field === 'size' ? t('size') : field === 'modifiedAt' ? t('modified') : field === 'permissions' ? t('permission') : t('type')}</span>
                    {state.sortField === (field === 'permissions' ? 'type' : field) ? <ArrowDownAZ aria-hidden="true" /> : null}
                  </th>
                ))}
                <th className="actions-column"><MoreHorizontal aria-hidden="true" /></th>
              </tr>
            </thead>
            <tbody>
              {virtualWindow.topHeight > 0 ? <tr className="virtual-spacer" aria-hidden="true"><td colSpan={columns.length + 1} style={{ height: virtualWindow.topHeight }} /></tr> : null}
              {virtualWindow.entries.map((entry, virtualIndex) => {
                const selected = state.selectedNames.has(entry.name);
                return (
                  <tr
                    key={entry.name}
                    aria-rowindex={virtualWindow.start + virtualIndex + 1}
                    className={`${selected ? 'selected' : ''} ${differences.has(entry.name) ? 'different' : ''}`}
                    onClick={(event) => controller.selectEntry(entry, event.ctrlKey || event.metaKey, event.shiftKey)}
                    onDoubleClick={() => openEntry(entry)}
                    onContextMenu={(event) => openContextMenu(event, entry)}
                  >
                    <td className="name-cell"><FileIcon entry={entry} /><span>{entry.name}</span></td>
                    <td className="size-cell">{entry.type === 'directory' ? '—' : formatBytes(entry.size)}</td>
                    <td>{isLocal ? entryTypeLabel(entry, t) : entry.permissions || entry.longname.split(/\s+/)[0] || '—'}</td>
                    <td>{entry.modifiedAt ? formatDateTime(entry.modifiedAt) : '—'}</td>
                    <td className="row-actions"><button type="button" onClick={(event) => { event.stopPropagation(); onProperties(entry); }}><MoreHorizontal aria-hidden="true" /></button></td>
                  </tr>
                );
              })}
              {virtualWindow.bottomHeight > 0 ? <tr className="virtual-spacer" aria-hidden="true"><td colSpan={columns.length + 1} style={{ height: virtualWindow.bottomHeight }} /></tr> : null}
            </tbody>
          </table>
          {state.loading ? <div className="sftp-pane-overlay"><RefreshCw className="spin" aria-hidden="true" /><span>{t('loading')}</span></div> : null}
          {!state.loading && !displayEntries.length ? <div className="sftp-pane-empty">{state.search ? t('noMatches') : t('empty')}</div> : null}
          {state.error ? <div className="sftp-pane-error" role="alert">{state.error}</div> : null}
        </div>
      </div>

      <footer className="sftp-pane-footer">
        <span>{state.entries.length} {t('items')}</span>
        <span>{t('selected')}: {selectedEntries.length}</span>
        <span>{selectedEntries.length ? formatBytes(selectedEntries.reduce((total, entry) => total + entry.size, 0)) : '—'}</span>
      </footer>

      {contextMenu ? createPortal(
        <div className="sftp-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => { onTransfer(selectedEntries.length ? selectedEntries : [contextMenu.entry]); setContextMenu(null); }}>{t(isLocal ? 'upload' : 'download')}</button>
          <button type="button" onClick={() => { onNewFolder(); setContextMenu(null); }}>{t('newFolder')}</button>
          <button type="button" onClick={() => { onNewFile(); setContextMenu(null); }}>{t('newFile')}</button>
          <hr />
          <button type="button" onClick={() => { onRename(contextMenu.entry); setContextMenu(null); }}>{t('rename')}</button>
          <button type="button" onClick={() => { onProperties(contextMenu.entry); setContextMenu(null); }}>{t('properties')}</button>
          <button type="button" className="danger" onClick={() => { onDelete(selectedEntries.length ? selectedEntries : [contextMenu.entry]); setContextMenu(null); }}>{t('delete')}</button>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default memo(FilePane, (previous, next) => (
  previous.kind === next.kind
  && previous.controller === next.controller
  && previous.windowsLocal === next.windowsLocal
  && previous.differences === next.differences
  && previous.showHidden === next.showHidden
  && previous.isActive === next.isActive
  && previous.t === next.t
  && previous.onTransfer === next.onTransfer
));
