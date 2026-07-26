import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';
import { useShellDeskEditorTheme } from './useShellDeskEditorTheme';
import { parseCaddyConfig, parseCaddyTestOutput } from './caddyParser';
import {
  createCaddyBackupCommand,
  createCaddyCreateSiteCommand,
  createCaddyDetectCommand,
  createCaddyReadConfigCommand,
  createCaddyReloadCommand,
  createCaddyTestCommand,
  createCaddyWriteConfigCommand,
  parseCaddyDetectOutput,
} from './caddyManagerProviders';
import { caddyConfigTemplates, renderCaddyTemplate } from './caddyManagerTemplates';
import type { CaddyConfigFile, CaddyConfigTemplate, CaddyInstallation, CaddySiteBlock, CaddySiteFilter, CaddyTestResult } from './caddyManagerTypes';
import { tCurrent, type MessageId } from '../../i18n';

const NotepadEditor = lazy(() => import('./NotepadEditor'));

interface RemoteCaddyManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type CaddyTab = 'sites' | 'templates' | 'config';
type CaddySubTab = 'overview' | 'editor';
type PendingAction =
  | { type: 'delete'; siteBlock: CaddySiteBlock }
  | { type: 'create-from-template'; template: CaddyConfigTemplate; values: Record<string, string> };

function combineOutput(result: { stdout?: string; stderr?: string }) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function formatValue(value: string | string[] | number | boolean | null | undefined) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getTemplateDefaults(template: CaddyConfigTemplate) {
  return Object.fromEntries(template.variables.map((variable) => [variable.name, variable.default]));
}

function renderTemplatePreview(template: CaddyConfigTemplate, values: Record<string, string>) {
  try {
    return renderCaddyTemplate(template, values);
  } catch (error) {
    return getErrorMessage(error);
  }
}

function siteTitle(siteBlock: CaddySiteBlock | null) {
  return siteBlock?.matcher || tCurrent('auto.remoteCaddyManager.noSelection');
}

function removeSiteBlock(content: string, siteBlock: CaddySiteBlock) {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, siteBlock.startLine - 1);
  const end = Math.min(lines.length, siteBlock.endLine);
  lines.splice(start, end - start);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const templateIcons: Record<string, string> = {
  FileText: '📄',
  Shuffle: '🔀',
  Code2: '💻',
  ShieldCheck: '🔒',
  Network: '⚖️',
  Container: '▣',
};

async function pMap<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }));
  return results;
}

function RemoteCaddyManager({ connectionId, systemType }: RemoteCaddyManagerProps) {
  const editorTheme = useShellDeskEditorTheme();
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const [installation, setInstallation] = useState<CaddyInstallation | null>(null);
  const [configFiles, setConfigFiles] = useState<CaddyConfigFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<CaddyConfigFile | null>(null);
  const [selectedSiteBlock, setSelectedSiteBlock] = useState<CaddySiteBlock | null>(null);
  const [activeTab, setActiveTab] = useState<CaddyTab>('sites');
  const [activeSubTab, setActiveSubTab] = useState<CaddySubTab>('overview');
  const [editorContent, setEditorContent] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [testResult, setTestResult] = useState<CaddyTestResult | null>(null);
  const [siteTestResults, setSiteTestResults] = useState<Record<string, CaddyTestResult>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [siteFilter, setSiteFilter] = useState<CaddySiteFilter>('all');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<CaddyConfigTemplate | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const requestIdRef = useRef(0);
  const previousFilePathRef = useRef<string | null>(null);
  const previousRawContentRef = useRef('');
  const hasUnsavedChangesRef = useRef(false);
  const siteTestTimerRef = useRef<Map<string, number>>(new Map());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const modalOpenerRef = useRef<HTMLElement | null>(null);

  const allSiteBlocks = useMemo(() => configFiles.flatMap((file) => file.siteBlocks), [configFiles]);
  const filteredSiteBlocks = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    return allSiteBlocks.filter((siteBlock) => {
      if (siteFilter === 'disabled') return false;
      if (siteFilter === 'enabled') {
        // Caddyfile has no native disabled-site state, so every parsed site block is treated as enabled.
      }
      if (siteFilter === 'tls' && !siteBlock.tls) return false;
      if (siteFilter === 'non-tls' && siteBlock.tls) return false;
      if (!needle) return true;
      return [
        siteBlock.matcher,
        siteBlock.filePath,
        ...siteBlock.listen,
        ...siteBlock.directives.map((directive) => directive.name),
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [allSiteBlocks, searchQuery, siteFilter]);

  const globalConfig = configFiles[0] ?? null;
  const modalOpen = Boolean(pendingAction || selectedTemplate);
  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const detectResult = await runCommand(createCaddyDetectCommand(isWindowsHost));
      const detected = parseCaddyDetectOutput(combineOutput(detectResult));
      if (requestIdRef.current !== requestId) return;
      if (!detected) {
        setInstallation(null);
        setConfigFiles([]);
        setSelectedFile(null);
        setSelectedSiteBlock(null);
        setEditorContent('');
        previousFilePathRef.current = null;
        previousRawContentRef.current = '';
        setTestResult(null);
        setError(tCurrent('auto.remoteCaddyManager.caddyNotDetected'));
        return;
      }

      // Known limitation: this reads the detected primary Caddyfile only; imported files are not expanded yet.
      const parsedFiles = await pMap([detected.configPath], 2, async (filePath) => {
        const readResult = await runCommand(createCaddyReadConfigCommand(filePath, isWindowsHost));
        const content = readResult.stdout ?? '';
        return parseCaddyConfig(content, filePath);
      });

      if (requestIdRef.current !== requestId) return;
      const nextFile = parsedFiles[0] ?? null;
      const nextPath = nextFile?.fullPath ?? null;
      const nextRawContent = nextFile?.rawContent ?? '';
      const pathChanged = previousFilePathRef.current !== nextPath;
      const rawContentChanged = previousRawContentRef.current !== nextRawContent;
      setInstallation(detected);
      setConfigFiles(parsedFiles);
      setSelectedFile(nextFile);
      setSelectedSiteBlock((current) => nextFile?.siteBlocks.find((block) => block.id === current?.id) ?? nextFile?.siteBlocks[0] ?? null);
      previousFilePathRef.current = nextPath;
      previousRawContentRef.current = nextRawContent;
      if (pathChanged || (rawContentChanged && !hasUnsavedChangesRef.current)) {
        setEditorContent(nextRawContent);
        setHasUnsavedChanges(false);
      }
      setTestResult(null);
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(tCurrent('auto.remoteCaddyManager.refreshSuccess', { value0: parsedFiles.length }));
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setError(getErrorMessage(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [isWindowsHost, runCommand]);

  const runCaddyTest = useCallback(async () => {
    if (!installation) throw new Error(tCurrent('auto.remoteCaddyManager.caddyNotDetected'));
    const result = await runCommand(createCaddyTestCommand(installation.configPath, isWindowsHost));
    const parsed = parseCaddyTestOutput(combineOutput(result));
    return result.code === 0 ? parsed : { ...parsed, success: false };
  }, [installation, isWindowsHost, runCommand]);

  const appendNotice = useCallback((message: string) => {
    setNotice((current) => (current ? `${current}\n${message}` : message));
  }, []);

  const getReloadWarning = useCallback((output: string) => (
    `${tCurrent('auto.remoteCaddyManager.reloadFailed')} ${output || tCurrent('auto.remoteCaddyManager.actionFailed')}`
  ), []);

  const testConfig = useCallback(async () => {
    setActionRunning(true);
    setError('');
    setNotice('');
    try {
      const parsed = await runCaddyTest();
      setTestResult(parsed);
      if (!parsed.success) {
        setError(tCurrent('auto.remoteCaddyManager.testFailed'));
        return parsed;
      }
      setNotice(tCurrent('auto.remoteCaddyManager.testSuccess'));
      return parsed;
    } catch (error) {
      const output = getErrorMessage(error);
      const parsed = parseCaddyTestOutput(output);
      setTestResult(parsed);
      setError(output || tCurrent('auto.remoteCaddyManager.testFailed'));
      return parsed;
    } finally {
      setActionRunning(false);
    }
  }, [runCaddyTest]);

  const showSiteTestResult = useCallback((siteBlockId: string, result: CaddyTestResult) => {
    const currentTimer = siteTestTimerRef.current.get(siteBlockId);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer);
    setSiteTestResults((current) => ({ ...current, [siteBlockId]: result }));
    const nextTimer = window.setTimeout(() => {
      setSiteTestResults((current) => {
        const next = { ...current };
        delete next[siteBlockId];
        return next;
      });
      siteTestTimerRef.current.delete(siteBlockId);
    }, 3000);
    siteTestTimerRef.current.set(siteBlockId, nextTimer);
  }, []);

  const quickTestSite = useCallback(async (siteBlock: CaddySiteBlock) => {
    const parsed = await testConfig();
    showSiteTestResult(siteBlock.id, parsed);
  }, [showSiteTestResult, testConfig]);

  const saveContent = useCallback(async (nextContent: string, successMessage: string) => {
    if (!installation || !selectedFile) return;
    const previousContent = selectedFile.rawContent;
    const backupResult = await runCommand(createCaddyBackupCommand(selectedFile.fullPath, isWindowsHost));
    if (backupResult.code !== 0) throw new Error(combineOutput(backupResult) || tCurrent('auto.remoteCaddyManager.actionFailed'));
    const writeResult = await runCommand(createCaddyWriteConfigCommand(selectedFile.fullPath, nextContent, isWindowsHost));
    if (writeResult.code !== 0) throw new Error(combineOutput(writeResult) || tCurrent('auto.remoteCaddyManager.actionFailed'));
    const parsedTest = await runCaddyTest();
    setTestResult(parsedTest);
    if (!parsedTest.success) {
      const rollbackResult = await runCommand(createCaddyWriteConfigCommand(selectedFile.fullPath, previousContent, isWindowsHost));
      if (rollbackResult.code !== 0) throw new Error(`${tCurrent('auto.remoteCaddyManager.rollbackNotice')} ${combineOutput(rollbackResult) || tCurrent('auto.remoteCaddyManager.actionFailed')}`);
      throw new Error(tCurrent('auto.remoteCaddyManager.rollbackNotice'));
    }
    const reloadResult = await runCommand(createCaddyReloadCommand(installation.configPath, isWindowsHost));
    const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
    setNotice(successMessage);
    await refresh();
    if (reloadWarning) appendNotice(reloadWarning);
  }, [appendNotice, getReloadWarning, installation, isWindowsHost, refresh, runCaddyTest, runCommand, selectedFile]);

  const saveConfig = useCallback(async () => {
    if (!selectedFile) return;
    setActionRunning(true);
    setError('');
    setNotice('');
    try {
      await saveContent(editorContent, tCurrent('auto.remoteCaddyManager.saveSuccess'));
      setHasUnsavedChanges(false);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [editorContent, saveContent, selectedFile]);

  const deleteSite = useCallback(async (siteBlock: CaddySiteBlock) => {
    if (!selectedFile) return;
    setActionRunning(true);
    setError('');
    setNotice('');
    try {
      await saveContent(removeSiteBlock(selectedFile.rawContent, siteBlock), tCurrent('auto.remoteCaddyManager.deleteSuccess'));
      setPendingAction(null);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [saveContent, selectedFile]);

  const createFromTemplate = useCallback(async (template: CaddyConfigTemplate, values: Record<string, string>) => {
    if (!installation) return;
    setActionRunning(true);
    setError('');
    setNotice('');
    try {
      for (const variable of template.variables) {
        if (variable.required && !values[variable.name]?.trim()) {
          throw new Error(tCurrent('auto.remoteCaddyManager.templateRequired', { value0: tCurrent(variable.label as MessageId) }));
        }
      }
      const content = `${renderCaddyTemplate(template, values).trim()}\n`;
      const backupReadResult = await runCommand(createCaddyReadConfigCommand(installation.configPath, isWindowsHost));
      if (backupReadResult.code !== 0) throw new Error(combineOutput(backupReadResult) || tCurrent('auto.remoteCaddyManager.actionFailed'));
      const previousContent = backupReadResult.stdout ?? '';
      const appendResult = await runCommand(createCaddyCreateSiteCommand(installation.configPath, content, isWindowsHost));
      if (appendResult.code !== 0) throw new Error(combineOutput(appendResult) || tCurrent('auto.remoteCaddyManager.actionFailed'));
      const parsedTest = await runCaddyTest();
      setTestResult(parsedTest);
      if (!parsedTest.success) {
        const rollbackResult = await runCommand(createCaddyWriteConfigCommand(installation.configPath, previousContent, isWindowsHost));
        if (rollbackResult.code !== 0) throw new Error(`${tCurrent('auto.remoteCaddyManager.rollbackNotice')} ${combineOutput(rollbackResult) || tCurrent('auto.remoteCaddyManager.actionFailed')}`);
        throw new Error(tCurrent('auto.remoteCaddyManager.rollbackNotice'));
      }
      const reloadResult = await runCommand(createCaddyReloadCommand(installation.configPath, isWindowsHost));
      const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
      setNotice(tCurrent('auto.remoteCaddyManager.createSuccess'));
      setSelectedTemplate(null);
      setTemplateValues({});
      setActiveTab('sites');
      await refresh();
      if (reloadWarning) appendNotice(reloadWarning);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [appendNotice, getReloadWarning, installation, isWindowsHost, refresh, runCaddyTest, runCommand]);

  const executePendingAction = async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    if (action.type === 'delete') await deleteSite(action.siteBlock);
    if (action.type === 'create-from-template') await createFromTemplate(action.template, action.values);
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => () => {
    siteTestTimerRef.current.forEach((timerId) => window.clearTimeout(timerId));
    siteTestTimerRef.current.clear();
  }, []);

  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!selectedSiteBlock && allSiteBlocks[0]) setSelectedSiteBlock(allSiteBlocks[0]);
  }, [allSiteBlocks, selectedSiteBlock]);

  useEffect(() => {
    if (!modalOpen) {
      modalOpenerRef.current?.focus();
      modalOpenerRef.current = null;
      return;
    }
    window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')?.focus();
    }, 0);
  }, [modalOpen]);

  const openTemplate = (template: CaddyConfigTemplate) => {
    modalOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedTemplate(template);
    setTemplateValues(getTemplateDefaults(template));
  };

  const openPendingAction = (action: PendingAction) => {
    modalOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingAction(action);
  };

  const handleTabKeyDown = <T extends string>(event: KeyboardEvent<HTMLButtonElement>, tabs: readonly T[], active: T, setActive: (tab: T) => void, idPrefix: string) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const currentIndex = tabs.indexOf(active);
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(currentIndex + offset + tabs.length) % tabs.length];
    setActive(next);
    window.setTimeout(() => document.getElementById(`${idPrefix}-${next}`)?.focus(), 0);
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      setPendingAction(null);
      setSelectedTemplate(null);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleEditorChange = useCallback((nextContent: string) => {
    setEditorContent(nextContent);
    setHasUnsavedChanges(nextContent !== (selectedFile?.rawContent ?? ''));
    const parsed = selectedFile ? parseCaddyConfig(nextContent, selectedFile.fullPath) : null;
    setSelectedSiteBlock((current) => parsed?.siteBlocks.find((block) => block.id === current?.id) ?? parsed?.siteBlocks[0] ?? null);
  }, [selectedFile]);

  const selectedSiteActionsDisabled = actionRunning || loading || !selectedSiteBlock;
  const confirmLabel = pendingAction?.type === 'delete'
    ? tCurrent('auto.remoteCaddyManager.confirmDelete')
    : tCurrent('auto.remoteCaddyManager.createFromTemplate');

  return (
    <section className="caddy-manager">
      <header className="caddy-toolbar">
        <div className="caddy-status-card">
          <span className={`caddy-status-dot ${installation?.isRunning ? '' : installation ? 'warning' : 'danger'}`} aria-hidden="true" />
          <span className="caddy-status-label">{tCurrent('auto.remoteCaddyManager.appName')}</span>
          <span className={`caddy-status-value ${installation?.isRunning ? '' : installation ? 'warning' : 'danger'}`}>{installation ? (installation.isRunning ? tCurrent('auto.remoteCaddyManager.running') : tCurrent('auto.remoteCaddyManager.stopped')) : tCurrent('auto.remoteCaddyManager.caddyNotDetected')}</span>
          <span className="caddy-status-version">{installation?.version || lastRefreshedAt || tCurrent('auto.remoteCaddyManager.notScanned')}</span>
        </div>
        <div className="caddy-status-divider" aria-hidden="true" />
        <label className="caddy-search">
          <input aria-label={tCurrent('auto.remoteCaddyManager.search')} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={tCurrent('auto.remoteCaddyManager.searchPlaceholder')} />
        </label>
        <div className="caddy-filter-chips" role="group" aria-label={tCurrent('auto.remoteCaddyManager.filterLabel')}>
          {(['all', 'enabled', 'disabled', 'tls', 'non-tls'] as CaddySiteFilter[]).map((filter) => (
            <button key={filter} type="button" className={siteFilter === filter ? 'active' : ''} aria-pressed={siteFilter === filter} onClick={() => setSiteFilter(filter)}>
              {tCurrent(`auto.remoteCaddyManager.filter.${filter === 'non-tls' ? 'nonTls' : filter}`)}
            </button>
          ))}
        </div>
        <div className="caddy-toolbar-actions">
          <button type="button" onClick={refresh} disabled={loading || actionRunning}>{loading ? tCurrent('auto.remoteCaddyManager.refreshing') : tCurrent('auto.remoteCaddyManager.refresh')}</button>
          <button type="button" onClick={testConfig} disabled={!installation || actionRunning}>{tCurrent('auto.remoteCaddyManager.testConfig')}</button>
          <button type="button" className="primary" onClick={() => setActiveTab('templates')} disabled={!installation || actionRunning}>{tCurrent('auto.remoteCaddyManager.newSite')}</button>
        </div>
      </header>

      <div className="caddy-tabs" role="tablist" aria-label={tCurrent('auto.remoteCaddyManager.tabsLabel')}>
        {(['sites', 'templates', 'config'] as CaddyTab[]).map((tab) => (
          <button key={tab} id={`caddy-tab-${tab}`} type="button" role="tab" className={activeTab === tab ? 'active' : ''} aria-selected={activeTab === tab} aria-controls={`caddy-panel-${tab}`} tabIndex={activeTab === tab ? 0 : -1} onClick={() => setActiveTab(tab)} onKeyDown={(event) => handleTabKeyDown(event, ['sites', 'templates', 'config'] as const, activeTab, setActiveTab, 'caddy-tab')}>
            {tCurrent(`auto.remoteCaddyManager.${tab}`)}
          </button>
        ))}
      </div>

      {error ? <DismissibleAlert className="caddy-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="caddy-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      {activeTab === 'sites' ? (
        <div id="caddy-panel-sites" className="caddy-layout" role="tabpanel" aria-labelledby="caddy-tab-sites">
          <aside className="caddy-site-list">
            <div className="caddy-list-head">
              <strong>{tCurrent('auto.remoteCaddyManager.sites')}</strong>
              <span>{filteredSiteBlocks.length}</span>
            </div>
            <div className="caddy-site-scroll">
              {filteredSiteBlocks.length ? filteredSiteBlocks.map((siteBlock) => (
                <article key={siteBlock.id} className={`caddy-site-card ${selectedSiteBlock?.id === siteBlock.id ? 'active' : ''}`} aria-current={selectedSiteBlock?.id === siteBlock.id ? 'true' : undefined}>
                  <button type="button" className="caddy-site-card-select" onClick={() => setSelectedSiteBlock(siteBlock)}>
                    <span className="caddy-site-card-main">
                      <span className="caddy-status-dot enabled" aria-hidden="true" />
                      <strong title={siteBlock.matcher}>{siteBlock.matcher}</strong>
                      {siteBlock.tls ? <small className="tls">{tCurrent('auto.remoteCaddyManager.filter.tls')}</small> : null}
                    </span>
                    <span className="caddy-site-card-badges">
                      <em title={siteBlock.filePath}>{siteBlock.filePath}</em>
                    </span>
                  </button>
                  <div className="caddy-site-card-actions">
                    <button type="button" onClick={() => void quickTestSite(siteBlock)} disabled={!installation || actionRunning}>{tCurrent('auto.remoteCaddyManager.quickTest')}</button>
                    <button type="button" className="danger" onClick={() => openPendingAction({ type: 'delete', siteBlock })} disabled={actionRunning || loading}>{tCurrent('auto.remoteCaddyManager.delete')}</button>
                  </div>
                  {siteTestResults[siteBlock.id] ? (
                    <div className={`caddy-site-card-test-result ${siteTestResults[siteBlock.id].success ? 'success' : 'danger'}`} aria-live="polite">
                      {tCurrent('auto.remoteCaddyManager.globalConfigTest')}{siteTestResults[siteBlock.id].output || (siteTestResults[siteBlock.id].success ? tCurrent('auto.remoteCaddyManager.testSuccess') : tCurrent('auto.remoteCaddyManager.testFailed'))}
                    </div>
                  ) : null}
                </article>
              )) : <div className="caddy-empty-state">{loading ? tCurrent('auto.remoteCaddyManager.loading') : tCurrent('auto.remoteCaddyManager.noSites')}</div>}
            </div>
          </aside>

          <main className="caddy-detail">
            <div className="caddy-detail-hero">
              <span>{selectedSiteBlock?.tls ? tCurrent('auto.remoteCaddyManager.filter.tls') : tCurrent('auto.remoteCaddyManager.filter.nonTls')}</span>
              <strong>{siteTitle(selectedSiteBlock)}</strong>
              <em title={selectedSiteBlock?.filePath}>{selectedSiteBlock?.filePath ?? tCurrent('auto.remoteCaddyManager.noSelection')}</em>
            </div>

            <div className="caddy-sub-tabs" role="tablist" aria-label={tCurrent('auto.remoteCaddyManager.detailTabsLabel')}>
              {(['overview', 'editor'] as CaddySubTab[]).map((tab) => (
                <button key={tab} id={`caddy-sub-tab-${tab}`} type="button" role="tab" className={activeSubTab === tab ? 'active' : ''} aria-selected={activeSubTab === tab} aria-controls={`caddy-sub-panel-${tab}`} tabIndex={activeSubTab === tab ? 0 : -1} onClick={() => setActiveSubTab(tab)} onKeyDown={(event) => handleTabKeyDown(event, ['overview', 'editor'] as const, activeSubTab, setActiveSubTab, 'caddy-sub-tab')}>
                  {tCurrent(`auto.remoteCaddyManager.${tab}`)}
                </button>
              ))}
            </div>

            {activeSubTab === 'overview' ? (
              <dl id="caddy-sub-panel-overview" className="caddy-detail-list" role="tabpanel" aria-labelledby="caddy-sub-tab-overview">
                <div><dt>{tCurrent('auto.remoteCaddyManager.domain')}</dt><dd>{formatValue(selectedSiteBlock?.matcher)}</dd></div>
                <div><dt>{tCurrent('auto.remoteCaddyManager.listen')}</dt><dd>{formatValue(selectedSiteBlock?.listen)}</dd></div>
                <div><dt>{tCurrent('auto.remoteCaddyManager.tlsStatus')}</dt><dd>{selectedSiteBlock?.tls ? tCurrent('auto.remoteCaddyManager.enabled') : tCurrent('auto.remoteCaddyManager.disabled')}</dd></div>
                <div><dt>{tCurrent('auto.remoteCaddyManager.directives')}</dt><dd>{selectedSiteBlock?.directives.length ?? 0}</dd></div>
                <div><dt>{tCurrent('auto.remoteCaddyManager.lines')}</dt><dd>{selectedSiteBlock ? `${selectedSiteBlock.startLine}-${selectedSiteBlock.endLine}` : '-'}</dd></div>
              </dl>
            ) : null}

            {activeSubTab === 'editor' ? (
              <div id="caddy-sub-panel-editor" className="caddy-editor" role="tabpanel" aria-labelledby="caddy-sub-tab-editor">
                <Suspense fallback={<div className="caddy-editor-loading">{tCurrent('auto.remoteCaddyManager.editorLoading')}</div>}>
                  <NotepadEditor ariaLabel={tCurrent('auto.remoteCaddyManager.editor')} className="caddy-code-editor" content={editorContent} language="caddyfile" readOnly={false} theme={editorTheme} wrapEnabled={false} onChange={handleEditorChange} onCursorChange={() => undefined} />
                </Suspense>
                <div className="caddy-editor-actions">
                  <span>{hasUnsavedChanges ? tCurrent('auto.remoteCaddyManager.unsavedChanges') : (selectedFile?.lastModified ? new Date(selectedFile.lastModified * 1000).toLocaleString(getShellDeskLocale()) : '-')}</span>
                  <button type="button" onClick={() => { setEditorContent(selectedFile?.rawContent ?? ''); setHasUnsavedChanges(false); }} disabled={!hasUnsavedChanges || actionRunning}>{tCurrent('auto.remoteCaddyManager.revert')}</button>
                  <button type="button" className="primary" onClick={saveConfig} disabled={!hasUnsavedChanges || actionRunning}>{tCurrent('auto.remoteCaddyManager.save')}</button>
                </div>
              </div>
            ) : null}

            <div className="caddy-actions">
              <button type="button" className="danger" onClick={() => selectedSiteBlock && openPendingAction({ type: 'delete', siteBlock: selectedSiteBlock })} disabled={selectedSiteActionsDisabled}>{tCurrent('auto.remoteCaddyManager.delete')}</button>
              <button type="button" onClick={saveConfig} disabled={!hasUnsavedChanges || actionRunning}>{tCurrent('auto.remoteCaddyManager.save')}</button>
            </div>

            {testResult ? <pre className={`caddy-test-output ${testResult.success ? 'success' : 'danger'}`} aria-live="polite">{testResult.output || (testResult.success ? tCurrent('auto.remoteCaddyManager.testSuccess') : tCurrent('auto.remoteCaddyManager.testFailed'))}</pre> : null}
          </main>
        </div>
      ) : null}

      {activeTab === 'templates' ? (
        <div id="caddy-panel-templates" className="caddy-templates-grid" role="tabpanel" aria-labelledby="caddy-tab-templates">
          {caddyConfigTemplates.map((template) => (
            <button key={template.id} type="button" className="caddy-template-card" onClick={() => openTemplate(template)} disabled={!installation || actionRunning}>
              <span aria-hidden="true">{templateIcons[template.icon] || '📋'}</span>
              <strong>{tCurrent(template.name as MessageId)}</strong>
              <em>{tCurrent(template.description as MessageId)}</em>
            </button>
          ))}
        </div>
      ) : null}

      {activeTab === 'config' ? (
        <div id="caddy-panel-config" className="caddy-global-config" role="tabpanel" aria-labelledby="caddy-tab-config">
          <section>
            <div className="caddy-list-head">
              <strong>{installation?.configPath ?? tCurrent('auto.remoteCaddyManager.config')}</strong>
              <span>{formatValue(globalConfig?.fileSize)}</span>
            </div>
            <pre>{globalConfig?.rawContent || tCurrent('auto.remoteCaddyManager.noSelection')}</pre>
          </section>
          <section>
            <div className="caddy-list-head">
              <strong>{tCurrent('auto.remoteCaddyManager.version')}</strong>
              <span>{installation?.distro ?? '-'}</span>
            </div>
            <dl className="caddy-detail-list">
              <div><dt>{tCurrent('auto.remoteCaddyManager.configPath')}</dt><dd>{installation?.configPath ?? '-'}</dd></div>
              <div><dt>{tCurrent('auto.remoteCaddyManager.adminApi')}</dt><dd>{installation?.isAdminApiEnabled ? installation.adminApiUrl : '-'}</dd></div>
            </dl>
          </section>
        </div>
      ) : null}

      {pendingAction ? createPortal(
        <div className="caddy-modal-backdrop" onKeyDown={handleDialogKeyDown} role="presentation">
          <div ref={dialogRef} className={`caddy-confirm-dialog ${pendingAction.type === 'delete' ? 'danger' : ''}`} role="dialog" aria-modal="true" aria-label={confirmLabel}>
            <div className="caddy-confirm-header">
              <span>{tCurrent('auto.remoteCaddyManager.appName')}</span>
              <strong>{confirmLabel}</strong>
            </div>
            <p>{pendingAction.type === 'create-from-template' ? tCurrent(pendingAction.template.name as MessageId) : pendingAction.siteBlock.matcher}</p>
            <div className="caddy-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteCaddyManager.cancel')}</button>
              <button type="button" className={pendingAction.type === 'delete' ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>{actionRunning ? tCurrent('auto.remoteCaddyManager.runningAction') : tCurrent('auto.remoteCaddyManager.confirm')}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {selectedTemplate ? createPortal(
        <div className="caddy-modal-backdrop" onKeyDown={handleDialogKeyDown} role="presentation">
          <div ref={dialogRef} className="caddy-template-wizard" role="dialog" aria-modal="true" aria-label={tCurrent('auto.remoteCaddyManager.createFromTemplate')}>
            <div className="caddy-confirm-header">
              <span>{tCurrent('auto.remoteCaddyManager.createFromTemplate')}</span>
              <strong>{tCurrent(selectedTemplate.name as MessageId)}</strong>
            </div>
            <div className="caddy-template-fields">
              {selectedTemplate.variables.map((variable) => (
                <label key={variable.name}>
                  <span>{tCurrent(variable.label as MessageId)}</span>
                  {variable.type === 'select' ? (
                    <select value={templateValues[variable.name] ?? ''} onChange={(event) => setTemplateValues((current) => ({ ...current, [variable.name]: event.target.value }))}>
                      {(variable.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : (
                    <input type={variable.type === 'number' || variable.type === 'port' ? 'number' : 'text'} value={templateValues[variable.name] ?? ''} onChange={(event) => setTemplateValues((current) => ({ ...current, [variable.name]: event.target.value }))} />
                  )}
                  <em>{tCurrent(variable.description as MessageId)}</em>
                </label>
              ))}
            </div>
            <pre>{renderTemplatePreview(selectedTemplate, templateValues)}</pre>
            <div className="caddy-confirm-actions">
              <button type="button" onClick={() => setSelectedTemplate(null)}>{tCurrent('auto.remoteCaddyManager.cancel')}</button>
              <button type="button" className="primary" onClick={() => { setSelectedTemplate(null); openPendingAction({ type: 'create-from-template', template: selectedTemplate, values: templateValues }); }} disabled={actionRunning}>
                {tCurrent('auto.remoteCaddyManager.createFromTemplate')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {sudoPrompt}
    </section>
  );
}

export default RemoteCaddyManager;
