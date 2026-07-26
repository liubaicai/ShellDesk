# Testing

ShellDesk uses layered tests so connection, backend, and UI regressions can be caught without requiring a real SSH host for every check.

## Default Gate

```bash
pnpm test
```

The default gate runs:

- IPC, desktop app, i18n, runtime-boundary, Tauri, default-settings, and release-script contract checks.
- `pnpm check:unit` for browser-free TypeScript unit tests.
- `pnpm build` for TypeScript and Vite production bundle verification.
- `pnpm check:ui` for mocked Playwright UI smoke tests.
- `pnpm check:rust` for Rust fmt, clippy with `-D warnings`, and Rust tests.
- `cargo check --manifest-path src-tauri/Cargo.toml`.

Run only the fast repository contract checks with:

```bash
pnpm check:contracts
```

## Unit Tests

```bash
pnpm check:unit
```

The unit gate first type-checks `tests/unit` with `tsconfig.unit.json`, then uses `playwright.unit.config.ts` to run the specs under Playwright's Node test runner. It does not launch a browser, start Vite, or require the Chromium bundle. These tests are intended for pure parsers, serializers, model helpers, and other frontend logic without rendered UI dependencies.

`tests/unit/database-import-utils.spec.ts` locks the current CSV and JSON import behavior, including quoted CSV fields, heterogeneous JSON rows, preview normalization, localized validation errors, and CSV header normalization. Empty headers are ignored, later duplicate headers are discarded, and retained columns continue to read from their original source indexes.

`tests/unit/database-import-draft.spec.ts` covers the shared MySQL/PostgreSQL/ClickHouse import-draft state transitions: fresh reset state, independent CSV/JSON drafts, case-insensitive JSON file-extension selection, transient status clearing, and preservation of execution errors while preview data is applied or cleared.

## Build Verification

```bash
pnpm build
```

The build runs `pnpm typecheck` followed by the Vite production build. It verifies TypeScript and bundling compatibility, but it does not replace `pnpm check:unit` for behavior assertions or `pnpm check:ui` for rendered interaction coverage.

## UI Smoke Tests

```bash
pnpm check:ui
```

`?shelldeskTheme=light|dark|system` is a bootstrap and test-harness override.
In the desktop application, persisted vault settings intentionally become the
runtime theme authority after hydration.

The UI gate first type-checks `tests/ui` with `tsconfig.ui.json`. Playwright then
serves `tests/ui/database-error-harness.html` through Vite and renders real React
remote-desktop components with a mocked `window.guiSSH` bridge. The first
covered flows are:

- MySQL create-table backend failure stays visible inside the create-table modal.
- Redis destructive action failure stays visible inside the confirmation modal.

These tests assert both DOM placement and z-index safety by checking that the alert is inside the active dialog and that `document.elementFromPoint()` at the alert center resolves back to the alert.

Install the browser once on fresh machines or CI workers:

```bash
pnpm exec playwright install chromium
```

## Rust Checks

```bash
pnpm check:rust
```

This runs:

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`

Rust tests include shared fixtures from `src-tauri/src/test_helpers.rs`, async database tunnel contract coverage, IPC database channel classification, and HTTP tunnel parameter/timeout validation.

## Coverage

```bash
cargo install cargo-llvm-cov
pnpm check:rust:coverage
```

CI installs `cargo-llvm-cov` and runs the coverage gate after the default test
gate. The command excludes standalone test files (`tests/`, `tests.rs`,
`*_test.rs`, `*_tests.rs`, and `test_helpers.rs`) and fails when production
coverage drops below 37% regions, 36% functions, or 39% lines. Tests that still
live in an inline `mod tests` share a production source file and therefore
cannot be excluded by filename; migrate them to adjacent `*_tests.rs` files
when touching those modules. The local command fails with an install hint if
`cargo-llvm-cov` is missing.

## Optional Live Smoke

```bash
pnpm smoke:ssh-live
```

The live SSH/SFTP smoke reads local `.env` or matching process environment variables:

- `SHELLDESK_TEST_SSH_HOST`
- `SHELLDESK_TEST_SSH_PORT`
- `SHELLDESK_TEST_SSH_USERNAME`
- `SHELLDESK_TEST_SSH_PASSWORD`
- `SHELLDESK_TEST_SSH_KEY_PATH`
- `SHELLDESK_TEST_SSH_KNOWN_HOSTS_PATH`

Provide either `SHELLDESK_TEST_SSH_PASSWORD` or `SHELLDESK_TEST_SSH_KEY_PATH`. `SHELLDESK_TEST_SSH_KNOWN_HOSTS_PATH` must point to an existing known-hosts file used to verify the test server. Do not commit real credentials. The smoke is intentionally separate from `pnpm test` because it requires an external server.
