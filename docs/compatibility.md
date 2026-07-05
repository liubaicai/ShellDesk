# Compatibility Matrix / 兼容性矩阵

This matrix tracks compatibility checks for ShellDesk remote system tools.

该矩阵用于记录 ShellDesk 远程系统工具的兼容性验证状态。

## Client-side baseline / 客户端基线

- ShellDesk desktop builds require the normal Tauri 2 platform prerequisites, Node.js, pnpm, and Rust for development builds.
- SSH protocol features are implemented in Rust with `russh`; the client machine does not need `openssh-client`, `sshpass`, `ssh-keyscan`, `ssh-keygen`, or `portable-pty`.
- Local mode uses local OS commands and a local shell process, not an SSH loopback host.

- ShellDesk 桌面端开发构建需要常规 Tauri 2 平台依赖、Node.js、pnpm 和 Rust。
- SSH 协议能力由 Rust `russh` 实现，客户端系统不需要安装 `openssh-client`、`sshpass`、`ssh-keyscan`、`ssh-keygen` 或 `portable-pty`。
- 本地模式使用本机系统命令和本地 shell 进程，不需要创建 SSH 回环主机。

## Remote target assumptions / 远端目标假设

- SSH connections require a reachable SSH server on the target host.
- The file manager requires SFTP support on the target SSH server.
- Individual operations tools may require target-side commands such as `systemctl`, `journalctl`, `ss`, `ip`, PowerShell cmdlets, database CLIs, `mc`, `aws`, `frpc`, or `frps`.
- The status below is about remote OS/tool behavior, not client-side OpenSSH availability.

- SSH 连接要求目标主机可访问 SSH server。
- 文件管理器要求目标 SSH server 支持 SFTP。
- 单个运维工具可能依赖远端命令，例如 `systemctl`、`journalctl`、`ss`、`ip`、PowerShell cmdlet、数据库 CLI、`mc`、`aws`、`frpc` 或 `frps`。
- 下表记录的是远端系统和工具行为，不表示客户端需要系统 OpenSSH。

Legend / 图例:

- ✅ Supported / 已支持
- ℹ️ Untested / 未测试
- ⚠️ Limited support / 有限支持
- ❌ Unsupported / 不支持

| Distribution / environment | Status | Notes |
| :--- | :---: | :--- |
| Ubuntu 26.04 LTS |  |  |
| Ubuntu 24.04 LTS | ✅ | [Report](system-compatibility-reports/ubuntu2404.md) |
| Ubuntu 22.04 LTS |  |  |
| Ubuntu 20.04 LTS |  |  |
| Debian 13 Trixie |  |  |
| Debian 12 Bookworm | ✅ | [Report](system-compatibility-reports/debian12.md) |
| Debian 11 Bullseye | ✅ | [Report](system-compatibility-reports/debian11.md) |
| RHEL 10 |  |  |
| RHEL 9 | ✅ | [Report](system-compatibility-reports/rhel9.md) |
| RHEL 8 |  |  |
| CentOS 7 | ⚠️ | [Report](system-compatibility-reports/centos7.md) |
| Fedora Server 41 |  |  |
| Fedora Workstation 41 |  |  |
| openSUSE Leap 15.6 |  |  |
| Alibaba Cloud Linux 3 |  |  |
| TencentOS Server 4 |  |  |
| openEuler 24.03 LTS | ✅ | [Report](system-compatibility-reports/openeuler2403.md) |
| Kylin Server V10 |  |  |
| UOS Server 20 |  |  |
| Linux Mint 22 |  |  |
| Arch Linux |  |  |
| Manjaro |  |  |
| Pop!_OS |  |  |
| Kali Linux |  |  |
| Raspberry Pi OS 12 Bookworm |  |  |
| Alpine Linux 3.23 | ⚠️ | [Report](system-compatibility-reports/alpine323.md) |
| Windows Server 2022 |  |  |
| Windows Server 2019 |  |  |
| Windows Server 2016 |  |  |
| Windows 11 | ✅ | [Report](system-compatibility-reports/windows11.md) |
| Windows 10 | ✅ | [Report](system-compatibility-reports/windows10.md) |
