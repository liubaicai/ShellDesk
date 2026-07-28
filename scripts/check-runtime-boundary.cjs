const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const removedRuntimePackages = [
  'concurrently',
  'cross-env',
  'electron',
  'electron-builder',
  'electron-updater',
  'electron-winstaller',
  'ioredis',
  'mongodb',
  'mysql2',
  'node-pty',
  'pg',
  'ssh2',
  'wait-on',
  'ws',
];

const forbiddenSourcePatterns = [
  { pattern: /\bipcRenderer\b/, label: 'Electron ipcRenderer' },
  { pattern: /\bipcMain\b/, label: 'Electron ipcMain' },
  { pattern: /\bBrowserWindow\b/, label: 'Electron BrowserWindow' },
  { pattern: /\bcontextBridge\b/, label: 'Electron contextBridge' },
  { pattern: /from\s+['"]electron['"]/, label: 'Electron import' },
  { pattern: /require\(\s*['"]electron['"]\s*\)/, label: 'Electron require' },
  { pattern: /<webview\b/i, label: 'Electron webview element' },
  { pattern: /\bBrowserWebview\b/, label: 'Electron BrowserWebview wrapper' },
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function listFiles(directory, predicate, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listFiles(fullPath, predicate, base);
    }
    if (!entry.isFile()) {
      return [];
    }
    const relativePath = path.relative(base, fullPath).replace(/\\/g, '/');
    return predicate(relativePath) ? [fullPath] : [];
  });
}

function assertNoRemovedPackages(packageJson) {
  const sections = [
    ['dependencies', packageJson.dependencies || {}],
    ['devDependencies', packageJson.devDependencies || {}],
    ['optionalDependencies', packageJson.optionalDependencies || {}],
  ];
  return sections.flatMap(([section, dependencies]) => (
    removedRuntimePackages
      .filter((packageName) => Object.prototype.hasOwnProperty.call(dependencies, packageName))
      .map((packageName) => `package.json ${section}.${packageName}`)
  ));
}

function findForbiddenSourceUses() {
  const sourceRoot = path.join(root, 'src');
  return listFiles(sourceRoot, (relativePath) => /\.(ts|tsx)$/.test(relativePath))
    .filter((filePath) => path.basename(filePath) !== 'tauriBridge.ts')
    .flatMap((filePath) => {
      const source = fs.readFileSync(filePath, 'utf8');
      const lines = source.split(/\r?\n/);
      return lines.flatMap((line, index) => (
        forbiddenSourcePatterns
          .filter(({ pattern }) => pattern.test(line))
          .map(({ label }) => `${path.relative(root, filePath).replace(/\\/g, '/')}:${index + 1}: ${label}: ${line.trim()}`)
      ));
    });
}

const packageJson = readJson('package.json');
const workspaceYaml = readText('pnpm-workspace.yaml');
const bridgeSource = readText('src/tauriBridge.ts');
const indexHtml = readText('index.html');
const failures = [];

if (Object.hasOwn(packageJson, 'main')) {
  failures.push('package.json must not expose an Electron main entry.');
}

failures.push(...assertNoRemovedPackages(packageJson));

for (const packageName of removedRuntimePackages) {
  const packagePattern = new RegExp(`^\\s*-\\s*['"]?${packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm');
  if (packagePattern.test(workspaceYaml)) {
    failures.push(`pnpm-workspace.yaml onlyBuiltDependencies ${packageName}`);
  }
}

failures.push(...findForbiddenSourceUses());

if (!/invoke<.*>\('ipc_dispatch'/.test(bridgeSource)) {
  failures.push('src/tauriBridge.ts must be the renderer IPC boundary and call ipc_dispatch.');
}

if (!indexHtml.includes("script-src 'self' 'wasm-unsafe-eval'")) {
  failures.push('index.html must allow WebAssembly compilation without enabling general unsafe-eval.');
}

if (indexHtml.includes("script-src 'self' 'unsafe-eval'")) {
  failures.push('index.html must not enable general unsafe-eval.');
}

if (failures.length) {
  console.error([
    'Runtime boundary check failed: Electron/Node backend runtime code must not leak into the Tauri app surface.',
    ...failures.map((failure) => `  - ${failure}`),
  ].join('\n'));
  process.exit(1);
}

console.log('Runtime boundary ok: Electron runtime APIs and removed Node backend packages are absent from the Tauri app surface.');
