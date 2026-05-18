import { useState } from 'react';

const settingsSections = [
  { key: 'general', label: '常规', summary: '语言、字体、视图' },
  { key: 'appearance', label: '外观', summary: '主题与强调色' },
  { key: 'terminal', label: '终端', summary: '字号、光标、滚动' },
  { key: 'security', label: '安全与存储', summary: '凭据与本地仓库' },
  { key: 'backup', label: '备份与导入', summary: '配置迁移' },
] as const;

const accentColorChoices = ['#43c7ff', '#77f4c5', '#ffb347', '#ff7b9c', '#9f8cff', '#8bd3ff', '#ff8c42'];

interface SettingsPageProps {
  hostCount: number;
  keyCount: number;
  bookmarkCount: number;
  settings: GuiSshAppSettings;
  storageInfo: GuiSshStorageInfo | null;
  isConfigTransferPending: boolean;
  onSettingsChange: (settings: GuiSshAppSettings) => void;
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

  const updateSetting = <Field extends keyof GuiSshAppSettings>(field: Field, value: GuiSshAppSettings[Field]) => {
    onSettingsChange({
      ...settings,
      [field]: value,
    });
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
                    <select value={settings.language} onChange={(event) => updateSetting('language', event.target.value as GuiSshAppSettings['language'])}>
                      <option value="zh-CN">简体中文</option>
                      <option value="en-US">English</option>
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>界面字体</strong>
                      <small>控制主界面与表单的字体栈</small>
                    </span>
                    <select
                      value={settings.interfaceFont}
                      onChange={(event) => updateSetting('interfaceFont', event.target.value as GuiSshAppSettings['interfaceFont'])}
                    >
                      <option value="LXGW WenKai Mono">LXGW WenKai Mono（本地）</option>
                      <option value="Microsoft YaHei UI">微软雅黑 UI</option>
                      <option value="DengXian">等线</option>
                      <option value="SimSun">宋体</option>
                      <option value="Arial">Arial</option>
                      <option value="Verdana">Verdana</option>
                      <option value="Georgia">Georgia</option>
                      <option value="Times New Roman">Times New Roman</option>
                    </select>
                  </label>

                  <label className="settings-row">
                    <span>
                      <strong>主机页默认视图</strong>
                      <small>控制主机列表默认使用网格还是列表</small>
                    </span>
                    <select
                      value={settings.defaultHostView}
                      onChange={(event) => updateSetting('defaultHostView', event.target.value as GuiSshAppSettings['defaultHostView'])}
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
            </>
          ) : null}

          {activeSection === 'terminal' ? (
            <section className="settings-section">
              <h2>终端体验</h2>
              <div className="settings-card">
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
                    <strong>光标样式</strong>
                    <small>控制终端中的输入光标形态</small>
                  </span>
                  <select
                    value={settings.terminalCursorStyle}
                    onChange={(event) => updateSetting('terminalCursorStyle', event.target.value as GuiSshAppSettings['terminalCursorStyle'])}
                  >
                    <option value="block">块状</option>
                    <option value="bar">竖线</option>
                    <option value="underline">下划线</option>
                  </select>
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
              </div>
            </section>
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
                      <strong>数据文件路径</strong>
                      <small>主机、密钥、设置和书签统一保存在主进程本地仓库</small>
                    </span>
                    <code className="settings-inline-code">{storageInfo?.path ?? '未就绪'}</code>
                  </div>
                </div>
                <p className="settings-caption">私钥内容不会再以路径引用方式保存在渲染进程，而是复制到本地受保护仓库，并只在主进程解锁使用。</p>
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
                    <small>导出主机、密钥、设置和浏览器书签，包含密码、私钥内容与密钥口令。</small>
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
