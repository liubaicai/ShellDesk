use crate::proxy::SshProxyConfig;
use crate::vault::{read_store, write_store};
use crate::{
    command_exists, error_string, https_url_origin, now, prevent_process_window,
    prevent_tokio_process_window, random_id, read_string_field, read_u16_field, remote_fs,
    run_ssh_command_for_profile_with_window, sanitize_file_name, shell_quote, string_arg, terminal,
    unavailable_password_auth_error, whoami, ActiveConnection, AppState, ConnectionKind,
    PrivilegeConfig, SshProfile,
};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::process::Command as StdCommand;
use std::{collections::HashSet, fs, future::Future, pin::Pin, process::Stdio, time::Duration};
use tauri::Emitter;
use tokio::{process::Command, sync::oneshot, time};
pub(crate) fn open_local_connection(state: &AppState) -> Result<Value, String> {
    {
        let connections = state.connections.lock().map_err(error_string)?;
        if let Some(connection) = connections
            .values()
            .find(|connection| connection.kind == ConnectionKind::Local)
        {
            return Ok(json!({
                "ok": true,
                "reused": true,
                "connection": connection_info(connection)
            }));
        }
    }

    let id = random_id("local");
    let connection = ActiveConnection {
        id: id.clone(),
        kind: ConnectionKind::Local,
        partition: format!("shelldesk-{id}"),
        proxy_port: 0,
        browser_certificate_trust: HashSet::new(),
        connected_at: now(),
        host: local_display_host(),
        ssh: None,
        privilege: None,
    };
    let info = connection_info(&connection);
    state
        .connections
        .lock()
        .map_err(error_string)?
        .insert(id, connection);

    Ok(json!({
        "ok": true,
        "connection": info
    }))
}

fn local_display_host() -> Value {
    json!({
        "id": "local",
        "name": "本地模式",
        "address": "localhost",
        "port": 0,
        "username": whoami(),
        "authMethod": "agent",
        "systemType": local_system_type(),
        "systemName": local_system_name()
    })
}

fn local_system_type() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => "unix",
    }
}

fn local_system_name() -> String {
    let release = local_os_release();
    match local_system_type() {
        "windows" => format!("Windows {release}"),
        "macos" => format!("macOS {release}"),
        "linux" => format!("Linux {release}"),
        _ => format!("{} {release}", std::env::consts::OS),
    }
    .trim()
    .to_string()
}

fn local_os_release() -> String {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("cmd");
        prevent_process_window(&mut command);
        return command
            .args(["/C", "ver"])
            .output()
            .ok()
            .and_then(|output| {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout
                    .split("Version")
                    .nth(1)
                    .map(|value| value.trim().trim_end_matches(']').to_string())
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_else(|| std::env::consts::OS.to_string());
    }

    #[cfg(not(windows))]
    {
        let mut command = std::process::Command::new("uname");
        prevent_process_window(&mut command);
        command
            .arg("-r")
            .output()
            .ok()
            .and_then(|output| {
                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if value.is_empty() {
                    None
                } else {
                    Some(value)
                }
            })
            .unwrap_or_else(|| std::env::consts::OS.to_string())
    }
}

fn build_ssh_profile(
    state: &AppState,
    raw_host: &Value,
    is_jump: bool,
) -> Result<SshProfile, String> {
    let store = read_store(state)?;
    let host_id = read_string_field(raw_host, "id", "");
    let stored_host = find_store_item_by_id(&store, "hosts", &host_id);
    let host = merge_host_for_connection(stored_host.as_ref(), raw_host);
    let address = read_string_field(&host, "address", "127.0.0.1");
    let port = read_u16_field(&host, "port", 22);
    let username = read_string_field(&host, "username", "");
    let auth_method = read_string_field(&host, "authMethod", "password");
    let password = read_string_field(&host, "password", "");
    let key_id = read_string_field(&host, "keyId", "");
    let mut key_path = read_string_field(&host, "keyPath", "");
    if auth_method == "key" && key_path.is_empty() && !key_id.is_empty() {
        if let Some(key) = find_store_item_by_id(&store, "sshKeys", &key_id) {
            let private_key = read_string_field(&key, "privateKey", "");
            if !private_key.trim().is_empty() {
                key_path = materialize_private_key(state, &key_id, &private_key)?;
            }
        }
    }

    let jump_host_id = read_string_field(&host, "jumpHostId", "");
    let proxy_profile_id = read_string_field(&host, "proxyProfileId", "");
    if !is_jump && !jump_host_id.is_empty() && !proxy_profile_id.is_empty() {
        return Err("当前不能同时为目标主机选择代理和跳板机。".to_string());
    }

    let proxy = if proxy_profile_id.is_empty() {
        None
    } else {
        Some(resolve_proxy_config(&store, &proxy_profile_id)?)
    };

    let jump = if is_jump || jump_host_id.is_empty() {
        None
    } else {
        if jump_host_id == host_id {
            return Err("目标主机不能选择自己作为跳板机。".to_string());
        }
        let jump_host = find_store_item_by_id(&store, "hosts", &jump_host_id)
            .ok_or_else(|| "跳板机不存在，请重新选择。".to_string())?;
        if !jump_host
            .get("canBeJumpHost")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Err(format!(
                "主机「{}」未勾选“可作为跳板机”，请先编辑该主机。",
                read_string_field(&jump_host, "name", "Jump Host")
            ));
        }
        if !read_string_field(&jump_host, "jumpHostId", "").is_empty() {
            return Err("当前仅支持单层跳板机，请选择一台直连主机作为跳板。".to_string());
        }
        Some(Box::new(build_ssh_profile(state, &jump_host, true)?))
    };

    Ok(SshProfile {
        address,
        port,
        username,
        auth_method,
        password,
        key_path,
        known_hosts_path: String::new(),
        proxy_helper_exe: std::env::current_exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| "shelldesk".to_string()),
        proxy,
        jump,
    })
}

fn merge_host_for_connection(stored: Option<&Value>, raw: &Value) -> Value {
    let mut merged = stored.cloned().unwrap_or_else(|| json!({}));
    if let Some(object) = raw.as_object() {
        for (key, value) in object {
            let should_replace = match value {
                Value::Null => false,
                Value::String(text) => !text.is_empty(),
                _ => true,
            };
            if should_replace {
                merged[key] = value.clone();
            }
        }
    }
    merged
}

fn find_store_item_by_id(store: &Value, collection: &str, id: &str) -> Option<Value> {
    if id.is_empty() {
        return None;
    }
    store
        .get(collection)
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
                .cloned()
        })
}

fn materialize_private_key(
    state: &AppState,
    key_id: &str,
    private_key: &str,
) -> Result<String, String> {
    let key_dir = state.data_dir.join("ssh-keys");
    fs::create_dir_all(&key_dir).map_err(error_string)?;
    let path = key_dir.join(format!("{}.pem", sanitize_file_name(key_id)));
    fs::write(&path, private_key).map_err(error_string)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(error_string)?;
    }
    #[cfg(windows)]
    restrict_windows_private_key_acl(&path)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(windows)]
fn restrict_windows_private_key_acl(path: &std::path::Path) -> Result<(), String> {
    let account = current_windows_account()
        .ok_or_else(|| "无法识别当前 Windows 用户，不能收紧 SSH 私钥权限。".to_string())?;
    let grant = format!("{account}:F");
    let mut command = StdCommand::new("icacls");
    prevent_process_window(&mut command);
    let output = command
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &grant])
        .output()
        .map_err(error_string)?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() && stdout.is_empty() {
            "收紧 SSH 私钥权限失败。".to_string()
        } else if stderr.is_empty() {
            format!("收紧 SSH 私钥权限失败：{stdout}")
        } else {
            format!("收紧 SSH 私钥权限失败：{stderr}")
        })
    }
}

#[cfg(windows)]
fn current_windows_account() -> Option<String> {
    let username = std::env::var("USERNAME")
        .ok()
        .filter(|value| !value.trim().is_empty());
    if let Some(username) = username {
        let domain = std::env::var("USERDOMAIN")
            .ok()
            .filter(|value| !value.trim().is_empty());
        return Some(match domain {
            Some(domain) => format!("{domain}\\{username}"),
            None => username,
        });
    }

    let mut command = StdCommand::new("whoami");
    prevent_process_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let account = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!account.is_empty()).then_some(account)
}

fn resolve_proxy_config(store: &Value, proxy_profile_id: &str) -> Result<SshProxyConfig, String> {
    let profile = find_store_item_by_id(store, "proxyProfiles", proxy_profile_id)
        .ok_or_else(|| "代理配置不存在，请重新选择。".to_string())?;
    let config = profile.get("config").cloned().unwrap_or_else(|| json!({}));
    let proxy_type = read_string_field(&config, "type", "");
    let host = read_string_field(&config, "host", "");
    let port = read_u16_field(&config, "port", 0);
    let command = read_string_field(&config, "command", "");
    if proxy_type == "command" {
        if command.trim().is_empty() {
            return Err("ProxyCommand 不能为空。".to_string());
        }
    } else if host.trim().is_empty() || port == 0 {
        return Err("代理主机或端口无效。".to_string());
    }
    Ok(SshProxyConfig {
        proxy_type,
        host,
        port,
        command,
        username: read_string_field(&config, "username", ""),
        password: read_string_field(&config, "password", ""),
        helper_id: random_id("proxy").replace('-', "_"),
    })
}

fn build_jump_host_display(state: &AppState, raw_host: &Value) -> Result<Value, String> {
    let store = read_store(state)?;
    let host_id = read_string_field(raw_host, "id", "");
    let stored_host = find_store_item_by_id(&store, "hosts", &host_id);
    let host = merge_host_for_connection(stored_host.as_ref(), raw_host);
    let jump_host_id = read_string_field(&host, "jumpHostId", "");
    if jump_host_id.is_empty() {
        return Ok(Value::Null);
    }
    let Some(jump_host) = find_store_item_by_id(&store, "hosts", &jump_host_id) else {
        return Ok(Value::Null);
    };
    Ok(json!({
        "id": jump_host.get("id").cloned().unwrap_or(Value::Null),
        "name": jump_host.get("name").cloned().unwrap_or(Value::Null),
        "address": jump_host.get("address").cloned().unwrap_or(Value::Null),
        "port": jump_host.get("port").cloned().unwrap_or_else(|| json!(22)),
        "username": jump_host.get("username").cloned().unwrap_or(Value::Null)
    }))
}

fn build_privilege_config(
    state: &AppState,
    raw_host: &Value,
) -> Result<Option<PrivilegeConfig>, String> {
    let store = read_store(state)?;
    let host_id = read_string_field(raw_host, "id", "");
    let stored_host = find_store_item_by_id(&store, "hosts", &host_id);
    let host = merge_host_for_connection(stored_host.as_ref(), raw_host);
    let mode = read_string_field(&host, "privilegeMode", "sudo");
    if mode == "su-root" {
        let password = read_string_field(&host, "rootPassword", "");
        if !password.is_empty() {
            return Ok(Some(PrivilegeConfig { mode, password }));
        }
    }
    Ok(None)
}

pub(crate) fn respond_host_key_verification(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let payload = args.first().cloned().unwrap_or_else(|| json!({}));
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "主机密钥确认请求无效。".to_string())?
        .to_string();
    let sender = state
        .host_key_responses
        .lock()
        .map_err(error_string)?
        .remove(&request_id)
        .ok_or_else(|| "主机密钥确认请求已过期。".to_string())?;
    sender
        .send(payload)
        .map_err(|_| "主机密钥确认请求已关闭。".to_string())?;
    Ok(json!(true))
}

pub(crate) fn respond_keyboard_interactive(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let payload = args.first().cloned().unwrap_or_else(|| json!({}));
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "SSH 交互认证请求无效。".to_string())?
        .to_string();
    let sender = state
        .keyboard_interactive_responses
        .lock()
        .map_err(error_string)?
        .remove(&request_id)
        .ok_or_else(|| "SSH 交互认证请求已过期。".to_string())?;
    let response = json!({
        "responses": payload
            .get("responses")
            .and_then(Value::as_array)
            .map(|responses| {
                responses
                    .iter()
                    .map(|response| json!(response.as_str().unwrap_or("").to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        "cancel": payload.get("cancel").and_then(Value::as_bool).unwrap_or(false)
    });
    sender
        .send(response)
        .map_err(|_| "SSH 交互认证请求已关闭。".to_string())?;
    Ok(json!(true))
}

fn ensure_ssh_host_key_trusted<'a>(
    state: &'a AppState,
    window: &'a tauri::Window,
    profile: &'a mut SshProfile,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if let Some(jump) = profile.jump.as_deref_mut() {
            ensure_ssh_host_key_trusted(state, window, jump).await?;
        }
        ensure_direct_ssh_host_key_trusted(state, window, profile).await
    })
}

async fn ensure_direct_ssh_host_key_trusted(
    state: &AppState,
    window: &tauri::Window,
    profile: &mut SshProfile,
) -> Result<(), String> {
    let store = read_store(state)?;
    let known_hosts = store
        .get("knownHosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(public_key) =
        trusted_known_host_public_key(&known_hosts, &profile.address, profile.port)
    {
        profile.known_hosts_path =
            write_connection_known_hosts_from_public_key(state, profile, &public_key)?;
        return Ok(());
    }
    let scanned = scan_ssh_host_key(state, window, profile).await?;
    let decision =
        classify_scanned_host_key(&known_hosts, &profile.address, profile.port, &scanned);
    match decision
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
    {
        "trusted" => {
            profile.known_hosts_path = write_connection_known_hosts(state, profile, &scanned)?;
            Ok(())
        }
        "unknown" | "changed" => {
            let response =
                request_host_key_decision(state, window, profile, &scanned, &decision).await?;
            if !response
                .get("accept")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Err("已取消 SSH 主机密钥确认。".to_string());
            }
            if response
                .get("addToKnownHosts")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                upsert_known_host_from_scan(state, profile, &scanned, &decision)?;
            }
            profile.known_hosts_path = write_connection_known_hosts(state, profile, &scanned)?;
            Ok(())
        }
        _ => Err("SSH 主机密钥校验失败。".to_string()),
    }
}

async fn request_host_key_decision(
    state: &AppState,
    window: &tauri::Window,
    profile: &SshProfile,
    scanned: &Value,
    decision: &Value,
) -> Result<Value, String> {
    let request_id = random_id("hostkey");
    let (sender, receiver) = oneshot::channel();
    state
        .host_key_responses
        .lock()
        .map_err(error_string)?
        .insert(request_id.clone(), sender);
    let payload = json!({
        "requestId": request_id,
        "hostname": profile.address,
        "port": profile.port,
        "username": profile.username,
        "status": decision.get("status").and_then(Value::as_str).unwrap_or("unknown"),
        "keyType": scanned.get("keyType").and_then(Value::as_str).unwrap_or("unknown"),
        "fingerprint": scanned.get("fingerprint").and_then(Value::as_str).unwrap_or(""),
        "publicKey": scanned.get("publicKey").and_then(Value::as_str).unwrap_or(""),
        "knownHostId": decision.get("knownHostId").and_then(Value::as_str).unwrap_or(""),
        "knownFingerprint": decision.get("expectedFingerprint").and_then(Value::as_str).unwrap_or("")
    });
    if let Err(error) = window.emit("connection:host-key-verification", payload) {
        let _ = state
            .host_key_responses
            .lock()
            .map_err(error_string)?
            .remove(&request_id);
        return Err(error_string(error));
    }
    match time::timeout(Duration::from_secs(120), receiver).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(_)) => Err("主机密钥确认请求已关闭。".to_string()),
        Err(_) => {
            let _ = state
                .host_key_responses
                .lock()
                .map_err(error_string)?
                .remove(&request_id);
            Err("主机密钥确认超时。".to_string())
        }
    }
}

async fn scan_ssh_host_key(
    state: &AppState,
    window: &tauri::Window,
    profile: &SshProfile,
) -> Result<Value, String> {
    if let Some(jump) = profile.jump.as_deref() {
        return scan_ssh_host_key_via_jump(state, window, jump, profile).await;
    }
    if !command_exists("ssh-keyscan") {
        return Err("未找到 ssh-keyscan，无法执行 SSH 主机密钥预检。".to_string());
    }
    let mut command = Command::new("ssh-keyscan");
    prevent_tokio_process_window(&mut command);
    let output = command
        .args([
            "-T",
            "3",
            "-t",
            "ed25519,ecdsa,rsa",
            "-p",
            &profile.port.to_string(),
            &profile.address,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(error_string)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(public_key) = stdout.lines().find_map(parse_ssh_keyscan_line) else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "未能扫描 SSH 主机密钥。".to_string()
        } else {
            format!("未能扫描 SSH 主机密钥：{stderr}")
        });
    };
    let key_type = public_key.split_whitespace().next().unwrap_or("unknown");
    let fingerprint = fingerprint_from_public_key(&public_key)?;
    Ok(json!({
        "keyType": key_type,
        "publicKey": public_key,
        "fingerprint": fingerprint
    }))
}

async fn scan_ssh_host_key_via_jump(
    state: &AppState,
    window: &tauri::Window,
    jump: &SshProfile,
    profile: &SshProfile,
) -> Result<Value, String> {
    let command = format!(
        "ssh-keyscan -T 3 -t ed25519,ecdsa,rsa -p {} {}",
        profile.port,
        shell_quote(&profile.address)
    );
    let output = run_ssh_command_for_profile_with_window(
        state,
        Some(window.clone()),
        jump.clone(),
        command,
        String::new(),
    )
    .await?;
    let stdout = output.get("stdout").and_then(Value::as_str).unwrap_or("");
    let Some(public_key) = stdout.lines().find_map(parse_ssh_keyscan_line) else {
        let stderr = output
            .get("stderr")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        return Err(if stderr.is_empty() {
            "未能通过跳板机读取目标主机 SSH 公钥。".to_string()
        } else {
            format!("未能通过跳板机读取目标主机 SSH 公钥：{stderr}")
        });
    };
    let key_type = public_key.split_whitespace().next().unwrap_or("unknown");
    let fingerprint = fingerprint_from_public_key(&public_key)?;
    Ok(json!({
        "keyType": key_type,
        "publicKey": public_key,
        "fingerprint": fingerprint
    }))
}

fn parse_ssh_keyscan_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let parts = trimmed.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 3 {
        return None;
    }
    if !parts[1].starts_with("ssh-")
        && !parts[1].starts_with("ecdsa-")
        && !parts[1].starts_with("sk-")
    {
        return None;
    }
    Some(format!("{} {}", parts[1], parts[2]))
}

fn normalize_fingerprint(value: &str) -> String {
    value
        .trim()
        .strip_prefix("SHA256:")
        .unwrap_or(value.trim())
        .trim_end_matches('=')
        .to_string()
}

fn normalize_hostname(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn parse_known_host_pattern(hostname: &str) -> (String, Option<u16>) {
    let first_pattern = hostname.trim().split(',').next().unwrap_or("").trim();
    if first_pattern.is_empty() {
        return (String::new(), None);
    }
    if let Some(rest) = first_pattern.strip_prefix('[') {
        if let Some((host, port_text)) = rest.split_once("]:") {
            return (normalize_hostname(host), port_text.parse::<u16>().ok());
        }
    }
    (normalize_hostname(first_pattern), None)
}

fn known_host_port(known_host: &Value) -> u16 {
    let (_, parsed_port) = known_host
        .get("hostname")
        .and_then(Value::as_str)
        .map(parse_known_host_pattern)
        .unwrap_or_else(|| (String::new(), None));
    known_host
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .or(parsed_port)
        .unwrap_or(22)
}

fn fingerprint_from_public_key(public_key: &str) -> Result<String, String> {
    let parts = public_key.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err("SSH 主机公钥格式无效。".to_string());
    }
    let key_blob = base64::engine::general_purpose::STANDARD
        .decode(parts[1])
        .map_err(|_| "SSH 主机公钥格式无效。".to_string())?;
    Ok(base64::engine::general_purpose::STANDARD
        .encode(Sha256::digest(&key_blob))
        .trim_end_matches('=')
        .to_string())
}

fn known_host_matches_host(known_host: &Value, hostname: &str, port: u16) -> bool {
    let (known_hostname, _) = known_host
        .get("hostname")
        .and_then(Value::as_str)
        .map(parse_known_host_pattern)
        .unwrap_or_else(|| (String::new(), None));
    if known_hostname.is_empty() || known_hostname.starts_with("|1|") {
        return false;
    }
    known_hostname == normalize_hostname(hostname) && known_host_port(known_host) == port
}

fn known_host_fingerprint(known_host: &Value) -> String {
    let fingerprint = known_host
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !fingerprint.trim().is_empty() {
        return normalize_fingerprint(fingerprint);
    }
    known_host
        .get("publicKey")
        .and_then(Value::as_str)
        .and_then(|public_key| fingerprint_from_public_key(public_key).ok())
        .unwrap_or_default()
}

fn trusted_known_host_public_key(
    known_hosts: &[Value],
    hostname: &str,
    port: u16,
) -> Option<String> {
    known_hosts
        .iter()
        .filter(|known_host| known_host_matches_host(known_host, hostname, port))
        .find_map(|known_host| {
            known_host
                .get("publicKey")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|public_key| !public_key.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn classify_scanned_host_key(
    known_hosts: &[Value],
    hostname: &str,
    port: u16,
    scanned: &Value,
) -> Value {
    let scanned_fingerprint = normalize_fingerprint(
        scanned
            .get("fingerprint")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let key_type = scanned.get("keyType").and_then(Value::as_str).unwrap_or("");
    let candidates = known_hosts
        .iter()
        .filter(|known_host| known_host_matches_host(known_host, hostname, port))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return json!({ "status": "unknown" });
    }
    for known_host in &candidates {
        if known_host_fingerprint(known_host) == scanned_fingerprint {
            return json!({
                "status": "trusted",
                "knownHostId": known_host.get("id").and_then(Value::as_str).unwrap_or("")
            });
        }
    }
    for known_host in &candidates {
        if !key_type.is_empty()
            && key_type != "unknown"
            && known_host.get("keyType").and_then(Value::as_str) == Some(key_type)
        {
            return json!({
                "status": "changed",
                "knownHostId": known_host.get("id").and_then(Value::as_str).unwrap_or(""),
                "expectedFingerprint": known_host_fingerprint(known_host)
            });
        }
    }
    json!({ "status": "unknown" })
}

fn upsert_known_host_from_scan(
    state: &AppState,
    profile: &SshProfile,
    scanned: &Value,
    decision: &Value,
) -> Result<(), String> {
    let mut store = read_store(state)?;
    let current = store
        .get("knownHosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let known_host_id = decision
        .get("knownHostId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let now_value = now();
    let mut replaced = false;
    let mut next = Vec::new();
    for known_host in current {
        let same_id = !known_host_id.is_empty()
            && known_host.get("id").and_then(Value::as_str) == Some(known_host_id);
        let same_host = known_host_matches_host(&known_host, &profile.address, profile.port);
        let same_fingerprint = same_host
            && known_host_fingerprint(&known_host)
                == normalize_fingerprint(
                    scanned
                        .get("fingerprint")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                );
        let same_host_type = same_host
            && !scanned
                .get("keyType")
                .and_then(Value::as_str)
                .unwrap_or("")
                .is_empty()
            && known_host.get("keyType").and_then(Value::as_str)
                == scanned.get("keyType").and_then(Value::as_str);
        if same_id || same_fingerprint || same_host_type {
            let next_known_host = json!({
                "id": known_host.get("id").and_then(Value::as_str).unwrap_or_else(|| if known_host_id.is_empty() { "" } else { known_host_id }),
                "hostname": profile.address,
                "port": profile.port,
                "keyType": scanned.get("keyType").and_then(Value::as_str).unwrap_or("unknown"),
                "publicKey": scanned.get("publicKey").and_then(Value::as_str).unwrap_or(""),
                "fingerprint": scanned.get("fingerprint").and_then(Value::as_str).unwrap_or(""),
                "discoveredAt": known_host.get("discoveredAt").and_then(Value::as_str).unwrap_or(&now_value),
                "lastSeen": now_value,
                "convertedToHostId": known_host.get("convertedToHostId").and_then(Value::as_str).unwrap_or("")
            });
            next.push(next_known_host.clone());
            replaced = true;
        } else {
            next.push(known_host);
        }
    }
    if !replaced {
        next.insert(
            0,
            json!({
                "id": if known_host_id.is_empty() { random_id("known-host") } else { known_host_id.to_string() },
                "hostname": profile.address,
                "port": profile.port,
                "keyType": scanned.get("keyType").and_then(Value::as_str).unwrap_or("unknown"),
                "publicKey": scanned.get("publicKey").and_then(Value::as_str).unwrap_or(""),
                "fingerprint": scanned.get("fingerprint").and_then(Value::as_str).unwrap_or(""),
                "discoveredAt": now_value,
                "lastSeen": now_value,
                "convertedToHostId": ""
            }),
        );
    }
    store["knownHosts"] = json!(next);
    write_store(state, &store)
}

fn write_connection_known_hosts(
    state: &AppState,
    profile: &SshProfile,
    scanned: &Value,
) -> Result<String, String> {
    let public_key = scanned
        .get("publicKey")
        .and_then(Value::as_str)
        .ok_or_else(|| "SSH 主机公钥为空。".to_string())?;
    write_connection_known_hosts_from_public_key(state, profile, public_key)
}

fn write_connection_known_hosts_from_public_key(
    state: &AppState,
    profile: &SshProfile,
    public_key: &str,
) -> Result<String, String> {
    let public_key = public_key.trim();
    if public_key.is_empty() {
        return Err("SSH 主机公钥为空。".to_string());
    }
    let known_hosts_dir = state.data_dir.join("known-hosts");
    fs::create_dir_all(&known_hosts_dir).map_err(error_string)?;
    let path = known_hosts_dir.join(format!("{}.known_hosts", random_id("ssh")));
    let host_pattern = known_hosts_host_pattern(&profile.address, profile.port);
    fs::write(&path, format!("{host_pattern} {public_key}\n")).map_err(error_string)?;
    Ok(path.to_string_lossy().to_string())
}

fn known_hosts_host_pattern(address: &str, port: u16) -> String {
    if port == 22 {
        address.to_string()
    } else {
        format!("[{address}]:{port}")
    }
}

pub(crate) async fn connect_ssh(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let raw_host = args.first().cloned().unwrap_or_else(|| json!({}));
    let mut profile = build_ssh_profile(state, &raw_host, false)?;
    let privilege = build_privilege_config(state, &raw_host)?;
    if let Some(error) = unavailable_password_auth_error(&profile) {
        return Ok(json!({ "ok": false, "error": error }));
    }
    if let Err(error) = ensure_ssh_host_key_trusted(state, window, &mut profile).await {
        return Ok(json!({ "ok": false, "error": error }));
    }

    let probe = run_ssh_command_for_profile_with_window(
        state,
        Some(window.clone()),
        profile.clone(),
        "printf shelldesk-ready".to_string(),
        String::new(),
    )
    .await;
    if let Err(error) = probe {
        return Ok(json!({ "ok": false, "error": error }));
    }

    let id = random_id("ssh");
    let connection = ActiveConnection {
        id: id.clone(),
        kind: ConnectionKind::Ssh,
        partition: format!("shelldesk-{id}"),
        proxy_port: 0,
        browser_certificate_trust: HashSet::new(),
        connected_at: now(),
        host: json!({
            "id": raw_host.get("id").cloned().unwrap_or(Value::Null),
            "name": read_string_field(&raw_host, "name", &read_string_field(&raw_host, "address", "SSH")),
            "address": raw_host.get("address").cloned().unwrap_or_else(|| json!("")),
            "port": raw_host.get("port").cloned().unwrap_or_else(|| json!(22)),
            "username": raw_host.get("username").cloned().unwrap_or_else(|| json!("")),
            "authMethod": raw_host.get("authMethod").cloned().unwrap_or_else(|| json!("password")),
            "privilegeMode": raw_host.get("privilegeMode").cloned().unwrap_or(Value::Null),
            "jumpHostId": raw_host.get("jumpHostId").cloned().unwrap_or(Value::Null),
            "proxyProfileId": raw_host.get("proxyProfileId").cloned().unwrap_or(Value::Null),
            "jumpHost": build_jump_host_display(state, &raw_host)?,
            "systemType": raw_host.get("systemType").cloned().unwrap_or_else(|| json!("unknown")),
            "systemName": raw_host.get("systemName").cloned().unwrap_or(Value::Null)
        }),
        ssh: Some(profile),
        privilege,
    };
    let info = connection_info(&connection);
    state
        .connections
        .lock()
        .map_err(error_string)?
        .insert(id, connection);

    Ok(json!({
        "ok": true,
        "connection": info
    }))
}

fn connection_info(connection: &ActiveConnection) -> Value {
    json!({
        "id": connection.id,
        "kind": match connection.kind {
            ConnectionKind::Local => "local",
            ConnectionKind::Ssh => "ssh",
        },
        "partition": connection.partition,
        "proxyPort": connection.proxy_port,
        "connectedAt": connection.connected_at,
        "host": connection.host
    })
}

pub(crate) fn get_connection(
    state: &AppState,
    connection_id: &str,
) -> Result<ActiveConnection, String> {
    state
        .connections
        .lock()
        .map_err(error_string)?
        .get(connection_id)
        .cloned()
        .ok_or_else(|| "连接已断开。".to_string())
}

pub(crate) fn get_connection_info(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let connection = get_connection(state, &connection_id)?;
    Ok(connection_info(&connection))
}

pub(crate) fn trust_browser_certificate(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let partition = string_arg(&args, 0)?;
    let raw_url = string_arg(&args, 1)?;
    let origin = https_url_origin(&raw_url)
        .ok_or_else(|| "只能为 HTTPS 地址添加临时证书例外。".to_string())?;
    let mut connections = state.connections.lock().map_err(error_string)?;
    let Some(connection) = connections
        .values_mut()
        .find(|connection| connection.partition == partition)
    else {
        return Err("浏览器连接已断开，无法信任该证书。".to_string());
    };
    connection.browser_certificate_trust.insert(origin.clone());
    Ok(json!({ "origin": origin }))
}

pub(crate) fn disconnect_connection(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    close_connection_by_id(state, &connection_id)?;
    let _ = window.emit(
        "connection:closed",
        json!({ "connectionId": connection_id, "reason": "连接已关闭。" }),
    );
    Ok(json!(true))
}

pub(crate) fn close_connection_by_id(state: &AppState, connection_id: &str) -> Result<(), String> {
    state
        .connections
        .lock()
        .map_err(error_string)?
        .remove(connection_id);
    let _ = remote_fs::cancel_transfers_for_connection(state, connection_id)?;
    let _ = terminal::close_terminals_for_connection(state, connection_id)?;
    let mut proxies = state.vnc_proxies.lock().map_err(error_string)?;
    let proxy_keys: Vec<String> = proxies
        .iter()
        .filter_map(|(key, proxy)| {
            if proxy.connection_id == connection_id {
                Some(key.clone())
            } else {
                None
            }
        })
        .collect();
    for key in proxy_keys {
        if let Some(mut proxy) = proxies.remove(&key) {
            if let Some(shutdown) = proxy.shutdown.take() {
                let _ = shutdown.send(());
            }
            if let Some(mut child) = proxy.ssh_forward.take() {
                let _ = child.kill();
            }
        }
    }
    drop(proxies);
    let mut browser_proxies = state.browser_proxies.lock().map_err(error_string)?;
    let browser_proxy_keys: Vec<String> = browser_proxies
        .iter()
        .filter_map(|(key, proxy)| {
            if proxy.connection_id == connection_id {
                Some(key.clone())
            } else {
                None
            }
        })
        .collect();
    for key in browser_proxy_keys {
        if let Some(mut proxy) = browser_proxies.remove(&key) {
            if let Some(shutdown) = proxy.shutdown.take() {
                let _ = shutdown.send(());
            }
            if let Some(mut child) = proxy.ssh_forward.take() {
                let _ = child.kill();
            }
        }
    }
    drop(browser_proxies);
    state
        .database_sessions
        .lock()
        .map_err(error_string)?
        .retain(|key, _| {
            let mut parts = key.splitn(3, ':');
            let _kind = parts.next();
            !matches!(parts.next(), Some(value) if value == connection_id)
        });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_host_matching_accepts_openssh_bracketed_host_pattern() {
        let known_host = json!({
            "hostname": "[Example.COM]:2222",
            "fingerprint": "SHA256:abc123"
        });

        assert!(known_host_matches_host(&known_host, "example.com", 2222));
        assert!(!known_host_matches_host(&known_host, "example.com", 22));
    }

    #[test]
    fn known_host_matching_uses_first_comma_pattern_and_explicit_port_field() {
        let known_host = json!({
            "hostname": "Example.COM,10.0.0.8",
            "port": 2200,
            "fingerprint": "SHA256:abc123"
        });

        assert!(known_host_matches_host(&known_host, "example.com", 2200));
        assert!(!known_host_matches_host(&known_host, "10.0.0.8", 2200));
    }

    #[test]
    fn known_host_matching_rejects_hashed_openssh_hosts() {
        let known_host = json!({
            "hostname": "|1|salt|hash",
            "port": 22,
            "fingerprint": "SHA256:abc123"
        });

        assert!(!known_host_matches_host(&known_host, "example.com", 22));
    }

    #[test]
    fn connection_known_hosts_pattern_uses_openssh_default_port_shape() {
        assert_eq!(
            known_hosts_host_pattern("192.168.100.23", 22),
            "192.168.100.23"
        );
        assert_eq!(
            known_hosts_host_pattern("192.168.100.23", 2222),
            "[192.168.100.23]:2222"
        );
    }

    #[test]
    fn classify_scanned_host_key_accepts_legacy_known_host_patterns() {
        let known_hosts = vec![json!({
            "id": "known-1",
            "hostname": "[example.com]:2222",
            "keyType": "ssh-ed25519",
            "fingerprint": "SHA256:abc123=="
        })];
        let scanned = json!({
            "keyType": "ssh-ed25519",
            "fingerprint": "abc123",
            "publicKey": "ssh-ed25519 AAAA"
        });

        let decision = classify_scanned_host_key(&known_hosts, "example.com", 2222, &scanned);

        assert_eq!(
            decision.get("status").and_then(Value::as_str),
            Some("trusted")
        );
        assert_eq!(
            decision.get("knownHostId").and_then(Value::as_str),
            Some("known-1")
        );
    }

    #[test]
    fn trusted_known_host_public_key_reuses_persisted_public_key() {
        let known_hosts = vec![
            json!({
                "hostname": "example.com",
                "port": 22,
                "publicKey": "   "
            }),
            json!({
                "hostname": "Example.COM",
                "port": 22,
                "publicKey": "ssh-ed25519 AAAATEST"
            }),
        ];

        assert_eq!(
            trusted_known_host_public_key(&known_hosts, "example.com", 22).as_deref(),
            Some("ssh-ed25519 AAAATEST")
        );
        assert_eq!(
            trusted_known_host_public_key(&known_hosts, "example.com", 2222),
            None
        );
    }

    #[test]
    fn classify_scanned_host_key_reports_changed_for_same_type_mismatch() {
        let known_hosts = vec![json!({
            "id": "known-1",
            "hostname": "[example.com]:2222",
            "keyType": "ssh-ed25519",
            "fingerprint": "old"
        })];
        let scanned = json!({
            "keyType": "ssh-ed25519",
            "fingerprint": "new",
            "publicKey": "ssh-ed25519 AAAA"
        });

        let decision = classify_scanned_host_key(&known_hosts, "example.com", 2222, &scanned);

        assert_eq!(
            decision.get("status").and_then(Value::as_str),
            Some("changed")
        );
        assert_eq!(
            decision.get("expectedFingerprint").and_then(Value::as_str),
            Some("old")
        );
    }

    #[test]
    fn local_display_host_matches_legacy_shape() {
        let host = local_display_host();

        assert_eq!(host.get("id").and_then(Value::as_str), Some("local"));
        assert_eq!(host.get("name").and_then(Value::as_str), Some("本地模式"));
        assert_eq!(
            host.get("address").and_then(Value::as_str),
            Some("localhost")
        );
        assert_eq!(host.get("port").and_then(Value::as_i64), Some(0));
        assert_eq!(
            host.get("authMethod").and_then(Value::as_str),
            Some("agent")
        );
        assert!(matches!(
            host.get("systemType").and_then(Value::as_str),
            Some("windows" | "macos" | "linux" | "unix")
        ));
        assert!(!host
            .get("systemName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .is_empty());
    }
}
