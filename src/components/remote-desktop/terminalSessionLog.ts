import { stripTerminalControlSequences } from './terminalCommands';

export interface TerminalSessionLogController {
  isRecording: () => boolean;
  start: () => void;
  append: (data: string) => void;
  stopAndSave: () => Promise<string>;
  dispose: () => void;
}

const maximumSessionLogCharacters = 10 * 1024 * 1024;

function safeFileName(value: string) {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/\s+/gu, '-');
  return normalized.slice(0, 80) || 'terminal';
}

export function createTerminalSessionLogController({
  api,
  title,
  format,
}: {
  api: ShellDeskApi;
  title: string;
  format: () => ShellDeskAppSettings['terminalSessionLogFormat'];
}): TerminalSessionLogController {
  let recording = false;
  let chunks: string[] = [];
  let characters = 0;
  let truncated = false;
  let startedAt = '';

  const clear = () => {
    chunks = [];
    characters = 0;
    truncated = false;
    startedAt = '';
  };

  return {
    isRecording: () => recording,
    start: () => {
      clear();
      recording = true;
      startedAt = new Date().toISOString();
      const header = `ShellDesk terminal session\nTitle: ${title}\nStarted: ${startedAt}\n\n`;
      chunks.push(header);
      characters = header.length;
    },
    append: (data) => {
      if (!recording || !data || truncated) return;
      const value = format() === 'text' ? stripTerminalControlSequences(data) : data;
      const remaining = maximumSessionLogCharacters - characters;
      if (value.length > remaining) {
        chunks.push(value.slice(0, Math.max(0, remaining)));
        chunks.push('\n\n[ShellDesk: session log truncated at 10 MiB]\n');
        characters = maximumSessionLogCharacters;
        truncated = true;
        return;
      }
      chunks.push(value);
      characters += value.length;
    },
    stopAndSave: async () => {
      if (!recording) return '';
      recording = false;
      const selectedFormat = format();
      const extension = selectedFormat === 'ansi' ? 'ansi' : 'txt';
      const stamp = (startedAt || new Date().toISOString()).replace(/[:.]/gu, '-');
      const content = chunks.join('');
      clear();
      return api.files.saveTextFile({
        title: 'Save terminal session log',
        defaultFileName: `${safeFileName(title)}-${stamp}.${extension}`,
        content,
        filters: [{ name: selectedFormat === 'ansi' ? 'ANSI terminal log' : 'Text terminal log', extensions: [extension] }],
      });
    },
    dispose: () => {
      recording = false;
      clear();
    },
  };
}
