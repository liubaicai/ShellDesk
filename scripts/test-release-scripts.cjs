const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shelldesk-release-scripts-'));
const artifactsDir = path.join(tempRoot, 'artifacts');
const manifestPath = path.join(tempRoot, 'latest.json');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function runNode(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed: node ${args.join(' ')}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

try {
  write(path.join(artifactsDir, 'windows', 'ShellDesk_1.2.3_x64-setup.exe'), 'windows');
  write(path.join(artifactsDir, 'windows', 'ShellDesk_1.2.3_x64-setup.exe.sig'), 'windows-signature');
  write(path.join(artifactsDir, 'macos', 'ShellDesk_1.2.3_aarch64.app.tar.gz'), 'macos');
  write(path.join(artifactsDir, 'macos', 'ShellDesk_1.2.3_aarch64.app.tar.gz.sig'), 'macos-signature');
  write(path.join(artifactsDir, 'linux', 'ShellDesk_1.2.3_x86_64.AppImage'), 'linux');
  write(path.join(artifactsDir, 'linux', 'ShellDesk_1.2.3_x86_64.AppImage.sig'), 'linux-signature');
  write(path.join(artifactsDir, 'linux-legacy', 'ShellDesk_1.2.3_x86_64.AppImage.tar.gz'), 'linux-legacy');
  write(path.join(artifactsDir, 'linux-legacy', 'ShellDesk_1.2.3_x86_64.AppImage.tar.gz.sig'), 'linux-legacy-signature');
  write(path.join(artifactsDir, 'latest.yml'), 'ignored');

  runNode([
    '.github/scripts/generate-tauri-updater-manifest.js',
    artifactsDir,
    manifestPath,
  ], {
    GITHUB_REF_NAME: 'v1.2.3',
    GITHUB_REPOSITORY: 'liubaicai/ShellDesk',
    RELEASE_PUBLISHED_AT: '2026-06-18T00:00:00Z',
  });

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.version, '1.2.3');
  assert.equal(manifest.pub_date, '2026-06-18T00:00:00Z');
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'windows-signature');
  assert.equal(manifest.platforms['darwin-aarch64'].signature, 'macos-signature');
  assert.equal(manifest.platforms['linux-x86_64'].signature, 'linux-signature');
  assert.match(manifest.platforms['windows-x86_64'].url, /ShellDesk_1\.2\.3_x64-setup\.exe$/);
  assert.match(manifest.platforms['darwin-aarch64'].url, /ShellDesk_1\.2\.3_aarch64\.app\.tar\.gz$/);
  assert.match(manifest.platforms['linux-x86_64'].url, /ShellDesk_1\.2\.3_x86_64\.AppImage$/);
  assert.ok(!manifest.platforms['windows-aarch64']);
  assert.ok(!manifest.platforms['linux-aarch64']);

  runNode(['.github/scripts/generate-release-note.js', artifactsDir], {
    GITHUB_REF_NAME: 'v1.2.3',
    GITHUB_REPOSITORY: 'liubaicai/ShellDesk',
  });

  const releaseNotes = fs.readFileSync(path.join(repoRoot, 'release_notes.md'), 'utf8');
  assert.match(releaseNotes, /\*\*Windows\*\*/);
  assert.match(releaseNotes, /\*\*macOS\*\*/);
  assert.match(releaseNotes, /\*\*Linux\*\*/);
  assert.match(releaseNotes, /ShellDesk_1\.2\.3_x64-setup\.exe/);
  assert.match(releaseNotes, /ShellDesk_1\.2\.3_aarch64\.app\.tar\.gz/);
  assert.match(releaseNotes, /ShellDesk_1\.2\.3_x86_64\.AppImage\.tar\.gz/);
  assert.match(releaseNotes, /ShellDesk_1\.2\.3_x86_64\.AppImage/);
  assert.doesNotMatch(releaseNotes, /ShellDesk_1\.2\.3_arm64-setup\.exe/);
  assert.doesNotMatch(releaseNotes, /\.sig/);
  assert.doesNotMatch(releaseNotes, /latest\.yml/);
  assert.doesNotMatch(releaseNotes, /\*\*Other\*\*/);
  fs.rmSync(path.join(repoRoot, 'release_notes.md'), { force: true });

  const releaseWorkflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
  assert.match(releaseWorkflow, /artifacts\/\*\*\/\*\.exe/);
  assert.match(releaseWorkflow, /artifacts\/\*\*\/\*\.app\.tar\.gz/);
  assert.match(releaseWorkflow, /artifacts\/\*\*\/\*\.AppImage\.tar\.gz/);
  assert.match(releaseWorkflow, /artifacts\/\*\*\/\*\.AppImage/);
  assert.match(releaseWorkflow, /artifacts\/\*\*\/\*\.json/);
  assert.match(releaseWorkflow, /src-tauri\/target\/\*\/release\/bundle\/\*\*\/\*\.exe/);
  assert.match(releaseWorkflow, /if-no-files-found: error/);
  assert.doesNotMatch(releaseWorkflow, /^\s*artifacts\/\*\*\/\*\.tar\.gz\s*$/m);
  assert.doesNotMatch(releaseWorkflow, /^\s*artifacts\/\*\*\/\*\.app\.tar\.gz\.sig\s*$/m);
  assert.doesNotMatch(releaseWorkflow, /^\s*artifacts\/latest\.json\s*$/m);
  assert.doesNotMatch(releaseWorkflow, /name: windows-arm64/);
  assert.doesNotMatch(releaseWorkflow, /pack_script: pack:win-arm64/);
  assert.doesNotMatch(releaseWorkflow, /rust_target: aarch64-pc-windows-msvc/);
  assert.match(releaseWorkflow, /TAURI_SIGNING_PRIVATE_KEY is required/);
  assert.match(releaseWorkflow, /TAURI_UPDATER_PUBLIC_KEY is required/);
  assert.match(releaseWorkflow, /TAURI_UPDATER_PUBLIC_KEY: \$\{\{ secrets\.TAURI_UPDATER_PUBLIC_KEY \}\}/);

  const tauriConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const scriptName of ['release', 'pack', 'pack:dir', 'pack:win', 'pack:win-x64', 'pack:win-arm64', 'pack:mac', 'pack:linux', 'pack:linux-x64', 'pack:linux-arm64']) {
    assert.match(packageJson.scripts[scriptName], /node scripts\/run-tauri-build\.cjs/);
  }

  const buildWrapper = fs.readFileSync(path.join(repoRoot, 'scripts/run-tauri-build.cjs'), 'utf8');
  assert.match(buildWrapper, /TAURI_UPDATER_PUBLIC_KEY/);
  assert.match(buildWrapper, /createUpdaterArtifacts: false/);
  assert.match(buildWrapper, /releases\/latest\/download\/latest\.json/);
  assert.match(buildWrapper, /function pnpmCommand\(\)/);
  assert.match(buildWrapper, /pnpm\.cmd/);
  assert.match(buildWrapper, /assertBundleArtifactsCreated/);
  assert.doesNotMatch(buildWrapper, /npm_execpath/);
  assert.match(buildWrapper, /spawnSync\(command, \['tauri', 'build'/);

  const debugBuild = JSON.parse(runNode(['scripts/run-tauri-build.cjs', '--debug'], {
    SHELLDESK_TAURI_BUILD_DRY_RUN: '1',
    TAURI_UPDATER_PUBLIC_KEY: '',
    npm_execpath: 'C:\\broken\\pnpm.cjs',
  }).stdout);
  assert.deepEqual(debugBuild.config, { bundle: { createUpdaterArtifacts: false } });
  assert.ok(debugBuild.args.includes('--debug'));
  assert.equal(debugBuild.command, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');

  const signedBuild = JSON.parse(runNode(['scripts/run-tauri-build.cjs', '--target', 'x86_64-pc-windows-msvc'], {
    SHELLDESK_TAURI_BUILD_DRY_RUN: '1',
    TAURI_UPDATER_PUBLIC_KEY: 'public-key-content',
    npm_execpath: 'C:\\broken\\pnpm.cjs',
  }).stdout);
  assert.equal(signedBuild.config.plugins.updater.pubkey, 'public-key-content');
  assert.deepEqual(signedBuild.config.plugins.updater.endpoints, [
    'https://github.com/liubaicai/ShellDesk/releases/latest/download/latest.json',
  ]);
  assert.ok(signedBuild.args.includes('x86_64-pc-windows-msvc'));
  assert.equal(signedBuild.command, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');

  const updaterSource = fs.readFileSync(path.join(repoRoot, 'src-tauri/src/updater.rs'), 'utf8');
  assert.match(updaterSource, /const TAURI_UPDATER_ENDPOINT: &str =\s*"https:\/\/github\.com\/liubaicai\/ShellDesk\/releases\/latest\/download\/latest\.json"/);
  assert.match(updaterSource, /option_env!\("TAURI_UPDATER_PUBLIC_KEY"\)/);
  assert.match(updaterSource, /std::env::var\("TAURI_UPDATER_PUBLIC_KEY"\)/);
  assert.match(updaterSource, /\.updater_builder\(\)/);
  assert.match(updaterSource, /\.pubkey\(public_key\)/);
  assert.match(updaterSource, /\.endpoints\(vec!\[endpoint\]\)/);

  console.log('Release script tests passed.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
