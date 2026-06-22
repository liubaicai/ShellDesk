import type { RemoteDirectoryResult, RemoteFileEntryType, RemotePathStat } from './fileExplorerTypes';

export function listDirectory(
  connectionId: string,
  remotePath: string,
  options?: ShellDeskSudoPasswordOptions,
): Promise<RemoteDirectoryResult> {
  return window.guiSSH!.connections.listDirectory(connectionId, remotePath, options);
}

export function createDirectory(
  connectionId: string,
  targetPath: string,
  options?: ShellDeskSudoPasswordOptions,
): Promise<boolean> {
  return window.guiSSH!.connections.createDirectory(connectionId, targetPath, options);
}

export function createFile(
  connectionId: string,
  targetPath: string,
  options?: ShellDeskSudoPasswordOptions,
): Promise<boolean> {
  return window.guiSSH!.connections.createFile(connectionId, targetPath, options);
}

export function renameEntry(
  connectionId: string,
  oldPath: string,
  newPath: string,
  options?: ShellDeskSudoPasswordOptions,
): Promise<boolean> {
  return window.guiSSH!.connections.renamePath(connectionId, oldPath, newPath, options);
}

export function deleteEntry(
  connectionId: string,
  entryPath: string,
  entryType: RemoteFileEntryType,
  options?: ShellDeskSudoPasswordOptions,
): Promise<boolean> {
  return window.guiSSH!.connections.deletePath(connectionId, entryPath, entryType, options);
}

export function statPath(
  connectionId: string,
  entryPath: string,
  options?: ShellDeskSudoPasswordOptions,
): Promise<RemotePathStat | null> {
  return window.guiSSH!.connections.statPath(connectionId, entryPath, options);
}

export function setPathPermissions(
  connectionId: string,
  entryPath: string,
  options: {
    mode: number;
    recursive: boolean;
  } & ShellDeskSudoPasswordOptions,
): Promise<boolean> {
  return window.guiSSH!.connections.setPathPermissions(connectionId, entryPath, options);
}

export function compressEntries(
  connectionId: string,
  sourcePaths: string[],
  format: string,
  destPath: string,
): ReturnType<ShellDeskConnectionControls['compress']> {
  return window.guiSSH!.connections.compress(connectionId, sourcePaths, format, destPath);
}

export function decompressEntry(
  connectionId: string,
  archivePath: string,
  destPath: string,
): ReturnType<ShellDeskConnectionControls['decompress']> {
  return window.guiSSH!.connections.decompress(connectionId, archivePath, destPath);
}
