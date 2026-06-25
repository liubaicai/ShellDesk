use crate::proxy::SshProxyConfig;
use crate::ssh_tunnel::spawn_tunnel_shutdown;
use crate::vault::read_store;
use crate::{
    error_string, https_url_origin, now, prevent_process_window, random_id, read_string_field,
    read_u16_field, remote_fs, sanitize_file_name, string_arg, terminal,
    unavailable_password_auth_error, whoami, ActiveConnection, AppState, ConnectionKind,
    PrivilegeConfig, SshProfile,
};
use host_keys::prepare_ssh_host_key_trust;
use serde_json::{json, Value};
#[cfg(windows)]
use std::process::Command as StdCommand;
use std::{collections::HashSet, fs, path::PathBuf};
use tauri::Emitter;

#[path = "connection/host_keys.rs"]
mod host_keys;

#[cfg(test)]
use host_keys::{
    classify_scanned_host_key, known_host_matches_host, known_hosts_host_pattern,
    merge_known_hosts_from_scan, select_scanned_host_key_decision,
};
pub(crate) use host_keys::{
    confirm_ssh_host_public_key_trusted, ensure_ssh_profile_host_key_trusted,
    respond_host_key_verification,
};
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
        temporary_key_paths: Vec::new(),
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
    temporary_key_paths: &mut Vec<PathBuf>,
) -> Result<SshProfile, String> {
    let store = read_store(state)?;
    let host_id = read_string_field(raw_host, "id", "");
    let stored_host = find_store_item_by_id(&store, "hosts", &host_id);
    let host = merge_host_for_connection(stored_host.as_ref(), raw_host);
    let address = read_string_field(&host, "address", "127.0.0.1");
    let port = read_u16_field(&host, "port", 22);
    let username = read_string_field(&host, "username", "");
    let auth_method = read_string_field(&host, "authMethod", "password");
    let password = if auth_method == "key" {
        read_string_field(&host, "passphrase", "")
    } else {
        read_string_field(&host, "password", "")
    };
    let key_id = read_string_field(&host, "keyId", "");
    let mut key_path = read_string_field(&host, "keyPath", "");
    if auth_method == "key" && key_path.is_empty() && !key_id.is_empty() {
        if let Some(key) = find_store_item_by_id(&store, "sshKeys", &key_id) {
            let private_key = read_string_field(&key, "privateKey", "");
            if !private_key.trim().is_empty() {
                key_path = materialize_private_key(state, &key_id, &private_key)?;
                temporary_key_paths.push(PathBuf::from(&key_path));
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
        Some(Box::new(build_ssh_profile(
            state,
            &jump_host,
            true,
            temporary_key_paths,
        )?))
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

pub(crate) async fn connect_ssh(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let raw_host = args.first().cloned().unwrap_or_else(|| json!({}));
    let mut temporary_key_paths = Vec::new();
    let mut profile = build_ssh_profile(state, &raw_host, false, &mut temporary_key_paths)?;
    let privilege = build_privilege_config(state, &raw_host)?;
    if let Some(error) = unavailable_password_auth_error(&profile) {
        return Ok(json!({ "ok": false, "error": error }));
    }
    if let Err(error) = prepare_ssh_host_key_trust(state, window, &mut profile).await {
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
        temporary_key_paths,
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
    let connection = state
        .connections
        .lock()
        .map_err(error_string)?
        .remove(connection_id);
    if let Some(connection) = connection {
        cleanup_temporary_key_paths(connection.temporary_key_paths);
    }
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
            if let Some(tunnel) = proxy.ssh_tunnel.take() {
                spawn_tunnel_shutdown("vnc", tunnel);
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
            if let Some(tunnel) = proxy.ssh_tunnel.take() {
                spawn_tunnel_shutdown("browser", tunnel);
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
    let tunnel_sessions = {
        let mut sessions = state
            .database_tunnel_sessions
            .lock()
            .map_err(error_string)?;
        let keys = sessions
            .keys()
            .filter_map(|key| {
                let mut parts = key.splitn(3, ':');
                let _kind = parts.next();
                if matches!(parts.next(), Some(value) if value == connection_id) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| sessions.remove(&key))
            .collect::<Vec<_>>()
    };
    for session in tunnel_sessions {
        tokio::spawn(async move {
            if let Err(error) =
                tokio::time::timeout(std::time::Duration::from_secs(5), session.shutdown()).await
            {
                eprintln!("[database-tunnel] session shutdown timed out: {error}");
            }
        });
    }
    let http_tunnel_sessions = {
        let mut sessions = state.http_tunnel_sessions.lock().map_err(error_string)?;
        let keys = sessions
            .iter()
            .filter_map(|(key, session)| {
                if session.connection_id == connection_id {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| sessions.remove(&key))
            .collect::<Vec<_>>()
    };
    for session in http_tunnel_sessions {
        tokio::spawn(async move {
            if let Err(error) =
                tokio::time::timeout(std::time::Duration::from_secs(5), session.shutdown()).await
            {
                eprintln!("[http-tunnel] session shutdown timed out: {error}");
            }
        });
    }
    Ok(())
}

pub(crate) fn cleanup_all_temporary_key_files(state: &AppState) {
    let paths = match state.connections.lock() {
        Ok(mut connections) => connections
            .values_mut()
            .flat_map(|connection| connection.temporary_key_paths.drain(..))
            .collect::<Vec<_>>(),
        Err(error) => {
            eprintln!("[connection] failed to collect temporary SSH keys for cleanup: {error}");
            Vec::new()
        }
    };
    cleanup_temporary_key_paths(paths);
}

fn cleanup_temporary_key_paths(paths: Vec<PathBuf>) {
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!(
                "[connection] failed to remove temporary SSH private key {}: {error}",
                path.display()
            ),
        }
    }
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
    fn classify_scanned_host_key_reports_changed_for_endpoint_key_type_mismatch() {
        let known_hosts = vec![json!({
            "id": "known-1",
            "hostname": "example.com",
            "port": 22,
            "keyType": "ssh-rsa",
            "fingerprint": "old-rsa"
        })];
        let scanned = json!({
            "keyType": "ssh-ed25519",
            "fingerprint": "new-ed25519",
            "publicKey": "ssh-ed25519 AAAA"
        });

        let decision = classify_scanned_host_key(&known_hosts, "example.com", 22, &scanned);

        assert_eq!(
            decision.get("status").and_then(Value::as_str),
            Some("changed")
        );
        assert_eq!(
            decision.get("expectedFingerprint").and_then(Value::as_str),
            Some("old-rsa")
        );
    }

    #[test]
    fn selected_scanned_host_key_prefers_any_trusted_key_before_changed_candidates() {
        let known_hosts = vec![json!({
            "id": "known-rsa",
            "hostname": "example.com",
            "port": 22,
            "keyType": "ssh-rsa",
            "fingerprint": "rsa-current"
        })];
        let scanned_keys = vec![
            json!({
                "keyType": "ssh-ed25519",
                "fingerprint": "new-ed25519",
                "publicKey": "ssh-ed25519 AAAA"
            }),
            json!({
                "keyType": "ssh-rsa",
                "fingerprint": "rsa-current",
                "publicKey": "ssh-rsa BBBB"
            }),
        ];

        let (_, decision) =
            select_scanned_host_key_decision(&known_hosts, "example.com", 22, &scanned_keys)
                .expect("scanned host key decision");

        assert_eq!(
            decision.get("status").and_then(Value::as_str),
            Some("trusted")
        );
        assert_eq!(
            decision.get("knownHostId").and_then(Value::as_str),
            Some("known-rsa")
        );
    }

    #[test]
    fn accepting_changed_host_key_replaces_old_endpoint_records() {
        let profile = SshProfile {
            address: "example.com".to_string(),
            port: 2222,
            username: "root".to_string(),
            auth_method: String::new(),
            password: String::new(),
            key_path: String::new(),
            known_hosts_path: String::new(),
            proxy_helper_exe: String::new(),
            proxy: None,
            jump: None,
        };
        let current = vec![
            json!({
                "id": "old-ed",
                "hostname": "[example.com]:2222",
                "port": 2222,
                "keyType": "ssh-ed25519",
                "fingerprint": "old-ed",
                "publicKey": "ssh-ed25519 OLD",
                "discoveredAt": "2026-01-01T00:00:00Z"
            }),
            json!({
                "id": "old-rsa",
                "hostname": "[example.com]:2222",
                "port": 2222,
                "keyType": "ssh-rsa",
                "fingerprint": "old-rsa",
                "publicKey": "ssh-rsa OLD"
            }),
            json!({
                "id": "other",
                "hostname": "other.example.com",
                "port": 22,
                "keyType": "ssh-ed25519",
                "fingerprint": "other"
            }),
        ];
        let scanned = json!({
            "keyType": "ssh-ed25519",
            "fingerprint": "new-ed",
            "publicKey": "ssh-ed25519 NEW"
        });
        let decision = json!({
            "status": "changed",
            "knownHostId": "old-ed",
            "expectedFingerprint": "old-ed"
        });

        let next = merge_known_hosts_from_scan(
            current,
            &profile,
            &scanned,
            &decision,
            "2026-02-01T00:00:00Z",
        );

        assert_eq!(next.len(), 2);
        assert_eq!(next[0].get("id").and_then(Value::as_str), Some("old-ed"));
        assert_eq!(
            next[0].get("fingerprint").and_then(Value::as_str),
            Some("new-ed")
        );
        assert_eq!(
            next[0].get("discoveredAt").and_then(Value::as_str),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(next[1].get("id").and_then(Value::as_str), Some("other"));
    }

    #[test]
    fn key_auth_profile_uses_passphrase_as_ssh_secret() {
        let state = AppState::new(
            std::env::temp_dir().join(format!("shelldesk-key-auth-profile-{}", std::process::id())),
        );
        let raw_host = json!({
            "address": "example.com",
            "port": 22,
            "username": "administrator",
            "authMethod": "key",
            "password": "windows-account-password",
            "passphrase": "key-passphrase",
            "keyPath": "C:\\Users\\me\\.ssh\\id_rsa"
        });

        let profile = build_ssh_profile(&state, &raw_host, false).unwrap();

        assert_eq!(profile.auth_method, "key");
        assert_eq!(profile.password, "key-passphrase");
        assert_eq!(profile.key_path, "C:\\Users\\me\\.ssh\\id_rsa");
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
