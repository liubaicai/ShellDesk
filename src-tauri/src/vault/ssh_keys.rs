use base64::Engine;
use russh::keys::{
    key::safe_rng,
    load_secret_key,
    ssh_key::{private::RsaKeypair, LineEnding, PrivateKey},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs};
use tauri::Emitter;

use crate::{error_string, now, random_id, AppState};

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
        public_key =
            derive_public_key_from_private_key(&private_key_path, passphrase).unwrap_or_default();
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
        .unwrap_or(4096) as usize;
    let passphrase = payload
        .get("passphrase")
        .and_then(Value::as_str)
        .unwrap_or("");
    let key_id = random_id("key");
    let mut rng = safe_rng();
    let rsa_key = RsaKeypair::random(&mut rng, modulus_length).map_err(error_string)?;
    let mut private_key = PrivateKey::from(rsa_key);
    private_key.set_comment(name.clone());
    let private_key = if passphrase.is_empty() {
        private_key
    } else {
        private_key
            .encrypt(&mut rng, passphrase.as_bytes())
            .map_err(error_string)?
    };
    let private_key = private_key
        .to_openssh(LineEnding::LF)
        .map_err(error_string)?
        .to_string();
    let public_key = PrivateKey::from_openssh(&private_key)
        .map_err(error_string)?
        .public_key()
        .to_openssh()
        .map_err(error_string)?;
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

fn derive_public_key_from_private_key(
    private_key_path: &str,
    passphrase: &str,
) -> Result<String, String> {
    let private_key = load_secret_key(
        private_key_path,
        (!passphrase.is_empty()).then_some(passphrase),
    )
    .map_err(error_string)?;
    private_key.public_key().to_openssh().map_err(error_string)
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
