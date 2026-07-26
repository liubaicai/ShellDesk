const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dotenvPath = path.join(root, '.env');

function parseDotenv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readLiveSshEnv() {
  const dotenvValues = fs.existsSync(dotenvPath)
    ? parseDotenv(fs.readFileSync(dotenvPath, 'utf8'))
    : {};

  const keys = [
    'SHELLDESK_TEST_SSH_HOST',
    'SHELLDESK_TEST_SSH_PORT',
    'SHELLDESK_TEST_SSH_USERNAME',
    'SHELLDESK_TEST_SSH_PASSWORD',
    'SHELLDESK_TEST_SSH_KEY_PATH',
    'SHELLDESK_TEST_SSH_KNOWN_HOSTS_PATH',
  ];

  const env = {};
  for (const key of keys) {
    const value = process.env[key] ?? dotenvValues[key] ?? '';
    env[key] = value.trim();
  }
  return env;
}

function meaningful(value) {
  return value && value !== 'change-me';
}

const liveEnv = readLiveSshEnv();
const missing = [];
if (!meaningful(liveEnv.SHELLDESK_TEST_SSH_HOST)) missing.push('SHELLDESK_TEST_SSH_HOST');
if (!meaningful(liveEnv.SHELLDESK_TEST_SSH_USERNAME)) missing.push('SHELLDESK_TEST_SSH_USERNAME');
if (
  !meaningful(liveEnv.SHELLDESK_TEST_SSH_KNOWN_HOSTS_PATH)
  || !fs.existsSync(liveEnv.SHELLDESK_TEST_SSH_KNOWN_HOSTS_PATH)
) {
  missing.push('SHELLDESK_TEST_SSH_KNOWN_HOSTS_PATH');
}
if (!meaningful(liveEnv.SHELLDESK_TEST_SSH_PASSWORD) && !meaningful(liveEnv.SHELLDESK_TEST_SSH_KEY_PATH)) {
  missing.push('SHELLDESK_TEST_SSH_PASSWORD or SHELLDESK_TEST_SSH_KEY_PATH');
}

if (missing.length) {
  console.error([
    'Live SSH/SFTP smoke requires root .env values or matching process environment variables.',
    `Missing: ${missing.join(', ')}`,
    'Password values are never printed.',
  ].join('\n'));
  process.exit(1);
}

const command = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

function runCargo(args) {
  return spawnSync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...liveEnv,
      SHELLDESK_REQUIRE_LIVE_SSH_SMOKE: '1',
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function redactOutput(text) {
  let next = text;
  if (liveEnv.SHELLDESK_TEST_SSH_PASSWORD) {
    next = next.replaceAll(liveEnv.SHELLDESK_TEST_SSH_PASSWORD, '[redacted]');
  }
  if (liveEnv.SHELLDESK_TEST_SSH_KEY_PATH) {
    next = next.replaceAll(liveEnv.SHELLDESK_TEST_SSH_KEY_PATH, '[key-path]');
  }
  return next;
}

const buildResult = runCargo(['build', '--manifest-path', 'src-tauri/Cargo.toml']);
if (buildResult.stdout) process.stdout.write(redactOutput(buildResult.stdout));
if (buildResult.stderr) process.stderr.write(redactOutput(buildResult.stderr));
if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

const result = runCargo([
  'test',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  'live_ssh_backend_smoke_uses_env_credentials_when_available',
  '--',
  '--nocapture',
]);

if (result.stdout) process.stdout.write(redactOutput(result.stdout));
if (result.stderr) process.stderr.write(redactOutput(result.stderr));

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('Live SSH/SFTP smoke passed.');
