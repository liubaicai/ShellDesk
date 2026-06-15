import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { indentWithTab } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';

import { t, translateStructuredText, type AppLanguage, type MessageId } from '../../i18n';
import { getErrorMessage } from './desktopUtils';
import RemoteFilePicker from './RemoteFilePicker';
import { clearCachedSudoPassword, getCachedSudoOptions, setCachedSudoPassword } from './sudoPrompt';
import type { RemoteSystemType } from './types';

interface NotepadTab {
  id: string;
  filePath?: string;
  title: string;
  content: string;
  originalContent: string;
  dirty: boolean;
  readOnly: boolean;
  revisionHint?: string;
  language: string;
  languageManuallySet: boolean;
  isLoading: boolean;
  isSaving: boolean;
  error: string;
}

interface RemoteNotepadProps {
  connectionId: string;
  settings: ShellDeskAppSettings;
  initialFilePath?: string;
  initialContent?: string;
  initialTitle?: string;
  openFileRequest?: NotepadOpenFileRequest;
  systemType?: RemoteSystemType;
}

interface NotepadOpenFileRequest {
  id: string;
  filePath: string;
}

interface SaveOptions {
  closeAfterSave?: boolean;
  force?: boolean;
}

interface NotepadConflictDialog {
  tabId: string;
  title: string;
  filePath: string;
  remoteContent?: string;
  remoteRevisionHint?: string;
  readError?: string;
  closeAfterSave: boolean;
}

interface NotepadDiffDialog {
  tabId: string;
  title: string;
  beforeLabel: string;
  beforeContent: string;
  afterLabel: string;
  afterContent: string;
}

type NotepadSudoOperation = 'read' | 'save';

interface NotepadSudoPrompt {
  operation: NotepadSudoOperation;
  filePath: string;
  error: string;
  password: string;
}

interface DiffPreviewLine {
  kind: 'context' | 'added' | 'removed' | 'meta';
  text: string;
}

interface DiffPreview {
  lines: DiffPreviewLine[];
  truncated: boolean;
}

type NotepadAiMessageRole = 'user' | 'assistant' | 'tool';

type NotepadAiAction =
  | {
      type: 'replace_content' | 'append_content' | 'insert_at_cursor' | 'replace_selection';
      content: string;
      summary?: string;
    }
  | {
      type: 'run_command';
      command: string;
      reason?: string;
    };

interface NotepadAiMessage {
  id: string;
  role: NotepadAiMessageRole;
  content: string;
  createdAt: string;
  action?: NotepadAiAction;
  actionApplied?: boolean;
}

interface EditorSelectionSnapshot {
  start: number;
  end: number;
  text: string;
}

/** Binary file extension denylist; other files are allowed to open in Notepad. */
const BINARY_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'tif',
  'psd', 'ai', 'eps', 'raw', 'cr2', 'nef', 'arw', 'dng', 'heic', 'heif',
  // Audio
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'aiff', 'opus', 'mid', 'midi',
  // Video
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'zst', 'lz4', 'tgz', 'tbz2',
  'cab', 'iso', 'dmg', 'img', 'wim', 'swm', 'esd',
  // Executables and compiled artifacts
  'exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'app', 'deb', 'rpm', 'snap', 'flatpak',
  'apk', 'ipa', 'war', 'jar', 'ear', 'class', 'pyc', 'pyo', 'whl',
  'o', 'obj', 'a', 'lib', 'pdb',
  // Databases and binary data
  'db', 'sqlite', 'sqlite3', 's3db', 'sl3', 'sqlitedb', 'mdb', 'accdb',
  // Binary document formats
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  // Binary font formats
  'woff', 'woff2', 'eot', 'ttc',
  // Other binary formats
  'dat', 'bin', 'sav', 'pickle', 'pkl', 'npy', 'npz', 'parquet', 'feather', 'arrow',
  'pb', 'onnx', 'tflite', 'h5', 'hdf5', 'caffemodel',
  'torrent', 'wasm',
  'keystore', 'jks', 'truststore',
]);

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python', pyi: 'python',
  html: 'html', htm: 'html', xhtml: 'html', svg: 'xml', xml: 'xml', vue: 'xml', svelte: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css', stylus: 'css', pcss: 'css', postcss: 'css',
  json: 'json', jsonc: 'json', json5: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ksh: 'bash', csh: 'bash', tcsh: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  yaml: 'yaml', yml: 'yaml',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sql: 'sql', graphql: 'sql', gql: 'sql', prisma: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  r: 'r',
  dart: 'dart',
  zig: 'zig',
  nim: 'nim',
  ex: 'elixir', exs: 'elixir',
  erl: 'erlang', hrl: 'erlang',
  hs: 'haskell', lhs: 'haskell',
  ml: 'ocaml', mli: 'ocaml',
  clj: 'clojure', cljs: 'clojure',
  lisp: 'lisp', el: 'lisp',
  jl: 'julia',
  ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', cnf: 'ini',
  toml: 'ini',
  nginx: 'nginx',
  dockerfile: 'dockerfile',
  diff: 'diff', patch: 'diff',
  tex: 'latex', cls: 'latex', sty: 'latex', bib: 'bibtex', bibtex: 'bibtex',
  bat: 'bat', cmd: 'bat',
  properties: 'properties',
};

const LANGUAGE_OPTIONS: Array<{ value: string; label?: string; labelId?: MessageId }> = [
  { value: 'plaintext', labelId: 'notepad.language.plaintext' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'html', label: 'HTML' },
  { value: 'xml', label: 'XML' },
  { value: 'css', label: 'CSS / SCSS' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'bash', label: 'Shell' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'sql', label: 'SQL' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'java', label: 'Java' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'php', label: 'PHP' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'ini', label: 'INI / TOML' },
  { value: 'nginx', label: 'Nginx' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'diff', label: 'Diff' },
];

const LANGUAGE_OPTION_VALUES = new Set(LANGUAGE_OPTIONS.map((language) => language.value));
type CodeMirrorLanguageLoader = () => Promise<Extension>;

const CODEMIRROR_LANGUAGE_LOADERS: Partial<Record<string, CodeMirrorLanguageLoader>> = {
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  html: async () => (await import('@codemirror/lang-html')).html(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  bash: async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  },
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  ruby: async () => {
    const [{ StreamLanguage }, { ruby }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/ruby'),
    ]);
    return StreamLanguage.define(ruby);
  },
  ini: async () => {
    const [{ StreamLanguage }, { properties }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/properties'),
    ]);
    return StreamLanguage.define(properties);
  },
  nginx: async () => {
    const [{ StreamLanguage }, { nginx }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/nginx'),
    ]);
    return StreamLanguage.define(nginx);
  },
  dockerfile: async () => {
    const [{ StreamLanguage }, { dockerFile }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/dockerfile'),
    ]);
    return StreamLanguage.define(dockerFile);
  },
  diff: async () => {
    const [{ StreamLanguage }, { diff }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/diff'),
    ]);
    return StreamLanguage.define(diff);
  },
};
const MAX_DIFF_INPUT_LINES = 180;
const MAX_DIFF_OUTPUT_LINES = 280;
const MAX_LANGUAGE_DETECTION_CHARACTERS = 24000;
const MAX_INTERACTIVE_LANGUAGE_DETECTION_CHARACTERS = 12000;
const MAX_AI_FILE_CONTEXT_CHARACTERS = 480000;
const MAX_AI_FILE_CONTEXT_CHUNK_CHARACTERS = 60000;
const MAX_AI_SELECTION_CHARACTERS = 6000;
const MAX_AI_ENVIRONMENT_CHARACTERS = 12000;
const MAX_AI_COMMAND_OUTPUT_CHARACTERS = 12000;
const MAX_AI_HISTORY_MESSAGES = 14;
const elevationRequiredPrefix = 'SHELLDESK_ELEVATION_REQUIRED:';
const elevationAuthFailedPrefix = 'SHELLDESK_ELEVATION_AUTH_FAILED:';

function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return name.slice(dotIndex + 1).toLowerCase();
}

function normalizeLanguage(language?: string): string {
  if (language && LANGUAGE_OPTION_VALUES.has(language)) {
    return language;
  }

  return 'plaintext';
}

function getPreferredLightTheme() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: light)').matches;
}

function getFileNameLanguage(fileName: string): string {
  const ext = getFileExtension(fileName);
  if (EXTENSION_LANGUAGE_MAP[ext]) return normalizeLanguage(EXTENSION_LANGUAGE_MAP[ext]);
  if (fileName === 'Makefile' || fileName === 'makefile') return 'plaintext';
  if (fileName === 'Dockerfile') return 'dockerfile';
  if (fileName === '.env') return 'ini';
  if (fileName === '.gitignore' || fileName === '.editorconfig') return 'plaintext';
  if (fileName.startsWith('nginx')) return 'nginx';
  return 'plaintext';
}

function getShebangLanguage(firstLine: string): string {
  if (!firstLine.startsWith('#!')) {
    return 'plaintext';
  }

  if (/\b(ts-node|deno)\b/iu.test(firstLine)) return 'typescript';
  if (/\b(node|bun)\b/iu.test(firstLine)) return 'javascript';
  if (/\bpython\d*\b/iu.test(firstLine)) return 'python';
  if (/\b(bash|sh|zsh|fish|ksh)\b/iu.test(firstLine)) return 'bash';
  if (/\bruby\b/iu.test(firstLine)) return 'ruby';
  if (/\bphp\b/iu.test(firstLine)) return 'php';
  return 'plaintext';
}

function looksLikeJson(content: string): boolean {
  const trimmedContent = content.trim();
  if (!/^[{\[]/u.test(trimmedContent) || !/[\}\]]$/u.test(trimmedContent)) {
    return false;
  }

  try {
    JSON.parse(trimmedContent);
    return true;
  } catch {
    return false;
  }
}

function detectLanguageFromContent(content: string): string {
  const sample = content.slice(0, MAX_LANGUAGE_DETECTION_CHARACTERS);
  const trimmed = sample.trim();

  if (trimmed.length < 3) {
    return 'plaintext';
  }

  const firstLine = trimmed.split(/\r?\n/u, 1)[0] ?? '';
  const shebangLanguage = getShebangLanguage(firstLine);
  if (shebangLanguage !== 'plaintext') return shebangLanguage;
  if (/^(diff --git|@@\s|---\s|\+\+\+\s)/mu.test(trimmed)) return 'diff';
  if (/^<!doctype\s+html\b|<html[\s>]/iu.test(trimmed)) return 'html';
  if (/^<\?xml\b|<svg[\s>]/iu.test(trimmed)) return 'xml';
  if (/^<\?php\b|<\?=/iu.test(trimmed)) return 'php';
  if (looksLikeJson(trimmed)) return 'json';
  if (/^(FROM|RUN|COPY|ADD|ENTRYPOINT|CMD|ARG|ENV|WORKDIR|EXPOSE)\s+/imu.test(trimmed)) return 'dockerfile';
  if (/\b(server|location|upstream)\s+[^{;\n]*\{/iu.test(trimmed)) return 'nginx';
  if (/^#{1,6}\s+\S/mu.test(trimmed) || /```[\s\S]*?```/u.test(trimmed)) return 'markdown';
  if (/^\s*---\s*$/mu.test(trimmed) && /^\s*[\w.-]+:\s+\S/mu.test(trimmed)) return 'yaml';
  if (/^\s*\[[^\]\n]+\]\s*$/mu.test(trimmed) && /^\s*[\w.-]+\s*=\s*.+$/mu.test(trimmed)) return 'ini';
  if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/iu.test(trimmed)) return 'sql';
  if (/\bpackage\s+main\b/iu.test(trimmed) && /\bfunc\s+\w+\s*\(/u.test(trimmed)) return 'go';
  if (/\bfn\s+main\s*\(|\buse\s+std::|\blet\s+mut\b|\bimpl\s+\w+/u.test(trimmed)) return 'rust';
  if (/^\s*(def|class)\s+\w+.*:\s*$/mu.test(trimmed) || /^(from\s+\S+\s+import|import\s+\S+)/mu.test(trimmed)) return 'python';
  if (/\b(interface|type)\s+[A-Z_$]\w*|\b(public|private|readonly)\s+\w+|:\s*(string|number|boolean|unknown|any)\b/u.test(trimmed)) return 'typescript';
  if (/\b(import|export)\s+|\bconst\s+\w+\s*=|\bfunction\s+\w+\s*\(|=>\s*[{(]/u.test(trimmed)) return 'javascript';
  if (/\bpublic\s+(final\s+)?class\s+\w+|\bimport\s+java\.|\bSystem\.out\.println/u.test(trimmed)) return 'java';
  if (/^\s*#include\s+<iostream>/mu.test(trimmed) || /\bstd::\w+|\bcout\s*<</u.test(trimmed)) return 'cpp';
  if (/^\s*#include\s+<[^>]+>/mu.test(trimmed) && /\bint\s+main\s*\(/u.test(trimmed)) return 'c';
  if (/^\s*def\s+\w+.*$/mu.test(trimmed) && /\bend\s*$/mu.test(trimmed)) return 'ruby';
  if (/(^|\n)\s*[@.#a-z][^{\n;]+\{[\s\S]*?:[\s\S]*?\}/iu.test(trimmed)) return 'css';
  if (/^\s*[\w.-]+:\s+\S/mu.test(trimmed) && /^\s*-\s+\S/mu.test(trimmed)) return 'yaml';

  return 'plaintext';
}

function getLanguage(fileName: string, content = ''): string {
  const fileNameLanguage = getFileNameLanguage(fileName);
  if (fileNameLanguage !== 'plaintext') {
    return fileNameLanguage;
  }

  return detectLanguageFromContent(content);
}

function isTextFile(fileName: string): boolean {
  const ext = getFileExtension(fileName);
  if (!ext && !fileName.includes('.')) return true;
  return !BINARY_EXTENSIONS.has(ext);
}

function getFileNameFromPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function getPrivilegeErrorMessage(error: unknown) {
  const message = getErrorMessage(error);

  if (message.startsWith(elevationRequiredPrefix)) {
    return message.slice(elevationRequiredPrefix.length).trim();
  }

  if (message.startsWith(elevationAuthFailedPrefix)) {
    return message.slice(elevationAuthFailedPrefix.length).trim();
  }

  return message;
}

function shouldPromptForSudoPassword(error: unknown) {
  const message = getErrorMessage(error);
  return message.startsWith(elevationRequiredPrefix) || message.startsWith(elevationAuthFailedPrefix);
}

function getRevisionHint(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function notifyRemoteFileSaved(connectionId: string, filePath: string) {
  window.dispatchEvent(new CustomEvent('shelldesk:remote-file-saved', {
    detail: {
      connectionId,
      filePath,
      savedAt: new Date().toISOString(),
    },
  }));
}

function getLineEndingLabel(content: string, language: AppLanguage): string {
  if (content.includes('\r\n')) return 'CRLF';
  if (content.includes('\n')) return 'LF';
  if (content.includes('\r')) return 'CR';
  return t('notepad.lineEnding.none', language);
}

function isLikelyBinaryContent(content: string): boolean {
  return content.includes('\0');
}

function countLogicalLines(content: string): number {
  let count = 1;
  let offset = content.indexOf('\n');

  while (offset >= 0) {
    count += 1;
    offset = content.indexOf('\n', offset + 1);
  }

  return count;
}

function getLineColumnAtPosition(content: string, position: number) {
  const clampedPosition = Math.min(Math.max(position, 0), content.length);
  let line = 1;
  let lineStart = 0;
  let newlineIndex = content.indexOf('\n');

  while (newlineIndex >= 0 && newlineIndex < clampedPosition) {
    line += 1;
    lineStart = newlineIndex + 1;
    newlineIndex = content.indexOf('\n', lineStart);
  }

  return {
    line,
    column: clampedPosition - lineStart + 1,
  };
}

function getLineStartOffset(content: string, targetLine: number) {
  const clampedLine = Math.max(1, Math.trunc(targetLine));

  if (clampedLine <= 1) {
    return 0;
  }

  let currentLine = 1;
  let offset = content.indexOf('\n');

  while (offset >= 0 && currentLine < clampedLine - 1) {
    currentLine += 1;
    offset = content.indexOf('\n', offset + 1);
  }

  return offset >= 0 ? offset + 1 : content.length;
}

function normalizeDiffLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function buildDiffPreview(beforeContent: string, afterContent: string, language: AppLanguage): DiffPreview {
  const beforeLines = normalizeDiffLines(beforeContent);
  const afterLines = normalizeDiffLines(afterContent);
  const beforeSample = beforeLines.slice(0, MAX_DIFF_INPUT_LINES);
  const afterSample = afterLines.slice(0, MAX_DIFF_INPUT_LINES);
  const lcs = Array.from(
    { length: beforeSample.length + 1 },
    () => Array<number>(afterSample.length + 1).fill(0),
  );

  for (let beforeIndex = beforeSample.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterSample.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lcs[beforeIndex][afterIndex] = beforeSample[beforeIndex] === afterSample[afterIndex]
        ? lcs[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(lcs[beforeIndex + 1][afterIndex], lcs[beforeIndex][afterIndex + 1]);
    }
  }

  const lines: DiffPreviewLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeSample.length || afterIndex < afterSample.length) {
    if (
      beforeIndex < beforeSample.length
      && afterIndex < afterSample.length
      && beforeSample[beforeIndex] === afterSample[afterIndex]
    ) {
      lines.push({ kind: 'context', text: beforeSample[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < afterSample.length
      && (
        beforeIndex >= beforeSample.length
        || lcs[beforeIndex][afterIndex + 1] >= lcs[beforeIndex + 1][afterIndex]
      )
    ) {
      lines.push({ kind: 'added', text: afterSample[afterIndex] });
      afterIndex += 1;
    } else {
      lines.push({ kind: 'removed', text: beforeSample[beforeIndex] });
      beforeIndex += 1;
    }

    if (lines.length >= MAX_DIFF_OUTPUT_LINES) break;
  }

  const truncated = (
    beforeLines.length > beforeSample.length
    || afterLines.length > afterSample.length
    || beforeIndex < beforeSample.length
    || afterIndex < afterSample.length
  );

  if (truncated) {
    lines.push({ kind: 'meta', text: t('notepad.diff.preview.truncated', language) });
  }

  if (lines.length === 0) {
    lines.push({ kind: 'meta', text: t('notepad.diff.preview.noChanges', language) });
  }

  return { lines, truncated };
}

function getDiffPrefix(kind: DiffPreviewLine['kind']): string {
  if (kind === 'added') return '+';
  if (kind === 'removed') return '-';
  if (kind === 'meta') return '!';
  return ' ';
}

function createNotepadAiMessageId() {
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncateMiddle(content: string, maxLength: number, language: AppLanguage) {
  if (content.length <= maxLength) {
    return content;
  }

  const headLength = Math.floor(maxLength * 0.58);
  const tailLength = Math.max(0, maxLength - headLength - 80);
  return [
    content.slice(0, headLength),
    '',
    t('notepad.truncate.characters', language, { count: content.length - headLength - tailLength }),
    '',
    content.slice(-tailLength),
  ].join('\n');
}

function limitAiFileContext(content: string, language: AppLanguage) {
  if (content.length <= MAX_AI_FILE_CONTEXT_CHARACTERS) {
    return {
      content,
      truncated: false,
      omittedCharacters: 0,
    };
  }

  const headLength = Math.floor(MAX_AI_FILE_CONTEXT_CHARACTERS * 0.62);
  const tailLength = Math.max(0, MAX_AI_FILE_CONTEXT_CHARACTERS - headLength);
  const omittedCharacters = content.length - headLength - tailLength;

  return {
    content: [
      content.slice(0, headLength),
      '',
      t('notepad.ai.context.limitNotice', language, { count: omittedCharacters }),
      '',
      content.slice(-tailLength),
    ].join('\n'),
    truncated: true,
    omittedCharacters,
  };
}

function splitAiFileContext(content: string) {
  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    let end = Math.min(start + MAX_AI_FILE_CONTEXT_CHUNK_CHARACTERS, content.length);

    if (end < content.length) {
      const newlineIndex = content.lastIndexOf('\n', end);
      const minimumChunkEnd = start + Math.floor(MAX_AI_FILE_CONTEXT_CHUNK_CHARACTERS * 0.72);

      if (newlineIndex >= minimumChunkEnd) {
        end = newlineIndex + 1;
      }
    }

    chunks.push(content.slice(start, end));
    start = end;
  }

  return chunks.length ? chunks : [''];
}

function stripAiActionBlocks(content: string) {
  return content
    .replace(/```shelldesk-action\s*[\s\S]*?```/giu, '')
    .replace(/```shelldesk-action[\s\S]*$/iu, '')
    .trim();
}

function parseAiAction(content: string): NotepadAiAction | undefined {
  const match = /```shelldesk-action\s*([\s\S]*?)```/iu.exec(content);

  if (!match) {
    return undefined;
  }

  try {
    const parsedAction: unknown = JSON.parse(match[1].trim());

    if (!parsedAction || typeof parsedAction !== 'object') {
      return undefined;
    }

    const action = parsedAction as Partial<NotepadAiAction>;

    if (
      (action.type === 'replace_content' ||
        action.type === 'append_content' ||
        action.type === 'insert_at_cursor' ||
        action.type === 'replace_selection') &&
      typeof action.content === 'string'
    ) {
      return {
        type: action.type,
        content: action.content,
        summary: typeof action.summary === 'string' ? action.summary : undefined,
      };
    }

    if (action.type === 'run_command' && typeof action.command === 'string' && action.command.trim()) {
      return {
        type: 'run_command',
        command: action.command.trim(),
        reason: typeof action.reason === 'string' ? action.reason : undefined,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function formatCommandResult(
  command: string,
  result: { stdout: string; stderr: string; code: number },
  language: AppLanguage,
) {
  const stdout = result.stdout
    ? truncateMiddle(result.stdout, MAX_AI_COMMAND_OUTPUT_CHARACTERS, language)
    : t('notepad.command.stdout.empty', language);
  const stderr = result.stderr
    ? `\n\n${t('notepad.command.stderr.label', language)}\n${truncateMiddle(result.stderr, 4000, language)}`
    : '';

  return t('notepad.command.result', language, { command, code: result.code, stdout, stderr });
}

function getEnvironmentProbeCommand(systemType?: RemoteSystemType) {
  if (systemType === 'windows') {
    return [
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy Bypass',
      '-Command',
      '"$ErrorActionPreference=\'SilentlyContinue\';',
      'Write-Output \'# OS\'; Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | Format-List | Out-String;',
      'Write-Output \'# PowerShell\'; $PSVersionTable | Out-String;',
      'Write-Output \'# Runtime\'; foreach ($cmd in \'node\',\'python\',\'python3\',\'dotnet\',\'java\',\'go\',\'rustc\',\'php\') { $found = Get-Command $cmd -ErrorAction SilentlyContinue; if ($found) { Write-Output \"## $cmd\"; & $cmd --version 2>&1 | Select-Object -First 3 } };',
      'Write-Output \'# Paths\'; Get-Location | Out-String"',
    ].join(' ');
  }

  return `sh -lc 'printf "# OS\\n"; (cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || uname -a); printf "\\n# Kernel\\n"; uname -a 2>/dev/null; printf "\\n# Shell\\n"; printf "%s\\n" "$SHELL"; printf "\\n# Runtime\\n"; for cmd in node npm pnpm yarn python python3 pip pip3 ruby go rustc cargo java javac php composer docker docker-compose nginx apache2 httpd mysql psql sqlite3; do if command -v "$cmd" >/dev/null 2>&1; then printf "## %s\\n" "$cmd"; "$cmd" --version 2>&1 | head -n 3; fi; done; printf "\\n# Working directory\\n"; pwd'`;
}

let tabSequence = 0;

function createNewTab(language: AppLanguage, initialTitle?: string, initialContent = ''): NotepadTab {
  tabSequence += 1;
  const title = initialTitle?.trim() || t('notepad.tab.untitled', language, { index: tabSequence });
  return {
    id: `new-${tabSequence}`,
    title,
    content: initialContent,
    originalContent: '',
    dirty: initialContent.length > 0,
    readOnly: false,
    language: getLanguage(title, initialContent),
    languageManuallySet: false,
    isLoading: false,
    isSaving: false,
    error: '',
  };
}

function NotepadDiffPreview({ preview, language }: { preview: DiffPreview; language: AppLanguage }) {
  return (
    <div className="notepad-diff-preview" aria-label={t('notepad.diff.preview.aria', language)}>
      {preview.lines.map((line, index) => (
        <div key={`${line.kind}-${index}`} className={`notepad-diff-line ${line.kind}`}>
          <span className="notepad-diff-prefix">{getDiffPrefix(line.kind)}</span>
          <span className="notepad-diff-text">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function RemoteNotepad({ connectionId, settings, initialFilePath, initialContent, initialTitle, openFileRequest, systemType }: RemoteNotepadProps) {
  const language = settings.language;
  const [tabs, setTabs] = useState<NotepadTab[]>(() => [createNewTab(language, initialTitle, initialContent)]);
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);
  const [showGoToLine, setShowGoToLine] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState('');
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [wrapEnabled, setWrapEnabled] = useState(false);
  const [pendingCloseTab, setPendingCloseTab] = useState<{ id: string; title: string } | null>(null);
  const [conflictDialog, setConflictDialog] = useState<NotepadConflictDialog | null>(null);
  const [diffDialog, setDiffDialog] = useState<NotepadDiffDialog | null>(null);
  const [isAiSidebarOpen, setIsAiSidebarOpen] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [aiMessages, setAiMessages] = useState<NotepadAiMessage[]>([]);
  const [isAiBusy, setIsAiBusy] = useState(false);
  const [isAiProbing, setIsAiProbing] = useState(false);
  const [aiError, setAiError] = useState('');
  const [remoteEnvironment, setRemoteEnvironment] = useState('');
  const [includeAiFileContext, setIncludeAiFileContext] = useState(true);
  const [lastAiSelection, setLastAiSelection] = useState<EditorSelectionSnapshot | null>(null);
  const [codeMirrorLanguageExtensions, setCodeMirrorLanguageExtensions] = useState<Extension[]>([]);
  const [prefersLightTheme, setPrefersLightTheme] = useState(() => getPreferredLightTheme());
  const [sudoPrompt, setSudoPrompt] = useState<NotepadSudoPrompt | null>(null);

  const [filePickerVisible, setFilePickerVisible] = useState(false);
  const [filePickerMode, setFilePickerMode] = useState<'open' | 'save'>('open');
  const [filePickerTitle, setFilePickerTitle] = useState('');
  const [filePickerOnConfirm, setFilePickerOnConfirm] = useState<((path: string) => void) | null>(null);

  const codeMirrorRef = useRef<ReactCodeMirrorRef>(null);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);
  const aiMessagesEndRef = useRef<HTMLDivElement>(null);
  const sudoPasswordInputRef = useRef<HTMLInputElement>(null);
  const sudoPromptResolverRef = useRef<((password: string | null) => void) | null>(null);
  const initialFileHandledRef = useRef(false);
  const lastOpenFileRequestIdRef = useRef('');
  const tabsRef = useRef(tabs);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => () => {
    sudoPromptResolverRef.current?.(null);
    sudoPromptResolverRef.current = null;
  }, []);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0], [tabs, activeTabId]);
  const isAiConfigured = Boolean(
    settings.aiApiBaseUrl.trim() &&
    (settings.aiApiFormat !== 'anthropic' || settings.aiApiKey.trim()) &&
    settings.aiModel.trim() &&
    (window.guiSSH?.ai?.chatStream || window.guiSSH?.ai?.chat),
  );

  const updateTab = useCallback((tabId: string, update: (tab: NotepadTab) => NotepadTab) => {
    setTabs((currentTabs) => currentTabs.map((tab) => tab.id === tabId ? update(tab) : tab));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleThemeChange = () => setPrefersLightTheme(mediaQuery.matches);
    handleThemeChange();
    mediaQuery.addEventListener('change', handleThemeChange);

    return () => mediaQuery.removeEventListener('change', handleThemeChange);
  }, []);

  useEffect(() => {
    const normalizedLanguage = normalizeLanguage(activeTab.language);
    const languageLoader = CODEMIRROR_LANGUAGE_LOADERS[normalizedLanguage];
    let cancelled = false;

    if (!languageLoader) {
      setCodeMirrorLanguageExtensions([]);
      return undefined;
    }

    languageLoader()
      .then((extension) => {
        if (!cancelled) {
          setCodeMirrorLanguageExtensions([extension]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCodeMirrorLanguageExtensions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab.language]);

  useEffect(() => {
    if (sudoPrompt) {
      sudoPasswordInputRef.current?.focus();
    }
  }, [sudoPrompt?.filePath, sudoPrompt?.operation]);

  const requestSudoPassword = useCallback((
    operation: NotepadSudoOperation,
    filePath: string,
    error: string,
  ) => new Promise<string | null>((resolve) => {
    sudoPromptResolverRef.current?.(null);
    sudoPromptResolverRef.current = resolve;
    setSudoPrompt({
      operation,
      filePath,
      error,
      password: '',
    });
  }), []);

  const resolveSudoPrompt = useCallback((password: string | null) => {
    sudoPromptResolverRef.current?.(password);
    sudoPromptResolverRef.current = null;
    setSudoPrompt(null);
  }, []);

  const readRemoteTextFile = useCallback(async (filePath: string, operation: NotepadSudoOperation = 'read') => {
    try {
      return await window.guiSSH!.connections.readFile(connectionId, filePath);
    } catch (error) {
      if (systemType === 'windows' || !shouldPromptForSudoPassword(error)) {
        throw error;
      }

      let lastError = getPrivilegeErrorMessage(error);
      const cachedOptions = getCachedSudoOptions(connectionId);

      if (cachedOptions) {
        try {
          return await window.guiSSH!.connections.readFile(connectionId, filePath, cachedOptions);
        } catch (cachedError) {
          if (!shouldPromptForSudoPassword(cachedError)) {
            throw cachedError;
          }

          clearCachedSudoPassword(connectionId);
          lastError = getPrivilegeErrorMessage(cachedError);
        }
      }

      for (;;) {
        const sudoPassword = await requestSudoPassword(operation, filePath, lastError);

        if (sudoPassword === null) {
          throw new Error(lastError);
        }

        try {
          const content = await window.guiSSH!.connections.readFile(connectionId, filePath, { sudoPassword });
          setCachedSudoPassword(connectionId, sudoPassword);
          return content;
        } catch (retryError) {
          if (!shouldPromptForSudoPassword(retryError)) {
            throw retryError;
          }

          clearCachedSudoPassword(connectionId);
          lastError = getPrivilegeErrorMessage(retryError);
        }
      }
    }
  }, [connectionId, requestSudoPassword, systemType]);

  const writeRemoteTextFile = useCallback(async (
    filePath: string,
    content: string,
  ) => {
    try {
      await window.guiSSH!.connections.writeFile(connectionId, filePath, content);
      return;
    } catch (error) {
      if (systemType === 'windows' || !shouldPromptForSudoPassword(error)) {
        throw error;
      }

      let lastError = getPrivilegeErrorMessage(error);
      const cachedOptions = getCachedSudoOptions(connectionId);

      if (cachedOptions) {
        try {
          await window.guiSSH!.connections.writeFile(connectionId, filePath, content, cachedOptions);
          return;
        } catch (cachedError) {
          if (!shouldPromptForSudoPassword(cachedError)) {
            throw cachedError;
          }

          clearCachedSudoPassword(connectionId);
          lastError = getPrivilegeErrorMessage(cachedError);
        }
      }

      for (;;) {
        const sudoPassword = await requestSudoPassword('save', filePath, lastError);

        if (sudoPassword === null) {
          throw new Error(lastError);
        }

        try {
          await window.guiSSH!.connections.writeFile(connectionId, filePath, content, { sudoPassword });
          setCachedSudoPassword(connectionId, sudoPassword);
          return;
        } catch (retryError) {
          if (!shouldPromptForSudoPassword(retryError)) {
            throw retryError;
          }

          clearCachedSudoPassword(connectionId);
          lastError = getPrivilegeErrorMessage(retryError);
        }
      }
    }
  }, [connectionId, requestSudoPassword, systemType]);

  useEffect(() => {
    if (isAiSidebarOpen) {
      aiMessagesEndRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [aiMessages, isAiBusy, isAiSidebarOpen]);

  const closeTabNow = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current;
    const closingIndex = currentTabs.findIndex((tab) => tab.id === tabId);
    if (closingIndex < 0) return;

    const remainingTabs = currentTabs.filter((tab) => tab.id !== tabId);
    if (remainingTabs.length === 0) {
      const freshTab = createNewTab(language);
      tabsRef.current = [freshTab];
      setTabs([freshTab]);
      setActiveTabId(freshTab.id);
      return;
    }

    tabsRef.current = remainingTabs;
    setTabs(remainingTabs);
    setActiveTabId((currentActiveTabId) => {
      if (currentActiveTabId !== tabId) return currentActiveTabId;
      return remainingTabs[Math.min(closingIndex, remainingTabs.length - 1)].id;
    });
  }, [language]);

  const openFile = useCallback(async (filePath: string) => {
    const nextFilePath = filePath.trim();
    if (!nextFilePath) return;

    const nextTitle = getFileNameFromPath(nextFilePath);
    if (!isTextFile(nextTitle)) {
      updateTab(activeTabId, (tab) => ({
        ...tab,
        error: t('notepad.error.binaryType', language, { title: nextTitle }),
      }));
      return;
    }

    const existingTab = tabsRef.current.find((tab) => tab.filePath === nextFilePath);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    const newTab: NotepadTab = {
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath: nextFilePath,
      title: nextTitle,
      content: '',
      originalContent: '',
      dirty: false,
      readOnly: false,
      language: getLanguage(nextTitle),
      languageManuallySet: false,
      isLoading: true,
      isSaving: false,
      error: '',
    };

    setTabs((currentTabs) => [...currentTabs, newTab]);
    setActiveTabId(newTab.id);

    try {
      const content = await readRemoteTextFile(nextFilePath, 'read');
      if (isLikelyBinaryContent(content)) {
        updateTab(newTab.id, (tab) => ({
          ...tab,
          content: '',
          originalContent: '',
          readOnly: true,
          isLoading: false,
          error: t('notepad.error.binaryContent', language),
        }));
        return;
      }

      updateTab(newTab.id, (tab) => ({
        ...tab,
        content,
        originalContent: content,
        dirty: false,
        revisionHint: getRevisionHint(content),
        language: tab.languageManuallySet ? tab.language : getLanguage(nextTitle, content),
        isLoading: false,
        error: '',
      }));
    } catch (error) {
      updateTab(newTab.id, (tab) => ({
        ...tab,
        isLoading: false,
        error: getErrorMessage(error),
      }));
    }
  }, [activeTabId, language, readRemoteTextFile, updateTab]);

  useEffect(() => {
    if (initialFilePath && !initialFileHandledRef.current) {
      initialFileHandledRef.current = true;
      void openFile(initialFilePath);
    }
  }, [initialFilePath, openFile]);

  useEffect(() => {
    if (!openFileRequest || openFileRequest.id === lastOpenFileRequestIdRef.current) {
      return;
    }

    lastOpenFileRequestIdRef.current = openFileRequest.id;
    void openFile(openFileRequest.filePath);
  }, [openFile, openFileRequest]);

  const activeContent = activeTab.content;
  const lineCount = useMemo(() => countLogicalLines(activeContent), [activeContent]);
  const effectiveWrapEnabled = wrapEnabled;
  const codeMirrorTheme = settings.theme === 'system' ? (prefersLightTheme ? 'light' : 'dark') : settings.theme;
  const lineEndingLabel = useMemo(() => getLineEndingLabel(activeContent, language), [activeContent, language]);
  const codeMirrorExtensions = useMemo<Extension[]>(() => [
    keymap.of([indentWithTab]),
    ...codeMirrorLanguageExtensions,
    ...(effectiveWrapEnabled ? [EditorView.lineWrapping] : []),
    EditorView.theme({
      '&': {
        height: '100%',
        minHeight: '0',
        backgroundColor: 'var(--surface)',
        color: 'var(--text)',
        fontSize: '13px',
      },
      '.cm-scroller': {
        backgroundColor: 'var(--surface)',
        fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
        lineHeight: '20px',
      },
      '.cm-content': {
        padding: '8px 0',
        caretColor: 'var(--text)',
      },
      '.cm-line': {
        padding: '0 12px',
      },
      '.cm-gutters': {
        borderRight: '1px solid var(--border)',
        backgroundColor: 'var(--surface-soft)',
        color: 'var(--muted)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--accent)',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(67, 199, 255, 0.25)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-panels': {
        borderColor: 'var(--border)',
        backgroundColor: 'var(--surface-panel)',
        color: 'var(--text)',
      },
      '.cm-panel input': {
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '4px 7px',
        backgroundColor: 'var(--surface-input)',
        color: 'var(--text)',
      },
      '.cm-panel button': {
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '4px 8px',
        backgroundColor: 'var(--surface-control)',
        color: 'var(--muted-strong)',
      },
      '.cm-panel button:hover': {
        borderColor: 'var(--border-strong)',
        backgroundColor: 'var(--surface-hover)',
        color: 'var(--text)',
      },
    }, {
      dark: codeMirrorTheme === 'dark',
    }),
  ], [codeMirrorLanguageExtensions, codeMirrorTheme, effectiveWrapEnabled]);

  const saveTabToPath = useCallback(async (tabId: string, filePath: string, options: SaveOptions = {}) => {
    const tabToSave = tabsRef.current.find((tab) => tab.id === tabId);
    const nextFilePath = filePath.trim();
    if (!tabToSave || !nextFilePath) return false;

    if (tabToSave.readOnly) {
      updateTab(tabId, (tab) => ({ ...tab, error: t('notepad.error.readOnlySave', language) }));
      return false;
    }

    if (!tabToSave.dirty && tabToSave.filePath === nextFilePath && !options.force) {
      if (options.closeAfterSave) closeTabNow(tabId);
      return true;
    }

    const contentToSave = tabToSave.content;
    updateTab(tabId, (tab) => ({ ...tab, isSaving: true, error: '' }));

    if (
      !options.force
      && tabToSave.filePath
      && tabToSave.filePath === nextFilePath
      && tabToSave.revisionHint
    ) {
      try {
        const remoteContent = await readRemoteTextFile(nextFilePath, 'save');
        const remoteRevisionHint = getRevisionHint(remoteContent);
        if (remoteRevisionHint !== tabToSave.revisionHint) {
          updateTab(tabId, (tab) => ({ ...tab, isSaving: false }));
          setConflictDialog({
            tabId,
            title: tabToSave.title,
            filePath: nextFilePath,
            remoteContent,
            remoteRevisionHint,
            closeAfterSave: Boolean(options.closeAfterSave),
          });
          return false;
        }
      } catch (error) {
        updateTab(tabId, (tab) => ({ ...tab, isSaving: false }));
        setConflictDialog({
          tabId,
          title: tabToSave.title,
          filePath: nextFilePath,
          readError: getErrorMessage(error),
          closeAfterSave: Boolean(options.closeAfterSave),
        });
        return false;
      }
    }

    try {
      await writeRemoteTextFile(nextFilePath, contentToSave);
      notifyRemoteFileSaved(connectionId, nextFilePath);
      const nextTitle = getFileNameFromPath(nextFilePath);
      const latestTab = tabsRef.current.find((tab) => tab.id === tabId);
      const receivedMoreEdits = latestTab?.content !== contentToSave;

      updateTab(tabId, (tab) => ({
        ...tab,
        filePath: nextFilePath,
        title: nextTitle,
        originalContent: contentToSave,
        dirty: tab.content !== contentToSave,
        revisionHint: getRevisionHint(contentToSave),
        language: tab.languageManuallySet || tab.filePath === nextFilePath
          ? tab.language
          : getLanguage(nextTitle, contentToSave),
        isSaving: false,
        error: receivedMoreEdits ? t('notepad.error.saveNewEdits', language) : '',
      }));
      if (options.closeAfterSave && !receivedMoreEdits) {
        closeTabNow(tabId);
      }
      return true;
    } catch (error) {
      updateTab(tabId, (tab) => ({
        ...tab,
        isSaving: false,
        error: t('notepad.error.saveFailed', language, { error: getErrorMessage(error) }),
      }));
      return false;
    }
  }, [closeTabNow, language, readRemoteTextFile, updateTab, writeRemoteTextFile]);

  const openSavePicker = useCallback((tabId: string, title: string, closeAfterSave = false) => {
    setFilePickerMode('save');
    setFilePickerTitle(title);
    setFilePickerOnConfirm(() => (filePath: string) => {
      void saveTabToPath(tabId, filePath, { closeAfterSave });
    });
    setFilePickerVisible(true);
  }, [saveTabToPath]);

  const saveTab = useCallback(async (tabId: string, options: SaveOptions = {}) => {
    const tabToSave = tabsRef.current.find((tab) => tab.id === tabId);
    if (!tabToSave) return false;

    if (!tabToSave.filePath) {
      openSavePicker(tabId, t('notepad.picker.saveFile', language), Boolean(options.closeAfterSave));
      return false;
    }

    return await saveTabToPath(tabId, tabToSave.filePath, options);
  }, [language, openSavePicker, saveTabToPath]);

  const openFilePicker = useCallback(() => {
    setFilePickerMode('open');
    setFilePickerTitle(t('notepad.picker.openFile', language));
    setFilePickerOnConfirm(() => (filePath: string) => {
      if (filePath) void openFile(filePath);
    });
    setFilePickerVisible(true);
  }, [language, openFile]);

  const handleNewFile = useCallback(() => {
    const newTab = createNewTab(language);
    setTabs((currentTabs) => [...currentTabs, newTab]);
    setActiveTabId(newTab.id);
  }, [language]);

  const handleCloseTab = useCallback((tabId: string) => {
    const tabToClose = tabsRef.current.find((tab) => tab.id === tabId);
    if (!tabToClose) return;

    if (tabToClose.dirty) {
      setPendingCloseTab({ id: tabToClose.id, title: tabToClose.title });
      return;
    }

    closeTabNow(tabId);
  }, [closeTabNow]);

  const updateCursorPosition = useCallback((view = codeMirrorRef.current?.view) => {
    if (!view) return;

    const position = view.state.selection.main.head;
    const line = view.state.doc.lineAt(position);
    setCursorLine(line.number);
    setCursorCol(position - line.from + 1);
  }, []);

  const handleEditorChange = useCallback((nextContent: string) => {
    updateTab(activeTabId, (tab) => tab.readOnly ? tab : {
      ...tab,
      content: nextContent,
      dirty: nextContent !== tab.originalContent,
      language: !tab.languageManuallySet && tab.language === 'plaintext' && nextContent.length <= MAX_INTERACTIVE_LANGUAGE_DETECTION_CHARACTERS
        ? getLanguage(tab.title, nextContent)
        : tab.language,
    });
  }, [activeTabId, updateTab]);

  const selectEditorRange = useCallback((start: number, end: number) => {
    const view = codeMirrorRef.current?.view;
    if (!view) return;

    const docLength = view.state.doc.length;
    const selectionStart = Math.max(0, Math.min(start, docLength));
    const selectionEnd = Math.max(0, Math.min(end, docLength));
    view.focus();
    view.dispatch({
      selection: EditorSelection.range(selectionStart, selectionEnd),
      scrollIntoView: true,
    });
    updateCursorPosition(view);
  }, [updateCursorPosition]);

  const replaceActiveContent = useCallback((nextContent: string, nextSelectionStart: number, nextSelectionEnd: number) => {
    updateTab(activeTabId, (tab) => tab.readOnly ? tab : {
      ...tab,
      content: nextContent,
      dirty: nextContent !== tab.originalContent,
      language: !tab.languageManuallySet && tab.language === 'plaintext' && nextContent.length <= MAX_INTERACTIVE_LANGUAGE_DETECTION_CHARACTERS
        ? getLanguage(tab.title, nextContent)
        : tab.language,
    });

    requestAnimationFrame(() => selectEditorRange(nextSelectionStart, nextSelectionEnd));
  }, [activeTabId, selectEditorRange, updateTab]);

  const getCurrentEditorSelection = useCallback((): EditorSelectionSnapshot => {
    const view = codeMirrorRef.current?.view;

    if (!view) {
      return { start: 0, end: 0, text: '' };
    }

    const selection = view.state.selection.main;
    const start = selection.from;
    const end = selection.to;
    return {
      start,
      end,
      text: view.state.doc.sliceString(start, end),
    };
  }, []);

  const buildAiContextMessage = useCallback((
    selection: EditorSelectionSnapshot,
    options?: { environmentOverride?: string },
  ) => {
    const filePath = activeTab.filePath || t('notepad.ai.context.unsavedFile', language);
    const selectedText = selection.text
      ? truncateMiddle(selection.text, MAX_AI_SELECTION_CHARACTERS, language)
      : t('notepad.ai.context.noSelection', language);
    const environmentSource = options?.environmentOverride ?? remoteEnvironment;
    const environmentContext = environmentSource
      ? truncateMiddle(environmentSource, MAX_AI_ENVIRONMENT_CHARACTERS, language)
      : t('notepad.ai.context.notProbed', language);
    let fileContextState = t('notepad.ai.context.fileContextCancelled', language);

    if (includeAiFileContext) {
      const fileContext = limitAiFileContext(activeTab.content, language);
      const chunkCount = splitAiFileContext(fileContext.content).length;
      fileContextState = fileContext.truncated
        ? t('notepad.ai.context.fileContextTruncated', language, {
            limit: MAX_AI_FILE_CONTEXT_CHARACTERS,
            chunks: chunkCount,
            omitted: fileContext.omittedCharacters,
          })
        : t('notepad.ai.context.fileContextComplete', language, { chunks: chunkCount });
    }

    return [
      t('notepad.ai.context.header', language),
      t('notepad.ai.context.fileTitle', language, { title: activeTab.title }),
      t('notepad.ai.context.remotePath', language, { path: filePath }),
      t('notepad.ai.context.languageMode', language, { language: activeTab.language }),
      t('notepad.ai.context.fileCharacters', language, { count: activeTab.content.length }),
      t('notepad.ai.context.readOnlyStatus', language, {
        status: activeTab.readOnly
          ? t('notepad.ai.context.readOnly', language)
          : t('notepad.ai.context.editable', language),
      }),
      t('notepad.ai.context.cursor', language, { line: cursorLine, column: cursorCol }),
      t('notepad.ai.context.selectionRange', language, { start: selection.start, end: selection.end }),
      '',
      t('notepad.ai.context.selectedTextHeader', language),
      selectedText,
      '',
      t('notepad.ai.context.environmentHeader', language),
      environmentContext,
      '',
      t('notepad.ai.context.fileContextHeader', language),
      fileContextState,
    ].join('\n');
  }, [activeTab.content, activeTab.filePath, activeTab.language, activeTab.readOnly, activeTab.title, cursorCol, cursorLine, includeAiFileContext, language, remoteEnvironment]);

  const buildAiFileContextMessages = useCallback((): ShellDeskAiChatMessage[] => {
    if (!includeAiFileContext) {
      return [];
    }

    const { content, truncated, omittedCharacters } = limitAiFileContext(activeTab.content, language);
    const chunks = splitAiFileContext(content);
    const filePath = activeTab.filePath || t('notepad.ai.context.unsavedFile', language);

    return chunks.map((chunk, index) => ({
      role: 'user',
      content: [
        t('notepad.ai.context.chunkHeader', language, { index: index + 1, total: chunks.length }),
        t('notepad.ai.context.fileTitle', language, { title: activeTab.title }),
        t('notepad.ai.context.remotePath', language, { path: filePath }),
        t('notepad.ai.context.languageMode', language, { language: activeTab.language }),
        t('notepad.ai.context.fullCharacters', language, { count: activeTab.content.length }),
        truncated
          ? t('notepad.ai.context.truncationTruncated', language, { limit: MAX_AI_FILE_CONTEXT_CHARACTERS, omitted: omittedCharacters })
          : t('notepad.ai.context.truncationNone', language),
        '```',
        chunk,
        '```',
      ].join('\n'),
    }));
  }, [activeTab.content, activeTab.filePath, activeTab.language, activeTab.title, includeAiFileContext, language]);

  const createAiChatMessages = useCallback((
    nextMessages: NotepadAiMessage[],
    selection: EditorSelectionSnapshot,
    options?: { environmentOverride?: string },
  ): ShellDeskAiChatMessage[] => {
    const recentMessages = nextMessages.slice(-MAX_AI_HISTORY_MESSAGES).map<ShellDeskAiChatMessage>((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.role === 'tool'
        ? `${t('ai.tool.resultPrefix', language)}\n${message.content}`
        : message.content,
    }));
    const fileContextMessages = buildAiFileContextMessages().map((message) => ({
      ...message,
      content: translateStructuredText(message.content, settings.language),
    }));

    return [
      { role: 'system', content: t('ai.notepad.systemPrompt', language) },
      { role: 'user', content: translateStructuredText(buildAiContextMessage(selection, options), language) },
      ...fileContextMessages,
      ...recentMessages,
    ];
  }, [buildAiContextMessage, buildAiFileContextMessages, language]);

  const runRemoteEnvironmentProbe = useCallback(async () => {
    const command = getEnvironmentProbeCommand(systemType);
    const result = await window.guiSSH!.connections.runCommand(connectionId, command);
    return formatCommandResult(command, result, language);
  }, [connectionId, language, systemType]);

  const requestAiAssistant = useCallback(async (
    nextMessages: NotepadAiMessage[],
    selection: EditorSelectionSnapshot,
    options?: { environmentOverride?: string },
  ) => {
    const aiControls = window.guiSSH?.ai;
    const chat = aiControls?.chat;
    const chatStream = aiControls?.chatStream;

    if (!chat && !chatStream) {
      setAiError(t('notepad.error.noAiChat', language));
      return;
    }

    if (
      !settings.aiApiBaseUrl.trim() ||
      (settings.aiApiFormat === 'anthropic' && !settings.aiApiKey.trim()) ||
      !settings.aiModel.trim()
    ) {
      setAiError(t('notepad.error.aiConfigRequired', language));
      return;
    }

    setIsAiBusy(true);
    setAiError('');

    try {
      const chatRequest: ShellDeskAiChatRequest = {
        provider: settings.aiProvider,
        apiFormat: settings.aiApiFormat,
        apiBaseUrl: settings.aiApiBaseUrl,
        apiKey: settings.aiApiKey,
        model: settings.aiModel,
        temperature: 0.2,
        messages: createAiChatMessages(nextMessages, selection, options),
      };
      const assistantMessageId = createNotepadAiMessageId();
      const assistantCreatedAt = new Date().toISOString();
      let streamedContent = '';
      let resultContent = '';

      if (chatStream) {
        try {
          const result = await chatStream(chatRequest, {
            onChunk: (chunk) => {
              streamedContent += chunk;
              const partialContent = stripAiActionBlocks(streamedContent) || t('notepad.ai.generating', language);
              const partialMessage: NotepadAiMessage = {
                id: assistantMessageId,
                role: 'assistant',
                content: partialContent,
                createdAt: assistantCreatedAt,
              };

              setAiMessages((currentMessages) => {
                const existingIndex = currentMessages.findIndex((message) => message.id === assistantMessageId);

                if (existingIndex >= 0) {
                  return currentMessages.map((message) => (
                    message.id === assistantMessageId ? { ...message, content: partialContent } : message
                  ));
                }

                return [...currentMessages, partialMessage];
              });
            },
          });

          resultContent = result.content || streamedContent;
        } catch (streamError) {
          if (streamedContent || !chat) {
            throw streamError;
          }

          const result = await chat(chatRequest);
          resultContent = result.content;
        }
      } else if (chat) {
        const result = await chat(chatRequest);
        resultContent = result.content;
      }

      const action = parseAiAction(resultContent);
      const displayContent = stripAiActionBlocks(resultContent) || (action ? t('notepad.ai.actionReady', language) : resultContent);
      const assistantMessage: NotepadAiMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: displayContent,
        createdAt: assistantCreatedAt,
        action,
      };

      setAiMessages([...nextMessages, assistantMessage]);
    } catch (error) {
      setAiError(t('notepad.error.aiRequestFailed', language, { error: getErrorMessage(error) }));
      setAiMessages(nextMessages);
    } finally {
      setIsAiBusy(false);
    }
  }, [
    createAiChatMessages,
    language,
    settings.aiApiBaseUrl,
    settings.aiApiFormat,
    settings.aiApiKey,
    settings.aiModel,
    settings.aiProvider,
  ]);

  const handleAiSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const prompt = aiInput.trim();
    if (!prompt || isAiBusy || isAiProbing) {
      return;
    }

    if (!isAiConfigured) {
      setAiError(t('notepad.error.aiConfigRequired', language));
      return;
    }

    const selection = getCurrentEditorSelection();
    setLastAiSelection(selection);
    const userMessage: NotepadAiMessage = {
      id: createNotepadAiMessageId(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    let nextMessages = [...aiMessages, userMessage];
    let environmentOverride = remoteEnvironment || undefined;

    setAiInput('');
    setAiMessages(nextMessages);

    if (!environmentOverride) {
      setIsAiProbing(true);
      setAiError('');

      try {
        const toolContent = await runRemoteEnvironmentProbe();
        const toolMessage: NotepadAiMessage = {
          id: createNotepadAiMessageId(),
          role: 'tool',
          content: t('notepad.ai.probe.success', language, { content: toolContent }),
          createdAt: new Date().toISOString(),
        };

        environmentOverride = toolContent;
        nextMessages = [...nextMessages, toolMessage];
        setRemoteEnvironment(toolContent);
        setAiMessages(nextMessages);
      } catch (error) {
        const errorMessage = t('notepad.ai.probe.failed', language, { error: getErrorMessage(error) });
        const toolMessage: NotepadAiMessage = {
          id: createNotepadAiMessageId(),
          role: 'tool',
          content: errorMessage,
          createdAt: new Date().toISOString(),
        };

        environmentOverride = errorMessage;
        nextMessages = [...nextMessages, toolMessage];
        setAiError(errorMessage);
        setAiMessages(nextMessages);
      } finally {
        setIsAiProbing(false);
      }
    }

    await requestAiAssistant(nextMessages, selection, { environmentOverride });
  }, [
    aiInput,
    aiMessages,
    getCurrentEditorSelection,
    isAiBusy,
    isAiConfigured,
    isAiProbing,
    language,
    remoteEnvironment,
    requestAiAssistant,
    runRemoteEnvironmentProbe,
  ]);

  const markAiActionApplied = useCallback((messageId: string) => {
    setAiMessages((currentMessages) => currentMessages.map((message) => (
      message.id === messageId ? { ...message, actionApplied: true } : message
    )));
  }, []);

  const applyAiTextAction = useCallback((message: NotepadAiMessage) => {
    const action = message.action;

    if (!action || action.type === 'run_command') {
      return;
    }

    if (activeTab.readOnly) {
      setAiError(t('notepad.error.aiReadOnlyApply', language));
      return;
    }

    const selection = lastAiSelection ?? getCurrentEditorSelection();
    let nextContent = activeTab.content;
    let nextPosition = 0;

    if (action.type === 'replace_content') {
      nextContent = action.content;
      nextPosition = action.content.length;
    } else if (action.type === 'append_content') {
      const separator = nextContent && !nextContent.endsWith('\n') ? '\n' : '';
      nextContent = `${nextContent}${separator}${action.content}`;
      nextPosition = nextContent.length;
    } else if (action.type === 'replace_selection') {
      nextContent = `${nextContent.slice(0, selection.start)}${action.content}${nextContent.slice(selection.end)}`;
      nextPosition = selection.start + action.content.length;
    } else {
      nextContent = `${nextContent.slice(0, selection.start)}${action.content}${nextContent.slice(selection.start)}`;
      nextPosition = selection.start + action.content.length;
    }

    replaceActiveContent(nextContent, nextPosition, nextPosition);
    markAiActionApplied(message.id);
  }, [activeTab.content, activeTab.readOnly, getCurrentEditorSelection, language, lastAiSelection, markAiActionApplied, replaceActiveContent]);

  const runAiCommandAction = useCallback(async (message: NotepadAiMessage) => {
    const action = message.action;

    if (!action || action.type !== 'run_command' || isAiBusy) {
      return;
    }

    setIsAiBusy(true);
    setAiError('');

    try {
      const result = await window.guiSSH!.connections.runCommand(connectionId, action.command);
      const toolContent = formatCommandResult(action.command, result, language);
      const toolMessage: NotepadAiMessage = {
        id: createNotepadAiMessageId(),
        role: 'tool',
        content: toolContent,
        createdAt: new Date().toISOString(),
      };
      const selection = getCurrentEditorSelection();
      const nextMessages = aiMessages.map((currentMessage) => (
        currentMessage.id === message.id ? { ...currentMessage, actionApplied: true } : currentMessage
      ));
      const continuedMessages = [...nextMessages, toolMessage];

      setLastAiSelection(selection);
      setRemoteEnvironment((currentEnvironment) => (
        currentEnvironment ? `${currentEnvironment}\n\n${toolContent}` : toolContent
      ));
      setAiMessages(continuedMessages);
      await requestAiAssistant(continuedMessages, selection);
    } catch (error) {
      setAiError(t('notepad.error.commandFailed', language, { error: getErrorMessage(error) }));
    } finally {
      setIsAiBusy(false);
    }
  }, [aiMessages, connectionId, getCurrentEditorSelection, isAiBusy, language, requestAiAssistant]);

  const handleGoToLine = useCallback(() => {
    const lineNumber = parseInt(goToLineValue, 10);
    if (Number.isNaN(lineNumber) || lineNumber < 1) {
      setShowGoToLine(false);
      return;
    }

    const targetLine = Math.min(lineNumber, lineCount);
    const position = getLineStartOffset(activeTab.content, targetLine);

    selectEditorRange(position, position);
    setShowGoToLine(false);
    setGoToLineValue('');
  }, [activeTab.content, goToLineValue, lineCount, selectEditorRange]);

  const openFindBar = useCallback(() => {
    const view = codeMirrorRef.current?.view;
    if (!view) return;

    view.focus();
    openSearchPanel(view);
  }, []);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent) => {
    const isMod = event.ctrlKey || event.metaKey;

    if (isMod && event.key === 's') {
      event.preventDefault();
      if (event.shiftKey) {
        openSavePicker(activeTabId, t('notepad.picker.saveAs', language));
      } else {
        void saveTab(activeTabId);
      }
      return;
    }

    if (isMod && event.key === 'n') {
      event.preventDefault();
      handleNewFile();
      return;
    }

    if (isMod && event.key === 'o') {
      event.preventDefault();
      openFilePicker();
      return;
    }

    if (isMod && event.key === 'g') {
      event.preventDefault();
      setShowGoToLine(true);
      setTimeout(() => goToLineInputRef.current?.focus(), 0);
      return;
    }

    if (isMod && event.key === 'f') {
      event.preventDefault();
      openFindBar();
      return;
    }

    if (event.key === 'Escape') {
      setShowGoToLine(false);
    }
  }, [
    activeTabId,
    handleNewFile,
    language,
    openFilePicker,
    openFindBar,
    openSavePicker,
    saveTab,
  ]);

  const diffPreview = useMemo(() => diffDialog
    ? buildDiffPreview(diffDialog.beforeContent, diffDialog.afterContent, language)
    : null, [diffDialog, language]);

  const conflictPreview = useMemo(() => {
    if (!conflictDialog || conflictDialog.remoteContent === undefined) return null;

    const conflictingTab = tabs.find((tab) => tab.id === conflictDialog.tabId);
    if (!conflictingTab) return null;
    return buildDiffPreview(conflictDialog.remoteContent, conflictingTab.content, language);
  }, [conflictDialog, language, tabs]);

  const activeSaveState = activeTab.isSaving
    ? t('notepad.status.saving', language)
    : activeTab.readOnly
      ? t('notepad.status.readOnly', language)
      : activeTab.dirty
        ? t('notepad.status.unsaved', language)
        : activeTab.filePath
          ? t('notepad.status.saved', language)
          : t('notepad.status.newFile', language);

  const activeRevisionHint = activeTab.revisionHint
    ? t('notepad.status.revision', language, { revision: activeTab.revisionHint.slice(-8) })
    : t('notepad.status.noRevision', language);

  return (
    <div className="notepad-root" onKeyDown={handleKeyDown}>
      <div className="notepad-tabstrip">
        <div className="notepad-tabs">
          {tabs.map((tab) => (
            <div key={tab.id} className={`notepad-tab ${tab.id === activeTabId ? 'active' : ''}`}>
              <button
                type="button"
                className="notepad-tab-select"
                onClick={() => setActiveTabId(tab.id)}
                title={tab.filePath || tab.title}
              >
                <span className={`notepad-tab-dirty ${tab.dirty ? 'visible' : ''}`} aria-hidden="true" />
                <span className="notepad-tab-name">{tab.title}</span>
                {tab.readOnly ? <span className="notepad-tab-readonly">{t('notepad.tab.readOnly', language)}</span> : null}
              </button>
              <button
                type="button"
                className="notepad-tab-close"
                onClick={() => handleCloseTab(tab.id)}
                aria-label={t('notepad.tab.closeAria', language, { title: tab.title })}
                title={t('notepad.tab.closeTitle', language)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="notepad-tab-add"
            onClick={handleNewFile}
            title={t('notepad.tab.newTitle', language)}
            aria-label={t('notepad.tab.newTitle', language)}
          >
            +
          </button>
        </div>
        <div className={`notepad-save-state ${activeTab.dirty ? 'dirty' : ''} ${activeTab.readOnly ? 'readonly' : ''}`}>
          {activeSaveState}
        </div>
      </div>

      <div className="notepad-toolbar">
        <div className="notepad-toolbar-group">
          <button type="button" className="notepad-tool-btn" onClick={handleNewFile} title={t('notepad.toolbar.newTitle', language)}>{t('notepad.toolbar.new', language)}</button>
          <button type="button" className="notepad-tool-btn" onClick={openFilePicker} title={t('notepad.toolbar.openTitle', language)}>{t('notepad.toolbar.open', language)}</button>
          <button
            type="button"
            className="notepad-tool-btn"
            onClick={() => void saveTab(activeTabId)}
            title={t('notepad.toolbar.saveTitle', language)}
            disabled={activeTab.readOnly || activeTab.isLoading || activeTab.isSaving || (!activeTab.dirty && Boolean(activeTab.filePath))}
          >
            {t('notepad.toolbar.save', language)}
          </button>
          <button
            type="button"
            className="notepad-tool-btn"
            onClick={() => openSavePicker(activeTabId, t('notepad.picker.saveAs', language))}
            title={t('notepad.toolbar.saveAsTitle', language)}
            disabled={activeTab.readOnly || activeTab.isLoading || activeTab.isSaving}
          >
            {t('notepad.toolbar.saveAs', language)}
          </button>
          <button
            type="button"
            className="notepad-tool-btn"
            onClick={() => setDiffDialog({
              tabId: activeTab.id,
              title: activeTab.title,
              beforeLabel: activeTab.filePath ? t('notepad.diff.before.opened', language) : t('notepad.diff.before.blank', language),
              beforeContent: activeTab.originalContent,
              afterLabel: t('notepad.diff.after.current', language),
              afterContent: activeTab.content,
            })}
            disabled={!activeTab.dirty || activeTab.isLoading}
          >
            {t('notepad.toolbar.beforeSaveDiff', language)}
          </button>
        </div>

        <div className="notepad-toolbar-group">
          <button type="button" className="notepad-tool-btn" onClick={openFindBar} title={t('notepad.toolbar.findReplaceTitle', language)}>{t('notepad.toolbar.findReplace', language)}</button>
          <button
            type="button"
            className="notepad-tool-btn"
            onClick={() => {
              setShowGoToLine(true);
              setTimeout(() => goToLineInputRef.current?.focus(), 0);
            }}
            title={t('notepad.toolbar.goToTitle', language)}
          >
            {t('notepad.toolbar.goTo', language)}
          </button>
        </div>

        <div className="notepad-toolbar-spacer" />

        <div className="notepad-toolbar-group notepad-editor-controls">
          <button
            type="button"
            className={`notepad-tool-btn ${effectiveWrapEnabled ? 'active' : ''}`}
            onClick={() => setWrapEnabled((currentWrapEnabled) => !currentWrapEnabled)}
            aria-pressed={effectiveWrapEnabled}
            title={t('notepad.toolbar.wrapTitle', language)}
          >
            {t('notepad.status.wrap', language)}
          </button>
          <button
            type="button"
            className={`notepad-tool-btn ${activeTab.readOnly ? 'active' : ''}`}
            onClick={() => updateTab(activeTabId, (tab) => ({ ...tab, readOnly: !tab.readOnly }))}
            aria-pressed={activeTab.readOnly}
          >
            {t('notepad.status.readOnly', language)}
          </button>
          <label className="notepad-toolbar-field">
            <span>{t('notepad.toolbar.syntax', language)}</span>
            <select
              className="notepad-toolbar-select"
              value={normalizeLanguage(activeTab.language)}
              onChange={(event) => updateTab(activeTabId, (tab) => ({
                ...tab,
                language: event.target.value,
                languageManuallySet: true,
              }))}
            >
              {LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.labelId ? t(option.labelId, language) : option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="notepad-toolbar-group">
          <button
            type="button"
            className={`notepad-tool-btn ${isAiSidebarOpen ? 'active' : ''}`}
            onClick={() => {
              setIsAiSidebarOpen((currentOpen) => !currentOpen);
              setTimeout(() => aiInputRef.current?.focus(), 0);
            }}
            aria-pressed={isAiSidebarOpen}
            title="SD-Agent"
          >
            AI
          </button>
        </div>
      </div>

      {showGoToLine ? (
        <div className="notepad-find-bar">
          <span className="notepad-find-label">{t('notepad.goTo.label', language)}</span>
          <input
            ref={goToLineInputRef}
            type="number"
            className="notepad-find-input notepad-goto-input"
            min={1}
            max={lineCount}
            value={goToLineValue}
            onChange={(event) => setGoToLineValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleGoToLine();
              if (event.key === 'Escape') setShowGoToLine(false);
            }}
          />
          <span className="notepad-find-hint">/ {lineCount}</span>
          <button type="button" className="notepad-tool-btn" onClick={handleGoToLine}>{t('notepad.toolbar.goTo', language)}</button>
          <button type="button" className="notepad-tool-btn" onClick={() => setShowGoToLine(false)}>{t('common.close', language)}</button>
        </div>
      ) : null}

      {activeTab.error ? (
        <div className="notepad-error">{activeTab.error}</div>
      ) : null}

      <div className={`notepad-workspace ${isAiSidebarOpen ? 'with-ai' : ''}`}>
        {activeTab.isLoading ? (
          <div className="notepad-loading">{t('notepad.loading', language)}</div>
        ) : (
          <div className={`notepad-editor-wrap ${effectiveWrapEnabled ? 'wrapped' : ''}`}>
            <CodeMirror
              ref={codeMirrorRef}
              className="notepad-codemirror"
              value={activeTab.content}
              height="100%"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                searchKeymap: true,
                defaultKeymap: true,
                history: true,
              }}
              theme={codeMirrorTheme}
              extensions={codeMirrorExtensions}
              editable={!activeTab.readOnly}
              readOnly={activeTab.readOnly}
              onChange={handleEditorChange}
              onUpdate={(viewUpdate) => {
                if (viewUpdate.docChanged || viewUpdate.selectionSet) {
                  updateCursorPosition(viewUpdate.view);
                }
              }}
              aria-label={t('notepad.editor.aria', language, { title: activeTab.title })}
            />
          </div>
        )}

        {isAiSidebarOpen ? (
          <aside className="notepad-ai-sidebar" aria-label={t('notepad.ai.sidebar.aria', language)}>
            <div className="notepad-ai-header">
              <span>
                <strong>SD-Agent</strong>
              </span>
              <button type="button" className="notepad-ai-close" onClick={() => setIsAiSidebarOpen(false)} aria-label={t('notepad.ai.sidebar.closeAria', language)}>×</button>
            </div>

            {!isAiConfigured ? (
              <div className="notepad-ai-warning">
                {t('notepad.ai.configWarning', language)}
              </div>
            ) : null}

            {aiError ? <div className="notepad-ai-error">{aiError}</div> : null}

            <div className="notepad-ai-messages">
              {aiMessages.length === 0 ? (
                <div className="notepad-ai-empty">
                  <strong>{t('notepad.ai.empty.title', language)}</strong>
                  <span>{t('notepad.ai.empty.summary', language)}</span>
                </div>
              ) : null}

              {aiMessages.map((message) => (
                <div key={message.id} className={`notepad-ai-message ${message.role}`}>
                  <div className="notepad-ai-message-role">
                    {message.role === 'assistant' ? 'SD-Agent' : message.role === 'tool' ? t('notepad.ai.role.tool', language) : t('notepad.ai.role.user', language)}
                  </div>
                  <div className="notepad-ai-message-content">{message.content}</div>
                  {message.action ? (
                    <div className="notepad-ai-action">
                      {message.action.type === 'run_command' ? (
                        <>
                          <strong>{t('notepad.ai.requestCommand', language)}</strong>
                          {message.action.reason ? <span>{message.action.reason}</span> : null}
                          <code>{message.action.command}</code>
                          <button
                            type="button"
                            className="notepad-modal-btn primary"
                            onClick={() => void runAiCommandAction(message)}
                            disabled={message.actionApplied || isAiBusy}
                          >
                            {message.actionApplied ? t('notepad.ai.executed', language) : t('notepad.ai.confirmExecute', language)}
                          </button>
                        </>
                      ) : (
                        <>
                          <strong>{message.action.summary || t('notepad.ai.applyFallback', language)}</strong>
                          <span>
                            {message.action.type === 'replace_content'
                              ? t('notepad.ai.action.replaceContent', language)
                              : message.action.type === 'replace_selection'
                                ? t('notepad.ai.action.replaceSelection', language)
                                : message.action.type === 'append_content'
                                  ? t('notepad.ai.action.appendContent', language)
                                  : t('notepad.ai.action.insertAtCursor', language)}
                          </span>
                          <button
                            type="button"
                            className="notepad-modal-btn primary"
                            onClick={() => applyAiTextAction(message)}
                            disabled={message.actionApplied || activeTab.readOnly}
                          >
                            {message.actionApplied ? t('notepad.ai.applied', language) : t('notepad.ai.applyChange', language)}
                          </button>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
              {isAiProbing ? <div className="notepad-ai-thinking">{t('notepad.ai.probing', language)}</div> : null}
              {!isAiProbing && isAiBusy ? <div className="notepad-ai-thinking">{t('notepad.ai.thinking', language)}</div> : null}
              <div ref={aiMessagesEndRef} />
            </div>

            <form className="notepad-ai-compose" onSubmit={handleAiSubmit}>
              <textarea
                ref={aiInputRef}
                value={aiInput}
                onChange={(event) => setAiInput(event.target.value)}
                placeholder={t('notepad.ai.placeholder', language)}
                rows={4}
                disabled={isAiBusy || isAiProbing}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div className="notepad-ai-compose-footer">
                <label className="notepad-ai-context-toggle">
                  <input
                    type="checkbox"
                    checked={includeAiFileContext}
                    onChange={(event) => setIncludeAiFileContext(event.target.checked)}
                  />
                  <span>{t('notepad.ai.includeFileContext', language)}</span>
                </label>
                <button type="submit" className="notepad-modal-btn primary" disabled={!aiInput.trim() || isAiBusy || isAiProbing || !isAiConfigured}>
                  {t('notepad.ai.send', language)}
                </button>
              </div>
            </form>
          </aside>
        ) : null}
      </div>

      <div className="notepad-statusbar">
        <span>{t('notepad.status.lineColumn', language, { line: cursorLine, column: cursorCol })}</span>
        <span>{t('notepad.status.lines', language, { count: lineCount })}</span>
        <span>{activeTab.language}</span>
        <span>UTF-8</span>
        <span>{lineEndingLabel}</span>
        <span>{t('notepad.status.indentSpaces', language)}</span>
        <span>{effectiveWrapEnabled ? t('notepad.status.wrap', language) : t('notepad.status.noWrap', language)}</span>
        <span>{activeRevisionHint}</span>
        <span>{activeTab.readOnly ? t('notepad.status.readOnly', language) : activeTab.dirty ? t('notepad.status.modified', language) : t('notepad.status.synced', language)}</span>
        {activeTab.filePath ? <span className="notepad-statusbar-path" title={activeTab.filePath}>{activeTab.filePath}</span> : null}
      </div>

      {pendingCloseTab ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => setPendingCloseTab(null)}>
          <div
            className="notepad-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="notepad-close-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="notepad-close-title" className="notepad-modal-title">{t('notepad.modal.unsavedTitle', language)}</div>
            <div className="notepad-modal-message">{t('notepad.modal.unsavedMessage', language, { title: pendingCloseTab.title })}</div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => {
                closeTabNow(pendingCloseTab.id);
                setPendingCloseTab(null);
              }}>{t('notepad.modal.discardClose', language)}</button>
              <button type="button" className="notepad-modal-btn" onClick={() => setPendingCloseTab(null)}>{t('common.cancel', language)}</button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => {
                const tabId = pendingCloseTab.id;
                setPendingCloseTab(null);
                void saveTab(tabId, { closeAfterSave: true });
              }}>{t('notepad.modal.saveClose', language)}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {diffDialog && diffPreview ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => setDiffDialog(null)}>
          <div
            className="notepad-modal notepad-diff-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notepad-diff-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="notepad-diff-title" className="notepad-modal-title">{t('notepad.modal.diffTitle', language, { title: diffDialog.title })}</div>
            <div className="notepad-diff-legend">
              <span>{diffDialog.beforeLabel}</span>
              <span>{diffDialog.afterLabel}</span>
            </div>
            <NotepadDiffPreview preview={diffPreview} language={language} />
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setDiffDialog(null)}>{t('common.close', language)}</button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => {
                const tabId = diffDialog.tabId;
                setDiffDialog(null);
                void saveTab(tabId);
              }}>{t('common.save', language)}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {conflictDialog ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => setConflictDialog(null)}>
          <div
            className="notepad-modal notepad-conflict-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="notepad-conflict-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="notepad-conflict-title" className="notepad-modal-title">{t('notepad.modal.remoteChangedTitle', language)}</div>
            <div className="notepad-modal-message">
              {conflictDialog.readError
                ? t('notepad.modal.conflictReadFailed', language, { path: conflictDialog.filePath, error: conflictDialog.readError })
                : t('notepad.modal.conflictMessage', language, { title: conflictDialog.title })}
            </div>
            {conflictPreview ? <NotepadDiffPreview preview={conflictPreview} language={language} /> : null}
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setConflictDialog(null)}>{t('common.cancel', language)}</button>
              <button
                type="button"
                className="notepad-modal-btn"
                disabled={conflictDialog.remoteContent === undefined}
                onClick={() => {
                  const remoteContent = conflictDialog.remoteContent;
                  const shouldClose = conflictDialog.closeAfterSave;
                  if (remoteContent === undefined) return;
                  updateTab(conflictDialog.tabId, (tab) => ({
                    ...tab,
                    content: remoteContent,
                    originalContent: remoteContent,
                    dirty: false,
                    revisionHint: conflictDialog.remoteRevisionHint || getRevisionHint(remoteContent),
                    error: '',
                  }));
                  if (shouldClose) closeTabNow(conflictDialog.tabId);
                  setConflictDialog(null);
                }}
              >
                {t('notepad.modal.reload', language)}
              </button>
              <button type="button" className="notepad-modal-btn" onClick={() => {
                openSavePicker(conflictDialog.tabId, t('notepad.picker.saveConflictAs', language), conflictDialog.closeAfterSave);
                setConflictDialog(null);
              }}>{t('notepad.toolbar.saveAs', language)}</button>
              <button type="button" className="notepad-modal-btn danger" onClick={() => {
                const { tabId, filePath, closeAfterSave } = conflictDialog;
                setConflictDialog(null);
                void saveTabToPath(tabId, filePath, { force: true, closeAfterSave });
              }}>{t('notepad.modal.overwriteRemote', language)}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {sudoPrompt ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => resolveSudoPrompt(null)}>
          <form
            className="notepad-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notepad-sudo-title"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              resolveSudoPrompt(sudoPrompt.password);
            }}
          >
            <div id="notepad-sudo-title" className="notepad-modal-title">
              {t(sudoPrompt.operation === 'read' ? 'notepad.sudo.title.read' : 'notepad.sudo.title.save', language)}
            </div>
            <div className="notepad-modal-message">
              {t('notepad.sudo.message', language, {
                operation: t(sudoPrompt.operation === 'read' ? 'notepad.sudo.operation.read' : 'notepad.sudo.operation.save', language),
                path: sudoPrompt.filePath,
              })}
            </div>
            {sudoPrompt.error ? <div className="notepad-modal-message">{t('notepad.sudo.lastError', language, { error: sudoPrompt.error })}</div> : null}
            <label className="notepad-modal-field">
              <span>{t('notepad.sudo.password', language)}</span>
              <input
                ref={sudoPasswordInputRef}
                className="notepad-modal-input"
                type="password"
                value={sudoPrompt.password}
                placeholder={t('notepad.sudo.passwordPlaceholder', language)}
                onChange={(event) => setSudoPrompt({ ...sudoPrompt, password: event.target.value })}
              />
            </label>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => resolveSudoPrompt(null)}>{t('common.cancel', language)}</button>
              <button type="submit" className="notepad-modal-btn primary" disabled={!sudoPrompt.password}>{t('notepad.sudo.submit', language)}</button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}

      <RemoteFilePicker
        connectionId={connectionId}
        systemType={systemType}
        mode={filePickerMode}
        title={filePickerTitle}
        visible={filePickerVisible}
        onConfirm={(filePath) => {
          setFilePickerVisible(false);
          filePickerOnConfirm?.(filePath);
        }}
        onCancel={() => setFilePickerVisible(false)}
      />
    </div>
  );
}

export { isTextFile };
export default RemoteNotepad;
