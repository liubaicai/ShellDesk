import { type ChangeEvent, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  getTerminalThemeChoice,
  terminalBoldWeightChoices,
  terminalFontWeightChoices,
  terminalThemeChoices,
} from '../components/remote-desktop/terminalPresets';
import {
  defaultDesktopWallpaperPresetId,
  desktopWallpaperPresets,
  getDesktopWallpaperPreset,
  loadDesktopWallpaperPresetUrl,
} from '../assets/desktopWallpapers';
import { getCurrentAppLocale, t } from '../i18n';
import { SftpSettingsFields } from '../components/SftpSettingsFields';
import { TerminalSessionSettingsFields } from '../components/TerminalSessionSettingsFields';
import { SettingsAboutSection } from './SettingsAboutSection';
import {
  settingsSections,
  defaultSettingsSection,
  accentColorChoices,
  terminalLineHeightChoices,
  terminalScrollSensitivityChoices,
  terminalFastScrollSensitivityChoices,
  fallbackSystemFontChoices,
  interfacePreferredFontChoices,
  terminalPreferredFontChoices,
  maxWallpaperImageBytes,
  defaultMcpServerEndpoint,
  mcpCallExample,
  skillCallExample,
  acceptedWallpaperTypes,
  wallpaperExtensionPattern,
  wallpaperDataUrlPattern,
  terminalContrastChoices,
  desktopDockPositionChoices,
  desktopDockSizeChoices,
  desktopDockAutoHideChoices,
  desktopDockPinnedAppChoices,
  aiProviderChoices,
  webSearchProviderChoices,
  defaultSyncRemotePath,
  syncIntervalChoices,
  isCustomAiProvider,
  createDefaultUpdateStatus,
  createDefaultSyncForm,
  createSyncFormFromConfig,
  formatDateTime,
  getSettingsSectionNavClass,
  readFileAsDataUrl,
  normalizeFontChoices,
  createFontOptions,
  getFontListErrorMessage,
  getUpdateCheckErrorMessage,
  getSettingsErrorMessage,
  getSyncStatusClassName,
  getAiModelDisplayName,
  getAiModelDetail,
  fetchRemoteAiModels,
  getBuiltinAiModels,
} from './settingsPageModel';

interface SettingsPageProps {
  hostCount: number;
  keyCount: number;
  bookmarkCount: number;
  settings: ShellDeskAppSettings;
  storageInfo: ShellDeskStorageInfo | null;
  isConfigTransferPending: boolean;
  updateCheckRequestId: number;
  initialSection?: (typeof settingsSections)[number]['key'];
  sectionRequestId?: number;
  onInitialSectionApplied?: () => void;
  onSettingsChange: (settings: ShellDeskAppSettings) => void;
  onImportConfig: () => void;
  onExportConfig: () => void;
}

type SyncPendingAction =
  | 'load'
  | 'save'
  | 'test'
  | 'run'
  | 'resolve-local'
  | 'resolve-remote'
  | 'restore-remote'
  | 'keep-empty'
  | 'allow-shrink'
  | '';

function SettingsPage({
  hostCount,
  keyCount,
  bookmarkCount,
  settings,
  storageInfo,
  isConfigTransferPending,
  updateCheckRequestId,
  initialSection,
  sectionRequestId,
  onInitialSectionApplied,
  onSettingsChange,
  onImportConfig,
  onExportConfig,
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<(typeof settingsSections)[number]['key']>(defaultSettingsSection);
  const [wallpaperError, setWallpaperError] = useState('');
  const [wallpaperPresetUrls, setWallpaperPresetUrls] = useState<Record<string, string>>({});
  const [systemFonts, setSystemFonts] = useState<string[]>(fallbackSystemFontChoices);
  const [isSystemFontsLoading, setIsSystemFontsLoading] = useState(false);
  const [systemFontsError, setSystemFontsError] = useState('');
  const [aiModelOptions, setAiModelOptions] = useState<ShellDeskAiModelInfo[]>([]);
  const [isAiModelsLoading, setIsAiModelsLoading] = useState(false);
  const [aiModelsMessage, setAiModelsMessage] = useState('');
  const [aiModelsError, setAiModelsError] = useState('');
  const [isAiModelListOpen, setIsAiModelListOpen] = useState(false);
  const [showWebSearchApiKey, setShowWebSearchApiKey] = useState(false);
  const [mcpServerStatus, setMcpServerStatus] = useState<ShellDeskMcpServerStatus | null>(null);
  const [isMcpServerPending, setIsMcpServerPending] = useState(false);
  const [isMcpSkillExporting, setIsMcpSkillExporting] = useState(false);
  const [mcpMessage, setMcpMessage] = useState('');
  const [mcpError, setMcpError] = useState('');
  const [mcpExampleDialog, setMcpExampleDialog] = useState<'mcp' | 'skill' | null>(null);
  const [appInfo, setAppInfo] = useState<ShellDeskAppInfo | null>(null);
  const [updateCheckResult, setUpdateCheckResult] = useState<ShellDeskUpdateCheckResult | null>(null);
  const [updateStatus, setUpdateStatus] = useState<ShellDeskUpdateStatus>(() => createDefaultUpdateStatus());
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [updateCheckError, setUpdateCheckError] = useState('');
  const updateCheckInFlightRef = useRef(false);
  const [syncConfig, setSyncConfig] = useState<ShellDeskSyncPublicConfig | null>(null);
  const [syncForm, setSyncForm] = useState<ShellDeskSyncConfigInput>(() => createDefaultSyncForm());
  const [syncMessage, setSyncMessage] = useState('');
  const [syncError, setSyncError] = useState('');
  const [syncConflicts, setSyncConflicts] = useState<ShellDeskSyncConflict[]>([]);
  const [syncNeedsResolution, setSyncNeedsResolution] = useState(false);
  const [syncEmptyVaultSummary, setSyncEmptyVaultSummary] = useState<ShellDeskSyncEmptyVaultSummary | null>(null);
  const [syncNeedsEmptyVaultResolution, setSyncNeedsEmptyVaultResolution] = useState(false);
  const [syncShrinkSummary, setSyncShrinkSummary] = useState<ShellDeskSyncShrinkSummary | null>(null);
  const [syncNeedsShrinkConfirmation, setSyncNeedsShrinkConfirmation] = useState(false);
  const [syncShrinkConflictResolution, setSyncShrinkConflictResolution] = useState<ShellDeskSyncConflictResolution | ''>('');
  const [syncPendingAction, setSyncPendingAction] = useState<SyncPendingAction>('');

  useEffect(() => {
    if (initialSection) {
      setActiveSection(initialSection);
      onInitialSectionApplied?.();
    }
  }, [initialSection, onInitialSectionApplied, sectionRequestId]);

  useEffect(() => {
    if (activeSection !== 'ai') {
      return undefined;
    }

    let isCurrent = true;
    const getStatus = window.guiSSH?.ai?.getMcpServerStatus;
    if (!getStatus) {
      setMcpError(t('settings.ai.mcp.error.noApi', settings.language));
      return undefined;
    }

    void getStatus()
      .then((status) => {
        if (isCurrent) {
          setMcpServerStatus(status);
          setMcpError(status.error ?? '');
        }
      })
      .catch((error: unknown) => {
        if (isCurrent) {
          setMcpError(error instanceof Error ? error.message : t('settings.ai.mcp.error.statusFailed', settings.language));
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [activeSection, settings.language, settings.mcpServerEnabled]);

  const updateSetting = <Field extends keyof ShellDeskAppSettings>(field: Field, value: ShellDeskAppSettings[Field]) => {
    onSettingsChange({
      ...settings,
      [field]: value,
    });
  };

  const updateMinimizeToTrayOnClose = (enabled: boolean) => {
    onSettingsChange({
      ...settings,
      minimizeToTrayOnClose: enabled,
      minimizeToTrayPromptedOnClose: true,
    });
  };

  const updateDockPinnedApp = (appKey: ShellDeskDesktopAppKey, isPinned: boolean) => {
    const currentPinnedApps = settings.remoteDesktopDockPinnedApps.filter((pinnedAppKey) => (
      desktopDockPinnedAppChoices.some((choice) => choice.key === pinnedAppKey)
    ));
    const nextPinnedApps = isPinned
      ? [...currentPinnedApps, appKey].filter((pinnedAppKey, index, appKeys) => appKeys.indexOf(pinnedAppKey) === index)
      : currentPinnedApps.filter((pinnedAppKey) => pinnedAppKey !== appKey);

    updateSetting('remoteDesktopDockPinnedApps', nextPinnedApps);
  };

  const selectedTerminalTheme = getTerminalThemeChoice(settings.terminalTheme);
  const visibleAiProvider = isCustomAiProvider(settings.aiProvider) ? 'custom' : settings.aiProvider;
  const selectedAiProvider = aiProviderChoices.find((choice) => choice.value === visibleAiProvider) ?? aiProviderChoices[0];
  const selectedWebSearchProvider = webSearchProviderChoices.find((choice) => choice.value === settings.webSearchProvider) ?? webSearchProviderChoices[0];
  const selectedAiModelInList = aiModelOptions.some((model) => model.id === settings.aiModel);
  const visibleAiModelOptions = selectedAiModelInList || !settings.aiModel
    ? aiModelOptions
    : [{ id: settings.aiModel, name: settings.aiModel }, ...aiModelOptions];
  const selectedAiModelOption = visibleAiModelOptions.find((model) => model.id === settings.aiModel) ?? null;
  const aiModelStatus = aiModelsError || aiModelsMessage || (
    aiModelOptions.length
      ? t('settings.ai.model.loaded', settings.language, { count: String(aiModelOptions.length) })
      : t('settings.ai.model.fetchHint', settings.language)
  );
  const mcpStatusText = isMcpServerPending
    ? t('settings.ai.mcp.status.updating', settings.language)
    : mcpError
      ? t('settings.ai.mcp.status.error', settings.language, { error: mcpError })
      : mcpServerStatus?.running
        ? t('settings.ai.mcp.status.running', settings.language, { endpoint: mcpServerStatus.endpoint })
        : t('settings.ai.mcp.status.stopped', settings.language);
  const interfaceFontOptions = useMemo(
    () => createFontOptions(systemFonts, settings.interfaceFont, interfacePreferredFontChoices),
    [settings.interfaceFont, systemFonts],
  );
  const terminalFontOptions = useMemo(
    () => createFontOptions(systemFonts, settings.terminalFontFamily, terminalPreferredFontChoices),
    [settings.terminalFontFamily, systemFonts],
  );
  const fontListStatus = systemFontsError
    ? t('settings.fonts.status.fallback', settings.language, { error: systemFontsError })
    : isSystemFontsLoading
      ? t('settings.fonts.status.loading', settings.language)
      : t('settings.fonts.status.loaded', settings.language, { count: String(systemFonts.length) });
  const hasCustomWallpaper = settings.desktopWallpaperMode === 'custom' && Boolean(settings.desktopWallpaperDataUrl);
  const selectedWallpaperPreset = getDesktopWallpaperPreset(settings.desktopWallpaperPresetId);
  const selectedWallpaperPresetLabel = t(selectedWallpaperPreset.labelId, settings.language);
  const wallpaperPreviewUrl = hasCustomWallpaper
    ? settings.desktopWallpaperDataUrl
    : wallpaperPresetUrls[selectedWallpaperPreset.id] || '';
  const wallpaperPreviewLabel = hasCustomWallpaper ? t('settings.wallpaper.custom', settings.language) : selectedWallpaperPresetLabel;
  const isDefaultWallpaperPreset = !hasCustomWallpaper && selectedWallpaperPreset.id === defaultDesktopWallpaperPresetId;
  const wallpaperPreviewAriaLabel = hasCustomWallpaper
    ? t('settings.wallpaper.customPreview', settings.language)
    : `${selectedWallpaperPresetLabel} ${t('settings.wallpaper.preview', settings.language)}`;
  const wallpaperPreviewStyle: CSSProperties = {
    backgroundImage: wallpaperPreviewUrl
      ? `linear-gradient(180deg, rgba(8, 13, 20, 0.16), rgba(8, 13, 20, 0.34)), url(${JSON.stringify(wallpaperPreviewUrl)})`
      : 'linear-gradient(180deg, rgba(8, 13, 20, 0.16), rgba(8, 13, 20, 0.34))',
  };
  const pinnedDockAppLabels = desktopDockPinnedAppChoices
    .filter((appChoice) => settings.remoteDesktopDockPinnedApps.includes(appChoice.key))
    .map((appChoice) => t(appChoice.labelId, settings.language));
  const pinnedDockAppPreviewLabels = pinnedDockAppLabels.slice(0, 4);
  const pinnedDockAppMoreCount = Math.max(0, pinnedDockAppLabels.length - pinnedDockAppPreviewLabels.length);

  useEffect(() => {
    let isCurrent = true;

    Promise.all(desktopWallpaperPresets.map(async (preset) => {
      const url = await loadDesktopWallpaperPresetUrl(preset.id);
      return [preset.id, url] as const;
    }))
      .then((entries) => {
        if (isCurrent) {
          setWallpaperPresetUrls(Object.fromEntries(entries));
        }
      })
      .catch(() => undefined);

    return () => {
      isCurrent = false;
    };
  }, []);

  const appDisplayName = appInfo?.productName || window.guiSSH?.appName || 'ShellDesk';
  const appVersion = appInfo?.version || '0.0.1';
  const appPlatform = appInfo ? `${appInfo.platform} ${appInfo.arch}` : t('settings.about.runtime.current', settings.language);
  const updateProgressPercent = Math.max(0, Math.min(100, Math.round(updateStatus.percent)));
  const updateVersion = updateStatus.version || updateCheckResult?.latestVersion || '';
  const isUpdateDownloading = updateStatus.status === 'downloading';
  const isUpdateReady = updateStatus.status === 'ready';
  const canOpenUpdateRelease = Boolean(updateCheckResult?.releaseUrl || updateCheckResult?.downloadUrl || updateStatus.version);
  const canManualDownloadUpdate = updateStatus.supported !== false && updateStatus.status === 'available';
  const updateStatusText = updateStatus.status === 'downloading'
    ? t('settings.update.status.downloading', settings.language, { percent: String(updateProgressPercent) })
    : updateStatus.status === 'ready'
      ? t('settings.update.status.ready', settings.language)
      : updateStatus.status === 'error'
        ? t('settings.update.status.downloadError', settings.language, { error: updateStatus.error || t('settings.error.updateCheckFailed', settings.language) })
        : updateCheckError
          ? updateCheckError
          : updateStatus.isChecking || isCheckingForUpdates
            ? t('settings.update.status.checking', settings.language)
            : updateStatus.status === 'available'
              ? t('settings.update.status.available', settings.language, { version: updateVersion })
              : updateCheckResult
                ? updateCheckResult.updateAvailable
                  ? t('settings.update.status.available', settings.language, { version: updateCheckResult.latestVersion })
                  : t('settings.update.status.upToDate', settings.language)
                : t('settings.update.status.notChecked', settings.language);
  const updateStatusClassName = updateStatus.status === 'error' || updateCheckError
    ? 'error'
    : isUpdateReady || updateCheckResult?.updateAvailable === false
      ? 'success'
      : updateStatus.status === 'available' || updateStatus.status === 'downloading' || updateCheckResult?.updateAvailable
      ? 'available'
      : '';
  const hasSavedWebDavPassword = Boolean(syncConfig?.hasWebDavPassword);
  const hasSavedSyncPassphrase = Boolean(syncConfig?.hasSyncPassphrase);
  const isSyncBusy = Boolean(syncPendingAction);
  const syncStatusClassName = getSyncStatusClassName(syncConfig?.lastSyncStatus, Boolean(syncError));
  const syncStatusText = syncError || syncMessage || syncConfig?.lastSyncMessage || t('settings.sync.status.notConfigured', settings.language);
  const syncLastSyncText = syncConfig?.lastSyncAt ? formatDateTime(syncConfig.lastSyncAt) : t('settings.sync.lastSync.notSynced', settings.language);
  const syncConflictCount = Math.max(syncConflicts.length, syncConfig?.lastConflictCount ?? 0);
  const syncHasPendingResolution = syncNeedsResolution || (syncConfig?.lastConflictCount ?? 0) > 0;
  const syncHasSafetyGate = syncNeedsEmptyVaultResolution || syncNeedsShrinkConfirmation;

  const selectDesktopWallpaperPreset = (presetId: string) => {
    setWallpaperError('');
    onSettingsChange({
      ...settings,
      desktopWallpaperMode: 'preset',
      desktopWallpaperPresetId: presetId,
      desktopWallpaperDataUrl: '',
      desktopWallpaperName: '',
    });
  };

  const resetDesktopWallpaper = () => {
    selectDesktopWallpaperPreset(defaultDesktopWallpaperPresetId);
  };

  const updateAiProvider = (provider: ShellDeskAiProvider) => {
    const providerChoice = aiProviderChoices.find((choice) => choice.value === provider) ?? aiProviderChoices[0];

    setAiModelOptions([]);
    setAiModelsMessage('');
    setAiModelsError('');
    setIsAiModelListOpen(false);
    onSettingsChange({
      ...settings,
      aiProvider: providerChoice.value,
      aiProviderName: t(providerChoice.labelId, settings.language),
      aiApiFormat: providerChoice.apiFormat,
      aiApiBaseUrl: providerChoice.defaultApiBaseUrl,
      aiModel: '',
    });
  };

  const updateWebSearchProvider = (provider: ShellDeskWebSearchProvider) => {
    const providerChoice = webSearchProviderChoices.find((choice) => choice.value === provider) ?? webSearchProviderChoices[0];

    onSettingsChange({
      ...settings,
      webSearchProvider: providerChoice.value,
      webSearchApiBaseUrl: providerChoice.defaultApiBaseUrl,
      webSearchApiKey: '',
    });
  };

  const fetchAiModels = async () => {
    if (isCustomAiProvider(settings.aiProvider) && !settings.aiApiBaseUrl.trim()) {
      setAiModelsError(t('settings.ai.model.error.apiBaseUrlRequired', settings.language));
      setAiModelsMessage('');
      return;
    }

    if (settings.aiApiFormat === 'anthropic' && !settings.aiApiKey.trim()) {
      setAiModelsError(t('settings.ai.model.error.apiKeyRequired', settings.language));
      setAiModelsMessage('');
      return;
    }

    setIsAiModelsLoading(true);
    setAiModelsError('');
    setAiModelsMessage('');

    try {
      const models = isCustomAiProvider(settings.aiProvider)
        ? await fetchRemoteAiModels(settings)
        : getBuiltinAiModels(settings);

      setAiModelOptions(models);
      setAiModelsMessage(t('settings.ai.model.loaded', settings.language, { count: String(models.length) }));
      setIsAiModelListOpen(models.length > 0);
    } catch (error) {
      setAiModelOptions([]);
      setIsAiModelListOpen(false);
      setAiModelsError(error instanceof Error ? error.message : t('settings.ai.model.error.fetchFailed', settings.language));
    } finally {
      setIsAiModelsLoading(false);
    }
  };

  const updateMcpServerEnabled = async (enabled: boolean) => {
    const setEnabled = window.guiSSH?.ai?.setMcpServerEnabled;
    if (!setEnabled) {
      setMcpError(t('settings.ai.mcp.error.noApi', settings.language));
      return;
    }

    setIsMcpServerPending(true);
    setMcpMessage('');
    setMcpError('');
    try {
      const status = await setEnabled(enabled);
      setMcpServerStatus(status);
      setMcpError(status.error ?? '');
      updateSetting('mcpServerEnabled', enabled);
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : t('settings.ai.mcp.error.toggleFailed', settings.language));
    } finally {
      setIsMcpServerPending(false);
    }
  };

  const exportMcpSkill = async () => {
    const exportSkill = window.guiSSH?.ai?.exportMcpSkill;
    if (!exportSkill) {
      setMcpError(t('settings.ai.mcp.error.noApi', settings.language));
      return;
    }

    setIsMcpSkillExporting(true);
    setMcpMessage('');
    setMcpError('');
    try {
      const result = await exportSkill();
      if (!result.canceled) {
        setMcpMessage(t('settings.ai.mcp.skill.exported', settings.language, { path: result.path ?? '' }));
      }
    } catch (error) {
      setMcpError(error instanceof Error ? error.message : t('settings.ai.mcp.error.exportFailed', settings.language));
    } finally {
      setIsMcpSkillExporting(false);
    }
  };

  const openExternalLink = useCallback((url: string) => {
    const openExternal = window.guiSSH?.app?.openExternal;
    const openFallback = () => {
      if (/^mailto:/i.test(url)) {
        window.location.href = url;
        return;
      }

      window.open(url, '_blank', 'noopener,noreferrer');
    };

    if (openExternal) {
      void openExternal(url).catch(openFallback);
      return;
    }

    openFallback();
  }, []);

  const checkForUpdates = async () => {
    if (updateCheckInFlightRef.current) {
      return;
    }

    const checkUpdates = window.guiSSH?.app?.checkForUpdates;

    if (!checkUpdates) {
      setUpdateCheckError(t('settings.update.error.noApi', settings.language));
      return;
    }

    updateCheckInFlightRef.current = true;
    setIsCheckingForUpdates(true);
    setUpdateCheckError('');

    try {
      const result = await checkUpdates();
      setUpdateCheckResult(result);

      if (result.updateAvailable && settings.autoUpdateEnabled) {
        const checkForUpdateDownload = window.guiSSH?.app?.checkForUpdateDownload;

        if (checkForUpdateDownload) {
          setUpdateStatus((current) => ({ ...current, isChecking: true, error: null }));
          void checkForUpdateDownload()
            .then((autoResult) => {
              if (autoResult.supported === false) {
                setUpdateStatus((current) => ({
                  ...current,
                  supported: false,
                  unsupportedReason: autoResult.error || current.unsupportedReason,
                  isChecking: false,
                }));
                return;
              }

              if (autoResult.ready) {
                setUpdateStatus((current) => ({
                  ...current,
                  status: 'ready',
                  percent: 100,
                  version: autoResult.version || current.version || result.latestVersion,
                  isChecking: false,
                  error: null,
                }));
                return;
              }

              if (autoResult.downloading) {
                setUpdateStatus((current) => ({
                  ...current,
                  status: 'downloading',
                  version: autoResult.version || current.version || result.latestVersion,
                  isChecking: false,
                  error: null,
                }));
                return;
              }

              if (autoResult.available && autoResult.version) {
                setUpdateStatus((current) => ({
                  ...current,
                  version: autoResult.version || result.latestVersion,
                  isChecking: Boolean(autoResult.checking),
                  error: null,
                }));
                return;
              }

              if (autoResult.error) {
                const errorMessage = autoResult.error;
                setUpdateStatus((current) => ({
                  ...current,
                  status: 'error',
                  error: errorMessage,
                  isChecking: false,
                }));
                return;
              }

              setUpdateStatus((current) => ({
                ...current,
                isChecking: Boolean(autoResult.checking),
              }));
            })
            .catch((error: unknown) => {
              setUpdateStatus((current) => ({
                ...current,
                status: 'error',
                error: getUpdateCheckErrorMessage(error, settings.language),
                isChecking: false,
              }));
            });
        }
      }
    } catch (error) {
      setUpdateCheckResult(null);
      setUpdateCheckError(getUpdateCheckErrorMessage(error, settings.language));
    } finally {
      updateCheckInFlightRef.current = false;
      setIsCheckingForUpdates(false);
    }
  };

  const downloadUpdate = async () => {
    const download = window.guiSSH?.app?.downloadUpdate;

    if (!download) {
      setUpdateStatus((current) => ({
        ...current,
        status: 'error',
        error: t('settings.update.error.noApi', settings.language),
      }));
      return;
    }

    setUpdateStatus((current) => ({
      ...current,
      status: 'downloading',
      percent: 0,
      error: null,
    }));

    try {
      const result = await download();

      if (!result.success) {
        setUpdateStatus((current) => ({
          ...current,
          status: 'error',
          percent: 0,
          error: result.error || t('settings.error.updateCheckFailed', settings.language),
        }));
      }
    } catch (error) {
      setUpdateStatus((current) => ({
        ...current,
        status: 'error',
        percent: 0,
        error: getUpdateCheckErrorMessage(error, settings.language),
      }));
    }
  };

  const installUpdate = async () => {
    const install = window.guiSSH?.app?.installUpdate;

    if (!install) {
      setUpdateStatus((current) => ({
        ...current,
        status: 'error',
        error: t('settings.update.error.noApi', settings.language),
      }));
      return;
    }

    try {
      await install();
    } catch (error) {
      setUpdateStatus((current) => ({
        ...current,
        status: 'error',
        error: getUpdateCheckErrorMessage(error, settings.language),
      }));
    }
  };

  useEffect(() => {
    if (updateCheckRequestId <= 0) {
      return;
    }

    void checkForUpdates();
  }, [updateCheckRequestId]);

  const applySyncConfig = useCallback((config: ShellDeskSyncPublicConfig) => {
    setSyncConfig(config);
    setSyncForm(createSyncFormFromConfig(config));
    setSyncEmptyVaultSummary(null);
    setSyncNeedsEmptyVaultResolution(false);
    setSyncShrinkSummary(null);
    setSyncNeedsShrinkConfirmation(false);
    setSyncShrinkConflictResolution('');
    if ((config.lastConflictCount ?? 0) > 0) {
      setSyncNeedsResolution(true);
      return;
    }

    setSyncConflicts([]);
    setSyncNeedsResolution(false);
  }, []);

  const clearSyncSafetyState = () => {
    setSyncEmptyVaultSummary(null);
    setSyncNeedsEmptyVaultResolution(false);
    setSyncShrinkSummary(null);
    setSyncNeedsShrinkConfirmation(false);
    setSyncShrinkConflictResolution('');
  };

  const updateSyncForm = <Field extends keyof ShellDeskSyncConfigInput>(field: Field, value: ShellDeskSyncConfigInput[Field]) => {
    setSyncForm((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const saveAutoSyncConfig = async () => {
    const syncControls = window.guiSSH?.sync;

    if (!syncControls) {
      setSyncError(t('settings.sync.error.noApi', settings.language));
      return;
    }

    setSyncPendingAction('save');
    setSyncError('');
    setSyncMessage('');

    try {
      const config = await syncControls.saveConfig(syncForm);
      applySyncConfig(config);
      setSyncMessage(t('settings.sync.message.saved', settings.language));
      setSyncConflicts([]);
      setSyncNeedsResolution(false);
      clearSyncSafetyState();
    } catch (error) {
      setSyncError(getSettingsErrorMessage(error, settings.language));
    } finally {
      setSyncPendingAction('');
    }
  };

  const testAutoSyncConnection = async () => {
    const syncControls = window.guiSSH?.sync;

    if (!syncControls) {
      setSyncError(t('settings.sync.error.noApi', settings.language));
      return;
    }

    setSyncPendingAction('test');
    setSyncError('');
    setSyncMessage('');

    try {
      const result = await syncControls.testWebDav(syncForm);
      setSyncMessage(result.message);
      setSyncConflicts([]);
      setSyncNeedsResolution(false);
      clearSyncSafetyState();
    } catch (error) {
      setSyncError(getSettingsErrorMessage(error, settings.language));
    } finally {
      setSyncPendingAction('');
    }
  };

  const runAutoSyncNow = async (options: {
    conflictResolution?: ShellDeskSyncConflictResolution;
    emptyVaultResolution?: ShellDeskSyncEmptyVaultResolution;
    shrinkResolution?: ShellDeskSyncShrinkResolution;
  } = {}) => {
    const syncControls = window.guiSSH?.sync;

    if (!syncControls) {
      setSyncError(t('settings.sync.error.noApi', settings.language));
      return;
    }

    const { conflictResolution, emptyVaultResolution, shrinkResolution } = options;

    setSyncPendingAction(conflictResolution === 'local'
      ? 'resolve-local'
      : conflictResolution === 'remote'
        ? 'resolve-remote'
        : emptyVaultResolution === 'restoreRemote'
          ? 'restore-remote'
          : emptyVaultResolution === 'keepEmpty'
            ? 'keep-empty'
            : shrinkResolution === 'allow'
              ? 'allow-shrink'
              : 'run');
    setSyncError('');
    setSyncMessage('');

    try {
      const result = await syncControls.runNow({ ...syncForm, ...options });
      setSyncConflicts(result.conflicts);

      if (result.needsEmptyVaultResolution) {
        setSyncConfig(result.config);
        setSyncEmptyVaultSummary(result.emptyVaultSummary);
        setSyncNeedsEmptyVaultResolution(true);
        setSyncShrinkSummary(null);
        setSyncNeedsShrinkConfirmation(false);
        setSyncShrinkConflictResolution('');
        setSyncNeedsResolution(false);
        setSyncMessage(t('settings.sync.message.emptyVaultNeedsResolution', settings.language, {
          count: result.emptyVaultSummary?.remoteRecords ?? 0,
        }));
        return;
      }

      if (result.needsShrinkConfirmation) {
        setSyncConfig(result.config);
        setSyncShrinkSummary(result.shrinkSummary);
        setSyncNeedsShrinkConfirmation(true);
        setSyncShrinkConflictResolution(result.resolution);
        setSyncEmptyVaultSummary(null);
        setSyncNeedsEmptyVaultResolution(false);
        setSyncNeedsResolution(false);
        setSyncMessage(t('settings.sync.message.shrinkNeedsConfirmation', settings.language, {
          lost: result.shrinkSummary?.lostRecords ?? 0,
          baseline: result.shrinkSummary?.baselineRecords ?? 0,
          next: result.shrinkSummary?.mergedRecords ?? 0,
        }));
        return;
      }

      if (result.needsResolution) {
        setSyncConfig(result.config);
        clearSyncSafetyState();
        setSyncNeedsResolution(true);
        setSyncMessage(t('settings.sync.message.needsResolution', settings.language, { count: result.conflictCount }));
        return;
      }

      applySyncConfig(result.config);
      clearSyncSafetyState();
      setSyncNeedsResolution(false);
      setSyncMessage(result.conflictCount && result.resolution
        ? t(result.resolution === 'local' ? 'settings.sync.message.resolvedLocal' : 'settings.sync.message.resolvedRemote', settings.language, { count: result.conflictCount })
        : t('settings.sync.message.summary', settings.language, {
          uploaded: result.uploaded,
          downloaded: result.downloaded,
          deleted: result.deleted,
        }));
    } catch (error) {
      setSyncError(getSettingsErrorMessage(error, settings.language));
    } finally {
      setSyncPendingAction('');
    }
  };

  useEffect(() => {
    const getInfo = window.guiSSH?.app?.getInfo;

    if (!getInfo) {
      return;
    }

    let disposed = false;

    void getInfo()
      .then((info) => {
        if (!disposed) {
          setAppInfo(info);
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const appControls = window.guiSSH?.app;
    const eventControls = window.guiSSH?.events;

    let disposed = false;

    void appControls?.getUpdateStatus?.()
      .then((status) => {
        if (!disposed) {
          setUpdateStatus(status);
        }
      })
      .catch(() => undefined);

    const cleanups = [
      eventControls?.onUpdateAvailable?.((payload) => setUpdateStatus(payload)),
      eventControls?.onUpdateNotAvailable?.((payload) => setUpdateStatus(payload)),
      eventControls?.onUpdateDownloadProgress?.((payload) => setUpdateStatus(payload)),
      eventControls?.onUpdateDownloaded?.((payload) => setUpdateStatus(payload)),
      eventControls?.onUpdateError?.((payload) => setUpdateStatus(payload)),
    ].filter((cleanup): cleanup is () => void => typeof cleanup === 'function');

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => {
    const getSyncConfig = window.guiSSH?.sync?.getConfig;

    if (!getSyncConfig) {
      setSyncError(t('settings.sync.error.noApi', settings.language));
      return;
    }

    let disposed = false;
    setSyncPendingAction('load');

    void getSyncConfig()
      .then((config) => {
        if (!disposed) {
          applySyncConfig(config);
          setSyncError('');
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setSyncError(getSettingsErrorMessage(error, settings.language));
        }
      })
      .finally(() => {
        if (!disposed) {
          setSyncPendingAction('');
        }
      });

    return () => {
      disposed = true;
    };
  }, [applySyncConfig]);

  useEffect(() => {
    const removeSyncChanged = window.guiSSH?.events?.onSyncChanged?.((result) => {
      setSyncConfig(result.config);
      setSyncConflicts(result.conflicts);
      setSyncNeedsResolution(result.needsResolution || (result.config.lastConflictCount ?? 0) > 0);
      setSyncEmptyVaultSummary(result.emptyVaultSummary);
      setSyncNeedsEmptyVaultResolution(result.needsEmptyVaultResolution);
      setSyncShrinkSummary(result.shrinkSummary);
      setSyncNeedsShrinkConfirmation(result.needsShrinkConfirmation);
      setSyncShrinkConflictResolution(result.resolution);

      if (result.needsEmptyVaultResolution) {
        setSyncMessage(t('settings.sync.message.emptyVaultNeedsResolution', settings.language, {
          count: result.emptyVaultSummary?.remoteRecords ?? 0,
        }));
        setSyncError('');
        return;
      }

      if (result.needsShrinkConfirmation) {
        setSyncMessage(t('settings.sync.message.shrinkNeedsConfirmation', settings.language, {
          lost: result.shrinkSummary?.lostRecords ?? 0,
          baseline: result.shrinkSummary?.baselineRecords ?? 0,
          next: result.shrinkSummary?.mergedRecords ?? 0,
        }));
        setSyncError('');
        return;
      }

      if (result.needsResolution) {
        setSyncMessage(t('settings.sync.message.needsResolution', settings.language, { count: String(result.conflictCount) }));
        setSyncError('');
      }
    });

    return () => {
      removeSyncChanged?.();
    };
  }, [settings.language]);

  useEffect(() => {
    const listFonts = window.guiSSH?.system?.listFonts;

    if (!listFonts) {
      setSystemFonts(fallbackSystemFontChoices);
      setSystemFontsError(t('settings.fonts.error.noApi', settings.language));
      return;
    }

    let disposed = false;
    setIsSystemFontsLoading(true);
    setSystemFontsError('');

    void listFonts()
      .then((fontFamilies) => {
        if (disposed) {
          return;
        }

        const nextSystemFonts = normalizeFontChoices(fontFamilies);
        setSystemFonts(nextSystemFonts.length ? nextSystemFonts : fallbackSystemFontChoices);
        setSystemFontsError(nextSystemFonts.length ? '' : t('settings.fonts.error.empty', settings.language));
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }

        setSystemFonts(fallbackSystemFontChoices);
        setSystemFontsError(getFontListErrorMessage(error, settings.language));
      })
      .finally(() => {
        if (!disposed) {
          setIsSystemFontsLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  const uploadDesktopWallpaper = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';

    if (!file) {
      return;
    }

    if (file.size > maxWallpaperImageBytes) {
      setWallpaperError(t('settings.wallpaper.error.tooLarge', settings.language));
      return;
    }

    if (
      (file.type && !acceptedWallpaperTypes.has(file.type)) ||
      (!file.type && !wallpaperExtensionPattern.test(file.name))
    ) {
      setWallpaperError(t('settings.wallpaper.error.unsupported', settings.language));
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file, settings.language);

      if (!wallpaperDataUrlPattern.test(dataUrl)) {
        setWallpaperError(t('settings.wallpaper.error.unsupported', settings.language));
        return;
      }

      setWallpaperError('');
      onSettingsChange({
        ...settings,
        desktopWallpaperMode: 'custom',
        desktopWallpaperPresetId: selectedWallpaperPreset.id,
        desktopWallpaperDataUrl: dataUrl,
        desktopWallpaperName: file.name,
      });
    } catch (error) {
      setWallpaperError(error instanceof Error ? error.message : t('settings.error.imageReadFailed', settings.language));
    }
  };

  return (
    <section className="settings-page no-drag">
        <aside className="settings-section-nav" aria-label={t('settings.nav.aria', settings.language)}>
          <div className="settings-section-nav-header">
            <span>{t('settings.nav.title', settings.language)}</span>
            <small>{t('settings.nav.count', settings.language, { count: String(settingsSections.length) })}</small>
          </div>

          {settingsSections.map((section, index) => (
            <button
              key={section.key}
              type="button"
              className={getSettingsSectionNavClass(section.key, activeSection)}
              onClick={() => setActiveSection(section.key)}
              aria-current={activeSection === section.key ? 'page' : undefined}
            >
              <span className="settings-section-nav-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="settings-section-nav-copy">
                <strong>{t(section.labelId, settings.language)}</strong>
                <small>{t(section.summaryId, settings.language)}</small>
              </span>
            </button>
          ))}
        </aside>

        <div className="settings-content">
          {activeSection === 'general' ? (
            <>
              <section className="settings-section">
                <h2>{t('settings.general.behavior.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.general.language.label', settings.language)}</strong>
                      <small>{t('settings.general.language.summary', settings.language)}</small>
                    </span>
                    <select value={settings.language} onChange={(event) => updateSetting('language', event.target.value as ShellDeskAppSettings['language'])}>
                      <option value="zh-CN">{t('settings.general.language.zh', settings.language)}</option>
                      <option value="en-US">{t('settings.general.language.en', settings.language)}</option>
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.general.interfaceFont.label', settings.language)}</strong>
                      <small>{fontListStatus}</small>
                    </span>
                    <select
                      className="settings-font-select"
                      value={settings.interfaceFont}
                      onChange={(event) => updateSetting('interfaceFont', event.target.value as ShellDeskAppSettings['interfaceFont'])}
                    >
                      {interfaceFontOptions.map((fontChoice) => (
                        <option key={fontChoice} value={fontChoice}>{fontChoice}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.general.sshConnectTimeout.label', settings.language)}</strong>
                      <small>{t('settings.general.sshConnectTimeout.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input settings-number-input"
                      type="number"
                      min={3}
                      max={120}
                      step={1}
                      value={settings.sshConnectTimeoutSeconds}
                      aria-label={t('settings.general.sshConnectTimeout.label', settings.language)}
                      onChange={(event) => updateSetting(
                        'sshConnectTimeoutSeconds',
                        Math.max(3, Math.min(120, Number.parseInt(event.target.value, 10) || 15)),
                      )}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.general.minimizeToTrayOnClose.label', settings.language)}</strong>
                      <small>{t('settings.general.minimizeToTrayOnClose.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.minimizeToTrayOnClose}
                      onChange={(event) => updateMinimizeToTrayOnClose(event.target.checked)}
                    />
                  </label>

                </div>
              </section>

              <SftpSettingsFields
                settings={settings}
                onChange={(patch) => onSettingsChange({ ...settings, ...patch })}
              />

              <section className="settings-section">
                <h2>{t('settings.general.library.title', settings.language)}</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.general.hosts.label', settings.language)}</strong>
                      <small>{t('settings.general.hosts.summary', settings.language)}</small>
                    </span>
                    <strong>{hostCount}</strong>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.general.keys.label', settings.language)}</strong>
                      <small>{t('settings.general.keys.summary', settings.language)}</small>
                    </span>
                    <strong>{keyCount}</strong>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.general.bookmarks.label', settings.language)}</strong>
                      <small>{t('settings.general.bookmarks.summary', settings.language)}</small>
                    </span>
                    <strong>{bookmarkCount}</strong>
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {activeSection === 'appearance' ? (
            <>
              <section className="settings-section">
                <h2>{t('settings.appearance.theme.title', settings.language)}</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.appearance.theme.label', settings.language)}</strong>
                      <small>{t('settings.appearance.theme.summary', settings.language)}</small>
                    </span>
                    <div className="theme-switch" role="group" aria-label={t('settings.appearance.theme.label', settings.language)}>
                      <button type="button" className={settings.theme === 'light' ? 'active' : ''} onClick={() => updateSetting('theme', 'light')}>{t('settings.appearance.theme.light', settings.language)}</button>
                      <button type="button" className={settings.theme === 'system' ? 'active' : ''} onClick={() => updateSetting('theme', 'system')}>{t('settings.appearance.theme.system', settings.language)}</button>
                      <button type="button" className={settings.theme === 'dark' ? 'active' : ''} onClick={() => updateSetting('theme', 'dark')}>{t('settings.appearance.theme.dark', settings.language)}</button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <h2>{t('settings.appearance.accent.title', settings.language)}</h2>
                <div className="settings-card color-card">
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.appearance.accent.label', settings.language)}</strong>
                      <small>{t('settings.appearance.accent.summary', settings.language)}</small>
                    </span>
                    <div className="color-picker-row" aria-label={t('settings.appearance.accent.aria', settings.language)}>
                      {accentColorChoices.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={settings.accentColor === color ? 'selected' : ''}
                          style={{ background: color }}
                          onClick={() => updateSetting('accentColor', color)}
                          aria-label={t('settings.appearance.accent.choose', settings.language, { color })}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <h2>{t('settings.wallpaper.title', settings.language)}</h2>
                <div className="settings-card desktop-wallpaper-card">
                  <div className="settings-row desktop-wallpaper-row">
                    <span>
                      <strong>{t('settings.wallpaper.background.label', settings.language)}</strong>
                      <small>{t('settings.wallpaper.background.summary', settings.language)}</small>
                    </span>
                    <div className="desktop-wallpaper-control">
                      <div
                        className={`desktop-wallpaper-preview ${hasCustomWallpaper ? 'custom' : ''}`}
                        style={wallpaperPreviewStyle}
                        aria-label={wallpaperPreviewAriaLabel}
                      >
                        <span>{wallpaperPreviewLabel}</span>
                      </div>
                      <div className="desktop-wallpaper-presets" aria-label={t('settings.wallpaper.presets.aria', settings.language)}>
                        {desktopWallpaperPresets.map((preset) => {
                          const isSelectedPreset = !hasCustomWallpaper && selectedWallpaperPreset.id === preset.id;
                          const presetLabel = t(preset.labelId, settings.language);
                          const presetUrl = wallpaperPresetUrls[preset.id] || '';

                          return (
                            <button
                              key={preset.id}
                              type="button"
                              className={`desktop-wallpaper-preset ${isSelectedPreset ? 'selected' : ''}`}
                              style={{
                                backgroundImage: presetUrl
                                  ? `linear-gradient(180deg, rgba(8, 13, 20, 0.1), rgba(8, 13, 20, 0.42)), url(${JSON.stringify(presetUrl)})`
                                  : 'linear-gradient(180deg, rgba(8, 13, 20, 0.1), rgba(8, 13, 20, 0.42))',
                              }}
                              onClick={() => selectDesktopWallpaperPreset(preset.id)}
                              aria-pressed={isSelectedPreset}
                              aria-label={`${t('settings.wallpaper.choosePreset', settings.language)} ${presetLabel}`}
                              title={presetLabel}
                            >
                              <span>{presetLabel}</span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="desktop-wallpaper-actions">
                        <label className="command-button desktop-wallpaper-upload">
                          {t('settings.wallpaper.upload', settings.language)}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
                            onChange={uploadDesktopWallpaper}
                          />
                        </label>
                        <button type="button" className="command-button muted" onClick={resetDesktopWallpaper} disabled={isDefaultWallpaperPreset}>
                          {t('settings.wallpaper.useDefault', settings.language)}
                        </button>
                      </div>
                      <small className="desktop-wallpaper-meta">
                        {hasCustomWallpaper
                          ? settings.desktopWallpaperName || t('settings.wallpaper.customImage', settings.language)
                          : `${t('settings.wallpaper.current', settings.language)} ${selectedWallpaperPresetLabel}`}
                      </small>
                      {wallpaperError ? <small className="desktop-wallpaper-error">{wallpaperError}</small> : null}
                    </div>
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {activeSection === 'desktop' ? (
            <section className="settings-section">
              <h2>{t('settings.desktop.dock.title', settings.language)}</h2>
              <div className="settings-card">
                <div className="settings-row">
                  <span>
                    <strong>{t('settings.desktop.dock.position.label', settings.language)}</strong>
                    <small>{t('settings.desktop.dock.position.summary', settings.language)}</small>
                  </span>
                  <div className="theme-switch" role="group" aria-label={t('settings.desktop.dock.position.label', settings.language)}>
                    {desktopDockPositionChoices.map((positionChoice) => (
                      <button
                        key={positionChoice.value}
                        type="button"
                        className={settings.remoteDesktopDockPosition === positionChoice.value ? 'active' : ''}
                        onClick={() => updateSetting('remoteDesktopDockPosition', positionChoice.value)}
                      >
                        {t(positionChoice.labelId, settings.language)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-row">
                  <span>
                    <strong>{t('settings.desktop.dock.size.label', settings.language)}</strong>
                    <small>{t('settings.desktop.dock.size.summary', settings.language)}</small>
                  </span>
                  <div className="theme-switch" role="group" aria-label={t('settings.desktop.dock.size.label', settings.language)}>
                    {desktopDockSizeChoices.map((sizeChoice) => (
                      <button
                        key={sizeChoice.value}
                        type="button"
                        className={settings.remoteDesktopDockSize === sizeChoice.value ? 'active' : ''}
                        onClick={() => updateSetting('remoteDesktopDockSize', sizeChoice.value)}
                      >
                        {t(sizeChoice.labelId, settings.language)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-row">
                  <span>
                    <strong>{t('settings.desktop.dock.autoHide.label', settings.language)}</strong>
                    <small>{t('settings.desktop.dock.autoHide.summary', settings.language)}</small>
                  </span>
                  <div className="theme-switch" role="group" aria-label={t('settings.desktop.dock.autoHide.label', settings.language)}>
                    {desktopDockAutoHideChoices.map((autoHideChoice) => (
                      <button
                        key={autoHideChoice.value}
                        type="button"
                        className={settings.remoteDesktopDockAutoHide === autoHideChoice.value ? 'active' : ''}
                        onClick={() => updateSetting('remoteDesktopDockAutoHide', autoHideChoice.value)}
                      >
                        {t(autoHideChoice.labelId, settings.language)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-row desktop-dock-pinned-row">
                  <span>
                    <strong>{t('settings.desktop.dock.pinnedApps.label', settings.language)}</strong>
                    <small>{t('settings.desktop.dock.pinnedApps.summary', settings.language)}</small>
                  </span>
                  <details className="desktop-dock-pinned-picker">
                    <summary>
                      <span className="desktop-dock-pinned-summary-copy">
                        <strong>{t('settings.desktop.dock.pinnedApps.count', settings.language, { count: pinnedDockAppLabels.length })}</strong>
                        <span>
                          {pinnedDockAppPreviewLabels.length > 0
                            ? pinnedDockAppPreviewLabels.join(' / ')
                            : t('settings.desktop.dock.pinnedApps.none', settings.language)}
                          {pinnedDockAppMoreCount > 0
                            ? ` +${pinnedDockAppMoreCount}`
                            : ''}
                        </span>
                      </span>
                      <span className="desktop-dock-pinned-summary-caret" aria-hidden="true" />
                    </summary>
                    <div className="desktop-dock-pinned-panel" aria-label={t('settings.desktop.dock.pinnedApps.label', settings.language)}>
                      {desktopDockPinnedAppChoices.map((appChoice) => {
                        const isPinned = settings.remoteDesktopDockPinnedApps.includes(appChoice.key);

                        return (
                          <label key={appChoice.key} className={`desktop-dock-pinned-choice ${isPinned ? 'selected' : ''}`}>
                            <input
                              type="checkbox"
                              checked={isPinned}
                              onChange={(event) => updateDockPinnedApp(appChoice.key, event.target.checked)}
                            />
                            <span>{t(appChoice.labelId, settings.language)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </details>
                </div>
              </div>
            </section>
          ) : null}

          {activeSection === 'terminal' ? (
            <>
              <section className="settings-section">
                <h2>{t('settings.terminal.theme.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row terminal-theme-row">
                    <span>
                      <strong>{t('settings.terminal.theme.label', settings.language)}</strong>
                      <small>{t(selectedTerminalTheme.summaryId, settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalTheme}
                      onChange={(event) => updateSetting('terminalTheme', event.target.value as ShellDeskAppSettings['terminalTheme'])}
                    >
                      {terminalThemeChoices.map((themeChoice) => (
                        <option key={themeChoice.key} value={themeChoice.key}>{t(themeChoice.labelId, settings.language)}</option>
                      ))}
                    </select>
                  </label>

                  <div className="terminal-theme-preview" style={{ background: selectedTerminalTheme.theme.background, color: selectedTerminalTheme.theme.foreground }}>
                    <div>
                      <strong>{t(selectedTerminalTheme.labelId, settings.language)}</strong>
                      <small>$ ssh user@host</small>
                    </div>
                    <div className="terminal-theme-swatches" aria-label={t('settings.terminal.theme.previewAria', settings.language)}>
                      {[
                        selectedTerminalTheme.theme.red,
                        selectedTerminalTheme.theme.green,
                        selectedTerminalTheme.theme.yellow,
                        selectedTerminalTheme.theme.blue,
                        selectedTerminalTheme.theme.magenta,
                        selectedTerminalTheme.theme.cyan,
                      ].map((color) => (
                        <span key={color} style={{ background: color }} />
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <TerminalSessionSettingsFields
                settings={settings}
                onChange={(patch) => onSettingsChange({ ...settings, ...patch })}
              />

              <section className="settings-section">
                <h2>{t('settings.terminal.typography.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.fontFamily.label', settings.language)}</strong>
                      <small>{fontListStatus}</small>
                    </span>
                    <select
                      className="settings-font-select"
                      value={settings.terminalFontFamily}
                      onChange={(event) => updateSetting('terminalFontFamily', event.target.value as ShellDeskAppSettings['terminalFontFamily'])}
                    >
                      {terminalFontOptions.map((fontChoice) => (
                        <option key={fontChoice} value={fontChoice}>{fontChoice}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.fontSize.label', settings.language)}</strong>
                      <small>{t('settings.terminal.fontSize.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalFontSize}
                      onChange={(event) => updateSetting('terminalFontSize', Number(event.target.value))}
                    >
                      {[11, 12, 13, 14, 15, 16, 18, 20].map((size) => (
                        <option key={size} value={size}>{size}px</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.lineHeight.label', settings.language)}</strong>
                      <small>{t('settings.terminal.lineHeight.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalLineHeight}
                      onChange={(event) => updateSetting('terminalLineHeight', Number(event.target.value))}
                    >
                      {terminalLineHeightChoices.map((value) => (
                        <option key={value} value={value}>{value.toFixed(1)}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.regularWeight.label', settings.language)}</strong>
                      <small>{t('settings.terminal.regularWeight.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalFontWeight}
                      onChange={(event) => updateSetting('terminalFontWeight', Number(event.target.value))}
                    >
                      {terminalFontWeightChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>{t(choice.labelId, settings.language)}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.boldWeight.label', settings.language)}</strong>
                      <small>{t('settings.terminal.boldWeight.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalFontWeightBold}
                      onChange={(event) => updateSetting('terminalFontWeightBold', Number(event.target.value))}
                    >
                      {terminalBoldWeightChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>{t(choice.labelId, settings.language)}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.ligatures.label', settings.language)}</strong>
                      <small>{t('settings.terminal.ligatures.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.terminalFontLigatures}
                      onChange={(event) => updateSetting('terminalFontLigatures', event.target.checked)}
                    />
                  </label>
                </div>
              </section>

              <section className="settings-section">
                <h2>{t('settings.terminal.cursor.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.cursorStyle.label', settings.language)}</strong>
                      <small>{t('settings.terminal.cursorStyle.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalCursorStyle}
                      onChange={(event) => updateSetting('terminalCursorStyle', event.target.value as ShellDeskAppSettings['terminalCursorStyle'])}
                    >
                      <option value="block">{t('settings.terminal.cursorStyle.block', settings.language)}</option>
                      <option value="bar">{t('settings.terminal.cursorStyle.bar', settings.language)}</option>
                      <option value="underline">{t('settings.terminal.cursorStyle.underline', settings.language)}</option>
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.cursorInactive.label', settings.language)}</strong>
                      <small>{t('settings.terminal.cursorInactive.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalCursorInactiveStyle}
                      onChange={(event) => updateSetting('terminalCursorInactiveStyle', event.target.value as ShellDeskAppSettings['terminalCursorInactiveStyle'])}
                    >
                      <option value="outline">{t('settings.terminal.cursorInactive.outline', settings.language)}</option>
                      <option value="block">{t('settings.terminal.cursorStyle.block', settings.language)}</option>
                      <option value="bar">{t('settings.terminal.cursorStyle.bar', settings.language)}</option>
                      <option value="underline">{t('settings.terminal.cursorStyle.underline', settings.language)}</option>
                      <option value="none">{t('settings.terminal.cursorInactive.none', settings.language)}</option>
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.cursorBlink.label', settings.language)}</strong>
                      <small>{t('settings.terminal.cursorBlink.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.terminalCursorBlink}
                      onChange={(event) => updateSetting('terminalCursorBlink', event.target.checked)}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.scrollback.label', settings.language)}</strong>
                      <small>{t('settings.terminal.scrollback.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalScrollback}
                      onChange={(event) => updateSetting('terminalScrollback', Number(event.target.value))}
                    >
                      {[1000, 3000, 5000, 10000, 20000, 50000].map((value) => (
                        <option key={value} value={value}>{t('settings.terminal.scrollback.lines', settings.language, { count: value.toLocaleString(getCurrentAppLocale()) })}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.wheelSpeed.label', settings.language)}</strong>
                      <small>{t('settings.terminal.wheelSpeed.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalScrollSensitivity}
                      onChange={(event) => updateSetting('terminalScrollSensitivity', Number(event.target.value))}
                    >
                      {terminalScrollSensitivityChoices.map((value) => (
                        <option key={value} value={value}>{value}x</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.fastWheelSpeed.label', settings.language)}</strong>
                      <small>{t('settings.terminal.fastWheelSpeed.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalFastScrollSensitivity}
                      onChange={(event) => updateSetting('terminalFastScrollSensitivity', Number(event.target.value))}
                    >
                      {terminalFastScrollSensitivityChoices.map((value) => (
                        <option key={value} value={value}>{value}x</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.scrollOnInput.label', settings.language)}</strong>
                      <small>{t('settings.terminal.scrollOnInput.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.terminalScrollOnUserInput}
                      onChange={(event) => updateSetting('terminalScrollOnUserInput', event.target.checked)}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.clearScrollback.label', settings.language)}</strong>
                      <small>{t('settings.terminal.clearScrollback.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.terminalScrollOnEraseInDisplay}
                      onChange={(event) => updateSetting('terminalScrollOnEraseInDisplay', event.target.checked)}
                    />
                  </label>
                </div>
              </section>

              <section className="settings-section">
                <h2>{t('settings.terminal.input.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.copyOnSelect.label', settings.language)}</strong>
                      <small>{t('settings.terminal.copyOnSelect.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.terminalCopyOnSelect}
                      onChange={(event) => updateSetting('terminalCopyOnSelect', event.target.checked)}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.rightClickPaste.label', settings.language)}</strong>
                      <small>{t('settings.terminal.rightClickPaste.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.terminalRightClickPaste}
                      onChange={(event) => updateSetting('terminalRightClickPaste', event.target.checked)}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.altClick.label', settings.language)}</strong>
                      <small>{t('settings.terminal.altClick.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.terminalAltClickMovesCursor}
                      onChange={(event) => updateSetting('terminalAltClickMovesCursor', event.target.checked)}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.bracketedPaste.label', settings.language)}</strong>
                      <small>{t('settings.terminal.bracketedPaste.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.terminalBracketedPasteMode}
                      onChange={(event) => updateSetting('terminalBracketedPasteMode', event.target.checked)}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.minimumContrast.label', settings.language)}</strong>
                      <small>{t('settings.terminal.minimumContrast.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.terminalMinimumContrastRatio}
                      onChange={(event) => updateSetting('terminalMinimumContrastRatio', Number(event.target.value))}
                    >
                      {terminalContrastChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>{t(choice.labelId, settings.language)}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.screenReader.label', settings.language)}</strong>
                      <small>{t('settings.terminal.screenReader.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.terminalScreenReaderMode}
                      onChange={(event) => updateSetting('terminalScreenReaderMode', event.target.checked)}
                    />
                  </label>
                </div>
              </section>
            </>
          ) : null}

          {activeSection === 'ai' ? (
            <>
              <section className="settings-section settings-mcp-section">
                <h2>{t('settings.ai.mcp.title', settings.language)}</h2>
                <div className="settings-card settings-mcp-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.mcp.enabled.label', settings.language)}</strong>
                      <small className={mcpError ? 'settings-error-text' : undefined}>{mcpStatusText}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.mcpServerEnabled}
                      disabled={isMcpServerPending}
                      onChange={(event) => void updateMcpServerEnabled(event.target.checked)}
                      aria-label={t('settings.ai.mcp.enabled.label', settings.language)}
                    />
                  </label>

                  <div className="settings-row settings-mcp-action-row">
                    <span>
                      <strong>{t('settings.ai.mcp.endpoint.label', settings.language)}</strong>
                      <small>{t('settings.ai.mcp.endpoint.summary', settings.language)}</small>
                    </span>
                    <div className="settings-mcp-actions">
                      <code className="settings-inline-code">{mcpServerStatus?.endpoint ?? defaultMcpServerEndpoint}</code>
                      <button
                        type="button"
                        className="command-button"
                        onClick={() => setMcpExampleDialog('mcp')}
                      >
                        {t('settings.ai.mcp.example.button', settings.language)}
                      </button>
                    </div>
                  </div>

                  <div className="settings-row settings-mcp-action-row">
                    <span>
                      <strong>{t('settings.ai.mcp.skill.label', settings.language)}</strong>
                      <small>{t('settings.ai.mcp.skill.summary', settings.language)}</small>
                    </span>
                    <div className="settings-mcp-actions">
                      <button
                        type="button"
                        className="command-button"
                        disabled={isMcpSkillExporting}
                        onClick={() => void exportMcpSkill()}
                      >
                        {isMcpSkillExporting
                          ? t('settings.ai.mcp.skill.exporting', settings.language)
                          : t('settings.ai.mcp.skill.export', settings.language)}
                      </button>
                      <button
                        type="button"
                        className="command-button"
                        onClick={() => setMcpExampleDialog('skill')}
                      >
                        {t('settings.ai.mcp.skill.example.button', settings.language)}
                      </button>
                    </div>
                  </div>
                </div>
                <p className={mcpError ? 'settings-caption settings-error-text' : 'settings-caption'}>
                  {mcpError || mcpMessage || t('settings.ai.mcp.caption', settings.language)}
                </p>
              </section>

              <section className="settings-section">
                <h2>{t('settings.ai.provider.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.provider.label', settings.language)}</strong>
                      <small>{t(selectedAiProvider.summaryId, settings.language)}</small>
                    </span>
                    <select
                      value={visibleAiProvider}
                      onChange={(event) => updateAiProvider(event.target.value as ShellDeskAiProvider)}
                    >
                      {aiProviderChoices.map((providerChoice) => (
                        <option key={providerChoice.value} value={providerChoice.value}>{t(providerChoice.labelId, settings.language)}</option>
                      ))}
                    </select>
                  </label>

                  {isCustomAiProvider(settings.aiProvider) ? (
                    <label className="settings-row">
                      <span>
                        <strong>{t('settings.ai.providerName.label', settings.language)}</strong>
                        <small>{t('settings.ai.providerName.summary', settings.language)}</small>
                      </span>
                      <input
                        className="settings-text-input"
                        value={settings.aiProviderName}
                        maxLength={80}
                        onChange={(event) => updateSetting('aiProviderName', event.target.value)}
                        placeholder={t('settings.ai.providerName.placeholder', settings.language)}
                      />
                    </label>
                  ) : null}

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.apiFormat.label', settings.language)}</strong>
                      <small>{t('settings.ai.apiFormat.summary', settings.language)}</small>
                    </span>
                    <select
                      value={settings.aiApiFormat}
                      onChange={(event) => {
                        setAiModelOptions([]);
                        setAiModelsMessage('');
                        setAiModelsError('');
                        setIsAiModelListOpen(false);
                        updateSetting('aiApiFormat', event.target.value as ShellDeskAiApiFormat);
                      }}
                      disabled={!isCustomAiProvider(settings.aiProvider)}
                    >
                      <option value="openai">OpenAI compatible</option>
                      <option value="anthropic">Claude / Anthropic</option>
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.apiBaseUrl.label', settings.language)}</strong>
                      <small>{t('settings.ai.apiBaseUrl.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input settings-url-input"
                      type="text"
                      inputMode="url"
                      value={settings.aiApiBaseUrl}
                      onChange={(event) => {
                        setAiModelOptions([]);
                        setAiModelsMessage('');
                        setAiModelsError('');
                        setIsAiModelListOpen(false);
                        updateSetting('aiApiBaseUrl', event.target.value);
                      }}
                      placeholder={settings.aiApiFormat === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.example.com/v1'}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.apiKey.label', settings.language)}</strong>
                      <small>{t('settings.ai.apiKey.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input settings-secret-input"
                      type="password"
                      value={settings.aiApiKey}
                      onChange={(event) => updateSetting('aiApiKey', event.target.value)}
                      placeholder="sk-..."
                    />
                  </label>
                </div>
                <p className="settings-caption">{t('settings.ai.provider.caption', settings.language)}</p>
              </section>

              <section className="settings-section">
                <h2>{t('settings.ai.model.title', settings.language)}</h2>
                <div className="settings-card ai-model-card">
                  <div className="settings-row ai-model-row">
                    <span>
                      <strong>{t('settings.ai.model.default.label', settings.language)}</strong>
                      <small className={aiModelsError ? 'settings-error-text' : undefined}>{aiModelStatus}</small>
                    </span>
                    <div className="ai-model-control">
                      <div className="ai-model-input-wrap">
                        <input
                          className="settings-text-input"
                          value={settings.aiModel}
                          onFocus={() => setIsAiModelListOpen(visibleAiModelOptions.length > 0)}
                          onBlur={() => {
                            window.setTimeout(() => setIsAiModelListOpen(false), 120);
                          }}
                          onChange={(event) => {
                            updateSetting('aiModel', event.target.value);
                            setIsAiModelListOpen(visibleAiModelOptions.length > 0);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              setIsAiModelListOpen(false);
                            }

                            if (event.key === 'ArrowDown' && visibleAiModelOptions.length > 0) {
                              setIsAiModelListOpen(true);
                            }
                          }}
                          placeholder={t('settings.ai.model.placeholder', settings.language)}
                          role="combobox"
                          aria-controls="ai-model-options"
                          aria-expanded={isAiModelListOpen}
                          aria-autocomplete="list"
                        />
                        {isAiModelListOpen && visibleAiModelOptions.length ? (
                          <div className="ai-model-options" id="ai-model-options" role="listbox">
                            {visibleAiModelOptions.map((model) => {
                              const isSelected = model.id === selectedAiModelOption?.id;
                              const modelDetail = getAiModelDetail(model);

                              return (
                                <button
                                  key={model.id}
                                  type="button"
                                  className={isSelected ? 'selected' : ''}
                                  role="option"
                                  aria-selected={isSelected}
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    updateSetting('aiModel', model.id);
                                    setIsAiModelListOpen(false);
                                  }}
                                >
                                  <strong>{getAiModelDisplayName(model)}</strong>
                                  {modelDetail ? <small>{modelDetail}</small> : null}
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="command-button"
                        onClick={fetchAiModels}
                        disabled={(
                          settings.aiProvider !== 'openai'
                          && settings.aiProvider !== 'anthropic'
                          && !settings.aiApiBaseUrl.trim()
                        ) || (
                          settings.aiApiFormat === 'anthropic'
                          && !settings.aiApiKey.trim()
                        ) || isAiModelsLoading}
                      >
                        {isAiModelsLoading ? t('settings.ai.model.fetching', settings.language) : t('settings.ai.model.fetch', settings.language)}
                      </button>
                    </div>
                  </div>
                </div>
                <p className="settings-caption">{t('settings.ai.intro', settings.language)}</p>
              </section>

              <section className="settings-section">
                <h2>{t('settings.ai.webSearch.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.webSearch.enabled.label', settings.language)}</strong>
                      <small>{t('settings.ai.webSearch.enabled.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.webSearchEnabled}
                      onChange={(event) => updateSetting('webSearchEnabled', event.target.checked)}
                      aria-label={t('settings.ai.webSearch.enabled.label', settings.language)}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.webSearch.provider.label', settings.language)}</strong>
                      <small>{t(selectedWebSearchProvider.summaryId, settings.language)}</small>
                    </span>
                    <select
                      value={settings.webSearchProvider}
                      onChange={(event) => updateWebSearchProvider(event.target.value as ShellDeskWebSearchProvider)}
                    >
                      {webSearchProviderChoices.map((providerChoice) => (
                        <option key={providerChoice.value} value={providerChoice.value}>{providerChoice.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.webSearch.apiKey.label', settings.language)}</strong>
                      <small>{t('settings.ai.webSearch.apiKey.summary', settings.language)}</small>
                    </span>
                    <span className="settings-secret-control">
                      <input
                        className="settings-text-input settings-secret-input"
                        type={showWebSearchApiKey ? 'text' : 'password'}
                        value={settings.webSearchApiKey}
                        onChange={(event) => updateSetting('webSearchApiKey', event.target.value)}
                        placeholder={t('settings.ai.webSearch.apiKey.placeholder', settings.language)}
                      />
                      <button
                        type="button"
                        className="settings-secret-toggle"
                        onClick={() => setShowWebSearchApiKey((value) => !value)}
                        aria-label={t(showWebSearchApiKey ? 'settings.ai.webSearch.apiKey.hide' : 'settings.ai.webSearch.apiKey.show', settings.language)}
                      >
                        {t(showWebSearchApiKey ? 'settings.ai.webSearch.apiKey.hide' : 'settings.ai.webSearch.apiKey.show', settings.language)}
                      </button>
                    </span>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.webSearch.apiBaseUrl.label', settings.language)}</strong>
                      <small>{t('settings.ai.webSearch.apiBaseUrl.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input settings-url-input"
                      type="text"
                      inputMode="url"
                      value={settings.webSearchApiBaseUrl}
                      onChange={(event) => updateSetting('webSearchApiBaseUrl', event.target.value)}
                      placeholder={selectedWebSearchProvider.defaultApiBaseUrl}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.webSearch.maxResults.label', settings.language)}</strong>
                      <small>{t('settings.ai.webSearch.maxResults.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input settings-number-input"
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      value={settings.webSearchMaxResults}
                      onChange={(event) => updateSetting('webSearchMaxResults', Math.max(1, Math.min(20, Number.parseInt(event.target.value, 10) || 5)))}
                    />
                  </label>
                </div>
                <p className="settings-caption">{t('settings.ai.webSearch.caption', settings.language)}</p>
              </section>
            </>
          ) : null}

          {activeSection === 'security' ? (
            <>
              <section className="settings-section">
                <h2>{t('settings.security.sensitive.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.security.rememberPasswords.label', settings.language)}</strong>
                      <small>{t('settings.security.rememberPasswords.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.rememberPasswords}
                      onChange={(event) => updateSetting('rememberPasswords', event.target.checked)}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.security.rememberPassphrases.label', settings.language)}</strong>
                      <small>{t('settings.security.rememberPassphrases.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={settings.rememberKeyPassphrases}
                      onChange={(event) => updateSetting('rememberKeyPassphrases', event.target.checked)}
                    />
                  </label>
                </div>
              </section>

              <section className="settings-section">
                <h2>{t('settings.storage.title', settings.language)}</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.storage.protection.label', settings.language)}</strong>
                      <small>{storageInfo?.protectionLabel ?? t('settings.storage.loading', settings.language)}</small>
                    </span>
                    <strong>{storageInfo?.protected ? t('settings.storage.protected', settings.language) : t('settings.storage.filePermission', settings.language)}</strong>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.storage.dataDir.label', settings.language)}</strong>
                      <small>{t('settings.storage.dataDir.summary', settings.language)}</small>
                    </span>
                    <code className="settings-inline-code">{storageInfo?.path ?? t('settings.storage.notReady', settings.language)}</code>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.storage.configFile.label', settings.language)}</strong>
                      <small>{t('settings.storage.configFile.summary', settings.language)}</small>
                    </span>
                    <code className="settings-inline-code">{storageInfo?.configPath ?? t('settings.storage.notReady', settings.language)}</code>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.storage.vaultFile.label', settings.language)}</strong>
                      <small>{t('settings.storage.vaultFile.summary', settings.language)}</small>
                    </span>
                    <code className="settings-inline-code">{storageInfo?.vaultPath ?? t('settings.storage.notReady', settings.language)}</code>
                  </div>
                </div>
                <p className="settings-caption">{t('settings.storage.caption', settings.language)}</p>
              </section>
            </>
          ) : null}

          {activeSection === 'backup' ? (
            <>
              <section className="settings-section">
                <h2>{t('settings.backup.title', settings.language)}</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.backup.export.label', settings.language)}</strong>
                      <small>{t('settings.backup.export.summary', settings.language)}</small>
                    </span>
                    <button
                      type="button"
                      className="command-button"
                      onClick={onExportConfig}
                      disabled={isConfigTransferPending}
                    >
                      {isConfigTransferPending ? t('settings.backup.processing', settings.language) : t('settings.backup.export.button', settings.language)}
                    </button>
                  </div>

                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.backup.import.label', settings.language)}</strong>
                      <small>{t('settings.backup.import.summary', settings.language)}</small>
                    </span>
                    <button
                      type="button"
                      className="command-button"
                      onClick={onImportConfig}
                      disabled={isConfigTransferPending}
                    >
                      {isConfigTransferPending ? t('settings.backup.processing', settings.language) : t('settings.backup.import.button', settings.language)}
                    </button>
                  </div>
                </div>
                <p className="settings-caption">{t('settings.backup.caption', settings.language)}</p>
              </section>

              <section className="settings-section">
                <h2>{t('settings.sync.title', settings.language)}</h2>
                <div className="settings-card settings-sync-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.sync.enabled.label', settings.language)}</strong>
                      <small>{t('settings.sync.enabled.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={syncForm.enabled}
                      onChange={(event) => updateSyncForm('enabled', event.target.checked)}
                      disabled={syncPendingAction === 'load'}
                    />
                  </label>

                  <label className="settings-row settings-sync-input-row">
                    <span>
                      <strong>{t('settings.sync.webdavUrl.label', settings.language)}</strong>
                      <small>{t('settings.sync.webdavUrl.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input settings-url-input"
                      type="text"
                      inputMode="url"
                      value={syncForm.webdavUrl}
                      onChange={(event) => updateSyncForm('webdavUrl', event.target.value)}
                      placeholder="https://dav.example.com/remote.php/dav/files/user/"
                      disabled={syncPendingAction === 'load'}
                    />
                  </label>

                  <label className="settings-row settings-sync-input-row">
                    <span>
                      <strong>{t('settings.sync.username.label', settings.language)}</strong>
                      <small>{t('settings.sync.username.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input"
                      value={syncForm.webdavUsername}
                      onChange={(event) => updateSyncForm('webdavUsername', event.target.value)}
                      placeholder="username"
                      disabled={syncPendingAction === 'load'}
                    />
                  </label>

                  <label className="settings-row settings-sync-input-row">
                    <span>
                      <strong>{t('settings.sync.password.label', settings.language)}</strong>
                      <small>{hasSavedWebDavPassword ? t('settings.sync.password.savedSummary', settings.language) : t('settings.sync.password.defaultSummary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input settings-secret-input"
                      type="password"
                      value={syncForm.webdavPassword}
                      onChange={(event) => updateSyncForm('webdavPassword', event.target.value)}
                      placeholder={hasSavedWebDavPassword ? t('settings.sync.password.savedPlaceholder', settings.language) : t('settings.sync.password.placeholder', settings.language)}
                      disabled={syncPendingAction === 'load'}
                    />
                  </label>

                  <label className="settings-row settings-sync-input-row">
                    <span>
                      <strong>{t('settings.sync.remotePath.label', settings.language)}</strong>
                      <small>{t('settings.sync.remotePath.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input settings-url-input"
                      value={syncForm.webdavRemotePath}
                      onChange={(event) => updateSyncForm('webdavRemotePath', event.target.value)}
                      placeholder={defaultSyncRemotePath}
                      disabled={syncPendingAction === 'load'}
                    />
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.sync.ignoreCertificate.label', settings.language)}</strong>
                      <small>{t('settings.sync.ignoreCertificate.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={syncForm.ignoreCertificateErrors}
                      onChange={(event) => updateSyncForm('ignoreCertificateErrors', event.target.checked)}
                      disabled={syncPendingAction === 'load'}
                    />
                  </label>

                  <label className="settings-row settings-sync-input-row">
                    <span>
                      <strong>{t('settings.sync.passphrase.label', settings.language)}</strong>
                      <small>{hasSavedSyncPassphrase ? t('settings.sync.passphrase.savedSummary', settings.language) : t('settings.sync.passphrase.defaultSummary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-text-input settings-secret-input"
                      type="password"
                      value={syncForm.syncPassphrase}
                      onChange={(event) => updateSyncForm('syncPassphrase', event.target.value)}
                      placeholder={hasSavedSyncPassphrase ? t('settings.sync.passphrase.savedPlaceholder', settings.language) : t('settings.sync.passphrase.placeholder', settings.language)}
                      disabled={syncPendingAction === 'load'}
                    />
                  </label>

                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.sync.interval.label', settings.language)}</strong>
                      <small>{t('settings.sync.interval.summary', settings.language)}</small>
                    </span>
                    <select
                      value={syncForm.intervalMinutes}
                      onChange={(event) => updateSyncForm('intervalMinutes', Number(event.target.value))}
                      disabled={syncPendingAction === 'load'}
                    >
                      {syncIntervalChoices.map((minutes) => (
                        <option key={minutes} value={minutes}>{minutes < 60 ? t('settings.sync.interval.minutes', settings.language, { count: String(minutes) }) : t('settings.sync.interval.hours', settings.language, { count: String(minutes / 60) })}</option>
                      ))}
                    </select>
                  </div>

                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.sync.startup.label', settings.language)}</strong>
                      <small>{t('settings.sync.startup.summary', settings.language)}</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={syncForm.syncOnStartup}
                      onChange={(event) => updateSyncForm('syncOnStartup', event.target.checked)}
                      disabled={syncPendingAction === 'load'}
                    />
                  </label>

                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.sync.status.label', settings.language)}</strong>
                      <small className={syncStatusClassName ? `settings-sync-status ${syncStatusClassName}` : 'settings-sync-status'}>
                        {syncStatusText}
                      </small>
                    </span>
                    <code className="settings-inline-code">{syncLastSyncText}</code>
                  </div>

                  <div className="settings-row settings-sync-actions-row">
                    <span>
                      <strong>{t('settings.sync.actions.label', settings.language)}</strong>
                      <small>{t('settings.sync.actions.summary', settings.language)}</small>
                    </span>
                    <div className="settings-sync-actions">
                      <button
                        type="button"
                        className="command-button"
                        onClick={saveAutoSyncConfig}
                        disabled={isSyncBusy}
                      >
                        {syncPendingAction === 'save' ? t('settings.sync.action.save.loading', settings.language) : t('settings.sync.action.save', settings.language)}
                      </button>
                      <button
                        type="button"
                        className="command-button"
                        onClick={testAutoSyncConnection}
                        disabled={isSyncBusy}
                      >
                        {syncPendingAction === 'test' ? t('settings.sync.action.test.loading', settings.language) : t('settings.sync.action.test', settings.language)}
                      </button>
                      <button
                        type="button"
                        className="command-button"
                        onClick={() => runAutoSyncNow()}
                        disabled={isSyncBusy}
                      >
                        {syncPendingAction === 'run' ? t('settings.sync.action.run.loading', settings.language) : t('settings.sync.action.run', settings.language)}
                      </button>
                    </div>
                  </div>
                </div>
                <p className="settings-caption">{t('settings.sync.caption', settings.language)}</p>

                {syncNeedsEmptyVaultResolution && syncEmptyVaultSummary ? (
                  <div className="settings-sync-conflicts needs-resolution">
                    <strong>{t('settings.sync.safety.emptyVault.title', settings.language)}</strong>
                    <p>{t('settings.sync.safety.emptyVault.summary', settings.language, { count: syncEmptyVaultSummary.remoteRecords })}</p>
                    <div className="settings-sync-conflict-list">
                      <div className="settings-sync-conflict-item">
                        <span>{t('settings.sync.safety.emptyVault.remoteItems', settings.language, { count: syncEmptyVaultSummary.remoteRecords })}</span>
                        <small>{t('settings.sync.safety.emptyVault.remoteSummary', settings.language)}</small>
                      </div>
                      <div className="settings-sync-conflict-item">
                        <span>{t('settings.sync.safety.emptyVault.localItems', settings.language, { count: syncEmptyVaultSummary.localRecords })}</span>
                        <small>{t('settings.sync.safety.emptyVault.localSummary', settings.language)}</small>
                      </div>
                    </div>
                    <div className="settings-sync-resolution-actions">
                      <button
                        type="button"
                        className="command-button"
                        onClick={() => runAutoSyncNow({ emptyVaultResolution: 'keepEmpty' })}
                        disabled={isSyncBusy}
                      >
                        {syncPendingAction === 'keep-empty' ? t('settings.sync.action.keepEmpty.loading', settings.language) : t('settings.sync.action.keepEmpty', settings.language)}
                      </button>
                      <button
                        type="button"
                        className="command-button primary"
                        onClick={() => runAutoSyncNow({ emptyVaultResolution: 'restoreRemote' })}
                        disabled={isSyncBusy}
                      >
                        {syncPendingAction === 'restore-remote' ? t('settings.sync.action.restoreRemote.loading', settings.language) : t('settings.sync.action.restoreRemote', settings.language)}
                      </button>
                    </div>
                  </div>
                ) : null}

                {syncNeedsShrinkConfirmation && syncShrinkSummary ? (
                  <div className="settings-sync-conflicts needs-resolution">
                    <strong>{t('settings.sync.safety.shrink.title', settings.language)}</strong>
                    <p>{t('settings.sync.safety.shrink.summary', settings.language, {
                      lost: syncShrinkSummary.lostRecords,
                      baseline: syncShrinkSummary.baselineRecords,
                      next: syncShrinkSummary.mergedRecords,
                    })}</p>
                    <div className="settings-sync-conflict-list">
                      <div className="settings-sync-conflict-item">
                        <span>{t('settings.sync.safety.shrink.lostItems', settings.language, { count: syncShrinkSummary.lostRecords })}</span>
                        <small>{t('settings.sync.safety.shrink.baselineItems', settings.language, {
                          baseline: syncShrinkSummary.baselineRecords,
                          next: syncShrinkSummary.mergedRecords,
                        })}</small>
                      </div>
                    </div>
                    <div className="settings-sync-resolution-actions">
                      <button
                        type="button"
                        className="command-button primary"
                        onClick={() => runAutoSyncNow({
                          conflictResolution: syncShrinkConflictResolution || undefined,
                          shrinkResolution: 'allow',
                        })}
                        disabled={isSyncBusy}
                      >
                        {syncPendingAction === 'allow-shrink' ? t('settings.sync.action.allowShrink.loading', settings.language) : t('settings.sync.action.allowShrink', settings.language)}
                      </button>
                    </div>
                  </div>
                ) : null}

                {!syncHasSafetyGate && (syncConflicts.length || syncHasPendingResolution) ? (
                  <div className={syncHasPendingResolution ? 'settings-sync-conflicts needs-resolution' : 'settings-sync-conflicts'}>
                    <strong>{t(syncHasPendingResolution ? 'settings.sync.conflicts.resolveTitle' : 'settings.sync.conflicts.title', settings.language)}</strong>
                    {syncHasPendingResolution ? <p>{t('settings.sync.conflicts.resolveSummary', settings.language)}</p> : null}
                    {syncConflicts.length ? (
                      <div className="settings-sync-conflict-list">
                        {syncConflicts.slice(0, 6).map((conflict) => (
                          <div className="settings-sync-conflict-item" key={`${conflict.type}:${conflict.id}`}>
                            <span>{conflict.name}</span>
                            <small>{conflict.reason}</small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="settings-sync-conflict-list">
                        <div className="settings-sync-conflict-item">
                          <span>{t('settings.sync.conflicts.pendingCount', settings.language, { count: String(syncConflictCount) })}</span>
                          <small>{t('settings.sync.conflicts.pendingSummary', settings.language)}</small>
                        </div>
                      </div>
                    )}
                    {syncConflicts.length > 6 ? <small>{t('settings.sync.conflicts.more', settings.language, { count: String(syncConflicts.length - 6) })}</small> : null}
                    {syncHasPendingResolution ? (
                      <div className="settings-sync-resolution-actions">
                        <button
                          type="button"
                          className="command-button"
                          onClick={() => runAutoSyncNow({ conflictResolution: 'remote' })}
                          disabled={isSyncBusy}
                        >
                          {syncPendingAction === 'resolve-remote' ? t('settings.sync.action.keepRemote.loading', settings.language) : t('settings.sync.action.keepRemote', settings.language)}
                        </button>
                        <button
                          type="button"
                          className="command-button primary"
                          onClick={() => runAutoSyncNow({ conflictResolution: 'local' })}
                          disabled={isSyncBusy}
                        >
                          {syncPendingAction === 'resolve-local' ? t('settings.sync.action.keepLocal.loading', settings.language) : t('settings.sync.action.keepLocal', settings.language)}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </>
          ) : null}

          {activeSection === 'about' ? (
            <SettingsAboutSection
              appDisplayName={appDisplayName}
              appPlatform={appPlatform}
              appVersion={appVersion}
              autoUpdateEnabled={settings.autoUpdateEnabled}
              canManualDownloadUpdate={canManualDownloadUpdate}
              canOpenUpdateRelease={canOpenUpdateRelease}
              isCheckingForUpdates={isCheckingForUpdates}
              isUpdateDownloading={isUpdateDownloading}
              isUpdateReady={isUpdateReady}
              language={settings.language}
              updateCheckResult={updateCheckResult}
              updateProgressPercent={updateProgressPercent}
              updateStatus={updateStatus}
              updateStatusClassName={updateStatusClassName}
              updateStatusText={updateStatusText}
              onAutoUpdateChange={(enabled) => updateSetting('autoUpdateEnabled', enabled)}
              onCheckForUpdates={checkForUpdates}
              onDownloadUpdate={downloadUpdate}
              onInstallUpdate={installUpdate}
              onOpenExternalLink={openExternalLink}
            />
          ) : null}
        </div>
        {mcpExampleDialog ? createPortal(
          <div
            className="settings-example-modal-overlay"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setMcpExampleDialog(null);
              }
            }}
          >
            <div className="settings-example-modal" role="dialog" aria-modal="true" aria-labelledby="settings-mcp-example-title">
              <div className="settings-example-modal-header">
                <div>
                  <strong id="settings-mcp-example-title">
                    {t(mcpExampleDialog === 'mcp' ? 'settings.ai.mcp.example.title' : 'settings.ai.mcp.skill.example.title', settings.language)}
                  </strong>
                  <small>{t('settings.ai.mcp.example.summary', settings.language)}</small>
                </div>
                <button
                  type="button"
                  onClick={() => setMcpExampleDialog(null)}
                  aria-label={t('settings.ai.mcp.example.close', settings.language)}
                >
                  ×
                </button>
              </div>
              <pre><code>{mcpExampleDialog === 'mcp' ? mcpCallExample : skillCallExample}</code></pre>
              <div className="settings-example-modal-actions">
                <button type="button" className="command-button" onClick={() => setMcpExampleDialog(null)}>
                  {t('settings.ai.mcp.example.close', settings.language)}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        ) : null}
    </section>
  );
}

export default SettingsPage;
