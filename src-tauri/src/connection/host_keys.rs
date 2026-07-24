use crate::russh_client::scan_host_public_keys;
use crate::vault::{read_store, with_store_mut};
use crate::{error_string, now, random_id, AppState, HostKeyRequest, SshProfile, UiWindowRef};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, future::Future, pin::Pin, time::Duration};
use tauri::{AppHandle, Emitter};
use tokio::{sync::oneshot, time};

pub(crate) fn respond_host_key_verification(
    state: &AppState,
    app: &AppHandle,
    args: Vec<Value>,
) -> Result<Value, String> {
    let payload = args.first().cloned().unwrap_or_else(|| json!({}));
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "主机密钥确认请求无效。".to_string())?
        .to_string();
    let accept = payload
        .get("accept")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let add_to_known_hosts = payload
        .get("addToKnownHosts")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let entry = state
        .host_key_responses
        .lock()
        .map_err(error_string)?
        .remove(&request_id)
        .ok_or_else(|| "主机密钥确认请求已过期。".to_string())?;
    let HostKeyRequest {
        hostname,
        port,
        sender,
    } = entry;
    sender
        .send(payload.clone())
        .map_err(|_| "主机密钥确认请求已关闭。".to_string())?;
    if accept && add_to_known_hosts {
        resolve_sibling_host_key_requests(state, &hostname, port);
        let _ = app.emit(
            "connection:host-key-trusted",
            json!({ "hostname": hostname, "port": port }),
        );
    }
    Ok(json!(true))
}

fn resolve_sibling_host_key_requests(state: &AppState, hostname: &str, port: u16) {
    let target_key = host_key_match_key(hostname, port);
    let siblings = state
        .host_key_responses
        .lock()
        .map(|mut requests| {
            let target_key = target_key.clone();
            let matching_ids: Vec<String> = requests
                .iter()
                .filter(|(_, request)| {
                    host_key_match_key(&request.hostname, request.port) == target_key
                })
                .map(|(id, _)| id.clone())
                .collect();
            matching_ids
                .into_iter()
                .filter_map(|id| requests.remove(&id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for sibling in siblings {
        let _ = sibling.sender.send(json!({
            "accept": true,
            "addToKnownHosts": false
        }));
    }
}

fn host_key_match_key(hostname: &str, port: u16) -> String {
    format!("{}:{}", normalize_hostname(hostname), port)
}

#[derive(Clone)]
struct HostKeyUi {
    window: UiWindowRef,
}

impl HostKeyUi {
    fn from_window(window: &tauri::Window) -> Self {
        Self {
            window: UiWindowRef::from_window(window),
        }
    }

    fn emit(&self, event: &str, payload: Value) -> Result<(), String> {
        self.window.emit(event, payload).map_err(error_string)
    }
}

pub(super) fn ensure_ssh_host_key_trusted<'a>(
    state: &AppState,
    window: &tauri::Window,
    profile: &'a mut SshProfile,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    let state = state.clone_without_ui_window();
    let ui = HostKeyUi::from_window(window);
    let original = profile.clone();
    Box::pin(async move {
        let updated = ensure_ssh_host_key_trusted_owned(state, ui, original).await?;
        *profile = updated;
        Ok(())
    })
}

pub(super) fn prepare_ssh_host_key_trust<'a>(
    state: &AppState,
    window: &tauri::Window,
    profile: &'a mut SshProfile,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    let state = state.clone_without_ui_window();
    let ui = HostKeyUi::from_window(window);
    let original = profile.clone();
    Box::pin(async move {
        let updated = prepare_ssh_host_key_trust_owned(state, ui, original).await?;
        *profile = updated;
        Ok(())
    })
}

fn ensure_ssh_host_key_trusted_owned(
    state: AppState,
    ui: HostKeyUi,
    mut profile: SshProfile,
) -> Pin<Box<dyn Future<Output = Result<SshProfile, String>> + Send>> {
    Box::pin(async move {
        if let Some(jump) = profile.jump.take() {
            let jump_state = state.clone();
            let jump_ui = ui.clone();
            let trusted_jump =
                ensure_ssh_host_key_trusted_owned(jump_state, jump_ui, *jump).await?;
            profile.jump = Some(Box::new(trusted_jump));
        }
        ensure_direct_ssh_host_key_trusted(state, ui, profile).await
    })
}

fn prepare_ssh_host_key_trust_owned(
    state: AppState,
    ui: HostKeyUi,
    mut profile: SshProfile,
) -> Pin<Box<dyn Future<Output = Result<SshProfile, String>> + Send>> {
    Box::pin(async move {
        if let Some(jump) = profile.jump.take() {
            let jump_state = state.clone();
            let jump_ui = ui.clone();
            let trusted_jump = prepare_ssh_host_key_trust_owned(jump_state, jump_ui, *jump).await?;
            profile.jump = Some(Box::new(trusted_jump));
        }
        if prepare_direct_ssh_host_key_trust_from_store(&state, &mut profile)? {
            return Ok(profile);
        }
        ensure_direct_ssh_host_key_trusted(state, ui, profile).await
    })
}

pub(crate) async fn ensure_ssh_profile_host_key_trusted(
    state: &AppState,
    window: &tauri::Window,
    profile: &mut SshProfile,
) -> Result<(), String> {
    ensure_ssh_host_key_trusted(state, window, profile).await
}

async fn ensure_direct_ssh_host_key_trusted(
    state: AppState,
    ui: HostKeyUi,
    mut profile: SshProfile,
) -> Result<SshProfile, String> {
    let store = read_store(&state)?;
    let known_hosts = store
        .get("knownHosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let scanned_keys = scan_ssh_host_keys(profile.clone()).await?;
    let (scanned, decision) = select_scanned_host_key_decision(
        &known_hosts,
        &profile.address,
        profile.port,
        &scanned_keys,
    )
    .ok_or_else(|| "未能扫描 SSH 主机密钥。".to_string())?;
    let status = decision
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    if status == "trusted" {
        profile.known_hosts_path =
            write_connection_known_hosts_from_scans(&state, &profile, &scanned_keys)?;
        return Ok(profile);
    }
    if status != "unknown" && status != "changed" {
        return Err("SSH 主机密钥校验失败。".to_string());
    }

    let decision_ui = ui.clone();
    let response = request_host_key_decision(
        state.clone(),
        decision_ui,
        profile.clone(),
        scanned.clone(),
        decision.clone(),
    )
    .await?;
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
        upsert_known_host_from_scan(&state, &profile, &scanned, &decision).await?;
        let _ = ui.emit("vault:changed", json!({ "kind": "hostKeyTrust" }));
    }
    profile.known_hosts_path =
        write_connection_known_hosts_from_scans(&state, &profile, &scanned_keys)?;
    Ok(profile)
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
    state: AppState,
    ui: HostKeyUi,
    profile: SshProfile,
    scanned: Value,
    decision: Value,
) -> Result<Value, String> {
    if host_key_already_trusted(&state, &profile, &scanned) {
        return Ok(json!({ "accept": true, "addToKnownHosts": false }));
    }
    let request_id = random_id("hostkey");
    let (sender, receiver) = oneshot::channel();
    state
        .host_key_responses
        .lock()
        .map_err(error_string)?
        .insert(
            request_id.clone(),
            HostKeyRequest {
                sender,
                hostname: profile.address.clone(),
                port: profile.port,
            },
        );
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
    let emit_result = ui.emit("connection:host-key-verification", payload);
    if let Err(error) = emit_result {
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

fn host_key_already_trusted(state: &AppState, profile: &SshProfile, scanned: &Value) -> bool {
    let Ok(store) = read_store(state) else {
        return false;
    };
    let known_hosts = store
        .get("knownHosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    classify_scanned_host_key(&known_hosts, &profile.address, profile.port, scanned)
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        == "trusted"
}

async fn scan_ssh_host_keys(profile: SshProfile) -> Result<Vec<Value>, String> {
    let scanned_keys = scan_host_public_keys(profile)
        .await?
        .into_iter()
        .filter_map(|public_key| public_key.to_openssh().ok())
        .filter_map(|public_key| scanned_host_key_from_public_key(&public_key).ok())
        .collect::<Vec<_>>();
    if scanned_keys.is_empty() {
        return Err("未能读取 SSH 主机公钥。".to_string());
    }
    Ok(scanned_keys)
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

pub(crate) fn is_host_key_verification_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("host key verification failed")
        || message.contains("remote host identification has changed")
        || message.contains("possible dns spoofing detected")
        || message.contains("host key is not trusted")
        || message.contains("known_hosts 校验")
        || message.contains("known_hosts verification")
        || (message.contains("offending") && message.contains("known_hosts"))
        || (message.contains("no ") && message.contains("host key is known"))
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

async fn upsert_known_host_from_scan(
    state: &AppState,
    profile: &SshProfile,
    scanned: &Value,
    decision: &Value,
) -> Result<(), String> {
    let _operation = state.vault_operation_lock.lock().await;
    with_store_mut(state, |store| {
        let current = store
            .get("knownHosts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let now_value = now();
        let next = merge_known_hosts_from_scan(current, profile, scanned, decision, &now_value);
        store["knownHosts"] = json!(next);
        Ok(())
    })
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
                    .unwrap_or({
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

fn write_connection_known_hosts_from_public_key(
    state: &AppState,
    profile: &SshProfile,
    public_key: &str,
) -> Result<String, String> {
    write_connection_known_hosts_from_public_keys(state, profile, &[public_key.to_string()])
}

fn write_connection_known_hosts_from_scans(
    state: &AppState,
    profile: &SshProfile,
    scanned_keys: &[Value],
) -> Result<String, String> {
    let mut public_keys = Vec::new();
    for scanned in scanned_keys {
        let public_key = scanned
            .get("publicKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if public_key.is_empty() || public_keys.iter().any(|value| value == public_key) {
            continue;
        }
        public_keys.push(public_key.to_string());
    }
    write_connection_known_hosts_from_public_keys(state, profile, &public_keys)
}

fn write_connection_known_hosts_from_public_keys(
    state: &AppState,
    profile: &SshProfile,
    public_keys: &[String],
) -> Result<String, String> {
    let public_keys = public_keys
        .iter()
        .map(|public_key| public_key.trim())
        .filter(|public_key| !public_key.is_empty())
        .collect::<Vec<_>>();
    if public_keys.is_empty() {
        return Err("SSH 主机公钥为空。".to_string());
    }
    let known_hosts_dir = state.data_dir.join("known-hosts");
    fs::create_dir_all(&known_hosts_dir).map_err(error_string)?;
    let path = known_hosts_dir.join(format!("{}.known_hosts", random_id("ssh")));
    let host_pattern = known_hosts_host_pattern(&profile.address, profile.port);
    let content = public_keys
        .iter()
        .map(|public_key| format!("{host_pattern} {public_key}"))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&path, format!("{content}\n")).map_err(error_string)?;
    Ok(path.to_string_lossy().to_string())
}

pub(super) fn known_hosts_host_pattern(address: &str, port: u16) -> String {
    if port == 22 {
        address.to_string()
    } else {
        format!("[{address}]:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_profile() -> SshProfile {
        SshProfile {
            address: "192.168.51.217".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: "password".to_string(),
            password: String::new(),
            key_path: String::new(),
            known_hosts_path: String::new(),
            proxy_helper_exe: String::new(),
            proxy: None,
            jump: None,
            keepalive_enabled: false,
            keepalive_interval_ms: 15_000,
        }
    }

    #[test]
    fn known_hosts_file_includes_all_scanned_host_key_algorithms() {
        let data_dir =
            std::env::temp_dir().join(format!("shelldesk-host-key-test-{}", random_id("case")));
        let state = AppState::new(data_dir.clone());
        let profile = test_profile();
        let scanned_keys = vec![
            json!({ "publicKey": "ssh-ed25519 AAAAed25519" }),
            json!({ "publicKey": "ecdsa-sha2-nistp256 AAAAecdsa" }),
            json!({ "publicKey": "ssh-ed25519 AAAAed25519" }),
        ];

        let path = write_connection_known_hosts_from_scans(&state, &profile, &scanned_keys)
            .expect("known_hosts file should be written");
        let content = fs::read_to_string(&path).expect("known_hosts file should be readable");

        assert!(content.contains("192.168.51.217 ssh-ed25519 AAAAed25519"));
        assert!(content.contains("192.168.51.217 ecdsa-sha2-nistp256 AAAAecdsa"));
        assert_eq!(content.matches("ssh-ed25519 AAAAed25519").count(), 1);

        let _ = fs::remove_dir_all(data_dir);
    }
}
