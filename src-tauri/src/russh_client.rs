use crate::{
    error_string, prevent_tokio_process_window, proxy::SshProxyConfig, shell_quote,
    ui_prompts::request_keyboard_interactive_decision, AppState, SshProfile, UiWindowRef,
};
use base64::Engine;
use russh::{
    client,
    keys::{
        agent::{
            client::{AgentClient, AgentStream},
            AgentIdentity,
        },
        key::PrivateKeyWithHashAlg,
        Algorithm, HashAlg, PublicKey,
    },
    ChannelMsg, Disconnect,
};
use serde_json::json;
use std::{
    path::Path,
    pin::Pin,
    process::Stdio,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{self, AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::TcpStream,
    process::{Child, ChildStdin, ChildStdout, Command},
};

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct RusshSession {
    handle: client::Handle<ShellDeskClientHandler>,
}

impl RusshSession {
    pub(crate) fn handle(&self) -> &client::Handle<ShellDeskClientHandler> {
        &self.handle
    }

    pub(crate) async fn disconnect(&mut self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }
}

pub(crate) struct RusshExecOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) code: i32,
    pub(crate) success: bool,
}

pub(crate) async fn run_exec_command(
    state: Option<AppState>,
    window: Option<UiWindowRef>,
    profile: SshProfile,
    command: String,
    stdin: String,
    timeout: Duration,
) -> Result<RusshExecOutput, String> {
    let task = async {
        let mut session = connect_authenticated(state, window, profile).await?;
        let result = exec_on_session(session.handle(), command, stdin, None).await;
        session.disconnect().await;
        result
    };
    tokio::time::timeout(timeout, task)
        .await
        .map_err(|_| "SSH command timed out.".to_string())?
}

pub(crate) async fn run_exec_command_stream(
    state: Option<AppState>,
    window: UiWindowRef,
    profile: SshProfile,
    command: String,
    stdin: String,
    stream_id: String,
    timeout: Duration,
) -> Result<RusshExecOutput, String> {
    let task = async {
        let mut session = connect_authenticated(state, Some(window.clone()), profile).await?;
        let result =
            exec_on_session(session.handle(), command, stdin, Some((window, stream_id))).await;
        session.disconnect().await;
        result
    };
    tokio::time::timeout(timeout, task)
        .await
        .map_err(|_| "SSH command timed out.".to_string())?
}

pub(crate) async fn scan_host_public_keys(profile: SshProfile) -> Result<Vec<PublicKey>, String> {
    tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(error_string)?;
        runtime.block_on(scan_host_public_keys_inner(profile))
    })
    .await
    .map_err(error_string)?
}

async fn scan_host_public_keys_inner(profile: SshProfile) -> Result<Vec<PublicKey>, String> {
    let captured = Arc::new(Mutex::new(Vec::new()));
    let policy = HostKeyPolicy::Capture(Arc::clone(&captured));
    let _session = connect_profile(profile, DEFAULT_CONNECT_TIMEOUT, policy).await?;
    let keys = captured.lock().map_err(error_string)?.clone();
    if keys.is_empty() {
        return Err("未能读取 SSH 主机公钥。".to_string());
    }
    Ok(keys)
}

pub(crate) async fn connect_authenticated(
    state: Option<AppState>,
    window: Option<UiWindowRef>,
    profile: SshProfile,
) -> Result<RusshSession, String> {
    let mut handle = connect_profile(
        profile.clone(),
        DEFAULT_CONNECT_TIMEOUT,
        HostKeyPolicy::Verify,
    )
    .await?;
    authenticate_profile(&mut handle, profile, state, window).await?;
    Ok(RusshSession { handle })
}

async fn exec_on_session(
    session: &client::Handle<ShellDeskClientHandler>,
    command: String,
    stdin: String,
    stream: Option<(UiWindowRef, String)>,
) -> Result<RusshExecOutput, String> {
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|error| format!("SSH 会话通道打开失败：{error}"))?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|error| format!("SSH 命令启动失败：{error}"))?;
    if !stdin.is_empty() {
        let mut writer = channel.make_writer();
        writer
            .write_all(stdin.as_bytes())
            .await
            .map_err(error_string)?;
        writer.flush().await.map_err(error_string)?;
    }
    let _ = channel.eof().await;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code: Option<i32> = None;
    let mut rejected = false;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                emit_stream_chunk(stream.as_ref(), "stdout", &data);
                stdout.extend_from_slice(&data);
            }
            ChannelMsg::ExtendedData { data, ext } => {
                let stream_name = if ext == 1 { "stderr" } else { "stdout" };
                emit_stream_chunk(stream.as_ref(), stream_name, &data);
                if ext == 1 {
                    stderr.extend_from_slice(&data);
                } else {
                    stdout.extend_from_slice(&data);
                }
            }
            ChannelMsg::ExitStatus { exit_status } => {
                code = Some(i32::try_from(exit_status).unwrap_or(-1));
            }
            ChannelMsg::ExitSignal {
                signal_name,
                error_message,
                ..
            } => {
                code = Some(-1);
                if !error_message.trim().is_empty() {
                    stderr.extend_from_slice(error_message.as_bytes());
                } else {
                    stderr.extend_from_slice(
                        format!("SSH process exited by {signal_name:?}").as_bytes(),
                    );
                }
            }
            ChannelMsg::Failure => {
                rejected = true;
            }
            ChannelMsg::Close => break,
            _ => {}
        }
    }

    if rejected && code.is_none() {
        return Err("SSH 服务器拒绝执行该命令。".to_string());
    }
    let code = code.unwrap_or(-1);
    Ok(RusshExecOutput {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        code,
        success: code == 0,
    })
}

fn emit_stream_chunk(stream: Option<&(UiWindowRef, String)>, stream_name: &str, data: &[u8]) {
    let Some((window, stream_id)) = stream else {
        return;
    };
    let chunk = String::from_utf8_lossy(data).to_string();
    let _ = window.emit(
        "connection:run-command-stream:chunk",
        json!({ "streamId": stream_id, "chunk": chunk, "stream": stream_name }),
    );
}

#[derive(Clone)]
enum HostKeyPolicy {
    Verify,
    Capture(Arc<Mutex<Vec<PublicKey>>>),
}

pub(crate) struct ShellDeskClientHandler {
    host: String,
    port: u16,
    known_hosts_path: String,
    policy: HostKeyPolicy,
}

impl client::Handler for ShellDeskClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        if let HostKeyPolicy::Capture(keys) = &self.policy {
            if let Ok(mut keys) = keys.lock() {
                keys.push(server_public_key.clone());
            }
            return Ok(true);
        }

        let path = self.known_hosts_path.trim();
        if path.is_empty() {
            eprintln!(
                "[russh-client] known_hosts path is empty for {}:{}",
                self.host, self.port
            );
            return Ok(false);
        }
        match russh::keys::check_known_hosts_path(&self.host, self.port, server_public_key, path) {
            Ok(true) => Ok(true),
            Ok(false) => {
                eprintln!(
                    "[russh-client] host key is not trusted for {}:{}",
                    self.host, self.port
                );
                Ok(false)
            }
            Err(error) => {
                eprintln!(
                    "[russh-client] host key verification failed for {}:{}: {}",
                    self.host, self.port, error
                );
                Ok(false)
            }
        }
    }
}

async fn connect_profile(
    profile: SshProfile,
    timeout: Duration,
    policy: HostKeyPolicy,
) -> Result<client::Handle<ShellDeskClientHandler>, String> {
    let ssh_config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        ..Default::default()
    });
    let handler = ShellDeskClientHandler {
        host: profile.address.clone(),
        port: profile.port,
        known_hosts_path: profile.known_hosts_path.clone(),
        policy,
    };
    let error_host = profile.address.clone();
    let error_port = profile.port;
    let transport = open_transport(profile, timeout).await?;
    tokio::time::timeout(
        timeout,
        client::connect_stream(ssh_config, transport, handler),
    )
    .await
    .map_err(|_| "SSH 连接超时。".to_string())?
    .map_err(|error| {
        let message = error.to_string();
        if message.to_ascii_lowercase().contains("key") {
            format!(
                "{}:{} 未通过 known_hosts 校验，请先信任该主机密钥。",
                error_host, error_port
            )
        } else {
            format!("SSH 连接失败：{message}")
        }
    })
}

async fn authenticate_profile(
    session: &mut client::Handle<ShellDeskClientHandler>,
    profile: SshProfile,
    state: Option<AppState>,
    window: Option<UiWindowRef>,
) -> Result<(), String> {
    let auth_method = profile.auth_method.clone();
    match auth_method.as_str() {
        "key" | "privateKey" => authenticate_key(session, profile).await,
        "agent" => authenticate_agent(session, profile).await,
        "password" => {
            authenticate_password_or_keyboard_interactive(session, profile, state, window).await
        }
        _ => authenticate_password_or_keyboard_interactive(session, profile, state, window).await,
    }
}

async fn authenticate_key(
    session: &mut client::Handle<ShellDeskClientHandler>,
    profile: SshProfile,
) -> Result<(), String> {
    if profile.key_path.trim().is_empty() {
        return Err("SSH 私钥路径为空。".to_string());
    }
    if !Path::new(&profile.key_path).is_file() {
        return Err(format!("SSH 私钥文件不存在：{}", profile.key_path));
    }
    let passphrase = (!profile.password.is_empty()).then_some(profile.password.as_str());
    let key = russh::keys::load_secret_key(&profile.key_path, passphrase)
        .map_err(|error| format!("读取 SSH 私钥失败：{error}"))?;
    let key = Arc::new(key);
    let rsa_hash = if matches!(key.algorithm(), Algorithm::Rsa { .. }) {
        session
            .best_supported_rsa_hash()
            .await
            .map_err(|error| format!("读取 SSH RSA 签名能力失败：{error}"))?
    } else {
        None
    };
    for hash_alg in key_auth_hash_algorithms(key.algorithm(), rsa_hash) {
        let key_with_hash = PrivateKeyWithHashAlg::new(Arc::clone(&key), hash_alg);
        let auth_result = session
            .authenticate_publickey(&profile.username, key_with_hash)
            .await
            .map_err(|error| format!("SSH 私钥认证失败：{error}"))?;
        if auth_result.success() {
            return Ok(());
        }
    }
    Err("服务器拒绝 SSH 私钥认证。".to_string())
}

pub(crate) fn key_auth_hash_algorithms(
    algorithm: Algorithm,
    server_best: Option<Option<HashAlg>>,
) -> Vec<Option<HashAlg>> {
    if !matches!(algorithm, Algorithm::Rsa { .. }) {
        return vec![None];
    }
    let mut candidates = Vec::new();
    if let Some(hash_alg) = server_best {
        candidates.push(hash_alg);
    } else {
        candidates.push(Some(HashAlg::Sha512));
        candidates.push(Some(HashAlg::Sha256));
    }
    candidates.push(None);
    candidates.dedup();
    candidates
}

async fn authenticate_password_or_keyboard_interactive(
    session: &mut client::Handle<ShellDeskClientHandler>,
    profile: SshProfile,
    state: Option<AppState>,
    window: Option<UiWindowRef>,
) -> Result<(), String> {
    if !profile.password.is_empty() {
        let result = session
            .authenticate_password(&profile.username, &profile.password)
            .await
            .map_err(|error| format!("SSH 密码认证失败：{error}"))?;
        if result.success() {
            return Ok(());
        }
        if let client::AuthResult::Failure {
            remaining_methods, ..
        } = result
        {
            if !remaining_methods.contains(&russh::MethodKind::KeyboardInteractive) {
                return Err("服务器拒绝 SSH 密码认证。".to_string());
            }
        }
    }
    authenticate_keyboard_interactive(session, profile, state, window).await
}

async fn authenticate_keyboard_interactive(
    session: &mut client::Handle<ShellDeskClientHandler>,
    profile: SshProfile,
    state: Option<AppState>,
    window: Option<UiWindowRef>,
) -> Result<(), String> {
    let mut response = session
        .authenticate_keyboard_interactive_start(&profile.username, None)
        .await
        .map_err(|error| format!("SSH 交互认证失败：{error}"))?;
    loop {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => return Ok(()),
            client::KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err("服务器拒绝 SSH 交互认证。".to_string());
            }
            client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answers = keyboard_interactive_answers(
                    profile.clone(),
                    state.clone(),
                    window.clone(),
                    name,
                    instructions,
                    prompts,
                )
                .await?;
                response = session
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|error| format!("SSH 交互认证失败：{error}"))?;
            }
        }
    }
}

async fn keyboard_interactive_answers(
    profile: SshProfile,
    state: Option<AppState>,
    window: Option<UiWindowRef>,
    name: String,
    instructions: String,
    prompts: Vec<client::Prompt>,
) -> Result<Vec<String>, String> {
    if prompts.iter().all(|prompt| {
        !prompt.echo && !profile.password.is_empty() && is_password_keyboard_prompt(&prompt.prompt)
    }) {
        return Ok(prompts.iter().map(|_| profile.password.clone()).collect());
    }
    let (Some(state), Some(window)) = (state, window) else {
        return Err("SSH 交互认证需要用户输入，但当前没有可用窗口。".to_string());
    };
    let prompt_pairs = prompts
        .into_iter()
        .map(|prompt| (prompt.prompt, prompt.echo))
        .collect::<Vec<_>>();
    request_keyboard_interactive_decision(state, window, profile, name, instructions, prompt_pairs)
        .await
}

fn is_password_keyboard_prompt(prompt: &str) -> bool {
    let prompt = prompt.trim().to_lowercase();
    if prompt.is_empty() {
        return false;
    }
    let password_like = ["password", "passphrase", "passcode", "密码", "口令"]
        .iter()
        .any(|needle| prompt.contains(needle));
    if !password_like {
        return false;
    }
    ![
        "one-time",
        "one time",
        "otp",
        "totp",
        "token",
        "verification",
        "verify",
        "code",
        "验证码",
        "动态",
        "令牌",
        "一次",
    ]
    .iter()
    .any(|needle| prompt.contains(needle))
}

async fn authenticate_agent(
    session: &mut client::Handle<ShellDeskClientHandler>,
    profile: SshProfile,
) -> Result<(), String> {
    let mut agent = open_agent_client().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|error| format!("读取 SSH agent 密钥失败：{error}"))?;
    if identities.is_empty() {
        return Err("SSH agent 中没有可用密钥。".to_string());
    }
    let rsa_hash = session
        .best_supported_rsa_hash()
        .await
        .map_err(|error| format!("读取 SSH RSA 签名能力失败：{error}"))?;
    for identity in identities {
        let public_key = identity.public_key();
        let hash_alg = if matches!(public_key.algorithm(), Algorithm::Rsa { .. }) {
            rsa_hash.flatten()
        } else {
            None
        };
        let result = match identity {
            AgentIdentity::PublicKey { key, .. } => {
                session
                    .authenticate_publickey_with(&profile.username, key, hash_alg, &mut agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                session
                    .authenticate_certificate_with(
                        &profile.username,
                        certificate,
                        hash_alg,
                        &mut agent,
                    )
                    .await
            }
        }
        .map_err(|error| format!("SSH agent 认证失败：{error}"))?;
        if result.success() {
            return Ok(());
        }
    }
    Err("服务器拒绝 SSH agent 中的所有密钥。".to_string())
}

async fn open_agent_client(
) -> Result<AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>, String> {
    #[cfg(unix)]
    {
        AgentClient::connect_env()
            .await
            .map(AgentClient::dynamic)
            .map_err(|error| format!("连接 SSH agent 失败：{error}"))
    }

    #[cfg(windows)]
    {
        if let Ok(path) = std::env::var("SSH_AUTH_SOCK") {
            if !path.trim().is_empty() {
                match AgentClient::connect_named_pipe(path).await {
                    Ok(agent) => return Ok(agent.dynamic()),
                    Err(error) => {
                        eprintln!("[russh-client] OpenSSH agent pipe unavailable: {error}");
                    }
                }
            }
        }
        AgentClient::connect_pageant()
            .await
            .map(AgentClient::dynamic)
            .map_err(|error| format!("连接 SSH agent 失败：{error}"))
    }

    #[cfg(not(any(unix, windows)))]
    {
        Err("当前平台不支持 SSH agent。".to_string())
    }
}

async fn open_transport(
    mut profile: SshProfile,
    timeout: Duration,
) -> Result<RusshTransport, String> {
    if profile.jump.is_some() {
        return open_jump_transport(profile, timeout).await;
    }
    if let Some(proxy) = profile.proxy.take() {
        return open_proxy_transport(profile, proxy).await;
    }
    let target = format!("{}:{}", profile.address, profile.port);
    let stream = tokio::time::timeout(timeout, TcpStream::connect(target))
        .await
        .map_err(|_| "SSH TCP 连接超时。".to_string())?
        .map_err(|error| format!("SSH TCP 连接失败：{error}"))?;
    Ok(RusshTransport::Tcp(stream))
}

async fn open_jump_transport(
    mut target: SshProfile,
    timeout: Duration,
) -> Result<RusshTransport, String> {
    let jump = target
        .jump
        .take()
        .ok_or_else(|| "跳板机配置为空。".to_string())?;
    let jump = *jump;
    let mut jump_session = Box::pin(connect_profile(
        jump.clone(),
        timeout,
        HostKeyPolicy::Verify,
    ))
    .await?;
    authenticate_profile(&mut jump_session, jump, None, None).await?;
    let target_host = target.address.clone();
    let target_port = target.port;
    let channel = jump_session
        .channel_open_direct_tcpip(target_host, u32::from(target_port), "127.0.0.1", 0)
        .await
        .map_err(|error| format!("跳板机打开目标 SSH 通道失败：{error}"))?;
    Ok(RusshTransport::Jump(JumpTransport {
        stream: channel.into_stream(),
        _session: jump_session,
    }))
}

async fn open_proxy_transport(
    profile: SshProfile,
    proxy: SshProxyConfig,
) -> Result<RusshTransport, String> {
    let (command_line, envs) = match proxy.proxy_type.as_str() {
        "command" => (
            proxy_command_template(&proxy.command, &profile.address, profile.port),
            Vec::new(),
        ),
        "http" | "socks5" => network_proxy_command(&profile, &proxy)?,
        _ => return Err("代理类型无效。".to_string()),
    };
    ProxyCommandTransport::spawn(&command_line, envs).map(RusshTransport::ProxyCommand)
}

fn network_proxy_command(
    profile: &SshProfile,
    proxy: &SshProxyConfig,
) -> Result<(String, Vec<(String, String)>), String> {
    if profile.proxy_helper_exe.trim().is_empty() {
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
        proxy_command_arg(&profile.proxy_helper_exe),
        proxy_command_arg(&proxy.helper_id),
        proxy_command_arg(&profile.address),
        profile.port
    );
    Ok((
        command,
        vec![(
            crate::proxy::proxy_helper_env_name(&proxy.helper_id),
            encoded,
        )],
    ))
}

fn proxy_command_template(command: &str, host: &str, port: u16) -> String {
    command
        .replace("{host}", &proxy_command_arg(host))
        .replace("%h", &proxy_command_arg(host))
        .replace("{port}", &proxy_command_arg(&port.to_string()))
        .replace("%p", &proxy_command_arg(&port.to_string()))
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

enum RusshTransport {
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
    _session: client::Handle<ShellDeskClientHandler>,
}

impl AsyncRead for RusshTransport {
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

impl AsyncWrite for RusshTransport {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rsa_key_auth_prefers_server_supported_hash_then_legacy() {
        assert_eq!(
            key_auth_hash_algorithms(
                Algorithm::Rsa {
                    hash: Some(HashAlg::Sha256)
                },
                Some(Some(HashAlg::Sha512)),
            ),
            vec![Some(HashAlg::Sha512), None]
        );
    }

    #[test]
    fn rsa_key_auth_tries_sha2_before_legacy_without_server_hint() {
        assert_eq!(
            key_auth_hash_algorithms(Algorithm::Rsa { hash: None }, None),
            vec![Some(HashAlg::Sha512), Some(HashAlg::Sha256), None]
        );
    }

    #[test]
    fn non_rsa_key_auth_ignores_hash_algorithms() {
        assert_eq!(
            key_auth_hash_algorithms(Algorithm::Ed25519, Some(Some(HashAlg::Sha512))),
            vec![None]
        );
    }
}
