use serde_json::{json, Map, Value};
use std::collections::HashSet;

use crate::{escape_pointer, node_platform};

use super::records::{compare_time, count_records_by_type, sum_counts, synced_content_type};

fn conflict_name(record: &Value) -> String {
    let payload = record.get("payload").unwrap_or(&Value::Null);
    match record.get("type").and_then(Value::as_str).unwrap_or("") {
        "host" => payload
            .get("name")
            .or_else(|| payload.get("address"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| record.get("id").and_then(Value::as_str).unwrap_or(""))
            .to_string(),
        "bookmark" => payload
            .pointer("/bookmark/title")
            .or_else(|| payload.pointer("/bookmark/url"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| record.get("id").and_then(Value::as_str).unwrap_or(""))
            .to_string(),
        "proxyProfile" => payload
            .get("name")
            .or_else(|| payload.pointer("/config/host"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| record.get("id").and_then(Value::as_str).unwrap_or(""))
            .to_string(),
        "sshKey" => payload
            .get("name")
            .or_else(|| payload.get("fingerprint"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| record.get("id").and_then(Value::as_str).unwrap_or(""))
            .to_string(),
        "knownHost" => format!(
            "{}:{}",
            payload
                .get("hostname")
                .and_then(Value::as_str)
                .unwrap_or(""),
            payload.get("port").and_then(Value::as_i64).unwrap_or(22)
        ),
        _ => "应用设置".to_string(),
    }
}

fn add_sync_conflict(conflicts: &mut Vec<Value>, record: &Value, reason: &str) {
    conflicts.push(json!({
        "type": record.get("type").and_then(Value::as_str).unwrap_or("host"),
        "id": record.get("id").and_then(Value::as_str).unwrap_or(""),
        "name": conflict_name(record),
        "reason": reason
    }));
}

pub(super) fn tombstones_for_records(records: &Value, state: &Value, now_value: &str) -> Value {
    let mut tombstones = Map::new();
    if let Some(object) = records.as_object() {
        for (id, record) in object {
            let record_type = record.get("type").and_then(Value::as_str).unwrap_or("");
            if !synced_content_type(record_type) {
                continue;
            }
            tombstones.insert(
                id.clone(),
                json!({
                    "id": id,
                    "type": record_type,
                    "deletedAt": now_value,
                    "deviceId": state.get("deviceId").and_then(Value::as_str).unwrap_or("tauri-local"),
                    "hash": record.get("hash").and_then(Value::as_str).unwrap_or("")
                }),
            );
        }
    }
    Value::Object(tombstones)
}

pub(super) fn merge_sync_documents(
    remote_document: &Value,
    local_records: &Value,
    local_tombstones: &Value,
    state: &Value,
    now_value: &str,
    conflict_resolution: &str,
) -> Value {
    let mut merged_records = remote_document
        .get("records")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut merged_tombstones = remote_document
        .get("tombstones")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let keep_local = conflict_resolution == "local";
    let keep_remote = conflict_resolution == "remote";
    let mut uploaded = 0;
    let mut downloaded = 0;
    let mut deleted = 0;
    let mut conflicts = Vec::new();

    if let Some(tombstones) = local_tombstones.as_object() {
        for (id, tombstone) in tombstones {
            let remote_record = merged_records.get(id).cloned();
            if remote_record.is_none()
                || remote_record
                    .as_ref()
                    .and_then(|record| record.get("hash"))
                    .and_then(Value::as_str)
                    == tombstone.get("hash").and_then(Value::as_str)
                || compare_time(
                    tombstone
                        .get("deletedAt")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    remote_record
                        .as_ref()
                        .and_then(|record| record.get("updatedAt"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ) >= 0
            {
                merged_records.remove(id);
                merged_tombstones.insert(id.clone(), tombstone.clone());
                uploaded += 1;
                deleted += 1;
                continue;
            }
            if keep_local {
                if let Some(record) = remote_record.as_ref() {
                    add_sync_conflict(
                        &mut conflicts,
                        record,
                        "本机删除与远端修改冲突，已按选择保留本地：云端对应数据将删除。",
                    );
                }
                merged_records.remove(id);
                merged_tombstones.insert(id.clone(), tombstone.clone());
                uploaded += 1;
                deleted += 1;
            } else if let Some(record) = remote_record.as_ref() {
                add_sync_conflict(
                    &mut conflicts,
                    record,
                    if keep_remote {
                        "本机删除与远端修改冲突，已按选择保留云端：云端版本已恢复到本地。"
                    } else {
                        "本机删除与远端修改冲突，请选择保留本地或保留云端。"
                    },
                );
                if keep_remote {
                    downloaded += 1;
                }
            }
        }
    }

    if let Some(records) = local_records.as_object() {
        for (id, local_record) in records {
            if let Some(remote_tombstone) = merged_tombstones.get(id).cloned() {
                if compare_time(
                    remote_tombstone
                        .get("deletedAt")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    local_record
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ) >= 0
                {
                    let previous = state.pointer(&format!("/lastRecords/{}", escape_pointer(id)));
                    let local_changed = previous
                        .and_then(|value| value.get("hash"))
                        .and_then(Value::as_str)
                        .is_some_and(|hash| {
                            Some(hash) != local_record.get("hash").and_then(Value::as_str)
                        });
                    if !local_changed || keep_remote {
                        if keep_remote && local_changed {
                            add_sync_conflict(
                                &mut conflicts,
                                local_record,
                                "远端删除与本机修改冲突，已按选择保留云端：本机对应数据将删除。",
                            );
                        }
                        merged_records.remove(id);
                        downloaded += 1;
                        deleted += 1;
                        continue;
                    }
                    if keep_local {
                        add_sync_conflict(
                            &mut conflicts,
                            local_record,
                            "远端删除与本机修改冲突，已按选择保留本地：本机版本已覆盖到云端。",
                        );
                        merged_tombstones.remove(id);
                        merged_records.insert(id.clone(), local_record.clone());
                        uploaded += 1;
                        continue;
                    }
                    add_sync_conflict(
                        &mut conflicts,
                        local_record,
                        "远端删除与本机修改冲突，请选择保留本地或保留云端。",
                    );
                    continue;
                }
            }

            let remote_record = merged_records.get(id).cloned();
            if remote_record.is_none() {
                merged_records.insert(id.clone(), local_record.clone());
                uploaded += 1;
                continue;
            }
            let remote_record = remote_record.unwrap();
            if remote_record.get("hash").and_then(Value::as_str)
                == local_record.get("hash").and_then(Value::as_str)
            {
                if compare_time(
                    local_record
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    remote_record
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ) > 0
                {
                    merged_records.insert(id.clone(), local_record.clone());
                }
                continue;
            }
            let previous = state.pointer(&format!("/lastRecords/{}", escape_pointer(id)));
            let local_changed = previous
                .and_then(|value| value.get("hash"))
                .and_then(Value::as_str)
                .is_some_and(|hash| Some(hash) != local_record.get("hash").and_then(Value::as_str));
            let remote_changed = previous
                .and_then(|value| value.get("hash"))
                .and_then(Value::as_str)
                .is_some_and(|hash| {
                    Some(hash) != remote_record.get("hash").and_then(Value::as_str)
                });
            if previous.is_some() && local_changed && remote_changed {
                let label = if local_record.get("type").and_then(Value::as_str) == Some("settings")
                {
                    "设置"
                } else {
                    "同一条数据"
                };
                if keep_remote {
                    add_sync_conflict(
                        &mut conflicts,
                        local_record,
                        &format!("{label}在本机和远端都被修改，已按选择保留云端版本。"),
                    );
                    downloaded += 1;
                } else if keep_local {
                    add_sync_conflict(
                        &mut conflicts,
                        local_record,
                        &format!("{label}在本机和远端都被修改，已按选择保留本地版本。"),
                    );
                    merged_records.insert(id.clone(), local_record.clone());
                    uploaded += 1;
                } else {
                    add_sync_conflict(
                        &mut conflicts,
                        local_record,
                        &format!("{label}在本机和远端都被修改，请选择保留本地或保留云端。"),
                    );
                }
                continue;
            }
            if compare_time(
                local_record
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                remote_record
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ) >= 0
            {
                merged_records.insert(id.clone(), local_record.clone());
                uploaded += 1;
            } else {
                downloaded += 1;
            }
        }
    }

    let mut devices = remote_document
        .get("devices")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let device_id = state
        .get("deviceId")
        .and_then(Value::as_str)
        .unwrap_or("tauri-local");
    devices.insert(
        device_id.to_string(),
        json!({
            "name": std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "ShellDesk".to_string()),
            "platform": node_platform(),
            "arch": std::env::consts::ARCH,
            "lastSeenAt": now_value
        }),
    );
    json!({
        "document": {
            "format": "shelldesk-sync-webdav",
            "version": 1,
            "updatedAt": now_value,
            "devices": Value::Object(devices),
            "records": Value::Object(merged_records),
            "tombstones": Value::Object(merged_tombstones)
        },
        "conflicts": conflicts,
        "uploaded": uploaded,
        "downloaded": downloaded,
        "deleted": deleted
    })
}

pub(super) fn detect_suspicious_shrink(
    state: &Value,
    local_records: &Value,
    remote_document: &Value,
    merged_document: &Value,
) -> Option<Value> {
    let previous_counts = count_records_by_type(state.get("lastRecords").unwrap_or(&Value::Null));
    let local_counts = count_records_by_type(local_records);
    let remote_counts =
        count_records_by_type(remote_document.get("records").unwrap_or(&Value::Null));
    let merged_counts =
        count_records_by_type(merged_document.get("records").unwrap_or(&Value::Null));
    let previous = sum_counts(&previous_counts);
    let local = sum_counts(&local_counts);
    let remote = sum_counts(&remote_counts);
    let merged = sum_counts(&merged_counts);
    let baseline = previous.max(local).max(remote);
    let lost = baseline - merged;
    if baseline <= 0 || lost <= 0 {
        return None;
    }
    let suspicious = lost >= 10 || (lost >= 3 && merged <= baseline / 2);
    if !suspicious {
        return None;
    }
    let mut lost_by_type = Map::new();
    let mut keys = HashSet::new();
    for counts in [
        &previous_counts,
        &local_counts,
        &remote_counts,
        &merged_counts,
    ] {
        for key in counts.keys() {
            keys.insert(key.clone());
        }
    }
    for key in keys {
        let baseline_for_type = previous_counts
            .get(&key)
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(local_counts.get(&key).and_then(Value::as_i64).unwrap_or(0))
            .max(remote_counts.get(&key).and_then(Value::as_i64).unwrap_or(0));
        let lost_for_type =
            baseline_for_type - merged_counts.get(&key).and_then(Value::as_i64).unwrap_or(0);
        if lost_for_type > 0 {
            lost_by_type.insert(key, json!(lost_for_type));
        }
    }
    Some(json!({
        "baselineRecords": baseline,
        "mergedRecords": merged,
        "lostRecords": lost,
        "previousRecords": previous,
        "localRecords": local,
        "remoteRecords": remote,
        "lostByType": Value::Object(lost_by_type)
    }))
}

pub(super) fn create_sync_state_from_document(
    document: &Value,
    device_id: &str,
    etag: &str,
    synced_at: &str,
) -> Value {
    let mut last_records = Map::new();
    if let Some(records) = document.get("records").and_then(Value::as_object) {
        for (id, record) in records {
            last_records.insert(
                id.clone(),
                json!({
                    "type": record.get("type").and_then(Value::as_str).unwrap_or("host"),
                    "hash": record.get("hash").and_then(Value::as_str).unwrap_or(""),
                    "updatedAt": record.get("updatedAt").and_then(Value::as_str).unwrap_or("")
                }),
            );
        }
    }
    let mut last_tombstones = Map::new();
    if let Some(tombstones) = document.get("tombstones").and_then(Value::as_object) {
        for (id, tombstone) in tombstones {
            last_tombstones.insert(id.clone(), tombstone.clone());
        }
    }
    json!({
        "deviceId": device_id,
        "lastRecords": Value::Object(last_records),
        "lastTombstones": Value::Object(last_tombstones),
        "lastSyncAt": synced_at,
        "lastRemoteEtag": etag
    })
}
