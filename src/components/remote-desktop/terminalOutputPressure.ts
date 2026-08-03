export type TerminalOutputPressure = 'normal' | 'busy' | 'saturated';

export interface TerminalOutputPressureSample {
  queuedBytes: number;
  recentBytes: number;
  largestChunkBytes: number;
  longestLineCharacters: number;
}

export function measureTerminalLongestLine(data: string, limit = 131_072) {
  let longest = 0;
  let current = 0;
  const length = Math.min(data.length, limit);
  for (let index = 0; index < length; index += 1) {
    if (data.charCodeAt(index) === 10 || data.charCodeAt(index) === 13) {
      longest = Math.max(longest, current);
      current = 0;
    } else {
      current += 1;
    }
  }
  return Math.max(longest, current);
}

export function resolveTerminalOutputPressure({
  queuedBytes,
  recentBytes,
  largestChunkBytes,
  longestLineCharacters,
}: TerminalOutputPressureSample): TerminalOutputPressure {
  if (
    queuedBytes >= 1024 * 1024
    || recentBytes >= 4 * 1024 * 1024
    || largestChunkBytes >= 512 * 1024
    || longestLineCharacters >= 64 * 1024
  ) {
    return 'saturated';
  }
  if (
    queuedBytes >= 256 * 1024
    || recentBytes >= 1024 * 1024
    || largestChunkBytes >= 128 * 1024
    || longestLineCharacters >= 16 * 1024
  ) {
    return 'busy';
  }
  return 'normal';
}
