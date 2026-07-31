import type { RemoteTerminalExitResult } from './terminalTypes';

export function shouldCloseTerminalAfterExit(
  policy: ShellDeskAppSettings['terminalExitPolicy'],
  result: RemoteTerminalExitResult,
) {
  if (policy === 'close-always') return true;
  return policy === 'close-success' && result.code === 0 && !result.signal;
}
