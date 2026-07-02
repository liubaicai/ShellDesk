import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useMemo, useRef, useState } from 'react';
import { Code2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';

import { completeAiRequest, isAiConfigured } from '../ai';
import NotepadEditor from '../components/remote-desktop/NotepadEditor';
import { LANGUAGE_OPTIONS, normalizeLanguage } from '../components/remote-desktop/notepadLanguageDetection';
import { isMacClient, keyEventToShortcut } from '../components/remote-desktop/terminalSnippetShortcuts';
import { t, useCurrentAppLanguage, type AppLanguage } from '../i18n';

interface SnippetsPageProps {
  settings: ShellDeskAppSettings;
  onSettingsChange: (
    settingsUpdate: ShellDeskAppSettings | ((currentSettings: ShellDeskAppSettings) => ShellDeskAppSettings),
  ) => void | Promise<void>;
}

interface SnippetDraft {
  id: string;
  label: string;
  group: string;
  command: string;
  language: string;
  shortcut: string;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type AiStatus = 'idle' | 'running' | 'error';

const emptySnippetDraft: SnippetDraft = {
  id: '',
  label: '',
  group: '',
  command: '',
  language: 'bash',
  shortcut: '',
};

function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function snippetToDraft(snippet: ShellDeskTerminalSnippet): SnippetDraft {
  return {
    id: snippet.id,
    label: snippet.label,
    group: snippet.group,
    command: snippet.command,
    language: normalizeSnippetLanguage(snippet.language),
    shortcut: snippet.shortcut,
  };
}

function getSnippetPreview(snippet: ShellDeskTerminalSnippet) {
  return snippet.command.replace(/\s+/gu, ' ').trim().slice(0, 160);
}

function getSaveErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return '';
}

function closeSnippetCardMenu(target: HTMLElement) {
  const menu = target.closest('details');

  if (menu instanceof HTMLDetailsElement) {
    menu.open = false;
  }
}

function getAiReadinessError(settings: ShellDeskAppSettings, language: ShellDeskAppSettings['language']) {
  if (!isAiConfigured(settings)) {
    return t('snippets.ai.configRequired', language);
  }

  return '';
}

function extractAiCommand(content: string) {
  const trimmedContent = content.trim();
  const fencedBlockMatch = trimmedContent.match(/```(?:[a-z0-9#+.-]+)?\s*([\s\S]*?)```/iu);
  const command = (fencedBlockMatch?.[1] ?? trimmedContent)
    .replace(/^["'`]+|["'`]+$/gu, '')
    .trim();

  return command.slice(0, 20000);
}

function normalizeShortcutLabel(shortcut: string) {
  return shortcut.replace(/\s*\+\s*/gu, ' + ').trim();
}

function normalizeSnippetLanguage(language?: string) {
  if (language === 'plaintext') {
    return 'plaintext';
  }

  const normalizedLanguage = normalizeLanguage(language);
  return normalizedLanguage === 'plaintext' ? 'bash' : normalizedLanguage;
}

function getSnippetLanguageLabel(languageValue: string | undefined, appLanguage: AppLanguage) {
  const normalizedLanguage = normalizeSnippetLanguage(languageValue);
  const languageOption = LANGUAGE_OPTIONS.find((option) => option.value === normalizedLanguage);

  if (!languageOption) {
    return normalizedLanguage;
  }

  if (languageOption.labelId) {
    return t(languageOption.labelId, appLanguage);
  }

  return languageOption.label ?? normalizedLanguage;
}

function getEffectiveSnippetEditorTheme(theme: ShellDeskAppSettings['theme']): 'light' | 'dark' {
  if (typeof document !== 'undefined') {
    const documentTheme = document.documentElement.getAttribute('data-theme');
    if (documentTheme === 'light' || documentTheme === 'dark') {
      return documentTheme;
    }
  }

  if (theme === 'light' || theme === 'dark') {
    return theme;
  }

  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }

  return 'dark';
}

function handleSnippetEditorCursorChange() {
  // The snippets page does not currently display cursor position.
}

function normalizeShortcutForCompare(shortcut: string) {
  return normalizeShortcutLabel(shortcut).toLowerCase();
}

function clearShortcutConflicts(
  snippets: ShellDeskTerminalSnippet[],
  ownerSnippetId: string,
  shortcut: string,
  timestamp: string,
) {
  const normalizedShortcut = normalizeShortcutForCompare(shortcut);

  if (!normalizedShortcut) {
    return snippets;
  }

  return snippets.map((snippet) => (
    snippet.id !== ownerSnippetId && normalizeShortcutForCompare(snippet.shortcut) === normalizedShortcut
      ? { ...snippet, shortcut: '', updatedAt: timestamp }
      : snippet
  ));
}

function getDuplicateShortcutWarning(
  shortcut: string,
  snippets: ShellDeskTerminalSnippet[],
  editingSnippetId: string,
  language: AppLanguage,
) {
  const normalizedShortcut = normalizeShortcutForCompare(shortcut);

  if (!normalizedShortcut) {
    return '';
  }

  const duplicateSnippet = snippets.find((snippet) => (
    snippet.id !== editingSnippetId &&
    normalizeShortcutForCompare(snippet.shortcut) === normalizedShortcut
  ));

  return duplicateSnippet
    ? t('snippets.shortcut.warning.duplicate', language, { name: duplicateSnippet.label })
    : '';
}

function getSystemShortcutConflictName(shortcut: string, language: AppLanguage) {
  const normalizedShortcut = normalizeShortcutForCompare(shortcut);
  const shortcutParts = normalizedShortcut.split(' + ').filter(Boolean);
  const systemShortcutLabels = new Map<string, string>([
    ['ctrl + c', t('snippets.shortcut.system.terminalControl', language)],
    ['ctrl + d', t('snippets.shortcut.system.terminalControl', language)],
    ['ctrl + l', t('snippets.shortcut.system.terminalControl', language)],
    ['ctrl + r', t('snippets.shortcut.system.terminalControl', language)],
    ['ctrl + z', t('snippets.shortcut.system.terminalControl', language)],
    ['ctrl + a', t('snippets.shortcut.system.editing', language)],
    ['ctrl + f', t('snippets.shortcut.system.editing', language)],
    ['ctrl + n', t('snippets.shortcut.system.editing', language)],
    ['ctrl + o', t('snippets.shortcut.system.editing', language)],
    ['ctrl + p', t('snippets.shortcut.system.editing', language)],
    ['ctrl + s', t('snippets.shortcut.system.editing', language)],
    ['ctrl + v', t('snippets.shortcut.system.editing', language)],
    ['ctrl + x', t('snippets.shortcut.system.editing', language)],
    ['ctrl + y', t('snippets.shortcut.system.editing', language)],
    ['ctrl + w', t('snippets.shortcut.system.window', language)],
    ['ctrl + tab', t('snippets.shortcut.system.window', language)],
    ['ctrl + shift + tab', t('snippets.shortcut.system.window', language)],
    ['ctrl + shift + c', t('snippets.shortcut.system.developerTools', language)],
    ['ctrl + shift + i', t('snippets.shortcut.system.developerTools', language)],
    ['ctrl + shift + j', t('snippets.shortcut.system.developerTools', language)],
    ['alt + f4', t('snippets.shortcut.system.window', language)],
    ['alt + space', t('snippets.shortcut.system.window', language)],
    ['alt + tab', t('snippets.shortcut.system.window', language)],
    ['alt + ←', t('snippets.shortcut.system.window', language)],
    ['alt + →', t('snippets.shortcut.system.window', language)],
    ['f5', t('snippets.shortcut.system.window', language)],
    ['f11', t('snippets.shortcut.system.window', language)],
    ['f12', t('snippets.shortcut.system.developerTools', language)],
    ['⌘ + a', t('snippets.shortcut.system.editing', language)],
    ['⌘ + c', t('snippets.shortcut.system.editing', language)],
    ['⌘ + f', t('snippets.shortcut.system.editing', language)],
    ['⌘ + n', t('snippets.shortcut.system.editing', language)],
    ['⌘ + o', t('snippets.shortcut.system.editing', language)],
    ['⌘ + p', t('snippets.shortcut.system.editing', language)],
    ['⌘ + q', t('snippets.shortcut.system.window', language)],
    ['⌘ + r', t('snippets.shortcut.system.window', language)],
    ['⌘ + s', t('snippets.shortcut.system.editing', language)],
    ['⌘ + tab', t('snippets.shortcut.system.window', language)],
    ['⌘ + v', t('snippets.shortcut.system.editing', language)],
    ['⌘ + w', t('snippets.shortcut.system.window', language)],
    ['⌘ + x', t('snippets.shortcut.system.editing', language)],
    ['⌘ + z', t('snippets.shortcut.system.editing', language)],
    ['⌘ + shift + c', t('snippets.shortcut.system.developerTools', language)],
    ['⌘ + shift + i', t('snippets.shortcut.system.developerTools', language)],
    ['⌘ + shift + j', t('snippets.shortcut.system.developerTools', language)],
    ['⌘ + shift + z', t('snippets.shortcut.system.editing', language)],
    ['⌃ + c', t('snippets.shortcut.system.terminalControl', language)],
    ['⌃ + d', t('snippets.shortcut.system.terminalControl', language)],
    ['⌃ + l', t('snippets.shortcut.system.terminalControl', language)],
    ['⌃ + r', t('snippets.shortcut.system.terminalControl', language)],
    ['⌃ + z', t('snippets.shortcut.system.terminalControl', language)],
  ]);

  if (!normalizedShortcut) {
    return '';
  }

  if (systemShortcutLabels.has(normalizedShortcut)) {
    return systemShortcutLabels.get(normalizedShortcut) ?? '';
  }

  if (shortcutParts.includes('win')) {
    return t('snippets.shortcut.system.window', language);
  }

  if (shortcutParts.length === 1) {
    return t('snippets.shortcut.system.terminalInput', language);
  }

  return '';
}

function getShortcutWarning(
  shortcut: string,
  snippets: ShellDeskTerminalSnippet[],
  editingSnippetId: string,
  language: AppLanguage,
) {
  const warnings = [
    getDuplicateShortcutWarning(shortcut, snippets, editingSnippetId, language),
  ];
  const conflictName = getSystemShortcutConflictName(shortcut, language);

  if (conflictName) {
    warnings.push(t('snippets.shortcut.warning.system', language, { name: conflictName }));
  }

  return warnings.filter(Boolean).join(' ');
}

function SnippetsPage({ settings, onSettingsChange }: SnippetsPageProps) {
  const language = useCurrentAppLanguage();
  const snippets = settings.terminalSnippets ?? [];
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [isSnippetEditorOpen, setIsSnippetEditorOpen] = useState(false);
  const [editingSnippetId, setEditingSnippetId] = useState('');
  const [snippetDraft, setSnippetDraft] = useState<SnippetDraft>(emptySnippetDraft);
  const [formError, setFormError] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveStatusDetail, setSaveStatusDetail] = useState('');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiStatus, setAiStatus] = useState<AiStatus>('idle');
  const [aiError, setAiError] = useState('');
  const saveStatusTimerRef = useRef<number | null>(null);

  const snippetGroups = useMemo(() => {
    const groups = new Map<string, number>();

    for (const snippet of snippets) {
      const group = snippet.group.trim();
      if (group) {
        groups.set(group, (groups.get(group) ?? 0) + 1);
      }
    }

    return Array.from(groups.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [snippets]);

  const filteredSnippets = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return snippets.filter((snippet) => {
      const matchesGroup = !selectedGroup || snippet.group === selectedGroup;
      const matchesQuery = !query || (
        snippet.label.toLowerCase().includes(query) ||
        snippet.group.toLowerCase().includes(query) ||
        snippet.command.toLowerCase().includes(query) ||
        normalizeSnippetLanguage(snippet.language).toLowerCase().includes(query) ||
        getSnippetLanguageLabel(snippet.language, language).toLowerCase().includes(query) ||
        snippet.shortcut.toLowerCase().includes(query)
      );

      return matchesGroup && matchesQuery;
    });
  }, [language, searchQuery, selectedGroup, snippets]);

  const activeSnippet = editingSnippetId
    ? snippets.find((snippet) => snippet.id === editingSnippetId) ?? null
    : null;
  const shortcutWarning = useMemo(
    () => getShortcutWarning(snippetDraft.shortcut, snippets, editingSnippetId, language),
    [editingSnippetId, language, snippetDraft.shortcut, snippets],
  );

  const setTemporarySaveStatus = (status: SaveStatus, detail = '') => {
    setSaveStatus(status);
    setSaveStatusDetail(detail);

    if (saveStatusTimerRef.current !== null) {
      window.clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }

    if (status === 'saved') {
      saveStatusTimerRef.current = window.setTimeout(() => {
        setSaveStatus('idle');
        setSaveStatusDetail('');
        saveStatusTimerRef.current = null;
      }, 2200);
    }
  };

  const updateSnippets = async (
    createNextSnippets: (currentSnippets: ShellDeskTerminalSnippet[]) => ShellDeskTerminalSnippet[],
  ) => {
    setTemporarySaveStatus('saving');

    try {
      await onSettingsChange((currentSettings) => ({
        ...currentSettings,
        terminalSnippets: createNextSnippets(currentSettings.terminalSnippets ?? []),
      }));
      setTemporarySaveStatus('saved');
      return true;
    } catch (error) {
      setTemporarySaveStatus('error', getSaveErrorMessage(error));
      return false;
    }
  };

  const startCreateSnippet = () => {
    setEditingSnippetId('');
    setSnippetDraft({
      ...emptySnippetDraft,
      group: selectedGroup ?? '',
    });
    setFormError('');
    setAiPrompt('');
    setAiError('');
    setAiStatus('idle');
    setIsSnippetEditorOpen(true);
  };

  const startEditSnippet = (snippet: ShellDeskTerminalSnippet) => {
    setEditingSnippetId(snippet.id);
    setSnippetDraft(snippetToDraft(snippet));
    setFormError('');
    setAiPrompt('');
    setAiError('');
    setAiStatus('idle');
    setIsSnippetEditorOpen(true);
  };

  const closeSnippetEditor = () => {
    setEditingSnippetId('');
    setSnippetDraft(emptySnippetDraft);
    setFormError('');
    setAiPrompt('');
    setAiError('');
    setAiStatus('idle');
    setIsSnippetEditorOpen(false);
  };

  const saveSnippet = async (event: FormEvent) => {
    event.preventDefault();

    const label = snippetDraft.label.trim();
    const group = snippetDraft.group.trim();
    const command = snippetDraft.command.trim();
    const snippetLanguage = normalizeSnippetLanguage(snippetDraft.language);
    const shortcut = snippetDraft.shortcut.trim();

    if (!label) {
      setFormError(t('terminal.snippets.error.labelRequired', language));
      return;
    }

    if (!command) {
      setFormError(t('terminal.snippets.error.commandRequired', language));
      return;
    }

    if (label.length > 80 || group.length > 80 || shortcut.length > 80 || command.length > 20000) {
      setFormError(t('terminal.snippets.error.tooLong', language));
      return;
    }

    const now = new Date().toISOString();

    if (editingSnippetId) {
      const saved = await updateSnippets((currentSnippets) => {
        let didUpdate = false;
        const snippetsWithAvailableShortcut = clearShortcutConflicts(currentSnippets, editingSnippetId, shortcut, now);
        const nextSnippets = snippetsWithAvailableShortcut.map((snippet) => {
          if (snippet.id !== editingSnippetId) {
            return snippet;
          }

          didUpdate = true;
          return { ...snippet, label, group, command, language: snippetLanguage, shortcut, updatedAt: now };
        });

        return didUpdate
          ? nextSnippets
          : [
              {
                id: editingSnippetId,
                label,
                group,
                command,
                language: snippetLanguage,
                shortcut,
                createdAt: now,
                updatedAt: now,
              },
              ...nextSnippets,
            ];
      });

      if (saved) {
        closeSnippetEditor();
      }
    } else {
      const nextSnippet: ShellDeskTerminalSnippet = {
        id: createId(),
        label,
        group,
        command,
        language: snippetLanguage,
        shortcut,
        createdAt: now,
        updatedAt: now,
      };
      const saved = await updateSnippets((currentSnippets) => [
        nextSnippet,
        ...clearShortcutConflicts(currentSnippets, nextSnippet.id, shortcut, now)
          .filter((snippet) => snippet.id !== nextSnippet.id),
      ]);

      if (saved) {
        closeSnippetEditor();
      }
    }

    setFormError('');
  };

  const deleteSnippet = async (snippetId: string) => {
    const saved = await updateSnippets((currentSnippets) => currentSnippets.filter((snippet) => snippet.id !== snippetId));

    if (saved && editingSnippetId === snippetId) {
      closeSnippetEditor();
    }
  };

  const handleShortcutKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Backspace' || event.key === 'Delete') {
      setSnippetDraft((currentDraft) => ({ ...currentDraft, shortcut: '' }));
      return;
    }

    const shortcut = keyEventToShortcut(event.nativeEvent, isMacClient());

    if (shortcut) {
      setSnippetDraft((currentDraft) => ({ ...currentDraft, shortcut }));
    }
  };

  const requestAiCommand = async () => {
    const prompt = aiPrompt.trim();
    const readinessError = getAiReadinessError(settings, language);

    if (readinessError) {
      setAiError(readinessError);
      setAiStatus('error');
      return;
    }

    if (!prompt && !snippetDraft.label.trim() && !snippetDraft.command.trim()) {
      setAiError(t('snippets.ai.promptRequired', language));
      setAiStatus('error');
      return;
    }

    const systemPrompt = t('ai.snippets.systemPrompt', language);
    const snippetLanguage = normalizeSnippetLanguage(snippetDraft.language);
    const userPrompt = [
      t('snippets.ai.contextHeader', language),
      `uiLanguage=${language}`,
      `snippetLanguage=${snippetLanguage}`,
      `name=${snippetDraft.label.trim() || '-'}`,
      `group=${snippetDraft.group.trim() || '-'}`,
      `existingCommand=${snippetDraft.command.trim() || '-'}`,
      '',
      t('snippets.ai.userPromptHeader', language),
      prompt || t('snippets.ai.defaultPrompt', language),
    ].join('\n');

    setAiStatus('running');
    setAiError('');

    try {
      const result = await completeAiRequest(settings, {
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.2,
      });
      const command = extractAiCommand(result);

      if (!command) {
        throw new Error(t('snippets.ai.empty', language));
      }

      setSnippetDraft((currentDraft) => ({ ...currentDraft, command }));
      setAiStatus('idle');
    } catch (error) {
      setAiStatus('error');
      setAiError(t('snippets.ai.requestFailed', language, { error: getSaveErrorMessage(error) || t('app.error.operationFailed', language) }));
    }
  };

  const editorTitle = activeSnippet
    ? t('snippets.page.editTitle', language)
    : t('snippets.page.newTitle', language);
  const emptyTitle = snippets.length
    ? t('snippets.page.noMatchesTitle', language)
    : t('snippets.page.emptyTitle', language);
  const emptyDescription = snippets.length
    ? t('snippets.page.noMatchesDesc', language)
    : t('snippets.page.emptyDesc', language);
  const saveStatusText = saveStatus === 'saving'
    ? t('snippets.page.saving', language)
    : saveStatus === 'saved'
      ? t('snippets.page.saved', language)
      : saveStatus === 'error'
        ? t('snippets.page.saveFailed', language, { error: saveStatusDetail || t('app.error.operationFailed', language) })
        : '';
  const editorTheme = getEffectiveSnippetEditorTheme(settings.theme);

  return (
    <>
      <div className="command-bar no-drag snippets-command-bar">
        <label className="global-search snippets-search">
          <span>{t('snippets.page.searchLabel', language)}</span>
          <input
            type="search"
            placeholder={t('snippets.page.searchPlaceholder', language)}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>

        {saveStatusText ? (
          <span className={`snippets-save-state ${saveStatus}`} role={saveStatus === 'error' ? 'alert' : 'status'}>
            {saveStatusText}
          </span>
        ) : null}

        <button type="button" className="primary-action" onClick={startCreateSnippet}>
          {t('terminal.snippets.new', language)}
        </button>
      </div>

      <section className="vault-content hosts-content snippets-page snippets-content">
        <aside className="hosts-group-panel snippets-group-panel" aria-label={t('snippets.page.groups', language)}>
          <button
            type="button"
            className={`filter-tab all-hosts-filter ${!selectedGroup ? 'active' : ''}`}
            onClick={() => setSelectedGroup(null)}
          >
            <span>{t('snippets.page.allGroups', language)}</span>
            <b>{snippets.length}</b>
          </button>

          <div className="section-heading group-panel-heading">
            <h2>{t('snippets.page.groups', language)}</h2>
            <button type="button" className="group-add-button" onClick={startCreateSnippet} aria-label={t('terminal.snippets.new', language)}>
              +
            </button>
          </div>

          {snippetGroups.length ? (
            <div className="group-grid group-list">
              {snippetGroups.map((group) => (
                <button
                  key={group.name}
                  type="button"
                  className={`group-card snippet-group-card ${selectedGroup === group.name ? 'active' : ''}`}
                  onClick={() => setSelectedGroup(group.name)}
                >
                  <span className="group-icon snippet-group-icon" aria-hidden="true">#</span>
                  <strong>{group.name}</strong>
                  <small>{group.count}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-inline">{t('snippets.page.emptyDesc', language)}</div>
          )}
        </aside>

        <section className="vault-section host-section hosts-list-panel snippets-list-panel">
          <div className="section-heading host-list-heading">
            <div className="host-list-title">
              <h2>{selectedGroup || t('snippets.page.allGroups', language)} <b>{filteredSnippets.length}</b></h2>
            </div>
            <span className="host-list-controls">
              {t('terminal.snippets.count', language, { count: filteredSnippets.length })}
              {selectedGroup || searchQuery.trim() ? (
                <button
                  type="button"
                  className="host-refresh-button snippets-clear-filter"
                  onClick={() => {
                    setSelectedGroup(null);
                    setSearchQuery('');
                  }}
                  aria-label={t('snippets.page.clearFilter', language)}
                  title={t('snippets.page.clearFilter', language)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </span>
          </div>

          <div className="host-list-scroll snippets-list-scroll">
            {filteredSnippets.length ? (
              <div className="host-grid grid snippet-card-grid">
                {filteredSnippets.map((snippet) => (
                  <article
                    key={snippet.id}
                    className={`host-card snippet-card ${isSnippetEditorOpen && editingSnippetId === snippet.id ? 'active' : ''}`}
                  >
                    <div className="host-card-main snippet-card-main">
                      <span className="host-avatar snippet-avatar" aria-hidden="true">
                        <Code2 />
                      </span>
                      <span className="host-summary snippet-summary">
                        <strong>{snippet.label}</strong>
                        <small>{snippet.group || t('terminal.snippets.ungrouped', language)}</small>
                        <span className="host-card-tags snippet-card-tags">
                          <span className="snippet-card-meta-tags">
                            <em>{getSnippetLanguageLabel(snippet.language, language)}</em>
                            {snippet.shortcut ? <em>{snippet.shortcut}</em> : null}
                          </span>
                          <em className="snippet-command-preview">
                            {getSnippetPreview(snippet) || t('snippets.page.commandFallback', language)}
                          </em>
                        </span>
                      </span>
                    </div>
                    <span className="host-card-actions snippet-card-actions">
                      <details className="host-card-menu snippet-card-menu" onClick={(event) => event.stopPropagation()}>
                        <summary aria-label={t('snippets.page.actions', language)}>
                          <MoreHorizontal aria-hidden="true" />
                        </summary>
                        <div className="host-card-menu-panel">
                          <button
                            type="button"
                            onClick={(event) => {
                              closeSnippetCardMenu(event.currentTarget);
                              startEditSnippet(snippet);
                            }}
                          >
                            <Pencil aria-hidden="true" />
                            {t('app.host.edit', language)}
                          </button>
                          <button
                            type="button"
                            className="danger-text"
                            onClick={(event) => {
                              closeSnippetCardMenu(event.currentTarget);
                              void deleteSnippet(snippet.id);
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                            {t('terminal.snippets.delete', language)}
                          </button>
                        </div>
                      </details>
                    </span>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state snippets-empty">
                <span>SNIPPETS</span>
                <h3>{emptyTitle}</h3>
                <p>{emptyDescription}</p>
              </div>
            )}
          </div>
        </section>
      </section>

      {isSnippetEditorOpen ? (
        <aside className="editor-panel snippets-editor-popover no-drag" aria-label={editorTitle}>
          <div className="editor-header">
            <span>
              <strong>{editorTitle}</strong>
              <small>{activeSnippet ? activeSnippet.label : t('snippets.page.editorHint', language)}</small>
            </span>
            <div className="editor-header-actions">
              <button
                type="submit"
                className="editor-header-submit"
                form="snippet-editor-form"
                disabled={saveStatus === 'saving'}
              >
                {t('common.save', language)}
              </button>
              <button type="button" className="editor-header-clear" onClick={closeSnippetEditor}>
                {t('common.cancel', language)}
              </button>
            </div>
          </div>

          <form id="snippet-editor-form" className="host-form snippet-editor-form" onSubmit={saveSnippet}>
            <label className="field">
              <span>{t('terminal.snippets.fieldLabel', language)}</span>
              <input
                value={snippetDraft.label}
                maxLength={80}
                onChange={(event) => setSnippetDraft((currentDraft) => ({ ...currentDraft, label: event.target.value }))}
                placeholder={t('terminal.snippets.labelPlaceholder', language)}
              />
            </label>

            <label className="field">
              <span>{t('terminal.snippets.fieldGroup', language)}</span>
              <input
                value={snippetDraft.group}
                maxLength={80}
                onChange={(event) => setSnippetDraft((currentDraft) => ({ ...currentDraft, group: event.target.value }))}
                placeholder={t('terminal.snippets.groupPlaceholder', language)}
              />
            </label>

            <div className="field snippet-command-field">
              <div className="snippet-command-toolbar">
                <span>{t('terminal.snippets.fieldCommand', language)}</span>
                <label className="snippet-language-control">
                  <span>{t('terminal.snippets.fieldLanguage', language)}</span>
                  <select
                    value={normalizeSnippetLanguage(snippetDraft.language)}
                    onChange={(event) => {
                      setSnippetDraft((currentDraft) => ({
                        ...currentDraft,
                        language: normalizeSnippetLanguage(event.target.value),
                      }));
                    }}
                  >
                    {LANGUAGE_OPTIONS.map((languageOption) => (
                      <option key={languageOption.value} value={languageOption.value}>
                        {languageOption.labelId ? t(languageOption.labelId, language) : languageOption.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="snippet-command-editor">
                <NotepadEditor
                  ariaLabel={t('terminal.snippets.fieldCommand', language)}
                  className="snippet-codemirror"
                  content={snippetDraft.command}
                  language={normalizeSnippetLanguage(snippetDraft.language)}
                  readOnly={saveStatus === 'saving'}
                  theme={editorTheme}
                  wrapEnabled
                  onChange={(command) => setSnippetDraft((currentDraft) => ({ ...currentDraft, command }))}
                  onCursorChange={handleSnippetEditorCursorChange}
                />
              </div>
            </div>

            <section className="snippet-ai-inline" aria-label={t('snippets.ai.title', language)}>
              <div className="snippet-ai-heading">
                <span>
                  <strong>{t('snippets.ai.title', language)}</strong>
                  <small>{settings.aiModel ? settings.aiModel : t('snippets.ai.notConfigured', language)}</small>
                </span>
                <button
                  type="button"
                  className="command-button muted"
                  onClick={() => void requestAiCommand()}
                  disabled={aiStatus === 'running' || saveStatus === 'saving'}
                >
                  {aiStatus === 'running' ? t('snippets.ai.generating', language) : t('snippets.ai.generate', language)}
                </button>
              </div>
              <textarea
                value={aiPrompt}
                onChange={(event) => setAiPrompt(event.target.value)}
                placeholder={t('snippets.ai.placeholder', language)}
                disabled={aiStatus === 'running'}
              />
              {aiError ? <div className="snippet-form-error">{aiError}</div> : null}
            </section>

            <label className="field">
              <span>{t('terminal.snippets.fieldShortcut', language)}</span>
              <div className="snippet-shortcut-row">
                <input
                  value={snippetDraft.shortcut}
                  readOnly
                  onKeyDown={handleShortcutKeyDown}
                  placeholder={t('terminal.snippets.shortcutPlaceholder', language)}
                />
                <button
                  type="button"
                  className="command-button muted"
                  onClick={() => setSnippetDraft((currentDraft) => ({ ...currentDraft, shortcut: '' }))}
                  disabled={!snippetDraft.shortcut || saveStatus === 'saving'}
                >
                  {t('terminal.snippets.clearShortcut', language)}
                </button>
              </div>
              <small className="field-note">{t('snippets.page.shortcutHint', language)}</small>
              {shortcutWarning ? (
                <small className="snippet-shortcut-warning" role="alert">
                  {shortcutWarning}
                </small>
              ) : null}
            </label>

            {formError ? <div className="snippet-form-error">{formError}</div> : null}
            {saveStatus === 'error' ? <div className="snippet-form-error">{saveStatusText}</div> : null}
          </form>
        </aside>
      ) : null}
    </>
  );
}

export default SnippetsPage;
