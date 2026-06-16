import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';
import { parseNginxConfig, parseNginxTestOutput } from './nginxParser';
import {
  createNginxDetectCommand,
  parseNginxDetectOutput,
  createNginxListConfigsCommand,
  parseNginxListConfigs,
  createNginxReadConfigCommand,
  createNginxEnableSiteCommand,
  createNginxDisableSiteCommand,
  createNginxBackupCommand,
  createNginxWriteConfigCommand,
  createNginxTestCommand,
  createNginxReloadCommand,
  createNginxMoveConfigToBackupCommand,
  createNginxRestoreDeletedConfigCommand,
  createNginxCleanupCreatedConfigCommand,
  validateNginxConfigPath,
} from './nginxManagerProviders';
import { nginxConfigTemplates, renderNginxTemplate } from './nginxManagerTemplates';
import type {
  NginxConfigFile,
  NginxConfigTemplate,
  NginxInstallation,
  NginxLocationBlock,
  NginxServerBlock,
  NginxSiteFilter,
  NginxTestResult,
} from './nginxManagerTypes';
import { tCurrent, type MessageId } from '../../i18n';

interface RemoteNginxManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type NginxTab = 'sites' | 'templates' | 'config';
type NginxSubTab = 'overview' | 'editor' | 'locations';
type PendingAction =
  | { type: 'enable'; filePath: string }
  | { type: 'disable'; filePath: string }
  | { type: 'delete'; filePath: string }
  | { type: 'create-from-template'; template: NginxConfigTemplate; values: Record<string, string> };

function combineOutput(result: { stdout?: string; stderr?: string }) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function basename(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function siteTitle(serverBlock: NginxServerBlock | null, file: NginxConfigFile | null) {
  return serverBlock?.serverNames.join(', ') || file?.filename || tCurrent('auto.remoteNginxManager.noSelection');
}

function formatValue(value: string | string[] | number | null | undefined) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getFileServerNames(file: NginxConfigFile) {
  const names = file.serverBlocks.flatMap((block) => block.serverNames);
  return names.length ? names.join(', ') : file.filename;
}

function getFilePorts(file: NginxConfigFile) {
  const ports = Array.from(new Set(file.serverBlocks.flatMap((block) => block.listenDirectives.map((listen) => listen.port))));
  return ports.length ? ports.join(', ') : '-';
}

function hasSsl(file: NginxConfigFile) {
  return file.serverBlocks.some((block) => Boolean(block.sslConfig) || block.listenDirectives.some((listen) => listen.ssl || listen.port === 443));
}

function sanitizeSiteFilename(value: string) {
  const firstName = value.trim().split(/\s+/)[0] || 'site';
  return `${firstName.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'site'}.conf`;
}

function getTemplateDefaults(template: NginxConfigTemplate) {
  return Object.fromEntries(template.variables.map((variable) => [variable.name, variable.default]));
}

function renderTemplatePreview(template: NginxConfigTemplate, values: Record<string, string>) {
  try {
    return renderNginxTemplate(template, values);
  } catch (error) {
    return getErrorMessage(error);
  }
}

const templateIcons: Record<string, string> = {
  FileText: '📄',
  Shuffle: '🔀',
  Code2: '💻',
  ShieldCheck: '🔒',
  Network: '⚖️',
  Radio: '🔌',
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

function renderLocation(location: NginxLocationBlock, depth = 0) {
  return (
    <details key={location.id} className="nginx-location-node" open={depth === 0}>
      <summary>
        <span>{`${location.modifier ? `${location.modifier} ` : ''}${location.path || '/'}`}</span>
        <em>{tCurrent('auto.remoteNginxManager.lines', { value0: `${location.startLine}-${location.endLine}` })}</em>
      </summary>
      <dl>
        <div><dt>{tCurrent('auto.remoteNginxManager.proxyPass')}</dt><dd>{formatValue(location.proxyPass)}</dd></div>
        <div><dt>{tCurrent('auto.remoteNginxManager.fastcgiPass')}</dt><dd>{formatValue(location.fastcgiPass)}</dd></div>
        <div><dt>{tCurrent('auto.remoteNginxManager.documentRoot')}</dt><dd>{formatValue(location.root ?? location.alias)}</dd></div>
        <div><dt>{tCurrent('auto.remoteNginxManager.tryFiles')}</dt><dd>{formatValue(location.tryFiles)}</dd></div>
      </dl>
      {location.nestedLocations.length ? (
        <div className="nginx-location-children">
          {location.nestedLocations.map((child) => renderLocation(child, depth + 1))}
        </div>
      ) : null}
    </details>
  );
}

function RemoteNginxManager({ connectionId, systemType }: RemoteNginxManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const [installation, setInstallation] = useState<NginxInstallation | null>(null);
  const [configFiles, setConfigFiles] = useState<NginxConfigFile[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedFile, setSelectedFile] = useState<NginxConfigFile | null>(null);
  const [selectedServerBlock, setSelectedServerBlock] = useState<NginxServerBlock | null>(null);
  const [activeTab, setActiveTab] = useState<NginxTab>('sites');
  const [activeSubTab, setActiveSubTab] = useState<NginxSubTab>('overview');
  const [editorContent, setEditorContent] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [testResult, setTestResult] = useState<NginxTestResult | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [siteFilter, setSiteFilter] = useState<NginxSiteFilter>('all');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<NginxConfigTemplate | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const requestIdRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousSelectedFilePathRef = useRef<string | null>(null);
  const previousRawContentRef = useRef<string>('');
  const modalOpenerRef = useRef<HTMLElement | null>(null);

  const filteredFiles = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    return configFiles.filter((file) => {
      if (siteFilter === 'enabled' && !file.isEnabled) return false;
      if (siteFilter === 'disabled' && file.isEnabled) return false;
      if (siteFilter === 'ssl' && !hasSsl(file)) return false;
      if (siteFilter === 'non-ssl' && hasSsl(file)) return false;
      if (!needle) return true;
      return [
        file.filename,
        file.fullPath,
        ...file.serverBlocks.flatMap((block) => block.serverNames),
        ...file.serverBlocks.flatMap((block) => block.locations.map((location) => location.path)),
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [configFiles, searchQuery, siteFilter]);

  const globalConfig = useMemo(() => configFiles.find((file) => file.fullPath === installation?.configPath) ?? null, [configFiles, installation?.configPath]);
  const selectedListenPorts = selectedServerBlock?.listenDirectives.map((listen) => listen.raw || `${listen.address}:${listen.port}`) ?? [];
  const modalOpen = Boolean(pendingAction || selectedTemplate);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const detectResult = await runCommand(createNginxDetectCommand(isWindowsHost));
      const detected = parseNginxDetectOutput(combineOutput(detectResult));
      if (requestIdRef.current !== requestId) return;

      if (!detected) {
        setInstallation(null);
        setConfigFiles([]);
        setSelectedFilePath('');
        setSelectedFile(null);
        setSelectedServerBlock(null);
        setEditorContent('');
        setTestResult(null);
        setError(tCurrent('auto.remoteNginxManager.nginxNotDetected'));
        return;
      }

      const listResult = await runCommand(createNginxListConfigsCommand(detected, isWindowsHost));
      const listed = parseNginxListConfigs(combineOutput(listResult));
      const paths = Array.from(new Set([detected.configPath, ...listed.map((item) => item.path)]))
        .filter((filePath) => validateNginxConfigPath(filePath, detected));
      const metadata = new Map(listed.map((item) => [item.path, item]));
      const parsedFiles = await pMap(paths, 4, async (filePath) => {
        const readResult = await runCommand(createNginxReadConfigCommand(filePath, isWindowsHost));
        const content = readResult.stdout ?? '';
        const parsed = parseNginxConfig(content, filePath);
        const info = metadata.get(filePath);
        return {
          ...parsed,
          isEnabled: filePath === detected.configPath ? true : info?.enabled ?? parsed.isEnabled,
          enabledPath: info?.enabled ? filePath : null,
          lastModified: info?.mtime ?? 0,
          fileSize: info?.size ?? content.length,
        };
      });

      if (requestIdRef.current !== requestId) return;
      setInstallation(detected);
      setConfigFiles(parsedFiles);
      setSelectedFilePath((current) => (
        current && parsedFiles.some((file) => file.fullPath === current)
          ? current
          : parsedFiles.find((file) => file.fullPath !== detected.configPath)?.fullPath ?? parsedFiles[0]?.fullPath ?? ''
      ));
      setTestResult(null);
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(tCurrent('auto.remoteNginxManager.refreshSuccess', { value0: parsedFiles.length }));
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setError(getErrorMessage(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [isWindowsHost, runCommand]);

  const runNginxTest = useCallback(async () => {
    const result = await runCommand(createNginxTestCommand(isWindowsHost));
    const parsed = parseNginxTestOutput(combineOutput(result));
    return result.code === 0 ? parsed : { ...parsed, success: false };
  }, [isWindowsHost, runCommand]);

  const getReloadWarning = useCallback((output: string) => (
    `${tCurrent('auto.remoteNginxManager.reloadFailed')} ${output || tCurrent('auto.remoteNginxManager.actionFailed')}`
  ), []);

  const appendNotice = useCallback((message: string) => {
    setNotice((current) => (current ? `${current}\n${message}` : message));
  }, []);

  const testConfig = useCallback(async () => {
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const parsed = await runNginxTest();
      setTestResult(parsed);
      if (!parsed.success) {
        setError(tCurrent('auto.remoteNginxManager.testFailed'));
        return parsed;
      }
      setNotice(tCurrent('auto.remoteNginxManager.testSuccess'));
      return parsed;
    } catch (error) {
      const output = getErrorMessage(error);
      const parsed = parseNginxTestOutput(output);
      setTestResult(parsed);
      setError(output || tCurrent('auto.remoteNginxManager.testFailed'));
      return parsed;
    } finally {
      setActionRunning(false);
    }
  }, [runNginxTest]);

  const toggleSite = useCallback(async (filePath: string, enable: boolean) => {
    if (!installation) return;
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const command = enable
        ? createNginxEnableSiteCommand(filePath, installation, isWindowsHost)
        : createNginxDisableSiteCommand(filePath, installation, isWindowsHost);
      const result = await runCommand(command);
      if (result.code !== 0) throw new Error(combineOutput(result) || tCurrent('auto.remoteNginxManager.actionFailed'));

      const parsedTest = await runNginxTest();
      setTestResult(parsedTest);
      if (!parsedTest.success) {
        const rollbackCommand = enable
          ? createNginxDisableSiteCommand(filePath, installation, isWindowsHost)
          : createNginxEnableSiteCommand(filePath, installation, isWindowsHost);
        const rollbackResult = await runCommand(rollbackCommand);
        if (rollbackResult.code !== 0) {
          throw new Error(`${tCurrent('auto.remoteNginxManager.testFailed')} ${combineOutput(rollbackResult) || tCurrent('auto.remoteNginxManager.actionFailed')}`);
        }
        throw new Error(tCurrent('auto.remoteNginxManager.testFailed'));
      }

      const reloadResult = await runCommand(createNginxReloadCommand(isWindowsHost));
      const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
      setNotice(enable ? tCurrent('auto.remoteNginxManager.enableSuccess') : tCurrent('auto.remoteNginxManager.disableSuccess'));
      await refresh();
      if (reloadWarning) appendNotice(reloadWarning);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [installation, isWindowsHost, refresh, runCommand, runNginxTest]);

  const saveConfig = useCallback(async () => {
    if (!selectedFile) return;
    const previousContent = selectedFile.rawContent;
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const backupResult = await runCommand(createNginxBackupCommand(selectedFile.fullPath, isWindowsHost));
      if (backupResult.code !== 0) throw new Error(combineOutput(backupResult) || tCurrent('auto.remoteNginxManager.actionFailed'));
      const writeResult = await runCommand(createNginxWriteConfigCommand(selectedFile.fullPath, editorContent, isWindowsHost));
      if (writeResult.code !== 0) throw new Error(combineOutput(writeResult) || tCurrent('auto.remoteNginxManager.actionFailed'));

      const parsedTest = await runNginxTest();
      setTestResult(parsedTest);
      if (!parsedTest?.success) {
        const rollbackResult = await runCommand(createNginxWriteConfigCommand(selectedFile.fullPath, previousContent, isWindowsHost));
        if (rollbackResult.code !== 0) {
          throw new Error(`${tCurrent('auto.remoteNginxManager.rollbackNotice')} ${combineOutput(rollbackResult) || tCurrent('auto.remoteNginxManager.actionFailed')}`);
        }
        throw new Error(tCurrent('auto.remoteNginxManager.rollbackNotice'));
      }

      const reloadResult = await runCommand(createNginxReloadCommand(isWindowsHost));
      const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
      setHasUnsavedChanges(false);
      setNotice(tCurrent('auto.remoteNginxManager.saveSuccess'));
      await refresh();
      if (reloadWarning) appendNotice(reloadWarning);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [editorContent, isWindowsHost, refresh, runCommand, runNginxTest, selectedFile]);

  const deleteConfig = useCallback(async (filePath: string) => {
    if (!installation) return;
    const deletedFile = configFiles.find((file) => file.fullPath === filePath);
    const backupPath = `${installation.configDir}/.shelldesk-backups/${basename(filePath)}.rollback.${Date.now()}`;
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createNginxMoveConfigToBackupCommand(filePath, backupPath, installation, isWindowsHost));
      if (result.code !== 0) throw new Error(combineOutput(result) || tCurrent('auto.remoteNginxManager.actionFailed'));
      const parsedTest = await runNginxTest();
      setTestResult(parsedTest);
      if (!parsedTest?.success) {
        const rollbackResult = await runCommand(createNginxRestoreDeletedConfigCommand(backupPath, filePath, installation, deletedFile?.isEnabled ?? true, isWindowsHost));
        if (rollbackResult.code !== 0) throw new Error(`${tCurrent('auto.remoteNginxManager.testFailed')} ${combineOutput(rollbackResult) || tCurrent('auto.remoteNginxManager.actionFailed')}`);
        throw new Error(tCurrent('auto.remoteNginxManager.testFailed'));
      }
      const reloadResult = await runCommand(createNginxReloadCommand(isWindowsHost));
      const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
      setNotice(tCurrent('auto.remoteNginxManager.deleteSuccess'));
      setPendingAction(null);
      await refresh();
      if (reloadWarning) appendNotice(reloadWarning);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [configFiles, installation, isWindowsHost, refresh, runCommand, runNginxTest]);

  const createFromTemplate = useCallback(async (template: NginxConfigTemplate, values: Record<string, string>) => {
    if (!installation) return;
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      for (const variable of template.variables) {
        if (variable.required && !values[variable.name]?.trim()) {
          throw new Error(tCurrent('auto.remoteNginxManager.templateRequired', { value0: tCurrent(variable.label as MessageId) }));
        }
      }

      const content = `${renderNginxTemplate(template, values).trim()}\n`;
      const filename = sanitizeSiteFilename(values.SERVER_NAME ?? values.UPSTREAM_NAME ?? template.id);
      const targetPath = `${installation.sitesLayout === 'debian' && installation.availableDir ? installation.availableDir : installation.confDir}/${filename}`;
      const writeResult = await runCommand(createNginxWriteConfigCommand(targetPath, content, isWindowsHost));
      if (writeResult.code !== 0) throw new Error(combineOutput(writeResult) || tCurrent('auto.remoteNginxManager.actionFailed'));

      if (installation.sitesLayout === 'debian') {
        try {
          const enableResult = await runCommand(createNginxEnableSiteCommand(targetPath, installation, isWindowsHost));
          if (enableResult.code !== 0) throw new Error(combineOutput(enableResult) || tCurrent('auto.remoteNginxManager.actionFailed'));
        } catch (error) {
          try {
            await runCommand(createNginxCleanupCreatedConfigCommand(targetPath, installation, isWindowsHost));
          } catch {
            // Keep the enable failure as the primary error.
          }
          throw error;
        }
      }

      const parsedTest = await runNginxTest();
      setTestResult(parsedTest);
      if (!parsedTest?.success) {
        await runCommand(createNginxCleanupCreatedConfigCommand(targetPath, installation, isWindowsHost));
        throw new Error(tCurrent('auto.remoteNginxManager.testFailed'));
      }
      const reloadResult = await runCommand(createNginxReloadCommand(isWindowsHost));
      const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
      setNotice(tCurrent('auto.remoteNginxManager.createSuccess'));
      setSelectedTemplate(null);
      setTemplateValues({});
      setActiveTab('sites');
      setSelectedFilePath(targetPath);
      await refresh();
      if (reloadWarning) appendNotice(reloadWarning);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [installation, isWindowsHost, refresh, runCommand, runNginxTest]);

  const executePendingAction = async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    if (action.type === 'enable') await toggleSite(action.filePath, true);
    if (action.type === 'disable') await toggleSite(action.filePath, false);
    if (action.type === 'delete') await deleteConfig(action.filePath);
    if (action.type === 'create-from-template') await createFromTemplate(action.template, action.values);
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const file = configFiles.find((item) => item.fullPath === selectedFilePath) ?? configFiles[0] ?? null;
    const currentPath = file?.fullPath ?? null;
    const currentRawContent = file?.rawContent ?? '';
    const pathChanged = previousSelectedFilePathRef.current !== currentPath;
    const rawContentChanged = previousRawContentRef.current !== currentRawContent;
    setSelectedFile(file);
    setSelectedServerBlock(file?.serverBlocks[0] ?? null);
    previousSelectedFilePathRef.current = currentPath;
    previousRawContentRef.current = currentRawContent;
    if (pathChanged || (rawContentChanged && !hasUnsavedChanges)) {
      setEditorContent(currentRawContent);
      setHasUnsavedChanges(false);
    }
  }, [configFiles, hasUnsavedChanges, selectedFilePath]);

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

  const handleEditorChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setEditorContent(event.target.value);
    setHasUnsavedChanges(event.target.value !== (selectedFile?.rawContent ?? ''));
  };

  const openTemplate = (template: NginxConfigTemplate) => {
    modalOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedTemplate(template);
    setTemplateValues(getTemplateDefaults(template));
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

  const openPendingAction = (action: PendingAction) => {
    modalOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPendingAction(action);
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

  const selectedFileActionsDisabled = actionRunning || loading || !selectedFile || selectedFile.fullPath === installation?.configPath;
  const confirmLabel = pendingAction?.type === 'enable'
    ? tCurrent('auto.remoteNginxManager.confirmEnable')
    : pendingAction?.type === 'disable'
      ? tCurrent('auto.remoteNginxManager.confirmDisable')
      : pendingAction?.type === 'delete'
        ? tCurrent('auto.remoteNginxManager.confirmDelete')
        : tCurrent('auto.remoteNginxManager.createFromTemplate');

  return (
    <section className="nginx-manager">
      <header className="nginx-toolbar">
        <div className={`nginx-status-card ${installation?.isRunning ? 'success' : installation ? 'warning' : 'danger'}`}>
          <span>{tCurrent('auto.remoteNginxManager.appName')}</span>
          <strong>{installation ? (installation.isRunning ? tCurrent('auto.remoteNginxManager.running') : tCurrent('auto.remoteNginxManager.stopped')) : tCurrent('auto.remoteNginxManager.nginxNotDetected')}</strong>
          <em>{installation?.version || lastRefreshedAt || tCurrent('auto.remoteNginxManager.notScanned')}</em>
        </div>
        <label className="nginx-search">
          <span>{tCurrent('auto.remoteNginxManager.search')}</span>
          <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={tCurrent('auto.remoteNginxManager.searchPlaceholder')} />
        </label>
        <div className="nginx-filter-chips" role="group" aria-label={tCurrent('auto.remoteNginxManager.filterLabel')}>
          {(['all', 'enabled', 'disabled', 'ssl', 'non-ssl'] as NginxSiteFilter[]).map((filter) => (
            <button key={filter} type="button" className={siteFilter === filter ? 'active' : ''} onClick={() => setSiteFilter(filter)}>
              {tCurrent(`auto.remoteNginxManager.filter.${filter === 'non-ssl' ? 'nonSsl' : filter}`)}
            </button>
          ))}
        </div>
        <div className="nginx-toolbar-actions">
          <button type="button" onClick={refresh} disabled={loading || actionRunning}>{loading ? tCurrent('auto.remoteNginxManager.refreshing') : tCurrent('auto.remoteNginxManager.refresh')}</button>
          <button type="button" onClick={testConfig} disabled={!installation || actionRunning}>{tCurrent('auto.remoteNginxManager.testConfig')}</button>
          <button type="button" className="primary" onClick={() => setActiveTab('templates')} disabled={!installation || actionRunning}>{tCurrent('auto.remoteNginxManager.newSite')}</button>
        </div>
      </header>

      <div className="nginx-tabs" role="tablist" aria-label={tCurrent('auto.remoteNginxManager.tabsLabel')}>
        {(['sites', 'templates', 'config'] as NginxTab[]).map((tab) => (
          <button
            key={tab}
            id={`nginx-tab-${tab}`}
            type="button"
            role="tab"
            className={activeTab === tab ? 'active' : ''}
            aria-selected={activeTab === tab}
            aria-controls={`nginx-panel-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            onClick={() => setActiveTab(tab)}
            onKeyDown={(event) => handleTabKeyDown(event, ['sites', 'templates', 'config'] as const, activeTab, setActiveTab, 'nginx-tab')}
          >
            {tCurrent(`auto.remoteNginxManager.${tab}`)}
          </button>
        ))}
      </div>

      {error ? <DismissibleAlert className="nginx-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="nginx-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      {activeTab === 'sites' ? (
        <div id="nginx-panel-sites" className="nginx-layout" role="tabpanel" aria-labelledby="nginx-tab-sites">
          <aside className="nginx-site-list">
            <div className="nginx-list-head">
              <strong>{tCurrent('auto.remoteNginxManager.sites')}</strong>
              <span>{filteredFiles.length}</span>
            </div>
            <div className="nginx-site-scroll">
              {(() => {
                const siteFiles = filteredFiles.filter((file) => file.fullPath !== installation?.configPath);
                return siteFiles.length ? siteFiles.map((file) => (
                <button key={file.fullPath} type="button" className={selectedFile?.fullPath === file.fullPath ? 'active' : ''} onClick={() => setSelectedFilePath(file.fullPath)}>
                  <span className={`nginx-status-dot ${file.isEnabled ? 'enabled' : 'disabled'}`} />
                  <strong title={getFileServerNames(file)}>{getFileServerNames(file)}</strong>
                  <em>{file.isEnabled ? tCurrent('auto.remoteNginxManager.filter.enabled') : tCurrent('auto.remoteNginxManager.filter.disabled')}</em>
                  {hasSsl(file) ? <small className="ssl">{tCurrent('auto.remoteNginxManager.filter.ssl')}</small> : <small>{tCurrent('auto.remoteNginxManager.portLabel', { value0: getFilePorts(file) })}</small>}
                  <small title={file.fullPath}>{file.fullPath}</small>
                </button>
                )) : (
                <div className="nginx-empty-state">{loading ? tCurrent('auto.remoteNginxManager.loading') : tCurrent('auto.remoteNginxManager.noSites')}</div>
                );
              })()}
            </div>
          </aside>

          <main className="nginx-detail">
            <div className="nginx-detail-hero">
              <span>{selectedFile?.isEnabled ? tCurrent('auto.remoteNginxManager.filter.enabled') : tCurrent('auto.remoteNginxManager.filter.disabled')}</span>
              <strong>{siteTitle(selectedServerBlock, selectedFile)}</strong>
              <em title={selectedFile?.fullPath}>{selectedFile?.fullPath ?? tCurrent('auto.remoteNginxManager.noSelection')}</em>
            </div>

            <div className="nginx-server-switcher">
              {selectedFile?.serverBlocks.map((block, index) => (
                <button key={block.id} type="button" className={selectedServerBlock?.id === block.id ? 'active' : ''} onClick={() => setSelectedServerBlock(block)}>
                  {block.serverNames.join(', ') || tCurrent('auto.remoteNginxManager.serverBlock', { value0: index + 1 })}
                </button>
              ))}
            </div>

            <div className="nginx-sub-tabs" role="tablist" aria-label={tCurrent('auto.remoteNginxManager.detailTabsLabel')}>
              {(['overview', 'locations', 'editor'] as NginxSubTab[]).map((tab) => (
                <button
                  key={tab}
                  id={`nginx-sub-tab-${tab}`}
                  type="button"
                  role="tab"
                  className={activeSubTab === tab ? 'active' : ''}
                  aria-selected={activeSubTab === tab}
                  aria-controls={`nginx-sub-panel-${tab}`}
                  tabIndex={activeSubTab === tab ? 0 : -1}
                  onClick={() => setActiveSubTab(tab)}
                  onKeyDown={(event) => handleTabKeyDown(event, ['overview', 'locations', 'editor'] as const, activeSubTab, setActiveSubTab, 'nginx-sub-tab')}
                >
                  {tCurrent(`auto.remoteNginxManager.${tab}`)}
                </button>
              ))}
            </div>

            {activeSubTab === 'overview' ? (
              <dl id="nginx-sub-panel-overview" className="nginx-detail-list" role="tabpanel" aria-labelledby="nginx-sub-tab-overview">
                <div><dt>{tCurrent('auto.remoteNginxManager.serverNames')}</dt><dd>{formatValue(selectedServerBlock?.serverNames)}</dd></div>
                <div><dt>{tCurrent('auto.remoteNginxManager.listenPorts')}</dt><dd>{formatValue(selectedListenPorts)}</dd></div>
                <div><dt>{tCurrent('auto.remoteNginxManager.documentRoot')}</dt><dd>{formatValue(selectedServerBlock?.root)}</dd></div>
                <div><dt>{tCurrent('auto.remoteNginxManager.sslStatus')}</dt><dd>{selectedServerBlock?.sslConfig ? tCurrent('auto.remoteNginxManager.enabled') : tCurrent('auto.remoteNginxManager.disabled')}</dd></div>
                <div><dt>{tCurrent('auto.remoteNginxManager.locations')}</dt><dd>{selectedServerBlock?.locations.length ?? 0}</dd></div>
                <div><dt>{tCurrent('auto.remoteNginxManager.accessLog')}</dt><dd>{formatValue(selectedServerBlock?.accessLog)}</dd></div>
                <div><dt>{tCurrent('auto.remoteNginxManager.errorLog')}</dt><dd>{formatValue(selectedServerBlock?.errorLog)}</dd></div>
              </dl>
            ) : null}

            {activeSubTab === 'locations' ? (
              <div id="nginx-sub-panel-locations" className="nginx-location-tree" role="tabpanel" aria-labelledby="nginx-sub-tab-locations">
                {selectedServerBlock?.locations.length ? selectedServerBlock.locations.map((location) => renderLocation(location)) : <div className="nginx-empty-state">{tCurrent('auto.remoteNginxManager.noLocations')}</div>}
              </div>
            ) : null}

            {activeSubTab === 'editor' ? (
              <div id="nginx-sub-panel-editor" className="nginx-editor" role="tabpanel" aria-labelledby="nginx-sub-tab-editor">
                <textarea aria-label={tCurrent('auto.remoteNginxManager.editor')} value={editorContent} onChange={handleEditorChange} spellCheck={false} />
                <div className="nginx-editor-actions">
                  {hasUnsavedChanges ? <span>{tCurrent('auto.remoteNginxManager.unsavedChanges')}</span> : <span>{selectedFile?.lastModified ? new Date(selectedFile.lastModified * 1000).toLocaleString(getShellDeskLocale()) : '-'}</span>}
                  <button type="button" onClick={() => { setEditorContent(selectedFile?.rawContent ?? ''); setHasUnsavedChanges(false); }} disabled={!hasUnsavedChanges || actionRunning}>{tCurrent('auto.remoteNginxManager.revert')}</button>
                  <button type="button" className="primary" onClick={saveConfig} disabled={!hasUnsavedChanges || actionRunning}>{tCurrent('auto.remoteNginxManager.save')}</button>
                </div>
              </div>
            ) : null}

            <div className="nginx-actions">
              {selectedFile?.isEnabled ? (
                <button type="button" onClick={() => selectedFile && openPendingAction({ type: 'disable', filePath: selectedFile.fullPath })} disabled={selectedFileActionsDisabled}>{tCurrent('auto.remoteNginxManager.disable')}</button>
              ) : (
                <button type="button" className="primary" onClick={() => selectedFile && openPendingAction({ type: 'enable', filePath: selectedFile.fullPath })} disabled={selectedFileActionsDisabled}>{tCurrent('auto.remoteNginxManager.enable')}</button>
              )}
              <button type="button" className="danger" onClick={() => selectedFile && openPendingAction({ type: 'delete', filePath: selectedFile.fullPath })} disabled={selectedFileActionsDisabled}>{tCurrent('auto.remoteNginxManager.delete')}</button>
              <button type="button" onClick={saveConfig} disabled={!hasUnsavedChanges || actionRunning}>{tCurrent('auto.remoteNginxManager.save')}</button>
            </div>

            {testResult ? (
              <pre className={`nginx-test-output ${testResult.success ? 'success' : 'danger'}`}>
                {testResult.output || (testResult.success ? tCurrent('auto.remoteNginxManager.testSuccess') : tCurrent('auto.remoteNginxManager.testFailed'))}
              </pre>
            ) : null}
          </main>
        </div>
      ) : null}

      {activeTab === 'templates' ? (
        <div id="nginx-panel-templates" className="nginx-templates-grid" role="tabpanel" aria-labelledby="nginx-tab-templates">
          {nginxConfigTemplates.map((template) => (
            <button key={template.id} type="button" className="nginx-template-card" onClick={() => openTemplate(template)} disabled={!installation || actionRunning}>
              <span>{templateIcons[template.icon] || '📋'}</span>
              <strong>{tCurrent(template.name as MessageId)}</strong>
              <em>{tCurrent(template.description as MessageId)}</em>
            </button>
          ))}
        </div>
      ) : null}

      {activeTab === 'config' ? (
        <div id="nginx-panel-config" className="nginx-global-config" role="tabpanel" aria-labelledby="nginx-tab-config">
          <section>
            <div className="nginx-list-head">
              <strong>{installation?.configPath ?? tCurrent('auto.remoteNginxManager.config')}</strong>
              <span>{formatValue(globalConfig?.fileSize)}</span>
            </div>
            <pre>{globalConfig?.rawContent || tCurrent('auto.remoteNginxManager.noSelection')}</pre>
          </section>
          <section>
            <div className="nginx-list-head">
              <strong>{tCurrent('auto.remoteNginxManager.modules')}</strong>
              <span>{installation?.modules.length ?? 0}</span>
            </div>
            <div className="nginx-module-list">
              {installation?.modules.length ? installation.modules.map((module) => <span key={module}>{module}</span>) : <span>{tCurrent('auto.remoteNginxManager.noModules')}</span>}
            </div>
          </section>
        </div>
      ) : null}

      {pendingAction ? createPortal(
        <div className="nginx-modal-backdrop" onKeyDown={handleDialogKeyDown} role="presentation">
          <div ref={dialogRef} className={`nginx-confirm-dialog ${pendingAction.type === 'delete' ? 'danger' : ''}`} role="dialog" aria-modal="true" aria-label={confirmLabel}>
            <div className="nginx-confirm-header">
              <span>{tCurrent('auto.remoteNginxManager.appName')}</span>
              <strong>{confirmLabel}</strong>
            </div>
            <p>{pendingAction.type === 'delete' ? basename(pendingAction.filePath) : pendingAction.type === 'create-from-template' ? tCurrent(pendingAction.template.name as MessageId) : pendingAction.filePath}</p>
            <div className="nginx-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteNginxManager.cancel')}</button>
              <button type="button" className={pendingAction.type === 'delete' ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>{actionRunning ? tCurrent('auto.remoteNginxManager.runningAction') : tCurrent('auto.remoteNginxManager.confirm')}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {selectedTemplate ? createPortal(
        <div className="nginx-modal-backdrop" onKeyDown={handleDialogKeyDown} role="presentation">
          <div ref={dialogRef} className="nginx-template-wizard" role="dialog" aria-modal="true" aria-label={tCurrent('auto.remoteNginxManager.createFromTemplate')}>
            <div className="nginx-confirm-header">
              <span>{tCurrent('auto.remoteNginxManager.createFromTemplate')}</span>
              <strong>{tCurrent(selectedTemplate.name as MessageId)}</strong>
            </div>
            <div className="nginx-template-fields">
              {selectedTemplate.variables.map((variable) => (
                <label key={variable.name}>
                  <span>{tCurrent(variable.label as MessageId)}</span>
                  {variable.type === 'select' ? (
                    <select value={templateValues[variable.name] ?? ''} onChange={(event) => setTemplateValues((current) => ({ ...current, [variable.name]: event.target.value }))}>
                      {(variable.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : (
                    <input
                      type={variable.type === 'number' || variable.type === 'port' ? 'number' : 'text'}
                      value={templateValues[variable.name] ?? ''}
                      onChange={(event) => setTemplateValues((current) => ({ ...current, [variable.name]: event.target.value }))}
                    />
                  )}
                  <em>{tCurrent(variable.description as MessageId)}</em>
                </label>
              ))}
            </div>
            <pre>{renderTemplatePreview(selectedTemplate, templateValues)}</pre>
            <div className="nginx-confirm-actions">
              <button type="button" onClick={() => setSelectedTemplate(null)}>{tCurrent('auto.remoteNginxManager.cancel')}</button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setSelectedTemplate(null);
                  openPendingAction({ type: 'create-from-template', template: selectedTemplate, values: templateValues });
                }}
                disabled={actionRunning}
              >
                {tCurrent('auto.remoteNginxManager.createFromTemplate')}
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

export default RemoteNginxManager;
