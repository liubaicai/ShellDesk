# ShellDesk SSH 架构说明

本文记录当前 ShellDesk 后端 SSH 相关模块的职责边界。维护时以代码为准，本文用于说明为什么不能再引入系统 OpenSSH、`sshpass`、`ssh-keyscan`、`ssh-keygen` 或 `portable-pty` 依赖。

## 当前结论

- SSH 协议路径使用 Rust `russh` / `russh-keys` 实现。
- 远程命令、流式命令、远程终端 PTY、主机密钥扫描、密钥生成、数据库/VNC/浏览器/HTTP 隧道都不调用系统 OpenSSH。
- 客户端系统不需要安装 `openssh-client`、`sshpass`、`ssh-keyscan`、`ssh-keygen` 或 `portable-pty`。
- 远程主机仍需要可达的 SSH server；文件管理器依赖远端 SFTP 能力；各运维工具还会按功能依赖远端系统命令。
- 用户配置的 ProxyCommand 或 ShellDesk proxy helper 仍可能启动用户指定的本地 helper 进程，但这不是系统 SSH fallback。

## 后端模块边界

| 模块 | 责任 |
| --- | --- |
| `src-tauri/src/russh_client.rs` | 共享 russh 客户端。负责 TCP/jump/proxy transport、host key verify/capture、密码/私钥/agent/键盘交互认证、exec channel 和流式输出。 |
| `src-tauri/src/ssh_transport.rs` | `connection:run-command` 的高层包装。负责本地/远程分流、sudo/su-root 包装、重试、host key 刷新和输出格式。 |
| `src-tauri/src/terminal.rs` | 终端生命周期。远程终端通过 russh `channel_open_session`、`request_pty`、`request_shell`/`exec` 运行；resize 通过 `window_change` 转发。 |
| `src-tauri/src/ssh_tunnel.rs` | russh `direct-tcpip` 隧道。数据库、浏览器代理、VNC 和 HTTP tunnel 复用该能力，不保留 OpenSSH `ssh -L` fallback。 |
| `src-tauri/src/connection/host_keys.rs` | 主机密钥预检、分类、信任确认、known_hosts 写入和 vault known-hosts 记录同步。扫描由 russh 握手捕获 server public key。 |
| `src-tauri/src/vault/ssh_keys.rs` | SSH 密钥导入、生成、fingerprint 和 public key 推导。生成路径使用 Rust key API，不调用 `ssh-keygen`。 |
| `src-tauri/src/ui_prompts.rs` | 记录可用 UI 窗口，路由键盘交互认证 prompt 和用户响应。 |
| `src-tauri/src/ipc/connection_channels.rs` | 将非 `Send` 或需要隔离 runtime 的后端任务放进 blocking/current-thread runtime，并保持 IPC channel 统一入口。 |

## 远程命令流程

1. 前端通过 `window.guiSSH.connections.runCommand()` 或流式命令 API 进入 IPC。
2. `ssh_transport.rs` 根据连接类型分流：
   - `ConnectionKind::Local` 走 `command_runner.rs` 的本地 shell。
   - SSH 连接走 `russh_client.rs` 的 `run_exec_command` 或 `run_exec_command_stream`。
3. `russh_client.rs` 建立 SSH transport、校验 host key、完成认证，并打开 session channel 执行 `exec`。
4. 输出被汇总为 `{ stdout, stderr, code, success }`，流式命令同时向窗口 emit chunk。
5. 发生 host key mismatch 时，`ssh_transport.rs` 会触发 host key 信任刷新，然后用更新后的 profile 重试。

## 远程终端流程

1. 前端创建 xterm.js 会话，通过 `connection:start-terminal` 启动后端终端。
2. SSH 连接由 `terminal.rs` 调用 `russh_client::connect_authenticated`。
3. 后端打开 session channel，调用 `request_pty("xterm-256color", columns, rows, ...)`。
4. 后端根据启动参数选择 `request_shell` 或 `exec`，并注入初始命令、工作目录或指定 shell。
5. xterm 输入通过 control channel 写入 russh channel；远端输出通过 `terminal:data` 回到渲染层。
6. resize 通过 `connection:resize-terminal` 转成 russh `window_change(columns, rows, 0, 0)`。
7. su-root 自动化只观察远端 PTY 输出中的密码提示，并把 root 密码写回同一个 PTY channel。

本地模式终端不走 SSH。它使用本地 shell 进程和独立的输入/输出管道，避免为本机工具创建 SSH loopback host。

## 隧道流程

数据库、VNC、浏览器代理和 HTTP tunnel 需要访问远端或远端可达网络时，统一使用 `ssh_tunnel.rs`：

1. 后端绑定本地 `127.0.0.1:0`。
2. 客户端连接本地随机端口。
3. 后端通过 russh `channel_open_direct_tcpip` 转发到目标 host/port。
4. 关闭应用会话时清理本地 listener、活动连接和 tunnel session。

没有 `SshTunnelHandle::OpenSsh`，也没有 `ssh -L` fallback。隧道失败应该返回明确错误，而不是静默回退到系统命令。

## 认证与密钥

支持的认证路径：

- password
- private key / passphrase
- SSH agent
- keyboard-interactive

普通密码 prompt 会优先用已保存密码自动回应；OTP、token、verification code 等交互 prompt 会通过 `ui_prompts.rs` 发到当前 UI 窗口。日志和错误信息不应打印密码、私钥、passphrase 或 `.env` 中的测试凭据。

## 维护规则

- 不要新增 `Command::new("ssh")`、`sshpass`、`SSHPASS`、`SSH_ASKPASS`、`ssh-keyscan`、`ssh-keygen` 或 OpenSSH fallback。
- 不要重新加入 `portable-pty`；远程 PTY 由 SSH server 通过 russh `request_pty` 分配。
- 新增 SSH 命令能力时，优先复用 `russh_client.rs` 和 `ssh_transport.rs`。
- 新增隧道能力时，优先复用 `ssh_tunnel.rs` 的 russh `direct-tcpip` 模型。
- 新增 host key 或密钥管理能力时，更新 `connection/host_keys.rs` 或 `vault/ssh_keys.rs`，不要 shell out 到系统工具。
- 新增 IPC 时同步 Rust dispatcher、`src/tauriBridge.ts`、`src/vite-env.d.ts`、前端调用和错误文案。

## 验证建议

常规检查：

```bash
pnpm test
```

可选 live SSH smoke test 会读取本地 `.env` 或环境变量：

```env
SHELLDESK_TEST_SSH_HOST=
SHELLDESK_TEST_SSH_PORT=
SHELLDESK_TEST_SSH_USERNAME=
SHELLDESK_TEST_SSH_PASSWORD=
SHELLDESK_TEST_SSH_KEY_PATH=
```

不要打印 `SHELLDESK_TEST_SSH_PASSWORD`。如果没有测试凭据，跳过 live SSH 验证并在 PR 中说明。

合并前可用残留扫描确认没有系统 SSH 路径回流：

```bash
rg -n -g '!src-tauri/target/**' -g '!dist/**' "ssh-keyscan|ssh-keygen|sshpass|SSHPASS|ASKPASS|askpass|portable_pty|portable-pty|OpenSsh|create_tunnel_with_fallback|start_ssh_local_forward|ssh_args_with_askpass|ssh_destination|apply_askpass|apply_proxy_helper_env_pty|openssh-client" src-tauri src scripts .github package.json pnpm-lock.yaml
```
