# SSH 隧道 + 数据库驱动连接 实现方案

> **Scope:** 只实现计划中的代码时才修改应用源码。本文件是实现计划，不是本次改动的实现。
>
> **Historical note, 2026-07-05:** 本文件保留为原始实现方案。当前代码已经模块化到 `src-tauri/src/database/`，隧道和数据库会话逻辑位于 `src-tauri/src/database/tunnel.rs`，SSH 转发位于 `src-tauri/src/ssh_tunnel.rs`。通用 SSH 命令、终端、主机密钥和密钥生成路径已迁移到 `docs/ssh-architecture.md` 描述的纯 Rust russh 栈；旧文中的 `database.rs`、`database_tunnel.rs`、系统 OpenSSH 或 fallback 表述不再代表当前架构。
>
> **Dependency note, 2026-07-06:** 当前实现已升级到 `russh = "0.61.2"`，`src-tauri/Cargo.toml` 的 `rust-version` 已提高到 `1.85`，并移除了旧的直接 `russh-keys` 依赖。下方任务清单中的 `russh 0.53.0` 片段仅保留为原始方案历史。
>
> **Goal:** 为 ShellDesk 添加 SSH 隧道模式，通过 `russh` 在本地建立 TCP 代理隧道，使用原生数据库驱动连接远程数据库，保留现有远程 CLI 调用方式作为默认/回退路径。

ShellDesk 当前数据库能力集中在 `src-tauri/src/database.rs`，IPC 通过 `src-tauri/src/ipc/database_channels.rs` 暴露为 `connection:mysql-*`、`connection:postgres-*`、`connection:redis-*`、`connection:clickhouse-*` 等通道。前端统一通过 `src/tauriBridge.ts` 的 `window.guiSSH.connections.*` 调用，类型定义在 `src/vite-env.d.ts`。

本方案不新增前端公开 API 前缀。隧道模式通过现有 connect 配置的 `mode: "tunnel"` 启用，后续 query/list/disconnect 仍复用现有 IPC channel 和前端方法。

**架构:** TCP 监听代理模式。Rust 后端用 `russh` 连接已建立的 ShellDesk SSH profile，在本地绑定 `127.0.0.1:0` 随机端口；数据库驱动连接该本地端口；隧道任务把本地 TCP 流量通过 SSH `direct-tcpip` 转发到远程数据库地址。

**Tech Stack:**
- SSH: `russh`（纯 Rust async，Tokio）
- MySQL: `sqlx`，`mysql` feature
- PostgreSQL: `sqlx`，`postgres` feature
- Redis: `fred`
- ClickHouse: `clickhouse` HTTP client
- Error: `thiserror`
- URL escaping: `urlencoding`

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     ShellDesk Frontend                       │
│  RemoteMySQL / RemotePostgres / RemoteRedis / RemoteClickHouse│
│          │ existing window.guiSSH.connections.* calls         │
└──────────┼───────────────────────────────────────────────────┘
           │ IPC: connection:mysql-connect/query/disconnect...
┌──────────▼───────────────────────────────────────────────────┐
│                   src-tauri/src/database.rs                   │
│   mode=cli → existing remote CLI implementation               │
│   mode=tunnel → database_tunnel.rs typed native driver         │
└──────────┬───────────────────────────────────────────────────┘
           │ owns tunnel sessions in AppState
┌──────────▼───────────────────────────────────────────────────┐
│                 src-tauri/src/database_tunnel.rs              │
│   sqlx pools / fred clients / clickhouse clients              │
└──────────┬───────────────────────────────────────────────────┘
           │ local address from tunnel
┌──────────▼───────────────────────────────────────────────────┐
│                   src-tauri/src/ssh_tunnel.rs                 │
│   russh session + TcpListener 127.0.0.1:0 + direct-tcpip       │
└──────────┬───────────────────────────────────────────────────┘
           │ SSH
           ▼
   remote host reachable from SSH server → database host:port
```

Session ownership:

- `AppState.database_sessions: HashMap<String, Value>` remains for existing CLI mode.
- Add `AppState.database_tunnel_sessions: Arc<Mutex<HashMap<String, DatabaseTunnelSession>>>` for native driver sessions.
- Add `AppState.ssh_tunnels: Arc<Mutex<HashMap<String, SshTunnel>>>` for tunnel lifecycle if tunnels are shared independently. If every DB session owns exactly one tunnel, storing the tunnel inside `DatabaseTunnelSession` is simpler and avoids orphan tunnel IDs.

Recommended implementation: store the `SshTunnel` directly inside each `DatabaseTunnelSession`; only add a standalone `ssh_tunnels` map if future features need reusable tunnels.

---

## Phase 1: SSH 隧道核心模块 (P0)

### Task 1.1: 添加 russh 依赖

**Objective:** 历史方案中在 `src-tauri/Cargo.toml` 添加隧道、错误和 URL 编码依赖，并锁定当时兼容 ShellDesk Rust 1.80 的版本范围。当前实现已升级到 `russh = "0.61.2"` / Rust 1.85。

**Files:**
- Modify: `src-tauri/Cargo.toml`

**Cargo.toml exact versions and features:**

```toml
[dependencies]
# existing tokio line should include these features; no "full" needed.
tokio = { version = "1.45.1", features = ["process", "io-util", "time", "net", "sync", "macros", "rt-multi-thread"] }

# Historical pin from the original plan.
russh = "0.53.0"
russh-keys = "0.49.2"
async-trait = "0.1.88"
ssh-key = "0.6.7"

# Stronger error modeling and connection string escaping.
thiserror = "2.0.12"
urlencoding = "2.1.3"

[dev-dependencies]
tempfile = "3.20.0"
```

Notes:

- Current code has already raised `src-tauri/Cargo.toml` `rust-version` to `1.85` and uses `russh = "0.61.2"`.
- If a future `russh` upgrade changes `client::Handle::channel_open_direct_tcpip` signatures, update `ssh_tunnel.rs` only; keep the public `SshTunnel` API stable.
- Prefer exact minor versions in the implementation branch and commit the generated `src-tauri/Cargo.lock`.
- `tokio` needs `rt-multi-thread` once tests spawn tunnel tasks outside Tauri runtime contexts.

**Validation command:**

```bash
cd /root/ShellDesk/src-tauri && cargo check
```

---

### Task 1.2: 创建 SSH 隧道模块

**Objective:** 实现一个 small API：validate config → open SSH session → bind local listener → forward each accepted TCP stream over SSH `direct-tcpip` → close via shutdown channel.

**Files:**
- Create: `src-tauri/src/ssh_tunnel.rs`
- Modify: `src-tauri/src/modules.rs`

**Step 1: Register module**

```rust
// src-tauri/src/modules.rs
#[path = "ssh_tunnel.rs"]
pub(crate) mod ssh_tunnel;
```

**Step 2: Add complete module**

The historical implementation sketch below is intentionally self-contained and targets the original pinned `russh = "0.53.0"` API.

```rust
// src-tauri/src/ssh_tunnel.rs
use async_trait::async_trait;
use russh::client;
use russh_keys::key::PrivateKeyWithHashAlg;
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    sync::Arc,
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io,
    net::{TcpListener, TcpStream},
    sync::{mpsc, Mutex},
    task::JoinHandle,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshTunnelConfig {
    pub(crate) ssh_host: String,
    pub(crate) ssh_port: u16,
    pub(crate) ssh_user: String,
    pub(crate) ssh_password: Option<String>,
    pub(crate) ssh_key_path: Option<String>,
    pub(crate) ssh_key_passphrase: Option<String>,
    pub(crate) known_hosts_path: Option<String>,
    pub(crate) remote_host: String,
    pub(crate) remote_port: u16,
    #[serde(default = "default_connect_timeout_ms")]
    pub(crate) connect_timeout_ms: u64,
}

fn default_connect_timeout_ms() -> u64 {
    15_000
}

#[derive(Debug, Error)]
pub(crate) enum TunnelError {
    #[error("SSH 主机不能为空。")]
    MissingSshHost,
    #[error("SSH 用户名不能为空。")]
    MissingSshUser,
    #[error("远程数据库主机不能为空。")]
    MissingRemoteHost,
    #[error("{field} 端口必须在 1-65535 范围内。")]
    InvalidPort { field: &'static str },
    #[error("必须提供 SSH 密码或 SSH 私钥路径。")]
    MissingAuthentication,
    #[error("SSH 私钥文件不存在：{0}")]
    MissingKeyFile(String),
    #[error("SSH 连接失败：{0}")]
    SshConnect(String),
    #[error("SSH 认证失败：{0}")]
    SshAuth(String),
    #[error("绑定本地隧道端口失败：{0}")]
    BindLocal(#[source] std::io::Error),
    #[error("获取本地隧道地址失败：{0}")]
    LocalAddr(#[source] std::io::Error),
    #[error("打开 SSH 转发通道失败：{0}")]
    OpenChannel(String),
    #[error("隧道转发失败：{0}")]
    Forward(#[source] std::io::Error),
    #[error("关闭隧道失败：{0}")]
    Shutdown(String),
}

impl TunnelError {
    pub(crate) fn user_message(&self) -> String {
        self.to_string()
    }
}

impl SshTunnelConfig {
    pub(crate) fn validate(&self) -> Result<(), TunnelError> {
        if self.ssh_host.trim().is_empty() {
            return Err(TunnelError::MissingSshHost);
        }
        if self.ssh_user.trim().is_empty() {
            return Err(TunnelError::MissingSshUser);
        }
        if self.remote_host.trim().is_empty() {
            return Err(TunnelError::MissingRemoteHost);
        }
        if self.ssh_port == 0 {
            return Err(TunnelError::InvalidPort { field: "SSH" });
        }
        if self.remote_port == 0 {
            return Err(TunnelError::InvalidPort { field: "数据库" });
        }
        let has_password = self
            .ssh_password
            .as_deref()
            .is_some_and(|value| !value.is_empty());
        let has_key = self
            .ssh_key_path
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        if !has_password && !has_key {
            return Err(TunnelError::MissingAuthentication);
        }
        if let Some(path) = self.ssh_key_path.as_deref().filter(|value| !value.is_empty()) {
            if !Path::new(path).is_file() {
                return Err(TunnelError::MissingKeyFile(path.to_string()));
            }
        }
        Ok(())
    }
}

pub(crate) struct SshTunnel {
    local_addr: SocketAddr,
    shutdown_tx: mpsc::Sender<()>,
    accept_task: JoinHandle<()>,
}

impl fmt::Debug for SshTunnel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshTunnel")
            .field("local_addr", &self.local_addr)
            .finish_non_exhaustive()
    }
}

impl SshTunnel {
    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub(crate) async fn shutdown(self) -> Result<(), TunnelError> {
        let _ = self.shutdown_tx.send(()).await;
        self.accept_task.abort();
        Ok(())
    }
}

struct TunnelHandler {
    known_hosts_path: Option<String>,
}

#[async_trait]
impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Phase 1 implementation may return true to unblock development.
        // Before release, replace this with integration to ShellDesk known_hosts:
        // - use known_hosts_path when provided by SshProfile
        // - or reuse connection.rs host-key prompt flow.
        let _ = &self.known_hosts_path;
        Ok(true)
    }
}

pub(crate) async fn create_tunnel(config: SshTunnelConfig) -> Result<SshTunnel, TunnelError> {
    config.validate()?;

    let timeout = Duration::from_millis(config.connect_timeout_ms.max(1_000));
    let ssh_config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        ..Default::default()
    });
    let handler = TunnelHandler {
        known_hosts_path: config.known_hosts_path.clone(),
    };

    let mut session = tokio::time::timeout(
        timeout,
        client::connect(
            ssh_config,
            (config.ssh_host.as_str(), config.ssh_port),
            handler,
        ),
    )
    .await
    .map_err(|_| TunnelError::SshConnect("连接超时。".to_string()))?
    .map_err(|error| TunnelError::SshConnect(error.to_string()))?;

    if let Some(key_path) = config.ssh_key_path.as_deref().filter(|value| !value.is_empty()) {
        let passphrase = config.ssh_key_passphrase.as_deref();
        let key = russh_keys::load_secret_key(key_path, passphrase)
            .map_err(|error| TunnelError::SshAuth(error.to_string()))?;
        let key = PrivateKeyWithHashAlg::new(Arc::new(key), None)
            .map_err(|error| TunnelError::SshAuth(error.to_string()))?;
        let auth_result = session
            .authenticate_publickey(&config.ssh_user, key)
            .await
            .map_err(|error| TunnelError::SshAuth(error.to_string()))?;
        if !auth_result.success() {
            return Err(TunnelError::SshAuth("服务器拒绝私钥认证。".to_string()));
        }
    } else if let Some(password) = config.ssh_password.as_deref() {
        let auth_result = session
            .authenticate_password(&config.ssh_user, password)
            .await
            .map_err(|error| TunnelError::SshAuth(error.to_string()))?;
        if !auth_result.success() {
            return Err(TunnelError::SshAuth("服务器拒绝密码认证。".to_string()));
        }
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(TunnelError::BindLocal)?;
    let local_addr = listener.local_addr().map_err(TunnelError::LocalAddr)?;
    let session = Arc::new(Mutex::new(session));
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    let remote_host = config.remote_host.clone();
    let remote_port = config.remote_port;

    let accept_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = shutdown_rx.recv() => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((local_stream, _peer)) => {
                            let session = Arc::clone(&session);
                            let remote_host = remote_host.clone();
                            tokio::spawn(async move {
                                if let Err(error) = forward_one(session, local_stream, remote_host, remote_port).await {
                                    eprintln!("[ssh-tunnel] {error}");
                                }
                            });
                        }
                        Err(error) => {
                            eprintln!("[ssh-tunnel] accept failed: {error}");
                            break;
                        }
                    }
                }
            }
        }
    });

    Ok(SshTunnel {
        local_addr,
        shutdown_tx,
        accept_task,
    })
}

async fn forward_one(
    session: Arc<Mutex<client::Handle<TunnelHandler>>>,
    mut local_stream: TcpStream,
    remote_host: String,
    remote_port: u16,
) -> Result<(), TunnelError> {
    let channel = {
        let mut session = session.lock().await;
        session
            .channel_open_direct_tcpip(
                remote_host.as_str(),
                u32::from(remote_port),
                "127.0.0.1",
                0,
            )
            .await
            .map_err(|error| TunnelError::OpenChannel(error.to_string()))?
    };

    let mut ssh_stream = channel.into_stream();
    io::copy_bidirectional(&mut local_stream, &mut ssh_stream)
        .await
        .map_err(TunnelError::Forward)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> SshTunnelConfig {
        SshTunnelConfig {
            ssh_host: "example.com".to_string(),
            ssh_port: 22,
            ssh_user: "root".to_string(),
            ssh_password: Some("secret".to_string()),
            ssh_key_path: None,
            ssh_key_passphrase: None,
            known_hosts_path: None,
            remote_host: "127.0.0.1".to_string(),
            remote_port: 3306,
            connect_timeout_ms: 1_000,
        }
    }

    #[test]
    fn validates_required_fields() {
        let mut config = base_config();
        config.remote_host.clear();
        assert!(matches!(config.validate(), Err(TunnelError::MissingRemoteHost)));
    }

    #[test]
    fn rejects_missing_authentication() {
        let mut config = base_config();
        config.ssh_password = None;
        config.ssh_key_path = None;
        assert!(matches!(config.validate(), Err(TunnelError::MissingAuthentication)));
    }

    #[tokio::test]
    async fn binds_loopback_when_config_is_valid_but_ssh_unreachable() {
        let mut config = base_config();
        config.ssh_host = "127.0.0.1".to_string();
        config.ssh_port = 9;
        let result = create_tunnel(config).await;
        assert!(matches!(result, Err(TunnelError::SshConnect(_))));
    }
}
```

**Error handling pattern:**

- Module internals return `TunnelError`.
- Public IPC adapters convert with `.map_err(|error| error.user_message())`.
- Do not return raw debug output containing passwords, DSNs, or key passphrases.

**Configuration validation checklist:**

- SSH host/user non-empty.
- SSH port and remote DB port non-zero.
- At least password or key path present.
- Key path exists when provided.
- `remote_host` is the address visible from the SSH server, not necessarily the ShellDesk host address.
- Timeout has a sane minimum.

---

### Task 1.3: 从现有 SSH profile 构造隧道配置

**Objective:** 隧道应复用已连接 ShellDesk host 的 `SshProfile`，避免前端重复输入 SSH 凭据。前端只提供数据库主机/端口和可选 tunnel override。

**Files:**
- Modify: `src-tauri/src/ssh_tunnel.rs`
- Use existing: `src-tauri/src/state.rs`, `src-tauri/src/connection.rs`, `src-tauri/src/ssh_transport.rs`

**Integration helper:**

```rust
// Add to src-tauri/src/ssh_tunnel.rs
use crate::{get_connection, AppState, ConnectionKind, SshProfile};
use serde_json::Value;

pub(crate) fn config_from_connection(
    state: &AppState,
    connection_id: &str,
    remote_host: &str,
    remote_port: u16,
    overrides: Option<&Value>,
) -> Result<SshTunnelConfig, String> {
    let connection = get_connection(state, connection_id)?;
    if connection.kind != ConnectionKind::Ssh {
        return Err("SSH 隧道模式需要一个 SSH 连接，本地连接不支持该模式。".to_string());
    }
    let profile = connection
        .ssh
        .as_ref()
        .ok_or_else(|| "当前连接缺少 SSH 配置。".to_string())?;
    Ok(config_from_profile(profile, remote_host, remote_port, overrides))
}

fn config_from_profile(
    profile: &SshProfile,
    remote_host: &str,
    remote_port: u16,
    overrides: Option<&Value>,
) -> SshTunnelConfig {
    let ssh_password = if profile.auth_method == "password" {
        Some(profile.password.clone())
    } else {
        None
    };
    let ssh_key_path = if profile.auth_method == "key" {
        Some(profile.key_path.clone())
    } else {
        None
    };
    let ssh_key_passphrase = if profile.auth_method == "key" && !profile.password.is_empty() {
        Some(profile.password.clone())
    } else {
        None
    };
    let connect_timeout_ms = overrides
        .and_then(|value| value.get("connectTimeoutMs"))
        .and_then(Value::as_u64)
        .unwrap_or(15_000);

    SshTunnelConfig {
        ssh_host: profile.address.clone(),
        ssh_port: profile.port,
        ssh_user: profile.username.clone(),
        ssh_password,
        ssh_key_path,
        ssh_key_passphrase,
        known_hosts_path: Some(profile.known_hosts_path.clone()).filter(|value| !value.is_empty()),
        remote_host: remote_host.to_string(),
        remote_port,
        connect_timeout_ms,
    }
}
```

**Important integration detail:**

`SshProfile` supports `proxy` and `jump`. The first implementation may explicitly reject profiles with proxy/jump and return a clear error, because `russh` direct connection will not automatically reuse ShellDesk's CLI proxy helper:

```rust
if profile.proxy.is_some() || profile.jump.is_some() {
    return Err("SSH 隧道原生模式暂不支持代理或跳板机连接，请使用 CLI 模式。".to_string());
}
```

If proxy/jump support is required for v1, implement it in `ssh_tunnel.rs` by opening the russh transport through the same proxy chain instead of using `client::connect((host, port))`.

---

## Phase 2: 数据库驱动集成 (P0)

### Task 2.1: 添加数据库驱动依赖

**Objective:** 添加 native driver 依赖并启用最小 feature set。

**Files:**
- Modify: `src-tauri/Cargo.toml`

```toml
[dependencies]
sqlx = { version = "0.8.6", default-features = false, features = [
  "runtime-tokio-rustls",
  "mysql",
  "postgres",
  "chrono",
  "json",
] }
fred = { version = "10.1.0", default-features = false, features = [
  "enable-rustls",
  "i-keys",
] }
clickhouse = { version = "0.13.3", default-features = false, features = ["rustls-tls"] }
```

**Validation command:**

```bash
cd /root/ShellDesk/src-tauri && cargo check
```

**Pitfall:** `sqlx` compile-time query macros require `DATABASE_URL`; use `sqlx::query` runtime queries in ShellDesk to avoid build-time DB dependencies.

---

### Task 2.2: 创建 database_tunnel.rs

**Objective:** Implement typed sessions, parsing, validation, connect/query/list/disconnect functions. Route through this module only when connect config contains `mode: "tunnel"`.

**Files:**
- Create: `src-tauri/src/database_tunnel.rs`
- Modify: `src-tauri/src/modules.rs`
- Modify: `src-tauri/src/state.rs`

**Register module and AppState field:**

```rust
// src-tauri/src/modules.rs
#[path = "database_tunnel.rs"]
pub(crate) mod database_tunnel;

// src-tauri/src/state.rs
use crate::database_tunnel::DatabaseTunnelSession;

pub(crate) struct AppState {
    // existing fields...
    pub(crate) database_tunnel_sessions: Arc<Mutex<HashMap<String, DatabaseTunnelSession>>>,
}

impl AppState {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        Self {
            // existing fields...
            database_tunnel_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
```

**Complete module skeleton:**

```rust
// src-tauri/src/database_tunnel.rs
use crate::{
    error_string, random_id, read_string_field, string_arg,
    ssh_tunnel::{config_from_connection, create_tunnel, SshTunnel, SshTunnelConfig, TunnelError},
    AppState,
};
use fred::{clients::RedisClient, prelude::*};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{
    mysql::{MySqlPool, MySqlPoolOptions, MySqlRow},
    postgres::{PgPool, PgPoolOptions, PgRow},
    Column, Row, TypeInfo,
};
use std::{collections::HashMap, time::Duration};
use thiserror::Error;
use urlencoding::encode;

#[derive(Debug, Error)]
pub(crate) enum DbTunnelError {
    #[error("{0}")]
    InvalidConfig(String),
    #[error(transparent)]
    Tunnel(#[from] TunnelError),
    #[error("MySQL 连接失败：{0}")]
    MysqlConnect(#[source] sqlx::Error),
    #[error("MySQL 查询失败：{0}")]
    MysqlQuery(#[source] sqlx::Error),
    #[error("PostgreSQL 连接失败：{0}")]
    PostgresConnect(#[source] sqlx::Error),
    #[error("PostgreSQL 查询失败：{0}")]
    PostgresQuery(#[source] sqlx::Error),
    #[error("Redis 连接失败：{0}")]
    RedisConnect(String),
    #[error("Redis 命令失败：{0}")]
    RedisCommand(String),
    #[error("ClickHouse 连接失败：{0}")]
    ClickHouseConnect(String),
    #[error("ClickHouse 查询失败：{0}")]
    ClickHouseQuery(String),
    #[error("数据库连接已断开。")]
    SessionNotFound,
    #[error("会话类型不匹配，期望 {expected}，实际 {actual}。")]
    SessionKindMismatch { expected: &'static str, actual: &'static str },
}

impl DbTunnelError {
    pub(crate) fn user_message(&self) -> String {
        self.to_string()
    }
}

pub(crate) enum DatabaseTunnelSession {
    Mysql(MysqlTunnelSession),
    Postgres(PostgresTunnelSession),
    Redis(RedisTunnelSession),
    ClickHouse(ClickHouseTunnelSession),
}

impl DatabaseTunnelSession {
    fn kind(&self) -> &'static str {
        match self {
            Self::Mysql(_) => "mysql",
            Self::Postgres(_) => "postgres",
            Self::Redis(_) => "redis",
            Self::ClickHouse(_) => "clickhouse",
        }
    }

    async fn shutdown(self) {
        match self {
            Self::Mysql(session) => session.shutdown().await,
            Self::Postgres(session) => session.shutdown().await,
            Self::Redis(session) => session.shutdown().await,
            Self::ClickHouse(session) => session.shutdown().await,
        }
    }
}

pub(crate) struct MysqlTunnelSession {
    tunnel: SshTunnel,
    pool: MySqlPool,
}

pub(crate) struct PostgresTunnelSession {
    tunnel: SshTunnel,
    pool: PgPool,
}

pub(crate) struct RedisTunnelSession {
    tunnel: SshTunnel,
    client: RedisClient,
}

pub(crate) struct ClickHouseTunnelSession {
    tunnel: SshTunnel,
    client: clickhouse::Client,
}

impl MysqlTunnelSession {
    async fn shutdown(self) {
        self.pool.close().await;
        let _ = self.tunnel.shutdown().await;
    }
}

impl PostgresTunnelSession {
    async fn shutdown(self) {
        self.pool.close().await;
        let _ = self.tunnel.shutdown().await;
    }
}

impl RedisTunnelSession {
    async fn shutdown(self) {
        let _ = self.client.quit().await;
        let _ = self.tunnel.shutdown().await;
    }
}

impl ClickHouseTunnelSession {
    async fn shutdown(self) {
        let _ = self.tunnel.shutdown().await;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelOptions {
    pub(crate) remote_host: String,
    pub(crate) remote_port: u16,
    #[serde(default)]
    pub(crate) connect_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MysqlConnectConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_mysql_port")]
    port: u16,
    #[serde(default = "default_mysql_user")]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    tunnel: Option<TunnelOptions>,
}

fn default_mode() -> String { "cli".to_string() }
fn default_host() -> String { "127.0.0.1".to_string() }
fn default_mysql_port() -> u16 { 3306 }
fn default_mysql_user() -> String { "root".to_string() }

fn session_key(kind: &str, connection_id: &str, session_id: &str) -> String {
    format!("{kind}:{connection_id}:{session_id}")
}

pub(crate) fn is_tunnel_mode(config: &Value) -> bool {
    config
        .get("mode")
        .and_then(Value::as_str)
        .is_some_and(|mode| mode.eq_ignore_ascii_case("tunnel"))
}

pub(crate) async fn disconnect(
    state: &AppState,
    args: Vec<Value>,
    kind: &'static str,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let session_id = string_arg(&args, 1)?;
    let key = session_key(kind, &connection_id, &session_id);
    let session = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .remove(&key);
    if let Some(session) = session {
        tokio::spawn(async move {
            session.shutdown().await;
        });
        return Ok(json!(true));
    }
    Ok(json!(false))
}

pub(crate) async fn mysql_connect(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config_value = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let config: MysqlConnectConfig = serde_json::from_value(config_value.clone())
        .map_err(|error| format!("MySQL 隧道配置无效：{error}"))?;
    let tunnel_options = config
        .tunnel
        .clone()
        .unwrap_or(TunnelOptions {
            remote_host: config.host.clone(),
            remote_port: config.port,
            connect_timeout_ms: None,
        });
    validate_database_endpoint(&tunnel_options.remote_host, tunnel_options.remote_port)?;
    if config.user.trim().is_empty() {
        return Err("MySQL 用户名不能为空。".to_string());
    }

    let tunnel_config = tunnel_config_from_options(state, &connection_id, &tunnel_options)?;
    let tunnel = create_tunnel(tunnel_config)
        .await
        .map_err(|error| error.user_message())?;
    let local_addr = tunnel.local_addr();
    let dsn = format!(
        "mysql://{}:{}@{}:{}/{}",
        encode(&config.user),
        encode(&config.password),
        local_addr.ip(),
        local_addr.port(),
        encode(config.database.as_deref().unwrap_or(""))
    );

    let pool_result = MySqlPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&dsn)
        .await;
    let pool = match pool_result {
        Ok(pool) => pool,
        Err(error) => {
            let _ = tunnel.shutdown().await;
            return Err(DbTunnelError::MysqlConnect(error).user_message());
        }
    };
    sqlx::query("SELECT 1").execute(&pool).await.map_err(|error| {
        DbTunnelError::MysqlQuery(error).user_message()
    })?;

    let mysql_id = random_id("mysql-tunnel");
    let key = session_key("mysql", &connection_id, &mysql_id);
    state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .insert(key, DatabaseTunnelSession::Mysql(MysqlTunnelSession { tunnel, pool }));

    Ok(json!({
        "mysqlId": mysql_id,
        "transport": "ssh-tunnel",
        "alreadyConnected": false
    }))
}

pub(crate) async fn mysql_databases(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let (_, pool) = mysql_pool(state, &args)?;
    let rows = sqlx::query("SHOW DATABASES").fetch_all(&pool).await
        .map_err(|error| DbTunnelError::MysqlQuery(error).user_message())?;
    let values = rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>(0).ok())
        .collect::<Vec<_>>();
    Ok(json!(values))
}

pub(crate) async fn mysql_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let (_, pool) = mysql_pool(state, &args)?;
    let sql = string_arg(&args, 2)?;
    let rows = sqlx::query(&sql).fetch_all(&pool).await
        .map_err(|error| DbTunnelError::MysqlQuery(error).user_message())?;
    Ok(rows_to_json_mysql(rows))
}

fn mysql_pool(state: &AppState, args: &[Value]) -> Result<(String, MySqlPool), String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let key = session_key("mysql", &connection_id, &session_id);
    let guard = state.database_tunnel_sessions.lock().map_err(error_string)?;
    let session = guard.get(&key).ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    match session {
        DatabaseTunnelSession::Mysql(session) => Ok((connection_id, session.pool.clone())),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "mysql",
            actual: other.kind(),
        }.user_message()),
    }
}

fn rows_to_json_mysql(rows: Vec<MySqlRow>) -> Value {
    let columns = rows
        .first()
        .map(|row| row.columns().iter().map(|column| column.name().to_string()).collect::<Vec<_>>())
        .unwrap_or_default();
    let data_rows = rows
        .into_iter()
        .map(mysql_row_to_json)
        .collect::<Vec<_>>();
    json!({
        "columns": columns,
        "rows": data_rows,
        "affectedRows": 0
    })
}

fn mysql_row_to_json(row: MySqlRow) -> Value {
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        object.insert(column.name().to_string(), mysql_value_to_json(&row, index, column.type_info().name()));
    }
    Value::Object(object)
}

fn mysql_value_to_json(row: &MySqlRow, index: usize, type_name: &str) -> Value {
    if let Ok(value) = row.try_get::<Option<i64>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(value) = row.try_get::<Option<f64>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(value) = row.try_get::<Option<bool>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(value) = row.try_get::<Option<String>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    json!(format!("<unsupported:{type_name}>"))
}

fn tunnel_config_from_options(
    state: &AppState,
    connection_id: &str,
    options: &TunnelOptions,
) -> Result<SshTunnelConfig, String> {
    let overrides = json!({
        "connectTimeoutMs": options.connect_timeout_ms.unwrap_or(15_000)
    });
    config_from_connection(
        state,
        connection_id,
        &options.remote_host,
        options.remote_port,
        Some(&overrides),
    )
}

fn validate_database_endpoint(host: &str, port: u16) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("数据库主机不能为空。".to_string());
    }
    if port == 0 {
        return Err("数据库端口必须在 1-65535 范围内。".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_tunnel_mode_only_when_explicit() {
        assert!(is_tunnel_mode(&json!({ "mode": "tunnel" })));
        assert!(is_tunnel_mode(&json!({ "mode": "TUNNEL" })));
        assert!(!is_tunnel_mode(&json!({ "mode": "cli" })));
        assert!(!is_tunnel_mode(&json!({})));
    }

    #[test]
    fn rejects_empty_database_endpoint() {
        assert!(validate_database_endpoint("", 3306).is_err());
        assert!(validate_database_endpoint("127.0.0.1", 0).is_err());
        assert!(validate_database_endpoint("127.0.0.1", 3306).is_ok());
    }

    #[test]
    fn session_key_matches_existing_database_key_shape() {
        assert_eq!(session_key("mysql", "conn-1", "mysql-1"), "mysql:conn-1:mysql-1");
    }
}
```

**Compiler note:** `MySqlPool` and `PgPool` are cheap clones. Clone pools while holding the mutex, then release the mutex before awaiting queries.

**Never do this:** hold `state.database_tunnel_sessions.lock()` across `.await`. It can deadlock the app and block unrelated DB calls.

---

### Task 2.3: PostgreSQL 隧道驱动

**Objective:** Add Postgres connect/query/list functions in `database_tunnel.rs` using the same session map.

**Code to add:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PostgresConnectConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_pg_port")]
    port: u16,
    #[serde(default = "default_pg_user")]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default = "default_pg_database")]
    database: String,
    #[serde(default)]
    tunnel: Option<TunnelOptions>,
}

fn default_pg_port() -> u16 { 5432 }
fn default_pg_user() -> String { "postgres".to_string() }
fn default_pg_database() -> String { "postgres".to_string() }

pub(crate) async fn postgres_connect(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config_value = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let config: PostgresConnectConfig = serde_json::from_value(config_value)
        .map_err(|error| format!("PostgreSQL 隧道配置无效：{error}"))?;
    let tunnel_options = config.tunnel.clone().unwrap_or(TunnelOptions {
        remote_host: config.host.clone(),
        remote_port: config.port,
        connect_timeout_ms: None,
    });
    validate_database_endpoint(&tunnel_options.remote_host, tunnel_options.remote_port)?;
    if config.user.trim().is_empty() {
        return Err("PostgreSQL 用户名不能为空。".to_string());
    }

    let tunnel_config = tunnel_config_from_options(state, &connection_id, &tunnel_options)?;
    let tunnel = create_tunnel(tunnel_config).await.map_err(|error| error.user_message())?;
    let local_addr = tunnel.local_addr();
    let dsn = format!(
        "postgres://{}:{}@{}:{}/{}",
        encode(&config.user),
        encode(&config.password),
        local_addr.ip(),
        local_addr.port(),
        encode(&config.database)
    );
    let pool = match PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&dsn)
        .await
    {
        Ok(pool) => pool,
        Err(error) => {
            let _ = tunnel.shutdown().await;
            return Err(DbTunnelError::PostgresConnect(error).user_message());
        }
    };

    let postgres_id = random_id("postgres-tunnel");
    let key = session_key("postgres", &connection_id, &postgres_id);
    state.database_tunnel_sessions.lock().map_err(error_string)?.insert(
        key,
        DatabaseTunnelSession::Postgres(PostgresTunnelSession { tunnel, pool }),
    );

    Ok(json!({
        "postgresId": postgres_id,
        "transport": "ssh-tunnel",
        "alreadyConnected": false
    }))
}

pub(crate) async fn postgres_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = postgres_pool(state, &args)?;
    let sql = string_arg(&args, 2)?;
    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
        .await
        .map_err(|error| DbTunnelError::PostgresQuery(error).user_message())?;
    Ok(rows_to_json_pg(rows))
}

fn postgres_pool(state: &AppState, args: &[Value]) -> Result<PgPool, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let key = session_key("postgres", &connection_id, &session_id);
    let guard = state.database_tunnel_sessions.lock().map_err(error_string)?;
    let session = guard.get(&key).ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    match session {
        DatabaseTunnelSession::Postgres(session) => Ok(session.pool.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "postgres",
            actual: other.kind(),
        }.user_message()),
    }
}

fn rows_to_json_pg(rows: Vec<PgRow>) -> Value {
    let columns = rows
        .first()
        .map(|row| row.columns().iter().map(|column| column.name().to_string()).collect::<Vec<_>>())
        .unwrap_or_default();
    let rows = rows
        .into_iter()
        .map(|row| {
            let mut object = Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                let value = if let Ok(value) = row.try_get::<Option<i64>, _>(index) {
                    value.map_or(Value::Null, |value| json!(value))
                } else if let Ok(value) = row.try_get::<Option<f64>, _>(index) {
                    value.map_or(Value::Null, |value| json!(value))
                } else if let Ok(value) = row.try_get::<Option<bool>, _>(index) {
                    value.map_or(Value::Null, |value| json!(value))
                } else if let Ok(value) = row.try_get::<Option<String>, _>(index) {
                    value.map_or(Value::Null, |value| json!(value))
                } else {
                    Value::Null
                };
                object.insert(column.name().to_string(), value);
            }
            Value::Object(object)
        })
        .collect::<Vec<_>>();
    json!({ "columns": columns, "rows": rows, "affectedRows": 0 })
}

#[cfg(test)]
mod postgres_tests {
    use super::*;

    #[test]
    fn parses_minimal_postgres_config() {
        let config: PostgresConnectConfig = serde_json::from_value(json!({
            "mode": "tunnel",
            "user": "postgres"
        })).unwrap();
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 5432);
        assert_eq!(config.database, "postgres");
    }
}
```

Add `postgres_databases`, `postgres_schemas`, `postgres_tables`, and `postgres_columns` by translating the existing SQL in `database.rs` from CLI parsing to `sqlx::query(...).fetch_all(...)`.

---

### Task 2.4: Redis 隧道驱动

**Objective:** Add Redis connection and command execution through `fred`.

**Code to add:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedisConnectConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_redis_port")]
    port: u16,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: u8,
    #[serde(default)]
    tunnel: Option<TunnelOptions>,
}

fn default_redis_port() -> u16 { 6379 }

pub(crate) async fn redis_connect(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config_value = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let config: RedisConnectConfig = serde_json::from_value(config_value)
        .map_err(|error| format!("Redis 隧道配置无效：{error}"))?;
    let tunnel_options = config.tunnel.clone().unwrap_or(TunnelOptions {
        remote_host: config.host.clone(),
        remote_port: config.port,
        connect_timeout_ms: None,
    });
    validate_database_endpoint(&tunnel_options.remote_host, tunnel_options.remote_port)?;

    let tunnel_config = tunnel_config_from_options(state, &connection_id, &tunnel_options)?;
    let tunnel = create_tunnel(tunnel_config).await.map_err(|error| error.user_message())?;
    let local_addr = tunnel.local_addr();
    let redis_url = if config.password.is_empty() {
        format!("redis://{}:{}/{}", local_addr.ip(), local_addr.port(), config.database)
    } else {
        format!(
            "redis://:{}@{}:{}/{}",
            encode(&config.password),
            local_addr.ip(),
            local_addr.port(),
            config.database
        )
    };

    let redis_config = RedisConfig::from_url(&redis_url)
        .map_err(|error| format!("Redis URL 无效：{error}"))?;
    let client = RedisClient::new(redis_config, None, None, None);
    client.connect();
    if let Err(error) = client.wait_for_connect().await {
        let _ = tunnel.shutdown().await;
        return Err(DbTunnelError::RedisConnect(error.to_string()).user_message());
    }

    let redis_id = random_id("redis-tunnel");
    let key = session_key("redis", &connection_id, &redis_id);
    state.database_tunnel_sessions.lock().map_err(error_string)?.insert(
        key,
        DatabaseTunnelSession::Redis(RedisTunnelSession { tunnel, client }),
    );
    Ok(json!({ "redisId": redis_id, "transport": "ssh-tunnel", "alreadyConnected": false }))
}

pub(crate) async fn redis_command(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let client = redis_client(state, &args)?;
    let command = string_arg(&args, 2)?;
    let values = args
        .get(3)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(ToString::to_string))
        .collect::<Vec<_>>();
    let frame: RedisValue = client
        .custom(command, values)
        .await
        .map_err(|error| DbTunnelError::RedisCommand(error.to_string()).user_message())?;
    Ok(redis_value_to_json(frame))
}

fn redis_client(state: &AppState, args: &[Value]) -> Result<RedisClient, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let key = session_key("redis", &connection_id, &session_id);
    let guard = state.database_tunnel_sessions.lock().map_err(error_string)?;
    let session = guard.get(&key).ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    match session {
        DatabaseTunnelSession::Redis(session) => Ok(session.client.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "redis",
            actual: other.kind(),
        }.user_message()),
    }
}

fn redis_value_to_json(value: RedisValue) -> Value {
    match value {
        RedisValue::Null => Value::Null,
        RedisValue::Boolean(value) => json!(value),
        RedisValue::Integer(value) => json!(value),
        RedisValue::Double(value) => json!(value),
        RedisValue::String(value) => json!(value.to_string()),
        RedisValue::Array(values) => Value::Array(values.into_iter().map(redis_value_to_json).collect()),
        other => json!(other.to_string()),
    }
}

#[cfg(test)]
mod redis_tests {
    use super::*;

    #[test]
    fn parses_redis_defaults() {
        let config: RedisConnectConfig = serde_json::from_value(json!({ "mode": "tunnel" })).unwrap();
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 6379);
        assert_eq!(config.database, 0);
    }
}
```

Implement `redis_scan`, `redis_keys`, `redis_get_value`, `redis_set_value`, and `redis_delete_key` with the existing frontend result shape in `vite-env.d.ts`.

---

### Task 2.5: ClickHouse 隧道驱动

**Objective:** Use tunnel local address with ClickHouse HTTP client. The remote port defaults to `8123`, not native TCP `9000`.

**Code example:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickHouseConnectConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_clickhouse_port")]
    port: u16,
    #[serde(default = "default_clickhouse_user")]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    tunnel: Option<TunnelOptions>,
}

fn default_clickhouse_port() -> u16 { 8123 }
fn default_clickhouse_user() -> String { "default".to_string() }

pub(crate) async fn clickhouse_connect(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config_value = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let config: ClickHouseConnectConfig = serde_json::from_value(config_value)
        .map_err(|error| format!("ClickHouse 隧道配置无效：{error}"))?;
    let tunnel_options = config.tunnel.clone().unwrap_or(TunnelOptions {
        remote_host: config.host.clone(),
        remote_port: config.port,
        connect_timeout_ms: None,
    });
    validate_database_endpoint(&tunnel_options.remote_host, tunnel_options.remote_port)?;

    let tunnel_config = tunnel_config_from_options(state, &connection_id, &tunnel_options)?;
    let tunnel = create_tunnel(tunnel_config).await.map_err(|error| error.user_message())?;
    let local_addr = tunnel.local_addr();
    let url = format!("http://{}:{}", local_addr.ip(), local_addr.port());
    let mut client = clickhouse::Client::default()
        .with_url(url)
        .with_user(config.user)
        .with_password(config.password);
    if let Some(database) = config.database.as_deref().filter(|value| !value.is_empty()) {
        client = client.with_database(database);
    }
    #[derive(Debug, serde::Deserialize, clickhouse::Row)]
    struct PingRow {
        ok: u8,
    }

    let ping_result = client.query("SELECT 1 AS ok").fetch_one::<PingRow>().await;
    if let Err(error) = ping_result {
        let _ = tunnel.shutdown().await;
        return Err(DbTunnelError::ClickHouseConnect(error.to_string()).user_message());
    }

    let clickhouse_id = random_id("clickhouse-tunnel");
    let key = session_key("clickhouse", &connection_id, &clickhouse_id);
    state.database_tunnel_sessions.lock().map_err(error_string)?.insert(
        key,
        DatabaseTunnelSession::ClickHouse(ClickHouseTunnelSession { tunnel, client }),
    );
    Ok(json!({ "clickhouseId": clickhouse_id, "transport": "ssh-tunnel", "alreadyConnected": false }))
}
```

---

## Phase 3: IPC 集成 (P1)

### Task 3.1: 精确定义 IPC contract

**Objective:** Preserve existing channel names. Add `mode` and `tunnel` fields to connect configs only.

**Channels:**

| Channel | Args | Tunnel behavior | Return |
|---|---|---|---|
| `connection:mysql-connect` | `[connectionId: string, config: ShellDeskMysqlConnectConfig]` | if `config.mode === "tunnel"` calls `database_tunnel::mysql_connect`; otherwise existing CLI | `{ mysqlId: string, transport: "ssh-exec" \| "ssh-tunnel", alreadyConnected?: boolean }` |
| `connection:mysql-disconnect` | `[connectionId, mysqlId]` | first tries tunnel session map, then CLI map | `boolean` |
| `connection:mysql-databases` | `[connectionId, mysqlId]` | route by session id existing in tunnel map | `string[]` |
| `connection:mysql-tables` | `[connectionId, mysqlId, database]` | route by session id | `string[]` |
| `connection:mysql-columns` | `[connectionId, mysqlId, database, table]` | route by session id | `ShellDeskMysqlColumn[]` |
| `connection:mysql-query` | `[connectionId, mysqlId, sql, database?]` | route by session id | `ShellDeskMysqlQueryResult` |
| `connection:postgres-*` | existing args | same pattern | existing result shapes |
| `connection:redis-*` | existing args | same pattern | existing result shapes |
| `connection:clickhouse-*` | existing args | same pattern | existing result shapes |

**Message format examples:**

```json
{
  "channel": "connection:mysql-connect",
  "args": [
    "conn-abc",
    {
      "mode": "tunnel",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "app",
      "password": "db-password",
      "database": "appdb",
      "tunnel": {
        "remoteHost": "127.0.0.1",
        "remotePort": 3306,
        "connectTimeoutMs": 15000
      }
    }
  ]
}
```

```json
{
  "mysqlId": "mysql-tunnel-1710000000-abcd1234",
  "transport": "ssh-tunnel",
  "alreadyConnected": false
}
```

**Rust dispatch integration:**

```rust
// src-tauri/src/ipc/database_channels.rs
pub(crate) fn is_database_channel(channel: &str) -> bool {
    channel.starts_with("connection:mysql-")
        || channel.starts_with("connection:postgres-")
        || channel.starts_with("connection:redis-")
        || channel.starts_with("connection:sqlite-")
        || channel.starts_with("connection:clickhouse-")
        || channel.starts_with("connection:mongo-")
}
```

No new `db:tunnel:*` prefix is required.

---

### Task 3.2: 与 existing database.rs 集成

**Objective:** Keep current CLI implementation intact. Route tunnel sessions at the top of existing functions.

**Files:**
- Modify: `src-tauri/src/database.rs`
- Modify: `src-tauri/src/ipc/database_channels.rs` only if extra dispatch is unavoidable

**Connect routing example:**

```rust
// src-tauri/src/database.rs
pub(crate) async fn mysql_connect(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    if crate::database_tunnel::is_tunnel_mode(&config) {
        return crate::database_tunnel::mysql_connect(state, args).await;
    }

    let connection_id = string_arg(&args, 0)?;
    let mysql_id = encode_config_id("mysql", &config)?;
    let _ = run_mysql_cli(state, &connection_id, &config, "SELECT 1 AS ok;", None).await?;
    register_db_session(state, "mysql", &connection_id, &mysql_id, config)?;
    Ok(json!({
        "mysqlId": mysql_id,
        "transport": "ssh-exec"
    }))
}
```

**Query/list routing example:**

```rust
pub(crate) async fn mysql_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "mysql", &args)? {
        return crate::database_tunnel::mysql_query(state, args).await;
    }

    let (connection_id, config) = decode_active_db_session_args(state, "mysql", &args, 0, 1)?;
    // existing CLI implementation continues unchanged...
}
```

**Add helper in database_tunnel.rs:**

```rust
pub(crate) fn has_session(state: &AppState, kind: &str, args: &[Value]) -> Result<bool, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let key = session_key(kind, &connection_id, &session_id);
    Ok(state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .contains_key(&key))
}
```

**Disconnect routing example:**

```rust
pub(crate) fn disconnect_db_session(
    state: &AppState,
    args: Vec<Value>,
    kind: &str,
) -> Result<Value, String> {
    // Keep this function sync only for CLI. Add a new async wrapper or make callers async.
    // Recommended: change database_channels disconnect arms to call:
    // database::disconnect_db_session_any(state, args, "mysql").await
}

pub(crate) async fn disconnect_db_session_any(
    state: &AppState,
    args: Vec<Value>,
    kind: &'static str,
) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, kind, &args)? {
        return crate::database_tunnel::disconnect(state, args, kind).await;
    }
    disconnect_db_session(state, args, kind)
}
```

**Integration with ssh_transport.rs:**

- Do not use `start_ssh_local_forward` for the new native path; it shells out to `ssh` and was designed for process-backed forwarding.
- Reuse `ssh_transport.rs` concepts only where they match:
  - `SshProfile` auth fields and known_hosts path from `state.rs`.
  - Existing `proxy`/`jump` limitations must be explicit.
  - `wait_for_tcp` is not needed because `create_tunnel` returns after the listener is bound.
- Keep `start_ssh_local_forward` for existing VNC/browser/proxy features.

---

## Phase 4: 前端 UI (P1)

### Task 4.1: TypeScript 类型定义

**Objective:** Extend existing connect config types in `src/vite-env.d.ts` without changing method names.

**Files:**
- Modify: `src/vite-env.d.ts`

```ts
type ShellDeskDatabaseTransportMode = 'cli' | 'tunnel';

interface ShellDeskDatabaseTunnelConfig {
  remoteHost: string;
  remotePort: number;
  connectTimeoutMs?: number;
}

interface ShellDeskMysqlConnectConfig {
  mode?: ShellDeskDatabaseTransportMode;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  tunnel?: ShellDeskDatabaseTunnelConfig;
}

interface ShellDeskMysqlConnectResult {
  mysqlId: string;
  transport?: 'ssh-exec' | 'ssh-tunnel';
  alreadyConnected?: boolean;
}

interface ShellDeskPostgresConnectConfig {
  mode?: ShellDeskDatabaseTransportMode;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  tunnel?: ShellDeskDatabaseTunnelConfig;
}

interface ShellDeskRedisConnectConfig {
  mode?: ShellDeskDatabaseTransportMode;
  host?: string;
  port?: number;
  password?: string;
  database?: number;
  tunnel?: ShellDeskDatabaseTunnelConfig;
}

interface ShellDeskClickHouseConnectConfig {
  mode?: ShellDeskDatabaseTransportMode;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  tunnel?: ShellDeskDatabaseTunnelConfig;
}
```

No `tauriBridge.ts` method changes are required unless current config interfaces reject the new fields.

---

### Task 4.2: Frontend component examples

**Objective:** Add a reusable tunnel section and wire it into MySQL/Postgres/Redis/ClickHouse forms.

**Files:**
- Create: `src/components/remote-desktop/DatabaseTunnelFields.tsx`
- Modify: `src/components/remote-desktop/RemoteMySQL.tsx`
- Modify: `src/components/remote-desktop/RemotePostgres.tsx`
- Modify: `src/components/remote-desktop/RemoteRedis.tsx`
- Modify: `src/components/remote-desktop/RemoteClickHouse.tsx` if present

**Reusable component:**

```tsx
// src/components/remote-desktop/DatabaseTunnelFields.tsx
import { useMemo } from 'react';

export interface DatabaseTunnelFormValue {
  enabled: boolean;
  remoteHost: string;
  remotePort: string;
  connectTimeoutMs: string;
}

interface DatabaseTunnelFieldsProps {
  value: DatabaseTunnelFormValue;
  defaultPort: number;
  onChange: (next: DatabaseTunnelFormValue) => void;
}

export function createDefaultTunnelValue(defaultPort: number): DatabaseTunnelFormValue {
  return {
    enabled: false,
    remoteHost: '127.0.0.1',
    remotePort: String(defaultPort),
    connectTimeoutMs: '15000',
  };
}

export function parseTunnelValue(value: DatabaseTunnelFormValue, fallbackPort: number): ShellDeskDatabaseTunnelConfig | undefined {
  if (!value.enabled) return undefined;
  const remotePort = Number.parseInt(value.remotePort, 10) || fallbackPort;
  const connectTimeoutMs = Number.parseInt(value.connectTimeoutMs, 10) || 15000;
  return {
    remoteHost: value.remoteHost.trim() || '127.0.0.1',
    remotePort,
    connectTimeoutMs,
  };
}

export function DatabaseTunnelFields({ value, defaultPort, onChange }: DatabaseTunnelFieldsProps) {
  const portInvalid = useMemo(() => {
    const port = Number.parseInt(value.remotePort, 10);
    return value.enabled && (!Number.isInteger(port) || port < 1 || port > 65535);
  }, [value.enabled, value.remotePort]);

  return (
    <section className="database-tunnel-fields">
      <label className="form-check">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.currentTarget.checked })}
        />
        <span>使用 SSH 隧道</span>
      </label>

      {value.enabled && (
        <div className="database-tunnel-grid">
          <label>
            <span>远程数据库主机</span>
            <input
              value={value.remoteHost}
              placeholder="127.0.0.1"
              onChange={(event) => onChange({ ...value, remoteHost: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>远程数据库端口</span>
            <input
              value={value.remotePort}
              inputMode="numeric"
              placeholder={String(defaultPort)}
              aria-invalid={portInvalid}
              onChange={(event) => onChange({ ...value, remotePort: event.currentTarget.value })}
            />
          </label>
          <label>
            <span>连接超时 ms</span>
            <input
              value={value.connectTimeoutMs}
              inputMode="numeric"
              placeholder="15000"
              onChange={(event) => onChange({ ...value, connectTimeoutMs: event.currentTarget.value })}
            />
          </label>
        </div>
      )}
    </section>
  );
}
```

**MySQL integration example:**

```tsx
// RemoteMySQL.tsx
import {
  DatabaseTunnelFields,
  createDefaultTunnelValue,
  parseTunnelValue,
  type DatabaseTunnelFormValue,
} from './DatabaseTunnelFields';

const defaultPort = 3306;
const [tunnel, setTunnel] = useState<DatabaseTunnelFormValue>(() => createDefaultTunnelValue(defaultPort));

// In form JSX near host/port fields:
<DatabaseTunnelFields value={tunnel} defaultPort={defaultPort} onChange={setTunnel} />

// In handleConnect:
const parsedPort = Number.parseInt(port, 10) || defaultPort;
const tunnelConfig = parseTunnelValue(tunnel, parsedPort);
const result = await api.connections.mysqlConnect(connectionId, {
  mode: tunnel.enabled ? 'tunnel' : 'cli',
  host: host || '127.0.0.1',
  port: parsedPort,
  user: user || 'root',
  password,
  database: initialDatabase.trim() || undefined,
  tunnel: tunnelConfig,
});
```

**Profile persistence update:**

Persist non-secret tunnel fields with existing `saveRemoteConnectionProfile`. Do not save DB password unless current app setting already allows password persistence.

```tsx
void saveRemoteConnectionProfile(hostId, 'mysql', {
  host: host || '127.0.0.1',
  port: String(parsedPort),
  user: user || 'root',
  password,
  initialDatabase: initialDatabase.trim(),
  mode: tunnel.enabled ? 'tunnel' : 'cli',
  tunnelRemoteHost: tunnel.remoteHost,
  tunnelRemotePort: tunnel.remotePort,
  tunnelConnectTimeoutMs: tunnel.connectTimeoutMs,
}).catch(() => undefined);
```

**SCSS example:**

```scss
.database-tunnel-fields {
  display: grid;
  gap: 10px;
}

.database-tunnel-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 720px) {
  .database-tunnel-grid {
    grid-template-columns: 1fr;
  }
}
```

---

## Phase 5: 与现有 CLI 模式共存 (P2)

### Task 5.1: 模式切换机制

**Objective:** Preserve behavior for all existing saved profiles. `mode` defaults to `"cli"` when absent.

**Config shape:**

```json
{
  "mode": "tunnel",
  "host": "127.0.0.1",
  "port": 3306,
  "user": "app",
  "password": "db-password",
  "database": "appdb",
  "tunnel": {
    "remoteHost": "127.0.0.1",
    "remotePort": 3306,
    "connectTimeoutMs": 15000
  }
}
```

**Routing rules:**

- Connect functions decide by `config.mode`.
- Non-connect functions decide by session ID presence in `database_tunnel_sessions`.
- Disconnect checks tunnel map first, then CLI map.
- Frontend still calls `mysqlConnect`, `mysqlQuery`, etc. No new public method names.
- If tunnel mode fails because SSH proxy/jump profile is unsupported, show the backend error and keep the form in disconnected state.

---

## Testing Strategy

Run focused Rust tests during implementation:

```bash
cd /root/ShellDesk/src-tauri
cargo test ssh_tunnel
cargo test database_tunnel
cargo test --all
```

Run project checks:

```bash
cd /root/ShellDesk
pnpm typecheck
pnpm test
```

### Unit tests by module

`ssh_tunnel.rs`:

- `SshTunnelConfig::validate` rejects missing host, user, remote host, zero ports, missing auth.
- key path validation rejects missing files.
- `create_tunnel` returns `SshConnect` for unreachable localhost port with short timeout.

`database_tunnel.rs`:

- `is_tunnel_mode` is case-insensitive and defaults false.
- JSON config parsing applies expected defaults per database.
- session key matches `"{kind}:{connection_id}:{session_id}"`.
- `has_session` returns false when map is empty.
- Redis/SQL row conversion helpers handle null/string/int/bool/float.

`database.rs` integration:

- `mysql_connect` routes to CLI when `mode` absent.
- `mysql_connect` routes to tunnel when `mode: "tunnel"` by injecting a test-only stub or factoring route decision into a pure helper.
- `disconnect_db_session_any` removes tunnel sessions before CLI sessions.

### Integration tests

Use `.env` only when present and never print password:

```bash
SHELLDESK_TEST_SSH_HOST=...
SHELLDESK_TEST_SSH_PORT=22
SHELLDESK_TEST_SSH_USERNAME=...
SHELLDESK_TEST_SSH_PASSWORD=...
SHELLDESK_TEST_MYSQL_HOST=127.0.0.1
SHELLDESK_TEST_MYSQL_PORT=3306
```

Test flow:

1. Create ShellDesk SSH connection from `.env`.
2. Call `connection:mysql-connect` with `mode: "tunnel"`.
3. Assert return `transport === "ssh-tunnel"`.
4. Call `connection:mysql-query` with `SELECT 1 AS ok`.
5. Assert `rows[0].ok === 1`.
6. Disconnect and assert the tunnel session map is empty in a test-only inspection helper.

Skip integration tests when required `.env` variables are missing.

### Frontend tests

- Typecheck verifies new config types.
- Component tests, if added later, should assert:
  - disabled tunnel mode omits `tunnel`.
  - enabled tunnel mode sends `mode: "tunnel"` and numeric `remotePort`.
  - invalid port sets `aria-invalid`.

---

## 实现阶段总结

| 阶段 | 内容 | 工作量 | 优先级 |
|------|------|--------|--------|
| Phase 1 | SSH 隧道核心模块、验证、基础测试 | 2-3 天 | P0 |
| Phase 2 | MySQL/Postgres/Redis/ClickHouse native driver | 3-5 天 | P0 |
| Phase 3 | IPC 路由和 `database.rs` 共存 | 1-2 天 | P1 |
| Phase 4 | 前端 UI、类型、样式、profile persistence | 2-3 天 | P1 |
| Phase 5 | 兼容性、回退、集成测试 | 1-2 天 | P2 |
| **总计** | | **~9-15 天** | |

---

## Known Pitfalls and Solutions

1. **russh API drift**
   - Symptom: `channel_open_direct_tcpip` or key loading code does not compile.
   - Solution: Keep `SshTunnel` public API stable and adjust only `forward_one`/auth implementation to selected `russh` version.

2. **Host key verification accidentally disabled**
   - Symptom: tunnel works but bypasses ShellDesk known_hosts trust model.
   - Solution: Phase 1 may temporarily `Ok(true)` only behind an explicit TODO. Before release, integrate `known_hosts_path` or reuse `connection.rs` host-key prompt flow.

3. **SSH proxy/jump profiles do not work**
   - Symptom: CLI connection works, tunnel mode cannot connect.
   - Solution: reject with a clear error for v1 or implement russh transport through the same proxy/jump chain. Do not silently fall back to a direct SSH connection.

4. **Holding mutex across await**
   - Symptom: UI freezes or unrelated DB calls hang.
   - Solution: clone `MySqlPool`/`PgPool`/`RedisClient` while locked, drop guard, then await.

5. **Password leaks in logs**
   - Symptom: DSN appears in errors.
   - Solution: never include full DSN in error messages. Use `DbTunnelError` wrappers and redact configs before logging.

6. **Wrong remote host semantics**
   - Symptom: user enters the public DB hostname but DB is only bound to loopback on SSH server.
   - Solution: UI label must say “远程数据库主机”, default to `127.0.0.1`, and explain in docs that it is resolved from the SSH server.

7. **ClickHouse wrong port**
   - Symptom: ClickHouse connect times out on `9000`.
   - Solution: `clickhouse` crate uses HTTP; default tunnel remote port is `8123`.

8. **Connection pool overload through one tunnel**
   - Symptom: query latency spikes or server refuses channels.
   - Solution: cap pools to `max_connections(5)` initially; expose advanced setting later if needed.

9. **Disconnect returns before tunnel fully closes**
   - Symptom: local port remains briefly occupied.
   - Solution: call pool/client close first, then tunnel shutdown. For UI, returning after scheduling shutdown is acceptable, but tests should wait until map removal is complete.

10. **Existing saved profiles break**
    - Symptom: old DB profiles fail after type changes.
    - Solution: `mode` defaults to `"cli"` and all new fields are optional.

11. **Redis command serialization differences**
    - Symptom: frontend expects strings but `fred` returns typed frames.
    - Solution: centralize conversion in `redis_value_to_json` and match current `RemoteRedis.tsx` result shape.

12. **SQL write metadata differs from CLI mode**
    - Symptom: affected rows/insert id missing for MySQL updates.
    - Solution: use `sqlx::query(...).execute(...)` for detected write statements and map `rows_affected()`/`last_insert_id()` to existing frontend shape.

---

## 参考资源

- [russh docs](https://docs.rs/russh)
- [russh 0.61.2 Cargo metadata](https://docs.rs/crate/russh/0.61.2/source/Cargo.toml.orig) - 当前 ShellDesk 使用版本，要求 Rust 1.85+
- [russh latest crates.io metadata](https://crates.io/crates/russh) - 升级前必须复核 MSRV
- [russh examples](https://github.com/Eugeny/russh/tree/main/russh/examples)
- [sqlx docs](https://docs.rs/sqlx)
- [fred docs](https://docs.rs/fred)
- [clickhouse crate docs](https://docs.rs/clickhouse)
