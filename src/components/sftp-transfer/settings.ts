export interface SftpInitialDirectories {
  local: string;
  remote: string;
}

export function resolveSftpInitialDirectories(
  localDirectory: string,
  remoteDirectory: string,
): SftpInitialDirectories {
  return {
    local: localDirectory.trim() || '/',
    remote: remoteDirectory.trim() || '.',
  };
}
