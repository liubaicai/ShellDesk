use crate::agent_sessions::{
    delete_session as delete_agent_session, get_sessions as get_agent_sessions,
    save_session as save_agent_session,
};
use crate::ai::{ai_chat, ai_chat_stream, ai_list_models, ai_web_search};
use crate::logs::{
    append_entry as append_log_entry, clear_entries as clear_log_entries,
    get_entries as get_log_entries, save_entries as save_log_entries,
};
use crate::proxy::test_proxy;
use crate::system::{list_system_fonts, read_known_hosts};
use crate::{config, sync_backend, AppState};
use serde_json::{json, Value};
use tauri::Emitter;

pub(crate) async fn dispatch(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: AppState,
    channel: String,
    args: &[Value],
) -> Result<Option<Value>, String> {
    let value = match channel.as_str() {
        "agent-sessions:get" => get_agent_sessions(&state)?,
        "agent-sessions:save" => {
            save_agent_session(&state, args.first().cloned().unwrap_or_else(|| json!({})))?
        }
        "agent-sessions:delete" => delete_agent_session(&state, args)?,
        "logs:get-entries" => get_log_entries(&state)?,
        "logs:clear-entries" => {
            let result = clear_log_entries(&state)?;
            let _ = app.emit("logs:changed", json!({ "kind": "clear" }));
            result
        }
        "logs:save-entries" => {
            let result =
                save_log_entries(&state, args.first().cloned().unwrap_or_else(|| json!([])))?;
            let _ = app.emit("logs:changed", json!({ "kind": "reload" }));
            result
        }
        "logs:append-entry" => {
            let entry = args.first().cloned().unwrap_or_else(|| json!({}));
            let result = append_log_entry(&state, entry.clone())?;
            let _ = app.emit("logs:changed", json!({ "kind": "append", "entry": entry }));
            result
        }

        "dialog:select-private-key" => config::select_key_file(&state, "private")?,
        "dialog:select-public-key" => config::select_key_file(&state, "public")?,
        "dialog:save-text-file" => config::save_text_file(&state, args.to_vec()).await?,
        "config:export" => config::export_config(&state).await?,
        "config:import" => config::import_config(&state, &window).await?,

        "system:list-fonts" => list_system_fonts().await?,
        "system:read-known-hosts" => read_known_hosts()?,
        "system:test-proxy" => test_proxy(args.to_vec()).await?,
        "ai:list-models" => ai_list_models(args.to_vec()).await?,
        "ai:chat" => ai_chat(args.to_vec()).await?,
        "ai:chat-stream" => ai_chat_stream(&window, args.to_vec()).await?,
        "ai:web-search" => ai_web_search(args.to_vec()).await?,

        "sync:get-config" => sync_backend::sync_config(&state)?,
        "sync:save-config" => {
            let _operation = state.vault_operation_lock.lock().await;
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            let result = sync_backend::save_sync_config(&state, config)?;
            sync_backend::reload_sync_schedule(&state, &app);
            result
        }
        "sync:test-webdav" => {
            let _operation = state.vault_operation_lock.lock().await;
            sync_backend::test_webdav(&state, args.to_vec()).await?
        }
        "sync:run-now" => {
            let _operation = state.vault_operation_lock.lock().await;
            match sync_backend::run_webdav_sync(&state, &window, args.to_vec()).await {
                Ok(result) => {
                    append_sync_log_entry(&state, &app, &result);
                    result
                }
                Err(error) => {
                    append_sync_log_entry(&state, &app, &json!({ "ok": false }));
                    return Err(error);
                }
            }
        }
        _ => return Ok(None),
    };

    Ok(Some(value))
}

fn append_sync_log_entry(state: &AppState, app: &tauri::AppHandle, result: &Value) {
    let needs_empty_vault_resolution = result
        .get("needsEmptyVaultResolution")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let needs_shrink_confirmation = result
        .get("needsShrinkConfirmation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let needs_resolution = result
        .get("needsResolution")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let succeeded = result.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let conflict_count = result
        .get("conflictCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let resolution = result
        .get("resolution")
        .and_then(Value::as_str)
        .unwrap_or("");
    let (level, message) = if !succeeded {
        ("error", "内容同步失败。".to_string())
    } else if needs_empty_vault_resolution {
        (
            "warning",
            "同步等待确认：本地内容为空，云端存在内容。".to_string(),
        )
    } else if needs_shrink_confirmation {
        (
            "warning",
            "同步等待确认：检测到可能的大量内容删除。".to_string(),
        )
    } else if needs_resolution {
        (
            "warning",
            format!("同步发现 {conflict_count} 个冲突，等待处理。"),
        )
    } else if !resolution.is_empty() {
        (
            "success",
            format!(
                "同步完成：已按{}处理冲突。",
                if resolution == "local" {
                    "本地版本"
                } else {
                    "云端版本"
                }
            ),
        )
    } else {
        ("success", "内容同步完成。".to_string())
    };
    let detail = format!(
        "uploaded: {}, downloaded: {}, deleted: {}, conflicts: {}",
        result.get("uploaded").and_then(Value::as_u64).unwrap_or(0),
        result
            .get("downloaded")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        result.get("deleted").and_then(Value::as_u64).unwrap_or(0),
        conflict_count,
    );
    let entry = json!({
        "id": crate::random_id("sync-log"),
        "timestamp": crate::now(),
        "category": "config",
        "level": level,
        "message": message,
        "detail": detail,
        "component": "sync"
    });

    if crate::logs::append_entry(state, entry.clone()).is_ok() {
        let _ = app.emit("logs:changed", json!({ "kind": "append", "entry": entry }));
    }
}
