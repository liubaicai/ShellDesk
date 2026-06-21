<p align="center">
  <img src="src/assets/images/icon.png" alt="ShellDesk" width="128" height="128">
</p>

<h1 align="center">ShellDesk</h1>

<p align="center">
  <strong>A virtual remote desktop and graphical server management toolkit</strong>
</p>

<p align="center">
  ShellDesk is built with Tauri 2, Rust, React 19, TypeScript, and xterm.js.<br/>
  It brings SSH and local host management, key management, terminals, SFTP, remote editing, browser and VNC access, databases, WebDAV sync, and operations tools into one desktop-style workspace.
</p>

<p align="center">
  <a href="https://github.com/liubaicai/ShellDesk/releases/latest"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/liubaicai/ShellDesk?style=for-the-badge&logo=github&label=Release&color=success"></a>
  &nbsp;
  <img alt="Platform" src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=for-the-badge&logo=tauri">
  &nbsp;
  <img alt="License" src="https://img.shields.io/badge/License-GPL--3.0-green?style=for-the-badge">
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/images/screenshot-en1.png" alt="ShellDesk English interface screenshot" width="920">
</p>
<p align="center">
  <img src="docs/images/screenshot-en2.png" alt="ShellDesk English interface screenshot" width="920">
</p>

---

## Table of Contents

- [Table of Contents](#table-of-contents)
- [Purpose](#purpose)
- [Feature Overview](#feature-overview)
  - [Hosts and Credentials](#hosts-and-credentials)
  - [Connection Desktop](#connection-desktop)
  - [Terminal, Files, and Editing](#terminal-files-and-editing)
  - [Databases and System Tools](#databases-and-system-tools)
  - [App Settings, Logs, Backup, and Language](#app-settings-logs-backup-and-language)
- [Data and Security](#data-and-security)
- [Compatibility Notes](#compatibility-notes)
- [Quick Start](#quick-start)
  - [Requirements](#requirements)
  - [Install Dependencies](#install-dependencies)
  - [Start Development Mode](#start-development-mode)
- [Scripts](#scripts)
- [Project Structure](#project-structure)
- [Development Notes](#development-notes)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## Purpose

ShellDesk is designed for developers, operations engineers, and anyone who maintains multiple servers over time. It is not just a terminal replacement; it is a desktop-style workspace centered on an SSH or local connection. After connecting, you can open terminals, file management, databases, VNC, private-network browser access, system monitoring, logs, service management, network diagnostics, security auditing, and more in one window.

ShellDesk is useful for:

- Maintaining an SSH host library with groups, tags, notes, system type detection, and authentication settings
- Opening the same workspace against the local machine when you need local-mode tools without creating an SSH loopback host
- Opening multiple remote tools side by side inside one connection window instead of switching between terminal, SFTP, database, and browser clients
- Handling common server operations through a graphical interface while keeping a full terminal available as the fallback
- Storing hosts, keys, app settings, bookmarks, and logs in a local vault, with import/export and WebDAV sync for backup and migration

---

## Feature Overview

### Hosts and Credentials

- Create, edit, delete, search, group, tag, annotate, and detect system types for SSH hosts
- Supports password login, private-key login, proxy/jump-host settings, local mode, and credential prompts before connecting
- Quick connect parses inputs such as `ssh user@example.com -p 2222`
- The Keys page can import key pairs, generate RSA keys, copy public keys, and search by name, algorithm, or fingerprint
- Settings control whether SSH passwords and key passphrases are saved by default, and known-hosts trust decisions are handled by the Rust backend

### Connection Desktop

- Each SSH or local connection opens in an independent connection window with the current host and local SOCKS port in the title bar when available
- Built-in SOCKS proxy, Tauri-backed browser proxy, and noVNC viewer cover remote web and desktop access
- Remote desktop windows support drag, resize, maximize, minimize, z-order management, and a Dock
- File Manager, Terminal, and Browser are pinned to the Dock; other apps join the Dock dynamically while open
- Desktop icons support custom layout, folders, sorting modes, and custom wallpaper

### Terminal, Files, and Editing

- xterm.js terminal supports multiple sessions, title synchronization, scrollback, copy/paste, and theme presets
- Terminal font family, size, weight, ligatures, line height, cursor, scrolling behavior, and contrast are configurable
- Font selection reads the local system font list instead of bundling font files
- SFTP file manager supports browsing, upload, download, transfer cancellation, create, delete, rename, compress, extract, permission edits, protected-write fallbacks, and copy path
- Remote Notepad supports tabs, remote read/write, find, go to line, syntax highlighting, language modes, and unsaved-change prompts
- Notepad uses a binary extension blacklist to avoid opening images, archives, databases, executables, and other binary files by mistake

### Databases and System Tools

- MySQL, PostgreSQL, ClickHouse, MongoDB, Redis, and SQLite tools cover connection, browsing, querying, and common editing actions where the backend supports them
- Database access uses Rust-side SSH tunnels with request timeouts, cleanup for orphaned tunnels, bounded result previews, and sensitive-value redaction in diagnostic paths
- Elasticsearch / OpenSearch panel shows cluster health, indices, shards, and basic `_search` results
- RabbitMQ / Kafka panel shows queues, topics, consumer group lag, and raw diagnostic output
- System Monitor, Process Manager, Service Manager, Container Manager, Port Listener, and Disk Analyzer help with daily checks
- Disk Manager shows physical disks, partitions, and mounts, with mount/unmount, format, partition maintenance, and Linux LVM configuration
- Git Repository Manager shows remote branch trees, remote branches, changed files, diffs, recent commits, branch create/delete/track, stage/unstage, commit, fetch, pull, push, and checkout
- Web Server Manager covers Nginx, Apache/httpd, and Caddy config discovery, Notepad handoff for config edits, config test, reload, and restart flows
- MinIO / S3 Browser uses remote `mc` or `aws` CLI to browse buckets, prefixes, objects, delete objects, copy object URLs, and download to a remote directory
- Firewall, iptables, Network Diagnostics, Package Manager, Scheduled Tasks, Certificate Manager, Login Sessions, and Security Audit support operations troubleshooting
- System Settings provides views for system information, network interfaces, DNS, mirrors, updates, Hosts, routes, disks, and mounts
- Log Viewer supports journalctl, `/var/log`, Windows Event Log, and related sources
- API Debugger sends HTTP requests from the remote host, which is useful for validating private-network services

### App Settings, Logs, Backup, and Language

- Supports dark, light, and system themes
- Supports accent color, system fonts, default host view, desktop wallpaper, and remote desktop layout
- UI language supports English and Simplified Chinese; first launch follows the system language
- Logs record connection, host, key, config, and system operations with search, filters, and clearing
- Config import/export covers hosts, keys, settings, and browser bookmarks
- WebDAV sync can back up and restore the local vault across machines, and the updater checks GitHub releases through Tauri's update flow

---

## Data and Security

ShellDesk stores local data in the Tauri app data directory. The Settings page shows the config path and vault path.

- Hosts, keys, app settings, and browser bookmarks are stored in the local vault
- Sensitive data is encrypted with system credentials when platform support is available
- When system encryption is unavailable, the vault falls back to local file-permission protection
- Logs are stored separately in the user data directory
- Exported config JSON may include hosts, passwords, private keys, and key passphrases, so it should only be stored in trusted locations
- The React renderer accesses controlled backend APIs through the `window.guiSSH` Tauri bridge
- Native dialog limitations around `prompt`, `confirm`, and `alert` are handled with custom modals

---

## Compatibility Notes

This table tracks the planned compatibility matrix for ShellDesk remote system tools. The status and notes columns are intentionally blank for now; after an environment is tested, put `✓` in the second column and add notes as needed.

✅ Supported
ℹ️ Untested
⚠️ Limited support
❌ Unsupported

| Distribution / environment | Status | Notes |
| :--- | :---: | :--- |
| Ubuntu 26.04 LTS |  |  |
| Ubuntu 24.04 LTS | ✅ | [Report](docs/system-compatibility-reports/ubuntu2404.md) |
| Ubuntu 22.04 LTS |  |  |
| Ubuntu 20.04 LTS |  |  |
| Debian 13 Trixie |  |  |
| Debian 12 Bookworm | ✅ | [Report](docs/system-compatibility-reports/debian12.md) |
| Debian 11 Bullseye | ✅ | [Report](docs/system-compatibility-reports/debian11.md) |
| RHEL 10 |  |  |
| RHEL 9 | ✅ | [Report](docs/system-compatibility-reports/rhel9.md) |
| RHEL 8 |  |  |
| CentOS 7 | ⚠️ | [Report](docs/system-compatibility-reports/centos7.md) |
| Fedora Server 41 |  |  |
| Fedora Workstation 41 |  |  |
| openSUSE Leap 15.6 |  |  |
| Alibaba Cloud Linux 3 |  |  |
| TencentOS Server 4 |  |  |
| openEuler 24.03 LTS | ✅ | [Report](docs/system-compatibility-reports/openeuler2403.md) |
| Kylin Server V10 |  |  |
| UOS Server 20 |  |  |
| Linux Mint 22 |  |  |
| Arch Linux |  |  |
| Manjaro |  |  |
| Pop!_OS |  |  |
| Kali Linux |  |  |
| Raspberry Pi OS 12 Bookworm |  |  |
| Alpine Linux 3.23 | ⚠️ | [Report](docs/system-compatibility-reports/alpine323.md) |
| Windows Server 2022 |  |  |
| Windows Server 2019 |  |  |
| Windows Server 2016 |  |  |
| Windows 11 | ✅ | [Report](docs/system-compatibility-reports/windows11.md) |
| Windows 10 | ✅ | [Report](docs/system-compatibility-reports/windows10.md) |

---

## Quick Start

### Requirements

- Node.js 20 or later
- pnpm 11 or later; this repository currently pins `pnpm@11.8.0`
- Rust stable and the Tauri 2 platform prerequisites for desktop development and packaging
- Windows 10 or later, macOS, or Linux. Platform packaging requires the matching system toolchain.

### Install Dependencies

```bash
pnpm install
```

`pnpm install` runs `prepare`, which configures the local Git hooks from `.githooks`. If hooks are ever missing, run `pnpm hooks:install` manually.

### Start Development Mode

```bash
pnpm dev
```

Development mode starts Vite through Tauri:

- Vite listens on `127.0.0.1:5173` by default
- Tauri waits for Vite before opening the app window

If Vite remains on port `5173` after exit, stop only the PID occupying that port:

```powershell
netstat -ano | findstr :5173
Stop-Process -Id <PID>
```

---

## Scripts

| Command | Description |
| :--- | :--- |
| `pnpm dev` | Starts the Tauri development window with Vite |
| `pnpm typecheck` | Runs TypeScript type checking |
| `pnpm build` | Runs `tsc --noEmit` and then the Vite production build |
| `pnpm test` | Runs IPC checks, release-script checks, frontend build, Rust fmt/test, and `cargo check` |
| `pnpm check:ipc` | Checks parity between the Rust IPC dispatcher, bridge, and type surface |
| `pnpm check:desktop-apps` | Checks remote desktop app catalog and layout contract coverage |
| `pnpm check:i18n` | Checks translation key coverage |
| `pnpm check:runtime-boundary` | Checks frontend/runtime boundary assumptions |
| `pnpm check:tauri` | Checks Tauri config, package metadata, updater wiring, and contract consistency |
| `pnpm check:release` | Checks release scripts and workflow expectations |
| `pnpm check:rust` | Runs Rust format checks and tests |
| `pnpm smoke:tauri-dev` | Runs a Tauri development smoke test |
| `pnpm smoke:ssh-live` | Runs the live SSH smoke test when local test credentials are configured |
| `pnpm start` | Starts the Tauri development window |
| `pnpm preview` | Previews the Vite frontend build without Tauri backend capabilities |
| `pnpm hooks:install` | Configures local Git hooks from `.githooks` |
| `pnpm tag` | Creates and pushes a `v<package.json version>` Git tag |
| `pnpm version:sync` | Synchronizes version metadata across release surfaces |
| `pnpm release:updater-manifest` | Generates updater manifest assets |
| `pnpm release:dir` | Builds and outputs a Tauri debug bundle directory |
| `pnpm release` | Builds installer |
| `pnpm pack` | Packages with Tauri using the default target |
| `pnpm pack:dir` | Builds the unpacked Tauri debug bundle |
| `pnpm pack:win` / `pnpm pack:win-x64` | Builds Windows x64 packages |
| `pnpm pack:mac` | Builds macOS packages |
| `pnpm pack:linux` / `pnpm pack:linux-x64` / `pnpm pack:linux-arm64` | Builds Linux packages |

More platform packaging scripts are available in [package.json](package.json).

---

## Project Structure

```text
ShellDesk/
├── src-tauri/
│   ├── tauri.conf.json                  # Tauri app, bundle, icon, and updater artifact config
│   ├── Cargo.toml                       # Rust backend dependencies
│   └── src/
│       ├── main.rs                      # Thin Rust entrypoint
│       ├── bootstrap.rs                 # Tauri builder, state, updater plugin, and command registration
│       ├── ipc.rs                       # Channel dispatcher used by window.guiSSH
│       ├── connection.rs                # SSH/local connection lifecycle
│       ├── ssh_transport.rs             # SSH commands, forwarding, proxy helpers, and terminal transport
│       ├── remote_fs.rs                 # SFTP and remote file operations
│       ├── database.rs                  # MySQL / PostgreSQL / ClickHouse / MongoDB / Redis / SQLite handlers
│       ├── database_tunnel.rs           # SSH tunnel lifecycle, timeout, and cleanup helpers for database tools
│       ├── browser_proxy.rs             # Remote browser URL parsing and local reverse proxy
│       ├── vnc.rs                       # VNC probing, SSH tunnel, and noVNC WebSocket proxy
│       ├── system.rs                    # System fonts and known_hosts helpers
│       ├── vault.rs                     # Local vault, settings, bookmarks, and import/export normalization
│       ├── vault/normalize.rs           # Vault settings, host, key, proxy, and known_hosts normalization
│       ├── sync_backend.rs              # WebDAV sync backend
│       └── updater.rs                   # GitHub release checks and Tauri updater install path
├── src/
│   ├── App.tsx                          # Host library, keys, logs, settings, and connection entry
│   ├── RemoteDesktopShell.tsx           # Remote desktop, multi-window manager, Dock, layout
│   ├── i18n.ts                          # UI language selection and translation helpers
│   ├── components/
│   │   ├── navigation/                  # Main navigation icons
│   │   └── remote-desktop/              # Built-in remote desktop apps
│   ├── pages/
│   │   ├── KeysPage.tsx                 # SSH key management
│   │   ├── LogsPage.tsx                 # Logs page
│   │   └── SettingsPage.tsx             # App settings
│   ├── styles/
│   │   ├── index.scss                   # Global style entry
│   │   ├── _tokens.scss                 # Fonts, CSS variables, and theme tokens
│   │   ├── foundations/                 # Reset, base elements, global behavior
│   │   ├── layout/                      # App shell, title bar, side navigation
│   │   ├── pages/                       # Hosts, keys, logs, settings styles
│   │   ├── remote-desktop/              # Remote desktop and built-in app styles
│   │   └── themes/                      # Light theme overrides
│   └── vite-env.d.ts                    # window.guiSSH and global type definitions
├── index.html
├── package.json
├── src-tauri/tauri.conf.json
├── tsconfig.json
└── vite.config.ts
```

---

## Development Notes

- Use pnpm as the package manager
- Backend code lives in Rust modules under `src-tauri/src`
- The frontend uses React function components, Hooks, and strict TypeScript
- Do not introduce Redux / Zustand; keep global application state in the existing React state tree where possible
- Styles use SCSS modules and CSS variables, with `src/styles/index.scss` as the entry
- Dark theme is the default; light theme overrides live under `[data-theme="light"]`
- New styles should account for both dark and light themes
- New IPC requires synchronized changes in the Rust dispatcher, `src/tauriBridge.ts`, and `src/vite-env.d.ts`
- Remote desktop windows use `transform` for positioning, so context menus and dialogs should render to `document.body` with `createPortal`
- UI copy should remain available in both English and Simplified Chinese

See [AGENTS.md](AGENTS.md) for the full collaboration and engineering notes.

---

## License

This project is released under the GNU General Public License v3.0 (GPLv3). See [LICENSE](LICENSE) for the full license text.

---

## Acknowledgments

- [binaricat/Netcatty](https://github.com/binaricat/Netcatty) — SSH workspace, SFTP, and terminals in one. Some features and UI design were referenced from this project.

---

<p align="center">
  A comfortable desktop workspace for everyday remote server maintenance.
</p>
