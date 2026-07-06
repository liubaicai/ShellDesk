use serde_json::{json, Value};
use std::collections::HashMap;

use crate::vault::{
    default_settings, normalize_ssh_keys_for_import, read_store, to_snapshot, write_store,
};
use crate::{error_string, now, AppState};

fn records_array(document: &Value, record_type: &str) -> Vec<Value> {
    document
        .get("records")
        .and_then(Value::as_object)
        .map(|records| {
            records
                .values()
                .filter(|record| record.get("type").and_then(Value::as_str) == Some(record_type))
                .filter_map(|record| record.get("payload").cloned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn map_by_id(items: &[Value]) -> HashMap<String, Value> {
    items
        .iter()
        .filter_map(|item| Some((item.get("id")?.as_str()?.to_string(), item.clone())))
        .collect()
}

pub(super) fn apply_sync_document_to_vault(
    state: &AppState,
    document: &Value,
) -> Result<Value, String> {
    let _store_guard = state.store_lock.lock().map_err(error_string)?;
    let current = read_store(state)?;
    let current_hosts = current
        .get("hosts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let current_host_by_id = map_by_id(&current_hosts);
    let mut hosts = records_array(document, "host")
        .into_iter()
        .map(|mut host| {
            if let Some(current_host) = host
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| current_host_by_id.get(id))
            {
                if let Some(object) = host.as_object_mut() {
                    for key in ["password", "passphrase", "rootPassword"] {
                        object.insert(
                            key.to_string(),
                            current_host
                                .get(key)
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .into(),
                        );
                    }
                }
            }
            host
        })
        .collect::<Vec<_>>();
    hosts.sort_by_key(|item| {
        item.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    });

    let current_profiles = current
        .get("proxyProfiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let current_profile_by_id = map_by_id(&current_profiles);
    let mut proxy_profiles = records_array(document, "proxyProfile")
        .into_iter()
        .map(|mut profile| {
            if let Some(current_profile) = profile
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| current_profile_by_id.get(id))
            {
                let password = current_profile
                    .pointer("/config/password")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(object) = profile.as_object_mut() {
                    let mut config = object
                        .get("config")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    config.insert("password".to_string(), json!(password));
                    object.insert("config".to_string(), Value::Object(config));
                }
            }
            profile
        })
        .collect::<Vec<_>>();
    proxy_profiles.sort_by_key(|item| {
        item.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    });

    let raw_ssh_keys = records_array(document, "sshKey")
        .into_iter()
        .filter(|key| {
            !key.get("privateKey")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .is_empty()
        })
        .collect::<Vec<_>>();
    let mut ssh_keys = normalize_ssh_keys_for_import(&Value::Array(raw_ssh_keys))?;
    if let Some(keys) = ssh_keys.as_array_mut() {
        keys.sort_by_key(|item| {
            item.get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        });
    }

    let mut known_hosts = records_array(document, "knownHost");
    known_hosts.sort_by_key(|item| {
        format!(
            "{}:{}",
            item.get("hostname").and_then(Value::as_str).unwrap_or(""),
            item.get("port").and_then(Value::as_i64).unwrap_or(22)
        )
    });

    let mut settings = document
        .pointer("/records/settings:app/payload")
        .cloned()
        .unwrap_or_else(|| {
            current
                .get("settings")
                .cloned()
                .unwrap_or_else(default_settings)
        });
    if let Some(object) = settings.as_object_mut() {
        object.insert(
            "aiApiKey".to_string(),
            current
                .pointer("/settings/aiApiKey")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
        );
    }

    let mut bookmarks_by_scope: HashMap<String, Vec<Value>> = HashMap::new();
    for payload in records_array(document, "bookmark") {
        let scope = payload.get("scope").and_then(Value::as_str).unwrap_or("");
        if scope.is_empty() {
            continue;
        }
        if let Some(bookmark) = payload.get("bookmark") {
            bookmarks_by_scope
                .entry(scope.to_string())
                .or_default()
                .push(bookmark.clone());
        }
    }
    let mut browser_bookmarks = bookmarks_by_scope
        .into_iter()
        .map(|(scope, mut bookmarks)| {
            bookmarks.sort_by_key(|item| {
                item.get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            });
            json!({ "scope": scope, "bookmarks": bookmarks, "updatedAt": now() })
        })
        .collect::<Vec<_>>();
    browser_bookmarks.sort_by_key(|item| {
        item.get("scope")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    });

    let mut next = current.clone();
    next["hosts"] = json!(hosts);
    next["sshKeys"] = ssh_keys;
    next["settings"] = settings;
    next["proxyProfiles"] = json!(proxy_profiles);
    next["knownHosts"] = json!(known_hosts);
    next["browserBookmarks"] = json!(browser_bookmarks);
    write_store(state, &next)?;
    Ok(to_snapshot(state, next))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_state(name: &str) -> AppState {
        let dir = std::env::temp_dir().join(format!(
            "shelldesk-sync-apply-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        AppState::new(dir)
    }

    #[test]
    fn applies_synced_ssh_keys_to_vault() {
        let state = temp_state("ssh-keys");
        write_store(
            &state,
            &json!({
                "hosts": [],
                "sshKeys": [],
                "proxyProfiles": [],
                "knownHosts": [],
                "settings": default_settings(),
                "browserBookmarks": []
            }),
        )
        .unwrap();

        let snapshot = apply_sync_document_to_vault(
            &state,
            &json!({
                "records": {
                    "sshKey:key-1": {
                        "id": "sshKey:key-1",
                        "type": "sshKey",
                        "updatedAt": "2026-01-02T00:00:00.000Z",
                        "hash": "hash-1",
                        "payload": {
                            "id": "key-1",
                            "name": "Deploy",
                            "source": "imported",
                            "algorithm": "SSH",
                            "fingerprint": "SHA256:test",
                            "publicKey": "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7",
                            "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----",
                            "passphrase": "key-passphrase",
                            "createdAt": "2026-01-01T00:00:00.000Z",
                            "updatedAt": "2026-01-02T00:00:00.000Z"
                        }
                    }
                }
            }),
        )
        .unwrap();

        assert_eq!(snapshot["sshKeys"][0]["id"], "key-1");
        assert!(snapshot["sshKeys"][0].get("privateKey").is_none());

        let store = read_store(&state).unwrap();
        assert_eq!(
            store["sshKeys"][0]["privateKey"],
            "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----"
        );
        assert_eq!(store["sshKeys"][0]["passphrase"], "key-passphrase");

        let _ = fs::remove_dir_all(&state.data_dir);
    }
}
