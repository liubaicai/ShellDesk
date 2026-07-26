use russh::client;
use serde::Deserialize;
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
    sync::mpsc,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::{
    connection::ensure_ssh_profile_host_key_trusted,
    get_connection,
    proxy::SshProxyConfig,
    russh_client::{
        authenticate_profile, configure_tcp_keepalive, keepalive_interval_from_settings,
        ssh_authentication_kind, SshAuthenticationKind,
    },
    russh_transport_io::{
        proxy_command_template, proxy_helper_command, RusshTransport as TunnelTransport,
    },
    AppState, ConnectionKind, SshProfile, UiWindowRef,
};
use serde_json::Value;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshTunnelConfig {
    pub(crate) ssh_host: String,
    pub(crate) ssh_port: u16,
    pub(crate) ssh_user: String,
    #[serde(default = "default_auth_method")]
    pub(crate) ssh_auth_method: String,
    pub(crate) ssh_password: Option<String>,
    pub(crate) ssh_key_path: Option<String>,
    pub(crate) ssh_key_passphrase: Option<String>,
    pub(crate) known_hosts_path: Option<String>,
    #[serde(skip)]
    pub(crate) proxy_helper_exe: String,
    #[serde(skip)]
    pub(crate) proxy: Option<SshProxyConfig>,
    #[serde(skip)]
    pub(crate) jump: Option<Box<SshProfile>>,
    pub(crate) remote_host: String,
    pub(crate) remote_port: u16,
    #[serde(default = "default_connect_timeout_ms")]
    pub(crate) connect_timeout_ms: u64,
    #[serde(default)]
    pub(crate) keepalive_enabled: bool,
    #[serde(default = "default_keepalive_interval_ms")]
    pub(crate) keepalive_interval_ms: u64,
}

impl fmt::Debug for SshTunnelConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshTunnelConfig")
            .field("ssh_host", &self.ssh_host)
            .field("ssh_port", &self.ssh_port)
            .field("ssh_user", &self.ssh_user)
            .field("ssh_auth_method", &self.ssh_auth_method)
            .field(
                "ssh_password",
                &self.ssh_password.as_ref().map(|_| "<redacted>"),
            )
            .field("ssh_key_path", &self.ssh_key_path)
            .field(
                "ssh_key_passphrase",
                &self.ssh_key_passphrase.as_ref().map(|_| "<redacted>"),
            )
            .field("known_hosts_path", &self.known_hosts_path)
            .field("proxy_helper_exe", &self.proxy_helper_exe)
            .field("proxy", &self.proxy)
            .field("jump", &self.jump)
            .field("remote_host", &self.remote_host)
            .field("remote_port", &self.remote_port)
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .field("keepalive_enabled", &self.keepalive_enabled)
            .field("keepalive_interval_ms", &self.keepalive_interval_ms)
            .finish()
    }
}

fn default_connect_timeout_ms() -> u64 {
    15_000
}

fn default_auth_method() -> String {
    "password".to_string()
}

fn default_keepalive_interval_ms() -> u64 {
    15_000
}

#[derive(Debug, Error)]
pub(crate) enum SshTunnelError {
    // TODO(i18n): Return stable error codes here and localize backend messages in the frontend.
    #[error("SSH 主机不能为空。")]
    MissingSshHost,
    #[error("SSH 用户名不能为空。")]
    MissingSshUser,
    #[error("远程主机不能为空。")]
    MissingRemoteHost,
    #[error("{field} 端口必须在 1-65535 范围内。")]
    InvalidPort { field: &'static str },
    #[error("SSH 私钥认证必须提供私钥路径。")]
    MissingAuthentication,
    #[error("SSH 私钥文件不存在：{0}")]
    MissingKeyFile(String),
    #[error("SSH 连接失败：{0}")]
    SshConnect(String),
    #[error("SSH 认证失败：{0}")]
    SshAuth(String),
    #[error("SSH 主机密钥校验失败：{0}")]
    HostKeyVerification(String),
    #[error("SSH 代理连接失败：{0}")]
    ProxyConnect(String),
    #[error("SSH 跳板机连接失败：{0}")]
    JumpConnect(String),
    #[error("绑定本地隧道端口失败：{0}")]
    BindLocal(#[source] std::io::Error),
    #[error("获取本地隧道地址失败：{0}")]
    LocalAddr(#[source] std::io::Error),
    #[error("打开 SSH 转发通道失败：{0}")]
    OpenChannel(String),
    #[error("隧道转发失败：{0}")]
    Forward(#[source] std::io::Error),
}

pub(crate) struct SshTunnelGuard {
    label: &'static str,
    tunnel: Option<SshTunnelHandle>,
}

impl SshTunnelGuard {
    pub(crate) fn new(label: &'static str, tunnel: Option<SshTunnelHandle>) -> Self {
        Self { label, tunnel }
    }

    pub(crate) fn take(&mut self) -> Option<SshTunnelHandle> {
        self.tunnel.take()
    }
}

impl Drop for SshTunnelGuard {
    fn drop(&mut self) {
        if let Some(tunnel) = self.tunnel.take() {
            spawn_tunnel_shutdown(self.label, tunnel);
        }
    }
}

impl SshTunnelError {
    pub(crate) fn user_message(&self) -> String {
        self.to_string()
    }
}

impl SshTunnelConfig {
    pub(crate) fn validate(&self) -> Result<(), SshTunnelError> {
        if self.ssh_host.trim().is_empty() {
            return Err(SshTunnelError::MissingSshHost);
        }
        if self.ssh_user.trim().is_empty() {
            return Err(SshTunnelError::MissingSshUser);
        }
        if self.remote_host.trim().is_empty() {
            return Err(SshTunnelError::MissingRemoteHost);
        }
        if self.ssh_port == 0 {
            return Err(SshTunnelError::InvalidPort { field: "SSH" });
        }
        if self.remote_port == 0 {
            return Err(SshTunnelError::InvalidPort { field: "远程" });
        }

        let auth_kind = ssh_authentication_kind(&self.ssh_auth_method);
        let key_path = self
            .ssh_key_path
            .as_deref()
            .filter(|value| !value.trim().is_empty());
        if auth_kind == SshAuthenticationKind::Key {
            let Some(path) = key_path else {
                return Err(SshTunnelError::MissingAuthentication);
            };
            if !Path::new(path).is_file() {
                return Err(SshTunnelError::MissingKeyFile(path.to_string()));
            }
        }

        Ok(())
    }
}

pub(crate) struct SshTunnel {
    local_addr: SocketAddr,
    shutdown_tx: mpsc::Sender<()>,
    cancellation_token: CancellationToken,
    accept_task: JoinHandle<()>,
}

pub(crate) enum SshTunnelHandle {
    Native(SshTunnel),
}

impl SshTunnelHandle {
    pub(crate) async fn shutdown(self) {
        match self {
            Self::Native(tunnel) => {
                let _ = tunnel.shutdown().await;
            }
        }
    }

    pub(crate) fn local_addr(&self) -> Option<SocketAddr> {
        match self {
            Self::Native(tunnel) => Some(tunnel.local_addr()),
        }
    }
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

    pub(crate) async fn shutdown(self) -> Result<(), SshTunnelError> {
        self.cancellation_token.cancel();
        let _ = self.shutdown_tx.send(()).await;
        self.accept_task.abort();
        Ok(())
    }
}

struct TunnelHandler {
    host: String,
    port: u16,
    known_hosts_path: Option<String>,
}

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        if let Some(path) = self
            .known_hosts_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            match russh::keys::check_known_hosts_path(
                &self.host,
                self.port,
                server_public_key,
                path,
            ) {
                Ok(true) => return Ok(true),
                Ok(false) => {
                    eprintln!(
                        "[ssh-tunnel] host key is not trusted for {}:{}",
                        self.host, self.port
                    );
                }
                Err(error) => {
                    eprintln!(
                        "[ssh-tunnel] host key verification failed for {}:{}: {}",
                        self.host, self.port, error
                    );
                }
            }
        } else {
            eprintln!(
                "[ssh-tunnel] known_hosts path is empty for {}:{}",
                self.host, self.port
            );
        }

        Ok(false)
    }
}

pub(crate) async fn create_tunnel(
    config: SshTunnelConfig,
    state: AppState,
    window: UiWindowRef,
) -> Result<SshTunnel, SshTunnelError> {
    config.validate()?;

    let timeout = Duration::from_millis(config.connect_timeout_ms.max(1_000));
    let mut session = connect_profile(&config, timeout, "SSH", &state, &window).await?;
    let auth_profile = authentication_profile_from_config(&config);
    authenticate_profile(&mut session, auth_profile, Some(state), Some(window))
        .await
        .map_err(SshTunnelError::SshAuth)?;

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(SshTunnelError::BindLocal)?;
    let local_addr = listener.local_addr().map_err(SshTunnelError::LocalAddr)?;
    let session = Arc::new(session);
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    let cancellation_token = CancellationToken::new();
    let remote_host = config.remote_host.clone();
    let remote_port = config.remote_port;
    let accept_cancellation_token = cancellation_token.clone();

    let accept_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = accept_cancellation_token.cancelled() => break,
                _ = shutdown_rx.recv() => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((local_stream, _peer)) => {
                            let session = Arc::clone(&session);
                            let remote_host = remote_host.clone();
                            let cancellation_token = accept_cancellation_token.child_token();
                            tokio::spawn(async move {
                                if let Err(error) = forward_one(session, local_stream, remote_host, remote_port, cancellation_token).await {
                                    eprintln!("[ssh-tunnel] {}", error.user_message());
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
        cancellation_token,
        accept_task,
    })
}

pub(crate) async fn create_tunnel_for_connection(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
    host: &str,
    port: u16,
) -> Result<(SshTunnelHandle, SocketAddr), String> {
    let config =
        config_from_connection_with_window(state, window, connection_id, host, port, None).await?;
    let tunnel = create_tunnel(config, state.clone(), UiWindowRef::from_window(window))
        .await
        .map_err(|error| error.user_message())?;
    let addr = tunnel.local_addr();
    Ok((SshTunnelHandle::Native(tunnel), addr))
}

pub(crate) fn spawn_tunnel_shutdown(label: impl Into<String>, tunnel: SshTunnelHandle) {
    let label = label.into();
    tauri::async_runtime::spawn(async move {
        match tokio::time::timeout(Duration::from_secs(5), tunnel.shutdown()).await {
            Ok(()) => {}
            Err(_) => eprintln!("[{}] tunnel shutdown timed out after 5s", label),
        }
    });
}

async fn connect_profile(
    config: &SshTunnelConfig,
    timeout: Duration,
    label: &str,
    state: &AppState,
    window: &UiWindowRef,
) -> Result<client::Handle<TunnelHandler>, SshTunnelError> {
    let ssh_config = Arc::new(client::Config {
        inactivity_timeout: if config.keepalive_enabled {
            None
        } else {
            Some(Duration::from_secs(300))
        },
        keepalive_interval: keepalive_interval_from_settings(
            config.keepalive_enabled,
            config.keepalive_interval_ms,
        ),
        ..Default::default()
    });
    let handler = TunnelHandler {
        host: config.ssh_host.clone(),
        port: config.ssh_port,
        known_hosts_path: config.known_hosts_path.clone(),
    };

    let transport = open_transport(config, timeout, state, window).await?;
    tokio::time::timeout(
        timeout,
        client::connect_stream(ssh_config, transport, handler),
    )
    .await
    .map_err(|_| SshTunnelError::SshConnect(format!("{label} 连接超时。")))?
    .map_err(|error| {
        let message = error.to_string();
        if message.to_ascii_lowercase().contains("key") {
            SshTunnelError::HostKeyVerification(format!(
                "{}:{} 未通过 known_hosts 校验，请先在连接中信任该主机密钥。",
                config.ssh_host, config.ssh_port
            ))
        } else {
            SshTunnelError::SshConnect(message)
        }
    })
}

async fn open_transport(
    config: &SshTunnelConfig,
    timeout: Duration,
    state: &AppState,
    window: &UiWindowRef,
) -> Result<TunnelTransport, SshTunnelError> {
    if let Some(jump) = config.jump.as_deref() {
        return open_jump_transport(config, jump, timeout, state, window).await;
    }
    if let Some(proxy) = config.proxy.as_ref() {
        return open_proxy_transport(config, proxy).await;
    }
    let stream = tokio::time::timeout(
        timeout,
        TcpStream::connect((config.ssh_host.as_str(), config.ssh_port)),
    )
    .await
    .map_err(|_| SshTunnelError::SshConnect("连接超时。".to_string()))?
    .map_err(|error| SshTunnelError::SshConnect(error.to_string()))?;
    if config.keepalive_enabled {
        configure_tcp_keepalive(&stream, config.keepalive_interval_ms);
    }
    Ok(TunnelTransport::tcp(stream))
}

async fn open_jump_transport(
    target: &SshTunnelConfig,
    jump: &SshProfile,
    timeout: Duration,
    state: &AppState,
    window: &UiWindowRef,
) -> Result<TunnelTransport, SshTunnelError> {
    let jump_config = config_from_profile(jump, &target.ssh_host, target.ssh_port, None);
    let mut jump_session = Box::pin(connect_profile(
        &jump_config,
        timeout,
        "跳板机",
        state,
        window,
    ))
    .await
    .map_err(|error| SshTunnelError::JumpConnect(error.user_message()))?;
    authenticate_profile(
        &mut jump_session,
        jump.clone(),
        Some(state.clone()),
        Some(window.clone()),
    )
    .await
    .map_err(|error| SshTunnelError::JumpConnect(SshTunnelError::SshAuth(error).user_message()))?;
    let channel = jump_session
        .channel_open_direct_tcpip(
            target.ssh_host.as_str(),
            u32::from(target.ssh_port),
            "127.0.0.1",
            0,
        )
        .await
        .map_err(|error| SshTunnelError::JumpConnect(error.to_string()))?;
    Ok(TunnelTransport::jump(channel.into_stream(), jump_session))
}

async fn open_proxy_transport(
    config: &SshTunnelConfig,
    proxy: &SshProxyConfig,
) -> Result<TunnelTransport, SshTunnelError> {
    match proxy.proxy_type.as_str() {
        "command" => TunnelTransport::proxy_command(
            &proxy_command_template(&proxy.command, &config.ssh_host, config.ssh_port)
                .map_err(SshTunnelError::ProxyConnect)?,
            Vec::new(),
        )
        .map_err(SshTunnelError::ProxyConnect),
        "http" | "socks5" => TunnelTransport::proxy_helper(
            proxy_helper_command(
                &config.proxy_helper_exe,
                &config.ssh_host,
                config.ssh_port,
                proxy,
            )
            .map_err(SshTunnelError::ProxyConnect)?,
        )
        .map_err(SshTunnelError::ProxyConnect),
        _ => Err(SshTunnelError::ProxyConnect("代理类型无效。".to_string())),
    }
}

pub(crate) async fn config_from_connection_with_window(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
    remote_host: &str,
    remote_port: u16,
    overrides: Option<&Value>,
) -> Result<SshTunnelConfig, String> {
    let connection = get_connection(state, connection_id)?;
    let mut local_profile;
    let profile = if connection.kind == ConnectionKind::Local {
        local_profile = profile_from_overrides(overrides)?;
        &mut local_profile
    } else {
        local_profile = connection
            .ssh
            .clone()
            .ok_or_else(|| "当前连接缺少 SSH 配置。".to_string())?;
        &mut local_profile
    };
    ensure_ssh_profile_host_key_trusted(state, window, profile).await?;
    Ok(config_from_profile(
        profile,
        remote_host,
        remote_port,
        overrides,
    ))
}

fn config_from_profile(
    profile: &SshProfile,
    remote_host: &str,
    remote_port: u16,
    overrides: Option<&Value>,
) -> SshTunnelConfig {
    let auth_kind = ssh_authentication_kind(&profile.auth_method);
    let ssh_password = if auth_kind == SshAuthenticationKind::Password {
        Some(profile.password.clone())
    } else {
        None
    };
    let ssh_key_path = if auth_kind == SshAuthenticationKind::Key {
        Some(profile.key_path.clone())
    } else {
        None
    };
    let ssh_key_passphrase =
        if auth_kind == SshAuthenticationKind::Key && !profile.password.is_empty() {
            Some(profile.password.clone())
        } else {
            None
        };
    let connect_timeout_ms = overrides
        .and_then(|value| value.get("connectTimeoutMs"))
        .and_then(Value::as_u64)
        .unwrap_or(15_000);
    let keepalive_enabled = overrides
        .and_then(|value| value.get("keepaliveEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(profile.keepalive_enabled);
    let keepalive_interval_ms = overrides
        .and_then(|value| value.get("keepaliveIntervalMs"))
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(profile.keepalive_interval_ms);

    SshTunnelConfig {
        ssh_host: profile.address.clone(),
        ssh_port: profile.port,
        ssh_user: profile.username.clone(),
        ssh_auth_method: profile.auth_method.clone(),
        ssh_password,
        ssh_key_path,
        ssh_key_passphrase,
        known_hosts_path: Some(profile.known_hosts_path.clone()).filter(|value| !value.is_empty()),
        proxy_helper_exe: profile.proxy_helper_exe.clone(),
        proxy: profile.proxy.clone(),
        jump: profile.jump.clone(),
        remote_host: remote_host.to_string(),
        remote_port,
        connect_timeout_ms,
        keepalive_enabled,
        keepalive_interval_ms,
    }
}

fn authentication_profile_from_config(config: &SshTunnelConfig) -> SshProfile {
    let auth_kind = ssh_authentication_kind(&config.ssh_auth_method);
    let password = match auth_kind {
        SshAuthenticationKind::Key => config.ssh_key_passphrase.clone().unwrap_or_default(),
        SshAuthenticationKind::Password => config.ssh_password.clone().unwrap_or_default(),
        SshAuthenticationKind::Agent => String::new(),
    };
    let key_path = if auth_kind == SshAuthenticationKind::Key {
        config.ssh_key_path.clone().unwrap_or_default()
    } else {
        String::new()
    };
    SshProfile {
        address: config.ssh_host.clone(),
        port: config.ssh_port,
        username: config.ssh_user.clone(),
        auth_method: config.ssh_auth_method.clone(),
        password,
        key_path,
        known_hosts_path: config.known_hosts_path.clone().unwrap_or_default(),
        proxy_helper_exe: config.proxy_helper_exe.clone(),
        proxy: None,
        jump: None,
        keepalive_enabled: config.keepalive_enabled,
        keepalive_interval_ms: config.keepalive_interval_ms,
    }
}

fn profile_from_overrides(overrides: Option<&Value>) -> Result<SshProfile, String> {
    let value =
        overrides.ok_or_else(|| "本地连接使用 SSH 隧道时必须提供 SSH 配置。".to_string())?;
    let ssh_host = string_override(value, "sshHost");
    let ssh_user = string_override(value, "sshUser");
    if ssh_host.trim().is_empty() {
        return Err("本地连接使用 SSH 隧道时 SSH 主机不能为空。".to_string());
    }
    if ssh_user.trim().is_empty() {
        return Err("本地连接使用 SSH 隧道时 SSH 用户名不能为空。".to_string());
    }
    let ssh_port = value
        .get("sshPort")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .unwrap_or(22);
    let ssh_password = string_override(value, "sshPassword");
    let ssh_key_path = string_override(value, "sshKeyPath");
    let auth_method = if !ssh_key_path.trim().is_empty() {
        "key"
    } else {
        "password"
    };
    Ok(SshProfile {
        address: ssh_host,
        port: ssh_port,
        username: ssh_user,
        auth_method: auth_method.to_string(),
        password: ssh_password,
        key_path: ssh_key_path,
        known_hosts_path: string_override(value, "knownHostsPath"),
        proxy_helper_exe: std::env::current_exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| "shelldesk".to_string()),
        proxy: None,
        jump: None,
        keepalive_enabled: value
            .get("keepaliveEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        keepalive_interval_ms: value
            .get("keepaliveIntervalMs")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .unwrap_or_else(default_keepalive_interval_ms),
    })
}

fn string_override(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

async fn forward_one(
    session: Arc<client::Handle<TunnelHandler>>,
    mut local_stream: TcpStream,
    remote_host: String,
    remote_port: u16,
    cancellation_token: CancellationToken,
) -> Result<(), SshTunnelError> {
    let channel = session
        .channel_open_direct_tcpip(remote_host.as_str(), u32::from(remote_port), "127.0.0.1", 0)
        .await
        .map_err(|error| SshTunnelError::OpenChannel(error.to_string()))?;

    let mut ssh_stream = channel.into_stream();
    tokio::select! {
        result = io::copy_bidirectional(&mut local_stream, &mut ssh_stream) => {
            result.map_err(SshTunnelError::Forward)?;
        }
        _ = cancellation_token.cancelled() => {}
    }
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
            ssh_auth_method: "password".to_string(),
            ssh_password: Some("secret".to_string()),
            ssh_key_path: None,
            ssh_key_passphrase: None,
            known_hosts_path: None,
            proxy_helper_exe: String::new(),
            proxy: None,
            jump: None,
            remote_host: "127.0.0.1".to_string(),
            remote_port: 3306,
            connect_timeout_ms: 1_000,
            keepalive_enabled: false,
            keepalive_interval_ms: 15_000,
        }
    }

    fn base_profile(auth_method: &str) -> SshProfile {
        SshProfile {
            address: "example.com".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: auth_method.to_string(),
            password: String::new(),
            key_path: String::new(),
            known_hosts_path: "/tmp/known_hosts".to_string(),
            proxy_helper_exe: "shelldesk".to_string(),
            proxy: None,
            jump: None,
            keepalive_enabled: false,
            keepalive_interval_ms: 15_000,
        }
    }

    #[test]
    fn validates_required_fields() {
        let mut config = base_config();
        config.remote_host.clear();
        assert!(matches!(
            config.validate(),
            Err(SshTunnelError::MissingRemoteHost)
        ));
    }

    #[test]
    fn rejects_key_authentication_without_key_path() {
        let mut config = base_config();
        config.ssh_auth_method = "key".to_string();
        config.ssh_password = None;
        config.ssh_key_path = None;
        assert!(matches!(
            config.validate(),
            Err(SshTunnelError::MissingAuthentication)
        ));
    }

    #[test]
    fn rejects_missing_key_file() {
        let mut config = base_config();
        config.ssh_auth_method = "key".to_string();
        config.ssh_password = None;
        config.ssh_key_path = Some("/path/that/does/not/exist".to_string());
        assert!(matches!(
            config.validate(),
            Err(SshTunnelError::MissingKeyFile(_))
        ));
    }

    #[test]
    fn agent_authentication_does_not_require_password_or_key() {
        let mut config = base_config();
        config.ssh_auth_method = "agent".to_string();
        config.ssh_password = None;
        config.ssh_key_path = None;

        config.validate().unwrap();
        let profile = authentication_profile_from_config(&config);
        assert_eq!(profile.auth_method, "agent");
        assert!(profile.password.is_empty());
        assert!(profile.key_path.is_empty());
    }

    #[test]
    fn password_authentication_without_secret_can_use_keyboard_interactive() {
        let mut config = base_config();
        config.ssh_password = None;

        config.validate().unwrap();
        let profile = authentication_profile_from_config(&config);
        assert_eq!(profile.auth_method, "password");
        assert!(profile.password.is_empty());
    }

    #[test]
    fn profile_mapping_preserves_current_and_legacy_key_authentication() {
        for auth_method in ["key", "privateKey"] {
            let mut profile = base_profile(auth_method);
            profile.password = "key-passphrase".to_string();
            profile.key_path = "/tmp/id_ed25519".to_string();
            profile.keepalive_enabled = true;
            profile.keepalive_interval_ms = 30_000;

            let config = config_from_profile(&profile, "127.0.0.1", 3306, None);
            assert_eq!(config.ssh_auth_method, auth_method);
            assert_eq!(config.ssh_password, None);
            assert_eq!(config.ssh_key_path.as_deref(), Some("/tmp/id_ed25519"));
            assert_eq!(config.ssh_key_passphrase.as_deref(), Some("key-passphrase"));

            let mapped_profile = authentication_profile_from_config(&config);
            assert_eq!(mapped_profile.auth_method, auth_method);
            assert_eq!(mapped_profile.password, "key-passphrase");
            assert_eq!(mapped_profile.key_path, "/tmp/id_ed25519");
        }
    }

    #[test]
    fn profile_mapping_keeps_agent_credentials_empty() {
        let mut profile = base_profile("agent");
        profile.password = "stale-password".to_string();
        profile.key_path = "/tmp/stale-key".to_string();

        let config = config_from_profile(&profile, "127.0.0.1", 5900, None);
        assert_eq!(config.ssh_auth_method, "agent");
        assert_eq!(config.ssh_password, None);
        assert_eq!(config.ssh_key_path, None);
        assert_eq!(config.ssh_key_passphrase, None);
        config.validate().unwrap();
    }

    #[test]
    fn rejects_zero_ports() {
        let mut config = base_config();
        config.ssh_port = 0;
        assert!(matches!(
            config.validate(),
            Err(SshTunnelError::InvalidPort { field: "SSH" })
        ));

        config = base_config();
        config.remote_port = 0;
        assert!(matches!(
            config.validate(),
            Err(SshTunnelError::InvalidPort { field: "远程" })
        ));
    }
}
