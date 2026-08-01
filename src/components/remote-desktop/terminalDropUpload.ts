import type { MutableRefObject } from 'react';

import { getErrorMessage } from './desktopUtils';
import { t } from '../../i18n';

function quoteShellPath(path: string, windows: boolean) {
  if (windows) {
    return /[\s&|<>^()]/u.test(path) ? `"${path.replace(/"/gu, '""')}"` : path;
  }
  return /[\s'"\\$`!*?()[\]{};&|<>]/u.test(path)
    ? `'${path.replace(/'/gu, `'"'"'`)}'`
    : path;
}

function pointInsideHost(host: HTMLElement, x: number, y: number) {
  const bounds = host.getBoundingClientRect();
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

export async function attachTerminalDropUpload({
  host,
  api,
  connectionId,
  connectionKind,
  windows,
  settingsRef,
  resolveWorkingDirectory,
  writeInput,
  writeNotice,
}: {
  host: HTMLDivElement;
  api: ShellDeskApi;
  connectionId: string;
  connectionKind?: 'ssh' | 'local';
  windows: boolean;
  settingsRef: MutableRefObject<ShellDeskAppSettings>;
  resolveWorkingDirectory: () => Promise<string>;
  writeInput: (data: string) => void;
  writeNotice: (message: string) => void;
}) {
  let disposed = false;
  let nativeUnlisten: (() => void) | null = null;
  let uploadActive = false;

  const setDropActive = (active: boolean) => host.classList.toggle('terminal-drop-active', active);

  const uploadPaths = async (paths: string[]) => {
    if (disposed || uploadActive || !settingsRef.current.terminalDropUploadEnabled || !paths.length) {
      return;
    }
    uploadActive = true;
    setDropActive(false);
    try {
      if (connectionKind === 'local') {
        writeInput(paths.map((path) => quoteShellPath(path, windows)).join(' '));
        return;
      }
      const remoteDirectory = await resolveWorkingDirectory();
      const result = await api.connections.sftpUploadLocalPaths(
        connectionId,
        remoteDirectory || '.',
        paths.map((path) => ({ path })),
        { conflictPolicy: 'overwrite', sourcePaths: paths },
      );
      const remotePaths = result.remotePaths ?? [];
      if (remotePaths.length) {
        writeInput(remotePaths.map((path) => quoteShellPath(path, windows)).join(' '));
      }
      writeNotice(t('terminal.dropUpload.completed', settingsRef.current.language, { count: result.itemCount ?? paths.length }));
    } catch (error) {
      writeNotice(t('terminal.dropUpload.failed', settingsRef.current.language, { error: getErrorMessage(error) }));
    } finally {
      uploadActive = false;
    }
  };

  const handleDragOver = (event: DragEvent) => {
    if (!settingsRef.current.terminalDropUploadEnabled || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    setDropActive(true);
  };
  const handleDragLeave = () => setDropActive(false);
  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    setDropActive(false);
    const paths = [...(event.dataTransfer?.files ?? [])]
      .map((file) => (file as File & { path?: string }).path ?? '')
      .filter(Boolean);
    void uploadPaths(paths);
  };
  host.addEventListener('dragover', handleDragOver);
  host.addEventListener('dragleave', handleDragLeave);
  host.addEventListener('drop', handleDrop);

  nativeUnlisten = api.events.onFileDrop((payload) => {
    if (payload.type === 'leave' || !payload.position) {
      setDropActive(false);
      return;
    }
    const inside = pointInsideHost(host, payload.position.x, payload.position.y);
    setDropActive(inside && payload.type !== 'drop');
    if (inside && payload.type === 'drop') {
      void uploadPaths(payload.paths ?? []);
    }
  });

  return () => {
    disposed = true;
    setDropActive(false);
    nativeUnlisten?.();
    host.removeEventListener('dragover', handleDragOver);
    host.removeEventListener('dragleave', handleDragLeave);
    host.removeEventListener('drop', handleDrop);
  };
}

export async function pasteClipboardImageToTerminal({
  api,
  connectionId,
  windows,
  language,
  resolveWorkingDirectory,
  writeInput,
}: {
  api: ShellDeskApi;
  connectionId: string;
  windows: boolean;
  language: ShellDeskAppSettings['language'];
  resolveWorkingDirectory: () => Promise<string>;
  writeInput: (data: string) => void;
}) {
  if (!navigator.clipboard?.read) {
    throw new Error(t('terminal.clipboardImage.unsupported', language));
  }
  const clipboardItems = await navigator.clipboard.read();
  const imageType = clipboardItems.flatMap((item) => item.types).find((type) => type.startsWith('image/'));
  const item = clipboardItems.find((candidate) => imageType && candidate.types.includes(imageType));
  if (!item || !imageType) {
    throw new Error(t('terminal.clipboardImage.empty', language));
  }
  const blob = await item.getType(imageType);
  if (blob.size > 10 * 1024 * 1024) {
    throw new Error(t('terminal.clipboardImage.tooLarge', language));
  }
  const extension = imageType.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/giu, '') || 'png';
  const fileName = `shelldesk-paste-${new Date().toISOString().replace(/[:.]/gu, '-')}.${extension}`;
  const remoteDirectory = await resolveWorkingDirectory();
  const result = await api.connections.sftpUploadBytes(
    connectionId,
    remoteDirectory || '.',
    fileName,
    new Uint8Array(await blob.arrayBuffer()),
  );
  const remotePath = result.remotePaths?.[0];
  if (!remotePath) {
    throw new Error(t('terminal.clipboardImage.failed', language));
  }
  writeInput(quoteShellPath(remotePath, windows));
  return remotePath;
}
