import {
  lazy,
  Suspense,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { isAiConfigured as hasAiConfiguration } from '../../ai';
import { t, type AppLanguage } from '../../i18n';
import { getErrorMessage } from './desktopUtils';
import NotepadAiPanel from './NotepadAiPanel';
import type { NotepadEditorHandle } from './NotepadEditor';
import { buildDiffPreview, NotepadDiffPreview } from './notepadDiff';
import {
  getLanguage,
  LANGUAGE_OPTIONS,
  MAX_INTERACTIVE_LANGUAGE_DETECTION_CHARACTERS,
  normalizeLanguage,
} from './notepadLanguageDetection';
import NotepadModals from './NotepadModals';
import type {
  EditorSelectionSnapshot,
  NotepadAiAction,
  NotepadConflictDialog,
  NotepadDiffDialog,
  NotepadSudoOperation,
  NotepadSudoPrompt,
  NotepadTab,
  RemoteNotepadProps,
  SaveOptions,
} from './notepadTypes';
import RemoteFilePicker from './RemoteFilePicker';
import { clearCachedSudoPassword, getCachedSudoOptions, setCachedSudoPassword } from './sudoPrompt';
import { isTextFile } from './textFileUtils';

const NotepadEditor = lazy(() => import('./NotepadEditor'));
const elevationRequiredPrefix = 'SHELLDESK_ELEVATION_REQUIRED:';
const elevationAuthFailedPrefix = 'SHELLDESK_ELEVATION_AUTH_FAILED:';

function getPreferredLightTheme() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: light)').matches;
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
  const [prefersLightTheme, setPrefersLightTheme] = useState(() => getPreferredLightTheme());
  const [sudoPrompt, setSudoPrompt] = useState<NotepadSudoPrompt | null>(null);

  const [filePickerVisible, setFilePickerVisible] = useState(false);
  const [filePickerMode, setFilePickerMode] = useState<'open' | 'save'>('open');
  const [filePickerTitle, setFilePickerTitle] = useState('');
  const [filePickerOnConfirm, setFilePickerOnConfirm] = useState<((path: string) => void) | null>(null);

  const editorRef = useRef<NotepadEditorHandle>(null);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
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
  const isAiConfigured = hasAiConfiguration(settings);

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

  const updateCursorPosition = useCallback((position: { line: number; col: number }) => {
    setCursorLine(position.line);
    setCursorCol(position.col);
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
    editorRef.current?.selectRange(start, end);
  }, []);

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
    return editorRef.current?.getSelection() ?? { start: 0, end: 0, text: '' };
  }, []);

  const handleAiApply = useCallback((action: Exclude<NotepadAiAction, { type: 'run_command' }>, selection: EditorSelectionSnapshot) => {
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
  }, [activeTab.content, replaceActiveContent]);

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
    editorRef.current?.openSearch();
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
            <Suspense fallback={<div className="notepad-loading">{t('notepad.loading', language)}</div>}>
              <NotepadEditor
                ref={editorRef}
                content={activeTab.content}
                language={normalizeLanguage(activeTab.language)}
                readOnly={activeTab.readOnly}
                theme={codeMirrorTheme}
                wrapEnabled={effectiveWrapEnabled}
                onChange={handleEditorChange}
                onCursorChange={updateCursorPosition}
                ariaLabel={t('notepad.editor.aria', language, { title: activeTab.title })}
              />
            </Suspense>
          </div>
        )}

        {isAiSidebarOpen ? (
          <NotepadAiPanel
            activeTab={activeTab}
            connectionId={connectionId}
            cursorLine={cursorLine}
            cursorCol={cursorCol}
            getCurrentEditorSelection={getCurrentEditorSelection}
            isConfigured={isAiConfigured}
            language={language}
            settings={settings}
            systemType={systemType}
            onApply={handleAiApply}
            onClose={() => setIsAiSidebarOpen(false)}
          />
        ) : null}      </div>

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

export default RemoteNotepad;
