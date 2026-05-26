import { type ChangeEvent, type CSSProperties, useEffect, useMemo, useState } from 'react';

import {
  getTerminalThemeChoice,
  terminalBoldWeightChoices,
  terminalFontWeightChoices,
  terminalThemeChoices,
} from '../components/remote-desktop/terminalPresets';
import defaultDesktopWallpaperUrl from '../assets/images/default-desktop-wallpaper.png';

const settingsSections = [
  { key: 'general', label: '常规', summary: '语言、字体、视图' },
  { key: 'appearance', label: '外观', summary: '主题、强调色、壁纸' },
  { key: 'terminal', label: '终端', summary: '主题、字体、滚动' },
  { key: 'ai', label: 'SD-Agent', summary: '提供商、密钥、模型' },
  { key: 'security', label: '安全与存储', summary: '凭据与本地仓库' },
  { key: 'backup', label: '备份与导入', summary: '配置迁移' },
] as const;

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
  { value: 1, label: '关闭' },
  { value: 4.5, label: 'AA 4.5' },
  { value: 7, label: 'AAA 7' },
];
const aiProviderChoices: Array<{
  value: ShellDeskAiProvider;
  label: string;
  summary: string;
  apiFormat: ShellDeskAiApiFormat;
  defaultApiBaseUrl: string;
}> = [
  {
    value: 'openai',
    label: 'OpenAI',
    summary: '官方 OpenAI API，使用 /v1/models 获取模型',
    apiFormat: 'openai',
    defaultApiBaseUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'anthropic',
    label: 'Claude / Anthropic',
    summary: 'Anthropic Messages API，使用 /v1/models 获取 Claude 模型',
    apiFormat: 'anthropic',
    defaultApiBaseUrl: 'https://api.anthropic.com',
  },
  {
    value: 'openai-compatible',
    label: 'OpenAI 兼容',
    summary: 'DeepSeek、OpenRouter、Ollama 等兼容 OpenAI 的服务',
    apiFormat: 'openai',
    defaultApiBaseUrl: '',
  },
  {
    value: 'custom',
    label: '自定义提供商',
    summary: '手动选择 API 格式并填写模型列表地址',
    apiFormat: 'openai',
    defaultApiBaseUrl: '',
  },
];

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('图片读取失败。'));
    };

    reader.onerror = () => reject(new Error('图片读取失败。'));
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

function getFontListErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return '读取系统字体失败。';
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
    aiModelOptions.length ? `已获取 ${aiModelOptions.length} 个模型` : '获取模型列表后可从下拉框选择'
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
    ? `使用备用字体列表：${systemFontsError}`
    : isSystemFontsLoading
      ? '正在读取系统字体列表'
      : `已读取 ${systemFonts.length} 个系统字体`;
  const hasCustomWallpaper = settings.desktopWallpaperMode === 'custom' && Boolean(settings.desktopWallpaperDataUrl);
  const wallpaperPreviewUrl = hasCustomWallpaper ? settings.desktopWallpaperDataUrl : defaultDesktopWallpaperUrl;
  const wallpaperPreviewStyle: CSSProperties = {
    backgroundImage: `linear-gradient(180deg, rgba(8, 13, 20, 0.16), rgba(8, 13, 20, 0.34)), url(${JSON.stringify(wallpaperPreviewUrl)})`,
  };

  const resetDesktopWallpaper = () => {
    setWallpaperError('');
    onSettingsChange({
      ...settings,
      desktopWallpaperMode: 'default',
      desktopWallpaperDataUrl: '',
      desktopWallpaperName: '',
    });
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
      aiProviderName: providerChoice.label,
      aiApiFormat: providerChoice.apiFormat,
      aiApiBaseUrl: providerChoice.defaultApiBaseUrl,
      aiModel: '',
    });
  };

  const fetchAiModels = async () => {
    const listModels = window.guiSSH?.ai?.listModels;

    if (!listModels) {
      setAiModelsError('当前运行环境未提供 SD-Agent 模型列表接口。');
      setAiModelsMessage('');
      return;
    }

    if (!settings.aiApiBaseUrl.trim()) {
      setAiModelsError('请先填写 API 地址。');
      setAiModelsMessage('');
      return;
    }

    if (!settings.aiApiKey.trim()) {
      setAiModelsError('请先填写 API 密钥。');
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
      setAiModelsMessage(`已获取 ${models.length} 个模型`);
      setIsAiModelListOpen(models.length > 0);
    } catch (error) {
      setAiModelOptions([]);
      setIsAiModelListOpen(false);
      setAiModelsError(error instanceof Error ? error.message : '获取模型列表失败。');
    } finally {
      setIsAiModelsLoading(false);
    }
  };

  useEffect(() => {
    const listFonts = window.guiSSH?.system?.listFonts;

    if (!listFonts) {
      setSystemFonts(fallbackSystemFontChoices);
      setSystemFontsError('当前运行环境未提供系统字体接口。');
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
        setSystemFontsError(nextSystemFonts.length ? '' : '系统未返回可用字体。');
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }

        setSystemFonts(fallbackSystemFontChoices);
        setSystemFontsError(getFontListErrorMessage(error));
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
      setWallpaperError('图片不能超过 5 MB。');
      return;
    }

    if (
      (file.type && !acceptedWallpaperTypes.has(file.type)) ||
      (!file.type && !wallpaperExtensionPattern.test(file.name))
    ) {
      setWallpaperError('请选择 PNG、JPG、WebP 或 GIF 图片。');
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);

      if (!wallpaperDataUrlPattern.test(dataUrl)) {
        setWallpaperError('请选择 PNG、JPG、WebP 或 GIF 图片。');
        return;
      }

      setWallpaperError('');
      onSettingsChange({
        ...settings,
        desktopWallpaperMode: 'custom',
        desktopWallpaperDataUrl: dataUrl,
        desktopWallpaperName: file.name,
      });
    } catch (error) {
      setWallpaperError(error instanceof Error ? error.message : '图片读取失败。');
    }
  };

  return (
    <>
      <div className="command-bar no-drag simple-command-bar settings-command-bar">
        <strong>设置</strong>
      </div>

      <section className="settings-page no-drag">
        <aside className="settings-section-nav" aria-label="设置分类">
          <div className="settings-section-nav-header">
            <span>设置分类</span>
            <small>{settingsSections.length} 项</small>
          </div>

          {settingsSections.map((section, index) => (
            <button
              key={section.key}
              type="button"
              className={`settings-section-nav-item ${activeSection === section.key ? 'active' : ''}`}
              onClick={() => setActiveSection(section.key)}
              aria-current={activeSection === section.key ? 'page' : undefined}
            >
              <span className="settings-section-nav-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="settings-section-nav-copy">
                <strong>{section.label}</strong>
                <small>{section.summary}</small>
              </span>
            </button>
          ))}
        </aside>

        <div className="settings-content">
          {activeSection === 'general' ? (
            <>
              <section className="settings-section">
                <h2>应用行为</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>语言</strong>
                      <small>选择应用界面语言</small>
                    </span>
                    <select value={settings.language} onChange={(event) => updateSetting('language', event.target.value as ShellDeskAppSettings['language'])}>
                      <option value="zh-CN">简体中文</option>
                      <option value="en-US">English</option>
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>界面字体</strong>
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

                  <label className="settings-row">
                    <span>
                      <strong>主机页默认视图</strong>
                      <small>控制主机列表默认使用网格还是列表</small>
                    </span>
                    <select
                      value={settings.defaultHostView}
                      onChange={(event) => updateSetting('defaultHostView', event.target.value as ShellDeskAppSettings['defaultHostView'])}
                    >
                      <option value="grid">网格</option>
                      <option value="list">列表</option>
                    </select>
                  </label>
                </div>
              </section>

              <section className="settings-section">
                <h2>本地库概览</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span>
                      <strong>主机连接</strong>
                      <small>当前已保存的 SSH 主机数量</small>
                    </span>
                    <strong>{hostCount}</strong>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>SSH 密钥</strong>
                      <small>已导入或生成的密钥对数量</small>
                    </span>
                    <strong>{keyCount}</strong>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>浏览器书签</strong>
                      <small>所有远程浏览器作用域下的书签总数</small>
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
                <h2>界面主题</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span>
                      <strong>主题</strong>
                      <small>选择浅色、深色或跟随系统主题</small>
                    </span>
                    <div className="theme-switch" role="group" aria-label="主题">
                      <button type="button" className={settings.theme === 'light' ? 'active' : ''} onClick={() => updateSetting('theme', 'light')}>☼ 浅色</button>
                      <button type="button" className={settings.theme === 'system' ? 'active' : ''} onClick={() => updateSetting('theme', 'system')}>▣ 系统</button>
                      <button type="button" className={settings.theme === 'dark' ? 'active' : ''} onClick={() => updateSetting('theme', 'dark')}>☾ 深色</button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <h2>强调色</h2>
                <div className="settings-card color-card">
                  <div className="settings-row">
                    <span>
                      <strong>主强调色</strong>
                      <small>用于按钮、选中态、焦点边框和终端高亮</small>
                    </span>
                    <div className="color-picker-row" aria-label="强调色">
                      {accentColorChoices.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={settings.accentColor === color ? 'selected' : ''}
                          style={{ background: color }}
                          onClick={() => updateSetting('accentColor', color)}
                          aria-label={`选择颜色 ${color}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="settings-section">
                <h2>虚拟桌面壁纸</h2>
                <div className="settings-card desktop-wallpaper-card">
                  <div className="settings-row desktop-wallpaper-row">
                    <span>
                      <strong>连接桌面背景</strong>
                      <small>作为连接服务器后的虚拟桌面壁纸；不设置时使用默认背景</small>
                    </span>
                    <div className="desktop-wallpaper-control">
                      <div
                        className={`desktop-wallpaper-preview ${hasCustomWallpaper ? 'custom' : ''}`}
                        style={wallpaperPreviewStyle}
                        aria-label={hasCustomWallpaper ? '自定义壁纸预览' : '默认壁纸预览'}
                      >
                        <span>{hasCustomWallpaper ? '自定义壁纸' : '默认背景'}</span>
                      </div>
                      <div className="desktop-wallpaper-actions">
                        <label className="command-button desktop-wallpaper-upload">
                          上传图片
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
                            onChange={uploadDesktopWallpaper}
                          />
                        </label>
                        <button type="button" className="command-button muted" onClick={resetDesktopWallpaper} disabled={!hasCustomWallpaper}>
                          使用默认
                        </button>
                      </div>
                      <small className="desktop-wallpaper-meta">
                        {hasCustomWallpaper ? settings.desktopWallpaperName || '自定义图片' : '当前使用 ShellDesk 默认桌面背景'}
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
                <h2>终端主题</h2>
                <div className="settings-card">
                  <label className="settings-row terminal-theme-row">
                    <span>
                      <strong>颜色主题</strong>
                      <small>{selectedTerminalTheme.summary}</small>
                    </span>
                    <select
                      value={settings.terminalTheme}
                      onChange={(event) => updateSetting('terminalTheme', event.target.value as ShellDeskAppSettings['terminalTheme'])}
                    >
                      {terminalThemeChoices.map((themeChoice) => (
                        <option key={themeChoice.key} value={themeChoice.key}>{themeChoice.label}</option>
                      ))}
                    </select>
                  </label>

                  <div className="terminal-theme-preview" style={{ background: selectedTerminalTheme.theme.background, color: selectedTerminalTheme.theme.foreground }}>
                    <div>
                      <strong>{selectedTerminalTheme.label}</strong>
                      <small>$ ssh user@host</small>
                    </div>
                    <div className="terminal-theme-swatches" aria-label="终端颜色预览">
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
                <h2>字体与排版</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>字体族</strong>
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
                      <strong>终端字号</strong>
                      <small>影响 SSH Shell 中的字符大小</small>
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
                      <strong>行高</strong>
                      <small>行距越大，日志和长命令越容易扫读</small>
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
                      <strong>常规字重</strong>
                      <small>控制普通输出的粗细</small>
                    </span>
                    <select
                      value={settings.terminalFontWeight}
                      onChange={(event) => updateSetting('terminalFontWeight', Number(event.target.value))}
                    >
                      {terminalFontWeightChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>{choice.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>粗体字重</strong>
                      <small>控制 sudo 提示、强调文本和 ANSI 粗体</small>
                    </span>
                    <select
                      value={settings.terminalFontWeightBold}
                      onChange={(event) => updateSetting('terminalFontWeightBold', Number(event.target.value))}
                    >
                      {terminalBoldWeightChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>{choice.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>字体连字</strong>
                      <small>对 Fira Code、JetBrains Mono 等字体启用编程连字</small>
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
                <h2>光标与滚动</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>光标样式</strong>
                      <small>控制终端中的输入光标形态</small>
                    </span>
                    <select
                      value={settings.terminalCursorStyle}
                      onChange={(event) => updateSetting('terminalCursorStyle', event.target.value as ShellDeskAppSettings['terminalCursorStyle'])}
                    >
                      <option value="block">块状</option>
                      <option value="bar">竖线</option>
                      <option value="underline">下划线</option>
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>失焦光标</strong>
                      <small>窗口失去焦点时的光标显示方式</small>
                    </span>
                    <select
                      value={settings.terminalCursorInactiveStyle}
                      onChange={(event) => updateSetting('terminalCursorInactiveStyle', event.target.value as ShellDeskAppSettings['terminalCursorInactiveStyle'])}
                    >
                      <option value="outline">描边</option>
                      <option value="block">块状</option>
                      <option value="bar">竖线</option>
                      <option value="underline">下划线</option>
                      <option value="none">隐藏</option>
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>光标闪烁</strong>
                      <small>关闭后光标保持静止，减少视觉干扰</small>
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
                      <strong>滚动缓冲区</strong>
                      <small>保留更多历史输出会占用更多内存</small>
                    </span>
                    <select
                      value={settings.terminalScrollback}
                      onChange={(event) => updateSetting('terminalScrollback', Number(event.target.value))}
                    >
                      {[1000, 3000, 5000, 10000, 20000, 50000].map((value) => (
                        <option key={value} value={value}>{value.toLocaleString('zh-CN')} 行</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>滚轮速度</strong>
                      <small>控制普通滚动的速度倍率</small>
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
                      <strong>快速滚动速度</strong>
                      <small>按住 Alt 滚轮时使用的速度倍率</small>
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
                      <strong>输入时滚到底部</strong>
                      <small>在查看历史输出时输入命令会自动回到最新位置</small>
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
                      <strong>清屏保留历史</strong>
                      <small>让 clear 等清屏动作把旧内容推入滚动历史</small>
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
                <h2>输入与辅助</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>选中即复制</strong>
                      <small>右键仍然保留粘贴 / 复制行为</small>
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
                      <strong>右键粘贴</strong>
                      <small>没有选中文本时，右键直接粘贴剪贴板内容</small>
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
                      <strong>Alt 单击移动光标</strong>
                      <small>在支持的 Shell 编辑模式中快速定位输入光标</small>
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
                      <strong>括号粘贴保护</strong>
                      <small>让支持的 Shell 能识别一次性粘贴内容，降低误执行风险</small>
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
                      <strong>最小对比度</strong>
                      <small>自动增强低对比输出文本</small>
                    </span>
                    <select
                      value={settings.terminalMinimumContrastRatio}
                      onChange={(event) => updateSetting('terminalMinimumContrastRatio', Number(event.target.value))}
                    >
                      {terminalContrastChoices.map((choice) => (
                        <option key={choice.value} value={choice.value}>{choice.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>屏幕阅读器支持</strong>
                      <small>启用后会增加辅助 DOM，可能略微影响高频输出性能</small>
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
                <h2>SD-Agent 提供商</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>提供商</strong>
                      <small>{selectedAiProvider.summary}</small>
                    </span>
                    <select
                      value={settings.aiProvider}
                      onChange={(event) => updateAiProvider(event.target.value as ShellDeskAiProvider)}
                    >
                      {aiProviderChoices.map((providerChoice) => (
                        <option key={providerChoice.value} value={providerChoice.value}>{providerChoice.label}</option>
                      ))}
                    </select>
                  </label>

                  {settings.aiProvider === 'custom' ? (
                    <label className="settings-row">
                      <span>
                        <strong>提供商名称</strong>
                        <small>用于后续组件展示当前 SD-Agent 来源</small>
                      </span>
                      <input
                        className="settings-text-input"
                        value={settings.aiProviderName}
                        maxLength={80}
                        onChange={(event) => updateSetting('aiProviderName', event.target.value)}
                        placeholder="例如：公司内网网关"
                      />
                    </label>
                  ) : null}

                  <label className="settings-row">
                    <span>
                      <strong>API 格式</strong>
                      <small>OpenAI 兼容格式使用 Authorization；Claude 格式使用 x-api-key</small>
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
                      <strong>API 地址</strong>
                      <small>填写基础地址即可；模型列表会自动拼接对应路径</small>
                    </span>
                    <input
                      className="settings-text-input settings-url-input"
                      type="url"
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
                      <strong>API 密钥</strong>
                      <small>密钥写入敏感 vault；普通 config.json 只保留非敏感配置</small>
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
                <p className="settings-caption">OpenAI 兼容格式适合 OpenAI、DeepSeek、OpenRouter、Ollama 网关等；Claude 格式适合 Anthropic 官方或兼容网关。</p>
              </section>

              <section className="settings-section">
                <h2>模型</h2>
                <div className="settings-card ai-model-card">
                  <div className="settings-row ai-model-row">
                    <span>
                      <strong>默认模型</strong>
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
                          placeholder="先获取模型列表，或手动输入模型 ID"
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
                        {isAiModelsLoading ? '获取中...' : '获取模型'}
                      </button>
                    </div>
                  </div>
                </div>
                <p className="settings-caption">SD-Agent 使用全局配置和模型发现，后续终端、文件、数据库等组件可以复用这套能力；它支持基础对话，也可以在用户确认后通过 SSH 隧道执行命令等操作。</p>
              </section>
            </>
          ) : null}

          {activeSection === 'security' ? (
            <>
              <section className="settings-section">
                <h2>敏感信息</h2>
                <div className="settings-card">
                  <label className="settings-row">
                    <span>
                      <strong>默认记住 SSH 密码</strong>
                      <small>影响连接弹窗里“连接成功后保存到此主机配置”的默认勾选</small>
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
                      <strong>默认记住密钥口令</strong>
                      <small>影响密钥登录弹窗的默认保存行为</small>
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
                <h2>存储状态</h2>
                <div className="settings-card">
                  <div className="settings-row">
                    <span>
                      <strong>本地保护方式</strong>
                      <small>{storageInfo?.protectionLabel ?? '正在读取...'}</small>
                    </span>
                    <strong>{storageInfo?.protected ? '受保护' : '文件权限保护'}</strong>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>数据目录</strong>
                      <small>普通配置与敏感 vault 统一放在同一目录，便于后续同步</small>
                    </span>
                    <code className="settings-inline-code">{storageInfo?.path ?? '未就绪'}</code>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>普通配置文件</strong>
                      <small>主机元数据、设置和书签</small>
                    </span>
                    <code className="settings-inline-code">{storageInfo?.configPath ?? '未就绪'}</code>
                  </div>
                  <div className="settings-row">
                    <span>
                      <strong>敏感 vault 文件</strong>
                      <small>SSH 密码、密钥口令、私钥内容和 AI API 密钥</small>
                    </span>
                    <code className="settings-inline-code">{storageInfo?.vaultPath ?? '未就绪'}</code>
                  </div>
                </div>
                <p className="settings-caption">私钥、密码、口令和 AI API 密钥只写入敏感 vault；普通配置文件不包含这些字段，后续可单独作为云同步配置源。</p>
              </section>
            </>
          ) : null}

          {activeSection === 'backup' ? (
            <section className="settings-section">
              <h2>配置备份</h2>
              <div className="settings-card">
                <div className="settings-row">
                  <span>
                    <strong>完整导出</strong>
                    <small>导出主机、密钥、设置和浏览器书签，包含密码、私钥内容、密钥口令和 AI API 密钥。</small>
                  </span>
                  <button
                    type="button"
                    className="command-button"
                    onClick={onExportConfig}
                    disabled={isConfigTransferPending}
                  >
                    {isConfigTransferPending ? '处理中...' : '导出配置'}
                  </button>
                </div>

                <div className="settings-row">
                  <span>
                    <strong>导入配置</strong>
                    <small>从完整备份恢复本地仓库，当前主机、密钥和书签会被导入内容替换。</small>
                  </span>
                  <button
                    type="button"
                    className="command-button"
                    onClick={onImportConfig}
                    disabled={isConfigTransferPending}
                  >
                    {isConfigTransferPending ? '处理中...' : '导入配置'}
                  </button>
                </div>
              </div>
              <p className="settings-caption">导出的 JSON 属于明文高敏备份，只适合放在你完全信任的位置；日常使用请依赖应用自身的本地加密仓库。</p>
            </section>
          ) : null}
        </div>
      </section>
    </>
  );
}

export default SettingsPage;
