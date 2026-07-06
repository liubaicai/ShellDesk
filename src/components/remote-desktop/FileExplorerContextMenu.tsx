import { createPortal } from 'react-dom';

import { t, type AppLanguage } from '../../i18n';
import ContextMenuIcon from './ContextMenuIcon';
import { isTextFile } from './textFileUtils';
import { joinRemotePath } from './fileExplorerPaths';
import {
  isArchiveFile,
  isDirectoryEntry,
  isFileEntry,
  isSqliteFile,
} from './fileExplorerIcons';
import type { ContextMenuState, RemoteFileEntry } from './fileExplorerTypes';

interface FileExplorerContextMenuProps {
  contextMenu: ContextMenuState | null;
  language: AppLanguage;
  remotePath: string;
  isWindowsHost: boolean;
  selectedNames: Set<string>;
  sortedEntries: RemoteFileEntry[];
  onOpenFileEntry: (entry: RemoteFileEntry) => void;
  onOpenFile?: (filePath: string) => void;
  onOpenSqliteFile?: (filePath: string) => void;
  onOpenTerminal?: (directoryPath: string) => void;
  onStartRename: (entry: RemoteFileEntry) => void;
  onCopyEntryPath: (entry: RemoteFileEntry) => void;
  onDownloadEntries: (entries: RemoteFileEntry[]) => void;
  onDecompressEntry: (entry: RemoteFileEntry) => void;
  onCompressEntries: (entries: RemoteFileEntry[], format: string) => void;
  onDeleteSelectedEntries: (entries?: RemoteFileEntry[]) => void;
  onShowProperties: (entry: RemoteFileEntry) => void;
  onRefresh: () => void;
  onStartNewItem: (type: 'file' | 'folder') => void;
  onUploadFiles: () => void;
  onUploadFolders: () => void;
  onClose: () => void;
}

function getContextTargets(
  contextMenu: ContextMenuState,
  selectedNames: Set<string>,
  sortedEntries: RemoteFileEntry[],
) {
  if (!contextMenu.targetEntry) {
    return [];
  }

  return selectedNames.has(contextMenu.targetEntry.name) && selectedNames.size > 1
    ? sortedEntries.filter((entry) => selectedNames.has(entry.name))
    : [contextMenu.targetEntry];
}

function FileExplorerContextMenu({
  contextMenu,
  language,
  remotePath,
  isWindowsHost,
  selectedNames,
  sortedEntries,
  onOpenFileEntry,
  onOpenFile,
  onOpenSqliteFile,
  onOpenTerminal,
  onStartRename,
  onCopyEntryPath,
  onDownloadEntries,
  onDecompressEntry,
  onCompressEntries,
  onDeleteSelectedEntries,
  onShowProperties,
  onRefresh,
  onStartNewItem,
  onUploadFiles,
  onUploadFolders,
  onClose,
}: FileExplorerContextMenuProps) {
  if (!contextMenu) {
    return null;
  }

  const targetEntry = contextMenu.targetEntry;
  const contextTargets = getContextTargets(contextMenu, selectedNames, sortedEntries);

  return createPortal(
    <>
      <div className="context-menu-overlay" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
      <div
        className="context-menu"
        style={{ left: contextMenu.x, top: contextMenu.y }}
        role="menu"
      >
        {targetEntry ? (
          <>
            {(isDirectoryEntry(targetEntry) || (targetEntry.type === 'symlink' && !isFileEntry(targetEntry))) && (
              <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => { onClose(); onOpenFileEntry(targetEntry); }}>
                <ContextMenuIcon name="open" />
                {t('fileExplorer.context.open', language)}
              </button>
            )}
            {isDirectoryEntry(targetEntry) && onOpenTerminal ? (
              <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => {
                onClose();
                onOpenTerminal(joinRemotePath(remotePath, targetEntry.name, isWindowsHost));
              }}>
                <ContextMenuIcon name="terminal" />
                {t('fileExplorer.details.openInTerminal', language)}
              </button>
            ) : null}
            {isFileEntry(targetEntry) && isTextFile(targetEntry.name) && onOpenFile && (
              <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => {
                onClose();
                onOpenFile(joinRemotePath(remotePath, targetEntry.name, isWindowsHost));
              }}>
                <ContextMenuIcon name="notepad" />
                {t('fileExplorer.open.notepad', language)}
              </button>
            )}
            {isFileEntry(targetEntry) && isSqliteFile(targetEntry.name) && onOpenSqliteFile && (
              <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => {
                onClose();
                onOpenSqliteFile(joinRemotePath(remotePath, targetEntry.name, isWindowsHost));
              }}>
                <ContextMenuIcon name="database" />
                {t('fileExplorer.open.sqlite', language)}
              </button>
            )}
            <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => onStartRename(targetEntry)}>
              <ContextMenuIcon name="rename" />
              {t('fileExplorer.context.rename', language)}
            </button>
            <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => onCopyEntryPath(targetEntry)}>
              <ContextMenuIcon name="copy" />
              {t('fileExplorer.context.copyPath', language)}
            </button>
            <button
              type="button"
              role="menuitem"
              className="context-menu-icon-button"
              onClick={() => onDownloadEntries(contextTargets)}
            >
              <ContextMenuIcon name="download" />
              {t('fileExplorer.toolbar.download', language)}
            </button>
            {isArchiveFile(targetEntry.name) && isFileEntry(targetEntry) && (!isWindowsHost || targetEntry.name.toLowerCase().endsWith('.zip')) && (
              <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => onDecompressEntry(targetEntry)}>
                <ContextMenuIcon name="archive" />
                {t('fileExplorer.details.decompress', language)}
              </button>
            )}
            <div className="context-menu-item-has-submenu">
              <button type="button" role="menuitem" className="context-menu-icon-button" aria-haspopup="menu">
                <ContextMenuIcon name="archive" />
                {t('fileExplorer.context.compressAs', language)}
              </button>
              <div className="context-submenu">
                <button type="button" role="menuitem" onClick={() => onCompressEntries(contextTargets, 'zip')}>ZIP (.zip)</button>
                {!isWindowsHost ? (
                  <>
                    <button type="button" role="menuitem" onClick={() => onCompressEntries(contextTargets, 'tar.gz')}>TAR.GZ (.tar.gz)</button>
                    <button type="button" role="menuitem" onClick={() => onCompressEntries(contextTargets, 'tar')}>TAR (.tar)</button>
                    <button type="button" role="menuitem" onClick={() => onCompressEntries(contextTargets, '7z')}>7Z (.7z)</button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="context-menu-sep" />
            <button type="button" role="menuitem" className="context-menu-icon-button danger-text" data-testid="explorer-context-delete" onClick={() => onDeleteSelectedEntries(targetEntry ? [targetEntry] : undefined)}>
              <ContextMenuIcon name="trash" />
              {t('fileExplorer.context.delete', language)}
            </button>
            <div className="context-menu-sep" />
            <button type="button" role="menuitem" className="context-menu-icon-button" data-testid="explorer-context-properties" onClick={() => onShowProperties(targetEntry)}>
              <ContextMenuIcon name="info" />
              {t('fileExplorer.context.properties', language)}
            </button>
          </>
        ) : (
          <>
            <button type="button" role="menuitem" className="context-menu-icon-button" onClick={onRefresh}>
              <ContextMenuIcon name="refresh" />
              {t('fileExplorer.toolbar.refresh', language)}
            </button>
            <div className="context-menu-sep" />
            <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => onStartNewItem('file')}>
              <ContextMenuIcon name="new-file" />
              {t('fileExplorer.toolbar.newFile', language)}
            </button>
            <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => onStartNewItem('folder')}>
              <ContextMenuIcon name="new-folder" />
              {t('fileExplorer.context.newFolder', language)}
            </button>
            <div className="context-menu-sep" />
            <button type="button" role="menuitem" className="context-menu-icon-button" onClick={onUploadFiles}>
              <ContextMenuIcon name="upload" />
              {t('fileExplorer.context.uploadFiles', language)}
            </button>
            <button type="button" role="menuitem" className="context-menu-icon-button" onClick={onUploadFolders}>
              <ContextMenuIcon name="upload" />
              {t('fileExplorer.context.uploadFolder', language)}
            </button>
            {onOpenTerminal ? (
              <button type="button" role="menuitem" className="context-menu-icon-button" onClick={() => { onClose(); onOpenTerminal(remotePath); }}>
                <ContextMenuIcon name="terminal" />
                {t('fileExplorer.details.openInTerminal', language)}
              </button>
            ) : null}
          </>
        )}
      </div>
    </>,
    document.body,
  );
}

export default FileExplorerContextMenu;
