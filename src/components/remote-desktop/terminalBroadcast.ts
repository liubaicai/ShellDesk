import { stripTerminalControlSequences } from './terminalCommands';

const sensitivePromptPattern = /(?:password|passphrase|pin|one[- ]time code|verification code|验证码|口令|密码)\s*[:：]?\s*$/iu;

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
