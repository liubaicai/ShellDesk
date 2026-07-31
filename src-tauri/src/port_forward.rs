use crate::{
    error_string, now, random_id, read_json_file,
    ssh_tunnel::{config_from_connection_with_window, create_managed_forward, SshForwardMode},
    write_json_file_private, AppState, ConnectionKind, UiWindowRef,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const PORT_FORWARD_FILE: &str = "port-forwards.json";
const MAX_PROFILES: usize = 200;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortForwardProfile {
    #[serde(default)]
    id: String,
    host_id: String,
    name: String,
    kind: PortForwardKind,
    #[serde(default)]
    bind_host: String,
    #[serde(default)]
    bind_port: u16,
    #[serde(default)]
    target_host: String,
    #[serde(default)]
    target_port: u16,
    #[serde(default)]
    autostart: bool,
    #[serde(default = "default_true")]
    reconnect: bool,
    #[serde(default)]
    allow_non_loopback: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PortForwardKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Clone)]
pub(crate) struct PortForwardRuntimeEntry {
    pub(crate) connection_id: String,
    generation: String,
    cancellation: CancellationToken,
    status: String,
    bind_host: String,
    bind_port: u16,
    retry_attempt: u32,
    error: String,
    updated_at: String,
}

struct RuntimeUpdate<'a> {
    status: &'a str,
    bind_host: &'a str,
    bind_port: u16,
    retry_attempt: u32,
    error: &'a str,
}

impl PortForwardRuntimeEntry {
    fn new(connection_id: String, generation: String, cancellation: CancellationToken) -> Self {
        Self {
            connection_id,
            generation,
            cancellation,
            status: "starting".to_string(),
            bind_host: String::new(),
            bind_port: 0,
            retry_attempt: 0,
            error: String::new(),
            updated_at: now(),
        }
    }

    fn as_value(&self) -> Value {
        json!({
            "connectionId": self.connection_id,
            "status": self.status,
            "bindHost": self.bind_host,
            "bindPort": self.bind_port,
            "retryAttempt": self.retry_attempt,
            "error": self.error,
            "updatedAt": self.updated_at,
        })
    }
}

pub(crate) fn list(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = args
        .first()
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "连接 ID 不能为空。".to_string())?;
    let connection = crate::get_connection(state, connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return Ok(json!([]));
    }
    let host_id = connection
        .host
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if host_id.is_empty() {
        return Ok(json!([]));
    }
    let profiles = load_profiles(&state.data_dir)?;
    let runtimes = state.port_forward_runtimes.lock().map_err(error_string)?;
    Ok(Value::Array(
        profiles
            .into_iter()
            .filter(|profile| profile.host_id == host_id)
            .map(|profile| {
                let runtime = runtimes
                    .get(&profile.id)
                    .filter(|runtime| runtime.connection_id == connection_id)
                    .map(PortForwardRuntimeEntry::as_value)
                    .unwrap_or_else(|| json!({ "status": "stopped" }));
                json!({ "profile": profile, "runtime": runtime })
            })
            .collect(),
    ))
}

pub(crate) fn save(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let mut profile: PortForwardProfile = serde_json::from_value(
        args.first()
            .cloned()
            .ok_or_else(|| "端口转发配置不能为空。".to_string())?,
    )
    .map_err(error_string)?;
    normalize_profile(&mut profile)?;
    if profile.id.is_empty() {
        profile.id = random_id("forward");
    }

    let store_guard = state.store_lock.lock().map_err(error_string)?;
    let mut profiles = load_profiles(&state.data_dir)?;
    let updated_existing = if let Some(existing) = profiles
        .iter_mut()
        .find(|existing| existing.id == profile.id)
    {
        if existing.host_id != profile.host_id {
            return Err("不能把端口转发配置移动到其他主机。".to_string());
        }
        *existing = profile.clone();
        true
    } else {
        if profiles.len() >= MAX_PROFILES {
            return Err(format!("端口转发配置最多保存 {MAX_PROFILES} 条。"));
        }
        profiles.push(profile.clone());
        false
    };
    persist_profiles(&state.data_dir, &profiles)?;
    drop(store_guard);
    if updated_existing {
        let _ = stop_runtime(state, &profile.id)?;
    }
    Ok(json!(profile))
}

pub(crate) fn delete(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let profile_id = profile_id_arg(&args)?;
    stop_runtime(state, &profile_id)?;
    let _store_guard = state.store_lock.lock().map_err(error_string)?;
    let mut profiles = load_profiles(&state.data_dir)?;
    let before = profiles.len();
    profiles.retain(|profile| profile.id != profile_id);
    if profiles.len() != before {
        persist_profiles(&state.data_dir, &profiles)?;
    }
    Ok(json!(profiles.len() != before))
}

pub(crate) fn start(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = args
        .first()
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "连接 ID 不能为空。".to_string())?
        .to_string();
    let profile_id = args
        .get(1)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "端口转发配置 ID 不能为空。".to_string())?
        .to_string();
    let profile = load_profiles(&state.data_dir)?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "端口转发配置不存在。".to_string())?;
    start_profile(state, window, connection_id, profile)
}

pub(crate) fn stop(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let profile_id = profile_id_arg(&args)?;
    Ok(json!(stop_runtime(state, &profile_id)?))
}

pub(crate) fn autostart_for_connection(
    state: AppState,
    window: tauri::Window,
    connection_id: String,
    host_id: String,
) {
    let profiles = match load_profiles(&state.data_dir) {
        Ok(profiles) => profiles,
        Err(error) => {
            eprintln!("[port-forward] failed to load autostart profiles: {error}");
            return;
        }
    };
    for profile in profiles
        .into_iter()
        .filter(|profile| profile.host_id == host_id && profile.autostart)
    {
        if let Err(error) = start_profile(
            state.clone(),
            window.clone(),
            connection_id.clone(),
            profile,
        ) {
            eprintln!("[port-forward] autostart failed: {error}");
        }
    }
}

pub(crate) fn close_for_connection(state: &AppState, connection_id: &str) -> Result<(), String> {
    let cancellations = {
        let mut runtimes = state.port_forward_runtimes.lock().map_err(error_string)?;
        let ids = runtimes
            .iter()
            .filter_map(|(id, runtime)| {
                (runtime.connection_id == connection_id).then_some(id.clone())
            })
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| runtimes.remove(&id).map(|runtime| runtime.cancellation))
            .collect::<Vec<_>>()
    };
    for cancellation in cancellations {
        cancellation.cancel();
    }
    Ok(())
}

fn start_profile(
    state: AppState,
    window: tauri::Window,
    connection_id: String,
    profile: PortForwardProfile,
) -> Result<Value, String> {
    let connection = crate::get_connection(&state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return Err("本地连接不支持 SSH 端口转发。".to_string());
    }
    let host_id = connection
        .host
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if host_id.is_empty() || host_id != profile.host_id {
        return Err("端口转发配置不属于当前主机。".to_string());
    }

    let _ = stop_runtime(&state, &profile.id)?;
    let cancellation = CancellationToken::new();
    let generation = random_id("forward-run");
    let runtime = PortForwardRuntimeEntry::new(
        connection_id.clone(),
        generation.clone(),
        cancellation.clone(),
    );
    state
        .port_forward_runtimes
        .lock()
        .map_err(error_string)?
        .insert(profile.id.clone(), runtime.clone());
    let profile_id = profile.id.clone();
    let task_state = state.clone();
    tauri::async_runtime::spawn(async move {
        run_profile(
            task_state,
            window,
            connection_id,
            profile,
            generation,
            cancellation,
        )
        .await;
    });
    Ok(runtime.as_value().merge_profile_id(&profile_id))
}

async fn run_profile(
    state: AppState,
    window: tauri::Window,
    connection_id: String,
    profile: PortForwardProfile,
    generation: String,
    cancellation: CancellationToken,
) {
    let mut attempt = 0_u32;
    loop {
        if cancellation.is_cancelled() || crate::get_connection(&state, &connection_id).is_err() {
            remove_runtime_if_current(&state, &profile.id, &generation);
            return;
        }
        update_runtime(
            &state,
            &profile.id,
            &generation,
            RuntimeUpdate {
                status: if attempt == 0 {
                    "starting"
                } else {
                    "recovering"
                },
                bind_host: "",
                bind_port: 0,
                retry_attempt: attempt,
                error: "",
            },
        );

        let placeholder_target = if profile.kind == PortForwardKind::Local {
            (profile.target_host.as_str(), profile.target_port)
        } else {
            ("127.0.0.1", 1)
        };
        let config = match config_from_connection_with_window(
            &state,
            &window,
            &connection_id,
            placeholder_target.0,
            placeholder_target.1,
            None,
        )
        .await
        {
            Ok(config) => config,
            Err(error) => {
                if !handle_failure(
                    &state,
                    &profile,
                    &generation,
                    &cancellation,
                    &mut attempt,
                    error,
                )
                .await
                {
                    return;
                }
                continue;
            }
        };
        let mode = profile_mode(&profile);
        let runtime = match create_managed_forward(
            config,
            mode,
            state.clone(),
            UiWindowRef::from_window(&window),
        )
        .await
        {
            Ok(runtime) => runtime,
            Err(error) => {
                if !handle_failure(
                    &state,
                    &profile,
                    &generation,
                    &cancellation,
                    &mut attempt,
                    error.user_message(),
                )
                .await
                {
                    return;
                }
                continue;
            }
        };

        attempt = 0;
        update_runtime(
            &state,
            &profile.id,
            &generation,
            RuntimeUpdate {
                status: "running",
                bind_host: runtime.bind_host(),
                bind_port: runtime.bind_port(),
                retry_attempt: attempt,
                error: "",
            },
        );
        let connection_closed = loop {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    runtime.shutdown().await;
                    remove_runtime_if_current(&state, &profile.id, &generation);
                    return;
                }
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    if crate::get_connection(&state, &connection_id).is_err() {
                        break true;
                    }
                    if runtime.is_closed() {
                        break false;
                    }
                }
            }
        };
        runtime.shutdown().await;
        if connection_closed {
            remove_runtime_if_current(&state, &profile.id, &generation);
            return;
        }
        if !handle_failure(
            &state,
            &profile,
            &generation,
            &cancellation,
            &mut attempt,
            "SSH 转发会话已断开。".to_string(),
        )
        .await
        {
            return;
        }
    }
}

async fn handle_failure(
    state: &AppState,
    profile: &PortForwardProfile,
    generation: &str,
    cancellation: &CancellationToken,
    attempt: &mut u32,
    error: String,
) -> bool {
    if !profile.reconnect {
        update_runtime(
            state,
            &profile.id,
            generation,
            RuntimeUpdate {
                status: "error",
                bind_host: "",
                bind_port: 0,
                retry_attempt: *attempt,
                error: &error,
            },
        );
        return false;
    }
    *attempt = attempt.saturating_add(1);
    update_runtime(
        state,
        &profile.id,
        generation,
        RuntimeUpdate {
            status: "recovering",
            bind_host: "",
            bind_port: 0,
            retry_attempt: *attempt,
            error: &error,
        },
    );
    let delay = 1_u64 << (*attempt).min(5);
    tokio::select! {
        _ = cancellation.cancelled() => false,
        _ = tokio::time::sleep(Duration::from_secs(delay)) => true,
    }
}

fn update_runtime(state: &AppState, profile_id: &str, generation: &str, update: RuntimeUpdate<'_>) {
    let Ok(mut runtimes) = state.port_forward_runtimes.lock() else {
        return;
    };
    let Some(runtime) = runtimes
        .get_mut(profile_id)
        .filter(|runtime| runtime.generation == generation)
    else {
        return;
    };
    runtime.status = update.status.to_string();
    runtime.bind_host = update.bind_host.to_string();
    runtime.bind_port = update.bind_port;
    runtime.retry_attempt = update.retry_attempt;
    runtime.error = update.error.to_string();
    runtime.updated_at = now();
}

fn remove_runtime_if_current(state: &AppState, profile_id: &str, generation: &str) {
    let Ok(mut runtimes) = state.port_forward_runtimes.lock() else {
        return;
    };
    if runtimes
        .get(profile_id)
        .is_some_and(|runtime| runtime.generation == generation)
    {
        runtimes.remove(profile_id);
    }
}

fn stop_runtime(state: &AppState, profile_id: &str) -> Result<bool, String> {
    let runtime = state
        .port_forward_runtimes
        .lock()
        .map_err(error_string)?
        .remove(profile_id);
    if let Some(runtime) = runtime {
        runtime.cancellation.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

fn profile_mode(profile: &PortForwardProfile) -> SshForwardMode {
    match profile.kind {
        PortForwardKind::Local => SshForwardMode::Local {
            bind_host: profile.bind_host.clone(),
            bind_port: profile.bind_port,
            target_host: profile.target_host.clone(),
            target_port: profile.target_port,
        },
        PortForwardKind::Remote => SshForwardMode::Remote {
            bind_host: profile.bind_host.clone(),
            bind_port: profile.bind_port,
            target_host: profile.target_host.clone(),
            target_port: profile.target_port,
        },
        PortForwardKind::Dynamic => SshForwardMode::Dynamic {
            bind_host: profile.bind_host.clone(),
            bind_port: profile.bind_port,
        },
    }
}

fn normalize_profile(profile: &mut PortForwardProfile) -> Result<(), String> {
    profile.id = profile.id.trim().to_string();
    profile.host_id = profile.host_id.trim().to_string();
    profile.name = profile.name.trim().to_string();
    profile.bind_host = profile.bind_host.trim().to_string();
    profile.target_host = profile.target_host.trim().to_string();
    if profile.host_id.is_empty() {
        return Err("主机 ID 不能为空。".to_string());
    }
    if profile.name.is_empty() || profile.name.chars().count() > 80 {
        return Err("名称不能为空且不能超过 80 个字符。".to_string());
    }
    if profile.bind_host.is_empty() {
        profile.bind_host = "127.0.0.1".to_string();
    }
    if !profile.allow_non_loopback && !is_loopback_bind(&profile.bind_host) {
        return Err("非回环监听必须显式允许外部访问。".to_string());
    }
    if profile.kind != PortForwardKind::Dynamic {
        if profile.target_host.is_empty() {
            return Err("目标主机不能为空。".to_string());
        }
        if profile.target_port == 0 {
            return Err("目标端口必须在 1-65535 范围内。".to_string());
        }
    } else {
        profile.target_host.clear();
        profile.target_port = 0;
    }
    Ok(())
}

fn is_loopback_bind(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "127.0.0.1" | "::1" | "localhost"
    )
}

fn profile_id_arg(args: &[Value]) -> Result<String, String> {
    args.first()
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "端口转发配置 ID 不能为空。".to_string())
}

fn load_profiles(data_dir: &Path) -> Result<Vec<PortForwardProfile>, String> {
    let value = read_json_file(&profiles_path(data_dir), json!([]))?;
    let raw_profiles = value.as_array().cloned().unwrap_or_default();
    let mut profiles = Vec::with_capacity(raw_profiles.len().min(MAX_PROFILES));
    for value in raw_profiles.into_iter().take(MAX_PROFILES) {
        let Ok(mut profile) = serde_json::from_value::<PortForwardProfile>(value) else {
            continue;
        };
        if normalize_profile(&mut profile).is_ok()
            && !profile.id.is_empty()
            && !profiles
                .iter()
                .any(|existing: &PortForwardProfile| existing.id == profile.id)
        {
            profiles.push(profile);
        }
    }
    Ok(profiles)
}

fn persist_profiles(data_dir: &Path, profiles: &[PortForwardProfile]) -> Result<(), String> {
    write_json_file_private(&profiles_path(data_dir), &json!(profiles))
}

fn profiles_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PORT_FORWARD_FILE)
}

fn default_true() -> bool {
    true
}

trait RuntimeValueExt {
    fn merge_profile_id(self, profile_id: &str) -> Value;
}

impl RuntimeValueExt for Value {
    fn merge_profile_id(mut self, profile_id: &str) -> Value {
        self["profileId"] = json!(profile_id);
        self
    }
}

pub(crate) fn new_runtime_map() -> Mutex<HashMap<String, PortForwardRuntimeEntry>> {
    Mutex::new(HashMap::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_profile(kind: PortForwardKind) -> PortForwardProfile {
        PortForwardProfile {
            id: String::new(),
            host_id: "host-1".to_string(),
            name: "Forward".to_string(),
            kind,
            bind_host: String::new(),
            bind_port: 0,
            target_host: "127.0.0.1".to_string(),
            target_port: 5432,
            autostart: false,
            reconnect: true,
            allow_non_loopback: false,
        }
    }

    #[test]
    fn normalizes_loopback_defaults_and_dynamic_targets() {
        let mut local = base_profile(PortForwardKind::Local);
        normalize_profile(&mut local).unwrap();
        assert_eq!(local.bind_host, "127.0.0.1");

        let mut dynamic = base_profile(PortForwardKind::Dynamic);
        normalize_profile(&mut dynamic).unwrap();
        assert!(dynamic.target_host.is_empty());
        assert_eq!(dynamic.target_port, 0);
    }

    #[test]
    fn rejects_non_loopback_without_explicit_opt_in() {
        let mut profile = base_profile(PortForwardKind::Local);
        profile.bind_host = "0.0.0.0".to_string();
        assert!(normalize_profile(&mut profile).is_err());
        profile.allow_non_loopback = true;
        normalize_profile(&mut profile).unwrap();
    }

    #[test]
    fn rejects_missing_fixed_target() {
        let mut profile = base_profile(PortForwardKind::Remote);
        profile.target_port = 0;
        assert!(normalize_profile(&mut profile).is_err());
    }

    #[test]
    fn persists_profiles_atomically_and_updates_by_id() {
        let directory = std::env::temp_dir().join(random_id("port-forward-test"));
        let state = AppState::new(directory.clone());
        let created = save(
            &state,
            vec![json!({
                "hostId": "host-1",
                "name": "SOCKS",
                "kind": "dynamic",
                "bindHost": "127.0.0.1",
                "bindPort": 0,
                "targetHost": "",
                "targetPort": 0,
                "autostart": true,
                "reconnect": true,
                "allowNonLoopback": false
            })],
        )
        .unwrap();
        let id = created["id"].as_str().unwrap();
        let updated = save(
            &state,
            vec![json!({
                "id": id,
                "hostId": "host-1",
                "name": "SOCKS updated",
                "kind": "dynamic",
                "bindHost": "127.0.0.1",
                "bindPort": 1080,
                "targetHost": "",
                "targetPort": 0,
                "autostart": false,
                "reconnect": true,
                "allowNonLoopback": false
            })],
        )
        .unwrap();
        assert_eq!(updated["id"], id);
        let profiles = load_profiles(&directory).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "SOCKS updated");
        assert_eq!(profiles[0].bind_port, 1080);
        let _ = std::fs::remove_dir_all(directory);
    }
}
