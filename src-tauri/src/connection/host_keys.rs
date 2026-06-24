use crate::vault::{read_store, write_store};
use crate::{
    command_exists, error_string, now, prevent_tokio_process_window, random_id,
    run_ssh_command_for_profile_with_window, shell_quote, AppState, SshProfile,
};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, future::Future, pin::Pin, process::Stdio, time::Duration};
use tauri::Emitter;
use tokio::{process::Command, sync::oneshot, time};

pub(crate) fn respond_host_key_verification(
    app: &tauri::AppHandle,
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

    // 如果信任被接受且用户选择加入 knownHosts，先落盘，再广播
    if payload
        .get("accept")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && payload
            .get("addToKnownHosts")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        // 从 state 中取出完整的请求信息
        let request_info = state
            .host_key_requests
            .lock()
            .map_err(error_string)?
            .remove(&request_id)
            .ok_or_else(|| "主机密钥确认请求信息不存在。".to_string())?;

        let hostname = request_info
            .get("hostname")
            .and_then(Value::as_str)
            .unwrap_or("");
        let port = request_info
            .get("port")
            .and_then(Value::as_u64)
            .unwrap_or(22) as u16;
        let scanned = request_info
            .get("scanned")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let decision = request_info
            .get("decision")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let username = request_info
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("");

        eprintln!("[DEBUG] respond_host_key_verification - hostname: {}, port: {}, decision: {:?}, scanned: {:?}", hostname, port, decision, scanned);

        let profile = SshProfile {
            address: hostname.to_string(),
            port,
            username: username.to_string(),
            auth_method: String::new(),
            password: String::new(),
            key_path: String::new(),
            known_hosts_path: String::new(),
            proxy_helper_exe: String::new(),
            proxy: None,
            jump: None,
        };

        // 先落盘
        match upsert_known_host_from_scan(state, &profile, &scanned, &decision) {
            Ok(()) => {
                eprintln!("[DEBUG] upsert_known_host_from_scan succeeded");
            }
            Err(err) => {
                eprintln!("[DEBUG] upsert_known_host_from_scan failed: {}", err);
            }
        }

        // 再广播事件给所有窗口
        let broadcast_payload = json!({
            "hostname": hostname,
            "port": port,
            "requestId": request_id
        });
        let _ = app.emit("connection:host-key-trusted", broadcast_payload);
    } else {
        // 如果不落盘，也要清理请求信息
        let _ = state
            .host_key_requests
            .lock()
            .map_err(error_string)?
            .remove(&request_id);
    }

    sender
        .send(payload)
        .map_err(|_| "主机密钥确认请求已关闭。".to_string())?;
    Ok(json!(true))
}

pub(super) fn ensure_ssh_host_key_trusted<'a>(
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

pub(super) fn prepare_ssh_host_key_trust<'a>(
    state: &'a AppState,
    window: &'a tauri::Window,
    profile: &'a mut SshProfile,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if let Some(jump) = profile.jump.as_deref_mut() {
            prepare_ssh_host_key_trust(state, window, jump).await?;
        }
        if prepare_direct_ssh_host_key_trust_from_store(state, profile)? {
            return Ok(());
        }
        ensure_direct_ssh_host_key_trusted(state, window, profile).await
    })
}

pub(crate) async fn ensure_ssh_profile_host_key_trusted(
    state: &AppState,
    window: &tauri::Window,
    profile: &mut SshProfile,
) -> Result<(), String> {
    ensure_ssh_host_key_trusted(state, window, profile).await
}

pub(crate) async fn confirm_ssh_host_public_key_trusted(
    state: &AppState,
    window: &tauri::Window,
    hostname: &str,
    port: u16,
    username: &str,
    public_key: &str,
) -> Result<bool, String> {
    let store = read_store(state)?;
    let known_hosts = store
        .get("knownHosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let scanned = scanned_host_key_from_public_key(public_key)?;
    let decision = classify_scanned_host_key(&known_hosts, hostname, port, &scanned);
    match decision
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
    {
        "trusted" => Ok(true),
        "unknown" | "changed" => {
            let profile = SshProfile {
                address: hostname.to_string(),
                port,
                username: username.to_string(),
                auth_method: String::new(),
                password: String::new(),
                key_path: String::new(),
                known_hosts_path: String::new(),
                proxy_helper_exe: String::new(),
                proxy: None,
                jump: None,
            };

            // 先检查 store，如果指纹已被其他窗口信任，直接采用
            let fresh_store = read_store(state)?;
            let fresh_known_hosts = fresh_store
                .get("knownHosts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let fresh_decision = classify_scanned_host_key(
                &fresh_known_hosts,
                hostname,
                port,
                &scanned,
            );
            if fresh_decision
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                == "trusted"
            {
                return Ok(true);
            }

            let response =
                request_host_key_decision(state, window, &profile, &scanned, &decision).await?;
            let accept = response
                .get("accept")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            // 落盘已在 respond_host_key_verification 中处理
            Ok(accept)
        }
        _ => Ok(false),
    }
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
    let scanned_keys = scan_ssh_host_keys(state, window, profile).await?;
    let (scanned, decision) = select_scanned_host_key_decision(
        &known_hosts,
        &profile.address,
        profile.port,
        &scanned_keys,
    )
    .ok_or_else(|| "未能扫描 SSH 主机密钥。".to_string())?;
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
            // 先检查 store，如果指纹已被其他窗口信任，直接采用
            let fresh_store = read_store(state)?;
            let fresh_known_hosts = fresh_store
                .get("knownHosts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let fresh_decision = classify_scanned_host_key(
                &fresh_known_hosts,
                &profile.address,
                profile.port,
                &scanned,
            );
            if fresh_decision
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                == "trusted"
            {
                profile.known_hosts_path =
                    write_connection_known_hosts(state, profile, &scanned)?;
                return Ok(());
            }

            let response =
                request_host_key_decision(state, window, profile, &scanned, &decision).await?;
            if !response
                .get("accept")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Err("已取消 SSH 主机密钥确认。".to_string());
            }
            // 落盘已在 respond_host_key_verification 中处理
            profile.known_hosts_path = write_connection_known_hosts(state, profile, &scanned)?;
            Ok(())
        }
        _ => Err("SSH 主机密钥校验失败。".to_string()),
    }
}

fn prepare_direct_ssh_host_key_trust_from_store(
    state: &AppState,
    profile: &mut SshProfile,
) -> Result<bool, String> {
    let store = read_store(state)?;
    let known_hosts = store
        .get("knownHosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let Some(public_key) =
        trusted_known_host_public_key(&known_hosts, &profile.address, profile.port)
    else {
        return Ok(false);
    };
    profile.known_hosts_path =
        write_connection_known_hosts_from_public_key(state, profile, &public_key)?;
    Ok(true)
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

    // 存储完整的请求信息，用于在响应时落盘和广播
    let request_info = json!({
        "hostname": profile.address,
        "port": profile.port,
        "username": profile.username,
        "scanned": scanned,
        "decision": decision
    });
    state
        .host_key_requests
        .lock()
        .map_err(error_string)?
        .insert(request_id.clone(), request_info);

    if let Err(error) = window.emit("connection:host-key-verification", payload) {
        let _ = state
            .host_key_responses
            .lock()
            .map_err(error_string)?
            .remove(&request_id);
        let _ = state
            .host_key_requests
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
            let _ = state
                .host_key_requests
                .lock()
                .map_err(error_string)?
                .remove(&request_id);
            Err("主机密钥确认超时。".to_string())
        }
    }
}

async fn scan_ssh_host_keys(
    state: &AppState,
    window: &tauri::Window,
    profile: &SshProfile,
) -> Result<Vec<Value>, String> {
    if let Some(jump) = profile.jump.as_deref() {
        return scan_ssh_host_keys_via_jump(state, window, jump, profile).await;
    }
    if !command_exists("ssh-keyscan") {
        return scan_ssh_host_keys_via_accept_new(
            state,
            profile,
            "未找到 ssh-keyscan，无法执行 SSH 主机密钥预检。",
        )
        .await;
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
    let scanned_keys = scanned_host_keys_from_keyscan_output(&stdout);
    if scanned_keys.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let keyscan_error = if stderr.is_empty() {
            "未能扫描 SSH 主机密钥。".to_string()
        } else {
            format!("未能扫描 SSH 主机密钥：{stderr}")
        };
        return scan_ssh_host_keys_via_accept_new(state, profile, &keyscan_error).await;
    }
    Ok(scanned_keys)
}

async fn scan_ssh_host_keys_via_accept_new(
    state: &AppState,
    profile: &SshProfile,
    keyscan_error: &str,
) -> Result<Vec<Value>, String> {
    if !command_exists("ssh") {
        return Err(format!(
            "{keyscan_error}；未找到 ssh，无法使用备用主机密钥预检。"
        ));
    }

    let known_hosts_dir = state.data_dir.join("known-hosts");
    fs::create_dir_all(&known_hosts_dir).map_err(error_string)?;
    let path = known_hosts_dir.join(format!("{}.scan.known_hosts", random_id("ssh")));
    let path_text = path.to_string_lossy().to_string();

    let mut command = Command::new("ssh");
    prevent_tokio_process_window(&mut command);
    let args = vec![
        "-p".to_string(),
        profile.port.to_string(),
        "-o".to_string(),
        "ConnectTimeout=8".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        format!("UserKnownHostsFile={path_text}"),
        "-o".to_string(),
        format!("GlobalKnownHostsFile={}", null_known_hosts_path()),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "PasswordAuthentication=no".to_string(),
        "-o".to_string(),
        "KbdInteractiveAuthentication=no".to_string(),
        "-o".to_string(),
        "ChallengeResponseAuthentication=no".to_string(),
        "-o".to_string(),
        "NumberOfPasswordPrompts=0".to_string(),
        ssh_scan_destination(profile),
        "true".to_string(),
    ];
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| format!("{keyscan_error}；备用 SSH 主机密钥预检超时。"))?
        .map_err(error_string)?;

    let known_hosts_text = fs::read_to_string(&path).unwrap_or_default();
    let _ = fs::remove_file(&path);
    let scanned_keys = scanned_host_keys_from_keyscan_output(&known_hosts_text);
    if scanned_keys.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{keyscan_error}；备用 SSH 主机密钥预检未写入 known_hosts。")
        } else {
            format!("{keyscan_error}；备用 SSH 主机密钥预检未写入 known_hosts：{stderr}")
        });
    }

    Ok(scanned_keys)
}

fn ssh_scan_destination(profile: &SshProfile) -> String {
    if profile.username.trim().is_empty() {
        profile.address.clone()
    } else {
        format!("{}@{}", profile.username, profile.address)
    }
}

fn null_known_hosts_path() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

async fn scan_ssh_host_keys_via_jump(
    state: &AppState,
    window: &tauri::Window,
    jump: &SshProfile,
    profile: &SshProfile,
) -> Result<Vec<Value>, String> {
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
    let scanned_keys = scanned_host_keys_from_keyscan_output(stdout);
    if scanned_keys.is_empty() {
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
    }
    Ok(scanned_keys)
}

fn scanned_host_keys_from_keyscan_output(stdout: &str) -> Vec<Value> {
    stdout
        .lines()
        .filter_map(parse_ssh_keyscan_line)
        .filter_map(|public_key| scanned_host_key_from_public_key(&public_key).ok())
        .collect()
}

fn scanned_host_key_from_public_key(public_key: &str) -> Result<Value, String> {
    let public_key = public_key.trim();
    if public_key.is_empty() {
        return Err("SSH 主机公钥为空。".to_string());
    }
    let key_type = public_key.split_whitespace().next().unwrap_or("unknown");
    let fingerprint = fingerprint_from_public_key(public_key)?;
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

pub(super) fn known_host_matches_host(known_host: &Value, hostname: &str, port: u16) -> bool {
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
        .find(|known_host| {
            known_host_matches_host(known_host, hostname, port)
                && known_host
                    .get("publicKey")
                    .and_then(Value::as_str)
                    .is_some_and(|public_key| scanned_host_key_from_public_key(public_key).is_ok())
        })
        .and_then(|known_host| known_host.get("publicKey").and_then(Value::as_str))
        .map(str::trim)
        .filter(|public_key| !public_key.is_empty())
        .map(ToString::to_string)
}

pub(super) fn classify_scanned_host_key(
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
                "expectedFingerprint": known_host_fingerprint(known_host),
                "expectedKeyType": known_host.get("keyType").and_then(Value::as_str).unwrap_or("")
            });
        }
    }
    let known_host = candidates[0];
    json!({
        "status": "changed",
        "knownHostId": known_host.get("id").and_then(Value::as_str).unwrap_or(""),
        "expectedFingerprint": known_host_fingerprint(known_host),
        "expectedKeyType": known_host.get("keyType").and_then(Value::as_str).unwrap_or("")
    })
}

pub(super) fn select_scanned_host_key_decision(
    known_hosts: &[Value],
    hostname: &str,
    port: u16,
    scanned_keys: &[Value],
) -> Option<(Value, Value)> {
    let mut first_changed = None;
    let mut first_unknown = None;
    for scanned in scanned_keys {
        let decision = classify_scanned_host_key(known_hosts, hostname, port, scanned);
        match decision
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
        {
            "trusted" => return Some((scanned.clone(), decision)),
            "changed" if first_changed.is_none() => {
                first_changed = Some((scanned.clone(), decision))
            }
            "unknown" if first_unknown.is_none() => {
                first_unknown = Some((scanned.clone(), decision))
            }
            _ => {}
        }
    }
    first_changed.or(first_unknown)
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
    let now_value = now();
    let next = merge_known_hosts_from_scan(current, profile, scanned, decision, &now_value);
    store["knownHosts"] = json!(next);

    // 打印更新后的 knownHosts 中匹配的记录
    let updated_record = next.iter().find(|record| {
        record.get("hostname").and_then(Value::as_str) == Some(&profile.address)
            && record.get("port").and_then(Value::as_u64) == Some(profile.port as u64)
    });
    eprintln!("[DEBUG] upsert_known_host_from_scan - hostname: {}, port: {}, updated record: {:?}", profile.address, profile.port, updated_record);

    write_store(state, &store)
}

pub(super) fn merge_known_hosts_from_scan(
    current: Vec<Value>,
    profile: &SshProfile,
    scanned: &Value,
    decision: &Value,
    now_value: &str,
) -> Vec<Value> {
    let known_host_id = decision
        .get("knownHostId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut replaced = false;
    let mut next = Vec::new();
    for known_host in current {
        let same_id = !known_host_id.is_empty()
            && known_host.get("id").and_then(Value::as_str) == Some(known_host_id);
        let same_host = known_host_matches_host(&known_host, &profile.address, profile.port);
        if same_id || same_host {
            if !replaced {
                let id = known_host
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .unwrap_or_else(|| {
                        if known_host_id.is_empty() {
                            ""
                        } else {
                            known_host_id
                        }
                    });
                let id = if id.is_empty() {
                    random_id("known-host")
                } else {
                    id.to_string()
                };
                next.push(known_host_record_from_scan(
                    profile,
                    scanned,
                    id,
                    known_host
                        .get("discoveredAt")
                        .and_then(Value::as_str)
                        .unwrap_or(now_value)
                        .to_string(),
                    known_host
                        .get("convertedToHostId")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    now_value,
                ));
            }
            replaced = true;
        } else {
            next.push(known_host);
        }
    }
    if !replaced {
        next.insert(
            0,
            known_host_record_from_scan(
                profile,
                scanned,
                if known_host_id.is_empty() {
                    random_id("known-host")
                } else {
                    known_host_id.to_string()
                },
                now_value.to_string(),
                String::new(),
                now_value,
            ),
        );
    }
    next
}

fn known_host_record_from_scan(
    profile: &SshProfile,
    scanned: &Value,
    id: String,
    discovered_at: String,
    converted_to_host_id: String,
    now_value: &str,
) -> Value {
    json!({
        "id": id,
        "hostname": profile.address,
        "port": profile.port,
        "keyType": scanned.get("keyType").and_then(Value::as_str).unwrap_or("unknown"),
        "publicKey": scanned.get("publicKey").and_then(Value::as_str).unwrap_or(""),
        "fingerprint": scanned.get("fingerprint").and_then(Value::as_str).unwrap_or(""),
        "discoveredAt": discovered_at,
        "lastSeen": now_value,
        "convertedToHostId": converted_to_host_id
    })
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

pub(super) fn known_hosts_host_pattern(address: &str, port: u16) -> String {
    if port == 22 {
        address.to_string()
    } else {
        format!("[{address}]:{port}")
    }
}
