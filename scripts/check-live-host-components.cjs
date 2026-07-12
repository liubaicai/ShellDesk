const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dotenvPath = path.join(root, '.env');
const requiredKeys = ['SHELLDESK_TEST_SSH_HOST', 'SHELLDESK_TEST_SSH_USERNAME'];

function parseDotenv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    values[key] = value;
  }
  return values;
}

const values = fs.existsSync(dotenvPath)
  ? parseDotenv(fs.readFileSync(dotenvPath, 'utf8'))
  : {};
const missing = requiredKeys.filter((key) => !values[key] || values[key] === 'change-me');
const hasPassword = Boolean(values.SHELLDESK_TEST_SSH_PASSWORD && values.SHELLDESK_TEST_SSH_PASSWORD !== 'change-me');
const hasKey = Boolean(values.SHELLDESK_TEST_SSH_KEY_PATH && values.SHELLDESK_TEST_SSH_KEY_PATH !== 'change-me');
if (!hasPassword && !hasKey) missing.push('SHELLDESK_TEST_SSH_PASSWORD or SHELLDESK_TEST_SSH_KEY_PATH');
if (missing.length) {
  console.error(`Live host smoke requires .env values: ${missing.join(', ')}`);
  process.exit(1);
}

const password = values.SHELLDESK_TEST_SSH_PASSWORD;
const keyPath = values.SHELLDESK_TEST_SSH_KEY_PATH;
const resultPrefix = '__SHELLDESK_SMOKE_RESULT__|';
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const result = spawnSync(cargo, [
  'test',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  'live_host_components_smoke',
  '--',
  '--nocapture',
], {
  cwd: root,
  env: {
    ...process.env,
    SHELLDESK_RUN_LIVE_HOST_COMPONENTS: '1',
  },
  encoding: 'utf8',
  stdio: 'pipe',
});

function redact(text) {
  let result = text;
  if (password) result = result.replaceAll(password, '[redacted]');
  if (keyPath) result = result.replaceAll(keyPath, '[key-path]');
  return result;
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function printStructuredResults(text) {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith(resultPrefix))
    .map((line) => line.slice(resultPrefix.length).split('|', 3));

  if (!rows.length) return 0;
  console.log('Host component smoke results:');
  for (const [name, status, detail = ''] of rows) {
    const suffix = detail ? ` — ${detail}` : '';
    if (status === 'ok') {
      console.log(color(32, `  ✓ ${name}${suffix}`));
    } else if (status === 'skip') {
      console.log(color(33, `  - ${name} (skipped)${suffix}`));
    } else {
      console.log(color(31, `  ✗ ${name}${suffix}`));
    }
  }
  return rows.length;
}

const stdout = redact(result.stdout ?? '');
const stderr = redact(result.stderr ?? '');
const structuredCount = printStructuredResults(stdout);
if (result.status !== 0) {
  console.error(color(31, 'Host component smoke failed.'));
  const diagnostics = [stdout, stderr]
    .filter(Boolean)
    .map((text) => text.split(/\r?\n/).filter((line) => !line.startsWith(resultPrefix)).join('\n'))
    .filter(Boolean)
    .join('\n');
  if (diagnostics) console.error(color(31, diagnostics));
  process.exit(result.status ?? 1);
}
if (!structuredCount) {
  console.error(color(31, 'Host component smoke returned no structured results.'));
  process.exit(1);
}

console.log(color(32, 'Host component smoke passed.'));
