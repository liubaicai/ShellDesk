use crate::{
    error_string, get_connection, https_url_origin,
    ssh_tunnel::{create_tunnel_with_fallback, spawn_tunnel_shutdown, SshTunnelHandle},
    string_arg, AppState, ConnectionKind, SshProfile,
};
use crate::{run_ssh_command_for_profile_with_window, shell_quote};
use base64::Engine;
use reqwest::header::{CONTENT_ENCODING, CONTENT_TYPE, HOST};
use serde_json::{json, Value};
use std::{net::SocketAddr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    time,
};

pub(crate) struct BrowserProxySession {
    pub(crate) connection_id: String,
    pub(crate) local_port: u16,
    pub(crate) shutdown: Option<oneshot::Sender<()>>,
    pub(crate) ssh_tunnel: Option<SshTunnelHandle>,
}

#[derive(Clone)]
struct BrowserRemoteFallback {
    state: AppState,
    window: tauri::Window,
    profile: SshProfile,
}

pub(crate) async fn browser_resolve_url(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let raw_url = string_arg(&args, 1)?;
    let connection = get_connection(state, &connection_id)?;
    let parsed = reqwest::Url::parse(&raw_url).map_err(|_| "浏览器 URL 无效。".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("远程浏览器只支持 http 和 https URL。".to_string());
    }
    let trusted_certificate_origin = https_url_origin(parsed.as_str())
        .filter(|origin| connection.browser_certificate_trust.contains(origin));
    let trusted_certificate = trusted_certificate_origin.is_some();
    let use_trusted_https_proxy = parsed.scheme() == "https" && trusted_certificate;

    if connection.kind == ConnectionKind::Local {
        if use_trusted_https_proxy {
            let key = browser_proxy_key(
                &connection_id,
                "trusted-https",
                parsed.host_str().unwrap_or(""),
                parsed.port_or_known_default().unwrap_or(443),
            );
            let proxy_port = ensure_browser_reverse_proxy(
                state,
                key,
                connection_id.clone(),
                parsed.clone(),
                None,
                true,
                None,
            )
            .await?;
            let browser_url = browser_proxy_url(&parsed, proxy_port, "http")?;
            return Ok(json!({
                "url": parsed.to_string(),
                "browserUrl": browser_url,
                "proxied": true,
                "mode": "trusted-https-proxy",
                "localPort": proxy_port,
                "targetHost": parsed.host_str().unwrap_or(""),
                "targetPort": parsed.port_or_known_default().unwrap_or(443),
                "trustedCertificate": trusted_certificate,
                "trustedCertificateOrigin": trusted_certificate_origin
            }));
        }
        return Ok(json!({
            "url": parsed.to_string(),
            "browserUrl": parsed.to_string(),
            "proxied": false,
            "mode": "direct",
            "trustedCertificate": trusted_certificate,
            "trustedCertificateOrigin": trusted_certificate_origin
        }));
    }

    let target_host = parsed
        .host_str()
        .ok_or_else(|| "浏览器 URL 缺少主机名。".to_string())?
        .to_string();
    let target_port = parsed
        .port_or_known_default()
        .ok_or_else(|| "浏览器 URL 缺少端口。".to_string())?;
    let proxy_key_scheme = if use_trusted_https_proxy {
        "trusted-https"
    } else if parsed.scheme() == "https" {
        "reverse-https"
    } else {
        "reverse-http"
    };
    let key = browser_proxy_key(&connection_id, proxy_key_scheme, &target_host, target_port);

    if let Some(existing_port) = healthy_browser_proxy_port(state, &key).await? {
        let browser_url = browser_proxy_url(&parsed, existing_port, "http")?;
        return Ok(json!({
            "url": parsed.to_string(),
            "browserUrl": browser_url,
            "proxied": true,
            "mode": if use_trusted_https_proxy { "trusted-https-proxy" } else { "browser-reverse-proxy" },
            "localPort": existing_port,
            "targetHost": target_host,
            "targetPort": target_port,
            "trustedCertificate": trusted_certificate,
            "trustedCertificateOrigin": trusted_certificate_origin
        }));
    }

    let profile = connection
        .ssh
        .clone()
        .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
    let (tunnel, local_addr) =
        create_tunnel_with_fallback(state, window, &connection_id, &target_host, target_port)
            .await?;
    let local_addr = tunnel.local_addr().unwrap_or(local_addr);
    let tunnel_port = local_addr.port();

    let remote_fallback = Some(BrowserRemoteFallback {
        state: state.clone(),
        window: window.clone(),
        profile: profile.clone(),
    });
    let proxy_port = match start_browser_reverse_proxy(
        parsed.clone(),
        Some(tunnel_port),
        trusted_certificate,
        remote_fallback,
    )
    .await
    {
        Ok(proxy_port) => proxy_port,
        Err(error) => {
            spawn_tunnel_shutdown("browser", tunnel);
            return Err(error);
        }
    };
    let browser_port = proxy_port.0;
    let browser_url = browser_proxy_url(&parsed, browser_port, "http")?;
    let shutdown = Some(proxy_port.1);
    state.browser_proxies.lock().map_err(error_string)?.insert(
        key,
        BrowserProxySession {
            connection_id: connection_id.clone(),
            local_port: browser_port,
            shutdown,
            ssh_tunnel: Some(tunnel),
        },
    );

    Ok(json!({
        "url": parsed.to_string(),
        "browserUrl": browser_url,
        "proxied": true,
        "mode": if use_trusted_https_proxy { "trusted-https-proxy" } else { "browser-reverse-proxy" },
        "localPort": browser_port,
        "targetHost": target_host,
        "targetPort": target_port,
        "trustedCertificate": trusted_certificate,
        "trustedCertificateOrigin": trusted_certificate_origin
    }))
}

fn browser_proxy_key(connection_id: &str, scheme: &str, host: &str, port: u16) -> String {
    format!(
        "{connection_id}:{scheme}:{}:{port}",
        host.to_ascii_lowercase()
    )
}

fn browser_proxy_url(
    parsed: &reqwest::Url,
    local_port: u16,
    scheme: &str,
) -> Result<String, String> {
    let mut browser_url = parsed.clone();
    browser_url
        .set_scheme(scheme)
        .map_err(|_| "浏览器代理协议无效。".to_string())?;
    browser_url
        .set_host(Some("127.0.0.1"))
        .map_err(|_| "浏览器代理地址无效。".to_string())?;
    browser_url
        .set_port(Some(local_port))
        .map_err(|_| "浏览器代理端口无效。".to_string())?;
    Ok(browser_url.to_string())
}

async fn ensure_browser_reverse_proxy(
    state: &AppState,
    key: String,
    connection_id: String,
    upstream_url: reqwest::Url,
    upstream_forward_port: Option<u16>,
    accept_invalid_certs: bool,
    remote_fallback: Option<BrowserRemoteFallback>,
) -> Result<u16, String> {
    if let Some(existing_port) = healthy_browser_proxy_port(state, &key).await? {
        return Ok(existing_port);
    }
    let (proxy_port, shutdown) = start_browser_reverse_proxy(
        upstream_url,
        upstream_forward_port,
        accept_invalid_certs,
        remote_fallback,
    )
    .await?;
    state.browser_proxies.lock().map_err(error_string)?.insert(
        key,
        BrowserProxySession {
            connection_id,
            local_port: proxy_port,
            shutdown: Some(shutdown),
            ssh_tunnel: None,
        },
    );
    Ok(proxy_port)
}

async fn healthy_browser_proxy_port(state: &AppState, key: &str) -> Result<Option<u16>, String> {
    let existing_port = state
        .browser_proxies
        .lock()
        .map_err(error_string)?
        .get(key)
        .map(|proxy| proxy.local_port);

    let Some(existing_port) = existing_port else {
        return Ok(None);
    };

    if local_browser_proxy_accepts_connections(existing_port).await {
        return Ok(Some(existing_port));
    }

    let stale_proxy = {
        let mut proxies = state.browser_proxies.lock().map_err(error_string)?;
        if proxies
            .get(key)
            .is_some_and(|proxy| proxy.local_port == existing_port)
        {
            proxies.remove(key)
        } else {
            None
        }
    };
    if let Some(proxy) = stale_proxy {
        shutdown_browser_proxy(proxy);
    }
    Ok(None)
}

async fn local_browser_proxy_accepts_connections(port: u16) -> bool {
    match time::timeout(
        Duration::from_millis(750),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    {
        Ok(Ok(mut stream)) => {
            let _ = stream.shutdown().await;
            true
        }
        _ => false,
    }
}

fn shutdown_browser_proxy(mut proxy: BrowserProxySession) {
    if let Some(shutdown) = proxy.shutdown.take() {
        let _ = shutdown.send(());
    }
    if let Some(tunnel) = proxy.ssh_tunnel.take() {
        spawn_tunnel_shutdown("browser", tunnel);
    }
}

async fn start_browser_reverse_proxy(
    upstream_url: reqwest::Url,
    upstream_forward_port: Option<u16>,
    accept_invalid_certs: bool,
    remote_fallback: Option<BrowserRemoteFallback>,
) -> Result<(u16, oneshot::Sender<()>), String> {
    let host = upstream_url
        .host_str()
        .ok_or_else(|| "浏览器 URL 缺少主机名。".to_string())?
        .to_string();
    let upstream_origin = origin_from_url(&upstream_url)?;
    let upstream_host_header = host_header_from_url(&upstream_url)?;
    let request_origin =
        request_origin_for_upstream(&upstream_url, upstream_forward_port, accept_invalid_certs)?;
    let mut client_builder = reqwest::Client::builder()
        .danger_accept_invalid_certs(accept_invalid_certs)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(forward_port) = upstream_forward_port.filter(|_| request_origin == upstream_origin)
    {
        client_builder = client_builder
            .resolve_to_addrs(&host, &[SocketAddr::from(([127, 0, 0, 1], forward_port))]);
    }
    let client = client_builder.build().map_err(error_string)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(error_string)?;
    let proxy_port = listener.local_addr().map_err(error_string)?.port();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _)) => {
                            let next_client = client.clone();
                            let next_origin = upstream_origin.clone();
                            let next_request_origin = request_origin.clone();
                            let next_host_header = upstream_host_header.clone();
                            let next_remote_fallback = remote_fallback.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = handle_trusted_https_browser_proxy(
                                    stream,
                                    next_client,
                                    next_origin,
                                    next_request_origin,
                                    next_host_header,
                                    next_remote_fallback,
                                ).await;
                            });
                        }
                        Err(_) => break,
                    }
                }
            }
        }
    });
    Ok((proxy_port, shutdown_tx))
}

fn origin_from_url(url: &reqwest::Url) -> Result<String, String> {
    let mut origin = url.clone();
    origin.set_path("");
    origin.set_query(None);
    origin.set_fragment(None);
    let mut text = origin.to_string();
    if text.ends_with('/') {
        text.pop();
    }
    Ok(text)
}

fn host_header_from_url(url: &reqwest::Url) -> Result<String, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "浏览器 URL 缺少主机名。".to_string())?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

fn request_origin_for_upstream(
    upstream_url: &reqwest::Url,
    upstream_forward_port: Option<u16>,
    accept_invalid_certs: bool,
) -> Result<String, String> {
    let Some(forward_port) = upstream_forward_port else {
        return origin_from_url(upstream_url);
    };
    if !should_use_forward_origin(upstream_url, accept_invalid_certs) {
        return origin_from_url(upstream_url);
    }
    let mut request_url = upstream_url.clone();
    request_url
        .set_host(Some("127.0.0.1"))
        .map_err(|_| "浏览器代理地址无效。".to_string())?;
    request_url
        .set_port(Some(forward_port))
        .map_err(|_| "浏览器代理端口无效。".to_string())?;
    origin_from_url(&request_url)
}

fn should_use_forward_origin(upstream_url: &reqwest::Url, accept_invalid_certs: bool) -> bool {
    upstream_url.scheme() == "http"
        || accept_invalid_certs
        || upstream_url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host.eq_ignore_ascii_case("localhost.")
                || host.parse::<std::net::IpAddr>().is_ok()
        })
}

async fn handle_trusted_https_browser_proxy(
    mut stream: TcpStream,
    client: reqwest::Client,
    upstream_origin: String,
    request_origin: String,
    upstream_host_header: String,
    remote_fallback: Option<BrowserRemoteFallback>,
) -> Result<(), String> {
    let (method, target, headers, body) = read_browser_http_request(&mut stream).await?;
    let browser_host = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let upstream_url = browser_request_url(
        &target,
        browser_host.as_str(),
        &upstream_origin,
        &request_origin,
    );
    let remote_upstream_url = browser_request_url(
        &target,
        browser_host.as_str(),
        &upstream_origin,
        &upstream_origin,
    );
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "浏览器请求方法无效。".to_string())?;
    let method_text = method.as_str().to_string();
    let fallback_headers = headers.clone();
    let fallback_body = body.clone();
    let mut request = client
        .request(method, upstream_url)
        .header(HOST, upstream_host_header.clone());
    for (name, value) in &headers {
        let name_lower = name.to_ascii_lowercase();
        if should_skip_browser_request_header(&name_lower) || name_lower == "host" {
            continue;
        }
        request = request.header(name.as_str(), value.as_str());
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            if let Some(fallback) = remote_fallback {
                return handle_remote_browser_proxy(
                    &mut stream,
                    fallback,
                    method_text,
                    remote_upstream_url,
                    fallback_headers,
                    fallback_body,
                    upstream_origin,
                    request_origin,
                    upstream_host_header,
                    browser_host,
                )
                .await;
            }
            return Err(error_string(error));
        }
    };
    let status = response.status();
    let response_headers = response.headers().clone();
    let body = response.bytes().await.map_err(error_string)?.to_vec();
    let content_type = response_headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let content_encoding = response_headers
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok());
    let (body, body_rewritten) = rewrite_browser_response_body(
        body,
        content_type,
        content_encoding,
        &upstream_origin,
        &request_origin,
        &browser_host,
    );
    let reason = status.canonical_reason().unwrap_or("");
    let mut raw = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), reason);
    for (name, value) in response_headers.iter() {
        let name_lower = name.as_str().to_ascii_lowercase();
        if is_skipped_browser_response_header(&name_lower) {
            continue;
        }
        if body_rewritten && is_body_integrity_response_header(&name_lower) {
            continue;
        }
        if let Ok(mut value) = value.to_str().map(str::to_string) {
            if is_content_security_policy_header(&name_lower) {
                value = remove_csp_frame_ancestors(&value);
                if value.is_empty() {
                    continue;
                }
            }
            if name_lower == "location"
                && (value.starts_with(&upstream_origin) || value.starts_with(&request_origin))
                && !browser_host.is_empty()
            {
                let origin = if value.starts_with(&upstream_origin) {
                    &upstream_origin
                } else {
                    &request_origin
                };
                value = format!("http://{}{}", browser_host, &value[origin.len()..]);
            }
            raw.push_str(name.as_str());
            raw.push_str(": ");
            raw.push_str(&value);
            raw.push_str("\r\n");
        }
    }
    raw.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    stream
        .write_all(raw.as_bytes())
        .await
        .map_err(error_string)?;
    stream.write_all(&body).await.map_err(error_string)?;
    let _ = stream.shutdown().await;
    Ok(())
}

fn browser_request_url(
    target: &str,
    browser_host: &str,
    upstream_origin: &str,
    request_origin: &str,
) -> String {
    if target.starts_with('/') {
        return format!("{request_origin}{target}");
    }
    if !target.starts_with("http://") && !target.starts_with("https://") {
        return format!("{request_origin}/{target}");
    }

    let Ok(parsed) = reqwest::Url::parse(target) else {
        return target.to_string();
    };
    let Ok(target_origin) = origin_from_url(&parsed) else {
        return target.to_string();
    };
    let browser_origin = (!browser_host.is_empty()).then(|| format!("http://{browser_host}"));
    if browser_origin.as_deref() == Some(target_origin.as_str())
        || target_origin == upstream_origin
        || target_origin == request_origin
    {
        return format!("{request_origin}{}", path_query_fragment(&parsed));
    }
    target.to_string()
}

fn path_query_fragment(url: &reqwest::Url) -> String {
    let mut output = url.path().to_string();
    if output.is_empty() {
        output.push('/');
    }
    if let Some(query) = url.query() {
        output.push('?');
        output.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        output.push('#');
        output.push_str(fragment);
    }
    output
}

async fn handle_remote_browser_proxy(
    stream: &mut TcpStream,
    fallback: BrowserRemoteFallback,
    method: String,
    upstream_url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    upstream_origin: String,
    request_origin: String,
    upstream_host_header: String,
    browser_host: String,
) -> Result<(), String> {
    let command = remote_browser_curl_command(
        &method,
        &upstream_url,
        &upstream_host_header,
        &headers,
        !body.is_empty(),
    );
    let stdin = String::from_utf8_lossy(&body).to_string();
    let output = run_ssh_command_for_profile_with_window(
        &fallback.state,
        Some(fallback.window),
        fallback.profile,
        command,
        stdin,
    )
    .await?;
    let stdout = output
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let stderr = output.get("stderr").and_then(Value::as_str).unwrap_or("");
    let success = output
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if stdout.is_empty() {
        let reason = if stderr.trim().is_empty() {
            "远程 curl 未返回数据。".to_string()
        } else {
            format!("远程 curl 请求失败：{}", stderr.trim())
        };
        write_browser_error_response(stream, 502, &reason).await?;
        return Ok(());
    }
    let response_bytes = base64::engine::general_purpose::STANDARD
        .decode(stdout)
        .map_err(|error| format!("远程浏览器响应解码失败：{error}"))?;
    if !success && response_bytes.is_empty() {
        let reason = if stderr.trim().is_empty() {
            "远程 curl 请求失败。".to_string()
        } else {
            format!("远程 curl 请求失败：{}", stderr.trim())
        };
        write_browser_error_response(stream, 502, &reason).await?;
        return Ok(());
    }
    write_remote_browser_response(
        stream,
        &response_bytes,
        &upstream_origin,
        &request_origin,
        &browser_host,
    )
    .await
}

fn remote_browser_curl_command(
    method: &str,
    upstream_url: &str,
    upstream_host_header: &str,
    headers: &[(String, String)],
    has_body: bool,
) -> String {
    let mut parts = vec![
        "curl".to_string(),
        "-sS".to_string(),
        "--max-time".to_string(),
        "30".to_string(),
        "--http1.1".to_string(),
        "-i".to_string(),
        "-X".to_string(),
        shell_quote(method),
        "-H".to_string(),
        shell_quote(&format!("Host: {upstream_host_header}")),
    ];
    for (name, value) in headers {
        let name_lower = name.to_ascii_lowercase();
        if should_skip_browser_request_header(&name_lower)
            || matches!(name_lower.as_str(), "host" | "content-length")
        {
            continue;
        }
        parts.push("-H".to_string());
        parts.push(shell_quote(&format!("{name}: {value}")));
    }
    if has_body {
        parts.push("--data-binary".to_string());
        parts.push("@-".to_string());
    }
    parts.push(shell_quote(upstream_url));
    format!(
        "{} | (base64 2>/dev/null || openssl base64 -A) | tr -d '\\r\\n'",
        parts.join(" ")
    )
}

fn is_hop_by_hop_request_header(name_lower: &str) -> bool {
    matches!(
        name_lower,
        "connection"
            | "proxy-connection"
            | "keep-alive"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn should_skip_browser_request_header(name_lower: &str) -> bool {
    is_hop_by_hop_request_header(name_lower) || name_lower == "accept-encoding"
}

fn is_skipped_browser_response_header(name_lower: &str) -> bool {
    matches!(
        name_lower,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
            | "x-frame-options"
    )
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(header_name, _)| header_name.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn rewrite_browser_response_body(
    body: Vec<u8>,
    content_type: Option<&str>,
    content_encoding: Option<&str>,
    upstream_origin: &str,
    request_origin: &str,
    browser_host: &str,
) -> (Vec<u8>, bool) {
    if browser_host.is_empty()
        || !is_rewriteable_browser_content_type(content_type)
        || has_encoded_browser_body(content_encoding)
    {
        return (body, false);
    }

    let mut text = match String::from_utf8(body) {
        Ok(text) => text,
        Err(error) => return (error.into_bytes(), false),
    };
    let original_text = text.clone();
    let browser_origin = format!("http://{browser_host}");

    for origin in [upstream_origin, request_origin] {
        if origin.is_empty() || origin == browser_origin {
            continue;
        }
        for (from, to) in browser_origin_rewrite_pairs(origin, &browser_origin, browser_host) {
            text = text.replace(&from, &to);
        }
    }

    if text == original_text {
        return (original_text.into_bytes(), false);
    }
    (text.into_bytes(), true)
}

fn browser_origin_rewrite_pairs(
    origin: &str,
    browser_origin: &str,
    browser_host: &str,
) -> Vec<(String, String)> {
    let mut pairs = vec![
        (origin.to_string(), browser_origin.to_string()),
        (
            origin.replace('/', "\\/"),
            browser_origin.replace('/', "\\/"),
        ),
    ];

    if let Ok(parsed) = reqwest::Url::parse(origin) {
        if let Ok(host_header) = host_header_from_url(&parsed) {
            let from = format!("//{host_header}");
            let to = format!("//{browser_host}");
            pairs.push((from.clone(), to.clone()));
            pairs.push((from.replace('/', "\\/"), to.replace('/', "\\/")));
        }
    }

    pairs
}

fn is_rewriteable_browser_content_type(content_type: Option<&str>) -> bool {
    let Some(content_type) = content_type else {
        return false;
    };
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    media_type.starts_with("text/")
        || matches!(
            media_type.as_str(),
            "application/ecmascript"
                | "application/javascript"
                | "application/json"
                | "application/manifest+json"
                | "application/rss+xml"
                | "application/xhtml+xml"
                | "application/xml"
                | "image/svg+xml"
                | "text/javascript"
        )
        || media_type.ends_with("+json")
        || media_type.ends_with("+xml")
}

fn has_encoded_browser_body(content_encoding: Option<&str>) -> bool {
    content_encoding
        .map(|value| {
            let value = value.trim();
            !value.is_empty() && !value.eq_ignore_ascii_case("identity")
        })
        .unwrap_or(false)
}

fn is_body_integrity_response_header(name_lower: &str) -> bool {
    matches!(
        name_lower,
        "content-md5" | "digest" | "etag" | "last-modified"
    )
}

fn is_content_security_policy_header(name_lower: &str) -> bool {
    matches!(
        name_lower,
        "content-security-policy" | "content-security-policy-report-only"
    )
}

fn remove_csp_frame_ancestors(value: &str) -> String {
    value
        .split(';')
        .map(str::trim)
        .filter(|directive| {
            !directive.is_empty()
                && !directive
                    .split_whitespace()
                    .next()
                    .is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors"))
        })
        .collect::<Vec<_>>()
        .join("; ")
}

async fn write_remote_browser_response(
    stream: &mut TcpStream,
    response_bytes: &[u8],
    upstream_origin: &str,
    request_origin: &str,
    browser_host: &str,
) -> Result<(), String> {
    let Some(header_end) = find_http_header_end(response_bytes) else {
        write_browser_error_response(stream, 502, "远程浏览器响应格式无效。").await?;
        return Ok(());
    };
    let (header_bytes, body) = response_bytes.split_at(header_end);
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.lines();
    let status_line = lines.next().unwrap_or("HTTP/1.1 502 Bad Gateway");
    let mut status_parts = status_line.splitn(3, ' ');
    let _http_version = status_parts.next();
    let status_code = status_parts.next().unwrap_or("502");
    let reason = status_parts.next().unwrap_or("Bad Gateway");
    let response_headers = lines
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            if line.is_empty() {
                return None;
            }
            let (name, value) = line.split_once(':')?;
            Some((name.to_string(), value.trim().to_string()))
        })
        .collect::<Vec<_>>();
    let content_type = header_value(&response_headers, "content-type");
    let content_encoding = header_value(&response_headers, "content-encoding");
    let (body, body_rewritten) = rewrite_browser_response_body(
        body.to_vec(),
        content_type,
        content_encoding,
        upstream_origin,
        request_origin,
        browser_host,
    );
    let mut raw = format!("HTTP/1.1 {status_code} {reason}\r\n");
    for (name, value) in response_headers {
        let name_lower = name.to_ascii_lowercase();
        if is_skipped_browser_response_header(&name_lower) {
            continue;
        }
        if body_rewritten && is_body_integrity_response_header(&name_lower) {
            continue;
        }
        let mut value = value;
        if is_content_security_policy_header(&name_lower) {
            value = remove_csp_frame_ancestors(&value);
            if value.is_empty() {
                continue;
            }
        }
        if name_lower == "location"
            && (value.starts_with(upstream_origin) || value.starts_with(request_origin))
            && !browser_host.is_empty()
        {
            let origin = if value.starts_with(upstream_origin) {
                upstream_origin
            } else {
                request_origin
            };
            value = format!("http://{}{}", browser_host, &value[origin.len()..]);
        }
        raw.push_str(&name);
        raw.push_str(": ");
        raw.push_str(&value);
        raw.push_str("\r\n");
    }
    raw.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    stream
        .write_all(raw.as_bytes())
        .await
        .map_err(error_string)?;
    stream.write_all(&body).await.map_err(error_string)?;
    let _ = stream.shutdown().await;
    Ok(())
}

fn find_http_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
        .or_else(|| {
            bytes
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| index + 2)
        })
}

async fn write_browser_error_response(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
) -> Result<(), String> {
    let body = message.as_bytes();
    let reason = match status {
        502 => "Bad Gateway",
        _ => "Error",
    };
    let raw = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(raw.as_bytes())
        .await
        .map_err(error_string)?;
    stream.write_all(body).await.map_err(error_string)?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn read_browser_http_request(
    stream: &mut TcpStream,
) -> Result<(String, String, Vec<(String, String)>, Vec<u8>), String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        let read = time::timeout(Duration::from_secs(15), stream.read(&mut chunk))
            .await
            .map_err(|_| "浏览器请求读取超时。".to_string())?
            .map_err(error_string)?;
        if read == 0 {
            return Err("浏览器请求为空。".to_string());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > 128 * 1024 {
            return Err("浏览器请求头过大。".to_string());
        }
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "浏览器请求行为空。".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "浏览器请求方法为空。".to_string())?
        .to_string();
    let target = request_parts
        .next()
        .ok_or_else(|| "浏览器请求目标为空。".to_string())?
        .to_string();
    let mut headers = Vec::new();
    let mut content_length = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_string();
        let value = value.trim().to_string();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse::<usize>().unwrap_or(0).min(16 * 1024 * 1024);
        }
        headers.push((name, value));
    }
    let mut body = buffer[header_end..].to_vec();
    while body.len() < content_length {
        let read = time::timeout(Duration::from_secs(15), stream.read(&mut chunk))
            .await
            .map_err(|_| "浏览器请求体读取超时。".to_string())?
            .map_err(error_string)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok((method, target, headers, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_proxy_url_serves_https_targets_over_local_http() {
        let parsed = reqwest::Url::parse("https://Example.COM:8443/a/b?q=1#frag").unwrap();

        let browser_url = browser_proxy_url(&parsed, 32123, "http").unwrap();

        assert_eq!(browser_url, "http://127.0.0.1:32123/a/b?q=1#frag");
    }

    #[test]
    fn browser_proxy_keys_distinguish_plain_and_trusted_https() {
        let plain = browser_proxy_key("conn-1", "reverse-https", "Example.COM", 443);
        let trusted = browser_proxy_key("conn-1", "trusted-https", "example.com", 443);

        assert_ne!(plain, trusted);
        assert_eq!(plain, "conn-1:reverse-https:example.com:443");
    }

    #[test]
    fn forwarded_http_loopback_uses_ssh_forward_port_as_request_origin() {
        let parsed = reqwest::Url::parse("http://127.0.0.1:5173/dashboard").unwrap();

        assert_eq!(origin_from_url(&parsed).unwrap(), "http://127.0.0.1:5173");
        assert_eq!(
            request_origin_for_upstream(&parsed, Some(42123), false).unwrap(),
            "http://127.0.0.1:42123"
        );
        assert_eq!(host_header_from_url(&parsed).unwrap(), "127.0.0.1:5173");
    }

    #[test]
    fn forwarded_https_preserves_origin_until_certificate_is_trusted() {
        let parsed = reqwest::Url::parse("https://service.internal:8443/").unwrap();

        assert_eq!(
            request_origin_for_upstream(&parsed, Some(42123), false).unwrap(),
            "https://service.internal:8443"
        );
        assert_eq!(
            request_origin_for_upstream(&parsed, Some(42123), true).unwrap(),
            "https://127.0.0.1:42123"
        );
    }

    #[test]
    fn forwarded_https_ip_literal_uses_ssh_forward_port() {
        let parsed = reqwest::Url::parse("https://127.0.0.1:8443/").unwrap();

        assert_eq!(
            request_origin_for_upstream(&parsed, Some(42123), false).unwrap(),
            "https://127.0.0.1:42123"
        );
    }

    #[test]
    fn absolute_browser_proxy_request_rewrites_to_ssh_forward_port() {
        assert_eq!(
            browser_request_url(
                "http://127.0.0.1:51234/app?q=1",
                "127.0.0.1:51234",
                "http://127.0.0.1:3000",
                "http://127.0.0.1:42123",
            ),
            "http://127.0.0.1:42123/app?q=1"
        );
    }

    #[test]
    fn absolute_upstream_request_rewrites_to_ssh_forward_port() {
        assert_eq!(
            browser_request_url(
                "http://127.0.0.1:3000/app?q=1",
                "127.0.0.1:51234",
                "http://127.0.0.1:3000",
                "http://127.0.0.1:42123",
            ),
            "http://127.0.0.1:42123/app?q=1"
        );
    }

    #[test]
    fn absolute_upstream_request_rewrites_to_remote_origin_for_exec_fallback() {
        assert_eq!(
            browser_request_url(
                "http://127.0.0.1:51234/app?q=1",
                "127.0.0.1:51234",
                "http://127.0.0.1:3000",
                "http://127.0.0.1:3000",
            ),
            "http://127.0.0.1:3000/app?q=1"
        );
    }

    #[test]
    fn remote_browser_curl_command_preserves_upstream_host_and_skips_proxy_headers() {
        let headers = vec![
            ("Host".to_string(), "127.0.0.1:51234".to_string()),
            ("Connection".to_string(), "keep-alive".to_string()),
            ("Accept-Encoding".to_string(), "gzip, br".to_string()),
            ("Accept".to_string(), "text/html".to_string()),
        ];

        let command = remote_browser_curl_command(
            "GET",
            "http://127.0.0.1:3000/app?q=1",
            "127.0.0.1:3000",
            &headers,
            false,
        );

        assert!(command.contains("'Host: 127.0.0.1:3000'"));
        assert!(command.contains("'Accept: text/html'"));
        assert!(!command.contains("127.0.0.1:51234"));
        assert!(!command.contains("'Connection: keep-alive'"));
        assert!(!command.contains("Accept-Encoding"));
    }

    #[test]
    fn browser_text_response_rewrites_remote_loopback_origins_to_proxy_origin() {
        let (body, rewritten) = rewrite_browser_response_body(
            br#"<script>fetch("http://127.0.0.1:9090/api")</script>"#.to_vec(),
            Some("text/html; charset=utf-8"),
            None,
            "http://127.0.0.1:9090",
            "http://127.0.0.1:42123",
            "127.0.0.1:51234",
        );

        assert!(rewritten);
        assert_eq!(
            String::from_utf8(body).unwrap(),
            r#"<script>fetch("http://127.0.0.1:51234/api")</script>"#
        );
    }

    #[test]
    fn browser_text_response_rewrites_json_escaped_origins() {
        let (body, rewritten) = rewrite_browser_response_body(
            br#"{"baseUrl":"http:\/\/127.0.0.1:9090"}"#.to_vec(),
            Some("application/json"),
            None,
            "http://127.0.0.1:9090",
            "http://127.0.0.1:42123",
            "127.0.0.1:51234",
        );

        assert!(rewritten);
        assert_eq!(
            String::from_utf8(body).unwrap(),
            r#"{"baseUrl":"http:\/\/127.0.0.1:51234"}"#
        );
    }

    #[test]
    fn browser_text_response_rewrites_protocol_relative_origins() {
        let (body, rewritten) = rewrite_browser_response_body(
            br#"<script src="//127.0.0.1:9090/assets/app.js"></script>"#.to_vec(),
            Some("text/html"),
            None,
            "http://127.0.0.1:9090",
            "http://127.0.0.1:42123",
            "127.0.0.1:51234",
        );

        assert!(rewritten);
        assert_eq!(
            String::from_utf8(body).unwrap(),
            r#"<script src="//127.0.0.1:51234/assets/app.js"></script>"#
        );
    }

    #[test]
    fn browser_response_rewrite_skips_encoded_bodies() {
        let original = vec![0x1f, 0x8b, 0x08];
        let (body, rewritten) = rewrite_browser_response_body(
            original.clone(),
            Some("text/html"),
            Some("gzip"),
            "http://127.0.0.1:9090",
            "http://127.0.0.1:42123",
            "127.0.0.1:51234",
        );

        assert!(!rewritten);
        assert_eq!(body, original);
    }

    #[test]
    fn content_security_policy_frame_ancestors_is_removed_for_iframe_browser() {
        assert_eq!(
            remove_csp_frame_ancestors(
                "default-src 'self'; frame-ancestors 'none'; connect-src 'self'"
            ),
            "default-src 'self'; connect-src 'self'"
        );
        assert_eq!(remove_csp_frame_ancestors("frame-ancestors 'none'"), "");
    }

    #[test]
    fn x_frame_options_is_removed_for_iframe_browser() {
        assert!(is_skipped_browser_response_header("x-frame-options"));
        assert!(!is_skipped_browser_response_header(
            "content-security-policy"
        ));
    }
}
