import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Save,
  Send,
  Terminal,
  X,
} from 'lucide-react';

import { createSharedTools, getDefaultChatPrompt, usePiAgent } from '../../ai';
import { t, type AppLanguage } from '../../i18n';
import { getErrorMessage } from './desktopUtils';
import {
  CODE_EDITOR_DIRECTORY_WATCH_INTERVAL_MS,
  CODE_EDITOR_FILE_WATCH_INTERVAL_MS,
  CODE_EDITOR_MAX_WATCHED_FILES,
  CODE_EDITOR_MAX_WATCHED_DIRECTORIES,
  createDirectoryEntriesSignature,
} from './directoryWatchUtils';
import { MarkdownMessage } from './RemoteAiChat';
import { resolveRemoteHomeDirectory } from './RemoteFileExplorer';
import RemoteFilePicker from './RemoteFilePicker';
import { listDirectory } from './fileExplorerSftp';
import type { RemoteDirectoryResult, RemoteFileEntry } from './fileExplorerTypes';
import { detectLanguageFromContent } from './notepadLanguageDetection';
import NotepadEditor from './NotepadEditor';
import { loadRemoteConnectionProfile, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import { isWindowsSystem } from './remoteSystem';
import RemoteTerminal from './RemoteTerminal';
import type { RemoteTerminalSessionState } from './terminalTypes';
import type { RemoteSystemType } from './types';

interface RemoteCodeEditorProps {
  connectionId: string;
  connectionKind?: 'ssh' | 'local';
  hostId: string;
  settings: ShellDeskAppSettings;
  systemType?: RemoteSystemType;
  onSettingsChange?: (settings: ShellDeskAppSettings) => void;
}

interface CodeEditorTreeNode {
  path: string;
  name: string;
  type: RemoteFileEntry['type'];
  size: number;
}

interface CodeEditorTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  language: string;
  dirty: boolean;
  loading: boolean;
  error: string;
  remoteChanged: boolean;
}

interface CodeEditorTerminalTab {
  id: string;
  title: string;
  workingDirectory: string;
}

const ignoredDirectoryNames = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'target',
  'vendor',
  '__pycache__',
]);

const codeEditorProfileKey = 'projectRoot';

function trimTrailingSlash(path: string) {
  return path.length > 1 ? path.replace(/[\\/]+$/u, '') : path;
}

function fileNameFromPath(path: string) {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) || path;
}

function joinRemotePath(basePath: string, name: string) {
  const separator = basePath.includes('\\') ? '\\' : '/';

  if (!basePath || basePath === '.') {
    return name;
  }

  if (basePath === '/' || /^[A-Z]:\\?$/iu.test(basePath)) {
    return `${basePath.replace(/[\\/]+$/u, '')}${separator}${name}`;
  }

  return `${trimTrailingSlash(basePath)}${separator}${name}`;
}

function relativeProjectPath(rootPath: string, filePath: string) {
  const root = trimTrailingSlash(rootPath);
  const file = filePath.replace(/\\/gu, '/');
  const normalizedRoot = root.replace(/\\/gu, '/');

  if (file === normalizedRoot) {
    return '.';
  }

  return file.startsWith(`${normalizedRoot}/`) ? file.slice(normalizedRoot.length + 1) : fileNameFromPath(filePath);
}

function parseGitignore(content: string) {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .slice(0, 300);
}

function globToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.');
  return new RegExp(`^${escaped}$`, 'u');
}

function isIgnoredByPatterns(relativePath: string, name: string, patterns: string[]) {
  const normalized = relativePath.replace(/\\/gu, '/');

  return patterns.some((pattern) => {
    const cleanPattern = pattern.replace(/^\//u, '').replace(/\/$/u, '');

    if (!cleanPattern) {
      return false;
    }

    if (!cleanPattern.includes('*') && !cleanPattern.includes('?')) {
      return name === cleanPattern || normalized === cleanPattern || normalized.startsWith(`${cleanPattern}/`) || normalized.endsWith(`/${cleanPattern}`);
    }

    return globToRegExp(cleanPattern).test(name) || globToRegExp(cleanPattern).test(normalized);
  });
}

function sortEntries(entries: RemoteFileEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

function createTreeNodes(result: RemoteDirectoryResult, rootPath: string, patterns: string[]) {
  return sortEntries(result.entries)
    .filter((entry) => !ignoredDirectoryNames.has(entry.name))
    .filter((entry) => {
      const childPath = joinRemotePath(result.path, entry.name);
      return !isIgnoredByPatterns(relativeProjectPath(rootPath, childPath), entry.name, patterns);
    })
    .map<CodeEditorTreeNode>((entry) => ({
      path: joinRemotePath(result.path, entry.name),
      name: entry.name,
      type: entry.type,
      size: entry.size,
    }));
}

function createTerminalId() {
  return `code-editor-terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTerminalTab(workingDirectory: string, index: number): CodeEditorTerminalTab {
  return {
    id: createTerminalId(),
    title: `Terminal ${index}`,
    workingDirectory,
  };
}

function createCodingPrompt(projectRoot: string) {
  return `${getDefaultChatPrompt()}

You are currently embedded in ShellDesk Code Editor.
Project root: ${projectRoot}

Use available tools to inspect files and run commands when the user asks coding questions. Prefer reading existing files before editing. Keep edits scoped to the project and explain changed files briefly.`;
}

function CodeEditorAiPanel({
  connectionId,
  language,
  onCollapse,
  projectRoot,
  settings,
  systemType,
}: {
  connectionId: string;
  language: AppLanguage;
  onCollapse: () => void;
  projectRoot: string;
  settings: ShellDeskAppSettings;
  systemType?: RemoteSystemType;
}) {
  const [draft, setDraft] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const tools = useMemo(() => createSharedTools(connectionId, { systemType }), [connectionId, systemType]);
  const {
    messages,
    isBusy,
    busyText,
    error,
    isConfigured,
    sendMessage,
    cancelRequest,
    clearHistory,
  } = usePiAgent({
    settings,
    language,
    systemPrompt: createCodingPrompt(projectRoot),
    tools,
    connectionId,
  });

  const submit = useCallback(() => {
    const prompt = draft.trim();

    if (!prompt || isBusy || !isConfigured) {
      return;
    }

    setDraft('');
    void sendMessage(`${prompt}\n\nProject root: ${projectRoot}`);
  }, [draft, isBusy, isConfigured, projectRoot, sendMessage]);

  const retryPrompt = useCallback((messageId: string, content: string) => {
    if (isBusy || !isConfigured) {
      return;
    }

    void sendMessage(content, { retryFromMessageId: messageId });
  }, [isBusy, isConfigured, sendMessage]);

  const messagesScrollKey = messages.map((message) => `${message.id}:${message.content}`).join('\x1e');

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const messagesElement = messagesRef.current;

      if (messagesElement) {
        messagesElement.scrollTop = messagesElement.scrollHeight;
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [busyText, error, isBusy, messagesScrollKey]);

  return (
    <aside className="code-editor-ai">
      <header>
        <span><Bot size={15} />{t('codeEditor.ai.title', language)}</span>
        <div className="code-editor-ai-actions">
          <button type="button" onClick={clearHistory}>{t('codeEditor.ai.clear', language)}</button>
          <button type="button" onClick={onCollapse} title={t('codeEditor.ai.hide', language)}>
            <PanelRightClose size={14} />
          </button>
        </div>
      </header>
      <div className="code-editor-ai-messages" ref={messagesRef}>
        {!isConfigured ? <div className="code-editor-ai-empty">{t('auto.aiChat.notConfiguredSummary', language)}</div> : null}
        {messages.length === 0 && isConfigured ? <div className="code-editor-ai-empty">{t('codeEditor.ai.empty', language)}</div> : null}
        {messages.map((message) => (
          <article key={message.id} className={`code-editor-ai-message ${message.role}`}>
            <div className="code-editor-ai-message-meta">
              <span>{message.role === 'assistant' ? t('auto.aiChat.assistant', language) : t('auto.aiChat.user', language)}</span>
              {message.role === 'user' ? (
                <button
                  type="button"
                  onClick={() => retryPrompt(message.id, message.content)}
                  disabled={isBusy || !isConfigured}
                  title={t('codeEditor.ai.retry', language)}
                >
                  <RefreshCw size={12} />
                  {t('codeEditor.ai.retry', language)}
                </button>
              ) : null}
            </div>
            {message.role === 'assistant'
              ? <MarkdownMessage content={message.content} />
              : <p data-i18n-skip>{message.content}</p>}
          </article>
        ))}
        {isBusy ? <div className="code-editor-ai-thinking">{busyText || t('auto.aiChat.thinking', language)}</div> : null}
      </div>
      {error ? <div className="code-editor-ai-error">{error}</div> : null}
      <footer>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t('codeEditor.ai.placeholder', language)}
          disabled={!isConfigured}
        />
        <button type="button" onClick={isBusy ? cancelRequest : submit} disabled={!isBusy && (!draft.trim() || !isConfigured)}>
          {isBusy ? <X size={14} /> : <Send size={14} />}
        </button>
      </footer>
    </aside>
  );
}

export default function RemoteCodeEditor({
  connectionId,
  connectionKind,
  hostId,
  settings,
  systemType,
  onSettingsChange,
}: RemoteCodeEditorProps) {
  const language = settings.language;
  const isWindowsHost = useMemo(() => isWindowsSystem(systemType), [systemType]);
  const [projectRoot, setProjectRoot] = useState('.');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(['.']));
  const [directoryChildren, setDirectoryChildren] = useState<Record<string, CodeEditorTreeNode[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [gitignorePatterns, setGitignorePatterns] = useState<string[]>([]);
  const [tabs, setTabs] = useState<CodeEditorTab[]>([]);
  const [activePath, setActivePath] = useState('');
  const [error, setError] = useState('');
  const [filePickerVisible, setFilePickerVisible] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(true);
  const [aiCollapsed, setAiCollapsed] = useState(false);
  const [terminalTabs, setTerminalTabs] = useState<CodeEditorTerminalTab[]>(() => [createTerminalTab('.', 1)]);
  const [activeTerminalId, setActiveTerminalId] = useState(() => terminalTabs[0]?.id ?? '');
  const [terminalSessionStates, setTerminalSessionStates] = useState<Record<string, RemoteTerminalSessionState>>({});
  const initializedRef = useRef(false);
  const directorySignaturesRef = useRef<Record<string, string>>({});
  const loadingPathsRef = useRef<Set<string>>(new Set());
  const tabsRef = useRef<CodeEditorTab[]>([]);
  const activePathRef = useRef('');
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === activeTerminalId) ?? terminalTabs[0] ?? null;

  const addTerminalTab = useCallback((workingDirectory = projectRoot) => {
    setTerminalTabs((current) => {
      const nextTab = createTerminalTab(workingDirectory || '.', current.length + 1);
      setActiveTerminalId(nextTab.id);
      return [...current, nextTab];
    });
    setTerminalCollapsed(false);
  }, [projectRoot]);

  const closeTerminalTab = useCallback((terminalId: string) => {
    setTerminalTabs((current) => {
      const terminalIndex = current.findIndex((terminalTab) => terminalTab.id === terminalId);

      if (terminalIndex <= 0) {
        return current;
      }

      const next = current.filter((terminalTab) => terminalTab.id !== terminalId);

      if (activeTerminalId === terminalId) {
        setActiveTerminalId(next[Math.max(0, terminalIndex - 1)]?.id ?? next[0]?.id ?? '');
      }

      setTerminalSessionStates((currentStates) => {
        const { [terminalId]: _removed, ...remainingStates } = currentStates;
        return remainingStates;
      });

      return next;
    });
  }, [activeTerminalId]);

  const updateActiveTerminalDirectory = useCallback((nextRoot: string) => {
    if (!activeTerminalTab) {
      addTerminalTab(nextRoot);
      return;
    }

    const sessionState = terminalSessionStates[activeTerminalTab.id];

    if (sessionState?.hasForegroundTask) {
      addTerminalTab(nextRoot);
      return;
    }

    const nextTerminalId = createTerminalId();

    setTerminalTabs((current) => current.map((tab) => (
      tab.id === activeTerminalTab.id
        ? { ...tab, id: nextTerminalId, workingDirectory: nextRoot }
        : tab
    )));
    setActiveTerminalId(nextTerminalId);
    setTerminalSessionStates((currentStates) => {
      const { [activeTerminalTab.id]: _removed, ...remainingStates } = currentStates;
      return remainingStates;
    });
  }, [activeTerminalTab, addTerminalTab, terminalSessionStates]);

  const loadDirectory = useCallback(async (path: string, rootOverride = projectRoot, patternsOverride = gitignorePatterns) => {
    setLoadingPaths((current) => new Set(current).add(path));
    setError('');

    try {
      const result = await listDirectory(connectionId, path);
      const children = createTreeNodes(result, rootOverride, patternsOverride);

      directorySignaturesRef.current[path] = createDirectoryEntriesSignature(result.entries);
      setDirectoryChildren((current) => ({
        ...current,
        [path]: children,
      }));
      return true;
    } catch (loadError) {
      setError(getErrorMessage(loadError));
      return false;
    } finally {
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
    }
  }, [connectionId, gitignorePatterns, projectRoot]);

  const openProject = useCallback(async (path: string, options: { persist?: boolean; syncTerminal?: boolean } = {}) => {
    const { persist = true, syncTerminal = true } = options;
    const nextRoot = path.trim() || '.';
    setProjectRoot(nextRoot);
    setTabs([]);
    setActivePath('');
    directorySignaturesRef.current = {};
    setDirectoryChildren({});
    setExpandedPaths(new Set([nextRoot]));
    setError('');

    let patterns: string[] = [];

    try {
      const gitignore = await window.guiSSH?.connections.readFile(connectionId, joinRemotePath(nextRoot, '.gitignore'));
      patterns = parseGitignore(gitignore || '');
    } catch {
      patterns = [];
    }

    setGitignorePatterns(patterns);
    const loaded = await loadDirectory(nextRoot, nextRoot, patterns);
    if (!loaded) {
      return false;
    }

    if (syncTerminal) {
      updateActiveTerminalDirectory(nextRoot);
    }

    if (persist) {
      void saveRemoteConnectionProfile(hostId, 'code-editor', {
        [codeEditorProfileKey]: nextRoot,
      }).catch(() => undefined);
    }

    return true;
  }, [connectionId, hostId, loadDirectory, updateActiveTerminalDirectory]);

  useEffect(() => {
    if (initializedRef.current) {
      return;
    }

    initializedRef.current = true;
    void (async () => {
      const profile = await loadRemoteConnectionProfile(hostId, 'code-editor');
      const savedProjectRoot = readProfileString(profile, codeEditorProfileKey, '').trim();
      if (savedProjectRoot && await openProject(savedProjectRoot, { persist: false })) {
        return;
      }

      let initialPath = '.';
      try {
        initialPath = await resolveRemoteHomeDirectory(connectionId, isWindowsHost) || '.';
      } catch {
        initialPath = '.';
      }
      await openProject(initialPath);
    })();
  }, [connectionId, hostId, isWindowsHost, openProject]);

  useEffect(() => {
    loadingPathsRef.current = loadingPaths;
  }, [loadingPaths]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    if (!window.guiSSH?.connections) {
      return;
    }

    let cancelled = false;
    let polling = false;

    const pollExpandedDirectories = async () => {
      if (cancelled || polling || document.visibilityState === 'hidden') {
        return;
      }

      const watchedPaths = [...expandedPaths]
        .filter((path) => directoryChildren[path] && !loadingPathsRef.current.has(path))
        .slice(0, CODE_EDITOR_MAX_WATCHED_DIRECTORIES);

      if (!watchedPaths.length) {
        return;
      }

      polling = true;

      try {
        const changedDirectories: Record<string, CodeEditorTreeNode[]> = {};
        const changedSignatures: Record<string, string> = {};

        for (const path of watchedPaths) {
          if (cancelled) {
            return;
          }

          try {
            const result = await listDirectory(connectionId, path);
            const nextSignature = createDirectoryEntriesSignature(result.entries);

            if (nextSignature !== directorySignaturesRef.current[path]) {
              changedSignatures[path] = nextSignature;
              changedDirectories[path] = createTreeNodes(result, projectRoot, gitignorePatterns);
            }
          } catch {
            // Polling is best effort; explicit expand/refresh still reports errors.
          }
        }

        if (cancelled || !Object.keys(changedDirectories).length) {
          return;
        }

        directorySignaturesRef.current = {
          ...directorySignaturesRef.current,
          ...changedSignatures,
        };
        setDirectoryChildren((current) => ({
          ...current,
          ...changedDirectories,
        }));
      } finally {
        polling = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void pollExpandedDirectories();
    }, CODE_EDITOR_DIRECTORY_WATCH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [connectionId, directoryChildren, expandedPaths, gitignorePatterns, projectRoot]);

  useEffect(() => {
    if (!window.guiSSH?.connections) {
      return;
    }

    let cancelled = false;
    let polling = false;

    const pollOpenFiles = async () => {
      if (cancelled || polling || document.visibilityState === 'hidden') {
        return;
      }

      const activeFilePath = activePathRef.current;
      const watchedTabs = tabsRef.current
        .filter((tab) => !tab.loading && !tab.error)
        .sort((left, right) => {
          if (left.path === activeFilePath) return -1;
          if (right.path === activeFilePath) return 1;
          return 0;
        })
        .slice(0, CODE_EDITOR_MAX_WATCHED_FILES);

      if (!watchedTabs.length) {
        return;
      }

      polling = true;

      try {
        for (const tab of watchedTabs) {
          if (cancelled) {
            return;
          }

          let remoteContent = '';

          try {
            remoteContent = await window.guiSSH!.connections.readFile(connectionId, tab.path);
          } catch {
            continue;
          }

          if (cancelled) {
            return;
          }

          setTabs((current) => current.map((currentTab) => {
            if (currentTab.path !== tab.path || currentTab.loading || currentTab.error || remoteContent === currentTab.savedContent) {
              return currentTab;
            }

            if (remoteContent === currentTab.content) {
              return {
                ...currentTab,
                savedContent: remoteContent,
                dirty: false,
                remoteChanged: false,
                language: detectLanguageFromContent(remoteContent),
              };
            }

            if (currentTab.dirty) {
              return {
                ...currentTab,
                savedContent: remoteContent,
                remoteChanged: true,
              };
            }

            return {
              ...currentTab,
              content: remoteContent,
              savedContent: remoteContent,
              dirty: false,
              remoteChanged: false,
              language: detectLanguageFromContent(remoteContent),
            };
          }));
        }
      } finally {
        polling = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void pollOpenFiles();
    }, CODE_EDITOR_FILE_WATCH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [connectionId]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);

      if (next.has(path)) {
        next.delete(path);
        return next;
      }

      next.add(path);
      if (!directoryChildren[path]) {
        void loadDirectory(path);
      }
      return next;
    });
  }, [directoryChildren, loadDirectory]);

  const openFile = useCallback(async (path: string) => {
    const existingTab = tabs.find((tab) => tab.path === path);

    if (existingTab) {
      setActivePath(path);
      return;
    }

    const name = fileNameFromPath(path);
    const loadingTab: CodeEditorTab = {
      path,
      name,
      content: '',
      savedContent: '',
      language: 'plaintext',
      dirty: false,
      loading: true,
      error: '',
      remoteChanged: false,
    };

    setTabs((current) => [...current, loadingTab]);
    setActivePath(path);
    setError('');

    try {
      const content = await window.guiSSH!.connections.readFile(connectionId, path);
      setTabs((current) => current.map((tab) => (
        tab.path === path
          ? {
              ...tab,
              content,
              savedContent: content,
              language: detectLanguageFromContent(content),
              loading: false,
              remoteChanged: false,
            }
          : tab
      )));
    } catch (readError) {
      setTabs((current) => current.map((tab) => (
        tab.path === path ? { ...tab, loading: false, error: getErrorMessage(readError) } : tab
      )));
    }
  }, [connectionId, tabs]);

  const closeTab = useCallback((path: string) => {
    setTabs((current) => {
      const tabIndex = current.findIndex((tab) => tab.path === path);
      const next = current.filter((tab) => tab.path !== path);

      if (activePath === path) {
        setActivePath(next[Math.max(0, tabIndex - 1)]?.path ?? next[0]?.path ?? '');
      }

      return next;
    });
  }, [activePath]);

  const saveActiveFile = useCallback(async () => {
    if (!activeTab || activeTab.loading) {
      return;
    }

    setError('');

    try {
      await window.guiSSH!.connections.writeFile(connectionId, activeTab.path, activeTab.content);
      setTabs((current) => current.map((tab) => (
        tab.path === activeTab.path ? { ...tab, savedContent: tab.content, dirty: false, remoteChanged: false } : tab
      )));
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    }
  }, [activeTab, connectionId]);

  const updateActiveContent = useCallback((content: string) => {
    if (!activeTab) {
      return;
    }

    setTabs((current) => current.map((tab) => (
      tab.path === activeTab.path
        ? {
            ...tab,
            content,
            dirty: content !== tab.savedContent,
            remoteChanged: content !== tab.savedContent && tab.remoteChanged,
            language: detectLanguageFromContent(content),
          }
        : tab
    )));
  }, [activeTab]);

  const reloadActiveRemoteVersion = useCallback(() => {
    if (!activeTab) {
      return;
    }

    setTabs((current) => current.map((tab) => (
      tab.path === activeTab.path
        ? {
            ...tab,
            content: tab.savedContent,
            dirty: false,
            remoteChanged: false,
            language: detectLanguageFromContent(tab.savedContent),
          }
        : tab
    )));
  }, [activeTab]);

  const renderTreeNode = useCallback((node: CodeEditorTreeNode, depth: number) => {
    const isDirectory = node.type === 'directory';
    const expanded = expandedPaths.has(node.path);
    const loading = loadingPaths.has(node.path);
    const children = directoryChildren[node.path] ?? [];

    return (
      <div key={node.path}>
        <button
          type="button"
          className={`code-editor-tree-row ${activePath === node.path ? 'active' : ''}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => (isDirectory ? toggleDirectory(node.path) : void openFile(node.path))}
        >
          {isDirectory ? (
            <ChevronRight className={expanded ? 'expanded' : ''} size={13} />
          ) : <span className="code-editor-tree-spacer" />}
          {isDirectory ? (expanded ? <FolderOpen size={15} /> : <Folder size={15} />) : <File size={15} />}
          <span>{node.name}</span>
        </button>
        {isDirectory && expanded ? (
          <div>
            {loading ? <div className="code-editor-tree-loading" style={{ paddingLeft: `${24 + depth * 14}px` }}>{t('codeEditor.tree.loading', language)}</div> : null}
            {children.map((child) => renderTreeNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }, [activePath, directoryChildren, expandedPaths, language, loadingPaths, openFile, toggleDirectory]);

  return (
    <div className={`remote-code-editor ${terminalCollapsed ? 'terminal-collapsed' : ''} ${aiCollapsed ? 'ai-collapsed' : ''}`}>
      <header className="code-editor-topbar">
        <div className="code-editor-project">
          <span>{t('codeEditor.root.label', language)}</span>
          <code className="code-editor-project-path" title={projectRoot}>{projectRoot}</code>
          <button type="button" onClick={() => setFilePickerVisible(true)}>
            <FolderOpen size={14} />{t('codeEditor.root.open', language)}
          </button>
        </div>
        <button type="button" onClick={() => void loadDirectory(projectRoot)}>
          <RefreshCw size={14} />{t('codeEditor.refresh', language)}
        </button>
        <button type="button" onClick={() => void saveActiveFile()} disabled={!activeTab?.dirty || activeTab.loading}>
          <Save size={14} />{t('codeEditor.save', language)}
        </button>
        <button type="button" onClick={() => setTerminalCollapsed((collapsed) => !collapsed)}>
          {terminalCollapsed ? <PanelBottomOpen size={14} /> : <PanelBottomClose size={14} />}
          {terminalCollapsed ? t('codeEditor.terminal.show', language) : t('codeEditor.terminal.hide', language)}
        </button>
        <button type="button" onClick={() => setAiCollapsed((collapsed) => !collapsed)}>
          {aiCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
          {aiCollapsed ? t('codeEditor.ai.show', language) : t('codeEditor.ai.hide', language)}
        </button>
      </header>

      {error ? <div className="code-editor-error">{error}</div> : null}

      <main className="code-editor-layout">
        <aside className="code-editor-tree">
          <div className="code-editor-tree-title">{t('codeEditor.files', language)}</div>
          {renderTreeNode({ path: projectRoot, name: projectRoot, type: 'directory', size: 0 }, 0)}
        </aside>

        <section className="code-editor-workbench">
          <div className="code-editor-tabs">
            {tabs.length === 0 ? <span className="code-editor-tabs-empty">{t('codeEditor.tabs.empty', language)}</span> : null}
            {tabs.map((tab) => (
              <button
                type="button"
                key={tab.path}
                className={tab.path === activePath ? 'active' : undefined}
                onClick={() => setActivePath(tab.path)}
                title={tab.path}
              >
                <span>{tab.dirty ? '● ' : ''}{tab.remoteChanged ? '! ' : ''}{tab.name}</span>
                <X size={13} onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.path);
                }} />
              </button>
            ))}
          </div>

          <div className="code-editor-editor">
            {activeTab ? (
              activeTab.loading ? (
                <div className="code-editor-placeholder">{t('codeEditor.file.loading', language)}</div>
              ) : activeTab.error ? (
                <div className="code-editor-placeholder error">{activeTab.error}</div>
              ) : (
                <>
                  {activeTab.remoteChanged ? (
                    <div className="code-editor-file-alert">
                      <span>{t('codeEditor.file.remoteChanged', language)}</span>
                      <button type="button" onClick={reloadActiveRemoteVersion}>
                        <RefreshCw size={13} />{t('codeEditor.file.reloadRemote', language)}
                      </button>
                    </div>
                  ) : null}
                  <div className="code-editor-editor-body">
                    <NotepadEditor
                      ariaLabel={activeTab.name}
                      content={activeTab.content}
                      language={activeTab.language}
                      readOnly={false}
                      theme={settings.theme === 'light' ? 'light' : 'dark'}
                      wrapEnabled={false}
                      onChange={updateActiveContent}
                      onCursorChange={() => undefined}
                    />
                  </div>
                </>
              )
            ) : (
              <div className="code-editor-placeholder">{t('codeEditor.editor.empty', language)}</div>
            )}
          </div>

          <div className="code-editor-terminal">
            <div className="code-editor-terminal-title">
              <span className="code-editor-terminal-label"><Terminal size={14} />{t('codeEditor.terminal', language)}</span>
              <div className="code-editor-terminal-tabs">
                {terminalTabs.map((terminalTab, index) => (
                  <div
                    key={terminalTab.id}
                    className={`code-editor-terminal-tab ${terminalTab.id === activeTerminalId ? 'active' : ''}`}
                    title={terminalTab.workingDirectory}
                  >
                    <button
                      type="button"
                      className="code-editor-terminal-tab-main"
                      onClick={() => {
                        setActiveTerminalId(terminalTab.id);
                        setTerminalCollapsed(false);
                      }}
                    >
                      {t('codeEditor.terminal.tab', language, { index: index + 1 })}
                      {terminalSessionStates[terminalTab.id]?.hasForegroundTask ? ' *' : ''}
                    </button>
                    {index > 0 ? (
                      <button
                        type="button"
                        className="code-editor-terminal-tab-close"
                        title={t('common.close', language)}
                        onClick={() => closeTerminalTab(terminalTab.id)}
                      >
                        <X size={11} />
                      </button>
                    ) : null}
                  </div>
                ))}
                <button
                  type="button"
                  className="code-editor-terminal-add"
                  title={t('codeEditor.terminal.new', language)}
                  onClick={() => addTerminalTab(projectRoot)}
                >
                  <Plus size={13} />
                </button>
              </div>
              <button
                type="button"
                className="code-editor-panel-toggle"
                title={t('codeEditor.terminal.hide', language)}
                onClick={() => setTerminalCollapsed(true)}
              >
                <PanelBottomClose size={14} />
              </button>
            </div>
            <div className="code-editor-terminal-stack">
              {terminalTabs.map((terminalTab) => (
                <div
                  key={terminalTab.id}
                  className={`code-editor-terminal-instance ${terminalTab.id === activeTerminalId ? 'active' : ''}`}
                >
                  <RemoteTerminal
                    connectionId={connectionId}
                    terminalId={terminalTab.id}
                    settings={settings}
                    connectionKind={connectionKind}
                    systemType={systemType}
                    launchOptions={{ title: terminalTab.title, workingDirectory: terminalTab.workingDirectory }}
                    onSessionStateChange={(state) => {
                      setTerminalSessionStates((current) => ({ ...current, [terminalTab.id]: state }));
                    }}
                    onSettingsChange={onSettingsChange}
                  />
                </div>
              ))}
            </div>
          </div>
        </section>

        {!aiCollapsed ? (
          <CodeEditorAiPanel
            connectionId={connectionId}
            language={language}
            onCollapse={() => setAiCollapsed(true)}
            projectRoot={projectRoot}
            settings={settings}
            systemType={systemType}
          />
        ) : null}
      </main>

      <RemoteFilePicker
        connectionId={connectionId}
        systemType={systemType}
        mode="directory"
        title={t('codeEditor.root.selectTitle', language)}
        visible={filePickerVisible}
        initialPath={projectRoot === '.' ? undefined : projectRoot}
        confirmLabel={t('codeEditor.root.open', language)}
        onConfirm={(directoryPath) => {
          setFilePickerVisible(false);
          void openProject(directoryPath);
        }}
        onCancel={() => setFilePickerVisible(false)}
      />
    </div>
  );
}
