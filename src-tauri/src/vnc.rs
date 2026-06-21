use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Emitter;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    time,
};
use tokio_tungstenite::tungstenite::Message;

use crate::{
    error_string, get_connection, random_id, read_string_field,
    ssh_tunnel::{create_tunnel_with_fallback, spawn_tunnel_shutdown, SshTunnelHandle},
    string_arg, AppState, ConnectionKind, VncProxySession,
};

struct VncTunnelGuard {
    tunnel: Option<SshTunnelHandle>,
}

impl VncTunnelGuard {
    fn new(tunnel: Option<SshTunnelHandle>) -> Self {
        Self { tunnel }
    }

    fn take(&mut self) -> Option<SshTunnelHandle> {
        self.tunnel.take()
    }
}

impl Drop for VncTunnelGuard {
    fn drop(&mut self) {
        if let Some(tunnel) = self.tunnel.take() {
            spawn_tunnel_shutdown("vnc", tunnel);
        }
    }
}

pub(crate) async fn probe(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let (host, port, vnc_id) = read_vnc_config(&config)?;
    emit_diagnostic(
        window,
        &connection_id,
        &vnc_id,
        "probe",
        &format!("Checking VNC target {host}:{port}"),
    );
    let result = probe_vnc_target(state, window, &connection_id, &host, port).await;
    let probe = match result {
        Ok(probe) => probe,
        Err(error) => {
            emit_diagnostic(window, &connection_id, &vnc_id, "probe-error", &error);
            return Err(error);
        }
    };
    if probe
        .get("securityTypes")
        .and_then(Value::as_array)
        .is_none()
    {
        let error = "VNC 服务探测结果无效。".to_string();
        emit_diagnostic(window, &connection_id, &vnc_id, "probe-error", &error);
        return Err(error);
    }
    emit_diagnostic(
        window,
        &connection_id,
        &vnc_id,
        "probe-ready",
        "VNC target port is reachable.",
    );
    Ok(probe)
}

pub(crate) async fn start(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let (host, port, vnc_id) = read_vnc_config(&config)?;
    let connection = get_connection(state, &connection_id)?;
    emit_diagnostic(
        window,
        &connection_id,
        &vnc_id,
        "start",
        &format!("Starting VNC proxy for {host}:{port}"),
    );

    stop_by_key(state, &vnc_key(&connection_id, &vnc_id))?;

    let (target_host, target_port, ssh_tunnel) = if connection.kind == ConnectionKind::Local {
        emit_diagnostic(
            window,
            &connection_id,
            &vnc_id,
            "target",
            &format!("Using local VNC target {host}:{port}"),
        );
        (host.clone(), port, None)
    } else {
        emit_diagnostic(
            window,
            &connection_id,
            &vnc_id,
            "ssh-forward",
            &format!("Opening SSH tunnel 127.0.0.1:* -> {host}:{port}"),
        );
        let (tunnel, local_addr) =
            create_tunnel_with_fallback(state, window, &connection_id, &host, port).await?;
        let local_addr = tunnel.local_addr().unwrap_or(local_addr);
        let forward_port = local_addr.port();
        emit_diagnostic(
            window,
            &connection_id,
            &vnc_id,
            "ssh-forward-ready",
            &format!("SSH tunnel ready at {} -> {host}:{port}", local_addr),
        );
        (local_addr.ip().to_string(), forward_port, Some(tunnel))
    };
    let mut tunnel_guard = VncTunnelGuard::new(ssh_tunnel);

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(error_string)?;
    let ws_port = listener.local_addr().map_err(error_string)?.port();
    emit_diagnostic(
        window,
        &connection_id,
        &vnc_id,
        "websocket-ready",
        &format!("Listening on ws://127.0.0.1:{ws_port}/"),
    );
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let server_target_host = target_host.clone();
    let event_window = window.clone();
    let event_connection_id = connection_id.clone();
    let event_vnc_id = vnc_id.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let next_host = server_target_host.clone();
                            let next_window = event_window.clone();
                            let next_connection_id = event_connection_id.clone();
                            let next_vnc_id = event_vnc_id.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(error) = handle_websocket(stream, next_host, target_port).await {
                                    emit_diagnostic(
                                        &next_window,
                                        &next_connection_id,
                                        &next_vnc_id,
                                        "target-error",
                                        &error,
                                    );
                                }
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });

    state.vnc_proxies.lock().map_err(error_string)?.insert(
        vnc_key(&connection_id, &vnc_id),
        VncProxySession {
            connection_id: connection_id.clone(),
            shutdown: Some(shutdown_tx),
            ssh_tunnel: tunnel_guard.take(),
        },
    );

    Ok(json!({
        "vncId": vnc_id,
        "host": host,
        "port": port,
        "webSocketUrl": format!("ws://127.0.0.1:{ws_port}/")
    }))
}

pub(crate) fn stop(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let vnc_id = string_arg(&args, 1)?;
    stop_by_key(state, &vnc_key(&connection_id, &vnc_id))?;
    Ok(json!(true))
}

fn emit_diagnostic(
    window: &tauri::Window,
    connection_id: &str,
    vnc_id: &str,
    stage: &str,
    detail: &str,
) {
    let _ = window.emit(
        "vnc:diagnostic",
        json!({
            "connectionId": connection_id,
            "vncId": vnc_id,
            "stage": stage,
            "detail": detail
        }),
    );
}

fn read_vnc_config(config: &Value) -> Result<(String, u16, String), String> {
    let host = read_string_field(config, "host", "127.0.0.1");
    if host.chars().count() > 256 {
        return Err("VNC 主机长度不能超过 256 个字符。".to_string());
    }
    let port = config.get("port").and_then(Value::as_u64).unwrap_or(5900);
    if !(1..=65535).contains(&port) {
        return Err("VNC 端口必须在 1 到 65535 之间。".to_string());
    }
    let vnc_id = read_string_field(config, "vncId", &random_id("vnc"));
    if vnc_id.chars().count() > 128 {
        return Err("VNC 会话 ID 长度不能超过 128 个字符。".to_string());
    }
    Ok((host, port as u16, vnc_id))
}

async fn probe_vnc_target(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
    host: &str,
    port: u16,
) -> Result<Value, String> {
    let connection = get_connection(state, connection_id)?;
    let (target_host, target_port, mut ssh_tunnel): (String, u16, Option<SshTunnelHandle>) =
        if connection.kind == ConnectionKind::Local {
            (host.to_string(), port, None)
        } else {
            let (tunnel, local_addr) =
                create_tunnel_with_fallback(state, window, connection_id, host, port).await?;
            let local_addr = tunnel.local_addr().unwrap_or(local_addr);
            let forward_port = local_addr.port();
            (local_addr.ip().to_string(), forward_port, Some(tunnel))
        };
    let result = async {
        let mut stream = time::timeout(
            Duration::from_secs(12),
            TcpStream::connect((target_host.as_str(), target_port)),
        )
        .await
        .map_err(|_| "SSH 通道连接 VNC 超时。".to_string())?
        .map_err(error_string)?;
        read_vnc_server_handshake(&mut stream, host, port).await
    }
    .await;
    if let Some(tunnel) = ssh_tunnel.take() {
        spawn_tunnel_shutdown("vnc", tunnel);
    }
    result
}

async fn read_vnc_server_handshake(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
) -> Result<Value, String> {
    let mut banner_buffer = [0_u8; 12];
    read_exact_timeout(stream, &mut banner_buffer, "读取 VNC 协议头超时。").await?;
    let banner = String::from_utf8_lossy(&banner_buffer).to_string();
    let version = banner.get(4..11).unwrap_or("").to_string();
    if !is_valid_vnc_banner(&banner) {
        return Err(format!("VNC 服务返回了无效协议头：{banner:?}"));
    }
    stream
        .write_all(&banner_buffer)
        .await
        .map_err(error_string)?;
    let security_types = read_vnc_security_types(stream, &version).await?;
    Ok(json!({
        "host": host,
        "port": port,
        "banner": banner.trim(),
        "version": version,
        "securityTypes": security_types
    }))
}

async fn read_exact_timeout(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    timeout_message: &str,
) -> Result<(), String> {
    time::timeout(Duration::from_secs(12), stream.read_exact(buffer))
        .await
        .map_err(|_| timeout_message.to_string())?
        .map(|_| ())
        .map_err(error_string)
}

async fn read_vnc_security_types(stream: &mut TcpStream, version: &str) -> Result<Value, String> {
    if version == "003.003" || version == "003.006" {
        let mut security_type = [0_u8; 4];
        read_exact_timeout(stream, &mut security_type, "读取 VNC 安全类型超时。").await?;
        let code = u32::from_be_bytes(security_type);
        return Ok(json!([vnc_security_type_value(code)]));
    }
    let mut count = [0_u8; 1];
    read_exact_timeout(stream, &mut count, "读取 VNC 安全类型数量超时。").await?;
    if count[0] == 0 {
        let mut reason_length = [0_u8; 4];
        read_exact_timeout(stream, &mut reason_length, "读取 VNC 拒绝原因超时。").await?;
        let reason_length = u32::from_be_bytes(reason_length).min(4096) as usize;
        let mut reason = vec![0_u8; reason_length];
        if reason_length > 0 {
            read_exact_timeout(stream, &mut reason, "读取 VNC 拒绝原因超时。").await?;
        }
        let reason = String::from_utf8_lossy(&reason).to_string();
        return Err(if reason.trim().is_empty() {
            "没有可用的安全类型。".to_string()
        } else {
            reason
        });
    }
    let mut security_type_bytes = vec![0_u8; count[0] as usize];
    read_exact_timeout(
        stream,
        &mut security_type_bytes,
        "读取 VNC 安全类型列表超时。",
    )
    .await?;
    Ok(Value::Array(
        security_type_bytes
            .into_iter()
            .map(|code| vnc_security_type_value(code as u32))
            .collect(),
    ))
}

fn is_valid_vnc_banner(banner: &str) -> bool {
    let bytes = banner.as_bytes();
    bytes.len() == 12
        && bytes.starts_with(b"RFB ")
        && bytes[7] == b'.'
        && bytes[11] == b'\n'
        && bytes[4..7].iter().all(u8::is_ascii_digit)
        && bytes[8..11].iter().all(u8::is_ascii_digit)
}

fn vnc_security_type_value(code: u32) -> Value {
    json!({
        "code": code,
        "name": vnc_security_type_name(code)
    })
}

fn vnc_security_type_name(code: u32) -> &'static str {
    match code {
        0 => "Failure",
        1 => "None",
        2 => "VNCAuth",
        6 => "RA2ne",
        16 => "Tight",
        19 => "VeNCrypt",
        22 => "XVP",
        30 => "Apple Remote Desktop",
        113 => "MSLogonII",
        129 => "Tight Unix Login",
        256 => "Plain",
        _ => "Unknown",
    }
}

fn stop_by_key(state: &AppState, key: &str) -> Result<(), String> {
    if let Some(mut proxy) = state.vnc_proxies.lock().map_err(error_string)?.remove(key) {
        if let Some(shutdown) = proxy.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(tunnel) = proxy.ssh_tunnel.take() {
            spawn_tunnel_shutdown("vnc", tunnel);
        }
    }
    Ok(())
}

async fn handle_websocket(
    stream: TcpStream,
    target_host: String,
    target_port: u16,
) -> Result<(), String> {
    let websocket = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(error_string)?;
    let target = TcpStream::connect((target_host.as_str(), target_port))
        .await
        .map_err(error_string)?;
    let (mut ws_sink, mut ws_stream) = websocket.split();
    let (mut target_reader, mut target_writer) = target.into_split();

    let client_to_target = async {
        while let Some(message) = ws_stream.next().await {
            let message = message.map_err(error_string)?;
            match message {
                Message::Binary(bytes) => target_writer
                    .write_all(&bytes)
                    .await
                    .map_err(error_string)?,
                Message::Text(text) => target_writer
                    .write_all(text.to_string().as_bytes())
                    .await
                    .map_err(error_string)?,
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
        Ok::<(), String>(())
    };

    let target_to_client = async {
        let mut buffer = [0_u8; 16384];
        loop {
            let count = target_reader
                .read(&mut buffer)
                .await
                .map_err(error_string)?;
            if count == 0 {
                break;
            }
            ws_sink
                .send(Message::Binary(buffer[..count].to_vec().into()))
                .await
                .map_err(error_string)?;
        }
        let _ = ws_sink.send(Message::Close(None)).await;
        Ok::<(), String>(())
    };

    tokio::select! {
        result = client_to_target => result,
        result = target_to_client => result,
    }
}

fn vnc_key(connection_id: &str, vnc_id: &str) -> String {
    format!("{connection_id}:{vnc_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_vnc_rfb_banners() {
        assert!(is_valid_vnc_banner("RFB 003.003\n"));
        assert!(is_valid_vnc_banner("RFB 003.008\n"));
        assert!(!is_valid_vnc_banner("HTTP/1.1 200"));
        assert!(!is_valid_vnc_banner("RFB 003.008\r"));
        assert!(!is_valid_vnc_banner("RFB abc.008\n"));
    }

    #[test]
    fn maps_legacy_vnc_security_type_names() {
        assert_eq!(vnc_security_type_name(1), "None");
        assert_eq!(vnc_security_type_name(2), "VNCAuth");
        assert_eq!(vnc_security_type_name(19), "VeNCrypt");
        assert_eq!(vnc_security_type_name(256), "Plain");
        assert_eq!(vnc_security_type_name(999), "Unknown");
    }

    #[test]
    fn validates_vnc_config_port_range_before_u16_cast() {
        assert_eq!(
            read_vnc_config(&json!({ "host": "127.0.0.1", "port": 5901, "vncId": "viewer-1" }))
                .unwrap(),
            ("127.0.0.1".to_string(), 5901, "viewer-1".to_string())
        );
        assert!(read_vnc_config(&json!({ "port": 0 })).is_err());
        assert!(read_vnc_config(&json!({ "port": 70000 })).is_err());
    }
}
