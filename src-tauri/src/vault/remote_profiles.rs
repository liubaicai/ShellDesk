use super::{clone_json_with_size_limit, read_bounded_string};
use serde_json::{json, Value};

pub(super) const REMOTE_DESKTOP_APP_KEYS: &[&str] = &[
    "files",
    "terminal",
    "notepad",
    "code-editor",
    "browser",
    "vnc",
    "log-viewer",
    "monitor",
    "mysql",
    "clickhouse",
    "redis",
    "service-manager",
    "container-manager",
    "k8s-manager",
    "vm-manager",
    "port-manager",
    "firewall-manager",
    "iptables-manager",
    "network-diagnostics",
    "disk-analyzer",
    "disk-manager",
    "package-manager",
    "git-manager",
    "cert-manager",
    "nginx-manager",
    "caddy-manager",
    "apache-manager",
    "scheduled-tasks",
    "postgres",
    "mongo",
    "search-cluster",
    "message-queue",
    "s3-browser",
    "frp-manager",
    "frps-manager",
    "security-audit",
    "api-debugger",
    "procmanager",
    "ai-chat",
    "settings",
    "sqlite",
];

pub(crate) fn get_remote_connection_profile(
    store: &Value,
    raw_host_id: &str,
    raw_app_key: &str,
) -> Result<Value, String> {
    let host_id = read_remote_connection_profile_host_id(raw_host_id)?;
    let app_key = read_remote_connection_profile_app_key(raw_app_key)?;
    Ok(store
        .get("remoteConnectionProfiles")
        .and_then(|profiles| profiles.get(&host_id))
        .and_then(|profiles| profiles.get(&app_key))
        .cloned()
        .unwrap_or(Value::Null))
}

pub(crate) fn save_remote_connection_profile_to_store(
    store: &mut Value,
    raw_host_id: &str,
    raw_app_key: &str,
    raw_values: Value,
) -> Result<Value, String> {
    let host_id = read_remote_connection_profile_host_id(raw_host_id)?;
    let app_key = read_remote_connection_profile_app_key(raw_app_key)?;
    let values = read_remote_connection_profile_values(raw_values)?;
    let Some(store_object) = store.as_object_mut() else {
        return Err("本地数据无效。".to_string());
    };
    if !store_object
        .get("remoteConnectionProfiles")
        .is_some_and(Value::is_object)
    {
        store_object.insert("remoteConnectionProfiles".to_string(), json!({}));
    }
    let profiles = store_object
        .get_mut("remoteConnectionProfiles")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "本地数据无效。".to_string())?;
    let host_profiles = profiles
        .entry(host_id)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "本地数据无效。".to_string())?;
    host_profiles.insert(app_key, values.clone());
    Ok(values)
}

fn read_remote_connection_profile_host_id(value: &str) -> Result<String, String> {
    read_bounded_string(value, "远程组件主机 ID", 512, true, true, true)
}

fn read_remote_connection_profile_app_key(value: &str) -> Result<String, String> {
    let app_key = read_bounded_string(value, "远程组件标识", 80, true, true, true)?;
    if !REMOTE_DESKTOP_APP_KEYS.contains(&app_key.as_str()) {
        return Err("远程组件标识无效。".to_string());
    }
    Ok(app_key)
}

pub(super) fn read_remote_connection_profile_values(raw_values: Value) -> Result<Value, String> {
    let Some(values) = raw_values.as_object() else {
        return Ok(json!({}));
    };
    clone_json_with_size_limit(
        raw_values.clone(),
        64 * 1024,
        "远程组件连接配置超过大小限制。",
    )?;
    let mut output = serde_json::Map::new();
    for (raw_key, raw_value) in values.iter().take(80) {
        let key = read_bounded_string(raw_key, "远程组件配置键", 80, true, true, true)?;
        if !key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
        {
            continue;
        }
        output.insert(
            key.clone(),
            read_remote_connection_profile_value(raw_value, &format!("远程组件配置 {key}"))?,
        );
    }
    Ok(Value::Object(output))
}

fn read_remote_connection_profile_value(value: &Value, label: &str) -> Result<Value, String> {
    match value {
        Value::String(value) => Ok(json!(read_bounded_string(
            value, label, 8192, false, false, false
        )?)),
        Value::Bool(_) => Ok(value.clone()),
        Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => Ok(value.clone()),
        _ => Ok(json!("")),
    }
}
