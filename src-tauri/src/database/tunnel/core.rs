use crate::{
    error_string, get_connection, pick_free_local_port,
    ssh_tunnel::{
        config_from_connection_with_window, create_tunnel, SshTunnel, SshTunnelConfig,
        SshTunnelError,
    },
    start_ssh_local_forward, string_arg, wait_for_tcp, AppState,
};
use fred::prelude::{Client as RedisClient, ClientLike};
use mongodb::Client as MongoClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{MySqlPool, PgPool};
use std::{
    process::Child as StdChild,
    time::{Duration, Instant},
};
use tauri::Emitter;
use thiserror::Error;

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Error)]
pub(crate) enum DbTunnelError {
    // TODO(i18n): Return stable error codes here and localize backend messages in the frontend.
    #[error(transparent)]
    Tunnel(#[from] SshTunnelError),
    #[error("MySQL 连接失败：{0}")]
    MysqlConnect(#[source] sqlx::Error),
    #[error("MySQL 查询失败：{0}")]
    MysqlQuery(#[source] sqlx::Error),
    #[error("PostgreSQL 连接失败：{0}")]
    PostgresConnect(#[source] sqlx::Error),
    #[error("PostgreSQL 查询失败：{0}")]
    PostgresQuery(#[source] sqlx::Error),
    #[error("ClickHouse 连接失败：{0}")]
    ClickHouseConnect(String),
    #[error("ClickHouse 查询失败：{0}")]
    ClickHouseQuery(String),
    #[error("MongoDB 连接失败：{0}")]
    MongoConnect(String),
    #[error("MongoDB 查询失败：{0}")]
    MongoQuery(String),
    #[error("Redis 连接失败：{0}")]
    RedisConnect(String),
    #[error("Redis 命令失败：{0}")]
    RedisCommand(String),
    #[error("查询超时，请检查网络或优化查询")]
    QueryTimeout,
    #[error("数据库连接已断开。")]
    SessionNotFound,
    #[error("会话类型不匹配，期望 {expected}，实际 {actual}。")]
    SessionKindMismatch {
        expected: &'static str,
        actual: &'static str,
    },
}

impl DbTunnelError {
    pub(crate) fn user_message(&self) -> String {
        redact_credentials(&self.to_string())
    }
}

pub(crate) enum DatabaseTunnelSession {
    Mysql(MysqlTunnelSession),
    Postgres(PostgresTunnelSession),
    Redis(RedisTunnelSession),
    ClickHouse(ClickHouseTunnelSession),
    Mongo(MongoTunnelSession),
}

impl DatabaseTunnelSession {
    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::Mysql(_) => "mysql",
            Self::Postgres(_) => "postgres",
            Self::Redis(_) => "redis",
            Self::ClickHouse(_) => "clickhouse",
            Self::Mongo(_) => "mongo",
        }
    }

    pub(crate) fn last_activity(&self) -> Instant {
        match self {
            Self::Mysql(session) => session.last_activity,
            Self::Postgres(session) => session.last_activity,
            Self::Redis(session) => session.last_activity,
            Self::ClickHouse(session) => session.last_activity,
            Self::Mongo(session) => session.last_activity,
        }
    }

    pub(crate) fn touch(&mut self) {
        let now = Instant::now();
        match self {
            Self::Mysql(session) => session.last_activity = now,
            Self::Postgres(session) => session.last_activity = now,
            Self::Redis(session) => session.last_activity = now,
            Self::ClickHouse(session) => session.last_activity = now,
            Self::Mongo(session) => session.last_activity = now,
        }
    }

    pub(crate) async fn shutdown(self) {
        match self {
            Self::Mysql(session) => session.shutdown().await,
            Self::Postgres(session) => session.shutdown().await,
            Self::Redis(session) => session.shutdown().await,
            Self::ClickHouse(session) => session.shutdown().await,
            Self::Mongo(session) => session.shutdown().await,
        }
    }
}

pub(crate) struct MysqlTunnelSession {
    pub(super) tunnel: Option<DatabaseSshTunnel>,
    pub(super) pool: MySqlPool,
    pub(super) last_activity: Instant,
}

pub(crate) struct PostgresTunnelSession {
    pub(super) tunnel: Option<DatabaseSshTunnel>,
    pub(super) pool: PgPool,
    pub(super) last_activity: Instant,
}

pub(crate) struct RedisTunnelSession {
    pub(super) tunnel: Option<DatabaseSshTunnel>,
    pub(super) client: RedisClient,
    pub(super) last_activity: Instant,
}

pub(crate) struct ClickHouseTunnelSession {
    pub(super) tunnel: Option<DatabaseSshTunnel>,
    pub(super) client: clickhouse::Client,
    pub(super) last_activity: Instant,
}

pub(crate) struct MongoTunnelSession {
    pub(super) tunnel: Option<DatabaseSshTunnel>,
    pub(super) client: MongoClient,
    pub(super) last_activity: Instant,
}

pub(super) enum DatabaseSshTunnel {
    Native(SshTunnel),
    OpenSsh(StdChild),
}

pub(super) struct DatabaseSshEndpoint {
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) tunnel: DatabaseSshTunnel,
    pub(super) transport: &'static str,
}

impl DatabaseSshTunnel {
    pub(super) async fn shutdown(self) {
        match self {
            Self::Native(tunnel) => {
                let _ = tunnel.shutdown().await;
            }
            Self::OpenSsh(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl MysqlTunnelSession {
    async fn shutdown(self) {
        self.pool.close().await;
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

impl PostgresTunnelSession {
    async fn shutdown(self) {
        self.pool.close().await;
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

impl RedisTunnelSession {
    async fn shutdown(self) {
        let _ = self.client.quit().await;
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

impl ClickHouseTunnelSession {
    async fn shutdown(self) {
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

impl MongoTunnelSession {
    async fn shutdown(self) {
        self.client.shutdown().await;
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelOptions {
    pub(crate) remote_host: String,
    pub(crate) remote_port: u16,
    #[serde(default)]
    pub(crate) connect_timeout_ms: Option<u64>,
    #[serde(default)]
    pub(crate) ssh_host: Option<String>,
    #[serde(default)]
    pub(crate) ssh_port: Option<u16>,
    #[serde(default)]
    pub(crate) ssh_user: Option<String>,
    #[serde(default)]
    pub(crate) ssh_password: Option<String>,
    #[serde(default)]
    pub(crate) ssh_key_path: Option<String>,
    #[serde(default)]
    pub(crate) ssh_key_passphrase: Option<String>,
    #[serde(default)]
    pub(crate) known_hosts_path: Option<String>,
}

impl TunnelOptions {
    pub(super) fn for_database_endpoint(remote_host: String, remote_port: u16) -> Self {
        Self {
            remote_host,
            remote_port,
            connect_timeout_ms: None,
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_password: None,
            ssh_key_path: None,
            ssh_key_passphrase: None,
            known_hosts_path: None,
        }
    }
}

pub(super) fn session_key(kind: &str, connection_id: &str, session_id: &str) -> String {
    format!("{kind}:{connection_id}:{session_id}")
}

pub(crate) fn is_tunnel_mode(config: &Value) -> bool {
    config
        .get("mode")
        .and_then(Value::as_str)
        .is_some_and(|mode| mode.eq_ignore_ascii_case("tunnel"))
}

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
        let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, session.shutdown()).await;
    }
    Ok(json!(true))
}

pub(crate) fn start_idle_cleanup(state: AppState, app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(CLEANUP_INTERVAL).await;
            cleanup_idle_sessions(&state, &app).await;
        }
    });
}

async fn cleanup_idle_sessions(state: &AppState, app: &tauri::AppHandle) {
    let now = Instant::now();
    let expired_keys: Vec<String> = {
        let sessions = match state.database_tunnel_sessions.lock() {
            Ok(sessions) => sessions,
            Err(_) => return,
        };
        sessions
            .iter()
            .filter(|(_, session)| now.duration_since(session.last_activity()) > IDLE_TIMEOUT)
            .map(|(key, _)| key.clone())
            .collect()
    };

    for key in expired_keys {
        let session = match state.database_tunnel_sessions.lock() {
            Ok(mut sessions) => {
                let removal_now = Instant::now();
                let is_still_expired = sessions.get(&key).is_some_and(|session| {
                    removal_now.duration_since(session.last_activity()) > IDLE_TIMEOUT
                });
                if is_still_expired {
                    sessions.remove(&key)
                } else {
                    None
                }
            }
            Err(_) => continue,
        };
        if let Some(session) = session {
            let parts = key.splitn(3, ':').collect::<Vec<_>>();
            let kind = parts.first().copied().unwrap_or("unknown").to_string();
            let session_id = parts.get(2).copied().unwrap_or("unknown").to_string();

            eprintln!("[database-tunnel] idle timeout: disconnecting {key}");

            let _ = app.emit(
                "database:tunnel-idle-timeout",
                json!({
                    "key": key,
                    "kind": kind,
                    "sessionId": session_id,
                    "idleMinutes": IDLE_TIMEOUT.as_secs() / 60,
                }),
            );

            let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, session.shutdown()).await;
        }
    }
}

pub(super) async fn open_database_ssh_tunnel(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
    options: &TunnelOptions,
) -> Result<DatabaseSshEndpoint, String> {
    let tunnel_config = tunnel_config_from_options(state, window, connection_id, options).await?;
    match create_tunnel(tunnel_config).await {
        Ok(tunnel) => {
            let local_addr = tunnel.local_addr();
            Ok(DatabaseSshEndpoint {
                host: local_addr.ip().to_string(),
                port: local_addr.port(),
                tunnel: DatabaseSshTunnel::Native(tunnel),
                transport: "ssh-tunnel",
            })
        }
        Err(native_error) => {
            eprintln!(
                "[database] Native SSH tunnel unavailable, trying OpenSSH local forward: {}",
                native_error.user_message()
            );
            open_database_openssh_forward(state, connection_id, options, native_error).await
        }
    }
}

async fn open_database_openssh_forward(
    state: &AppState,
    connection_id: &str,
    options: &TunnelOptions,
    native_error: SshTunnelError,
) -> Result<DatabaseSshEndpoint, String> {
    let profile = get_connection(state, connection_id)?
        .ssh
        .ok_or_else(|| "当前连接缺少 SSH 配置。".to_string())?;
    let local_port = pick_free_local_port()?;
    let mut child = start_ssh_local_forward(
        &profile,
        local_port,
        &options.remote_host,
        options.remote_port,
    )
    .map_err(|error| {
        format!(
            "{}；OpenSSH 本地转发启动失败：{}",
            native_error.user_message(),
            error
        )
    })?;
    if let Err(error) = wait_for_tcp("127.0.0.1", local_port, Duration::from_secs(8)).await {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "{}；OpenSSH 本地转发不可用：{}",
            native_error.user_message(),
            error
        ));
    }
    Ok(DatabaseSshEndpoint {
        host: "127.0.0.1".to_string(),
        port: local_port,
        tunnel: DatabaseSshTunnel::OpenSsh(child),
        transport: "ssh-forward",
    })
}

async fn tunnel_config_from_options(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
    options: &TunnelOptions,
) -> Result<SshTunnelConfig, String> {
    let overrides = json!({
        "connectTimeoutMs": options.connect_timeout_ms.unwrap_or(15_000),
        "sshHost": options.ssh_host.as_deref().unwrap_or(""),
        "sshPort": options.ssh_port.unwrap_or(22),
        "sshUser": options.ssh_user.as_deref().unwrap_or(""),
        "sshPassword": options
            .ssh_key_passphrase
            .as_deref()
            .or(options.ssh_password.as_deref())
            .unwrap_or(""),
        "sshKeyPath": options.ssh_key_path.as_deref().unwrap_or(""),
        "knownHostsPath": options.known_hosts_path.as_deref().unwrap_or("")
    });
    config_from_connection_with_window(
        state,
        window,
        connection_id,
        &options.remote_host,
        options.remote_port,
        Some(&overrides),
    )
    .await
}

pub(super) fn validate_database_endpoint(host: &str, port: u16) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("数据库主机不能为空。".to_string());
    }
    if port == 0 {
        return Err("数据库端口必须在 1-65535 范围内。".to_string());
    }
    Ok(())
}

fn redact_credentials(message: &str) -> String {
    let schemes = [
        "mysql://",
        "postgres://",
        "postgresql://",
        "redis://",
        "mongodb://",
        "mongodb+srv://",
    ];
    let mut output = String::with_capacity(message.len());
    let mut cursor = 0;

    while cursor < message.len() {
        let next_match = schemes
            .iter()
            .filter_map(|scheme| message[cursor..].find(scheme).map(|index| cursor + index))
            .min();
        let Some(start) = next_match else {
            output.push_str(&message[cursor..]);
            break;
        };
        output.push_str(&message[cursor..start]);
        let end = message[start..]
            .find(|character: char| character.is_whitespace() || matches!(character, '"' | '\''))
            .map(|index| start + index)
            .unwrap_or(message.len());
        let candidate = &message[start..end];
        output.push_str(&redact_url_credentials(candidate));
        cursor = end;
    }

    output
}

fn redact_url_credentials(candidate: &str) -> String {
    let mut trimmed_end = candidate.len();
    while trimmed_end > 0
        && matches!(
            candidate.as_bytes()[trimmed_end - 1] as char,
            '.' | ',' | ';' | ')' | ']'
        )
    {
        trimmed_end -= 1;
    }
    let (url_part, suffix) = candidate.split_at(trimmed_end);
    let Ok(mut url) = url::Url::parse(url_part) else {
        return candidate.to_string();
    };
    if url.username().is_empty() && url.password().is_none() {
        return candidate.to_string();
    }
    if !url.username().is_empty() {
        let _ = url.set_username("redacted");
    }
    if url.password().is_some() {
        let _ = url.set_password(Some("redacted"));
    }
    format!("{url}{suffix}")
}
