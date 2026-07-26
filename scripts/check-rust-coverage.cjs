#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const manifestArgs = ['--manifest-path', 'src-tauri/Cargo.toml'];
const version = spawnSync('cargo', ['llvm-cov', '--version'], {
  encoding: 'utf8',
  windowsHide: true,
});

if (version.error) {
  console.error(`Failed to inspect cargo-llvm-cov: ${version.error.message}`);
  process.exit(1);
}
if (version.signal || version.status === null) {
  console.error(`cargo-llvm-cov version check terminated without an exit status${version.signal ? ` (${version.signal})` : ''}.`);
  process.exit(1);
}
if (version.status !== 0) {
  console.error('cargo-llvm-cov is not installed.');
  console.error('Install it with: cargo install cargo-llvm-cov');
  process.exit(version.status);
}

const args = [
  'llvm-cov',
  ...manifestArgs,
  '--workspace',
  '--all-features',
  '--summary-only',
  '--ignore-filename-regex',
  String.raw`(_tests[.]rs$|_test[.]rs$|test_helpers[.]rs$|[/\\]tests[/\\]|[/\\]tests[.]rs$)`,
  '--fail-under-functions',
  '36',
  '--fail-under-lines',
  '39',
  '--fail-under-regions',
  '37',
];
const result = spawnSync('cargo', args, {
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`Failed to run cargo-llvm-cov: ${result.error.message}`);
  process.exit(1);
}
if (result.signal || result.status === null) {
  console.error(`cargo-llvm-cov terminated without an exit status${result.signal ? ` (${result.signal})` : ''}.`);
  process.exit(1);
}

process.exit(result.status);
