use base64::Engine;
use russh::client;
use std::{
    any::Any,
    io,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
    process::{Child, ChildStdin, ChildStdout, Command},
};

use crate::{error_string, prevent_tokio_process_window, proxy::SshProxyConfig, shell_quote};

pub(crate) fn proxy_command_template(command: &str, host: &str, port: u16) -> String {
    command
        .replace("{host}", &proxy_command_arg(host))
        .replace("%h", &proxy_command_arg(host))
        .replace("{port}", &proxy_command_arg(&port.to_string()))
        .replace("%p", &proxy_command_arg(&port.to_string()))
}

pub(crate) fn proxy_helper_command(
    proxy_helper_exe: &str,
    target_host: &str,
    target_port: u16,
    proxy: &SshProxyConfig,
) -> Result<(String, Vec<(String, String)>), String> {
    if proxy_helper_exe.trim().is_empty() {
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
        proxy_command_arg(proxy_helper_exe),
        proxy_command_arg(&proxy.helper_id),
        proxy_command_arg(target_host),
        target_port
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

pub(crate) enum RusshTransport {
    Tcp(TcpStream),
    ProxyCommand(ProxyCommandTransport),
    Jump(JumpTransport),
}

impl RusshTransport {
    pub(crate) fn tcp(stream: TcpStream) -> Self {
        Self::Tcp(stream)
    }

    pub(crate) fn proxy_command(
        command_line: &str,
        envs: Vec<(String, String)>,
    ) -> Result<Self, String> {
        ProxyCommandTransport::spawn(command_line, envs).map(Self::ProxyCommand)
    }

    pub(crate) fn jump<H>(
        stream: russh::ChannelStream<client::Msg>,
        session: client::Handle<H>,
    ) -> Self
    where
        H: client::Handler + Send + 'static,
        client::Handle<H>: Send + 'static,
    {
        Self::Jump(JumpTransport {
            stream,
            _session: Box::new(session),
        })
    }
}

pub(crate) struct ProxyCommandTransport {
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

pub(crate) struct JumpTransport {
    stream: russh::ChannelStream<client::Msg>,
    _session: Box<dyn Any + Send>,
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
