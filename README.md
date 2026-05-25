<p align="center">
  <img src="src/assets/images/icon.png" alt="ShellDesk" width="128" height="128">
</p>

<h1 align="center">ShellDesk</h1>

<p align="center">
  <strong>A graphical SSH client, remote desktop workspace, and server management toolkit</strong>
</p>

<p align="center">
  ShellDesk is built with Electron, React 19, TypeScript, ssh2, and xterm.js.<br/>
  It brings SSH host management, key management, remote terminals, SFTP, remote editing, browser access, databases, and operations tools into one desktop-style workspace.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue?style=for-the-badge">
  &nbsp;
  <img alt="Stage" src="https://img.shields.io/badge/stage-Alpha-orange?style=for-the-badge">
  &nbsp;
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows_first-lightgrey?style=for-the-badge&logo=electron">
  &nbsp;
  <img alt="Package manager" src="https://img.shields.io/badge/package-pnpm-f69220?style=for-the-badge&logo=pnpm">
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

---

## Table of Contents

- [Purpose](#purpose)
- [Feature Overview](#feature-overview)
- [Remote Desktop Apps](#remote-desktop-apps)
- [Data and Security](#data-and-security)
- [Quick Start](#quick-start)
- [Scripts](#scripts)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Development Notes](#development-notes)
- [Roadmap](#roadmap)
- [License](#license)

---

## Purpose

ShellDesk is designed for developers, operations engineers, and anyone who maintains multiple servers over time. It is not just a terminal replacement; it is a remote workspace centered on an SSH connection. After connecting to a host, you can open terminals, file management, databases, system monitoring, logs, service management, network diagnostics, security auditing, and more in one window.

ShellDesk is useful for:

- Maintaining an SSH host library with groups, tags, notes, system type detection, and authentication settings
- Opening multiple remote tools side by side inside one connection window instead of switching between terminal, SFTP, database, and browser clients
- Handling common server operations through a graphical interface while keeping a full terminal available as the fallback
- Storing hosts, keys, app settings, bookmarks, and logs in a local vault for backup and migration

The project is currently in Alpha and is primarily developed and packaged for Windows desktop environments.

---

## Feature Overview

### Hosts and Credentials

- Create, edit, delete, search, group, tag, annotate, and detect system types for SSH hosts
- Supports password login, private-key login, and credential prompts before connecting
- Quick connect parses inputs such as `ssh user@example.com -p 2222`
- The Keys page can import key pairs, generate RSA keys, copy public keys, and search by name, algorithm, or fingerprint
- Settings control whether SSH passwords and key passphrases are saved by default

### Connection Desktop

- Each SSH connection opens in an independent connection window with the current host and local SOCKS port in the title bar
- Built-in SOCKS proxy with an isolated Electron session partition for webviews
- Remote desktop windows support drag, resize, maximize, minimize, z-order management, and a Dock
- File Manager, Terminal, and Browser are pinned to the Dock; other apps join the Dock dynamically while open
- Desktop icons support custom layout, folders, sorting modes, and custom wallpaper

### Terminal, Files, and Editing

- xterm.js terminal supports multiple sessions, title synchronization, scrollback, copy/paste, and theme presets
- Terminal font family, size, weight, ligatures, line height, cursor, scrolling behavior, and contrast are configurable
- Font selection reads the local system font list instead of bundling font files
- SFTP file manager supports browsing, upload, download, transfer cancellation, create, delete, rename, compress, extract, and copy path
- Remote Notepad supports tabs, remote read/write, find, go to line, syntax highlighting, language modes, and unsaved-change prompts
- Notepad uses a binary extension blacklist to avoid opening images, archives, databases, executables, and other binary files by mistake

### Databases and System Tools

- MySQL, PostgreSQL, Redis, and SQLite tools cover connection, browsing, querying, and common editing actions
- System Monitor, Process Manager, Service Manager, Container Manager, Port Listener, and Disk Analyzer help with daily checks
- Firewall, Network Diagnostics, Package Manager, Scheduled Tasks, Login Sessions, and Security Audit support operations troubleshooting
- System Settings provides views for system information, network interfaces, DNS, mirrors, updates, Hosts, routes, disks, and mounts
- Log Viewer supports journalctl, `/var/log`, Windows Event Log, and related sources
- API Debugger sends HTTP requests from the remote host, which is useful for validating private-network services

### App Settings, Logs, Backup, and Language

- Supports dark, light, and system themes
- Supports accent color, system fonts, default host view, desktop wallpaper, and remote desktop layout
- UI language supports English and Simplified Chinese; first launch follows the system language
- Logs record connection, host, key, config, and system operations with search, filters, and clearing
- Config import/export covers hosts, keys, settings, and browser bookmarks

---

## Remote Desktop Apps

| App | Capabilities |
| :--- | :--- |
| File Manager | Windows-style SFTP file manager with transfer, archive, rename, and context menu support |
| Terminal | Interactive SSH shell with multiple sessions, themes, and terminal preferences |
| Notepad | Remote text file editor with tabs, syntax highlighting, and remote save |
| Browser | webview browser with bookmarks, recent visits, connection partitioning, and SOCKS proxy |
| VNC Viewer | Connects to local or intranet VNC desktops with scaling modes and performance presets |
| Log Viewer | Views journalctl, `/var/log`, and Windows Event Log |
| System Monitor | CPU, memory, network, and system status overview |
| MySQL | SSH-tunneled MySQL connection, database/table browsing, columns, SQL queries, and cell updates |
| PostgreSQL | PostgreSQL connection, schema/table browsing, columns, and SQL queries |
| Redis | Redis connection, key scanning, read, write, delete, and command execution |
| SQLite | Remote SQLite file browsing, object browsing, SQL queries, and table editing |
| Service Manager | systemd and Windows Services viewing, start, stop, restart, and startup management |
| Container Manager | Docker / Podman container, image, and basic status management |
| Port Listener | View port usage, listening services, and connection state |
| Firewall | ufw, firewalld, and Windows Firewall inspection and management |
| Network Diagnostics | Ping, DNS, HTTP, TCP, and related connectivity tests |
| Disk Analyzer | Disk space, directory usage, and large file discovery |
| Package Manager | Installed package search, upgradeable packages, and package-manager updates |
| Scheduled Tasks | Cron, systemd timer, and Windows Task Scheduler viewing |
| Security Audit | SSH config, sensitive ports, failed logins, permissions, and update checks |
| Login Sessions | Online users, successful logins, failed logins, and source summaries |
| API Debugger | Send HTTP requests from the remote host side |
| Process Manager | View, search, sort, and terminate processes |
| System Settings | System information, network, DNS, mirrors, updates, Hosts, routes, and disks |

---

## Data and Security

ShellDesk stores local data in the Electron user data directory. The Settings page shows the config path and vault path.

- Hosts, keys, app settings, and browser bookmarks are stored in the local vault
- When Electron `safeStorage` is available, sensitive data is encrypted with system credentials
- When system encryption is unavailable, the vault falls back to local file-permission protection
- Logs are stored separately in the user data directory
- Exported config JSON may include hosts, passwords, private keys, and key passphrases, so it should only be stored in trusted locations
- The renderer process uses `contextIsolation`, disables `nodeIntegration`, and accesses controlled APIs through preload
- Electron sandbox limitations around `prompt`, `confirm`, and `alert` are handled with custom modals

---

## Quick Start

### Requirements

- Node.js 20 or later
- pnpm 9 or later
- Windows 10 or later

### Install Dependencies

```bash
pnpm install
```

### Start Development Mode

```bash
pnpm dev
```

Development mode starts Vite and Electron in parallel:

- Vite listens on `127.0.0.1:5173` by default
- Electron waits for Vite before opening the app window
- The development window opens DevTools automatically

If Vite remains on port `5173` after exit, stop only the PID occupying that port:

```powershell
netstat -ano | findstr :5173
Stop-Process -Id <PID>
```

---

## Scripts

| Command | Description |
| :--- | :--- |
| `pnpm dev` | Starts Vite and the Electron development window in parallel |
| `pnpm typecheck` | Runs TypeScript type checking |
| `pnpm build` | Runs `tsc --noEmit` and then the Vite production build |
| `pnpm start` | Runs the current build output |
| `pnpm preview` | Previews the Vite frontend build without Electron main-process capabilities |
| `pnpm release:dir` | Builds and outputs an electron-builder directory package |
| `pnpm release` | Builds the Windows x64 NSIS installer |
| `pnpm pack` | Packages with electron-builder without publishing |

More platform packaging scripts are available in [package.json](package.json).

---

## Tech Stack

| Category | Technology |
| :--- | :--- |
| Desktop framework | Electron 40 |
| Frontend framework | React 19 |
| Type system | TypeScript 5.9 |
| Build tool | Vite 7 |
| Styling | Sass / SCSS + CSS variables |
| SSH / SFTP | ssh2 |
| Terminal | xterm.js |
| VNC | @novnc/novnc |
| Databases | mysql2, pg, ioredis, SQLite IPC |
| Syntax highlighting | highlight.js |
| Packaging | electron-builder |
| Package manager | pnpm |

---

## Project Structure

```text
ShellDesk/
├── electron/
│   ├── main.cjs                         # Main-process entry: windows, connections, database, VNC, config IPC
│   ├── preload.cjs                      # Secure contextBridge API
│   └── main/
│       ├── connectionHandlers.cjs       # SSH connection, SOCKS, terminal, and SFTP IPC
│       ├── databaseHandlers.cjs         # MySQL / PostgreSQL / Redis / SQLite IPC
│       ├── remoteConnectionHandlers.cjs # Remote system detection and system information
│       ├── vaultStore.cjs               # Local vault, settings, import/export
│       ├── systemFonts.cjs              # System font enumeration
│       └── windows.cjs                  # BrowserWindow and webview security policy
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
├── electron-builder.config.cjs
├── tsconfig.json
└── vite.config.ts
```

---

## Development Notes

- Use pnpm as the package manager
- Electron main-process and preload files use CommonJS `.cjs`
- The frontend uses React function components, Hooks, and strict TypeScript
- Do not introduce Redux / Zustand; keep global application state in the existing React state tree where possible
- Styles use SCSS modules and CSS variables, with `src/styles/index.scss` as the entry
- Dark theme is the default; light theme overrides live under `[data-theme="light"]`
- New styles should account for both dark and light themes
- New IPC requires synchronized changes in the main-process handler, `electron/preload.cjs`, and `src/vite-env.d.ts`
- Remote desktop windows use `transform` for positioning, so context menus and dialogs should render to `document.body` with `createPortal`
- UI copy should remain available in both English and Simplified Chinese

See [AGENTS.md](AGENTS.md) for the full collaboration and engineering notes.

---

## Roadmap

- Add official screenshots, demo GIFs, and installer download instructions
- Improve multi-platform packaging, signing, and release workflows
- Enhance the SFTP transfer queue, batch operations, and error recovery
- Add more granular encryption and redaction options for config export
- Improve remote system tool compatibility across Linux distributions and Windows environments
- Add automated tests for key IPC paths, data validation, and remote tool parsers
- Continue improving accessibility, keyboard navigation, and high-contrast experiences

---

## License

This project is released under the GNU General Public License v3.0 (GPLv3). See [LICENSE](LICENSE) for the full license text.

---

<p align="center">
  A comfortable desktop workspace for everyday remote server maintenance.
</p>
