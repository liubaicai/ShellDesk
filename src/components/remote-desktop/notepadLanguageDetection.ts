import { type MessageId } from '../../i18n';
import { getFileExtension } from './textFileUtils';

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

export const LANGUAGE_OPTIONS: Array<{ value: string; label?: string; labelId?: MessageId }> = [
  { value: 'plaintext', labelId: 'notepad.language.plaintext' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'html', label: 'HTML' },
  { value: 'xml', label: 'XML' },
  { value: 'css', label: 'CSS / SCSS' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'bash', label: 'Shell' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'bat', label: 'Batch / CMD' },
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
const MAX_LANGUAGE_DETECTION_CHARACTERS = 24000;
export const MAX_INTERACTIVE_LANGUAGE_DETECTION_CHARACTERS = 12000;

export function normalizeLanguage(language?: string): string {
  if (language && LANGUAGE_OPTION_VALUES.has(language)) {
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

export function detectLanguageFromContent(content: string): string {
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

export function getLanguage(fileName: string, content = ''): string {
  const fileNameLanguage = getFileNameLanguage(fileName);
  if (fileNameLanguage !== 'plaintext') {
    return fileNameLanguage;
  }

  return detectLanguageFromContent(content);
}
