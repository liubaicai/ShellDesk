const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function workspaceFileExists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function unique(values) {
  return [...new Set(values)];
}

function extractBlock(source, startPattern, endPattern) {
  const start = source.search(startPattern);
  if (start === -1) {
    throw new Error(`Could not find block start: ${startPattern}`);
  }
  const sliced = source.slice(start);
  const end = sliced.search(endPattern);
  if (end === -1) {
    throw new Error(`Could not find block end: ${endPattern}`);
  }
  return sliced.slice(0, end);
}

function extractStringArray(source, constName) {
  const escapedName = constName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`const\\s+${escapedName}[^=]*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!match) {
    throw new Error(`Could not find string array: ${constName}`);
  }
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

function extractRustStringArray(source, constName) {
  const escapedName = constName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`const\\s+${escapedName}[^=]*=\\s*&\\[([\\s\\S]*?)\\];`));
  if (!match) {
    throw new Error(`Could not find Rust string array: ${constName}`);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function extractNumberConst(source, constName) {
  const escapedName = constName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`const\\s+${escapedName}[^=]*=\\s*(\\d+)`));
  if (!match) {
    throw new Error(`Could not find number const: ${constName}`);
  }
  return Number.parseInt(match[1], 10);
}

function extractRustNumberConst(source, constName) {
  const escapedName = constName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`const\\s+${escapedName}[^=]*=\\s*(\\d+)`));
  if (!match) {
    throw new Error(`Could not find Rust number const: ${constName}`);
  }
  return Number.parseInt(match[1], 10);
}

function extractDesktopApps(source) {
  const block = extractBlock(source, /const desktopApps = \[/, /\] as const satisfies/);
  return [...block.matchAll(/\{\s*key:\s*'([^']+)',\s*labelId:\s*'([^']+)',\s*descriptionId:\s*'([^']+)'/g)]
    .map((match) => ({
      key: match[1],
      labelId: match[2],
      descriptionId: match[3],
    }));
}

function extractRecordKeys(source, constName) {
  const escapedName = constName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`const\\s+${escapedName}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  if (!match) {
    throw new Error(`Could not find record: ${constName}`);
  }
  return [...match[1].matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)]
    .map((entry) => entry[1] ?? entry[2] ?? entry[3]);
}

function extractTypeUnion(source, typeName) {
  const escapedName = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`type\\s+${escapedName}\\s*=([\\s\\S]*?);`));
  if (!match) {
    throw new Error(`Could not find type union: ${typeName}`);
  }
  return [...match[1].matchAll(/\|\s*'([^']+)'/g)].map((entry) => entry[1]);
}

function extractRenderBranches(source) {
  const block = extractBlock(
    source,
    /const renderWindowContent = \(desktopWindow: DesktopWindowState\) => \{/,
    /\n\s*return \(\n\s*<>\n\s*<main className="remote-desktop-page">/,
  );
  return unique([...block.matchAll(/desktopWindow\.appKey === '([^']+)'/g)].map((entry) => entry[1]));
}

function extractCatalogMessageIds(source, catalogName) {
  const block = extractBlock(
    source,
    new RegExp(`const\\s+${catalogName}\\b`),
    catalogName === 'zhCN' ? /\n} as const;/ : /\n};/,
  );
  return unique([...block.matchAll(/'([^']+)':\s*(?:'|`)/g)].map((entry) => entry[1]));
}

function extractLazyComponents(source) {
  return new Map([...source.matchAll(/const\s+(Remote[A-Za-z0-9]+)\s*=\s*lazy\(\(\)\s*=>\s*import\('([^']+)'\)\)/g)]
    .map((match) => [match[1], match[2]]));
}

function extractIconSourcePaths(source) {
  const block = extractBlock(source, /const desktopAppIconSources/, /\n\};/);
  return new Map([...block.matchAll(/^\s*(?:'([^']+)'|([A-Za-z_$][\w$]*)):\s*new URL\('([^']+)'/gm)]
    .map((match) => [match[1] ?? match[2], match[3]]));
}

function extractStyleUses(source) {
  return unique([...source.matchAll(/@use\s+"\.\/remote-desktop\/([^"]+)"/g)].map((match) => match[1]));
}

function compareSets(label, expected, actual, errors) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((value) => !actualSet.has(value));
  const extra = actual.filter((value) => !expectedSet.has(value));
  if (missing.length || extra.length) {
    errors.push(`${label} mismatch.\n  missing: ${missing.join(', ') || '(none)'}\n  extra: ${extra.join(', ') || '(none)'}`);
  }
}

function compareOrdered(label, expected, actual, errors) {
  if (expected.length !== actual.length || expected.some((value, index) => actual[index] !== value)) {
    errors.push(`${label} order mismatch.\n  expected: ${expected.join(', ')}\n  actual:   ${actual.join(', ')}`);
  }
}

const desktopAppAssetContracts = {
  files: { component: 'RemoteFileExplorer', style: 'file-explorer' },
  terminal: { component: 'RemoteTerminal', style: 'terminal' },
  notepad: { component: 'RemoteNotepad', style: 'notepad' },
  browser: { component: 'RemoteBrowser', style: 'browser' },
  vnc: { component: 'RemoteVncViewer', style: 'vnc' },
  'log-viewer': { component: 'RemoteLogViewer', style: 'log-viewer' },
  monitor: { component: 'RemoteMonitor', style: 'monitor' },
  mysql: { component: 'RemoteMySQL', style: 'mysql' },
  clickhouse: { component: 'RemoteClickHouse', style: 'clickhouse' },
  redis: { component: 'RemoteRedis', style: 'redis' },
  'service-manager': { component: 'RemoteServiceManager', style: 'service-manager' },
  'container-manager': { component: 'RemoteContainerManager', style: 'container-manager' },
  'port-manager': { component: 'RemotePortManager', style: 'port-manager' },
  'firewall-manager': { component: 'RemoteFirewallManager', style: 'firewall-manager' },
  'iptables-manager': { component: 'RemoteIptablesManager', style: 'iptables-manager' },
  'network-diagnostics': { component: 'RemoteNetworkDiagnostics', style: 'network-diagnostics' },
  'disk-analyzer': { component: 'RemoteDiskAnalyzer', style: 'disk-analyzer' },
  'disk-manager': { component: 'RemoteDiskManager', style: 'disk-manager' },
  'package-manager': { component: 'RemotePackageManager', style: 'package-manager' },
  'git-manager': { component: 'RemoteGitManager', style: 'git-manager' },
  'cert-manager': { component: 'RemoteCertManager', style: 'cert-manager' },
  'nginx-manager': { component: 'RemoteNginxManager', style: 'nginx-manager' },
  'caddy-manager': { component: 'RemoteCaddyManager', style: 'caddy-manager' },
  'apache-manager': { component: 'RemoteApacheManager', style: 'apache-manager' },
  'scheduled-tasks': { component: 'RemoteScheduledTasks', style: 'scheduled-tasks' },
  postgres: { component: 'RemotePostgres', style: 'postgres' },
  mongo: { component: 'RemoteMongo', style: 'mongo' },
  'search-cluster': { component: 'RemoteSearchCluster', style: 'search-cluster' },
  'message-queue': { component: 'RemoteMessageQueuePanel', style: 'message-queue' },
  's3-browser': { component: 'RemoteS3Browser', style: 's3-browser' },
  'security-audit': { component: 'RemoteSecurityAudit', style: 'security-audit' },
  'login-sessions': { component: 'RemoteLoginSessions', style: 'login-sessions' },
  'api-debugger': { component: 'RemoteApiDebugger', style: 'api-debugger' },
  procmanager: { component: 'RemoteProcessManager', style: 'process-manager' },
  settings: { component: 'RemoteSettings', style: 'settings' },
  sqlite: { component: 'RemoteSqlite', style: 'sqlite' },
  'frp-manager': { component: 'RemoteFrpManager', style: 'frp-manager' },
  'frps-manager': { component: 'RemoteFrpsManager', style: 'frps-manager' },
};

const remoteDesktopSource = readWorkspaceFile('src/RemoteDesktopShell.tsx');
const appSource = readWorkspaceFile('src/App.tsx');
const styleIndexSource = readWorkspaceFile('src/styles/index.scss');
const viteEnvSource = readWorkspaceFile('src/vite-env.d.ts');
const vaultRemoteProfilesSource = readWorkspaceFile('src-tauri/src/vault/remote_profiles.rs');
const vaultNormalizeSource = readWorkspaceFile('src-tauri/src/vault/normalize.rs');
const i18nCatalogSource = readWorkspaceFile('src/i18nCatalog.ts');

const desktopAppEntries = extractDesktopApps(remoteDesktopSource);
const desktopAppKeys = desktopAppEntries.map((entry) => entry.key);
const errors = [];

if (desktopAppKeys.length !== unique(desktopAppKeys).length) {
  errors.push('desktopApps contains duplicate app keys.');
}

compareOrdered('vite-env ShellDeskDesktopAppKey', desktopAppKeys, extractTypeUnion(viteEnvSource, 'ShellDeskDesktopAppKey'), errors);
compareOrdered('Rust REMOTE_DESKTOP_APP_KEYS', desktopAppKeys, extractRustStringArray(vaultRemoteProfilesSource, 'REMOTE_DESKTOP_APP_KEYS'), errors);
compareSets('desktopAppIconSources', desktopAppKeys, extractRecordKeys(remoteDesktopSource, 'desktopAppIconSources'), errors);
compareSets('defaultWindowFrames', desktopAppKeys, extractRecordKeys(remoteDesktopSource, 'defaultWindowFrames'), errors);
compareSets('renderWindowContent branches', desktopAppKeys, extractRenderBranches(remoteDesktopSource), errors);
compareSets('desktop app asset contract table', desktopAppKeys, Object.keys(desktopAppAssetContracts), errors);

const shellCatalogVersion = extractNumberConst(remoteDesktopSource, 'desktopAppCatalogVersion');
const appCatalogVersion = extractNumberConst(appSource, 'remoteDesktopAppCatalogVersion');
const rustCatalogVersion = extractRustNumberConst(vaultNormalizeSource, 'REMOTE_DESKTOP_APP_CATALOG_VERSION');
if (shellCatalogVersion !== appCatalogVersion || shellCatalogVersion !== rustCatalogVersion) {
  errors.push(`remote desktop app catalog versions differ: shell=${shellCatalogVersion}, app=${appCatalogVersion}, rust=${rustCatalogVersion}`);
}

const migrationKeys = extractStringArray(remoteDesktopSource, 'appCatalogMigrationKeys');
compareOrdered('App remoteDesktopAppCatalogMigrationKeys', migrationKeys, extractStringArray(appSource, 'remoteDesktopAppCatalogMigrationKeys'), errors);
compareOrdered('Rust REMOTE_DESKTOP_APP_CATALOG_MIGRATION_KEYS', migrationKeys, extractRustStringArray(vaultNormalizeSource, 'REMOTE_DESKTOP_APP_CATALOG_MIGRATION_KEYS'), errors);
compareSets('migration keys in desktopApps', migrationKeys, migrationKeys.filter((key) => desktopAppKeys.includes(key)), errors);

const defaultDesktopAppKeys = extractStringArray(remoteDesktopSource, 'defaultDesktopAppKeys');
const appDefaultLayoutBlock = extractBlock(appSource, /const defaultRemoteDesktopLayout: ShellDeskRemoteDesktopLayout = \{/, /\n\};/);
const appDefaultLayoutKeys = [...appDefaultLayoutBlock.matchAll(/appKey:\s*'([^']+)'/g)].map((entry) => entry[1]);
compareOrdered('App default remote desktop layout', defaultDesktopAppKeys, appDefaultLayoutKeys, errors);

const zhCNMessageIds = new Set(extractCatalogMessageIds(i18nCatalogSource, 'zhCN'));
const enUSMessageIds = new Set(extractCatalogMessageIds(i18nCatalogSource, 'enUS'));
const lazyComponents = extractLazyComponents(remoteDesktopSource);
const iconSourcePaths = extractIconSourcePaths(remoteDesktopSource);
const remoteDesktopStyleUses = new Set(extractStyleUses(styleIndexSource));
for (const entry of desktopAppEntries) {
  for (const messageId of [entry.labelId, entry.descriptionId]) {
    if (!zhCNMessageIds.has(messageId)) {
      errors.push(`Missing zh-CN i18n message for desktop app ${entry.key}: ${messageId}`);
    }
    if (!enUSMessageIds.has(messageId)) {
      errors.push(`Missing en-US i18n message for desktop app ${entry.key}: ${messageId}`);
    }
  }

  const assetContract = desktopAppAssetContracts[entry.key];
  if (!assetContract) {
    continue;
  }

  const lazyImportPath = lazyComponents.get(assetContract.component);
  const expectedLazyImportPath = `./components/remote-desktop/${assetContract.component}`;
  if (lazyImportPath !== expectedLazyImportPath) {
    errors.push(`Desktop app ${entry.key} must lazy-load ${assetContract.component} from ${expectedLazyImportPath}; actual=${lazyImportPath || '(missing)'}`);
  }

  const componentFile = `src/components/remote-desktop/${assetContract.component}.tsx`;
  if (!workspaceFileExists(componentFile)) {
    errors.push(`Desktop app ${entry.key} component file is missing: ${componentFile}`);
  }

  const iconSourcePath = iconSourcePaths.get(entry.key);
  if (!iconSourcePath) {
    errors.push(`Desktop app ${entry.key} icon source path is missing.`);
  } else if (!workspaceFileExists(path.join('src', iconSourcePath.replace(/^\.\//, '')))) {
    errors.push(`Desktop app ${entry.key} icon file is missing: ${iconSourcePath}`);
  }

  const stylePartial = `src/styles/remote-desktop/_${assetContract.style}.scss`;
  if (!workspaceFileExists(stylePartial)) {
    errors.push(`Desktop app ${entry.key} SCSS partial is missing: ${stylePartial}`);
  }
  if (!remoteDesktopStyleUses.has(assetContract.style)) {
    errors.push(`Desktop app ${entry.key} SCSS partial is not imported by src/styles/index.scss: ${assetContract.style}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n\n'));
  process.exit(1);
}

console.log(`Desktop app contract ok: ${desktopAppKeys.length} app keys are aligned across catalog, rendering, i18n, component files, icons, styles, types, defaults, migrations, and Rust vault normalization.`);
