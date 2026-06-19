use base64::Engine;
use russh::{client, keys::key::PrivateKeyWithHashAlg};
use serde::Deserialize;
use std::{
    fmt,
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    pin::Pin,
    process::Stdio,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::{self, AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::mpsc,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use crate::{
    connection::{confirm_ssh_host_public_key_trusted, ensure_ssh_profile_host_key_trusted},
    error_string, get_connection, prevent_tokio_process_window,
    proxy::SshProxyConfig,
    shell_quote, AppState, ConnectionKind, SshProfile,
};
use serde_json::Value;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SshTunnelConfig {
    pub(crate) ssh_host: String,
    pub(crate) ssh_port: u16,
    pub(crate) ssh_user: String,
    pub(crate) ssh_password: Option<String>,
    pub(crate) ssh_key_path: Option<String>,
    pub(crate) ssh_key_passphrase: Option<String>,
    pub(crate) known_hosts_path: Option<String>,
    #[serde(skip)]
    pub(crate) trust_state: Option<AppState>,
    #[serde(skip)]
    pub(crate) trust_window: Option<tauri::Window>,
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
}

impl fmt::Debug for SshTunnelConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshTunnelConfig")
            .field("ssh_host", &self.ssh_host)
            .field("ssh_port", &self.ssh_port)
            .field("ssh_user", &self.ssh_user)
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
            .field(
                "trust_state",
                &self.trust_state.as_ref().map(|_| "<available>"),
            )
            .field(
                "trust_window",
                &self.trust_window.as_ref().map(|_| "<available>"),
            )
            .field("proxy_helper_exe", &self.proxy_helper_exe)
            .field("proxy", &self.proxy)
            .field("jump", &self.jump)
            .field("remote_host", &self.remote_host)
            .field("remote_port", &self.remote_port)
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .finish()
    }
}

fn default_connect_timeout_ms() -> u64 {
    15_000
}

#[derive(Debug, Error)]
pub(crate) enum SshTunnelError {
    // TODO(i18n): Return stable error codes here and localize backend messages in the frontend.
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
            return Err(SshTunnelError::InvalidPort { field: "数据库" });
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
            return Err(SshTunnelError::MissingAuthentication);
        }

        if let Some(path) = self
            .ssh_key_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
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
    username: String,
    known_hosts_path: Option<String>,
    trust_state: Option<AppState>,
    trust_window: Option<tauri::Window>,
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

        let (Some(state), Some(window)) = (self.trust_state.as_ref(), self.trust_window.as_ref())
        else {
            return Ok(false);
        };
        let public_key = match server_public_key.to_openssh() {
            Ok(value) => value,
            Err(error) => {
                eprintln!(
                    "[ssh-tunnel] failed to encode host key for {}:{}: {}",
                    self.host, self.port, error
                );
                return Ok(false);
            }
        };
        match confirm_ssh_host_public_key_trusted(
            state,
            window,
            &self.host,
            self.port,
            &self.username,
            &public_key,
        )
        .await
        {
            Ok(true) => Ok(true),
            Ok(false) => Ok(false),
            Err(error) => {
                eprintln!(
                    "[ssh-tunnel] host key confirmation failed for {}:{}: {}",
                    self.host, self.port, error
                );
                Ok(false)
            }
        }
    }
}

pub(crate) async fn create_tunnel(config: SshTunnelConfig) -> Result<SshTunnel, SshTunnelError> {
    config.validate()?;

    let timeout = Duration::from_millis(config.connect_timeout_ms.max(1_000));
    let mut session = connect_profile(&config, timeout, "SSH").await?;

    if let Some(key_path) = config
        .ssh_key_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        authenticate_key(
            &mut session,
            &config.ssh_user,
            key_path,
            config.ssh_key_passphrase.as_deref(),
        )
        .await?;
    } else if let Some(password) = config.ssh_password.as_deref() {
        authenticate_password(&mut session, &config.ssh_user, password).await?;
    }

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

async fn connect_profile(
    config: &SshTunnelConfig,
    timeout: Duration,
    label: &str,
) -> Result<client::Handle<TunnelHandler>, SshTunnelError> {
    let ssh_config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        ..Default::default()
    });
    let handler = TunnelHandler {
        host: config.ssh_host.clone(),
        port: config.ssh_port,
        username: config.ssh_user.clone(),
        known_hosts_path: config.known_hosts_path.clone(),
        trust_state: config.trust_state.clone(),
        trust_window: config.trust_window.clone(),
    };

    let transport = open_transport(config, timeout).await?;
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

async fn authenticate_key(
    session: &mut client::Handle<TunnelHandler>,
    user: &str,
    key_path: &str,
    passphrase: Option<&str>,
) -> Result<(), SshTunnelError> {
    let key = russh::keys::load_secret_key(key_path, passphrase)
        .map_err(|error| SshTunnelError::SshAuth(error.to_string()))?;
    let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
    let auth_result = session
        .authenticate_publickey(user, key)
        .await
        .map_err(|error| SshTunnelError::SshAuth(error.to_string()))?;
    if !auth_result.success() {
        return Err(SshTunnelError::SshAuth("服务器拒绝私钥认证。".to_string()));
    }
    Ok(())
}

async fn authenticate_password(
    session: &mut client::Handle<TunnelHandler>,
    user: &str,
    password: &str,
) -> Result<(), SshTunnelError> {
    let auth_result = session
        .authenticate_password(user, password)
        .await
        .map_err(|error| SshTunnelError::SshAuth(error.to_string()))?;
    if !auth_result.success() {
        return Err(SshTunnelError::SshAuth("服务器拒绝密码认证。".to_string()));
    }
    Ok(())
}

async fn open_transport(
    config: &SshTunnelConfig,
    timeout: Duration,
) -> Result<TunnelTransport, SshTunnelError> {
    if let Some(jump) = config.jump.as_deref() {
        return open_jump_transport(config, jump, timeout).await;
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
    Ok(TunnelTransport::Tcp(stream))
}

async fn open_jump_transport(
    target: &SshTunnelConfig,
    jump: &SshProfile,
    timeout: Duration,
) -> Result<TunnelTransport, SshTunnelError> {
    let jump_config = config_from_profile(jump, &target.ssh_host, target.ssh_port, None);
    let mut jump_session = Box::pin(connect_profile(&jump_config, timeout, "跳板机"))
        .await
        .map_err(|error| SshTunnelError::JumpConnect(error.user_message()))?;
    if jump.auth_method == "key" && !jump.key_path.trim().is_empty() {
        authenticate_key(
            &mut jump_session,
            &jump.username,
            &jump.key_path,
            (!jump.password.is_empty()).then_some(jump.password.as_str()),
        )
        .await
        .map_err(|error| SshTunnelError::JumpConnect(error.user_message()))?;
    } else if jump.auth_method == "password" && !jump.password.is_empty() {
        authenticate_password(&mut jump_session, &jump.username, &jump.password)
            .await
            .map_err(|error| SshTunnelError::JumpConnect(error.user_message()))?;
    }
    let channel = jump_session
        .channel_open_direct_tcpip(
            target.ssh_host.as_str(),
            u32::from(target.ssh_port),
            "127.0.0.1",
            0,
        )
        .await
        .map_err(|error| SshTunnelError::JumpConnect(error.to_string()))?;
    Ok(TunnelTransport::Jump(JumpTransport {
        stream: channel.into_stream(),
        _session: jump_session,
    }))
}

async fn open_proxy_transport(
    config: &SshTunnelConfig,
    proxy: &SshProxyConfig,
) -> Result<TunnelTransport, SshTunnelError> {
    let (command_line, envs) = match proxy.proxy_type.as_str() {
        "command" => (
            proxy
                .command
                .replace("{host}", &config.ssh_host)
                .replace("%h", &config.ssh_host)
                .replace("{port}", &config.ssh_port.to_string())
                .replace("%p", &config.ssh_port.to_string()),
            Vec::new(),
        ),
        "http" | "socks5" => {
            network_proxy_command(config, proxy).map_err(SshTunnelError::ProxyConnect)?
        }
        _ => return Err(SshTunnelError::ProxyConnect("代理类型无效。".to_string())),
    };
    ProxyCommandTransport::spawn(&command_line, envs)
        .map(TunnelTransport::ProxyCommand)
        .map_err(SshTunnelError::ProxyConnect)
}

fn network_proxy_command(
    config: &SshTunnelConfig,
    proxy: &SshProxyConfig,
) -> Result<(String, Vec<(String, String)>), String> {
    if config.proxy_helper_exe.trim().is_empty() {
        return Err("代理 helper 路径为空。".to_string());
    }
    let payload = serde_json::json!({
        "type": proxy.proxy_type,
        "host": proxy.host,
        "port": proxy.port,
        "username": proxy.username,
        "password": proxy.password
    });
    let encoded = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(&payload).map_err(error_string)?);
    let command = format!(
        "{} --shelldesk-proxy-helper {} {} {}",
        proxy_command_arg(&config.proxy_helper_exe),
        proxy_command_arg(&proxy.helper_id),
        proxy_command_arg(&config.ssh_host),
        config.ssh_port
    );
    Ok((
        command,
        vec![(
            crate::proxy::proxy_helper_env_name(&proxy.helper_id),
            encoded,
        )],
    ))
}

fn proxy_command_arg(value: &str) -> String {
    let safe_unquoted = value.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(ch, '.' | '_' | '-' | '/' | ':' | '@' | '=')
            || (!cfg!(windows) && ch == '%')
    });
    if safe_unquoted {
        value.to_string()
    } else if cfg!(windows) {
        cmd_quote(value)
    } else {
        shell_quote(value)
    }
}

fn cmd_quote(value: &str) -> String {
    let escaped = value
        .replace('%', "%%")
        .replace('"', "\\\"")
        .replace('^', "^^")
        .replace('&', "^&")
        .replace('|', "^|")
        .replace('<', "^<")
        .replace('>', "^>");
    format!("\"{escaped}\"")
}

enum TunnelTransport {
    Tcp(TcpStream),
    ProxyCommand(ProxyCommandTransport),
    Jump(JumpTransport),
}

struct ProxyCommandTransport {
    stdin: ChildStdin,
    stdout: ChildStdout,
    _child: Child,
}

impl ProxyCommandTransport {
    fn spawn(command_line: &str, envs: Vec<(String, String)>) -> Result<Self, String> {
        if command_line.trim().is_empty() {
            return Err("ProxyCommand 不能为空。".to_string());
        }
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", command_line]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", command_line]);
            command
        };
        for (name, value) in envs {
            command.env(name, value);
        }
        prevent_tokio_process_window(&mut command);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(error_string)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "ProxyCommand 标准输入不可写。".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "ProxyCommand 标准输出不可读。".to_string())?;
        Ok(Self {
            stdin,
            stdout,
            _child: child,
        })
    }
}

struct JumpTransport {
    stream: russh::ChannelStream<client::Msg>,
    _session: client::Handle<TunnelHandler>,
}

impl AsyncRead for TunnelTransport {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut *self {
            Self::Tcp(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::ProxyCommand(stream) => Pin::new(&mut stream.stdout).poll_read(cx, buf),
            Self::Jump(stream) => Pin::new(&mut stream.stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for TunnelTransport {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut *self {
            Self::Tcp(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::ProxyCommand(stream) => Pin::new(&mut stream.stdin).poll_write(cx, buf),
            Self::Jump(stream) => Pin::new(&mut stream.stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            Self::Tcp(stream) => Pin::new(stream).poll_flush(cx),
            Self::ProxyCommand(stream) => Pin::new(&mut stream.stdin).poll_flush(cx),
            Self::Jump(stream) => Pin::new(&mut stream.stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            Self::Tcp(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::ProxyCommand(stream) => Pin::new(&mut stream.stdin).poll_shutdown(cx),
            Self::Jump(stream) => Pin::new(&mut stream.stream).poll_shutdown(cx),
        }
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
    let mut config = config_from_profile(profile, remote_host, remote_port, overrides);
    config.trust_state = Some(state.clone());
    config.trust_window = Some(window.clone());
    Ok(config)
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
        trust_state: None,
        trust_window: None,
        proxy_helper_exe: profile.proxy_helper_exe.clone(),
        proxy: profile.proxy.clone(),
        jump: profile.jump.clone(),
        remote_host: remote_host.to_string(),
        remote_port,
        connect_timeout_ms,
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
            ssh_password: Some("secret".to_string()),
            ssh_key_path: None,
            ssh_key_passphrase: None,
            known_hosts_path: None,
            trust_state: None,
            trust_window: None,
            proxy_helper_exe: String::new(),
            proxy: None,
            jump: None,
            remote_host: "127.0.0.1".to_string(),
            remote_port: 3306,
            connect_timeout_ms: 1_000,
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
    fn rejects_missing_authentication() {
        let mut config = base_config();
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
        config.ssh_password = None;
        config.ssh_key_path = Some("/path/that/does/not/exist".to_string());
        assert!(matches!(
            config.validate(),
            Err(SshTunnelError::MissingKeyFile(_))
        ));
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
            Err(SshTunnelError::InvalidPort { field: "数据库" })
        ));
    }
}
