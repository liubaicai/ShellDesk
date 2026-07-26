use futures_util::{SinkExt, StreamExt};
use ironrdp_rdcleanpath::{DetectionResult, RDCleanPathPdu};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::Emitter;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time,
};
use tokio_rustls::{
    rustls::{
        client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider},
        pki_types::{CertificateDer, ServerName, UnixTime},
        ClientConfig, DigitallySignedStruct, SignatureScheme,
    },
    TlsConnector,
};
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use tokio_util::sync::CancellationToken;

use crate::{
    error_string, get_connection, random_id, read_string_field,
    ssh_tunnel::{
        create_tunnel_for_connection, spawn_tunnel_shutdown, SshTunnelGuard, SshTunnelHandle,
    },
    string_arg, AppState, ConnectionKind, DesktopProxySession,
};

const DEFAULT_RDP_PORT: u16 = 3389;
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CLEANPATH_PDU_SIZE: usize = 64 * 1024;
const MAX_TPKT_SIZE: usize = 4096;
const RDP_NEGOTIATION_REQUEST: [u8; 19] = [
    0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x0b,
    0x00, 0x00, 0x00,
];

#[derive(Clone)]
struct RdpProxyTarget {
    connect_host: String,
    connect_port: u16,
    server_host: String,
    server_port: u16,
    expected_destination: String,
    auth_token: String,
}

#[derive(Debug)]
struct AcceptRdpCertificate(CryptoProvider);

impl ServerCertVerifier for AcceptRdpCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
        // RDP servers commonly use self-signed certificates. IronRDP binds CredSSP
        // to the certificate chain returned by this local clean-path proxy.
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            signature,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            signature,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

pub(crate) async fn probe(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let (host, port, rdp_id) = read_rdp_config(&config)?;
    emit_diagnostic(
        &window,
        &connection_id,
        &rdp_id,
        "probe",
        &format!("Checking RDP target {host}:{port}"),
    );

    let result = probe_rdp_target(&state, &window, &connection_id, &host, port).await;
    match result {
        Ok(probe) => {
            emit_diagnostic(
                &window,
                &connection_id,
                &rdp_id,
                "probe-ready",
                "RDP negotiation completed.",
            );
            Ok(probe)
        }
        Err(error) => {
            emit_diagnostic(&window, &connection_id, &rdp_id, "probe-error", &error);
            Err(error)
        }
    }
}

pub(crate) async fn start(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let (host, port, rdp_id) = read_rdp_config(&config)?;
    let connection = get_connection(&state, &connection_id)?;
    let key = rdp_key(&connection_id, &rdp_id);

    stop_by_key(&state, &key)?;
    emit_diagnostic(
        &window,
        &connection_id,
        &rdp_id,
        "start",
        &format!("Starting RDP clean-path proxy for {host}:{port}"),
    );

    let (target_host, target_port, ssh_tunnel) = if connection.kind == ConnectionKind::Local {
        (host.clone(), port, None)
    } else {
        emit_diagnostic(
            &window,
            &connection_id,
            &rdp_id,
            "ssh-forward",
            &format!("Opening SSH tunnel 127.0.0.1:* -> {host}:{port}"),
        );
        let (tunnel, local_addr) =
            create_tunnel_for_connection(&state, &window, &connection_id, &host, port).await?;
        let local_addr = tunnel.local_addr().unwrap_or(local_addr);
        (local_addr.ip().to_string(), local_addr.port(), Some(tunnel))
    };
    let mut tunnel_guard = SshTunnelGuard::new("rdp", ssh_tunnel);
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(error_string)?;
    let ws_port = listener.local_addr().map_err(error_string)?.port();
    let auth_token = format!("{}{}", random_id("rdp"), random_id("token"));
    let expected_destination = format_destination(&host, port);
    let cancellation = CancellationToken::new();
    let server_cancellation = cancellation.clone();
    let event_window = window.clone();
    let event_connection_id = connection_id.clone();
    let event_rdp_id = rdp_id.clone();
    let proxy_target = RdpProxyTarget {
        connect_host: target_host,
        connect_port: target_port,
        server_host: host.clone(),
        server_port: port,
        expected_destination,
        auth_token: auth_token.clone(),
    };

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = server_cancellation.cancelled() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else {
                        break;
                    };
                    let next_window = event_window.clone();
                    let next_connection_id = event_connection_id.clone();
                    let next_rdp_id = event_rdp_id.clone();
                    let next_target = proxy_target.clone();
                    let next_cancellation = server_cancellation.clone();
                    tauri::async_runtime::spawn(async move {
                        let handler_cancellation = next_cancellation.clone();
                        let result = tokio::select! {
                            _ = next_cancellation.cancelled() => Ok(()),
                            result = handle_websocket(
                                stream,
                                next_target,
                                handler_cancellation,
                            ) => result,
                        };
                        if let Err(error) = result {
                            emit_diagnostic(
                                &next_window,
                                &next_connection_id,
                                &next_rdp_id,
                                "session-error",
                                &error,
                            );
                        }
                    });
                }
            }
        }
    });

    state.rdp_proxies.lock().map_err(error_string)?.insert(
        key,
        DesktopProxySession {
            connection_id: connection_id.clone(),
            cancellation,
            ssh_tunnel: tunnel_guard.take(),
        },
    );

    emit_diagnostic(
        &window,
        &connection_id,
        &rdp_id,
        "websocket-ready",
        &format!("RDP proxy listening on 127.0.0.1:{ws_port}"),
    );
    Ok(json!({
        "rdpId": rdp_id,
        "host": host,
        "port": port,
        "destination": format_destination(&host, port),
        "webSocketUrl": format!("ws://127.0.0.1:{ws_port}/rdp"),
        "authToken": auth_token
    }))
}

pub(crate) fn stop(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let rdp_id = string_arg(&args, 1)?;
    stop_by_key(state, &rdp_key(&connection_id, &rdp_id))?;
    Ok(json!(true))
}

fn read_rdp_config(config: &Value) -> Result<(String, u16, String), String> {
    let host = read_string_field(config, "host", "127.0.0.1");
    if host.is_empty() {
        return Err("RDP 主机不能为空。".to_string());
    }
    if host.chars().count() > 256 {
        return Err("RDP 主机长度不能超过 256 个字符。".to_string());
    }
    let port = config
        .get("port")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(DEFAULT_RDP_PORT));
    if !(1..=65535).contains(&port) {
        return Err("RDP 端口必须在 1 到 65535 之间。".to_string());
    }
    let rdp_id = read_string_field(config, "rdpId", &random_id("rdp"));
    if rdp_id.chars().count() > 128 {
        return Err("RDP 会话 ID 长度不能超过 128 个字符。".to_string());
    }
    Ok((host, port as u16, rdp_id))
}

async fn probe_rdp_target(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
    host: &str,
    port: u16,
) -> Result<Value, String> {
    let connection = get_connection(state, connection_id)?;
    let (target_host, target_port, ssh_tunnel): (String, u16, Option<SshTunnelHandle>) =
        if connection.kind == ConnectionKind::Local {
            (host.to_string(), port, None)
        } else {
            let (tunnel, local_addr) =
                create_tunnel_for_connection(state, window, connection_id, host, port).await?;
            let local_addr = tunnel.local_addr().unwrap_or(local_addr);
            (local_addr.ip().to_string(), local_addr.port(), Some(tunnel))
        };
    let _tunnel_guard = SshTunnelGuard::new("rdp-probe", ssh_tunnel);
    let mut stream = time::timeout(
        IO_TIMEOUT,
        TcpStream::connect((target_host.as_str(), target_port)),
    )
    .await
    .map_err(|_| "SSH 通道连接 RDP 超时。".to_string())?
    .map_err(error_string)?;
    write_all_timeout(
        &mut stream,
        &RDP_NEGOTIATION_REQUEST,
        "发送 RDP 探测请求超时。",
    )
    .await?;
    let response = read_tpkt(&mut stream).await?;
    let security = parse_negotiation_response(&response)?;
    Ok(json!({
        "host": host,
        "port": port,
        "protocol": "RDP",
        "securityProtocol": security
    }))
}

async fn handle_websocket(
    stream: TcpStream,
    target: RdpProxyTarget,
    cancellation: CancellationToken,
) -> Result<(), String> {
    let RdpProxyTarget {
        connect_host,
        connect_port,
        server_host,
        server_port,
        expected_destination,
        auth_token,
    } = target;
    let mut websocket = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(error_string)?;
    let request = match time::timeout(IO_TIMEOUT, read_cleanpath_request(&mut websocket)).await {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => {
            send_cleanpath_error(&mut websocket, 400).await;
            return Err(error);
        }
        Err(_) => {
            send_cleanpath_error(&mut websocket, 408).await;
            return Err("等待 RDCleanPath 请求超时。".to_string());
        }
    };
    if request.proxy_auth.as_deref() != Some(auth_token.as_str())
        || request.destination.as_deref() != Some(expected_destination.as_str())
    {
        send_cleanpath_error(&mut websocket, 403).await;
        return Err("RDP 代理会话授权失败。".to_string());
    }

    let mut target = match time::timeout(
        IO_TIMEOUT,
        TcpStream::connect((connect_host.as_str(), connect_port)),
    )
    .await
    {
        Ok(Ok(target)) => target,
        Ok(Err(error)) => {
            send_cleanpath_error(&mut websocket, 502).await;
            return Err(format!("连接 RDP 目标失败：{error}"));
        }
        Err(_) => {
            send_cleanpath_error(&mut websocket, 504).await;
            return Err("连接 RDP 目标超时。".to_string());
        }
    };

    if let Some(preconnection_blob) = request.preconnection_blob.as_deref() {
        write_all_timeout(
            &mut target,
            preconnection_blob.as_bytes(),
            "发送 RDP 预连接数据超时。",
        )
        .await?;
    }
    let x224_request = request
        .x224_connection_pdu
        .as_ref()
        .map(|value| value.as_bytes())
        .ok_or_else(|| "RDCleanPath 请求缺少 X.224 连接数据。".to_string())?;
    write_all_timeout(&mut target, x224_request, "发送 RDP X.224 请求超时。").await?;
    let x224_response = read_tpkt(&mut target).await?;
    if is_negotiation_failure(&x224_response) {
        let response =
            RDCleanPathPdu::new_negotiation_error(x224_response).map_err(error_string)?;
        send_cleanpath_response(&mut websocket, &response).await?;
        return Err("RDP 服务拒绝了安全协议协商。".to_string());
    }
    let selected_security = parse_negotiation_response(&x224_response)?;
    if selected_security == "RDP Security" {
        send_cleanpath_error(&mut websocket, 426).await;
        return Err("RDP 服务未启用 TLS/CredSSP，浏览器客户端无法安全连接。".to_string());
    }

    let provider = tokio_rustls::rustls::crypto::ring::default_provider();
    let verifier = Arc::new(AcceptRdpCertificate(provider.clone()));
    let client_config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(error_string)?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    let server_name = ServerName::try_from(server_host.trim_matches(['[', ']']).to_string())
        .map_err(|_| "RDP 主机名无法用于 TLS 握手。".to_string())?;
    let tls_stream = match time::timeout(
        IO_TIMEOUT,
        TlsConnector::from(Arc::new(client_config)).connect(server_name, target),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => {
            send_cleanpath_error(&mut websocket, 502).await;
            return Err(format!("RDP TLS 握手失败：{error}"));
        }
        Err(_) => {
            send_cleanpath_error(&mut websocket, 504).await;
            return Err("RDP TLS 握手超时。".to_string());
        }
    };
    let certificate_chain = tls_stream
        .get_ref()
        .1
        .peer_certificates()
        .ok_or_else(|| "RDP TLS 服务未返回证书链。".to_string())?
        .iter()
        .map(|certificate| certificate.as_ref().to_vec())
        .collect::<Vec<_>>();
    if certificate_chain.is_empty() {
        send_cleanpath_error(&mut websocket, 502).await;
        return Err("RDP TLS 服务返回了空证书链。".to_string());
    }
    let response = RDCleanPathPdu::new_response(
        format_destination(&server_host, server_port),
        x224_response,
        certificate_chain,
    )
    .map_err(error_string)?;
    send_cleanpath_response(&mut websocket, &response).await?;
    bridge_rdp(websocket, tls_stream, cancellation).await
}

async fn read_cleanpath_request(
    websocket: &mut WebSocketStream<TcpStream>,
) -> Result<RDCleanPathPdu, String> {
    let mut buffer = Vec::new();
    loop {
        let message = websocket
            .next()
            .await
            .ok_or_else(|| "RDP WebSocket 在握手前关闭。".to_string())?
            .map_err(error_string)?;
        match message {
            Message::Binary(bytes) => buffer.extend_from_slice(&bytes),
            Message::Ping(bytes) => websocket
                .send(Message::Pong(bytes))
                .await
                .map_err(error_string)?,
            Message::Close(_) => return Err("RDP WebSocket 在握手前关闭。".to_string()),
            Message::Text(_) => return Err("RDCleanPath 仅接受二进制消息。".to_string()),
            Message::Pong(_) | Message::Frame(_) => {}
        }
        if buffer.len() > MAX_CLEANPATH_PDU_SIZE {
            return Err("RDCleanPath 请求过大。".to_string());
        }
        match RDCleanPathPdu::detect(&buffer) {
            DetectionResult::Detected { total_length, .. } if buffer.len() == total_length => {
                return RDCleanPathPdu::from_der(&buffer).map_err(error_string);
            }
            DetectionResult::Detected { total_length, .. } if buffer.len() > total_length => {
                return Err("RDCleanPath 请求包含意外的尾随数据。".to_string());
            }
            DetectionResult::Failed => return Err("RDCleanPath 请求格式无效。".to_string()),
            DetectionResult::NotEnoughBytes | DetectionResult::Detected { .. } => {}
        }
    }
}

async fn bridge_rdp(
    websocket: WebSocketStream<TcpStream>,
    tls_stream: tokio_rustls::client::TlsStream<TcpStream>,
    cancellation: CancellationToken,
) -> Result<(), String> {
    let (mut ws_sink, mut ws_stream) = websocket.split();
    let (mut rdp_reader, mut rdp_writer) = tokio::io::split(tls_stream);
    let client_to_rdp = async {
        while let Some(message) = ws_stream.next().await {
            match message.map_err(error_string)? {
                Message::Binary(bytes) => {
                    rdp_writer.write_all(&bytes).await.map_err(error_string)?
                }
                Message::Close(_) => break,
                Message::Text(_) => return Err("RDP 会话收到非二进制消息。".to_string()),
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
        Ok::<(), String>(())
    };
    let rdp_to_client = async {
        let mut buffer = [0_u8; 32 * 1024];
        loop {
            let count = rdp_reader.read(&mut buffer).await.map_err(error_string)?;
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
        _ = cancellation.cancelled() => Ok(()),
        result = client_to_rdp => result,
        result = rdp_to_client => result,
    }
}

async fn read_tpkt(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut header = [0_u8; 4];
    read_exact_timeout(stream, &mut header, "读取 RDP TPKT 头超时。").await?;
    if header[0] != 3 || header[1] != 0 {
        return Err("RDP 服务返回了无效的 TPKT 头。".to_string());
    }
    let length = usize::from(u16::from_be_bytes([header[2], header[3]]));
    if !(11..=MAX_TPKT_SIZE).contains(&length) {
        return Err("RDP 服务返回了无效的 TPKT 长度。".to_string());
    }
    let mut packet = vec![0_u8; length];
    packet[..4].copy_from_slice(&header);
    read_exact_timeout(stream, &mut packet[4..], "读取 RDP 协商响应超时。").await?;
    Ok(packet)
}

fn parse_negotiation_response(packet: &[u8]) -> Result<&'static str, String> {
    if packet.len() < 19 || packet[5] != 0xd0 {
        return Err("RDP 服务返回了无效的 X.224 协商响应。".to_string());
    }
    match packet[11] {
        0x02 => {
            let protocol = u32::from_le_bytes([packet[15], packet[16], packet[17], packet[18]]);
            Ok(match protocol {
                0x00 => "RDP Security",
                0x01 => "TLS",
                0x02 => "CredSSP",
                0x04 => "RDSTLS",
                0x08 => "CredSSP Extended",
                0x10 => "RDS-AAD",
                _ => return Err(format!("RDP 服务选择了不支持的安全协议 0x{protocol:08x}。")),
            })
        }
        0x03 => {
            let code = u32::from_le_bytes([packet[15], packet[16], packet[17], packet[18]]);
            Err(format!("RDP 安全协议协商失败（代码 0x{code:08x}）。"))
        }
        _ => Err("RDP 服务未返回安全协议协商结果。".to_string()),
    }
}

fn is_negotiation_failure(packet: &[u8]) -> bool {
    packet.len() >= 19 && packet[5] == 0xd0 && packet[11] == 0x03
}

async fn read_exact_timeout(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    timeout_message: &str,
) -> Result<(), String> {
    time::timeout(IO_TIMEOUT, stream.read_exact(buffer))
        .await
        .map_err(|_| timeout_message.to_string())?
        .map(|_| ())
        .map_err(error_string)
}

async fn write_all_timeout(
    stream: &mut TcpStream,
    buffer: &[u8],
    timeout_message: &str,
) -> Result<(), String> {
    time::timeout(IO_TIMEOUT, stream.write_all(buffer))
        .await
        .map_err(|_| timeout_message.to_string())?
        .map_err(error_string)
}

async fn send_cleanpath_response(
    websocket: &mut WebSocketStream<TcpStream>,
    response: &RDCleanPathPdu,
) -> Result<(), String> {
    let bytes = response.to_der().map_err(error_string)?;
    websocket
        .send(Message::Binary(bytes.into()))
        .await
        .map_err(error_string)
}

async fn send_cleanpath_error(websocket: &mut WebSocketStream<TcpStream>, status: u16) {
    let _ = send_cleanpath_response(websocket, &RDCleanPathPdu::new_http_error(status)).await;
}

fn format_destination(host: &str, port: u16) -> String {
    let host = host.trim();
    if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn stop_by_key(state: &AppState, key: &str) -> Result<(), String> {
    if let Some(mut proxy) = state.rdp_proxies.lock().map_err(error_string)?.remove(key) {
        proxy.cancellation.cancel();
        if let Some(tunnel) = proxy.ssh_tunnel.take() {
            spawn_tunnel_shutdown("rdp", tunnel);
        }
    }
    Ok(())
}

fn rdp_key(connection_id: &str, rdp_id: &str) -> String {
    format!("{connection_id}:{rdp_id}")
}

fn emit_diagnostic(
    window: &tauri::Window,
    connection_id: &str,
    rdp_id: &str,
    stage: &str,
    detail: &str,
) {
    let _ = window.emit(
        "rdp:diagnostic",
        json!({
            "connectionId": connection_id,
            "rdpId": rdp_id,
            "stage": stage,
            "detail": detail
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn negotiation_response(protocol: u32) -> Vec<u8> {
        let mut response = vec![
            0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, 0x02, 0x00, 0x08,
            0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        response[15..19].copy_from_slice(&protocol.to_le_bytes());
        response
    }

    #[test]
    fn validates_rdp_config_and_port_range() {
        let (host, port, id) = read_rdp_config(&json!({
            "host": "10.0.0.8",
            "port": 3390,
            "rdpId": "viewer-1"
        }))
        .expect("valid config");
        assert_eq!(host, "10.0.0.8");
        assert_eq!(port, 3390);
        assert_eq!(id, "viewer-1");
        assert!(read_rdp_config(&json!({ "host": "", "port": 3389 })).is_err());
        assert!(read_rdp_config(&json!({ "port": 0 })).is_err());
        assert!(read_rdp_config(&json!({ "port": 70000 })).is_err());
    }

    #[test]
    fn formats_ipv4_hostnames_and_ipv6_destinations() {
        assert_eq!(
            format_destination("server.local", 3389),
            "server.local:3389"
        );
        assert_eq!(
            format_destination("2001:db8::8", 3389),
            "[2001:db8::8]:3389"
        );
        assert_eq!(
            format_destination("[2001:db8::8]", 3389),
            "[2001:db8::8]:3389"
        );
    }

    #[test]
    fn parses_rdp_security_protocols_and_failures() {
        assert_eq!(
            parse_negotiation_response(&negotiation_response(0x02)).expect("CredSSP"),
            "CredSSP"
        );
        assert_eq!(
            parse_negotiation_response(&negotiation_response(0x08)).expect("CredSSP Extended"),
            "CredSSP Extended"
        );
        assert_eq!(
            parse_negotiation_response(&negotiation_response(0x04)).expect("RDSTLS"),
            "RDSTLS"
        );
        assert_eq!(
            parse_negotiation_response(&negotiation_response(0x10)).expect("RDS-AAD"),
            "RDS-AAD"
        );
        assert!(parse_negotiation_response(&negotiation_response(0x20)).is_err());
        let mut failure = negotiation_response(0x05);
        failure[11] = 0x03;
        assert!(is_negotiation_failure(&failure));
        assert!(parse_negotiation_response(&failure).is_err());
    }
}
