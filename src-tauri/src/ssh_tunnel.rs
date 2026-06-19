use russh::{client, keys::key::PrivateKeyWithHashAlg};
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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
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
pub(crate) enum SshTunnelError {
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
        let _ = self.shutdown_tx.send(()).await;
        self.accept_task.abort();
        Ok(())
    }
}

struct TunnelHandler {
    known_hosts_path: Option<String>,
}

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Phase 1 deliberately accepts the server key. This is replaced with
        // ShellDesk known_hosts integration before exposing the mode broadly.
        let _ = &self.known_hosts_path;
        Ok(true)
    }
}

pub(crate) async fn create_tunnel(config: SshTunnelConfig) -> Result<SshTunnel, SshTunnelError> {
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
    .map_err(|_| SshTunnelError::SshConnect("连接超时。".to_string()))?
    .map_err(|error| SshTunnelError::SshConnect(error.to_string()))?;

    if let Some(key_path) = config
        .ssh_key_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let passphrase = config.ssh_key_passphrase.as_deref();
        let key = russh::keys::load_secret_key(key_path, passphrase)
            .map_err(|error| SshTunnelError::SshAuth(error.to_string()))?;
        let key = PrivateKeyWithHashAlg::new(Arc::new(key), None)
            .map_err(|error| SshTunnelError::SshAuth(error.to_string()))?;
        let auth_result = session
            .authenticate_publickey(&config.ssh_user, key)
            .await
            .map_err(|error| SshTunnelError::SshAuth(error.to_string()))?;
        if !auth_result.success() {
            return Err(SshTunnelError::SshAuth(
                "服务器拒绝私钥认证。".to_string(),
            ));
        }
    } else if let Some(password) = config.ssh_password.as_deref() {
        let auth_result = session
            .authenticate_password(&config.ssh_user, password)
            .await
            .map_err(|error| SshTunnelError::SshAuth(error.to_string()))?;
        if !auth_result.success() {
            return Err(SshTunnelError::SshAuth(
                "服务器拒绝密码认证。".to_string(),
            ));
        }
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(SshTunnelError::BindLocal)?;
    let local_addr = listener.local_addr().map_err(SshTunnelError::LocalAddr)?;
    let session = Arc::new(session);
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
        accept_task,
    })
}

async fn forward_one(
    session: Arc<client::Handle<TunnelHandler>>,
    mut local_stream: TcpStream,
    remote_host: String,
    remote_port: u16,
) -> Result<(), SshTunnelError> {
    let channel = session
        .channel_open_direct_tcpip(remote_host.as_str(), u32::from(remote_port), "127.0.0.1", 0)
        .await
        .map_err(|error| SshTunnelError::OpenChannel(error.to_string()))?;

    let mut ssh_stream = channel.into_stream();
    io::copy_bidirectional(&mut local_stream, &mut ssh_stream)
        .await
        .map_err(SshTunnelError::Forward)?;
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
