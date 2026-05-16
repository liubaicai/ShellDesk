import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

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
  filePath: string;
  fileName: string;
  content: string;
  originalContent: string;
  language: string;
  isLoading: boolean;
  error: string;
}

interface RemoteNotepadProps {
  connectionId: string;
  initialFilePath?: string;
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

function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return name.slice(dotIndex + 1).toLowerCase();
}

function getLanguage(fileName: string): string {
  const ext = getFileExtension(fileName);
  if (EXTENSION_LANGUAGE_MAP[ext]) return EXTENSION_LANGUAGE_MAP[ext];
  if (fileName === 'Makefile' || fileName === 'makefile') return 'plaintext';
  if (fileName === 'Dockerfile') return 'dockerfile';
  if (fileName === '.gitignore' || fileName === '.editorconfig') return 'plaintext';
  if (fileName.startsWith('nginx')) return 'nginx';
  return 'plaintext';
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

let tabSequence = 0;

function createNewTab(): NotepadTab {
  tabSequence += 1;
  return {
    id: `new-${tabSequence}`,
    filePath: '',
    fileName: `未命名-${tabSequence}`,
    content: '',
    originalContent: '',
    language: 'plaintext',
    isLoading: false,
    error: '',
  };
}

function RemoteNotepad({ connectionId, initialFilePath }: RemoteNotepadProps) {
  const [tabs, setTabs] = useState<NotepadTab[]>(() => [createNewTab()]);
  const [activeTabId, setActiveTabId] = useState(tabs[0].id);
  const [showGoToLine, setShowGoToLine] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState('');
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol, setCursorCol] = useState(1);
  const [findText, setFindText] = useState('');
  const [showFind, setShowFind] = useState(false);

  const [promptDialog, setPromptDialog] = useState<{
    title: string;
    placeholder: string;
    defaultValue: string;
    onConfirm: (value: string) => void;
  } | null>(null);
  const [promptInput, setPromptInput] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const initialFileHandledRef = useRef(false);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? tabs[0], [tabs, activeTabId]);

  const openFile = useCallback(async (filePath: string) => {
    const existingTab = tabs.find((t) => t.filePath === filePath);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    const newTab: NotepadTab = {
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      fileName: getFileNameFromPath(filePath),
      content: '',
      originalContent: '',
      language: getLanguage(getFileNameFromPath(filePath)),
      isLoading: true,
      error: '',
    };

    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);

    try {
      const content = await window.guiSSH!.connections.readFile(connectionId, filePath);
      setTabs((prev) => prev.map((t) => t.id === newTab.id
        ? { ...t, content, originalContent: content, isLoading: false }
        : t,
      ));
    } catch (error) {
      setTabs((prev) => prev.map((t) => t.id === newTab.id
        ? { ...t, isLoading: false, error: getErrorMessage(error) }
        : t,
      ));
    }
  }, [connectionId, tabs]);

  useEffect(() => {
    if (initialFilePath && !initialFileHandledRef.current) {
      initialFileHandledRef.current = true;
      void openFile(initialFilePath);
    }
  }, [initialFilePath, openFile]);

  const activeContent = activeTab.content;
  const highlightedHtml = useMemo(() => {
    if (!activeContent) return '';
    try {
      const result = hljs.highlight(activeContent, { language: activeTab.language, ignoreIllegals: true });
      return result.value;
    } catch {
      return activeContent
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  }, [activeContent, activeTab.language]);

  const isDirty = useMemo(() => {
    return tabs.map((t) => t.content !== t.originalContent);
  }, [tabs]);

  const handleNewFile = useCallback(() => {
    const newTab = createNewTab();
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const handleSave = useCallback(async () => {
    if (!activeTab) return;

    if (!activeTab.filePath) {
      setPromptDialog({
        title: '保存文件',
        placeholder: '请输入远程绝对路径，如 /home/user/file.txt',
        defaultValue: '',
        onConfirm: async (filePath) => {
          if (!filePath) return;
          const fileName = getFileNameFromPath(filePath);
          try {
            await window.guiSSH!.connections.writeFile(connectionId, filePath, activeTab.content);
            setTabs((prev) => prev.map((t) => t.id === activeTab.id
              ? { ...t, filePath, fileName, originalContent: t.content, language: getLanguage(fileName), error: '' }
              : t,
            ));
          } catch (error) {
            setTabs((prev) => prev.map((t) => t.id === activeTab.id
              ? { ...t, error: `保存失败：${getErrorMessage(error)}` }
              : t,
            ));
          }
        },
      });
      setPromptInput('');
      return;
    }

    try {
      await window.guiSSH!.connections.writeFile(connectionId, activeTab.filePath, activeTab.content);
      setTabs((prev) => prev.map((t) => t.id === activeTab.id
        ? { ...t, originalContent: t.content, error: '' }
        : t,
      ));
    } catch (error) {
      setTabs((prev) => prev.map((t) => t.id === activeTab.id
        ? { ...t, error: `保存失败：${getErrorMessage(error)}` }
        : t,
      ));
    }
  }, [activeTab, connectionId]);

  const handleSaveAs = useCallback(() => {
    if (!activeTab) return;

    setPromptDialog({
      title: '另存为',
      placeholder: '请输入远程绝对路径',
      defaultValue: activeTab.filePath || '',
      onConfirm: async (filePath) => {
        if (!filePath) return;
        const fileName = getFileNameFromPath(filePath);
        try {
          await window.guiSSH!.connections.writeFile(connectionId, filePath, activeTab.content);
          setTabs((prev) => prev.map((t) => t.id === activeTab.id
            ? { ...t, filePath, fileName, originalContent: t.content, language: getLanguage(fileName), error: '' }
            : t,
          ));
        } catch (error) {
          setTabs((prev) => prev.map((t) => t.id === activeTab.id
            ? { ...t, error: `保存失败：${getErrorMessage(error)}` }
            : t,
          ));
        }
      },
    });
    setPromptInput(activeTab.filePath || '');
  }, [activeTab, connectionId]);

  const handleCloseTab = useCallback((tabId: string) => {
    const tabToClose = tabs.find((t) => t.id === tabId);
    if (!tabToClose) return;

    const doClose = () => {
      const remaining = tabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) {
        const fresh = createNewTab();
        setTabs([fresh]);
        setActiveTabId(fresh.id);
      } else {
        setTabs(remaining);
        if (activeTabId === tabId) {
          setActiveTabId(remaining[remaining.length - 1].id);
        }
      }
    };

    const tabDirty = tabToClose.content !== tabToClose.originalContent;
    if (tabDirty) {
      setConfirmDialog({
        message: `"${tabToClose.fileName}" 有未保存的更改，是否保存？`,
        onConfirm: doClose,
      });
      return;
    }

    doClose();
  }, [tabs, activeTabId, handleSave]);

  const handleContentChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = event.target.value;
    setTabs((prev) => prev.map((t) => t.id === activeTabId
      ? { ...t, content: newContent }
      : t,
    ));
  }, [activeTabId]);

  const updateCursorPosition = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const pos = textarea.selectionStart;
    const textBefore = textarea.value.slice(0, pos);
    const lines = textBefore.split('\n');
    setCursorLine(lines.length);
    setCursorCol(lines[lines.length - 1].length + 1);
  }, []);

  const handleTextareaKeyUp = useCallback(() => {
    updateCursorPosition();
  }, [updateCursorPosition]);

  const handleTextareaMouseUp = useCallback(() => {
    updateCursorPosition();
  }, [updateCursorPosition]);

  const handleTextareaScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const highlight = highlightRef.current;
    if (textarea && highlight) {
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    }
  }, []);

  const handleGoToLine = useCallback(() => {
    const lineNum = parseInt(goToLineValue, 10);
    const textarea = textareaRef.current;
    if (!textarea || isNaN(lineNum) || lineNum < 1) {
      setShowGoToLine(false);
      return;
    }

    const lines = activeTab.content.split('\n');
    const targetLine = Math.min(lineNum, lines.length);
    let pos = 0;
    for (let i = 0; i < targetLine - 1; i++) {
      pos += lines[i].length + 1;
    }

    textarea.focus();
    textarea.setSelectionRange(pos, pos);
    const lineHeight = 20;
    textarea.scrollTop = (targetLine - 5) * lineHeight;
    setCursorLine(targetLine);
    setCursorCol(1);
    setShowGoToLine(false);
    setGoToLineValue('');
  }, [goToLineValue, activeTab.content]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent) => {
    const isMod = event.ctrlKey || event.metaKey;

    if (isMod && event.key === 's') {
      event.preventDefault();
      if (event.shiftKey) {
        void handleSaveAs();
      } else {
        void handleSave();
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
      setPromptDialog({
        title: '打开文件',
        placeholder: '请输入远程文件路径',
        defaultValue: '',
        onConfirm: (filePath) => {
          if (filePath) void openFile(filePath);
        },
      });
      setPromptInput('');
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
      setShowFind(true);
      setTimeout(() => findInputRef.current?.focus(), 0);
      return;
    }

    if (event.key === 'Escape') {
      setShowGoToLine(false);
      setShowFind(false);
    }

    if (event.key === 'Tab' && event.target === textareaRef.current) {
      event.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;
      const newValue = `${value.slice(0, start)}  ${value.slice(end)}`;
      setTabs((prev) => prev.map((t) => t.id === activeTabId ? { ...t, content: newValue } : t));
      requestAnimationFrame(() => {
        textarea.selectionStart = start + 2;
        textarea.selectionEnd = start + 2;
      });
    }
  }, [handleSave, handleSaveAs, handleNewFile, openFile, activeTabId]);

  const handleFindNext = useCallback(() => {
    if (!findText || !textareaRef.current) return;
    const textarea = textareaRef.current;
    const pos = textarea.value.indexOf(findText, textarea.selectionEnd);
    if (pos >= 0) {
      textarea.focus();
      textarea.setSelectionRange(pos, pos + findText.length);
      const lineHeight = 20;
      const lineNum = textarea.value.slice(0, pos).split('\n').length;
      textarea.scrollTop = (lineNum - 5) * lineHeight;
    } else {
      const wrapPos = textarea.value.indexOf(findText);
      if (wrapPos >= 0) {
        textarea.focus();
        textarea.setSelectionRange(wrapPos, wrapPos + findText.length);
      }
    }
  }, [findText]);

  const lineCount = useMemo(() => {
    if (!activeTab) return 0;
    return activeTab.content.split('\n').length;
  }, [activeTab]);

  return (
    <div className="notepad-root" onKeyDown={handleKeyDown}>
      <div className="notepad-toolbar">
        <div className="notepad-toolbar-group">
          <button type="button" className="notepad-tool-btn" onClick={handleNewFile} title="新建 (Ctrl+N)">新建</button>
          <button type="button" className="notepad-tool-btn" onClick={() => {
            setPromptDialog({
              title: '打开文件',
              placeholder: '请输入远程文件路径',
              defaultValue: '',
              onConfirm: (filePath) => {
                if (filePath) void openFile(filePath);
              },
            });
            setPromptInput('');
          }} title="打开 (Ctrl+O)">打开</button>
          <button type="button" className="notepad-tool-btn" onClick={() => void handleSave()} title="保存 (Ctrl+S)">保存</button>
          <button type="button" className="notepad-tool-btn" onClick={() => void handleSaveAs()} title="另存为 (Ctrl+Shift+S)">另存为</button>
        </div>
        <div className="notepad-toolbar-group">
          <button type="button" className="notepad-tool-btn" onClick={() => setShowFind(true)} title="查找 (Ctrl+F)">查找</button>
          <button type="button" className="notepad-tool-btn" onClick={() => setShowGoToLine(true)} title="跳转 (Ctrl+G)">跳转</button>
        </div>
      </div>

      <div className="notepad-tabs">
        {tabs.map((tab, index) => {
          const dirty = tab.content !== tab.originalContent;
          return (
            <button
              key={tab.id}
              type="button"
              className={`notepad-tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => setActiveTabId(tab.id)}
              title={tab.filePath || tab.fileName}
            >
              <span className="notepad-tab-name">
                {dirty ? '• ' : ''}{tab.fileName}
              </span>
              <span
                className="notepad-tab-close"
                onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id); }}
                role="button"
                tabIndex={-1}
                aria-label={`关闭 ${tab.fileName}`}
              >
                ×
              </span>
            </button>
          );
        })}
        <button
          type="button"
          className="notepad-tab notepad-tab-add"
          onClick={handleNewFile}
          title="新建文件"
        >
          +
        </button>
      </div>

      {showFind && (
        <div className="notepad-find-bar">
          <input
            ref={findInputRef}
            type="text"
            className="notepad-find-input"
            placeholder="查找..."
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleFindNext();
              if (e.key === 'Escape') setShowFind(false);
            }}
          />
          <button type="button" className="notepad-tool-btn" onClick={handleFindNext}>下一个</button>
          <button type="button" className="notepad-tool-btn" onClick={() => setShowFind(false)}>关闭</button>
        </div>
      )}

      {showGoToLine && (
        <div className="notepad-find-bar">
          <span className="notepad-find-label">跳转到行：</span>
          <input
            ref={goToLineInputRef}
            type="number"
            className="notepad-find-input"
            min={1}
            max={lineCount}
            value={goToLineValue}
            onChange={(e) => setGoToLineValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleGoToLine();
              if (e.key === 'Escape') setShowGoToLine(false);
            }}
          />
          <span className="notepad-find-hint">/ {lineCount}</span>
          <button type="button" className="notepad-tool-btn" onClick={handleGoToLine}>跳转</button>
          <button type="button" className="notepad-tool-btn" onClick={() => setShowGoToLine(false)}>关闭</button>
        </div>
      )}

      {activeTab.error && (
        <div className="notepad-error">{activeTab.error}</div>
      )}

      {activeTab.isLoading ? (
        <div className="notepad-loading">正在加载文件...</div>
      ) : (
        <div className="notepad-editor-wrap">
          <div className="notepad-line-numbers" aria-hidden="true">
            {Array.from({ length: lineCount }, (_, i) => (
              <span key={i + 1} className={cursorLine === i + 1 ? 'active' : ''}>{i + 1}</span>
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
              onKeyUp={handleTextareaKeyUp}
              onMouseUp={handleTextareaMouseUp}
              onScroll={handleTextareaScroll}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              wrap="off"
            />
          </div>
        </div>
      )}

      <div className="notepad-statusbar">
        <span>行 {cursorLine}, 列 {cursorCol}</span>
        <span>{lineCount} 行</span>
        <span>{activeTab.language}</span>
        <span>UTF-8</span>
        {activeTab.filePath && <span className="notepad-statusbar-path" title={activeTab.filePath}>{activeTab.filePath}</span>}
      </div>

      {promptDialog && (
        <div className="notepad-modal-overlay" onClick={() => setPromptDialog(null)}>
          <div className="notepad-modal" onClick={(e) => e.stopPropagation()}>
            <div className="notepad-modal-title">{promptDialog.title}</div>
            <input
              type="text"
              className="notepad-modal-input"
              placeholder={promptDialog.placeholder}
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const dialog = promptDialog;
                  setPromptDialog(null);
                  dialog.onConfirm(promptInput);
                }
                if (e.key === 'Escape') setPromptDialog(null);
              }}
              autoFocus
            />
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => setPromptDialog(null)}>取消</button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => {
                const dialog = promptDialog;
                setPromptDialog(null);
                dialog.onConfirm(promptInput);
              }}>确定</button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="notepad-modal-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="notepad-modal" onClick={(e) => e.stopPropagation()}>
            <div className="notepad-modal-title">确认</div>
            <div className="notepad-modal-message">{confirmDialog.message}</div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => {
                confirmDialog.onConfirm();
                setConfirmDialog(null);
              }}>不保存并关闭</button>
              <button type="button" className="notepad-modal-btn" onClick={() => setConfirmDialog(null)}>取消</button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => {
                setConfirmDialog(null);
                void handleSave();
              }}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { isTextFile };
export default RemoteNotepad;
