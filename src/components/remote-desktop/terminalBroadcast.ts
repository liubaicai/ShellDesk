import { stripTerminalControlSequences } from './terminalCommands';
import type { RemoteTerminalBroadcastRequest } from './terminalTypes';

const sensitivePromptPattern = /(?:password|passphrase|pin|one[- ]time code|verification code|验证码|口令|密码)\s*[:：]?\s*$/iu;
export const maximumPendingTerminalBroadcastRequests = 512;

export function isSensitiveTerminalPrompt(data: string) {
  return sensitivePromptPattern.test(stripTerminalControlSequences(data).slice(-512));
}

export function canBroadcastTerminalInput(data: string, sensitivePrompt: boolean) {
  if (!data) return { allowed: false, reason: 'empty' as const };
  if (sensitivePrompt) return { allowed: false, reason: 'sensitive-prompt' as const };
  const lineBreaks = [...data].filter((character) => character === '\r' || character === '\n').length;
  if (data.length > 1024 || lineBreaks > 1) {
    return { allowed: false, reason: 'large-paste' as const };
  }
  return { allowed: true, reason: null };
}

export function enqueueTerminalBroadcastRequest(
  pending: RemoteTerminalBroadcastRequest[] | undefined,
  request: RemoteTerminalBroadcastRequest,
) {
  const current = pending ?? [];
  if (current.length >= maximumPendingTerminalBroadcastRequests) return current;
  return [...current, request];
}

export function completeTerminalBroadcastRequest(
  pending: RemoteTerminalBroadcastRequest[] | undefined,
  requestId: string,
) {
  if (!pending?.length) return pending;
  const remaining = pending.filter((request) => request.id !== requestId);
  return remaining.length ? remaining : undefined;
}
