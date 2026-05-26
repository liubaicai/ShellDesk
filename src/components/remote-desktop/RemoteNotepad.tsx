import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import ini from 'highlight.js/lib/languages/ini';
import nginx from 'highlight.js/lib/languages/nginx';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import diff from 'highlight.js/lib/languages/diff';
import plaintext from 'highlight.js/lib/languages/plaintext';

import { getErrorMessage } from './desktopUtils';
import RemoteFilePicker from './RemoteFilePicker';
import type { RemoteSystemType } from './types';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', cpp);
hljs.registerLanguage('php', php);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('nginx', nginx);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('plaintext', plaintext);

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
  systemType?: RemoteSystemType;
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

/** 二进制文件扩展名黑名单，其他文件均允许用记事本打开 */
const BINARY_EXTENSIONS = new Set([
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'tif',
  'psd', 'ai', 'eps', 'raw', 'cr2', 'nef', 'arw', 'dng', 'heic', 'heif',
  // 音频
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'aiff', 'opus', 'mid', 'midi',
  // 视频
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
  // 压缩/归档
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'zst', 'lz4', 'tgz', 'tbz2',
  'cab', 'iso', 'dmg', 'img', 'wim', 'swm', 'esd',
  // 可执行/编译
  'exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'app', 'deb', 'rpm', 'snap', 'flatpak',
  'apk', 'ipa', 'war', 'jar', 'ear', 'class', 'pyc', 'pyo', 'whl',
  'o', 'obj', 'a', 'lib', 'pdb',
  // 数据库/二进制数据
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb',
  // 文档（二进制格式）
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  // 字体（二进制格式）
  'woff', 'woff2', 'eot', 'ttc',
  // 其他二进制
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

const LANGUAGE_OPTIONS = [
  { value: 'plaintext', label: '纯文本' },
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
const AUTO_DETECT_LANGUAGE_VALUES = LANGUAGE_OPTIONS
  .map((language) => language.value)
  .filter((language) => language !== 'plaintext');
const MAX_DIFF_INPUT_LINES = 180;
const MAX_DIFF_OUTPUT_LINES = 280;
const MAX_HIGHLIGHT_CHARACTERS = 320000;
const MAX_LANGUAGE_DETECTION_CHARACTERS = 80000;
const EDITOR_LINE_HEIGHT = 20;
const MAX_AI_FILE_CONTEXT_CHARACTERS = 18000;
const MAX_AI_SELECTION_CHARACTERS = 6000;
const MAX_AI_ENVIRONMENT_CHARACTERS = 12000;
const MAX_AI_COMMAND_OUTPUT_CHARACTERS = 12000;
const MAX_AI_HISTORY_MESSAGES = 14;
const NOTEPAD_AI_SYSTEM_PROMPT = `你是 ShellDesk 的全局 SD-Agent。SD-Agent 具备基础对话能力，也可以在用户确认后通过 SSH 隧道执行命令等操作。当前你嵌入在远程记事本中，帮助用户理解、生成和修改当前远程文件内容。

要求：
- 用中文回答，除非用户明确要求其他语言。
- 优先结合当前文件路径、语言、选区、远端环境探测结果来生成内容。
- 如果要修改当前文本，先简短说明，然后附加一个 shelldesk-action 代码块。
- 如果需要探测服务器，可以请求执行只读命令，同样使用 shelldesk-action 代码块。命令会经 SSH 隧道在当前连接上执行，但必须等用户确认。

可用动作 JSON：
{"type":"replace_content","content":"完整新内容","summary":"替换全文"}
{"type":"replace_selection","content":"替换选区的文本","summary":"替换选区"}
{"type":"insert_at_cursor","content":"要插入的文本","summary":"插入文本"}
{"type":"append_content","content":"追加到文件末尾的文本","summary":"追加文本"}
{"type":"run_command","command":"只读探测命令","reason":"为什么需要执行"}

动作块格式必须是：
\`\`\`shelldesk-action
{"type":"replace_content","content":"..."}
\`\`\`

除非用户明确要求，避免生成会删除数据、重启服务、安装软件或修改系统状态的命令。`;

function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return name.slice(dotIndex + 1).toLowerCase();
}

function normalizeLanguage(language?: string): string {
  if (language && LANGUAGE_OPTION_VALUES.has(language) && hljs.getLanguage(language)) {
    return language;
  }

  return 'plaintext';
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

  try {
    const detected = hljs.highlightAuto(sample, AUTO_DETECT_LANGUAGE_VALUES);
    if (detected.language && detected.relevance >= 8) {
      return normalizeLanguage(detected.language);
    }
  } catch {
    return 'plaintext';
  }

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

function escapeHtml(content: string): string {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getRevisionHint(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function getLineEndingLabel(content: string): string {
  if (content.includes('\r\n')) return 'CRLF';
  if (content.includes('\n')) return 'LF';
  if (content.includes('\r')) return 'CR';
  return '无换行';
}

function isLikelyBinaryContent(content: string): boolean {
  return content.includes('\0');
}

function countOccurrences(content: string, searchText: string): number {
  if (!searchText) return 0;

  let count = 0;
  let start = 0;
  while (start <= content.length) {
    const matchIndex = content.indexOf(searchText, start);
    if (matchIndex < 0) return count;
    count += 1;
    start = matchIndex + searchText.length;
  }
  return count;
}

function normalizeDiffLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function buildDiffPreview(beforeContent: string, afterContent: string): DiffPreview {
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
    lines.push({ kind: 'meta', text: '差异预览已截断，保存仍会写入完整文件。' });
  }

  if (lines.length === 0) {
    lines.push({ kind: 'meta', text: '当前内容没有行级差异。' });
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

function truncateMiddle(content: string, maxLength: number) {
  if (content.length <= maxLength) {
    return content;
  }

  const headLength = Math.floor(maxLength * 0.58);
  const tailLength = Math.max(0, maxLength - headLength - 80);
  return `${content.slice(0, headLength)}\n\n... 已截断 ${content.length - headLength - tailLength} 个字符 ...\n\n${content.slice(-tailLength)}`;
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

function formatCommandResult(command: string, result: { stdout: string; stderr: string; code: number }) {
  const stdout = result.stdout ? truncateMiddle(result.stdout, MAX_AI_COMMAND_OUTPUT_CHARACTERS) : '(无标准输出)';
  const stderr = result.stderr ? `\n\nstderr:\n${truncateMiddle(result.stderr, 4000)}` : '';

  return `远端命令执行完成。\n\n命令:\n${command}\n\n退出码: ${result.code}\n\nstdout:\n${stdout}${stderr}`;
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

function createNewTab(initialTitle?: string, initialContent = ''): NotepadTab {
  tabSequence += 1;
  const title = initialTitle?.trim() || `未命名-${tabSequence}`;
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

function NotepadDiffPreview({ preview }: { preview: DiffPreview }) {
  return (
    <div className="notepad-diff-preview" aria-label="差异预览">
      {preview.lines.map((line, index) => (
        <div key={`${line.kind}-${index}`} className={`notepad-diff-line ${line.kind}`}>
          <span className="notepad-diff-prefix">{getDiffPrefix(line.kind)}</span>
          <span className="notepad-diff-text">{line.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function RemoteNotepad({ connectionId, settings, initialFilePath, initialContent, initialTitle, systemType }: RemoteNotepadProps) {
  const [tabs, setTabs] = useState<NotepadTab[]>(() => [createNewTab(initialTitle, initialContent)]);
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);
  const [showGoToLine, setShowGoToLine] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState('');
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [findFeedback, setFindFeedback] = useState('');
  const [showFind, setShowFind] = useState(false);
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

  const [filePickerVisible, setFilePickerVisible] = useState(false);
  const [filePickerMode, setFilePickerMode] = useState<'open' | 'save'>('open');
  const [filePickerTitle, setFilePickerTitle] = useState('');
  const [filePickerOnConfirm, setFilePickerOnConfirm] = useState<((path: string) => void) | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);
  const aiMessagesEndRef = useRef<HTMLDivElement>(null);
  const initialFileHandledRef = useRef(false);
  const tabsRef = useRef(tabs);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0], [tabs, activeTabId]);
  const isAiConfigured = Boolean(
    settings.aiApiBaseUrl.trim() &&
    settings.aiApiKey.trim() &&
    settings.aiModel.trim() &&
    (window.guiSSH?.ai?.chatStream || window.guiSSH?.ai?.chat),
  );

  const updateTab = useCallback((tabId: string, update: (tab: NotepadTab) => NotepadTab) => {
    setTabs((currentTabs) => currentTabs.map((tab) => tab.id === tabId ? update(tab) : tab));
  }, []);

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
      const freshTab = createNewTab();
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
  }, []);

  const openFile = useCallback(async (filePath: string) => {
    const nextFilePath = filePath.trim();
    if (!nextFilePath) return;

    const nextTitle = getFileNameFromPath(nextFilePath);
    if (!isTextFile(nextTitle)) {
      updateTab(activeTabId, (tab) => ({
        ...tab,
        error: `"${nextTitle}" 属于二进制文件类型，记事本未打开它。`,
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
      const content = await window.guiSSH!.connections.readFile(connectionId, nextFilePath);
      if (isLikelyBinaryContent(content)) {
        updateTab(newTab.id, (tab) => ({
          ...tab,
          content: '',
          originalContent: '',
          readOnly: true,
          isLoading: false,
          error: '文件包含二进制内容，记事本已停止加载。',
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
  }, [activeTabId, connectionId, updateTab]);

  useEffect(() => {
    if (initialFilePath && !initialFileHandledRef.current) {
      initialFileHandledRef.current = true;
      void openFile(initialFilePath);
    }
  }, [initialFilePath, openFile]);

  const activeContent = activeTab.content;
  const highlightedHtml = useMemo(() => {
    if (!activeContent) return '';
    if (activeContent.length > MAX_HIGHLIGHT_CHARACTERS || !hljs.getLanguage(activeTab.language)) {
      return escapeHtml(activeContent);
    }

    try {
      return hljs.highlight(activeContent, { language: activeTab.language, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(activeContent);
    }
  }, [activeContent, activeTab.language]);

  const lineCount = useMemo(() => activeTab.content.split('\n').length, [activeTab.content]);

  const saveTabToPath = useCallback(async (tabId: string, filePath: string, options: SaveOptions = {}) => {
    const tabToSave = tabsRef.current.find((tab) => tab.id === tabId);
    const nextFilePath = filePath.trim();
    if (!tabToSave || !nextFilePath) return false;

    if (tabToSave.readOnly) {
      updateTab(tabId, (tab) => ({ ...tab, error: '当前标签为只读模式，未执行保存。' }));
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
        const remoteContent = await window.guiSSH!.connections.readFile(connectionId, nextFilePath);
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
      await window.guiSSH!.connections.writeFile(connectionId, nextFilePath, contentToSave);
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
        error: receivedMoreEdits ? '保存完成，保存过程中产生的新编辑仍未写入。' : '',
      }));
      if (options.closeAfterSave && !receivedMoreEdits) {
        closeTabNow(tabId);
      }
      return true;
    } catch (error) {
      updateTab(tabId, (tab) => ({
        ...tab,
        isSaving: false,
        error: `保存失败：${getErrorMessage(error)}`,
      }));
      return false;
    }
  }, [closeTabNow, connectionId, updateTab]);

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
      openSavePicker(tabId, '保存文件', Boolean(options.closeAfterSave));
      return false;
    }

    return await saveTabToPath(tabId, tabToSave.filePath, options);
  }, [openSavePicker, saveTabToPath]);

  const openFilePicker = useCallback(() => {
    setFilePickerMode('open');
    setFilePickerTitle('打开文件');
    setFilePickerOnConfirm(() => (filePath: string) => {
      if (filePath) void openFile(filePath);
    });
    setFilePickerVisible(true);
  }, [openFile]);

  const handleNewFile = useCallback(() => {
    const newTab = createNewTab();
    setTabs((currentTabs) => [...currentTabs, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const handleCloseTab = useCallback((tabId: string) => {
    const tabToClose = tabsRef.current.find((tab) => tab.id === tabId);
    if (!tabToClose) return;

    if (tabToClose.dirty) {
      setPendingCloseTab({ id: tabToClose.id, title: tabToClose.title });
      return;
    }

    closeTabNow(tabId);
  }, [closeTabNow]);

  const handleContentChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextContent = event.target.value;
    updateTab(activeTabId, (tab) => tab.readOnly ? tab : {
      ...tab,
      content: nextContent,
      dirty: nextContent !== tab.originalContent,
      language: !tab.languageManuallySet && tab.language === 'plaintext'
        ? getLanguage(tab.title, nextContent)
        : tab.language,
    });
  }, [activeTabId, updateTab]);

  const updateCursorPosition = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const position = textarea.selectionStart;
    const textBeforeCursor = textarea.value.slice(0, position);
    const lines = textBeforeCursor.split('\n');
    setCursorLine(lines.length);
    setCursorCol(lines[lines.length - 1].length + 1);
  }, []);

  const selectEditorRange = useCallback((start: number, end: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.focus();
    textarea.setSelectionRange(start, end);
    const targetLine = textarea.value.slice(0, start).split('\n').length;
    textarea.scrollTop = Math.max(0, targetLine - 5) * EDITOR_LINE_HEIGHT;
    updateCursorPosition();
  }, [updateCursorPosition]);

  const replaceActiveContent = useCallback((nextContent: string, nextSelectionStart: number, nextSelectionEnd: number) => {
    updateTab(activeTabId, (tab) => tab.readOnly ? tab : {
      ...tab,
      content: nextContent,
      dirty: nextContent !== tab.originalContent,
      language: !tab.languageManuallySet && tab.language === 'plaintext'
        ? getLanguage(tab.title, nextContent)
        : tab.language,
    });

    requestAnimationFrame(() => selectEditorRange(nextSelectionStart, nextSelectionEnd));
  }, [activeTabId, selectEditorRange, updateTab]);

  const getCurrentEditorSelection = useCallback((): EditorSelectionSnapshot => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return { start: 0, end: 0, text: '' };
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    return {
      start,
      end,
      text: textarea.value.slice(start, end),
    };
  }, []);

  const buildAiContextMessage = useCallback((
    selection: EditorSelectionSnapshot,
    options?: { environmentOverride?: string },
  ) => {
    const filePath = activeTab.filePath || '(尚未保存的新文件)';
    const selectedText = selection.text
      ? truncateMiddle(selection.text, MAX_AI_SELECTION_CHARACTERS)
      : '(无选区)';
    const environmentSource = options?.environmentOverride ?? remoteEnvironment;
    const environmentContext = environmentSource
      ? truncateMiddle(environmentSource, MAX_AI_ENVIRONMENT_CHARACTERS)
      : '(尚未探测；发送消息时会自动探测，也可以请求 run_command 动作补充上下文)';
    const fileContextLines = includeAiFileContext
      ? [
          '当前文件内容：',
          '```',
          truncateMiddle(activeTab.content, MAX_AI_FILE_CONTEXT_CHARACTERS),
          '```',
        ]
      : [
          '当前文件内容：',
          '(用户已取消带入当前文件内容上下文；请仅依据文件元数据、选区、对话和工具结果回答)',
        ];

    return [
      '当前 ShellDesk 记事本上下文：',
      `文件标题：${activeTab.title}`,
      `远程路径：${filePath}`,
      `语言模式：${activeTab.language}`,
      `只读状态：${activeTab.readOnly ? '只读' : '可编辑'}`,
      `光标：第 ${cursorLine} 行，第 ${cursorCol} 列`,
      `选区范围：${selection.start}-${selection.end}`,
      '',
      '当前选中文本：',
      selectedText,
      '',
      '远端环境探测：',
      environmentContext,
      '',
      ...fileContextLines,
    ].join('\n');
  }, [activeTab.content, activeTab.filePath, activeTab.language, activeTab.readOnly, activeTab.title, cursorCol, cursorLine, includeAiFileContext, remoteEnvironment]);

  const createAiChatMessages = useCallback((
    nextMessages: NotepadAiMessage[],
    selection: EditorSelectionSnapshot,
    options?: { environmentOverride?: string },
  ): ShellDeskAiChatMessage[] => {
    const recentMessages = nextMessages.slice(-MAX_AI_HISTORY_MESSAGES).map<ShellDeskAiChatMessage>((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.role === 'tool' ? `工具结果：\n${message.content}` : message.content,
    }));

    return [
      { role: 'system', content: NOTEPAD_AI_SYSTEM_PROMPT },
      { role: 'user', content: buildAiContextMessage(selection, options) },
      ...recentMessages,
    ];
  }, [buildAiContextMessage]);

  const runRemoteEnvironmentProbe = useCallback(async () => {
    const command = getEnvironmentProbeCommand(systemType);
    const result = await window.guiSSH!.connections.runCommand(connectionId, command);
    return formatCommandResult(command, result);
  }, [connectionId, systemType]);

  const requestAiAssistant = useCallback(async (
    nextMessages: NotepadAiMessage[],
    selection: EditorSelectionSnapshot,
    options?: { environmentOverride?: string },
  ) => {
    const aiControls = window.guiSSH?.ai;
    const chat = aiControls?.chat;
    const chatStream = aiControls?.chatStream;

    if (!chat && !chatStream) {
      setAiError('当前运行环境未提供 SD-Agent 对话接口。');
      return;
    }

    if (!settings.aiApiBaseUrl.trim() || !settings.aiApiKey.trim() || !settings.aiModel.trim()) {
      setAiError('请先在设置中完成 SD-Agent 提供商、API 密钥和模型配置。');
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
              const partialContent = stripAiActionBlocks(streamedContent) || '正在生成回复...';
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
      const displayContent = stripAiActionBlocks(resultContent) || (action ? '我准备好了一个可执行动作。' : resultContent);
      const assistantMessage: NotepadAiMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: displayContent,
        createdAt: assistantCreatedAt,
        action,
      };

      setAiMessages([...nextMessages, assistantMessage]);
    } catch (error) {
      setAiError(`SD-Agent 请求失败：${getErrorMessage(error)}`);
      setAiMessages(nextMessages);
    } finally {
      setIsAiBusy(false);
    }
  }, [
    createAiChatMessages,
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
      setAiError('请先在设置中完成 SD-Agent 提供商、API 密钥和模型配置。');
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
          content: `已自动探测环境，后续对话会带上这份上下文。\n\n${toolContent}`,
          createdAt: new Date().toISOString(),
        };

        environmentOverride = toolContent;
        nextMessages = [...nextMessages, toolMessage];
        setRemoteEnvironment(toolContent);
        setAiMessages(nextMessages);
      } catch (error) {
        const errorMessage = `自动探测环境失败：${getErrorMessage(error)}`;
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
      setAiError('当前标签是只读状态，无法应用 SD-Agent 修改。');
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
  }, [activeTab.content, activeTab.readOnly, getCurrentEditorSelection, lastAiSelection, markAiActionApplied, replaceActiveContent]);

  const runAiCommandAction = useCallback(async (message: NotepadAiMessage) => {
    const action = message.action;

    if (!action || action.type !== 'run_command' || isAiBusy) {
      return;
    }

    setIsAiBusy(true);
    setAiError('');

    try {
      const result = await window.guiSSH!.connections.runCommand(connectionId, action.command);
      const toolContent = formatCommandResult(action.command, result);
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
      setAiError(`命令执行失败：${getErrorMessage(error)}`);
    } finally {
      setIsAiBusy(false);
    }
  }, [aiMessages, connectionId, getCurrentEditorSelection, isAiBusy, requestAiAssistant]);

  const handleTextareaScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const highlight = highlightRef.current;
    const lineNumbers = lineNumbersRef.current;
    if (textarea && highlight) {
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    }
    if (textarea && lineNumbers) {
      lineNumbers.scrollTop = textarea.scrollTop;
    }
  }, []);

  const handleGoToLine = useCallback(() => {
    const lineNumber = parseInt(goToLineValue, 10);
    const textarea = textareaRef.current;
    if (!textarea || Number.isNaN(lineNumber) || lineNumber < 1) {
      setShowGoToLine(false);
      return;
    }

    const lines = activeTab.content.split('\n');
    const targetLine = Math.min(lineNumber, lines.length);
    let position = 0;
    for (let index = 0; index < targetLine - 1; index += 1) {
      position += lines[index].length + 1;
    }

    selectEditorRange(position, position);
    setShowGoToLine(false);
    setGoToLineValue('');
  }, [activeTab.content, goToLineValue, selectEditorRange]);

  const openFindBar = useCallback(() => {
    setShowFind(true);
    setTimeout(() => findInputRef.current?.focus(), 0);
  }, []);

  const handleFindNext = useCallback((reverse = false) => {
    const textarea = textareaRef.current;
    if (!textarea || !findText) return;

    const editorValue = textarea.value;
    const nextIndex = reverse
      ? editorValue.lastIndexOf(findText, Math.max(0, textarea.selectionStart - 1))
      : editorValue.indexOf(findText, textarea.selectionEnd);
    const wrappedIndex = reverse
      ? editorValue.lastIndexOf(findText)
      : editorValue.indexOf(findText);
    const matchIndex = nextIndex >= 0 ? nextIndex : wrappedIndex;

    if (matchIndex < 0) {
      setFindFeedback('未找到匹配内容');
      return;
    }

    selectEditorRange(matchIndex, matchIndex + findText.length);
    setFindFeedback(nextIndex >= 0 ? '' : '已从文件边界继续查找');
  }, [findText, selectEditorRange]);

  const handleReplaceCurrent = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || !findText || activeTab.readOnly) return;

    const selectedContent = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    if (selectedContent !== findText) {
      handleFindNext();
      return;
    }

    const nextContent = `${textarea.value.slice(0, textarea.selectionStart)}${replaceText}${textarea.value.slice(textarea.selectionEnd)}`;
    const nextPosition = textarea.selectionStart + replaceText.length;
    replaceActiveContent(nextContent, nextPosition, nextPosition);
    setFindFeedback('已替换 1 处');
  }, [activeTab.readOnly, findText, handleFindNext, replaceActiveContent, replaceText]);

  const handleReplaceAll = useCallback(() => {
    if (!findText || activeTab.readOnly) return;

    const matchCount = countOccurrences(activeTab.content, findText);
    if (matchCount === 0) {
      setFindFeedback('未找到可替换内容');
      return;
    }

    const nextContent = activeTab.content.split(findText).join(replaceText);
    replaceActiveContent(nextContent, 0, 0);
    setFindFeedback(`已替换 ${matchCount} 处`);
  }, [activeTab.content, activeTab.readOnly, findText, replaceActiveContent, replaceText]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent) => {
    const isMod = event.ctrlKey || event.metaKey;

    if (isMod && event.key === 's') {
      event.preventDefault();
      if (event.shiftKey) {
        openSavePicker(activeTabId, '另存为');
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
      setShowFind(false);
    }

    if (event.key === 'Tab' && event.target === textareaRef.current && !activeTab.readOnly) {
      event.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const nextContent = `${textarea.value.slice(0, start)}  ${textarea.value.slice(end)}`;
      replaceActiveContent(nextContent, start + 2, start + 2);
    }
  }, [
    activeTab.readOnly,
    activeTabId,
    handleNewFile,
    openFilePicker,
    openFindBar,
    openSavePicker,
    replaceActiveContent,
    saveTab,
  ]);

  const diffPreview = useMemo(() => diffDialog
    ? buildDiffPreview(diffDialog.beforeContent, diffDialog.afterContent)
    : null, [diffDialog]);

  const conflictPreview = useMemo(() => {
    if (!conflictDialog || conflictDialog.remoteContent === undefined) return null;

    const conflictingTab = tabs.find((tab) => tab.id === conflictDialog.tabId);
    if (!conflictingTab) return null;
    return buildDiffPreview(conflictDialog.remoteContent, conflictingTab.content);
  }, [conflictDialog, tabs]);

  const activeSaveState = activeTab.isSaving
    ? '保存中'
    : activeTab.readOnly
      ? '只读'
      : activeTab.dirty
        ? '未保存'
        : activeTab.filePath
          ? '已保存'
          : '新文件';

  const activeRevisionHint = activeTab.revisionHint
    ? `版本 ${activeTab.revisionHint.slice(-8)}`
    : '尚未保存';

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
                {tab.readOnly ? <span className="notepad-tab-readonly">只读</span> : null}
              </button>
              <button
                type="button"
                className="notepad-tab-close"
                onClick={() => handleCloseTab(tab.id)}
                aria-label={`关闭 ${tab.title}`}
                title="关闭标签"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="notepad-tab-add"
            onClick={handleNewFile}
            title="新建文件"
            aria-label="新建文件"
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
          <button type="button" className="notepad-tool-btn" onClick={handleNewFile} title="新建 (Ctrl+N)">新建</button>
          <button type="button" className="notepad-tool-btn" onClick={openFilePicker} title="打开 (Ctrl+O)">打开</button>
          <button
            type="button"
            className="notepad-tool-btn"
            onClick={() => void saveTab(activeTabId)}
            title="保存 (Ctrl+S)"
            disabled={activeTab.readOnly || activeTab.isLoading || activeTab.isSaving || (!activeTab.dirty && Boolean(activeTab.filePath))}
          >
            保存
          </button>
          <button
            type="button"
            className="notepad-tool-btn"
            onClick={() => openSavePicker(activeTabId, '另存为')}
            title="另存为 (Ctrl+Shift+S)"
            disabled={activeTab.readOnly || activeTab.isLoading || activeTab.isSaving}
          >
            另存为
          </button>
          <button
            type="button"
            className="notepad-tool-btn"
            onClick={() => setDiffDialog({
              tabId: activeTab.id,
              title: activeTab.title,
              beforeLabel: activeTab.filePath ? '打开时版本' : '空白文件',
              beforeContent: activeTab.originalContent,
              afterLabel: '当前编辑',
              afterContent: activeTab.content,
            })}
            disabled={!activeTab.dirty || activeTab.isLoading}
          >
            保存前差异
          </button>
        </div>

        <div className="notepad-toolbar-group">
          <button type="button" className="notepad-tool-btn" onClick={openFindBar} title="查找与替换 (Ctrl+F)">查找替换</button>
          <button
            type="button"
            className="notepad-tool-btn"
            onClick={() => {
              setShowGoToLine(true);
              setTimeout(() => goToLineInputRef.current?.focus(), 0);
            }}
            title="跳转 (Ctrl+G)"
          >
            跳转
          </button>
        </div>

        <div className="notepad-toolbar-spacer" />

        <div className="notepad-toolbar-group notepad-editor-controls">
          <button
            type="button"
            className={`notepad-tool-btn ${wrapEnabled ? 'active' : ''}`}
            onClick={() => setWrapEnabled((currentWrapEnabled) => !currentWrapEnabled)}
            aria-pressed={wrapEnabled}
          >
            自动换行
          </button>
          <button
            type="button"
            className={`notepad-tool-btn ${activeTab.readOnly ? 'active' : ''}`}
            onClick={() => updateTab(activeTabId, (tab) => ({ ...tab, readOnly: !tab.readOnly }))}
            aria-pressed={activeTab.readOnly}
          >
            只读
          </button>
          <label className="notepad-toolbar-field">
            <span>语法</span>
            <select
              className="notepad-toolbar-select"
              value={hljs.getLanguage(activeTab.language) ? activeTab.language : 'plaintext'}
              onChange={(event) => updateTab(activeTabId, (tab) => ({
                ...tab,
                language: event.target.value,
                languageManuallySet: true,
              }))}
            >
              {LANGUAGE_OPTIONS.map((language) => (
                <option key={language.value} value={language.value}>{language.label}</option>
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

      {showFind ? (
        <div className="notepad-find-bar">
          <input
            ref={findInputRef}
            type="text"
            className="notepad-find-input"
            placeholder="查找"
            value={findText}
            onChange={(event) => {
              setFindText(event.target.value);
              setFindFeedback('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleFindNext(event.shiftKey);
              if (event.key === 'Escape') setShowFind(false);
            }}
          />
          <input
            type="text"
            className="notepad-find-input"
            placeholder="替换为"
            value={replaceText}
            onChange={(event) => setReplaceText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleReplaceCurrent();
              if (event.key === 'Escape') setShowFind(false);
            }}
            disabled={activeTab.readOnly}
          />
          <button type="button" className="notepad-tool-btn" onClick={() => handleFindNext(true)}>上一个</button>
          <button type="button" className="notepad-tool-btn" onClick={() => handleFindNext()}>下一个</button>
          <button type="button" className="notepad-tool-btn" onClick={handleReplaceCurrent} disabled={activeTab.readOnly}>替换</button>
          <button type="button" className="notepad-tool-btn" onClick={handleReplaceAll} disabled={activeTab.readOnly}>全部替换</button>
          {findFeedback ? <span className="notepad-find-hint">{findFeedback}</span> : null}
          <button type="button" className="notepad-tool-btn" onClick={() => setShowFind(false)}>关闭</button>
        </div>
      ) : null}

      {showGoToLine ? (
        <div className="notepad-find-bar">
          <span className="notepad-find-label">跳转到行：</span>
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
          <button type="button" className="notepad-tool-btn" onClick={handleGoToLine}>跳转</button>
          <button type="button" className="notepad-tool-btn" onClick={() => setShowGoToLine(false)}>关闭</button>
        </div>
      ) : null}

      {activeTab.error ? (
        <div className="notepad-error">{activeTab.error}</div>
      ) : null}

      <div className={`notepad-workspace ${isAiSidebarOpen ? 'with-ai' : ''}`}>
        {activeTab.isLoading ? (
          <div className="notepad-loading">正在加载文件...</div>
        ) : (
          <div className={`notepad-editor-wrap ${wrapEnabled ? 'wrapped' : ''}`}>
            <div ref={lineNumbersRef} className="notepad-line-numbers" aria-hidden="true">
              {Array.from({ length: lineCount }, (_, index) => (
                <span key={index + 1} className={cursorLine === index + 1 ? 'active' : ''}>{index + 1}</span>
              ))}
            </div>
            <div className="notepad-editor-container">
              <pre ref={highlightRef} className="notepad-highlight-layer" aria-hidden="true">
                <code dangerouslySetInnerHTML={{ __html: `${highlightedHtml}\n` }} />
              </pre>
              <textarea
                ref={textareaRef}
                className="notepad-textarea"
                value={activeTab.content}
                onChange={handleContentChange}
                onKeyUp={updateCursorPosition}
                onMouseUp={updateCursorPosition}
                onScroll={handleTextareaScroll}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                wrap={wrapEnabled ? 'soft' : 'off'}
                readOnly={activeTab.readOnly}
                aria-label={`${activeTab.title} 编辑区`}
              />
            </div>
          </div>
        )}

        {isAiSidebarOpen ? (
          <aside className="notepad-ai-sidebar" aria-label="SD-Agent 侧边栏">
            <div className="notepad-ai-header">
              <span>
                <strong>SD-Agent</strong>
              </span>
              <button type="button" className="notepad-ai-close" onClick={() => setIsAiSidebarOpen(false)} aria-label="关闭 SD-Agent 侧边栏">×</button>
            </div>

            {!isAiConfigured ? (
              <div className="notepad-ai-warning">
                请先在设置里配置 SD-Agent 提供商、API 密钥和默认模型。
              </div>
            ) : null}

            {aiError ? <div className="notepad-ai-error">{aiError}</div> : null}

            <div className="notepad-ai-messages">
              {aiMessages.length === 0 ? (
                <div className="notepad-ai-empty">
                  <strong>可以让 SD-Agent 生成、重构或解释当前文件。</strong>
                  <span>发送时会自动探测环境；当前文件内容默认会带入上下文，可在发送前取消。</span>
                </div>
              ) : null}

              {aiMessages.map((message) => (
                <div key={message.id} className={`notepad-ai-message ${message.role}`}>
                  <div className="notepad-ai-message-role">
                    {message.role === 'assistant' ? 'SD-Agent' : message.role === 'tool' ? '工具' : '你'}
                  </div>
                  <div className="notepad-ai-message-content">{message.content}</div>
                  {message.action ? (
                    <div className="notepad-ai-action">
                      {message.action.type === 'run_command' ? (
                        <>
                          <strong>请求执行命令</strong>
                          {message.action.reason ? <span>{message.action.reason}</span> : null}
                          <code>{message.action.command}</code>
                          <button
                            type="button"
                            className="notepad-modal-btn primary"
                            onClick={() => void runAiCommandAction(message)}
                            disabled={message.actionApplied || isAiBusy}
                          >
                            {message.actionApplied ? '已执行' : '确认执行'}
                          </button>
                        </>
                      ) : (
                        <>
                          <strong>{message.action.summary || '可应用到当前文本'}</strong>
                          <span>{message.action.type === 'replace_content' ? '替换全文' : message.action.type === 'replace_selection' ? '替换选区' : message.action.type === 'append_content' ? '追加内容' : '插入到光标'}</span>
                          <button
                            type="button"
                            className="notepad-modal-btn primary"
                            onClick={() => applyAiTextAction(message)}
                            disabled={message.actionApplied || activeTab.readOnly}
                          >
                            {message.actionApplied ? '已应用' : '应用修改'}
                          </button>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
              {isAiProbing ? <div className="notepad-ai-thinking">正在自动探测环境...</div> : null}
              {!isAiProbing && isAiBusy ? <div className="notepad-ai-thinking">SD-Agent 正在思考...</div> : null}
              <div ref={aiMessagesEndRef} />
            </div>

            <form className="notepad-ai-compose" onSubmit={handleAiSubmit}>
              <textarea
                ref={aiInputRef}
                value={aiInput}
                onChange={(event) => setAiInput(event.target.value)}
                placeholder="询问、生成内容，或要求修改当前文本..."
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
                  <span>带入当前文件内容</span>
                </label>
                <button type="submit" className="notepad-modal-btn primary" disabled={!aiInput.trim() || isAiBusy || isAiProbing || !isAiConfigured}>
                  发送
                </button>
              </div>
            </form>
          </aside>
        ) : null}
      </div>

      <div className="notepad-statusbar">
        <span>行 {cursorLine}, 列 {cursorCol}</span>
        <span>{lineCount} 行</span>
        <span>{activeTab.language}</span>
        <span>UTF-8</span>
        <span>{getLineEndingLabel(activeTab.content)}</span>
        <span>缩进 2 空格</span>
        <span>{wrapEnabled ? '自动换行' : '不换行'}</span>
        <span>{activeRevisionHint}</span>
        <span>{activeTab.readOnly ? '只读' : activeTab.dirty ? '已修改' : '已同步'}</span>
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
            <div id="notepad-close-title" className="notepad-modal-title">关闭未保存标签</div>
            <div className="notepad-modal-message">"{pendingCloseTab.title}" 还有未保存的更改。</div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => {
                closeTabNow(pendingCloseTab.id);
                setPendingCloseTab(null);
              }}>不保存并关闭</button>
              <button type="button" className="notepad-modal-btn" onClick={() => setPendingCloseTab(null)}>取消</button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => {
                const tabId = pendingCloseTab.id;
                setPendingCloseTab(null);
                void saveTab(tabId, { closeAfterSave: true });
              }}>保存后关闭</button>
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
            <div id="notepad-diff-title" className="notepad-modal-title">保存前差异 - {diffDialog.title}</div>
            <div className="notepad-diff-legend">
              <span>{diffDialog.beforeLabel}</span>
              <span>{diffDialog.afterLabel}</span>
            </div>
            <NotepadDiffPreview preview={diffPreview} />
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setDiffDialog(null)}>关闭</button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => {
                const tabId = diffDialog.tabId;
                setDiffDialog(null);
                void saveTab(tabId);
              }}>保存</button>
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
            <div id="notepad-conflict-title" className="notepad-modal-title">远程文件已变化</div>
            <div className="notepad-modal-message">
              {conflictDialog.readError
                ? `保存前无法读取 "${conflictDialog.filePath}"：${conflictDialog.readError}`
                : `"${conflictDialog.title}" 的远程版本在打开后发生变化。请先选择如何处理本地编辑。`}
            </div>
            {conflictPreview ? <NotepadDiffPreview preview={conflictPreview} /> : null}
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setConflictDialog(null)}>取消</button>
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
                重新加载
              </button>
              <button type="button" className="notepad-modal-btn" onClick={() => {
                openSavePicker(conflictDialog.tabId, '冲突内容另存为', conflictDialog.closeAfterSave);
                setConflictDialog(null);
              }}>另存为</button>
              <button type="button" className="notepad-modal-btn danger" onClick={() => {
                const { tabId, filePath, closeAfterSave } = conflictDialog;
                setConflictDialog(null);
                void saveTabToPath(tabId, filePath, { force: true, closeAfterSave });
              }}>覆盖远端</button>
            </div>
          </div>
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
