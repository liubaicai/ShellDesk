use crate::ai::{ai_chat, ai_chat_stream, ai_list_models, ai_web_search};
use crate::logs::{
    append_entry as append_log_entry, clear_entries as clear_log_entries,
    get_entries as get_log_entries, save_entries as save_log_entries,
};
use crate::proxy::test_proxy;
use crate::system::{list_system_fonts, read_known_hosts};
use crate::{config, sync_backend, AppState};
use serde_json::{json, Value};

pub(crate) async fn dispatch(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    state: &AppState,
    channel: &str,
    args: &[Value],
) -> Result<Option<Value>, String> {
    let value = match channel {
        "logs:get-entries" => get_log_entries(state)?,
        "logs:clear-entries" => clear_log_entries(state)?,
        "logs:save-entries" => {
            save_log_entries(state, args.first().cloned().unwrap_or_else(|| json!([])))?
        }
        "logs:append-entry" => {
            append_log_entry(state, args.first().cloned().unwrap_or_else(|| json!({})))?
        }

        "dialog:select-private-key" => config::select_key_file(state, "private")?,
        "dialog:select-public-key" => config::select_key_file(state, "public")?,
        "dialog:save-text-file" => config::save_text_file(state, args.to_vec()).await?,
        "config:export" => config::export_config(state).await?,
        "config:import" => config::import_config(state, window).await?,

        "system:list-fonts" => list_system_fonts().await?,
        "system:read-known-hosts" => read_known_hosts()?,
        "system:test-proxy" => test_proxy(args.to_vec()).await?,
        "ai:list-models" => ai_list_models(args.to_vec()).await?,
        "ai:chat" => ai_chat(args.to_vec()).await?,
        "ai:chat-stream" => ai_chat_stream(window, args.to_vec()).await?,
        "ai:web-search" => ai_web_search(args.to_vec()).await?,

        "sync:get-config" => sync_backend::sync_config(state)?,
        "sync:save-config" => {
            let _operation = state.vault_operation_lock.lock().await;
            let config = args.first().cloned().unwrap_or_else(|| json!({}));
            let result = sync_backend::save_sync_config(state, config)?;
            sync_backend::reload_sync_schedule(state, app);
            result
        }
        "sync:test-webdav" => {
            let _operation = state.vault_operation_lock.lock().await;
            sync_backend::test_webdav(state, args.to_vec()).await?
        }
        "sync:run-now" => {
            let _operation = state.vault_operation_lock.lock().await;
            sync_backend::run_webdav_sync(state, window, args.to_vec()).await?
        }
        _ => return Ok(None),
    };

    Ok(Some(value))
}
