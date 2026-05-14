import { useState } from 'react';

const settingsSections = [
  { key: 'app', label: '应用', icon: '▣' },
  { key: 'appearance', label: '外观', icon: '◉' },
  { key: 'terminal', label: '终端', icon: '▹' },
  { key: 'shortcuts', label: '快捷键', icon: '⌘' },
  { key: 'sftp', label: 'SFTP', icon: '⇅' },
  { key: 'ai', label: 'AI', icon: '✣' },
  { key: 'sync', label: '同步与云', icon: '☁' },
  { key: 'system', label: '系统', icon: '▤' },
] as const;

const lightThemeColors = ['#e8edf5', '#ffffff', '#f4f1ea', '#f8fbff', '#eef7f8', '#fbf7f0', '#f9f8ff'];
const darkThemeColors = ['#05070b', '#111827', '#0c1320', '#171717', '#141b25', '#0f1117', '#0d1b14'];

interface SettingsPageProps {
  hostCount: number;
  keyCount: number;
  isConfigTransferPending: boolean;
  onImportConfig: () => void;
  onExportConfig: () => void;
}

function SettingsPage({
  hostCount,
  keyCount,
  isConfigTransferPending,
  onImportConfig,
  onExportConfig,
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState('appearance');
  const [theme, setTheme] = useState<'light' | 'system' | 'dark'>('dark');
  const [useAccentColor, setUseAccentColor] = useState(false);
  const [selectedLightColor, setSelectedLightColor] = useState(lightThemeColors[0]);
  const [selectedDarkColor, setSelectedDarkColor] = useState(darkThemeColors[1]);

  return (
    <>
      <div className="command-bar no-drag simple-command-bar settings-command-bar">
        <strong>设置</strong>
      </div>

      <section className="settings-page no-drag">
        <aside className="settings-sidebar" aria-label="设置分类">
          {settingsSections.map((section) => (
            <button
              key={section.key}
              type="button"
              className={activeSection === section.key ? 'active' : ''}
              onClick={() => setActiveSection(section.key)}
            >
              <span>{section.icon}</span>
              {section.label}
            </button>
          ))}
        </aside>

        <div className="settings-content">
          <section className="settings-section">
            <h2>语言</h2>
            <div className="settings-card">
              <label className="settings-row">
                <span>
                  <strong>语言</strong>
                  <small>选择界面语言</small>
                </span>
                <select defaultValue="zh-CN">
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </label>
              <label className="settings-row">
                <span>
                  <strong>界面字体</strong>
                  <small>选择软件界面使用的字体</small>
                </span>
                <select defaultValue="Space Grotesk">
                  <option>Space Grotesk</option>
                  <option>Segoe UI</option>
                  <option>Inter</option>
                </select>
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h2>界面主题</h2>
            <div className="settings-card">
              <div className="settings-row">
                <span>
                  <strong>主题</strong>
                  <small>选择浅色、深色或跟随系统设置</small>
                </span>
                <div className="theme-switch" role="group" aria-label="主题">
                  <button type="button" className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>☼ 浅色</button>
                  <button type="button" className={theme === 'system' ? 'active' : ''} onClick={() => setTheme('system')}>▣ 系统</button>
                  <button type="button" className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>☾ 深色</button>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>强调色</h2>
            <div className="settings-card">
              <label className="settings-row">
                <span>
                  <strong>使用自定义强调色</strong>
                  <small>覆盖主题自带的强调色</small>
                </span>
                <input
                  className="settings-toggle"
                  type="checkbox"
                  checked={useAccentColor}
                  onChange={(event) => setUseAccentColor(event.target.checked)}
                />
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h2>主题色</h2>
            <div className="settings-card color-card">
              <div className="settings-row">
                <span>
                  <strong>浅色主题</strong>
                  <small>为浅色与深色主题选择预设颜色</small>
                </span>
                <div className="color-picker-row" aria-label="浅色主题色">
                  {lightThemeColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={selectedLightColor === color ? 'selected' : ''}
                      style={{ background: color }}
                      onClick={() => setSelectedLightColor(color)}
                      aria-label={`选择颜色 ${color}`}
                    />
                  ))}
                </div>
              </div>
              <div className="settings-row">
                <span>
                  <strong>深色主题</strong>
                </span>
                <div className="color-picker-row" aria-label="深色主题色">
                  {darkThemeColors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={selectedDarkColor === color ? 'selected' : ''}
                      style={{ background: color }}
                      onClick={() => setSelectedDarkColor(color)}
                      aria-label={`选择颜色 ${color}`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h2>主机库</h2>
            <div className="settings-card">
              <label className="settings-row">
                <span>
                  <strong>默认主机视图</strong>
                  <small>选择主机页默认展示方式</small>
                </span>
                <select defaultValue="grid">
                  <option value="grid">网格</option>
                  <option value="list">列表</option>
                </select>
              </label>
              <label className="settings-row">
                <span>
                  <strong>连接后显示桌面</strong>
                  <small>连接成功后进入远程桌面环境</small>
                </span>
                <input className="settings-toggle" type="checkbox" defaultChecked />
              </label>
            </div>
          </section>

          <section className="settings-section">
            <h2>配置备份</h2>
            <div className="settings-card">
              <div className="settings-row">
                <span>
                  <strong>完整导出</strong>
                  <small>导出 {hostCount} 台主机与 {keyCount} 把密钥，包含密码、私钥内容与密钥口令。</small>
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
                  <small>从完整备份恢复主机与密钥，已导入私钥会保存到本机应用目录。</small>
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
            <p className="settings-caption">导出的 JSON 包含明文敏感信息，请仅保存在可信位置。</p>
          </section>
        </div>
      </section>
    </>
  );
}

export default SettingsPage;
