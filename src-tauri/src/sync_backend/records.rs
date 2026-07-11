use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::vault::{default_settings, read_store};
use crate::{escape_pointer, now, random_id, AppState};

fn item_identity(item: &Value) -> String {
    for key in ["id", "name", "address", "fingerprint", "scope", "url"] {
        if let Some(value) = item
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return format!("{key}:{value}");
        }
    }
    serde_json::to_string(item).unwrap_or_else(|_| random_id("item"))
}

pub(super) fn merge_objects(left: Value, right: Value) -> Value {
    let mut object = left.as_object().cloned().unwrap_or_default();
    if let Some(right_object) = right.as_object() {
        for (key, value) in right_object {
            object.insert(key.clone(), value.clone());
        }
    }
    Value::Object(object)
}

fn stable_json(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(stable_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        stable_json(object.get(key).unwrap_or(&Value::Null))
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
    }
}

fn hash_payload(payload: &Value) -> String {
    format!("{:x}", Sha256::digest(stable_json(payload).as_bytes()))
}

fn valid_datetime(value: Option<&str>, fallback: &str) -> String {
    value
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| fallback.to_string())
}

pub(super) fn compare_time(left: &str, right: &str) -> i64 {
    let left = chrono::DateTime::parse_from_rfc3339(left)
        .map(|value| value.timestamp_millis())
        .unwrap_or(0);
    let right = chrono::DateTime::parse_from_rfc3339(right)
        .map(|value| value.timestamp_millis())
        .unwrap_or(0);
    left - right
}

fn public_host_payload(host: &Value) -> Value {
    let mut payload = host.as_object().cloned().unwrap_or_default();
    payload.insert("password".to_string(), json!(""));
    payload.insert("passphrase".to_string(), json!(""));
    payload.insert("rootPassword".to_string(), json!(""));
    Value::Object(payload)
}

fn sync_settings_payload(settings: &Value) -> Value {
    // The WebDAV document is always encrypted with the user's sync passphrase
    // before upload, so AI credentials can travel with the provider settings.
    settings.clone()
}

fn public_proxy_payload(profile: &Value) -> Value {
    let mut payload = profile.as_object().cloned().unwrap_or_default();
    let mut config = payload
        .get("config")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    config.insert("password".to_string(), json!(""));
    payload.insert("config".to_string(), Value::Object(config));
    Value::Object(payload)
}

fn ssh_key_payload(key: &Value) -> Value {
    key.clone()
}

fn create_sync_record(
    id: String,
    record_type: &str,
    payload: Value,
    updated_at: String,
    device_id: &str,
) -> Value {
    json!({
        "id": id,
        "type": record_type,
        "updatedAt": updated_at,
        "deviceId": device_id,
        "hash": hash_payload(&payload),
        "payload": payload
    })
}

fn create_records_from_vault(vault: &Value, sync_state: &Value, now_value: &str) -> Value {
    let device_id = sync_state
        .get("deviceId")
        .and_then(Value::as_str)
        .unwrap_or("tauri-local");
    let mut records = Map::new();

    for host in vault
        .get("hosts")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let id = host.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let entity_id = format!("host:{id}");
        let payload = public_host_payload(host);
        records.insert(
            entity_id.clone(),
            create_sync_record(
                entity_id,
                "host",
                payload,
                valid_datetime(host.get("updatedAt").and_then(Value::as_str), now_value),
                device_id,
            ),
        );
    }

    for profile in vault
        .get("proxyProfiles")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let id = profile.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let entity_id = format!("proxyProfile:{id}");
        let payload = public_proxy_payload(profile);
        records.insert(
            entity_id.clone(),
            create_sync_record(
                entity_id,
                "proxyProfile",
                payload,
                valid_datetime(profile.get("updatedAt").and_then(Value::as_str), now_value),
                device_id,
            ),
        );
    }

    for key in vault
        .get("sshKeys")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let id = key.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        if key
            .get("privateKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            continue;
        }
        let entity_id = format!("sshKey:{id}");
        let payload = ssh_key_payload(key);
        records.insert(
            entity_id.clone(),
            create_sync_record(
                entity_id,
                "sshKey",
                payload,
                valid_datetime(key.get("updatedAt").and_then(Value::as_str), now_value),
                device_id,
            ),
        );
    }

    for known_host in vault
        .get("knownHosts")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let id = known_host
            .get("id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| item_identity(known_host));
        let entity_id = format!("knownHost:{id}");
        let payload = known_host.clone();
        let payload_hash = hash_payload(&payload);
        let previous = sync_state.pointer(&format!("/lastRecords/{}", escape_pointer(&entity_id)));
        let updated_at = if previous
            .and_then(|value| value.get("hash"))
            .and_then(Value::as_str)
            == Some(payload_hash.as_str())
        {
            previous
                .and_then(|value| value.get("updatedAt"))
                .and_then(Value::as_str)
                .or_else(|| sync_state.get("lastSyncAt").and_then(Value::as_str))
                .unwrap_or(now_value)
                .to_string()
        } else {
            now_value.to_string()
        };
        records.insert(
            entity_id.clone(),
            create_sync_record(entity_id, "knownHost", payload, updated_at, device_id),
        );
    }

    let settings = vault
        .get("settings")
        .cloned()
        .unwrap_or_else(default_settings);
    let settings_payload = sync_settings_payload(&settings);
    let settings_hash = hash_payload(&settings_payload);
    let settings_previous = sync_state.pointer("/lastRecords/settings:app");
    let settings_updated_at = if settings_previous
        .and_then(|value| value.get("hash"))
        .and_then(Value::as_str)
        == Some(settings_hash.as_str())
    {
        settings_previous
            .and_then(|value| value.get("updatedAt"))
            .and_then(Value::as_str)
            .or_else(|| sync_state.get("lastSyncAt").and_then(Value::as_str))
            .unwrap_or(now_value)
            .to_string()
    } else {
        now_value.to_string()
    };
    records.insert(
        "settings:app".to_string(),
        json!({
            "id": "settings:app",
            "type": "settings",
            "updatedAt": settings_updated_at,
            "deviceId": device_id,
            "hash": settings_hash,
            "payload": settings_payload
        }),
    );

    for collection in vault
        .get("browserBookmarks")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let scope = collection
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("");
        let scope_hash = hash_payload(&json!(scope));
        for bookmark in collection
            .get("bookmarks")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
        {
            let bookmark_id = bookmark.get("id").and_then(Value::as_str).unwrap_or("");
            if bookmark_id.is_empty() {
                continue;
            }
            let entity_id = format!("bookmark:{}:{}", &scope_hash[..16], bookmark_id);
            let payload = json!({ "scope": scope, "bookmark": bookmark });
            records.insert(
                entity_id.clone(),
                create_sync_record(
                    entity_id,
                    "bookmark",
                    payload,
                    valid_datetime(
                        bookmark
                            .get("updatedAt")
                            .and_then(Value::as_str)
                            .or_else(|| collection.get("updatedAt").and_then(Value::as_str)),
                        now_value,
                    ),
                    device_id,
                ),
            );
        }
    }

    Value::Object(records)
}

fn create_local_tombstones(local_records: &Value, sync_state: &Value, now_value: &str) -> Value {
    let mut tombstones = Map::new();
    if let Some(previous_tombstones) = sync_state.get("lastTombstones").and_then(Value::as_object) {
        for (id, tombstone) in previous_tombstones {
            if local_records.get(id).is_some() {
                continue;
            }
            tombstones.insert(id.clone(), tombstone.clone());
        }
    }
    if let Some(previous_records) = sync_state.get("lastRecords").and_then(Value::as_object) {
        for (id, previous) in previous_records {
            if id == "settings:app" || local_records.get(id).is_some() {
                continue;
            }
            tombstones.insert(
                id.clone(),
                json!({
                    "id": id,
                    "type": previous.get("type").and_then(Value::as_str).unwrap_or("host"),
                    "deletedAt": now_value,
                    "deviceId": sync_state.get("deviceId").and_then(Value::as_str).unwrap_or("tauri-local"),
                    "hash": previous.get("hash").and_then(Value::as_str).unwrap_or("")
                }),
            );
        }
    }
    Value::Object(tombstones)
}

pub(super) fn create_local_sync_inputs(
    state: &AppState,
    sync_state: &Value,
    now_value: &str,
) -> Result<Value, String> {
    let vault = read_store(state)?;
    let local_records = create_records_from_vault(&vault, sync_state, now_value);
    let local_tombstones = create_local_tombstones(&local_records, sync_state, now_value);
    Ok(json!({
        "localRecords": local_records,
        "localTombstones": local_tombstones,
        "footprint": create_sync_footprint(&local_records, &local_tombstones)
    }))
}

pub(super) fn create_sync_footprint(records: &Value, tombstones: &Value) -> String {
    let record_footprint = records
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(id, record)| {
                    (
                        id.clone(),
                        json!({
                            "type": record.get("type").and_then(Value::as_str).unwrap_or(""),
                            "hash": record.get("hash").and_then(Value::as_str).unwrap_or("")
                        }),
                    )
                })
                .collect::<Map<_, _>>()
        })
        .unwrap_or_default();
    let tombstone_footprint = tombstones
        .as_object()
        .map(|object| {
            object
                .iter()
                .map(|(id, tombstone)| {
                    (
                        id.clone(),
                        json!({
                            "type": tombstone.get("type").and_then(Value::as_str).unwrap_or(""),
                            "hash": tombstone.get("hash").and_then(Value::as_str).unwrap_or("")
                        }),
                    )
                })
                .collect::<Map<_, _>>()
        })
        .unwrap_or_default();
    stable_json(&json!({
        "records": Value::Object(record_footprint),
        "tombstones": Value::Object(tombstone_footprint)
    }))
}

pub(super) fn synced_content_type(value: &str) -> bool {
    matches!(
        value,
        "host" | "bookmark" | "proxyProfile" | "knownHost" | "sshKey"
    )
}

pub(super) fn count_records_by_type(records: &Value) -> Map<String, Value> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    if let Some(object) = records.as_object() {
        for record in object.values() {
            let record_type = record.get("type").and_then(Value::as_str).unwrap_or("");
            if synced_content_type(record_type) {
                *counts.entry(record_type.to_string()).or_insert(0) += 1;
            }
        }
    }
    counts
        .into_iter()
        .map(|(key, count)| (key, json!(count)))
        .collect()
}

pub(super) fn sum_counts(counts: &Map<String, Value>) -> i64 {
    counts.values().filter_map(Value::as_i64).sum()
}

pub(super) fn count_content_records(records: &Value) -> i64 {
    sum_counts(&count_records_by_type(records))
}

pub(super) fn conflict_summary(conflicts: &[Value]) -> Value {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for conflict in conflicts {
        let record_type = conflict.get("type").and_then(Value::as_str).unwrap_or("");
        if !record_type.is_empty() {
            *counts.entry(record_type.to_string()).or_insert(0) += 1;
        }
    }
    let mut items = counts
        .into_iter()
        .map(|(record_type, count)| json!({ "type": record_type, "count": count }))
        .collect::<Vec<_>>();
    items.sort_by_key(|item| {
        item.get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    });
    Value::Array(items)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync_summary(
    local_records: &Value,
    local_tombstones: &Value,
    remote_document: &Value,
    merged_document: &Value,
    uploaded: i64,
    downloaded: i64,
    deleted: i64,
    conflicts: &[Value],
) -> Value {
    let local_counts = count_records_by_type(local_records);
    let remote_counts =
        count_records_by_type(remote_document.get("records").unwrap_or(&Value::Null));
    let merged_counts =
        count_records_by_type(merged_document.get("records").unwrap_or(&Value::Null));
    let tombstones = merge_objects(
        merge_objects(
            remote_document
                .get("tombstones")
                .cloned()
                .unwrap_or_else(|| json!({})),
            local_tombstones.clone(),
        ),
        merged_document
            .get("tombstones")
            .cloned()
            .unwrap_or_else(|| json!({})),
    );
    let tombstone_counts = count_records_by_type(&tombstones);
    json!({
        "localRecords": sum_counts(&local_counts),
        "remoteRecords": sum_counts(&remote_counts),
        "mergedRecords": sum_counts(&merged_counts),
        "tombstones": sum_counts(&tombstone_counts),
        "uploaded": uploaded,
        "downloaded": downloaded,
        "deleted": deleted,
        "conflictCount": conflicts.len(),
        "conflictsByType": conflict_summary(conflicts),
        "recordsByType": Value::Object(merged_counts)
    })
}

pub(super) fn create_empty_remote_document() -> Value {
    json!({
        "format": "shelldesk-sync-webdav",
        "version": 1,
        "updatedAt": "",
        "devices": {},
        "records": {},
        "tombstones": {}
    })
}

pub(super) fn sanitize_remote_document(raw: Value) -> Value {
    if raw.get("format").and_then(Value::as_str) == Some("shelldesk-sync-webdav")
        && raw.get("version").and_then(Value::as_i64) == Some(1)
    {
        let mut document = create_empty_remote_document();
        document["updatedAt"] = raw.get("updatedAt").cloned().unwrap_or_else(|| json!(""));
        document["devices"] = raw.get("devices").cloned().unwrap_or_else(|| json!({}));
        document["records"] = raw.get("records").cloned().unwrap_or_else(|| json!({}));
        document["tombstones"] = raw.get("tombstones").cloned().unwrap_or_else(|| json!({}));
        return document;
    }
    if let Some(snapshot_value) = raw.get("snapshot") {
        let mut document = create_empty_remote_document();
        let sync_state = json!({ "deviceId": "remote", "lastRecords": {}, "lastTombstones": {} });
        document["updatedAt"] = raw
            .get("updatedAt")
            .cloned()
            .unwrap_or_else(|| json!(now()));
        document["records"] = create_records_from_vault(snapshot_value, &sync_state, &now());
        return document;
    }
    let mut document = create_empty_remote_document();
    let sync_state = json!({ "deviceId": "remote", "lastRecords": {}, "lastTombstones": {} });
    document["updatedAt"] = json!(now());
    document["records"] = create_records_from_vault(&raw, &sync_state, &now());
    document
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_sync_records_include_ssh_key_private_material() {
        let records = create_records_from_vault(
            &json!({
                "hosts": [],
                "sshKeys": [{
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
                }, {
                    "id": "key-public-only",
                    "name": "Public Only",
                    "source": "imported",
                    "algorithm": "SSH",
                    "fingerprint": "SHA256:public",
                    "publicKey": "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-02T00:00:00.000Z"
                }],
                "proxyProfiles": [],
                "knownHosts": [],
                "settings": default_settings(),
                "browserBookmarks": []
            }),
            &json!({ "deviceId": "device-1", "lastRecords": {}, "lastTombstones": {} }),
            "2026-01-03T00:00:00.000Z",
        );

        let record = records
            .pointer("/sshKey:key-1")
            .expect("ssh key record should be present");
        assert!(records.pointer("/sshKey:key-public-only").is_none());
        assert_eq!(record["type"], "sshKey");
        assert_eq!(
            record["payload"]["privateKey"],
            "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----"
        );
        assert_eq!(record["payload"]["passphrase"], "key-passphrase");
        assert_eq!(count_content_records(&records), 1);
    }

    #[test]
    fn local_sync_records_include_ai_provider_credentials() {
        let mut settings = default_settings();
        settings["aiProvider"] = json!("custom");
        settings["aiProviderName"] = json!("Company gateway");
        settings["aiApiBaseUrl"] = json!("https://ai.example.com/v1");
        settings["aiApiKey"] = json!("sync-test-api-key");
        settings["aiModel"] = json!("gateway-model");
        let records = create_records_from_vault(
            &json!({
                "hosts": [],
                "sshKeys": [],
                "proxyProfiles": [],
                "knownHosts": [],
                "settings": settings,
                "browserBookmarks": []
            }),
            &json!({ "deviceId": "device-1", "lastRecords": {}, "lastTombstones": {} }),
            "2026-01-03T00:00:00.000Z",
        );

        let settings = records
            .pointer("/settings:app/payload")
            .expect("settings record should be present");
        assert_eq!(settings["aiProvider"], "custom");
        assert_eq!(settings["aiProviderName"], "Company gateway");
        assert_eq!(settings["aiApiBaseUrl"], "https://ai.example.com/v1");
        assert_eq!(settings["aiApiKey"], "sync-test-api-key");
        assert_eq!(settings["aiModel"], "gateway-model");
    }
}
