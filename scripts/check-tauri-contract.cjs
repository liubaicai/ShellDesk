const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertFile(relativePath) {
  assert.ok(fs.existsSync(path.join(root, relativePath)), `${relativePath} must exist`);
}

function assertNoDependency(packageJson, dependencyName) {
  assert.ok(
    !packageJson.dependencies?.[dependencyName] && !packageJson.devDependencies?.[dependencyName],
    `${dependencyName} must not remain in package.json after the Tauri migration`,
  );
}

function assertScript(packageJson, name, expected) {
  assert.equal(packageJson.scripts[name], expected, `package script ${name} must stay aligned`);
}

const packageJson = readJson('package.json');
const tauriConfig = readJson('src-tauri/tauri.conf.json');
const defaultCapability = readJson('src-tauri/capabilities/default.json');
const releaseWorkflow = readText('.github/workflows/release.yml');
const testWorkflow = readText('.github/workflows/test.yml');
const buildWrapper = readText('scripts/run-tauri-build.cjs');
const updaterSource = readText('src-tauri/src/updater.rs');
const versionSyncScript = readText('scripts/set-release-version.cjs');
const tauriMainSource = readText('src-tauri/src/main.rs');

assert.equal(packageJson.name, 'shelldesk');
assert.equal(packageJson.productName, 'ShellDesk');
assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(packageJson.packageManager, 'pnpm@10.26.2');
assert.equal(packageJson.homepage, 'https://github.com/liubaicai/ShellDesk');
assert.equal(packageJson.author, 'liubaicai <liushuai.baicai@hotmail.com>');
assert.equal(packageJson.license, 'GPL-3.0-only');
assert.ok(!Object.hasOwn(packageJson, 'main'), 'Tauri package.json must not expose an Electron main entry');

assertScript(packageJson, 'dev', 'tauri dev');
assertScript(packageJson, 'start', 'tauri dev');
assertScript(packageJson, 'build', 'pnpm typecheck && vite build');
assertScript(packageJson, 'preview', 'vite preview --host 127.0.0.1');
assertScript(packageJson, 'release:dir', 'pnpm pack:dir');
assertScript(packageJson, 'smoke:tauri-dev', 'node scripts/check-tauri-dev-start.cjs');
assertScript(packageJson, 'smoke:ssh-live', 'node scripts/check-live-ssh-smoke.cjs');
assert.equal(packageJson.scripts['check:tauri'], 'node scripts/check-tauri-contract.cjs');
assert.match(packageJson.scripts.test, /pnpm check:tauri/);

for (const scriptName of [
  'release',
  'pack',
  'pack:dir',
  'pack:win',
  'pack:win-x64',
  'pack:win-arm64',
  'pack:mac',
  'pack:linux',
  'pack:linux-x64',
  'pack:linux-arm64',
]) {
  assert.match(packageJson.scripts[scriptName], /^node scripts\/run-tauri-build\.cjs/);
}

assert.match(packageJson.scripts.release, /--target x86_64-pc-windows-msvc/);
assert.match(packageJson.scripts['pack:dir'], /--debug/);
assert.match(packageJson.scripts['pack:win-x64'], /--target x86_64-pc-windows-msvc/);
assert.match(packageJson.scripts['pack:win-arm64'], /--target aarch64-pc-windows-msvc/);
assert.match(packageJson.scripts['pack:mac'], /--bundles dmg,app/);
assert.match(packageJson.scripts['pack:linux-x64'], /--target x86_64-unknown-linux-gnu/);

assert.ok(packageJson.dependencies['@tauri-apps/api']);
assert.ok(packageJson.devDependencies['@tauri-apps/cli']);
for (const dependencyName of [
  'electron',
  'electron-builder',
  'electron-updater',
  'electron-winstaller',
  'concurrently',
  'cross-env',
  'wait-on',
]) {
  assertNoDependency(packageJson, dependencyName);
}

assert.equal(tauriConfig.productName, packageJson.productName);
assert.equal(tauriConfig.version, packageJson.version);
assert.equal(tauriConfig.identifier, 'com.shelldesk.app');
assert.deepEqual(tauriConfig.build, {
  beforeDevCommand: 'pnpm vite --host 127.0.0.1',
  devUrl: 'http://127.0.0.1:5173',
  beforeBuildCommand: 'pnpm vite build',
  frontendDist: '../dist',
});

const [mainWindow] = tauriConfig.app.windows;
assert.equal(mainWindow.title, packageJson.productName);
assert.equal(mainWindow.width, 1260);
assert.equal(mainWindow.height, 820);
assert.equal(mainWindow.minWidth, 960);
assert.equal(mainWindow.minHeight, 640);
assert.equal(mainWindow.backgroundColor, '#0e131c');
assert.equal(mainWindow.decorations, false);
assert.equal(mainWindow.resizable, true);
assert.equal(tauriConfig.app.security.csp, null);
assert.deepEqual(tauriConfig.plugins.updater, {
  endpoints: [],
  pubkey: '',
});

assert.equal(tauriConfig.bundle.active, true);
assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
assert.equal(tauriConfig.bundle.targets, 'all');
assert.equal(tauriConfig.bundle.publisher, 'liubaicai');
assert.equal(tauriConfig.bundle.category, 'DeveloperTool');
assert.equal(tauriConfig.bundle.copyright, packageJson.license);
assert.deepEqual(tauriConfig.bundle.icon, ['icons/icon.png', 'icons/icon.ico']);
assert.deepEqual(tauriConfig.bundle.resources, ['../src/assets/images/icon.png']);
assert.equal(tauriConfig.bundle.windows.nsis.installMode, 'currentUser');
assert.equal(tauriConfig.bundle.macOS.minimumSystemVersion, '10.15');
assertFile('src-tauri/icons/icon.png');
assertFile('src-tauri/icons/icon.ico');
assert.deepEqual(defaultCapability.windows, ['main', 'connection-*']);
assert.ok(defaultCapability.permissions.includes('core:default'));
assert.ok(defaultCapability.permissions.includes('updater:default'));
assert.match(readText('src-tauri/src/app.rs'), /open_connection_window/);
assert.match(readText('src-tauri/src/app.rs'), /background_color\(Color\(14, 19, 28, 255\)\)/);
assert.match(readText('src/tauriBridge.ts'), /app:open-connection-window/);
assert.match(tauriMainSource, /windows_subsystem = "windows"/);
assertFile('src/assets/images/icon.png');
assertFile('scripts/check-tauri-dev-start.cjs');
assertFile('scripts/check-live-ssh-smoke.cjs');

const updaterEndpoint = 'https://github.com/liubaicai/ShellDesk/releases/latest/download/latest.json';
assert.match(buildWrapper, new RegExp(updaterEndpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(buildWrapper, /TAURI_UPDATER_PUBLIC_KEY/);
assert.match(buildWrapper, /createUpdaterArtifacts: false/);
assert.match(buildWrapper, /function pnpmCommand\(\)/);
assert.match(buildWrapper, /pnpm\.cmd/);
assert.match(buildWrapper, /assertBundleArtifactsCreated/);
assert.doesNotMatch(buildWrapper, /npm_execpath/);
assert.match(buildWrapper, /spawnSync\(command, \['tauri', 'build'/);
assert.match(updaterSource, new RegExp(updaterEndpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(updaterSource, /option_env!\("TAURI_UPDATER_PUBLIC_KEY"\)/);
assert.match(updaterSource, /\.updater_builder\(\)/);
assert.match(updaterSource, /\.pubkey\(public_key\)/);
assert.match(updaterSource, /\.endpoints\(vec!\[endpoint\]\)/);

for (const workflow of [testWorkflow, releaseWorkflow]) {
  assert.match(workflow, /uses: pnpm\/action-setup@v6/);
  assert.match(workflow, /version: 10\.26\.2/);
  assert.match(workflow, /uses: actions\/setup-node@v6/);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /uses: dtolnay\/rust-toolchain@stable/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
}

assert.match(testWorkflow, /libwebkit2gtk-4\.1-dev/);
assert.match(testWorkflow, /libayatana-appindicator3-dev/);
assert.match(testWorkflow, /run: pnpm test/);

for (const expected of [
  'pack_script: pack:mac',
  'pack_script: pack:win-x64',
  'pack_script: pack:linux-x64',
  'TAURI_SIGNING_PRIVATE_KEY is required',
  'TAURI_UPDATER_PUBLIC_KEY is required',
  'node scripts/set-release-version.cjs "${VERSION}" --check',
  'node .github/scripts/generate-tauri-updater-manifest.js artifacts artifacts/latest.json',
  'src-tauri/target/*/release/bundle/**/*.exe',
  'if-no-files-found: error',
  'artifacts/**/*.AppImage.tar.gz',
  'artifacts/**/*.sig',
  'artifacts/latest.json',
]) {
  assert.ok(releaseWorkflow.includes(expected), `release workflow must include ${expected}`);
}

for (const unexpected of [
  'name: windows-arm64',
  'pack_script: pack:win-arm64',
  'rust_target: aarch64-pc-windows-msvc',
]) {
  assert.ok(!releaseWorkflow.includes(unexpected), `release workflow must not include ${unexpected}`);
}

assert.ok(
  !/^\s*artifacts\/\*\*\/\*\.tar\.gz\s*$/m.test(releaseWorkflow),
  'release workflow must not upload generic tar.gz patterns that overlap app/AppImage archives',
);
assert.ok(
  !/^\s*artifacts\/latest\.json\s*$/m.test(releaseWorkflow),
  'release workflow must not upload latest.json twice',
);

assert.match(versionSyncScript, /updateJsonVersion\('package\.json'\)/);
assert.match(versionSyncScript, /updateJsonVersion\('src-tauri\/tauri\.conf\.json'\)/);
assert.match(versionSyncScript, /updateCargoTomlVersion\('src-tauri\/Cargo\.toml'\)/);
assert.match(versionSyncScript, /updateCargoLockVersion\('src-tauri\/Cargo\.lock', 'shelldesk'\)/);

console.log('Tauri contract ok: package scripts, Tauri app config, updater, CI, and release workflows match the migration requirements.');
