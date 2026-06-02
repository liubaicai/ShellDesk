import { type ChangeEvent, type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';

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
} from '../assets/desktopWallpapers';
import appIconUrl from '../assets/images/icon.png';
import { getCurrentAppLocale, t, type MessageId } from '../i18n';

const settingsSections = [
  { key: 'general', labelId: 'settings.section.general.label', summaryId: 'settings.section.general.summary' },
  { key: 'appearance', labelId: 'settings.section.appearance.label', summaryId: 'settings.section.appearance.summary' },
  { key: 'terminal', labelId: 'settings.section.terminal.label', summaryId: 'settings.section.terminal.summary' },
  { key: 'ai', labelId: 'settings.section.ai.label', summaryId: 'settings.section.ai.summary' },
  { key: 'security', labelId: 'settings.section.security.label', summaryId: 'settings.section.security.summary' },
  { key: 'backup', labelId: 'settings.section.backup.label', summaryId: 'settings.section.backup.summary' },
  { key: 'about', labelId: 'settings.section.about.label', summaryId: 'settings.section.about.summary' },
] as const satisfies ReadonlyArray<{ key: string; labelId: MessageId; summaryId: MessageId }>;

const accentColorChoices = ['#43c7ff', '#77f4c5', '#ffb347', '#ff7b9c', '#9f8cff', '#8bd3ff', '#ff8c42'];
const terminalLineHeightChoices = [1, 1.1, 1.2, 1.3, 1.4];
const terminalScrollSensitivityChoices = [0.5, 1, 1.5, 2, 3, 5];
const terminalFastScrollSensitivityChoices = [2, 5, 8, 10, 15, 20];
const fallbackSystemFontChoices = [
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'PingFang SC',
  'Hiragino Sans GB',
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'Segoe UI Variable',
  'Segoe UI',
  'Arial',
  'Verdana',
  'Georgia',
  'Times New Roman',
  'DengXian',
  'SimSun',
  'Cascadia Mono',
  'JetBrains Mono',
  'Fira Code',
  'Consolas',
  'Source Code Pro',
  'Hack',
  'Menlo',
  'Monaco',
  'Courier New',
];
const interfacePreferredFontChoices = [
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'PingFang SC',
  'Hiragino Sans GB',
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'Segoe UI Variable',
  'Segoe UI',
];
const terminalPreferredFontChoices = [
  'Cascadia Mono',
  'JetBrains Mono',
  'Fira Code',
  'Consolas',
  'Source Code Pro',
  'Hack',
  'Menlo',
  'Monaco',
  'Courier New',
];
const maxWallpaperImageBytes = 5 * 1024 * 1024;
const acceptedWallpaperTypes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const wallpaperExtensionPattern = /\.(png|jpe?g|webp|gif)$/i;
const wallpaperDataUrlPattern = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;
const terminalContrastChoices = [
  { value: 1, labelId: 'settings.terminal.minimumContrast.off' },
  { value: 4.5, labelId: 'settings.terminal.minimumContrast.aa45' },
  { value: 7, labelId: 'settings.terminal.minimumContrast.aaa7' },
] as const satisfies ReadonlyArray<{ value: number; labelId: MessageId }>;
const aiProviderChoices: Array<{
  value: ShellDeskAiProvider;
  labelId: MessageId;
  summaryId: MessageId;
  apiFormat: ShellDeskAiApiFormat;
  defaultApiBaseUrl: string;
}> = [
  {
    value: 'openai',
    labelId: 'settings.ai.provider.openai.label',
    summaryId: 'settings.ai.provider.openai.summary',
    apiFormat: 'openai',
    defaultApiBaseUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'anthropic',
    labelId: 'settings.ai.provider.anthropic.label',
    summaryId: 'settings.ai.provider.anthropic.summary',
    apiFormat: 'anthropic',
    defaultApiBaseUrl: 'https://api.anthropic.com',
  },
  {
    value: 'openai-compatible',
    labelId: 'settings.ai.provider.openaiCompatible.label',
    summaryId: 'settings.ai.provider.openaiCompatible.summary',
    apiFormat: 'openai',
    defaultApiBaseUrl: '',
  },
  {
    value: 'custom',
    labelId: 'settings.ai.provider.custom.label',
    summaryId: 'settings.ai.provider.custom.summary',
    apiFormat: 'openai',
    defaultApiBaseUrl: '',
  },
];
const shellDeskRepositoryUrl = 'https://github.com/liubaicai/ShellDesk';
const shellDeskContactEmail = 'liushuai.baicai@hotmail.com';
const defaultSyncRemotePath = '/ShellDesk/shelldesk-sync.json';
const syncIntervalChoices = [5, 15, 30, 60, 120, 360];

function createDefaultSyncForm(): ShellDeskSyncConfigInput {
  return {
    enabled: false,
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    webdavRemotePath: defaultSyncRemotePath,
    ignoreCertificateErrors: false,
    syncPassphrase: '',
    intervalMinutes: 15,
    syncOnStartup: true,
  };
}

function createSyncFormFromConfig(config: ShellDeskSyncPublicConfig | null): ShellDeskSyncConfigInput {
  if (!config) {
    return createDefaultSyncForm();
  }

  return {
    enabled: config.enabled,
    webdavUrl: config.webdavUrl,
    webdavUsername: config.webdavUsername,
    webdavPassword: '',
    webdavRemotePath: config.webdavRemotePath || defaultSyncRemotePath,
    ignoreCertificateErrors: config.ignoreCertificateErrors,
    syncPassphrase: '',
    intervalMinutes: config.intervalMinutes,
    syncOnStartup: config.syncOnStartup,
  };
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(getCurrentAppLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getSettingsSectionNavClass(sectionKey: (typeof settingsSections)[number]['key'], activeSection: (typeof settingsSections)[number]['key']) {
  return [
    'settings-section-nav-item',
    sectionKey === 'about' ? 'settings-section-nav-about' : '',
    activeSection === sectionKey ? 'active' : '',
  ].filter(Boolean).join(' ');
}

function readFileAsDataUrl(file: File, language: ShellDeskAppSettings['language']) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error(t('settings.error.imageReadFailed', language)));
    };

    reader.onerror = () => reject(new Error(t('settings.error.imageReadFailed', language)));
    reader.readAsDataURL(file);
  });
}

function normalizeFontChoice(value: unknown) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function normalizeFontChoices(values: readonly unknown[]) {
  const fontMap = new Map<string, string>();

  for (const value of values) {
    const fontChoice = normalizeFontChoice(value);

    if (!fontChoice) {
      continue;
    }

    const key = fontChoice.toLocaleLowerCase();

    if (!fontMap.has(key)) {
      fontMap.set(key, fontChoice);
    }
  }

  return Array.from(fontMap.values());
}

function createFontOptions(systemFonts: readonly string[], selectedFont: string, preferredFonts: readonly string[]) {
  const availableFonts = new Set(systemFonts.map((font) => font.toLocaleLowerCase()));
  const preferredAvailableFonts = preferredFonts.filter((font) => availableFonts.has(font.toLocaleLowerCase()));

  return normalizeFontChoices([
    selectedFont,
    ...preferredAvailableFonts,
    ...systemFonts,
  ]);
}

function getFontListErrorMessage(error: unknown, language: ShellDeskAppSettings['language']) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return t('settings.error.fontListFailed', language);
}

function getUpdateCheckErrorMessage(error: unknown, language: ShellDeskAppSettings['language']) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return t('settings.error.updateCheckFailed', language);
}

function getSettingsErrorMessage(error: unknown, language: ShellDeskAppSettings['language']) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return t('settings.error.operationFailed', language);
}

function getSyncStatusClassName(status: ShellDeskSyncStatus | undefined, hasError: boolean) {
  if (hasError) {
    return 'error';
  }

  if (status === 'success' || status === 'warning' || status === 'error') {
    return status;
  }

  return '';
}

function getAiModelDisplayName(model: ShellDeskAiModelInfo) {
  return model.name && model.name !== model.id ? model.name : model.id;
}

function getAiModelDetail(model: ShellDeskAiModelInfo) {
  const details = [
    model.name && model.name !== model.id ? model.id : '',
    model.ownedBy ? `by ${model.ownedBy}` : '',
  ].filter(Boolean);

  return details.join(' · ');
}

interface SettingsPageProps {
  hostCount: number;
  keyCount: number;
  bookmarkCount: number;
  settings: ShellDeskAppSettings;
  storageInfo: ShellDeskStorageInfo | null;
  isConfigTransferPending: boolean;
  onSettingsChange: (settings: ShellDeskAppSettings) => void;
  onImportConfig: () => void;
  onExportConfig: () => void;
}

function SettingsPage({
  hostCount,
  keyCount,
  bookmarkCount,
  settings,
  storageInfo,
  isConfigTransferPending,
  onSettingsChange,
  onImportConfig,
  onExportConfig,
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<(typeof settingsSections)[number]['key']>('general');
  const [wallpaperError, setWallpaperError] = useState('');
  const [systemFonts, setSystemFonts] = useState<string[]>(fallbackSystemFontChoices);
  const [isSystemFontsLoading, setIsSystemFontsLoading] = useState(false);
  const [systemFontsError, setSystemFontsError] = useState('');
  const [aiModelOptions, setAiModelOptions] = useState<ShellDeskAiModelInfo[]>([]);
  const [isAiModelsLoading, setIsAiModelsLoading] = useState(false);
  const [aiModelsMessage, setAiModelsMessage] = useState('');
  const [aiModelsError, setAiModelsError] = useState('');
  const [isAiModelListOpen, setIsAiModelListOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<ShellDeskAppInfo | null>(null);
  const [updateCheckResult, setUpdateCheckResult] = useState<ShellDeskUpdateCheckResult | null>(null);
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [updateCheckError, setUpdateCheckError] = useState('');
  const [syncConfig, setSyncConfig] = useState<ShellDeskSyncPublicConfig | null>(null);
  const [syncForm, setSyncForm] = useState<ShellDeskSyncConfigInput>(() => createDefaultSyncForm());
  const [syncMessage, setSyncMessage] = useState('');
  const [syncError, setSyncError] = useState('');
  const [syncConflicts, setSyncConflicts] = useState<ShellDeskSyncConflict[]>([]);
  const [syncPendingAction, setSyncPendingAction] = useState<'load' | 'save' | 'test' | 'run' | ''>('');

  const updateSetting = <Field extends keyof ShellDeskAppSettings>(field: Field, value: ShellDeskAppSettings[Field]) => {
    onSettingsChange({
      ...settings,
      [field]: value,
    });
  };
  const selectedTerminalTheme = getTerminalThemeChoice(settings.terminalTheme);
  const selectedAiProvider = aiProviderChoices.find((choice) => choice.value === settings.aiProvider) ?? aiProviderChoices[0];
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
  const wallpaperPreviewUrl = hasCustomWallpaper ? settings.desktopWallpaperDataUrl : selectedWallpaperPreset.url;
  const wallpaperPreviewLabel = hasCustomWallpaper ? t('settings.wallpaper.custom', settings.language) : selectedWallpaperPresetLabel;
  const isDefaultWallpaperPreset = !hasCustomWallpaper && selectedWallpaperPreset.id === defaultDesktopWallpaperPresetId;
  const wallpaperPreviewAriaLabel = hasCustomWallpaper
    ? t('settings.wallpaper.customPreview', settings.language)
    : `${selectedWallpaperPresetLabel} ${t('settings.wallpaper.preview', settings.language)}`;
  const wallpaperPreviewStyle: CSSProperties = {
    backgroundImage: `linear-gradient(180deg, rgba(8, 13, 20, 0.16), rgba(8, 13, 20, 0.34)), url(${JSON.stringify(wallpaperPreviewUrl)})`,
  };
  const appDisplayName = appInfo?.productName || window.guiSSH?.appName || 'ShellDesk';
  const appVersion = appInfo?.version || '0.0.1';
  const appPlatform = appInfo ? `${appInfo.platform} ${appInfo.arch}` : t('settings.about.runtime.current', settings.language);
  const updateStatusText = updateCheckError
    ? updateCheckError
    : isCheckingForUpdates
      ? t('settings.update.status.checking', settings.language)
      : updateCheckResult
        ? updateCheckResult.updateAvailable
          ? t('settings.update.status.available', settings.language, { version: updateCheckResult.latestVersion })
          : t('settings.update.status.upToDate', settings.language)
        : t('settings.update.status.notChecked', settings.language);
  const updateStatusClassName = updateCheckError
    ? 'error'
    : updateCheckResult?.updateAvailable
      ? 'available'
      : updateCheckResult
        ? 'success'
        : '';
  const hasSavedWebDavPassword = Boolean(syncConfig?.hasWebDavPassword);
  const hasSavedSyncPassphrase = Boolean(syncConfig?.hasSyncPassphrase);
  const isSyncBusy = Boolean(syncPendingAction);
  const syncStatusClassName = getSyncStatusClassName(syncConfig?.lastSyncStatus, Boolean(syncError));
  const syncStatusText = syncError || syncMessage || syncConfig?.lastSyncMessage || t('settings.sync.status.notConfigured', settings.language);
  const syncLastSyncText = syncConfig?.lastSyncAt ? formatDateTime(syncConfig.lastSyncAt) : t('settings.sync.lastSync.notSynced', settings.language);

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

  const fetchAiModels = async () => {
    const listModels = window.guiSSH?.ai?.listModels;

    if (!listModels) {
      setAiModelsError(t('settings.ai.model.error.noApi', settings.language));
      setAiModelsMessage('');
      return;
    }

    if (!settings.aiApiBaseUrl.trim()) {
      setAiModelsError(t('settings.ai.model.error.apiBaseUrlRequired', settings.language));
      setAiModelsMessage('');
      return;
    }

    if (!settings.aiApiKey.trim()) {
      setAiModelsError(t('settings.ai.model.error.apiKeyRequired', settings.language));
      setAiModelsMessage('');
      return;
    }

    setIsAiModelsLoading(true);
    setAiModelsError('');
    setAiModelsMessage('');

    try {
      const result = await listModels({
        provider: settings.aiProvider,
        apiFormat: settings.aiApiFormat,
        apiBaseUrl: settings.aiApiBaseUrl,
        apiKey: settings.aiApiKey,
      });
      const models = result.models;

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
    const checkUpdates = window.guiSSH?.app?.checkForUpdates;

    if (!checkUpdates) {
      setUpdateCheckError(t('settings.update.error.noApi', settings.language));
      return;
    }

    setIsCheckingForUpdates(true);
    setUpdateCheckError('');

    try {
      const result = await checkUpdates();
      setUpdateCheckResult(result);
    } catch (error) {
      setUpdateCheckResult(null);
      setUpdateCheckError(getUpdateCheckErrorMessage(error, settings.language));
    } finally {
      setIsCheckingForUpdates(false);
    }
  };

  const applySyncConfig = useCallback((config: ShellDeskSyncPublicConfig) => {
    setSyncConfig(config);
    setSyncForm(createSyncFormFromConfig(config));
  }, []);

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
    } catch (error) {
      setSyncError(getSettingsErrorMessage(error, settings.language));
    } finally {
      setSyncPendingAction('');
    }
  };

  const runAutoSyncNow = async () => {
    const syncControls = window.guiSSH?.sync;

    if (!syncControls) {
      setSyncError(t('settings.sync.error.noApi', settings.language));
      return;
    }

    setSyncPendingAction('run');
    setSyncError('');
    setSyncMessage('');

    try {
      const result = await syncControls.runNow(syncForm);
      applySyncConfig(result.config);
      setSyncConflicts(result.conflicts);
      setSyncMessage(result.conflictCount
        ? t('settings.sync.message.conflicts', settings.language, { count: result.conflictCount })
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
    <>
      <div className="command-bar no-drag simple-command-bar settings-command-bar">
        <strong>{t('settings.title', settings.language)}</strong>
      </div>

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
                      value={settings.interfaceFont}
                      onChange={(event) => updateSetting('interfaceFont', event.target.value as ShellDeskAppSettings['interfaceFont'])}
                    >
                      {interfaceFontOptions.map((fontChoice) => (
                        <option key={fontChoice} value={fontChoice}>{fontChoice}</option>
                      ))}
                    </select>
                  </label>

                </div>
              </section>

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

                          return (
                            <button
                              key={preset.id}
                              type="button"
                              className={`desktop-wallpaper-preset ${isSelectedPreset ? 'selected' : ''}`}
                              style={{
                                backgroundImage: `linear-gradient(180deg, rgba(8, 13, 20, 0.1), rgba(8, 13, 20, 0.42)), url(${JSON.stringify(preset.url)})`,
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

              <section className="settings-section">
                <h2>{t('settings.terminal.typography.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.terminal.fontFamily.label', settings.language)}</strong>
                      <small>{fontListStatus}</small>
                    </span>
                    <select
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
              <section className="settings-section">
                <h2>{t('settings.ai.provider.title', settings.language)}</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>{t('settings.ai.provider.label', settings.language)}</strong>
                      <small>{t(selectedAiProvider.summaryId, settings.language)}</small>
                    </span>
                    <select
                      value={settings.aiProvider}
                      onChange={(event) => updateAiProvider(event.target.value as ShellDeskAiProvider)}
                    >
                      {aiProviderChoices.map((providerChoice) => (
                        <option key={providerChoice.value} value={providerChoice.value}>{t(providerChoice.labelId, settings.language)}</option>
                      ))}
                    </select>
                  </label>

                  {settings.aiProvider === 'custom' ? (
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
                      disabled={settings.aiProvider !== 'custom'}
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
                        disabled={isAiModelsLoading || !settings.aiApiBaseUrl.trim() || !settings.aiApiKey.trim()}
                      >
                        {isAiModelsLoading ? t('settings.ai.model.fetching', settings.language) : t('settings.ai.model.fetch', settings.language)}
                      </button>
                    </div>
                  </div>
                </div>
                <p className="settings-caption">{t('settings.ai.intro', settings.language)}</p>
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
                        onClick={runAutoSyncNow}
                        disabled={isSyncBusy}
                      >
                        {syncPendingAction === 'run' ? t('settings.sync.action.run.loading', settings.language) : t('settings.sync.action.run', settings.language)}
                      </button>
                    </div>
                  </div>
                </div>
                <p className="settings-caption">{t('settings.sync.caption', settings.language)}</p>

                {syncConflicts.length ? (
                  <div className="settings-sync-conflicts">
                    <strong>{t('settings.sync.conflicts.title', settings.language)}</strong>
                    {syncConflicts.slice(0, 6).map((conflict) => (
                      <div key={`${conflict.type}:${conflict.id}`}>
                        <span>{conflict.name}</span>
                        <small>{conflict.reason}</small>
                      </div>
                    ))}
                    {syncConflicts.length > 6 ? <small>{t('settings.sync.conflicts.more', settings.language, { count: String(syncConflicts.length - 6) })}</small> : null}
                  </div>
                ) : null}
              </section>
            </>
          ) : null}

          {activeSection === 'about' ? (
            <>
              <section className="settings-section settings-about-section">
                <div className="settings-about-hero">
                  <img src={appIconUrl} alt="" draggable={false} />
                  <span>
                    <strong>{appDisplayName}</strong>
                    <small>{t('settings.about.intro', settings.language)}</small>
                  </span>
                </div>
              </section>

              <section className="settings-section">
                <h2>{t('settings.about.appInfo.title', settings.language)}</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.about.version.label', settings.language)}</strong>
                      <small>{appPlatform}</small>
                    </span>
                    <code className="settings-inline-code">v{appVersion}</code>
                  </div>

                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.about.contact.label', settings.language)}</strong>
                      <small>{t('settings.about.contact.summary', settings.language)}</small>
                    </span>
                    <button
                      type="button"
                      className="settings-link-button"
                      onClick={() => openExternalLink(`mailto:${shellDeskContactEmail}`)}
                    >
                      {shellDeskContactEmail}
                    </button>
                  </div>

                  <div className="settings-row">
                    <span>
                      <strong>GitHub</strong>
                      <small>{t('settings.about.repository.summary', settings.language)}</small>
                    </span>
                    <button
                      type="button"
                      className="settings-link-button"
                      onClick={() => openExternalLink(shellDeskRepositoryUrl)}
                    >
                      liubaicai/ShellDesk
                    </button>
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <h2>{t('settings.update.title', settings.language)}</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.update.status.label', settings.language)}</strong>
                      <small className={updateStatusClassName ? `settings-update-status ${updateStatusClassName}` : 'settings-update-status'}>
                        {updateStatusText}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="command-button"
                      onClick={checkForUpdates}
                      disabled={isCheckingForUpdates}
                    >
                      {isCheckingForUpdates ? t('settings.update.checkingButton', settings.language) : t('settings.update.checkButton', settings.language)}
                    </button>
                  </div>

                  <div className="settings-row">
                    <span>
                      <strong>{t('settings.update.latest.label', settings.language)}</strong>
                      <small>
                        {updateCheckResult
                          ? [updateCheckResult.releaseName, formatDateTime(updateCheckResult.releaseDate)].filter(Boolean).join(' · ')
                          : t('settings.update.latest.clickToCheck', settings.language)}
                      </small>
                    </span>
                    <code className="settings-inline-code">{updateCheckResult?.latestVersion ?? t('settings.update.latest.notChecked', settings.language)}</code>
                  </div>

                  {updateCheckResult?.updateAvailable ? (
                    <div className="settings-row">
                      <span>
                        <strong>{t('settings.update.download.title', settings.language)}</strong>
                        <small>{[updateCheckResult.downloadName || t('settings.update.download.defaultName', settings.language), formatFileSize(updateCheckResult.downloadSize)].filter(Boolean).join(' · ')}</small>
                      </span>
                      <button
                        type="button"
                        className="command-button"
                        onClick={() => openExternalLink(updateCheckResult.downloadUrl ?? updateCheckResult.releaseUrl)}
                      >
                        {t('settings.update.download.open', settings.language)}
                      </button>
                    </div>
                  ) : null}
                </div>
              </section>
            </>
          ) : null}
        </div>
      </section>
    </>
  );
}

export default SettingsPage;
