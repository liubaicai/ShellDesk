use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tauri::{Emitter, Manager};
use tokio::time;

use crate::{
    error_string, now, random_id, read_json_file, vault_storage::decrypt_electron_safe_storage,
    write_json_file, AppState,
};

#[path = "sync_backend/apply.rs"]
mod apply;
#[path = "sync_backend/crypto.rs"]
mod crypto;
#[path = "sync_backend/merge.rs"]
mod merge;
#[path = "sync_backend/records.rs"]
mod records;
#[path = "sync_backend/webdav.rs"]
mod webdav;

use apply::apply_sync_document_to_vault;
use crypto::{decrypt_remote_document, encrypt_remote_document};
use merge::{
    create_sync_state_from_document, detect_suspicious_shrink, merge_sync_documents,
    tombstones_for_records,
};
#[cfg(test)]
use records::create_sync_footprint;
use records::{
    conflict_summary, count_content_records, count_records_by_type, create_empty_remote_document,
    create_local_sync_inputs, merge_objects, sanitize_remote_document, sync_summary,
};
use webdav::{
    ensure_webdav_directories, normalize_webdav_remote_path, normalize_webdav_url, webdav_request,
    webdav_response_error, webdav_test_path, webdav_write_precondition_headers,
};

fn sync_path(state: &AppState) -> PathBuf {
    state.data_dir.join("sync.json")
}

pub(crate) fn sync_config(state: &AppState) -> Result<Value, String> {
    Ok(sync_public_config(&read_sync_store(state)?))
}

fn default_sync_store() -> Value {
    json!({
        "format": "shelldesk-sync-settings",
        "version": 1,
        "updatedAt": now(),
        "config": {
            "enabled": false,
            "provider": "webdav",
            "webdavUrl": "",
            "webdavUsername": "",
            "webdavRemotePath": "/ShellDesk/shelldesk-sync.json",
            "ignoreCertificateErrors": false,
            "intervalMinutes": 15,
            "syncOnStartup": true,
            "lastSyncAt": "",
            "lastSyncStatus": "idle",
            "lastSyncMessage": "尚未同步",
            "lastConflictCount": 0
        },
        "secrets": {
            "webdavPassword": "",
            "syncPassphrase": ""
        },
        "state": {
            "deviceId": random_id("device"),
            "lastRecords": {},
            "lastTombstones": {},
            "lastSyncAt": "",
            "lastRemoteEtag": ""
        }
    })
}

fn read_sync_store(state: &AppState) -> Result<Value, String> {
    let raw = read_json_file(&sync_path(state), json!({}))?;
    if raw
        .get("format")
        .and_then(Value::as_str)
        .is_some_and(|value| value == "shelldesk-sync-settings")
    {
        if raw
            .get("protected")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return normalize_electron_protected_sync_store(raw);
        }
        return Ok(normalize_sync_store(raw));
    }
    Ok(normalize_legacy_sync_store(raw))
}

fn normalize_electron_protected_sync_store(mut raw: Value) -> Result<Value, String> {
    let ciphertext = raw
        .get("ciphertext")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "同步设置密文缺失，请重新保存同步设置。".to_string())?;
    let plaintext = decrypt_electron_safe_storage(ciphertext)?;
    let secrets: Value = serde_json::from_str(&plaintext)
        .map_err(|_| "同步设置密文内容无效，请重新保存同步设置。".to_string())?;
    raw["protected"] = json!(false);
    raw["secrets"] = normalize_sync_secrets(&secrets);
    if let Some(object) = raw.as_object_mut() {
        object.remove("ciphertext");
    }
    Ok(normalize_sync_store(raw))
}

fn normalize_sync_secrets(raw: &Value) -> Value {
    json!({
        "webdavPassword": raw.get("webdavPassword").and_then(Value::as_str).unwrap_or(""),
        "syncPassphrase": raw.get("syncPassphrase").and_then(Value::as_str).unwrap_or("")
    })
}

fn normalize_legacy_sync_store(raw: Value) -> Value {
    let defaults = default_sync_store();
    let config = normalize_sync_config(&raw, defaults.get("config").unwrap());
    let state = json!({
        "deviceId": raw.get("deviceId").and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or_else(|| {
            defaults.pointer("/state/deviceId").and_then(Value::as_str).unwrap_or("tauri-local")
        }),
        "lastRecords": raw.get("lastRecords").cloned().unwrap_or_else(|| json!({})),
        "lastTombstones": raw.get("lastTombstones").cloned().unwrap_or_else(|| json!({})),
        "lastSyncAt": raw.get("lastSyncAt").and_then(Value::as_str).unwrap_or(""),
        "lastRemoteEtag": raw.get("lastRemoteEtag").and_then(Value::as_str).unwrap_or("")
    });
    json!({
        "format": "shelldesk-sync-settings",
        "version": 1,
        "updatedAt": now(),
        "config": config,
        "secrets": {
            "webdavPassword": raw.get("webdavPassword").and_then(Value::as_str).unwrap_or(""),
            "syncPassphrase": raw.get("syncPassphrase").and_then(Value::as_str).unwrap_or("")
        },
        "state": state
    })
}

fn normalize_sync_store(raw: Value) -> Value {
    let defaults = default_sync_store();
    let config = normalize_sync_config(
        raw.get("config").unwrap_or(&Value::Null),
        defaults.get("config").unwrap(),
    );
    let state_defaults = defaults.get("state").unwrap();
    let state = json!({
        "deviceId": raw.pointer("/state/deviceId").and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or_else(|| state_defaults.get("deviceId").and_then(Value::as_str).unwrap_or("tauri-local")),
        "lastRecords": raw.pointer("/state/lastRecords").cloned().unwrap_or_else(|| json!({})),
        "lastTombstones": raw.pointer("/state/lastTombstones").cloned().unwrap_or_else(|| json!({})),
        "lastSyncAt": raw.pointer("/state/lastSyncAt").and_then(Value::as_str).unwrap_or(""),
        "lastRemoteEtag": raw.pointer("/state/lastRemoteEtag").and_then(Value::as_str).unwrap_or("")
    });
    json!({
        "format": "shelldesk-sync-settings",
        "version": 1,
        "updatedAt": raw.get("updatedAt").and_then(Value::as_str).unwrap_or(""),
        "config": config,
        "secrets": {
            "webdavPassword": raw.pointer("/secrets/webdavPassword").and_then(Value::as_str).unwrap_or(""),
            "syncPassphrase": raw.pointer("/secrets/syncPassphrase").and_then(Value::as_str).unwrap_or("")
        },
        "state": state
    })
}

fn normalize_sync_config(raw: &Value, fallback: &Value) -> Value {
    let enabled = raw
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            fallback
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
    let interval = raw
        .get("intervalMinutes")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| {
            fallback
                .get("intervalMinutes")
                .and_then(Value::as_i64)
                .unwrap_or(15)
        })
        .clamp(5, 1440);
    json!({
        "enabled": enabled,
        "provider": "webdav",
        "webdavUrl": normalize_webdav_url(raw.get("webdavUrl").and_then(Value::as_str).or_else(|| fallback.get("webdavUrl").and_then(Value::as_str)).unwrap_or(""), enabled).unwrap_or_default(),
        "webdavUsername": raw.get("webdavUsername").and_then(Value::as_str).or_else(|| fallback.get("webdavUsername").and_then(Value::as_str)).unwrap_or(""),
        "webdavRemotePath": normalize_webdav_remote_path(raw.get("webdavRemotePath").and_then(Value::as_str).or_else(|| fallback.get("webdavRemotePath").and_then(Value::as_str)).unwrap_or("/ShellDesk/shelldesk-sync.json")).unwrap_or_else(|_| "/ShellDesk/shelldesk-sync.json".to_string()),
        "ignoreCertificateErrors": raw.get("ignoreCertificateErrors").and_then(Value::as_bool).unwrap_or_else(|| fallback.get("ignoreCertificateErrors").and_then(Value::as_bool).unwrap_or(false)),
        "intervalMinutes": interval,
        "syncOnStartup": raw.get("syncOnStartup").and_then(Value::as_bool).unwrap_or_else(|| fallback.get("syncOnStartup").and_then(Value::as_bool).unwrap_or(true)),
        "lastSyncAt": raw.get("lastSyncAt").and_then(Value::as_str).or_else(|| fallback.get("lastSyncAt").and_then(Value::as_str)).unwrap_or(""),
        "lastSyncStatus": normalize_sync_status(raw.get("lastSyncStatus").and_then(Value::as_str).or_else(|| fallback.get("lastSyncStatus").and_then(Value::as_str)).unwrap_or("idle")),
        "lastSyncMessage": raw.get("lastSyncMessage").and_then(Value::as_str).or_else(|| fallback.get("lastSyncMessage").and_then(Value::as_str)).unwrap_or("尚未同步"),
        "lastConflictCount": raw.get("lastConflictCount").and_then(Value::as_i64).or_else(|| fallback.get("lastConflictCount").and_then(Value::as_i64)).unwrap_or(0).clamp(0, 10000)
    })
}

fn normalize_sync_status(value: &str) -> &str {
    match value {
        "success" | "warning" | "error" => value,
        _ => "idle",
    }
}

fn write_sync_store(state: &AppState, mut store: Value) -> Result<Value, String> {
    store["updatedAt"] = json!(now());
    write_json_file(&sync_path(state), &store)?;
    Ok(store)
}

fn sync_public_config(store: &Value) -> Value {
    let config = store.get("config").cloned().unwrap_or_else(|| json!({}));
    let secrets = store.get("secrets").cloned().unwrap_or_else(|| json!({}));
    let state = store.get("state").cloned().unwrap_or_else(|| json!({}));
    json!({
        "enabled": config.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "provider": "webdav",
        "webdavUrl": config.get("webdavUrl").and_then(Value::as_str).unwrap_or(""),
        "webdavUsername": config.get("webdavUsername").and_then(Value::as_str).unwrap_or(""),
        "webdavRemotePath": config.get("webdavRemotePath").and_then(Value::as_str).unwrap_or("/ShellDesk/shelldesk-sync.json"),
        "ignoreCertificateErrors": config.get("ignoreCertificateErrors").and_then(Value::as_bool).unwrap_or(false),
        "intervalMinutes": config.get("intervalMinutes").and_then(Value::as_i64).unwrap_or(15),
        "syncOnStartup": config.get("syncOnStartup").and_then(Value::as_bool).unwrap_or(true),
        "lastSyncAt": config.get("lastSyncAt").and_then(Value::as_str).unwrap_or(""),
        "lastSyncStatus": config.get("lastSyncStatus").and_then(Value::as_str).unwrap_or("idle"),
        "lastSyncMessage": config.get("lastSyncMessage").and_then(Value::as_str).unwrap_or(""),
        "lastConflictCount": config.get("lastConflictCount").and_then(Value::as_i64).unwrap_or(0),
        "deviceId": state.get("deviceId").and_then(Value::as_str).unwrap_or("tauri-local"),
        "hasWebDavPassword": secrets.get("webdavPassword").and_then(Value::as_str).is_some_and(|value| !value.is_empty()),
        "hasSyncPassphrase": secrets.get("syncPassphrase").and_then(Value::as_str).is_some_and(|value| !value.is_empty())
    })
}

fn read_incoming_secret(value: Option<&Value>, previous: &str) -> String {
    match value.and_then(Value::as_str) {
        Some(text) if !text.is_empty() && text != "••••••••" => text.to_string(),
        _ => previous.to_string(),
    }
}

pub(crate) fn save_sync_config(state: &AppState, incoming: Value) -> Result<Value, String> {
    let current = read_sync_store(state)?;
    let fallback_config = current.get("config").cloned().unwrap_or_else(|| json!({}));
    let incoming_object = incoming
        .as_object()
        .ok_or_else(|| "同步设置无效。".to_string())?;
    let next_config = normalize_sync_config(&incoming, &fallback_config);
    let current_secrets = current.get("secrets").cloned().unwrap_or_else(|| json!({}));
    let next_secrets = json!({
        "webdavPassword": read_incoming_secret(incoming_object.get("webdavPassword"), current_secrets.get("webdavPassword").and_then(Value::as_str).unwrap_or("")),
        "syncPassphrase": read_incoming_secret(incoming_object.get("syncPassphrase"), current_secrets.get("syncPassphrase").and_then(Value::as_str).unwrap_or(""))
    });
    if next_config
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        ensure_operational_sync_settings(&next_config, &next_secrets, true)?;
    }
    let next = json!({
        "format": "shelldesk-sync-settings",
        "version": 1,
        "config": next_config,
        "secrets": next_secrets,
        "state": current.get("state").cloned().unwrap_or_else(|| default_sync_store().get("state").cloned().unwrap_or_else(|| json!({})))
    });
    let saved = write_sync_store(state, next)?;
    Ok(sync_public_config(&saved))
}

fn next_sync_schedule_generation(state: &AppState) -> u64 {
    let mut generation = state.sync_schedule_generation.lock().unwrap();
    *generation = generation.saturating_add(1);
    *generation
}

fn current_sync_schedule_generation(state: &AppState) -> u64 {
    *state.sync_schedule_generation.lock().unwrap()
}

pub(crate) fn reload_sync_schedule(state: &AppState, app: &tauri::AppHandle) {
    let generation = next_sync_schedule_generation(state);
    let store = match read_sync_store(state) {
        Ok(store) => store,
        Err(_) => return,
    };
    let config = store.get("config").cloned().unwrap_or_else(|| json!({}));
    if !config
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return;
    }
    let interval_minutes = config
        .get("intervalMinutes")
        .and_then(Value::as_i64)
        .unwrap_or(15)
        .clamp(5, 1440) as u64;
    let sync_on_startup = config
        .get("syncOnStartup")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let state = state.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if sync_on_startup {
            time::sleep(Duration::from_secs(12)).await;
            if current_sync_schedule_generation(&state) != generation {
                return;
            }
            run_scheduled_webdav_sync(&state, &app).await;
        }
        loop {
            time::sleep(Duration::from_secs(interval_minutes * 60)).await;
            if current_sync_schedule_generation(&state) != generation {
                return;
            }
            run_scheduled_webdav_sync(&state, &app).await;
        }
    });
}

async fn run_scheduled_webdav_sync(state: &AppState, app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(error) = run_webdav_sync(state, &window, vec![]).await {
        let _ = update_sync_status(state, "error", &error);
        let result = sync_config(state).map(|config| {
            json!({
                "ok": false,
                "needsResolution": false,
                "needsEmptyVaultResolution": false,
                "needsShrinkConfirmation": false,
                "resolution": "",
                "emptyVaultResolution": "",
                "shrinkResolution": "",
                "syncedAt": "",
                "uploaded": 0,
                "downloaded": 0,
                "deleted": 0,
                "conflictCount": 0,
                "conflicts": [],
                "conflictSummary": [],
                "summary": {
                    "localRecords": 0,
                    "remoteRecords": 0,
                    "mergedRecords": 0,
                    "tombstones": 0,
                    "uploaded": 0,
                    "downloaded": 0,
                    "deleted": 0,
                    "conflictCount": 0,
                    "conflictsByType": [],
                    "recordsByType": {}
                },
                "emptyVaultSummary": null,
                "shrinkSummary": null,
                "snapshot": null,
                "config": config,
                "message": error
            })
        });
        if let Ok(result) = result {
            let _ = window.emit("sync:changed", result);
        }
    }
}

pub(crate) async fn test_webdav(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let store = operational_sync_store(state, args.first().cloned(), false)?;
    let config = store.get("config").cloned().unwrap_or_else(|| json!({}));
    let secrets = store.get("secrets").cloned().unwrap_or_else(|| json!({}));
    ensure_webdav_directories(&config, &secrets).await?;
    let test_path = webdav_test_path(&config);
    let content = format!("ShellDesk WebDAV test {}", now());
    let put = webdav_request(
        &config,
        &secrets,
        "PUT",
        &test_path,
        Some(content.clone()),
        Some("text/plain; charset=utf-8"),
        &[],
    )
    .await?;
    if !matches!(put.status().as_u16(), 200 | 201 | 204) {
        return Err(webdav_response_error(put, "写入 WebDAV 测试文件").await);
    }
    let get = webdav_request(&config, &secrets, "GET", &test_path, None, None, &[]).await?;
    if !get.status().is_success() {
        return Err(webdav_response_error(get, "读取 WebDAV 测试文件").await);
    }
    let read_back = get.text().await.map_err(error_string)?;
    if read_back != content {
        return Err("WebDAV 测试文件读写内容不一致。".to_string());
    }
    let delete = webdav_request(&config, &secrets, "DELETE", &test_path, None, None, &[]).await?;
    let cleanup_warning = if delete.status().is_success() || delete.status().as_u16() == 404 {
        String::new()
    } else {
        format!("读写测试通过，但临时测试文件删除失败：{}", delete.status())
    };
    let message = if cleanup_warning.is_empty() {
        "WebDAV 连接测试通过，远程目录具备读写权限。".to_string()
    } else {
        cleanup_warning
    };
    update_sync_status(
        state,
        if message.starts_with("读写测试通过") {
            "warning"
        } else {
            "success"
        },
        &message,
    )?;
    Ok(json!({ "ok": true, "checkedAt": now(), "message": message }))
}

pub(crate) async fn run_webdav_sync<R, W>(
    state: &AppState,
    window: &W,
    args: Vec<Value>,
) -> Result<Value, String>
where
    R: tauri::Runtime,
    W: Emitter<R>,
{
    let incoming = args.first().cloned();
    let mut store = operational_sync_store(state, incoming.clone(), true)?;
    let config = store.get("config").cloned().unwrap_or_else(|| json!({}));
    let secrets = store.get("secrets").cloned().unwrap_or_else(|| json!({}));
    ensure_webdav_directories(&config, &secrets).await?;
    let conflict_resolution = read_resolution(
        incoming.as_ref(),
        "conflictResolution",
        &["local", "remote"],
    );
    let empty_vault_resolution = read_resolution(
        incoming.as_ref(),
        "emptyVaultResolution",
        &["restoreRemote", "keepEmpty"],
    );
    let shrink_resolution = read_resolution(incoming.as_ref(), "shrinkResolution", &["allow"]);
    let max_precondition_retries = 1;
    let max_local_refreshes = 2;
    let mut precondition_retries = 0;
    let mut local_refreshes = 0;
    let mut remote_override: Option<Value> = None;

    loop {
        if precondition_retries > max_precondition_retries || local_refreshes > max_local_refreshes
        {
            return Err("同步未完成。".to_string());
        }

        let now_value = now();
        let local = create_local_sync_inputs(
            state,
            store.get("state").unwrap_or(&Value::Null),
            &now_value,
        )?;
        let remote = if let Some(remote) = remote_override.take() {
            remote
        } else {
            read_remote_sync_document(&config, &secrets).await?
        };
        let mut effective_local_records = local
            .get("localRecords")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut effective_local_tombstones = local
            .get("localTombstones")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let local_count = count_content_records(&effective_local_records);
        let remote_document = remote
            .get("document")
            .cloned()
            .unwrap_or_else(create_empty_remote_document);
        let remote_count =
            count_content_records(remote_document.get("records").unwrap_or(&Value::Null));

        if empty_vault_resolution.is_empty() && local_count == 0 && remote_count > 0 {
            let result = pending_empty_vault_result(state, &mut store, &local, &remote_document)?;
            let _ = window.emit("sync:changed", result.clone());
            return Ok(result);
        }

        if empty_vault_resolution == "restoreRemote" && local_count == 0 && remote_count > 0 {
            if remote_document.pointer("/records/settings:app").is_some() {
                if let Some(object) = effective_local_records.as_object_mut() {
                    object.remove("settings:app");
                }
            }
            effective_local_tombstones = json!({});
        } else if empty_vault_resolution == "keepEmpty" && local_count == 0 && remote_count > 0 {
            effective_local_tombstones = merge_objects(
                effective_local_tombstones,
                tombstones_for_records(
                    remote_document.get("records").unwrap_or(&Value::Null),
                    store.get("state").unwrap_or(&Value::Null),
                    &now_value,
                ),
            );
        }

        let merged = merge_sync_documents(
            &remote_document,
            &effective_local_records,
            &effective_local_tombstones,
            store.get("state").unwrap_or(&Value::Null),
            &now_value,
            &conflict_resolution,
        );
        let merged_document = merged
            .get("document")
            .cloned()
            .unwrap_or_else(create_empty_remote_document);
        let conflicts = merged
            .get("conflicts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if !conflicts.is_empty() && conflict_resolution.is_empty() {
            let result =
                pending_conflict_result(state, &mut store, &local, &remote_document, &merged)?;
            let _ = window.emit("sync:changed", result.clone());
            return Ok(result);
        }

        let shrink = detect_suspicious_shrink(
            store.get("state").unwrap_or(&Value::Null),
            &effective_local_records,
            &remote_document,
            &merged_document,
        );
        if shrink.is_some() && shrink_resolution != "allow" && empty_vault_resolution != "keepEmpty"
        {
            let result = pending_shrink_result(
                state,
                &mut store,
                &local,
                &remote_document,
                &merged,
                shrink,
            )?;
            let _ = window.emit("sync:changed", result.clone());
            return Ok(result);
        }

        let write_result = write_remote_sync_document(
            &config,
            &secrets,
            &merged_document,
            remote.get("etag").and_then(Value::as_str).unwrap_or(""),
            remote
                .get("exists")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
        .await?;
        if write_result
            .get("preconditionFailed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            if precondition_retries < max_precondition_retries {
                precondition_retries += 1;
                continue;
            }
            return Err("远端同步文件刚刚被其他设备更新，请稍后重试。".to_string());
        }

        let latest_local = create_local_sync_inputs(
            state,
            store.get("state").unwrap_or(&Value::Null),
            &now_value,
        )?;
        if latest_local.get("footprint") != local.get("footprint") {
            if local_refreshes >= max_local_refreshes {
                return Err("本机数据在同步期间持续变化，请稍后重试。".to_string());
            }
            local_refreshes += 1;
            remote_override = Some(json!({
                "document": merged_document,
                "etag": write_result.get("etag").and_then(Value::as_str).unwrap_or(""),
                "exists": true
            }));
            continue;
        }

        let snapshot_value = apply_sync_document_to_vault(state, &merged_document)?;
        let synced_at = now();
        let message = if !conflicts.is_empty() && !conflict_resolution.is_empty() {
            format!(
                "同步完成，已按选择保留{}处理 {} 个冲突。",
                if conflict_resolution == "local" {
                    "本地"
                } else {
                    "云端"
                },
                conflicts.len()
            )
        } else {
            "同步完成。".to_string()
        };
        store["state"] = create_sync_state_from_document(
            &merged_document,
            store
                .pointer("/state/deviceId")
                .and_then(Value::as_str)
                .unwrap_or("tauri-local"),
            write_result
                .get("etag")
                .and_then(Value::as_str)
                .unwrap_or(""),
            &synced_at,
        );
        store["config"]["lastSyncAt"] = json!(synced_at);
        store["config"]["lastSyncStatus"] = json!("success");
        store["config"]["lastSyncMessage"] = json!(message);
        store["config"]["lastConflictCount"] = json!(0);
        let saved_store = write_sync_store(state, store)?;
        let _ = window.emit("vault:changed", json!({ "kind": "sync" }));
        let result = sync_success_result(
            &saved_store,
            &local,
            &remote_document,
            &merged,
            snapshot_value,
            &message,
            &conflict_resolution,
            &empty_vault_resolution,
            &shrink_resolution,
        );
        let _ = window.emit("sync:changed", result.clone());
        return Ok(result);
    }
}

fn operational_sync_store(
    state: &AppState,
    incoming: Option<Value>,
    require_sync_passphrase: bool,
) -> Result<Value, String> {
    let store = if let Some(incoming) = incoming {
        if incoming.is_null() {
            read_sync_store(state)?
        } else {
            let _ = save_sync_config(state, incoming)?;
            read_sync_store(state)?
        }
    } else {
        read_sync_store(state)?
    };
    ensure_operational_sync_settings(
        store.get("config").unwrap_or(&Value::Null),
        store.get("secrets").unwrap_or(&Value::Null),
        require_sync_passphrase,
    )?;
    Ok(store)
}

fn ensure_operational_sync_settings(
    config: &Value,
    secrets: &Value,
    require_sync_passphrase: bool,
) -> Result<(), String> {
    let webdav_url = config
        .get("webdavUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let username = config
        .get("webdavUsername")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let password = secrets
        .get("webdavPassword")
        .and_then(Value::as_str)
        .unwrap_or("");
    let passphrase = secrets
        .get("syncPassphrase")
        .and_then(Value::as_str)
        .unwrap_or("");
    if webdav_url.is_empty() {
        return Err("请先填写 WebDAV 地址。".to_string());
    }
    if username.is_empty() {
        return Err("请先填写 WebDAV 用户名。".to_string());
    }
    if password.is_empty() {
        return Err("请先填写 WebDAV 密码或应用密码。".to_string());
    }
    if require_sync_passphrase && passphrase.chars().count() < 8 {
        return Err("同步密码至少需要 8 个字符。".to_string());
    }
    Ok(())
}

fn read_resolution(incoming: Option<&Value>, key: &str, allowed: &[&str]) -> String {
    incoming
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .filter(|value| allowed.contains(value))
        .unwrap_or("")
        .to_string()
}

async fn read_remote_sync_document(config: &Value, secrets: &Value) -> Result<Value, String> {
    let remote_path = config
        .get("webdavRemotePath")
        .and_then(Value::as_str)
        .unwrap_or("/ShellDesk/shelldesk-sync.json");
    let response = webdav_request(config, secrets, "GET", remote_path, None, None, &[]).await?;
    if response.status().as_u16() == 404 {
        return Ok(json!({
            "document": create_empty_remote_document(),
            "etag": "",
            "exists": false
        }));
    }
    if !response.status().is_success() {
        return Err(webdav_response_error(response, "读取远端同步文件").await);
    }
    let etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = response.text().await.map_err(error_string)?;
    if text.is_empty() || text.len() > 25 * 1024 * 1024 {
        return Err("远端同步文件为空或超过大小限制。".to_string());
    }
    let raw: Value =
        serde_json::from_str(&text).map_err(|_| "远端同步文件内容无效。".to_string())?;
    let passphrase = secrets
        .get("syncPassphrase")
        .and_then(Value::as_str)
        .unwrap_or("");
    let decrypted = if raw.get("format").and_then(Value::as_str) == Some("shelldesk-sync-encrypted")
    {
        decrypt_remote_document(&raw, passphrase)?
    } else {
        raw
    };
    Ok(json!({
        "document": sanitize_remote_document(decrypted),
        "etag": etag,
        "exists": true
    }))
}

async fn write_remote_sync_document(
    config: &Value,
    secrets: &Value,
    document: &Value,
    etag: &str,
    exists: bool,
) -> Result<Value, String> {
    let passphrase = secrets
        .get("syncPassphrase")
        .and_then(Value::as_str)
        .unwrap_or("");
    let body_value = encrypt_remote_document(document, passphrase)?;
    let body = serde_json::to_string_pretty(&body_value).map_err(error_string)?;
    let remote_path = config
        .get("webdavRemotePath")
        .and_then(Value::as_str)
        .unwrap_or("/ShellDesk/shelldesk-sync.json");
    let response = webdav_request(
        config,
        secrets,
        "PUT",
        remote_path,
        Some(body),
        Some("application/json; charset=utf-8"),
        &webdav_write_precondition_headers(etag, exists),
    )
    .await?;
    if response.status().as_u16() == 412 {
        return Ok(json!({ "preconditionFailed": true, "etag": "" }));
    }
    if !matches!(response.status().as_u16(), 200 | 201 | 204) {
        return Err(webdav_response_error(response, "写入远端同步文件").await);
    }
    let next_etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    Ok(json!({ "preconditionFailed": false, "etag": next_etag }))
}

fn base_sync_result(
    store: &Value,
    local: &Value,
    remote_document: &Value,
    merged: &Value,
    ok: bool,
    snapshot_value: Value,
    message: &str,
) -> Value {
    let conflicts = merged
        .get("conflicts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let local_records = local.get("localRecords").unwrap_or(&Value::Null);
    let local_tombstones = local.get("localTombstones").unwrap_or(&Value::Null);
    let merged_document = merged.get("document").unwrap_or(remote_document);
    let uploaded = merged.get("uploaded").and_then(Value::as_i64).unwrap_or(0);
    let downloaded = merged
        .get("downloaded")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let deleted = merged.get("deleted").and_then(Value::as_i64).unwrap_or(0);
    json!({
        "ok": ok,
        "needsResolution": false,
        "needsEmptyVaultResolution": false,
        "needsShrinkConfirmation": false,
        "resolution": "",
        "emptyVaultResolution": "",
        "shrinkResolution": "",
        "syncedAt": if ok { now() } else { String::new() },
        "uploaded": uploaded,
        "downloaded": downloaded,
        "deleted": deleted,
        "conflictCount": conflicts.len(),
        "conflicts": conflicts,
        "conflictSummary": conflict_summary(&conflicts),
        "summary": sync_summary(local_records, local_tombstones, remote_document, merged_document, uploaded, downloaded, deleted, &conflicts),
        "emptyVaultSummary": null,
        "shrinkSummary": null,
        "snapshot": snapshot_value,
        "config": sync_public_config(store),
        "message": message
    })
}

fn pending_empty_vault_result(
    state: &AppState,
    store: &mut Value,
    local: &Value,
    remote_document: &Value,
) -> Result<Value, String> {
    let remote_count =
        count_content_records(remote_document.get("records").unwrap_or(&Value::Null));
    let message = format!(
        "本机 vault 为空，但云端有 {remote_count} 项数据。请选择恢复云端数据或保留本机空库。"
    );
    store["config"]["lastSyncStatus"] = json!("warning");
    store["config"]["lastSyncMessage"] = json!(message);
    store["config"]["lastConflictCount"] = json!(0);
    let saved = write_sync_store(state, store.clone())?;
    let mut result = base_sync_result(
        &saved,
        local,
        remote_document,
        &json!({ "document": remote_document, "conflicts": [], "uploaded": 0, "downloaded": 0, "deleted": 0 }),
        false,
        Value::Null,
        saved
            .pointer("/config/lastSyncMessage")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    result["needsEmptyVaultResolution"] = json!(true);
    result["emptyVaultSummary"] = json!({
        "localRecords": count_content_records(local.get("localRecords").unwrap_or(&Value::Null)),
        "remoteRecords": remote_count,
        "remoteRecordsByType": Value::Object(count_records_by_type(remote_document.get("records").unwrap_or(&Value::Null)))
    });
    Ok(result)
}

fn pending_conflict_result(
    state: &AppState,
    store: &mut Value,
    local: &Value,
    remote_document: &Value,
    merged: &Value,
) -> Result<Value, String> {
    let count = merged
        .get("conflicts")
        .and_then(Value::as_array)
        .map(|items| items.len())
        .unwrap_or(0);
    let message = format!("发现 {count} 个同步冲突，请选择保留本地或保留云端。");
    store["config"]["lastSyncStatus"] = json!("warning");
    store["config"]["lastSyncMessage"] = json!(message);
    store["config"]["lastConflictCount"] = json!(count);
    let saved = write_sync_store(state, store.clone())?;
    let mut result = base_sync_result(
        &saved,
        local,
        remote_document,
        merged,
        false,
        Value::Null,
        saved
            .pointer("/config/lastSyncMessage")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    result["needsResolution"] = json!(true);
    Ok(result)
}

fn pending_shrink_result(
    state: &AppState,
    store: &mut Value,
    local: &Value,
    remote_document: &Value,
    merged: &Value,
    shrink: Option<Value>,
) -> Result<Value, String> {
    let shrink = shrink.unwrap_or(Value::Null);
    let message = format!(
        "同步结果会从 {} 项减少到 {} 项，已暂停以避免误删。",
        shrink
            .get("baselineRecords")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        shrink
            .get("mergedRecords")
            .and_then(Value::as_i64)
            .unwrap_or(0)
    );
    store["config"]["lastSyncStatus"] = json!("warning");
    store["config"]["lastSyncMessage"] = json!(message);
    store["config"]["lastConflictCount"] = json!(0);
    let saved = write_sync_store(state, store.clone())?;
    let mut result = base_sync_result(
        &saved,
        local,
        remote_document,
        merged,
        false,
        Value::Null,
        saved
            .pointer("/config/lastSyncMessage")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    result["needsShrinkConfirmation"] = json!(true);
    result["shrinkSummary"] = shrink;
    Ok(result)
}

fn sync_success_result(
    store: &Value,
    local: &Value,
    remote_document: &Value,
    merged: &Value,
    snapshot_value: Value,
    message: &str,
    conflict_resolution: &str,
    empty_vault_resolution: &str,
    shrink_resolution: &str,
) -> Value {
    let mut result = base_sync_result(
        store,
        local,
        remote_document,
        merged,
        true,
        snapshot_value,
        message,
    );
    result["resolution"] = json!(conflict_resolution);
    result["emptyVaultResolution"] = json!(empty_vault_resolution);
    result["shrinkResolution"] = json!(shrink_resolution);
    result
}

fn update_sync_status(state: &AppState, status: &str, message: &str) -> Result<(), String> {
    update_sync_status_with_time(state, status, message, "")
}

fn update_sync_status_with_time(
    state: &AppState,
    status: &str,
    message: &str,
    synced_at: &str,
) -> Result<(), String> {
    let mut store = read_sync_store(state)?;
    store["config"]["lastSyncStatus"] = json!(status);
    store["config"]["lastSyncMessage"] = json!(message);
    store["config"]["lastConflictCount"] = json!(0);
    if !synced_at.is_empty() {
        store["config"]["lastSyncAt"] = json!(synced_at);
    }
    let _ = write_sync_store(state, store)?;
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use base64::Engine;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    fn electron_safe_storage_encrypt(plaintext: &str) -> String {
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
        assert_ne!(ok, 0);
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
        base64::engine::general_purpose::STANDARD.encode(encrypted)
    }

    #[test]
    fn decrypts_windows_dpapi_safe_storage_payload() {
        let plaintext = r#"{"webdavPassword":"webdav-secret","syncPassphrase":"sync-secret"}"#;
        let ciphertext = electron_safe_storage_encrypt(plaintext);
        let decrypted = decrypt_electron_safe_storage(&ciphertext).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn normalizes_electron_protected_sync_store() {
        let ciphertext = electron_safe_storage_encrypt(
            r#"{"webdavPassword":"webdav-secret","syncPassphrase":"sync-secret"}"#,
        );
        let normalized = normalize_electron_protected_sync_store(json!({
            "format": "shelldesk-sync-settings",
            "version": 1,
            "protected": true,
            "ciphertext": ciphertext,
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "config": {
                "enabled": true,
                "webdavUrl": "https://dav.example.com/root",
                "webdavUsername": "alice",
                "webdavRemotePath": "/ShellDesk/sync.json",
                "intervalMinutes": 20
            },
            "state": {
                "deviceId": "device-1",
                "lastRecords": {},
                "lastTombstones": {}
            }
        }))
        .unwrap();

        assert_eq!(
            normalized
                .pointer("/secrets/webdavPassword")
                .and_then(Value::as_str),
            Some("webdav-secret")
        );
        assert_eq!(
            normalized
                .pointer("/secrets/syncPassphrase")
                .and_then(Value::as_str),
            Some("sync-secret")
        );
        assert_eq!(
            normalized
                .pointer("/config/webdavUsername")
                .and_then(Value::as_str),
            Some("alice")
        );
        assert_eq!(
            normalized
                .pointer("/state/deviceId")
                .and_then(Value::as_str),
            Some("device-1")
        );
    }

    #[test]
    fn webdav_write_precondition_headers_match_legacy_etag_rules() {
        assert_eq!(
            webdav_write_precondition_headers("\"abc\"", true),
            vec![("If-Match", "\"abc\"".to_string())]
        );
        assert_eq!(
            webdav_write_precondition_headers("", false),
            vec![("If-None-Match", "*".to_string())]
        );
        assert!(webdav_write_precondition_headers("", true).is_empty());
    }

    #[test]
    fn sync_footprint_tracks_record_and_tombstone_hashes_only() {
        let first = create_sync_footprint(
            &json!({
                "host:1": {
                    "id": "host:1",
                    "type": "host",
                    "hash": "hash-a",
                    "payload": { "name": "alpha" }
                }
            }),
            &json!({
                "bookmark:1": {
                    "id": "bookmark:1",
                    "type": "bookmark",
                    "hash": "hash-b",
                    "deletedAt": "2026-06-18T00:00:00.000Z"
                }
            }),
        );
        let second = create_sync_footprint(
            &json!({
                "host:1": {
                    "id": "host:1",
                    "type": "host",
                    "hash": "hash-a",
                    "payload": { "name": "renamed but same hash" }
                }
            }),
            &json!({
                "bookmark:1": {
                    "id": "bookmark:1",
                    "type": "bookmark",
                    "hash": "hash-b",
                    "deletedAt": "2026-06-19T00:00:00.000Z"
                }
            }),
        );
        let changed = create_sync_footprint(
            &json!({
                "host:1": {
                    "id": "host:1",
                    "type": "host",
                    "hash": "hash-c",
                    "payload": { "name": "alpha" }
                }
            }),
            &json!({
                "bookmark:1": {
                    "id": "bookmark:1",
                    "type": "bookmark",
                    "hash": "hash-b"
                }
            }),
        );

        assert_eq!(first, second);
        assert_ne!(first, changed);
    }
}
