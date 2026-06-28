#[cfg(windows)]
use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

use crate::{error_string, now, read_json_file, write_json_file_private, AppState};

const CONFIG_STORE_FORMAT: &str = "shelldesk-config-store";
const VAULT_FORMAT: &str = "shelldesk-vault";
const VAULT_SCHEMA_VERSION: i64 = 1;

pub(crate) fn storage_info(state: &AppState) -> Value {
    let protected = vault_protection_available();
    json!({
        "path": state.data_dir.to_string_lossy(),
        "configPath": config_store_path(state).to_string_lossy(),
        "vaultPath": vault_store_path(state).to_string_lossy(),
        "protected": protected,
        "protectionLabel": if protected {
            "普通配置写入 config.json，密码、私钥和 AI API 密钥已使用系统凭据加密保存到 vault.json"
        } else {
            "普通配置写入 config.json，当前系统不支持加密，敏感 vault 改为本地文件权限保护"
        }
    })
}

pub(crate) fn read_store(state: &AppState, default_store: Value) -> Result<(Value, bool), String> {
    let config_path = config_store_path(state);
    let vault_path = vault_store_path(state);

    if config_path.exists() {
        let config_payload = read_persisted_config_wrapper(read_json_file(
            &config_path,
            create_config_payload(&default_store),
        )?)?;
        let mut should_rewrite = false;
        let secrets_payload = if vault_path.exists() {
            let persisted = read_persisted_vault_wrapper(read_json_file(&vault_path, json!({}))?)?;
            if is_vault_secrets_payload(&persisted) {
                persisted
            } else {
                should_rewrite = vault_protection_available();
                create_vault_secrets_payload(&persisted)
            }
        } else {
            create_vault_secrets_payload(&default_store)
        };
        return Ok((
            merge_config_and_secrets(&config_payload, &secrets_payload),
            should_rewrite,
        ));
    }

    if !vault_path.exists() {
        return Ok((default_store, false));
    }

    let persisted = read_persisted_vault_wrapper(read_json_file(&vault_path, json!({}))?)?;
    if is_vault_secrets_payload(&persisted) {
        return Ok((
            merge_config_and_secrets(&create_config_payload(&default_store), &persisted),
            false,
        ));
    }

    Ok((persisted, true))
}

pub(crate) fn write_store(state: &AppState, store: &Value) -> Result<(), String> {
    let config_wrapper = json!({
        "format": CONFIG_STORE_FORMAT,
        "version": VAULT_SCHEMA_VERSION,
        "updatedAt": now(),
        "payload": create_config_payload(store)
    });
    write_json_file_private(&config_store_path(state), &config_wrapper)?;

    let vault_payload = store_without_runtime_fields(store);
    let vault_wrapper = if vault_protection_available() {
        let payload_json =
            serde_json::to_string(&create_vault_secrets_payload(store)).map_err(error_string)?;
        json!({
            "format": VAULT_FORMAT,
            "version": VAULT_SCHEMA_VERSION,
            "protected": true,
            "ciphertext": encrypt_electron_safe_storage(&payload_json)?
        })
    } else {
        json!({
            "format": VAULT_FORMAT,
            "version": VAULT_SCHEMA_VERSION,
            "protected": false,
            "payload": vault_payload
        })
    };
    write_json_file_private(&vault_store_path(state), &vault_wrapper)
}

fn config_store_path(state: &AppState) -> PathBuf {
    state.data_dir.join("config.json")
}

fn vault_store_path(state: &AppState) -> PathBuf {
    state.data_dir.join("vault.json")
}

fn read_persisted_config_wrapper(raw_payload: Value) -> Result<Value, String> {
    let Some(object) = raw_payload.as_object() else {
        return Err("配置文件格式无效。".to_string());
    };
    if object.get("format").and_then(Value::as_str) == Some(CONFIG_STORE_FORMAT)
        && object.get("version").and_then(Value::as_i64) == Some(VAULT_SCHEMA_VERSION)
    {
        return Ok(object.get("payload").cloned().unwrap_or_else(|| json!({})));
    }
    if [
        "hosts",
        "sshKeys",
        "proxyProfiles",
        "knownHosts",
        "settings",
        "browserBookmarks",
        "preferences",
    ]
    .iter()
    .any(|key| object.contains_key(*key))
    {
        return Ok(Value::Object(object.clone()));
    }
    Err("配置文件格式不受支持。".to_string())
}

fn read_persisted_vault_wrapper(raw_payload: Value) -> Result<Value, String> {
    let Some(object) = raw_payload.as_object() else {
        return Err("本地数据格式不受支持。".to_string());
    };
    if object.get("format").and_then(Value::as_str) != Some(VAULT_FORMAT)
        || object.get("version").and_then(Value::as_i64) != Some(VAULT_SCHEMA_VERSION)
    {
        return Ok(Value::Object(object.clone()));
    }
    if object
        .get("protected")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let ciphertext = object
            .get("ciphertext")
            .and_then(Value::as_str)
            .unwrap_or("");
        let plaintext = decrypt_electron_safe_storage(ciphertext)?;
        return serde_json::from_str(&plaintext).map_err(error_string);
    }
    Ok(object.get("payload").cloned().unwrap_or_else(|| json!({})))
}

fn create_config_payload(store: &Value) -> Value {
    json!({
        "version": VAULT_SCHEMA_VERSION,
        "hosts": config_hosts(store.get("hosts")),
        "sshKeys": config_ssh_keys(store.get("sshKeys")),
        "proxyProfiles": config_proxy_profiles(store.get("proxyProfiles")),
        "knownHosts": store.get("knownHosts").cloned().unwrap_or_else(|| json!([])),
        "settings": config_settings(store.get("settings")),
        "browserBookmarks": store.get("browserBookmarks").cloned().unwrap_or_else(|| json!([])),
        "preferences": store.get("preferences").cloned().unwrap_or_else(|| json!({})),
        "remoteConnectionProfiles": export_remote_connection_profiles(store.get("remoteConnectionProfiles"), true)
    })
}

fn create_vault_secrets_payload(store: &Value) -> Value {
    json!({
        "version": VAULT_SCHEMA_VERSION,
        "hostSecrets": host_secrets(store.get("hosts")),
        "sshKeySecrets": ssh_key_secrets(store.get("sshKeys")),
        "proxyProfileSecrets": proxy_profile_secrets(store.get("proxyProfiles")),
        "aiSecret": {
            "apiKey": store.pointer("/settings/aiApiKey").and_then(Value::as_str).unwrap_or("")
        },
        "remoteConnectionProfileSecrets": export_remote_connection_profiles(store.get("remoteConnectionProfiles"), false)
    })
}

fn config_hosts(hosts: Option<&Value>) -> Value {
    let items = hosts.and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .map(|mut item| {
                if let Some(object) = item.as_object_mut() {
                    object.remove("password");
                    object.remove("passphrase");
                    object.remove("rootPassword");
                }
                item
            })
            .collect(),
    )
}

fn config_ssh_keys(keys: Option<&Value>) -> Value {
    let items = keys.and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .map(|mut item| {
                if let Some(object) = item.as_object_mut() {
                    object.remove("privateKey");
                    object.remove("passphrase");
                }
                item
            })
            .collect(),
    )
}

fn config_proxy_profiles(profiles: Option<&Value>) -> Value {
    let items = profiles
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .map(|mut item| {
                if let Some(config) = item
                    .as_object_mut()
                    .and_then(|object| object.get_mut("config"))
                    .and_then(Value::as_object_mut)
                {
                    config.insert("password".to_string(), json!(""));
                }
                item
            })
            .collect(),
    )
}

fn config_settings(settings: Option<&Value>) -> Value {
    let mut settings = settings.cloned().unwrap_or_else(|| json!({}));
    if let Some(object) = settings.as_object_mut() {
        object.insert("aiApiKey".to_string(), json!(""));
    }
    settings
}

fn host_secrets(hosts: Option<&Value>) -> Value {
    let items = hosts.and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .filter_map(|item| {
                let secret = json!({
                    "id": item.get("id").and_then(Value::as_str).unwrap_or(""),
                    "password": item.get("password").and_then(Value::as_str).unwrap_or(""),
                    "passphrase": item.get("passphrase").and_then(Value::as_str).unwrap_or(""),
                    "rootPassword": item.get("rootPassword").and_then(Value::as_str).unwrap_or("")
                });
                if ["password", "passphrase", "rootPassword"]
                    .iter()
                    .any(|key| {
                        !secret
                            .get(*key)
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .is_empty()
                    })
                {
                    Some(secret)
                } else {
                    None
                }
            })
            .collect(),
    )
}

fn ssh_key_secrets(keys: Option<&Value>) -> Value {
    let items = keys.and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .map(|item| {
                json!({
                    "id": item.get("id").and_then(Value::as_str).unwrap_or(""),
                    "privateKey": item.get("privateKey").and_then(Value::as_str).unwrap_or(""),
                    "passphrase": item.get("passphrase").and_then(Value::as_str).unwrap_or("")
                })
            })
            .collect(),
    )
}

fn proxy_profile_secrets(profiles: Option<&Value>) -> Value {
    let items = profiles
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .filter_map(|item| {
                let password = item
                    .pointer("/config/password")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if password.is_empty() {
                    None
                } else {
                    Some(json!({
                        "id": item.get("id").and_then(Value::as_str).unwrap_or(""),
                        "password": password
                    }))
                }
            })
            .collect(),
    )
}

fn merge_config_and_secrets(config_payload: &Value, secrets_payload: &Value) -> Value {
    let host_secrets = secrets_by_id(secrets_payload.get("hostSecrets"));
    let key_secrets = secrets_by_id(
        secrets_payload
            .get("sshKeySecrets")
            .or_else(|| secrets_payload.get("keySecrets")),
    );
    let proxy_secrets = secrets_by_id(secrets_payload.get("proxyProfileSecrets"));
    let profile_secrets = remote_profile_secret_values(secrets_payload);

    let hosts = merge_array_secrets(
        config_payload.get("hosts"),
        &host_secrets,
        &["password", "passphrase", "rootPassword"],
        true,
    );
    let ssh_keys = merge_array_secrets(
        config_payload.get("sshKeys"),
        &key_secrets,
        &["privateKey", "passphrase"],
        false,
    );
    let proxy_profiles =
        merge_proxy_profile_secrets(config_payload.get("proxyProfiles"), &proxy_secrets);
    let mut settings = config_payload
        .get("settings")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "aiApiKey".to_string(),
            secrets_payload
                .pointer("/aiSecret/apiKey")
                .cloned()
                .unwrap_or_else(|| json!("")),
        );
    }

    json!({
        "version": VAULT_SCHEMA_VERSION,
        "hosts": hosts,
        "sshKeys": ssh_keys,
        "proxyProfiles": proxy_profiles,
        "knownHosts": config_payload.get("knownHosts").cloned().unwrap_or_else(|| json!([])),
        "settings": settings,
        "browserBookmarks": config_payload.get("browserBookmarks").cloned().unwrap_or_else(|| json!([])),
        "preferences": config_payload.get("preferences").cloned().unwrap_or_else(|| json!({})),
        "remoteConnectionProfiles": merge_remote_connection_profiles(config_payload.get("remoteConnectionProfiles"), &profile_secrets)
    })
}

fn secrets_by_id(items: Option<&Value>) -> Map<String, Value> {
    let mut output = Map::new();
    for item in items.and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        output.insert(id.to_string(), item.clone());
    }
    output
}

fn merge_array_secrets(
    items: Option<&Value>,
    secrets: &Map<String, Value>,
    fields: &[&str],
    keep_without_secret: bool,
) -> Value {
    let mut merged = Vec::new();
    for mut item in items.and_then(Value::as_array).cloned().unwrap_or_default() {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        let Some(secret) = secrets.get(id) else {
            if keep_without_secret {
                merged.push(item);
            }
            continue;
        };
        if let Some(object) = item.as_object_mut() {
            for field in fields {
                object.insert(
                    (*field).to_string(),
                    secret.get(*field).cloned().unwrap_or_else(|| json!("")),
                );
            }
        }
        merged.push(item);
    }
    merged.into()
}

fn merge_proxy_profile_secrets(profiles: Option<&Value>, secrets: &Map<String, Value>) -> Value {
    let mut merged = Vec::new();
    for mut item in profiles
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        if let Some(secret) = secrets.get(id) {
            if let Some(config) = item
                .as_object_mut()
                .and_then(|object| object.get_mut("config"))
                .and_then(Value::as_object_mut)
            {
                config.insert(
                    "password".to_string(),
                    secret.get("password").cloned().unwrap_or_else(|| json!("")),
                );
            }
        }
        merged.push(item);
    }
    merged.into()
}

fn export_remote_connection_profiles(profiles: Option<&Value>, config_values: bool) -> Value {
    let Some(profile_object) = profiles.and_then(Value::as_object) else {
        return json!([]);
    };
    let mut exported = Vec::new();
    for (host_id, host_profiles) in profile_object {
        let Some(app_profiles) = host_profiles.as_object() else {
            continue;
        };
        for (app_key, values) in app_profiles {
            let values = split_remote_connection_profile_values(values, config_values);
            if !config_values && values.as_object().is_none_or(|object| object.is_empty()) {
                continue;
            }
            exported.push(json!({
                "hostId": host_id,
                "appKey": app_key,
                "values": values,
                "updatedAt": now()
            }));
        }
    }
    exported.sort_by(|left, right| {
        let left_key = format!(
            "{}:{}",
            left.get("hostId").and_then(Value::as_str).unwrap_or(""),
            left.get("appKey").and_then(Value::as_str).unwrap_or("")
        );
        let right_key = format!(
            "{}:{}",
            right.get("hostId").and_then(Value::as_str).unwrap_or(""),
            right.get("appKey").and_then(Value::as_str).unwrap_or("")
        );
        left_key.cmp(&right_key)
    });
    Value::Array(exported)
}

fn split_remote_connection_profile_values(values: &Value, config_values: bool) -> Value {
    let Some(object) = values.as_object() else {
        return json!({});
    };
    Value::Object(
        object
            .iter()
            .filter_map(|(key, value)| {
                let is_secret = is_remote_connection_profile_secret_key(key);
                if is_secret == config_values {
                    None
                } else {
                    Some((key.clone(), value.clone()))
                }
            })
            .collect(),
    )
}

fn is_remote_connection_profile_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "password",
        "passphrase",
        "secret",
        "token",
        "apikey",
        "accesskey",
        "secretkey",
    ]
    .iter()
    .any(|suffix| normalized.ends_with(suffix))
}

fn remote_profile_secret_values(secrets_payload: &Value) -> Map<String, Value> {
    let mut output = Map::new();
    for item in secrets_payload
        .get("remoteConnectionProfileSecrets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let host_id = item.get("hostId").and_then(Value::as_str).unwrap_or("");
        let app_key = item.get("appKey").and_then(Value::as_str).unwrap_or("");
        if host_id.is_empty() || app_key.is_empty() {
            continue;
        }
        output.insert(
            format!("{host_id}:{app_key}"),
            split_remote_connection_profile_values(
                item.get("values").unwrap_or(&Value::Null),
                false,
            ),
        );
    }
    output
}

fn merge_remote_connection_profiles(
    profiles: Option<&Value>,
    secrets: &Map<String, Value>,
) -> Value {
    let mut profile_store = if let Some(object_profiles) = profiles.and_then(Value::as_object) {
        Value::Object(object_profiles.clone())
    } else {
        import_remote_connection_profiles(profiles)
    };
    for (profile_key, secret_values) in secrets {
        let Some((host_id, app_key)) = profile_key.split_once(':') else {
            continue;
        };
        let host_profiles = profile_store
            .as_object_mut()
            .expect("remote profile store should be an object")
            .entry(host_id.to_string())
            .or_insert_with(|| json!({}));
        if let Some(host_object) = host_profiles.as_object_mut() {
            let app_values = host_object
                .entry(app_key.to_string())
                .or_insert_with(|| json!({}));
            if let (Some(app_object), Some(secret_object)) =
                (app_values.as_object_mut(), secret_values.as_object())
            {
                for (key, value) in secret_object {
                    app_object.insert(key.clone(), value.clone());
                }
            }
        }
    }
    profile_store
}

fn import_remote_connection_profiles(profiles: Option<&Value>) -> Value {
    let mut profile_store = Map::new();
    let Some(profile_array) = profiles.and_then(Value::as_array) else {
        return Value::Object(profile_store);
    };
    for profile in profile_array {
        let Some(host_id) = profile
            .get("hostId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(app_key) = profile
            .get("appKey")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let values = profile.get("values").cloned().unwrap_or_else(|| json!({}));
        let host_profiles = profile_store
            .entry(host_id.to_string())
            .or_insert_with(|| json!({}));
        if let Some(host_object) = host_profiles.as_object_mut() {
            host_object.entry(app_key.to_string()).or_insert(values);
        }
    }
    Value::Object(profile_store)
}

fn store_without_runtime_fields(store: &Value) -> Value {
    let mut output = store.clone();
    if let Some(object) = output.as_object_mut() {
        object.remove("storage");
    }
    output
}

fn is_vault_secrets_payload(raw_payload: &Value) -> bool {
    raw_payload.as_object().is_some_and(|object| {
        [
            "hostSecrets",
            "sshKeySecrets",
            "keySecrets",
            "proxyProfileSecrets",
            "remoteConnectionProfileSecrets",
            "aiSecret",
        ]
        .iter()
        .any(|key| object.contains_key(*key))
    })
}

#[cfg(windows)]
fn vault_protection_available() -> bool {
    true
}

#[cfg(not(windows))]
fn vault_protection_available() -> bool {
    false
}

#[cfg(windows)]
fn encrypt_electron_safe_storage(plaintext: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let mut bytes = plaintext.as_bytes().to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("系统凭据加密失败。".to_string());
    }
    let encrypted = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    if !output.pbData.is_null() {
        unsafe {
            let _ = LocalFree(output.pbData as _);
        }
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(encrypted))
}

#[cfg(not(windows))]
fn encrypt_electron_safe_storage(_plaintext: &str) -> Result<String, String> {
    Err("当前平台不支持系统凭据加密。".to_string())
}

#[cfg(windows)]
pub(crate) fn decrypt_electron_safe_storage(ciphertext: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let mut encrypted = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_err(error_string)?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len() as u32,
        pbData: encrypted.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("系统凭据解密失败。".to_string());
    }
    let decrypted = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    if !output.pbData.is_null() {
        unsafe {
            let _ = LocalFree(output.pbData as _);
        }
    }
    String::from_utf8(decrypted).map_err(error_string)
}

#[cfg(not(windows))]
pub(crate) fn decrypt_electron_safe_storage(_ciphertext: &str) -> Result<String, String> {
    Err("当前平台不支持系统凭据解密。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_state(name: &str) -> AppState {
        let dir = std::env::temp_dir().join(format!(
            "shelldesk-vault-storage-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        AppState::new(dir)
    }

    fn sample_store() -> Value {
        json!({
            "hosts": [{
                "id": "host-1",
                "name": "prod",
                "password": "ssh-pass",
                "passphrase": "host-phrase",
                "rootPassword": "root-pass"
            }],
            "sshKeys": [{
                "id": "key-1",
                "name": "deploy",
                "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
                "passphrase": "key-phrase"
            }],
            "proxyProfiles": [{
                "id": "proxy-1",
                "config": { "type": "http", "password": "proxy-pass" }
            }],
            "knownHosts": [],
            "settings": { "language": "zh-CN", "aiApiKey": "sk-test" },
            "browserBookmarks": [],
            "preferences": { "sidebar": "wide" },
            "remoteConnectionProfiles": {
                "host-1": {
                    "mysql": {
                        "database": "app",
                        "password": "db-pass",
                        "apiKey": "api-secret"
                    }
                }
            }
        })
    }

    #[test]
    fn config_payload_removes_sensitive_fields() {
        let config = create_config_payload(&sample_store());

        assert!(config["hosts"][0].get("password").is_none());
        assert!(config["sshKeys"][0].get("privateKey").is_none());
        assert_eq!(config["proxyProfiles"][0]["config"]["password"], "");
        assert_eq!(config["settings"]["aiApiKey"], "");
        assert_eq!(
            config["remoteConnectionProfiles"][0]["values"],
            json!({ "database": "app" })
        );
    }

    #[test]
    fn secrets_payload_extracts_sensitive_fields() {
        let secrets = create_vault_secrets_payload(&sample_store());

        assert_eq!(secrets["hostSecrets"][0]["password"], "ssh-pass");
        assert_eq!(
            secrets["sshKeySecrets"][0]["privateKey"],
            sample_store()["sshKeys"][0]["privateKey"]
        );
        assert_eq!(secrets["proxyProfileSecrets"][0]["password"], "proxy-pass");
        assert_eq!(secrets["aiSecret"]["apiKey"], "sk-test");
        assert_eq!(
            secrets["remoteConnectionProfileSecrets"][0]["values"],
            json!({ "apiKey": "api-secret", "password": "db-pass" })
        );
    }

    #[test]
    fn split_config_and_secret_payloads_round_trip() {
        let store = sample_store();
        let merged = merge_config_and_secrets(
            &create_config_payload(&store),
            &create_vault_secrets_payload(&store),
        );

        assert_eq!(merged["hosts"][0]["password"], "ssh-pass");
        assert_eq!(
            merged["sshKeys"][0]["privateKey"],
            store["sshKeys"][0]["privateKey"]
        );
        assert_eq!(
            merged["proxyProfiles"][0]["config"]["password"],
            "proxy-pass"
        );
        assert_eq!(merged["settings"]["aiApiKey"], "sk-test");
        assert_eq!(
            merged["remoteConnectionProfiles"]["host-1"]["mysql"]["password"],
            "db-pass"
        );
    }

    #[test]
    fn write_store_creates_split_files_and_read_store_restores_full_store() {
        let state = temp_state("roundtrip");
        let store = sample_store();

        write_store(&state, &store).unwrap();

        let config = read_json_file(&config_store_path(&state), json!({})).unwrap();
        assert_eq!(config["format"], CONFIG_STORE_FORMAT);
        assert_eq!(config["payload"]["hosts"][0].get("password"), None);
        assert_eq!(config["payload"]["settings"]["aiApiKey"], "");

        let vault = read_json_file(&vault_store_path(&state), json!({})).unwrap();
        assert_eq!(vault["format"], VAULT_FORMAT);
        assert_eq!(
            vault["protected"].as_bool(),
            Some(vault_protection_available())
        );
        if vault_protection_available() {
            assert!(vault.get("ciphertext").and_then(Value::as_str).is_some());
            assert!(vault.get("payload").is_none());
        } else {
            assert_eq!(vault["payload"]["hosts"][0]["password"], "ssh-pass");
        }

        let (loaded, _) = read_store(&state, json!({})).unwrap();
        assert_eq!(loaded["hosts"][0]["password"], "ssh-pass");
        assert_eq!(
            loaded["sshKeys"][0]["privateKey"],
            store["sshKeys"][0]["privateKey"]
        );
        assert_eq!(loaded["settings"]["aiApiKey"], "sk-test");

        let _ = fs::remove_dir_all(&state.data_dir);
    }
}
