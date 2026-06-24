use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, process::Stdio};
use tauri::Emitter;
use tokio::process::Command;

use crate::{error_string, now, prevent_tokio_process_window, random_id, AppState};

use super::{to_snapshot, with_store_mut, MAX_PRIVATE_KEY_BYTES, MAX_PUBLIC_KEY_BYTES};

pub(super) fn renderer_key_record(mut key: Value) -> Value {
    if let Some(object) = key.as_object_mut() {
        object.remove("privateKey");
    }
    key
}

pub(crate) fn merge_private_key_fields(
    existing: Option<&Value>,
    incoming: &Value,
) -> Result<Value, String> {
    let existing_keys = existing
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let private_by_id = existing_keys
        .iter()
        .filter_map(|item| {
            Some((
                item.get("id")?.as_str()?.to_string(),
                item.get("privateKey")?.as_str()?.to_string(),
            ))
        })
        .collect::<HashMap<_, _>>();
    let incoming_keys = incoming.as_array().cloned().unwrap_or_default();
    let mut merged = Vec::with_capacity(incoming_keys.len());
    for mut item in incoming_keys {
        if item
            .get("privateKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("");
            if let Some(private_key) = private_by_id.get(id) {
                item["privateKey"] = json!(private_key);
            } else {
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(id);
                return Err(format!("密钥「{}」缺少私钥内容，无法保存。", name));
            }
        }
        merged.push(item);
    }
    Ok(Value::Array(merged))
}

pub(crate) async fn import_key_pair(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let payload = args.first().cloned().unwrap_or_else(|| json!({}));
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Imported key")
        .to_string();
    let public_key_path = payload
        .get("publicKeyPath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut public_key = if public_key_path.is_empty() {
        String::new()
    } else {
        read_local_text_file(&public_key_path, "SSH 公钥", MAX_PUBLIC_KEY_BYTES)?
    };
    let private_key_path = payload
        .get("privateKeyPath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let private_key = read_local_text_file(&private_key_path, "SSH 私钥", MAX_PRIVATE_KEY_BYTES)?;
    let passphrase = payload
        .get("passphrase")
        .and_then(Value::as_str)
        .unwrap_or("");
    if public_key.trim().is_empty() {
        public_key = derive_public_key_from_private_key(&private_key_path, passphrase)
            .await
            .unwrap_or_default();
    }
    let fingerprint = public_key_fingerprint(&public_key).unwrap_or_default();
    let algorithm = public_key_algorithm(&public_key)
        .unwrap_or("unknown")
        .to_string();
    let key = json!({
        "id": random_id("key"),
        "name": name,
        "source": "imported",
        "algorithm": algorithm,
        "fingerprint": fingerprint,
        "publicKey": public_key.trim(),
        "privateKey": private_key,
        "passphrase": passphrase,
        "createdAt": now(),
        "updatedAt": now()
    });
    let snapshot = with_store_mut(state, |store| {
        ensure_unique_ssh_key(store.get("sshKeys"), &key)?;
        if let Some(keys) = store.get_mut("sshKeys").and_then(Value::as_array_mut) {
            keys.push(key.clone());
        }
        Ok(to_snapshot(state, store.clone()))
    })?;
    let _ = window.emit("vault:changed", json!({ "kind": "vault" }));
    Ok(json!({ "snapshot": snapshot, "key": renderer_key_record(key) }))
}

pub(crate) async fn generate_key_pair(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let payload = args.first().cloned().unwrap_or_else(|| json!({}));
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("RSA key")
        .to_string();
    let modulus_length = payload
        .get("modulusLength")
        .and_then(Value::as_u64)
        .filter(|value| matches!(*value, 2048 | 3072 | 4096))
        .unwrap_or(4096)
        .to_string();
    let passphrase = payload
        .get("passphrase")
        .and_then(Value::as_str)
        .unwrap_or("");
    let key_id = random_id("key");
    let key_dir = state.data_dir.join("generated-keys");
    fs::create_dir_all(&key_dir).map_err(error_string)?;
    let private_path = key_dir.join(&key_id);
    let public_path = key_dir.join(format!("{key_id}.pub"));
    if private_path.exists() {
        let _ = fs::remove_file(&private_path);
    }
    if public_path.exists() {
        let _ = fs::remove_file(&public_path);
    }
    let mut command = Command::new("ssh-keygen");
    prevent_tokio_process_window(&mut command);
    let output = command
        .args([
            "-t",
            "rsa",
            "-b",
            &modulus_length,
            "-N",
            passphrase,
            "-C",
            &name,
            "-f",
            &private_path.to_string_lossy(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(error_string)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let private_key = fs::read_to_string(&private_path).map_err(error_string)?;
    let public_key = fs::read_to_string(&public_path).unwrap_or_default();
    let _ = fs::remove_file(&private_path);
    let _ = fs::remove_file(&public_path);
    let fingerprint = public_key_fingerprint(&public_key).unwrap_or_default();
    let algorithm = public_key_algorithm(&public_key)
        .unwrap_or("RSA")
        .to_string();
    let key = json!({
        "id": key_id,
        "name": name,
        "source": "generated",
        "algorithm": algorithm,
        "fingerprint": fingerprint,
        "publicKey": public_key.trim(),
        "privateKey": private_key,
        "passphrase": passphrase,
        "createdAt": now(),
        "updatedAt": now()
    });
    let snapshot = with_store_mut(state, |store| {
        if let Some(keys) = store.get_mut("sshKeys").and_then(Value::as_array_mut) {
            keys.push(key.clone());
        }
        Ok(to_snapshot(state, store.clone()))
    })?;
    let _ = window.emit("vault:changed", json!({ "kind": "vault" }));
    Ok(json!({ "snapshot": snapshot, "key": renderer_key_record(key) }))
}

fn read_local_text_file(path: &str, label: &str, max_bytes: u64) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return Err(format!("{label}路径无效。"));
    }
    let metadata = fs::metadata(trimmed).map_err(|_| format!("{label}不存在。"))?;
    if !metadata.is_file() {
        return Err(format!("{label}不存在。"));
    }
    if metadata.len() == 0 || metadata.len() > max_bytes {
        return Err(format!("{label}为空或超过大小限制。"));
    }
    fs::read_to_string(trimmed).map_err(error_string)
}

async fn derive_public_key_from_private_key(
    private_key_path: &str,
    passphrase: &str,
) -> Result<String, String> {
    let mut command = Command::new("ssh-keygen");
    prevent_tokio_process_window(&mut command);
    let output = command
        .args(["-y", "-f", private_key_path, "-P", passphrase])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(error_string)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(super) fn public_key_algorithm(public_key: &str) -> Option<&str> {
    public_key.split_whitespace().next().filter(|value| {
        value.starts_with("ssh-") || value.starts_with("ecdsa-") || value.starts_with("sk-")
    })
}

pub(super) fn public_key_fingerprint(public_key: &str) -> Option<String> {
    let mut parts = public_key.split_whitespace();
    let algorithm = parts.next()?;
    let encoded_key = parts.next()?;
    if !(algorithm.starts_with("ssh-")
        || algorithm.starts_with("ecdsa-")
        || algorithm.starts_with("sk-"))
    {
        return None;
    }
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded_key)
        .ok()?;
    let digest = Sha256::digest(key_bytes);
    let fingerprint = base64::engine::general_purpose::STANDARD
        .encode(digest)
        .trim_end_matches('=')
        .to_string();
    Some(format!("SHA256:{fingerprint}"))
}

pub(super) fn ensure_unique_ssh_key(
    existing: Option<&Value>,
    next_key: &Value,
) -> Result<(), String> {
    let next_private_key = next_key
        .get("privateKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let next_fingerprint = next_key
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    for key in existing.and_then(Value::as_array).into_iter().flatten() {
        if !next_private_key.is_empty()
            && key
                .get("privateKey")
                .and_then(Value::as_str)
                .is_some_and(|value| value.trim() == next_private_key)
        {
            return Err("这个 SSH 私钥已经在密钥库中。".to_string());
        }
        if !next_fingerprint.is_empty()
            && key
                .get("fingerprint")
                .and_then(Value::as_str)
                .is_some_and(|value| value.trim() == next_fingerprint)
        {
            return Err("这个 SSH 私钥已经在密钥库中。".to_string());
        }
    }
    Ok(())
}
