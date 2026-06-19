import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';
import { parseApacheConfig, parseApacheTestOutput } from './apacheParser';
import {
  createApacheBackupCommand,
  createApacheDetectCommand,
  createApacheDisableSiteCommand,
  createApacheEnableSiteCommand,
  createApacheListConfigsCommand,
  createApacheMoveConfigToBackupCommand,
  createApachePrepareTemplateTargetCommand,
  createApacheReadConfigCommand,
  createApacheReloadCommand,
  createApacheRestoreDeletedConfigCommand,
  createApacheRollbackTemplateConfigCommand,
  createApacheTestCommand,
  createApacheWriteConfigCommand,
  parseApacheTemplateTargetBackup,
  parseApacheDetectOutput,
  parseApacheListConfigs,
  validateApacheConfigPath,
} from './apacheManagerProviders';
import { apacheConfigTemplates, validateApacheTemplateValues } from './apacheManagerTemplates';
import type { ApacheConfigFile, ApacheConfigTemplate, ApacheInstallation, ApacheSiteFilter, ApacheTemplateValidationResult, ApacheTemplateVariable, ApacheTestResult, ApacheVirtualHost } from './apacheManagerTypes';
import { tCurrent, type MessageId } from '../../i18n';

const NotepadEditor = lazy(() => import('./NotepadEditor'));

interface RemoteApacheManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type ApacheTab = 'sites' | 'templates' | 'config';
type ApacheSubTab = 'overview' | 'editor';
type PendingAction =
  | { type: 'delete'; virtualHost: ApacheVirtualHost }
  | { type: 'create-from-template'; template: ApacheConfigTemplate; values: Record<string, string> };

interface ApacheFileMetadata {
  path: string;
  enabled: boolean;
  size: number;
  mtime: number;
}

function combineOutput(result: { stdout?: string; stderr?: string }) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function formatValue(value: string | string[] | number | boolean | null | undefined) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getTemplateDefaults(template: ApacheConfigTemplate) {
  return Object.fromEntries(template.variables.map((variable) => [variable.name, variable.default]));
}

function getTemplateValidationMessage(variable: ApacheTemplateVariable, result: ApacheTemplateValidationResult) {
  const label = tCurrent(variable.label as MessageId);
  switch (result.errorId) {
    case 'required':
      return tCurrent('auto.remoteApacheManager.templateRequired', { value0: label });
    case 'unsupportedCharacters':
      return tCurrent('auto.remoteApacheManager.templateUnsupportedCharacters', { value0: label });
    case 'spacesOrQuotes':
      return tCurrent('auto.remoteApacheManager.templateSpacesOrQuotes', { value0: label });
    case 'invalidUrl':
      return tCurrent('auto.remoteApacheManager.templateInvalidUrl', { value0: label });
    case 'invalidPort':
      return tCurrent('auto.remoteApacheManager.templateInvalidPort', { value0: label });
    case 'invalidNumber':
      return tCurrent('auto.remoteApacheManager.templateInvalidNumber', { value0: label });
    default:
      return tCurrent('auto.remoteApacheManager.actionFailed');
  }
}

function renderTemplatePreview(template: ApacheConfigTemplate, values: Record<string, string>) {
  const validation = validateApacheTemplateValues(template, values);
  if (!validation.valid) {
    return getTemplateValidationMessage(validation.variable, validation);
  }

  return template.render(values);
}

function virtualHostTitle(virtualHost: ApacheVirtualHost | null) {
  return virtualHost?.serverName || virtualHost?.serverAlias[0] || tCurrent('auto.remoteApacheManager.noSelection');
}

function removeVirtualHost(content: string, virtualHost: ApacheVirtualHost) {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, virtualHost.startLine - 1);
  const end = Math.min(lines.length, virtualHost.endLine);
  lines.splice(start, end - start);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function safeSiteFilename(values: Record<string, string>, template: ApacheConfigTemplate) {
  const source = values.SERVER_NAME || template.id;
  const safe = source.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || template.id;
  return safe.endsWith('.conf') ? safe : `${safe}.conf`;
}

function getCreateTargetPath(installation: ApacheInstallation, template: ApacheConfigTemplate, values: Record<string, string>) {
  const filename = safeSiteFilename(values, template);
  const baseDir = installation.sitesLayout === 'debian' && installation.availableDir ? installation.availableDir : installation.confDir;
  return `${baseDir.replace(/\/$/, '')}/${filename}`;
}

function applyMetadata(config: ApacheConfigFile, metadata: ApacheFileMetadata | undefined): ApacheConfigFile {
  if (!metadata) return config;
  return {
    ...config,
    fileSize: metadata.size,
    lastModified: metadata.mtime,
    virtualHosts: config.virtualHosts.map((virtualHost) => ({
      ...virtualHost,
      isEnabled: metadata.enabled,
    })),
  };
}

const templateIcons: Record<string, string> = {
  FileText: 'HTTP',
  Shuffle: 'Proxy',
  ShieldCheck: 'SSL',
  Code2: 'PHP',
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

function RemoteApacheManager({ connectionId, systemType }: RemoteApacheManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const [installation, setInstallation] = useState<ApacheInstallation | null>(null);
  const [configFiles, setConfigFiles] = useState<ApacheConfigFile[]>([]);
  const [globalConfig, setGlobalConfig] = useState<ApacheConfigFile | null>(null);
  const [selectedFile, setSelectedFile] = useState<ApacheConfigFile | null>(null);
  const [selectedVirtualHost, setSelectedVirtualHost] = useState<ApacheVirtualHost | null>(null);
  const [activeTab, setActiveTab] = useState<ApacheTab>('sites');
  const [activeSubTab, setActiveSubTab] = useState<ApacheSubTab>('overview');
  const [editorContent, setEditorContent] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [testResult, setTestResult] = useState<ApacheTestResult | null>(null);
  const [siteTestResults, setSiteTestResults] = useState<Record<string, ApacheTestResult>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [siteFilter, setSiteFilter] = useState<ApacheSiteFilter>('all');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<ApacheConfigTemplate | null>(null);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const requestIdRef = useRef(0);
  const selectedVirtualHostIdRef = useRef<string | null>(null);
  const previousFilePathRef = useRef<string | null>(null);
  const previousRawContentRef = useRef('');
  const hasUnsavedChangesRef = useRef(false);
  const siteTestTimerRef = useRef<Map<string, number>>(new Map());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const modalOpenerRef = useRef<HTMLElement | null>(null);

  const allVirtualHosts = useMemo(() => configFiles.flatMap((file) => file.virtualHosts), [configFiles]);
  const filteredVirtualHosts = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    return allVirtualHosts.filter((virtualHost) => {
      if (siteFilter === 'enabled' && !virtualHost.isEnabled) return false;
      if (siteFilter === 'disabled' && virtualHost.isEnabled) return false;
      if (siteFilter === 'ssl' && !virtualHost.sslConfig) return false;
      if (siteFilter === 'non-ssl' && virtualHost.sslConfig) return false;
      if (!needle) return true;
      return [
        virtualHost.serverName,
        ...virtualHost.serverAlias,
        virtualHost.documentRoot,
        virtualHost.filePath,
        ...virtualHost.listenPorts,
        ...virtualHost.directives.map((directive) => directive.name),
      ].some((value) => value.toLowerCase().includes(needle));
    });
  }, [allVirtualHosts, searchQuery, siteFilter]);

  const modalOpen = Boolean(pendingAction || selectedTemplate);
  const editorTheme = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError('');
    try {
      const detectResult = await runCommand(createApacheDetectCommand(isWindowsHost));
      const detected = parseApacheDetectOutput(combineOutput(detectResult));
      if (requestIdRef.current !== requestId) return;
      if (!detected) {
        setInstallation(null);
        setConfigFiles([]);
        setGlobalConfig(null);
        setSelectedFile(null);
        setSelectedVirtualHost(null);
        setEditorContent('');
        previousFilePathRef.current = null;
        previousRawContentRef.current = '';
        setTestResult(null);
        setError(isWindowsHost ? tCurrent('auto.remoteApacheManager.windowsUnsupported') : tCurrent('auto.remoteApacheManager.apacheNotDetected'));
        return;
      }

      const listResult = await runCommand(createApacheListConfigsCommand(detected, isWindowsHost));
      const files = parseApacheListConfigs(combineOutput(listResult));
      const metadataByPath = new Map(files.map((file) => [file.path, file]));
      const globalReadResult = await runCommand(createApacheReadConfigCommand(detected.configPath, isWindowsHost));
      const nextGlobalConfig = applyMetadata(parseApacheConfig(globalReadResult.stdout ?? '', detected.configPath), {
        path: detected.configPath,
        enabled: true,
        size: (globalReadResult.stdout ?? '').length,
        mtime: 0,
      });
      const siteFiles = await pMap(files, 3, async (file) => {
        const readResult = await runCommand(createApacheReadConfigCommand(file.path, isWindowsHost));
        return applyMetadata(parseApacheConfig(readResult.stdout ?? '', file.path), metadataByPath.get(file.path));
      });
      const parsedFiles = [nextGlobalConfig, ...siteFiles].filter((file, index, array) => (
        array.findIndex((candidate) => candidate.fullPath === file.fullPath) === index
      ));

      if (requestIdRef.current !== requestId) return;
      const nextSelectedVirtualHost = parsedFiles.flatMap((file) => file.virtualHosts).find((virtualHost) => virtualHost.id === selectedVirtualHostIdRef.current)
        ?? parsedFiles.flatMap((file) => file.virtualHosts)[0]
        ?? null;
      const nextSelectedFile = parsedFiles.find((file) => file.fullPath === nextSelectedVirtualHost?.filePath) ?? parsedFiles[0] ?? null;
      const nextPath = nextSelectedFile?.fullPath ?? null;
      const nextRawContent = nextSelectedFile?.rawContent ?? '';
      const pathChanged = previousFilePathRef.current !== nextPath;
      const rawContentChanged = previousRawContentRef.current !== nextRawContent;
      setInstallation(detected);
      setGlobalConfig(nextGlobalConfig);
      setConfigFiles(parsedFiles);
      setSelectedFile(nextSelectedFile);
      setSelectedVirtualHost(nextSelectedVirtualHost);
      previousFilePathRef.current = nextPath;
      previousRawContentRef.current = nextRawContent;
      if (pathChanged || (rawContentChanged && !hasUnsavedChangesRef.current)) {
        setEditorContent(nextRawContent);
        setHasUnsavedChanges(false);
      }
      setTestResult(null);
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(tCurrent('auto.remoteApacheManager.refreshSuccess', { value0: parsedFiles.length }));
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setError(getErrorMessage(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [isWindowsHost, runCommand]);

  const runApacheTest = useCallback(async () => {
    if (!installation) throw new Error(tCurrent('auto.remoteApacheManager.apacheNotDetected'));
    const result = await runCommand(createApacheTestCommand(isWindowsHost));
    const parsed = parseApacheTestOutput(combineOutput(result));
    return result.code === 0 ? parsed : { ...parsed, success: false };
  }, [installation, isWindowsHost, runCommand]);

  const appendNotice = useCallback((message: string) => {
    setNotice((current) => (current ? `${current}\n${message}` : message));
  }, []);

  const getReloadWarning = useCallback((output: string) => (
    `${tCurrent('auto.remoteApacheManager.reloadFailed')} ${output || tCurrent('auto.remoteApacheManager.actionFailed')}`
  ), []);

  const testConfig = useCallback(async () => {
    setActionRunning(true);
    setError('');
    setNotice('');
    try {
      const parsed = await runApacheTest();
      setTestResult(parsed);
      if (!parsed.success) {
        setError(tCurrent('auto.remoteApacheManager.testFailed'));
        return parsed;
      }
      setNotice(tCurrent('auto.remoteApacheManager.testSuccess'));
      return parsed;
    } catch (error) {
      const output = getErrorMessage(error);
      const parsed = parseApacheTestOutput(output);
      setTestResult(parsed);
      setError(output || tCurrent('auto.remoteApacheManager.testFailed'));
      return parsed;
    } finally {
      setActionRunning(false);
    }
  }, [runApacheTest]);

  const showSiteTestResult = useCallback((virtualHostId: string, result: ApacheTestResult) => {
    const currentTimer = siteTestTimerRef.current.get(virtualHostId);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer);
    setSiteTestResults((current) => ({ ...current, [virtualHostId]: result }));
    const nextTimer = window.setTimeout(() => {
      setSiteTestResults((current) => {
        const next = { ...current };
        delete next[virtualHostId];
        return next;
      });
      siteTestTimerRef.current.delete(virtualHostId);
    }, 3000);
    siteTestTimerRef.current.set(virtualHostId, nextTimer);
  }, []);

  const quickTestSite = useCallback(async (virtualHost: ApacheVirtualHost) => {
    const parsed = await testConfig();
    showSiteTestResult(virtualHost.id, parsed);
  }, [showSiteTestResult, testConfig]);

  const saveContent = useCallback(async (targetFile: ApacheConfigFile, nextContent: string, successMessage: string) => {
    if (!installation) return;
    if (!validateApacheConfigPath(targetFile.fullPath, installation)) throw new Error(tCurrent('auto.remoteApacheManager.actionFailed'));
    const previousContent = targetFile.rawContent;
    const backupResult = await runCommand(createApacheBackupCommand(targetFile.fullPath, isWindowsHost));
    if (backupResult.code !== 0) throw new Error(combineOutput(backupResult) || tCurrent('auto.remoteApacheManager.actionFailed'));
    const writeResult = await runCommand(createApacheWriteConfigCommand(targetFile.fullPath, nextContent, isWindowsHost));
    if (writeResult.code !== 0) throw new Error(combineOutput(writeResult) || tCurrent('auto.remoteApacheManager.actionFailed'));
    const parsedTest = await runApacheTest();
    setTestResult(parsedTest);
    if (!parsedTest.success) {
      const rollbackResult = await runCommand(createApacheWriteConfigCommand(targetFile.fullPath, previousContent, isWindowsHost));
      if (rollbackResult.code !== 0) throw new Error(`${tCurrent('auto.remoteApacheManager.rollbackNotice')} ${combineOutput(rollbackResult) || tCurrent('auto.remoteApacheManager.actionFailed')}`);
      throw new Error(tCurrent('auto.remoteApacheManager.rollbackNotice'));
    }
    const reloadResult = await runCommand(createApacheReloadCommand(isWindowsHost));
    const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
    await refresh();
    setNotice(successMessage);
    if (reloadWarning) appendNotice(reloadWarning);
  }, [appendNotice, getReloadWarning, installation, isWindowsHost, refresh, runApacheTest, runCommand]);

  const saveConfig = useCallback(async () => {
    if (!selectedFile) return;
    setActionRunning(true);
    setError('');
    setNotice('');
    try {
      await saveContent(selectedFile, editorContent, tCurrent('auto.remoteApacheManager.saveSuccess'));
      setHasUnsavedChanges(false);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [editorContent, saveContent, selectedFile]);

  const toggleSite = useCallback(async (virtualHost: ApacheVirtualHost) => {
    if (!installation) return;
    setActionRunning(true);
    setError('');
    setNotice('');
    try {
      const command = virtualHost.isEnabled
        ? createApacheDisableSiteCommand(virtualHost.filePath, installation, isWindowsHost)
        : createApacheEnableSiteCommand(virtualHost.filePath, installation, isWindowsHost);
      const result = await runCommand(command);
      if (result.code !== 0) throw new Error(combineOutput(result) || tCurrent('auto.remoteApacheManager.actionFailed'));
      const parsedTest = await runApacheTest();
      setTestResult(parsedTest);
      if (!parsedTest.success) {
        const rollbackCommand = virtualHost.isEnabled
          ? createApacheEnableSiteCommand(virtualHost.filePath, installation, isWindowsHost)
          : createApacheDisableSiteCommand(virtualHost.filePath, installation, isWindowsHost);
        const rollbackResult = await runCommand(rollbackCommand);
        if (rollbackResult.code !== 0) throw new Error(`${tCurrent('auto.remoteApacheManager.rollbackNotice')} ${combineOutput(rollbackResult) || tCurrent('auto.remoteApacheManager.actionFailed')}`);
        throw new Error(tCurrent('auto.remoteApacheManager.rollbackNotice'));
      }
      const reloadResult = await runCommand(createApacheReloadCommand(isWindowsHost));
      const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
      await refresh();
      setNotice(virtualHost.isEnabled ? tCurrent('auto.remoteApacheManager.disableSuccess') : tCurrent('auto.remoteApacheManager.enableSuccess'));
      if (reloadWarning) appendNotice(reloadWarning);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [appendNotice, getReloadWarning, installation, isWindowsHost, refresh, runApacheTest, runCommand]);

  const deleteSite = useCallback(async (virtualHost: ApacheVirtualHost) => {
    if (!installation) return;
    const targetFile = configFiles.find((file) => file.fullPath === virtualHost.filePath);
    if (!targetFile) return;
    setActionRunning(true);
    setError('');
    setNotice('');
    try {
      if (targetFile.virtualHosts.length > 1) {
        await saveContent(targetFile, removeVirtualHost(targetFile.rawContent, virtualHost), tCurrent('auto.remoteApacheManager.deleteSuccess'));
      } else {
        const backupPath = `${targetFile.fullPath}.deleted.${Date.now()}.bak`;
        const moveResult = await runCommand(createApacheMoveConfigToBackupCommand(targetFile.fullPath, backupPath, installation, isWindowsHost));
        if (moveResult.code !== 0) throw new Error(combineOutput(moveResult) || tCurrent('auto.remoteApacheManager.actionFailed'));
        const parsedTest = await runApacheTest();
        setTestResult(parsedTest);
        if (!parsedTest.success) {
          const rollbackResult = await runCommand(createApacheRestoreDeletedConfigCommand(backupPath, targetFile.fullPath, installation, virtualHost.isEnabled, isWindowsHost));
          if (rollbackResult.code !== 0) throw new Error(`${tCurrent('auto.remoteApacheManager.rollbackNotice')} ${combineOutput(rollbackResult) || tCurrent('auto.remoteApacheManager.actionFailed')}`);
          throw new Error(tCurrent('auto.remoteApacheManager.rollbackNotice'));
        }
        const reloadResult = await runCommand(createApacheReloadCommand(isWindowsHost));
        const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
        await refresh();
        setNotice(tCurrent('auto.remoteApacheManager.deleteSuccess'));
        if (reloadWarning) appendNotice(reloadWarning);
      }
      setPendingAction(null);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [appendNotice, configFiles, getReloadWarning, installation, isWindowsHost, refresh, runApacheTest, runCommand, saveContent]);

  const createFromTemplate = useCallback(async (template: ApacheConfigTemplate, values: Record<string, string>) => {
    if (!installation) return;
    setActionRunning(true);
    setError('');
    setNotice('');
    try {
      const validation = validateApacheTemplateValues(template, values);
      if (!validation.valid) {
        throw new Error(getTemplateValidationMessage(validation.variable, validation));
      }
      const targetPath = getCreateTargetPath(installation, template, values);
      const content = `${template.render(values).trim()}\n`;
      const prepareResult = await runCommand(createApachePrepareTemplateTargetCommand(targetPath, installation, isWindowsHost));
      if (prepareResult.code !== 0) throw new Error(combineOutput(prepareResult) || tCurrent('auto.remoteApacheManager.actionFailed'));
      const targetBackup = parseApacheTemplateTargetBackup(combineOutput(prepareResult));
      const rollbackTemplateTarget = async () => {
        const rollbackResult = await runCommand(createApacheRollbackTemplateConfigCommand(targetPath, targetBackup.backupPath, targetBackup.wasEnabled, installation, isWindowsHost));
        if (rollbackResult.code !== 0) throw new Error(`${tCurrent('auto.remoteApacheManager.rollbackNotice')} ${combineOutput(rollbackResult) || tCurrent('auto.remoteApacheManager.actionFailed')}`);
      };
      const writeResult = await runCommand(createApacheWriteConfigCommand(targetPath, content, isWindowsHost));
      if (writeResult.code !== 0) {
        await rollbackTemplateTarget();
        throw new Error(combineOutput(writeResult) || tCurrent('auto.remoteApacheManager.actionFailed'));
      }
      if (installation.sitesLayout === 'debian') {
        const enableResult = await runCommand(createApacheEnableSiteCommand(targetPath, installation, isWindowsHost));
        if (enableResult.code !== 0) {
          await rollbackTemplateTarget();
          throw new Error(combineOutput(enableResult) || tCurrent('auto.remoteApacheManager.actionFailed'));
        }
      }
      const parsedTest = await runApacheTest();
      setTestResult(parsedTest);
      if (!parsedTest.success) {
        await rollbackTemplateTarget();
        throw new Error(tCurrent('auto.remoteApacheManager.rollbackNotice'));
      }
      const reloadResult = await runCommand(createApacheReloadCommand(isWindowsHost));
      const reloadWarning = reloadResult.code !== 0 ? getReloadWarning(combineOutput(reloadResult)) : '';
      setSelectedTemplate(null);
      setTemplateValues({});
      setActiveTab('sites');
      await refresh();
      setNotice(tCurrent('auto.remoteApacheManager.createSuccess'));
      if (reloadWarning) appendNotice(reloadWarning);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  }, [appendNotice, getReloadWarning, installation, isWindowsHost, refresh, runApacheTest, runCommand]);

  const executePendingAction = async () => {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    if (action.type === 'delete') await deleteSite(action.virtualHost);
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
    selectedVirtualHostIdRef.current = selectedVirtualHost?.id ?? null;
  }, [selectedVirtualHost?.id]);

  useEffect(() => {
    if (!selectedVirtualHost && allVirtualHosts[0]) setSelectedVirtualHost(allVirtualHosts[0]);
  }, [allVirtualHosts, selectedVirtualHost]);

  useEffect(() => {
    const nextFile = configFiles.find((file) => file.fullPath === selectedVirtualHost?.filePath) ?? null;
    if (nextFile && nextFile.fullPath !== selectedFile?.fullPath && !hasUnsavedChanges) {
      setSelectedFile(nextFile);
      setEditorContent(nextFile.rawContent);
      previousFilePathRef.current = nextFile.fullPath;
      previousRawContentRef.current = nextFile.rawContent;
    }
  }, [configFiles, hasUnsavedChanges, selectedFile?.fullPath, selectedVirtualHost?.filePath]);

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

  const openTemplate = (template: ApacheConfigTemplate) => {
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
    const parsed = selectedFile ? parseApacheConfig(nextContent, selectedFile.fullPath) : null;
    setSelectedVirtualHost((current) => parsed?.virtualHosts.find((virtualHost) => virtualHost.id === current?.id) ?? parsed?.virtualHosts[0] ?? null);
  }, [selectedFile]);

  const selectedSiteActionsDisabled = actionRunning || loading || !selectedVirtualHost;
  const confirmLabel = pendingAction?.type === 'delete'
    ? tCurrent('auto.remoteApacheManager.confirmDelete')
    : tCurrent('auto.remoteApacheManager.createFromTemplate');

  return (
    <section className="apache-manager">
      <header className="apache-toolbar">
        <div className="apache-status-card">
          <span className={`apache-status-dot ${installation?.isRunning ? '' : installation ? 'warning' : 'danger'}`} aria-hidden="true" />
          <span className="apache-status-label">{tCurrent('auto.remoteApacheManager.appName')}</span>
          <span className={`apache-status-value ${installation?.isRunning ? '' : installation ? 'warning' : 'danger'}`}>{installation ? (installation.isRunning ? tCurrent('auto.remoteApacheManager.running') : tCurrent('auto.remoteApacheManager.stopped')) : tCurrent('auto.remoteApacheManager.apacheNotDetected')}</span>
          <span className="apache-status-version">{installation?.version || lastRefreshedAt || tCurrent('auto.remoteApacheManager.notScanned')}</span>
        </div>
        <div className="apache-status-divider" aria-hidden="true" />
        <label className="apache-search">
          <input aria-label={tCurrent('auto.remoteApacheManager.search')} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={tCurrent('auto.remoteApacheManager.searchPlaceholder')} />
        </label>
        <div className="apache-filter-chips" role="group" aria-label={tCurrent('auto.remoteApacheManager.filterLabel')}>
          {(['all', 'enabled', 'disabled', 'ssl', 'non-ssl'] as ApacheSiteFilter[]).map((filter) => (
            <button key={filter} type="button" className={siteFilter === filter ? 'active' : ''} aria-pressed={siteFilter === filter} onClick={() => setSiteFilter(filter)}>
              {tCurrent(`auto.remoteApacheManager.filter.${filter === 'non-ssl' ? 'nonSsl' : filter}` as MessageId)}
            </button>
          ))}
        </div>
        <div className="apache-toolbar-actions">
          <button type="button" onClick={refresh} disabled={loading || actionRunning}>{loading ? tCurrent('auto.remoteApacheManager.refreshing') : tCurrent('auto.remoteApacheManager.refresh')}</button>
          <button type="button" onClick={testConfig} disabled={!installation || actionRunning}>{tCurrent('auto.remoteApacheManager.testConfig')}</button>
          <button type="button" className="primary" onClick={() => setActiveTab('templates')} disabled={!installation || actionRunning}>{tCurrent('auto.remoteApacheManager.newSite')}</button>
        </div>
      </header>

      <div className="apache-tabs" role="tablist" aria-label={tCurrent('auto.remoteApacheManager.tabsLabel')}>
        {(['sites', 'templates', 'config'] as ApacheTab[]).map((tab) => (
          <button key={tab} id={`apache-tab-${tab}`} type="button" role="tab" className={activeTab === tab ? 'active' : ''} aria-selected={activeTab === tab} aria-controls={`apache-panel-${tab}`} tabIndex={activeTab === tab ? 0 : -1} onClick={() => setActiveTab(tab)} onKeyDown={(event) => handleTabKeyDown(event, ['sites', 'templates', 'config'] as const, activeTab, setActiveTab, 'apache-tab')}>
            {tCurrent(`auto.remoteApacheManager.${tab}` as MessageId)}
          </button>
        ))}
      </div>

      {error ? <DismissibleAlert className="apache-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="apache-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      {activeTab === 'sites' ? (
        <div id="apache-panel-sites" className="apache-layout" role="tabpanel" aria-labelledby="apache-tab-sites">
          <aside className="apache-site-list">
            <div className="apache-list-head">
              <strong>{tCurrent('auto.remoteApacheManager.sites')}</strong>
              <span>{filteredVirtualHosts.length}</span>
            </div>
            <div className="apache-site-scroll">
              {filteredVirtualHosts.length ? filteredVirtualHosts.map((virtualHost) => (
                <article key={virtualHost.id} className={`apache-site-card ${selectedVirtualHost?.id === virtualHost.id ? 'active' : ''}`} aria-current={selectedVirtualHost?.id === virtualHost.id ? 'true' : undefined}>
                  <button type="button" className="apache-site-card-select" onClick={() => setSelectedVirtualHost(virtualHost)}>
                    <span className="apache-site-card-main">
                      <span className={`apache-status-dot ${virtualHost.isEnabled ? 'enabled' : 'disabled'}`} aria-hidden="true" />
                      <strong title={virtualHostTitle(virtualHost)}>{virtualHostTitle(virtualHost)}</strong>
                      {virtualHost.sslConfig ? <small className="ssl">{tCurrent('auto.remoteApacheManager.filter.ssl')}</small> : null}
                    </span>
                    <span className="apache-site-card-badges">
                      <em title={virtualHost.filePath}>{virtualHost.filePath}</em>
                    </span>
                  </button>
                  <div className="apache-site-card-actions">
                    <button type="button" onClick={() => void quickTestSite(virtualHost)} disabled={!installation || actionRunning}>{tCurrent('auto.remoteApacheManager.quickTest')}</button>
                    <button type="button" onClick={() => void toggleSite(virtualHost)} disabled={!installation || actionRunning}>{virtualHost.isEnabled ? tCurrent('auto.remoteApacheManager.quickDisable') : tCurrent('auto.remoteApacheManager.quickEnable')}</button>
                    <button type="button" className="danger" onClick={() => openPendingAction({ type: 'delete', virtualHost })} disabled={actionRunning || loading}>{tCurrent('auto.remoteApacheManager.delete')}</button>
                  </div>
                  {siteTestResults[virtualHost.id] ? (
                    <div className={`apache-site-card-test-result ${siteTestResults[virtualHost.id].success ? 'success' : 'danger'}`} aria-live="polite">
                      {tCurrent('auto.remoteApacheManager.globalConfigTest')}{siteTestResults[virtualHost.id].output || (siteTestResults[virtualHost.id].success ? tCurrent('auto.remoteApacheManager.testSuccess') : tCurrent('auto.remoteApacheManager.testFailed'))}
                    </div>
                  ) : null}
                </article>
              )) : <div className="apache-empty-state">{loading ? tCurrent('auto.remoteApacheManager.loading') : tCurrent('auto.remoteApacheManager.noSites')}</div>}
            </div>
          </aside>

          <main className="apache-detail">
            <div className="apache-detail-hero">
              <span>{selectedVirtualHost?.sslConfig ? tCurrent('auto.remoteApacheManager.filter.ssl') : tCurrent('auto.remoteApacheManager.filter.nonSsl')}</span>
              <strong>{virtualHostTitle(selectedVirtualHost)}</strong>
              <em title={selectedVirtualHost?.filePath}>{selectedVirtualHost?.filePath ?? tCurrent('auto.remoteApacheManager.noSelection')}</em>
            </div>

            <div className="apache-sub-tabs" role="tablist" aria-label={tCurrent('auto.remoteApacheManager.detailTabsLabel')}>
              {(['overview', 'editor'] as ApacheSubTab[]).map((tab) => (
                <button key={tab} id={`apache-sub-tab-${tab}`} type="button" role="tab" className={activeSubTab === tab ? 'active' : ''} aria-selected={activeSubTab === tab} aria-controls={`apache-sub-panel-${tab}`} tabIndex={activeSubTab === tab ? 0 : -1} onClick={() => setActiveSubTab(tab)} onKeyDown={(event) => handleTabKeyDown(event, ['overview', 'editor'] as const, activeSubTab, setActiveSubTab, 'apache-sub-tab')}>
                  {tCurrent(`auto.remoteApacheManager.${tab}` as MessageId)}
                </button>
              ))}
            </div>

            {activeSubTab === 'overview' ? (
              <dl id="apache-sub-panel-overview" className="apache-detail-list" role="tabpanel" aria-labelledby="apache-sub-tab-overview">
                <div><dt>{tCurrent('auto.remoteApacheManager.serverName')}</dt><dd>{formatValue(selectedVirtualHost?.serverName)}</dd></div>
                <div><dt>{tCurrent('auto.remoteApacheManager.listenPorts')}</dt><dd>{formatValue(selectedVirtualHost?.listenPorts)}</dd></div>
                <div><dt>{tCurrent('auto.remoteApacheManager.documentRoot')}</dt><dd>{formatValue(selectedVirtualHost?.documentRoot)}</dd></div>
                <div><dt>{tCurrent('auto.remoteApacheManager.sslStatus')}</dt><dd>{selectedVirtualHost?.sslConfig ? tCurrent('auto.remoteApacheManager.enabled') : tCurrent('auto.remoteApacheManager.disabled')}</dd></div>
                <div><dt>{tCurrent('auto.remoteApacheManager.directives')}</dt><dd>{selectedVirtualHost?.directives.length ?? 0}</dd></div>
              </dl>
            ) : null}

            {activeSubTab === 'editor' ? (
              <div id="apache-sub-panel-editor" className="apache-editor" role="tabpanel" aria-labelledby="apache-sub-tab-editor">
                <Suspense fallback={<div className="apache-editor-loading">{tCurrent('auto.remoteApacheManager.editorLoading')}</div>}>
                  <NotepadEditor ariaLabel={tCurrent('auto.remoteApacheManager.editor')} className="apache-code-editor" content={editorContent} language="apache" readOnly={false} theme={editorTheme} wrapEnabled={false} onChange={handleEditorChange} onCursorChange={() => undefined} />
                </Suspense>
                <div className="apache-editor-actions">
                  <span>{hasUnsavedChanges ? tCurrent('auto.remoteApacheManager.unsavedChanges') : (selectedFile?.lastModified ? new Date(selectedFile.lastModified * 1000).toLocaleString(getShellDeskLocale()) : '-')}</span>
                  <button type="button" onClick={() => { setEditorContent(selectedFile?.rawContent ?? ''); setHasUnsavedChanges(false); }} disabled={!hasUnsavedChanges || actionRunning}>{tCurrent('auto.remoteApacheManager.revert')}</button>
                  <button type="button" className="primary" onClick={saveConfig} disabled={!hasUnsavedChanges || actionRunning}>{tCurrent('auto.remoteApacheManager.save')}</button>
                </div>
              </div>
            ) : null}

            <div className="apache-actions">
              <button type="button" onClick={() => selectedVirtualHost && void toggleSite(selectedVirtualHost)} disabled={selectedSiteActionsDisabled}>{selectedVirtualHost?.isEnabled ? tCurrent('auto.remoteApacheManager.disable') : tCurrent('auto.remoteApacheManager.enable')}</button>
              <button type="button" className="danger" onClick={() => selectedVirtualHost && openPendingAction({ type: 'delete', virtualHost: selectedVirtualHost })} disabled={selectedSiteActionsDisabled}>{tCurrent('auto.remoteApacheManager.delete')}</button>
              <button type="button" onClick={saveConfig} disabled={!hasUnsavedChanges || actionRunning}>{tCurrent('auto.remoteApacheManager.save')}</button>
            </div>

            {testResult ? <pre className={`apache-test-output ${testResult.success ? 'success' : 'danger'}`} aria-live="polite">{testResult.output || (testResult.success ? tCurrent('auto.remoteApacheManager.testSuccess') : tCurrent('auto.remoteApacheManager.testFailed'))}</pre> : null}
          </main>
        </div>
      ) : null}

      {activeTab === 'templates' ? (
        <div id="apache-panel-templates" className="apache-templates-grid" role="tabpanel" aria-labelledby="apache-tab-templates">
          {apacheConfigTemplates.map((template) => (
            <button key={template.id} type="button" className="apache-template-card" onClick={() => openTemplate(template)} disabled={!installation || actionRunning}>
              <span aria-hidden="true">{templateIcons[template.icon] || 'Conf'}</span>
              <strong>{tCurrent(template.name as MessageId)}</strong>
              <em>{tCurrent(template.description as MessageId)}</em>
            </button>
          ))}
        </div>
      ) : null}

      {activeTab === 'config' ? (
        <div id="apache-panel-config" className="apache-global-config" role="tabpanel" aria-labelledby="apache-tab-config">
          <section>
            <div className="apache-list-head">
              <strong>{installation?.configPath ?? tCurrent('auto.remoteApacheManager.config')}</strong>
              <span>{formatValue(globalConfig?.fileSize)}</span>
            </div>
            <pre>{globalConfig?.rawContent || tCurrent('auto.remoteApacheManager.noSelection')}</pre>
          </section>
          <section>
            <div className="apache-list-head">
              <strong>{tCurrent('auto.remoteApacheManager.modules')}</strong>
              <span>{installation?.loadedModules.length ?? 0}</span>
            </div>
            {installation?.loadedModules.length ? (
              <div className="apache-module-list">
                {installation.loadedModules.map((moduleName) => <span key={moduleName}>{moduleName}</span>)}
              </div>
            ) : <div className="apache-empty-state">{tCurrent('auto.remoteApacheManager.noModules')}</div>}
            <dl className="apache-detail-list">
              <div><dt>{tCurrent('auto.remoteApacheManager.version')}</dt><dd>{installation?.version ?? '-'}</dd></div>
              <div><dt>{tCurrent('auto.remoteApacheManager.configPath')}</dt><dd>{installation?.configPath ?? '-'}</dd></div>
              <div><dt>{tCurrent('auto.remoteApacheManager.lines')}</dt><dd>{globalConfig?.rawContent.split(/\r?\n/).length ?? '-'}</dd></div>
            </dl>
          </section>
        </div>
      ) : null}

      {pendingAction ? createPortal(
        <div className="apache-modal-backdrop" onKeyDown={handleDialogKeyDown} role="presentation">
          <div ref={dialogRef} className={`apache-confirm-dialog ${pendingAction.type === 'delete' ? 'danger' : ''}`} role="dialog" aria-modal="true" aria-label={confirmLabel}>
            <div className="apache-confirm-header">
              <span>{tCurrent('auto.remoteApacheManager.appName')}</span>
              <strong>{confirmLabel}</strong>
            </div>
            <p>{pendingAction.type === 'create-from-template' ? tCurrent(pendingAction.template.name as MessageId) : virtualHostTitle(pendingAction.virtualHost)}</p>
            <div className="apache-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteApacheManager.cancel')}</button>
              <button type="button" className={pendingAction.type === 'delete' ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>{actionRunning ? tCurrent('auto.remoteApacheManager.runningAction') : tCurrent('auto.remoteApacheManager.confirm')}</button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {selectedTemplate ? createPortal(
        <div className="apache-modal-backdrop" onKeyDown={handleDialogKeyDown} role="presentation">
          <div ref={dialogRef} className="apache-template-wizard" role="dialog" aria-modal="true" aria-label={tCurrent('auto.remoteApacheManager.createFromTemplate')}>
            <div className="apache-confirm-header">
              <span>{tCurrent('auto.remoteApacheManager.createFromTemplate')}</span>
              <strong>{tCurrent(selectedTemplate.name as MessageId)}</strong>
            </div>
            <div className="apache-template-fields">
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
            <div className="apache-confirm-actions">
              <button type="button" onClick={() => setSelectedTemplate(null)}>{tCurrent('auto.remoteApacheManager.cancel')}</button>
              <button type="button" className="primary" onClick={() => { setSelectedTemplate(null); openPendingAction({ type: 'create-from-template', template: selectedTemplate, values: templateValues }); }} disabled={actionRunning}>
                {tCurrent('auto.remoteApacheManager.createFromTemplate')}
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

export default RemoteApacheManager;
