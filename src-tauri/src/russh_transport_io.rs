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

pub(crate) fn proxy_command_template(
    command: &str,
    host: &str,
    port: u16,
) -> Result<String, String> {
    if cfg!(windows) && host.match_indices('%').nth(1).is_some() {
        return Err(
            "Windows ProxyCommand 目标主机不能包含成对的百分号，以免触发环境变量展开。".to_string(),
        );
    }

    Ok(command
        .replace("{host}", &proxy_command_arg(host))
        .replace("%h", &proxy_command_arg(host))
        .replace("{port}", &proxy_command_arg(&port.to_string()))
        .replace("%p", &proxy_command_arg(&port.to_string())))
}

#[derive(Debug)]
pub(crate) struct ProxyHelperCommand {
    executable: String,
    arguments: Vec<String>,
    environment: Vec<(String, String)>,
}

pub(crate) fn proxy_helper_command(
    proxy_helper_exe: &str,
    target_host: &str,
    target_port: u16,
    proxy: &SshProxyConfig,
) -> Result<ProxyHelperCommand, String> {
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
    Ok(ProxyHelperCommand {
        executable: proxy_helper_exe.to_string(),
        arguments: vec![
            "--shelldesk-proxy-helper".to_string(),
            proxy.helper_id.clone(),
            target_host.to_string(),
            target_port.to_string(),
        ],
        environment: vec![(
            crate::proxy::proxy_helper_env_name(&proxy.helper_id),
            encoded,
        )],
    })
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
        .replace('^', "^^")
        .replace('"', "\\\"")
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
        ProxyCommandTransport::spawn_shell(command_line, envs).map(Self::ProxyCommand)
    }

    pub(crate) fn proxy_helper(command: ProxyHelperCommand) -> Result<Self, String> {
        ProxyCommandTransport::spawn_helper(command).map(Self::ProxyCommand)
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
    fn spawn_shell(command_line: &str, envs: Vec<(String, String)>) -> Result<Self, String> {
        if command_line.trim().is_empty() {
            return Err("ProxyCommand 不能为空。".to_string());
        }
        let command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/D", "/V:OFF", "/C", command_line]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", command_line]);
            command
        };
        Self::spawn_command(command, envs)
    }

    fn spawn_helper(helper: ProxyHelperCommand) -> Result<Self, String> {
        let mut command = Command::new(helper.executable);
        command.args(helper.arguments);
        Self::spawn_command(command, helper.environment)
    }

    fn spawn_command(mut command: Command, envs: Vec<(String, String)>) -> Result<Self, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn proxy_config() -> SshProxyConfig {
        SshProxyConfig {
            proxy_type: "socks5".to_string(),
            host: "proxy.internal".to_string(),
            port: 1080,
            command: String::new(),
            username: "encoded-user-only".to_string(),
            password: "encoded-password-only".to_string(),
            helper_id: "proxy-1".to_string(),
        }
    }

    #[test]
    fn proxy_command_template_quotes_all_placeholders_for_current_shell() {
        let command =
            proxy_command_template("connect {host} %h {port} %p", "safe&echo bad", 22).unwrap();

        if cfg!(windows) {
            assert_eq!(
                command,
                "connect \"safe^&echo bad\" \"safe^&echo bad\" 22 22"
            );
        } else {
            assert_eq!(command, "connect 'safe&echo bad' 'safe&echo bad' 22 22");
        }
    }

    #[test]
    fn proxy_helper_command_rejects_blank_executable() {
        let error = proxy_helper_command(" \t ", "db.internal", 5432, &proxy_config())
            .expect_err("blank helper executable should be rejected");

        assert_eq!(error, "代理 helper 路径为空。");
    }

    #[test]
    fn proxy_helper_command_keeps_credentials_in_encoded_environment_payload() {
        let proxy = proxy_config();
        let command = proxy_helper_command("shelldesk", "db.internal", 5432, &proxy).unwrap();

        assert_eq!(command.executable, "shelldesk");
        assert_eq!(
            command.arguments,
            ["--shelldesk-proxy-helper", "proxy-1", "db.internal", "5432"]
        );
        assert_eq!(command.environment.len(), 1);

        let (env_name, encoded) = &command.environment[0];
        assert_eq!(env_name, "SHELLDESK_PROXY_CONFIG_PROXY_1");
        let payload = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(
            payload,
            json!({
                "type": "socks5",
                "host": "proxy.internal",
                "port": 1080,
                "username": "encoded-user-only",
                "password": "encoded-password-only"
            })
        );
    }

    #[test]
    fn cmd_quote_escapes_windows_metacharacters() {
        assert_eq!(
            cmd_quote(r#"a%b"c^d&e|f<g>h"#),
            "\"a%b\\\"c^^d^&e^|f^<g^>h\""
        );
    }

    #[test]
    fn proxy_helper_command_keeps_unsafe_arguments_out_of_the_shell() {
        let mut proxy = proxy_config();
        proxy.helper_id = r#"proxy id&"%SHELLDESK_SENTINEL%"#.to_string();
        let command = proxy_helper_command(
            r#"C:\Program Files\ShellDesk\helper.exe"#,
            r#"db host&"%SHELLDESK_SENTINEL%\"#,
            5432,
            &proxy,
        )
        .unwrap();

        assert_eq!(
            command.executable,
            r#"C:\Program Files\ShellDesk\helper.exe"#
        );
        assert_eq!(
            command.arguments,
            [
                "--shelldesk-proxy-helper",
                r#"proxy id&"%SHELLDESK_SENTINEL%"#,
                r#"db host&"%SHELLDESK_SENTINEL%\"#,
                "5432",
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn proxy_command_template_keeps_a_single_ipv6_zone_percent_literal() {
        let command_line = proxy_command_template("echo {host}", "fe80::1%12", 22).unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/D", "/V:OFF", "/C", &command_line])
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success());
        assert!(stdout.contains("fe80::1%12"), "stdout={stdout:?}");
    }

    #[cfg(windows)]
    #[test]
    fn proxy_command_template_rejects_percent_environment_expansion() {
        let error = proxy_command_template(
            "connect {host} 22",
            "before%SHELLDESK_QUOTE_SENTINEL%after",
            22,
        )
        .unwrap_err();

        assert!(error.contains("成对的百分号"));
    }

    #[test]
    fn proxy_command_transport_rejects_blank_command_before_spawning() {
        let error = RusshTransport::proxy_command(" \t ", Vec::new())
            .err()
            .expect("blank ProxyCommand should be rejected");

        assert_eq!(error, "ProxyCommand 不能为空。");
    }
}
