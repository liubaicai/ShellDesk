use crate::vault::{
    default_settings, generate_key_pair, get_bookmarks, get_preference,
    get_remote_connection_profile, import_key_pair, public_snapshot, read_store,
    save_bookmarks_to_store, save_remote_connection_profile_to_store, set_preference_to_store,
    snapshot, to_snapshot, upsert_vault_collections, with_store_mut,
};
use crate::{string_arg, AppState};
use serde_json::{json, Value};
use tauri::Emitter;

pub(crate) async fn dispatch(
    state: &AppState,
    window: &tauri::Window,
    channel: &str,
    args: &[Value],
) -> Result<Option<Value>, String> {
    let value = match channel {
        "vault:get-default-settings" => default_settings(),
        "vault:get-public-snapshot" => public_snapshot(state)?,
        "vault:get-snapshot" => snapshot(state)?,
        "vault:save-collections" => {
            let _operation = state.vault_operation_lock.lock().await;
            let payload = args.first().cloned().unwrap_or(Value::Null);
            let snapshot = with_store_mut(state, |store| {
                upsert_vault_collections(store, payload)?;
                Ok(to_snapshot(state, store.clone()))
            })?;
            let _ = window.emit("vault:changed", json!({ "kind": "vault" }));
            snapshot
        }
        "vault:get-bookmarks" => {
            let scope = string_arg(args, 0)?;
            let store = read_store(state)?;
            get_bookmarks(&store, &scope)?
        }
        "vault:save-bookmarks" => {
            let _operation = state.vault_operation_lock.lock().await;
            let scope = string_arg(args, 0)?;
            let bookmarks = args.get(1).cloned().unwrap_or_else(|| json!([]));
            let bookmarks = with_store_mut(state, |store| {
                save_bookmarks_to_store(store, &scope, bookmarks)
            })?;
            let _ = window.emit(
                "vault:changed",
                json!({ "kind": "bookmarks", "scope": scope }),
            );
            bookmarks
        }
        "vault:get-remote-connection-profile" => {
            let host_id = string_arg(args, 0)?;
            let app_key = string_arg(args, 1)?;
            let store = read_store(state)?;
            get_remote_connection_profile(&store, &host_id, &app_key)?
        }
        "vault:save-remote-connection-profile" => {
            let _operation = state.vault_operation_lock.lock().await;
            let host_id = string_arg(args, 0)?;
            let app_key = string_arg(args, 1)?;
            let values = args.get(2).cloned().unwrap_or_else(|| json!({}));
            with_store_mut(state, |store| {
                save_remote_connection_profile_to_store(store, &host_id, &app_key, values)
            })?
        }
        "vault:import-key-pair" => import_key_pair(state, window, args.to_vec()).await?,
        "vault:generate-rsa-key-pair" => generate_key_pair(state, window, args.to_vec()).await?,

        "preferences:get" => {
            let key = string_arg(args, 0)?;
            let store = read_store(state)?;
            get_preference(&store, &key)?
        }
        "preferences:set" => {
            let _operation = state.vault_operation_lock.lock().await;
            let key = string_arg(args, 0)?;
            let value = args.get(1).cloned().unwrap_or(Value::Null);
            let value = with_store_mut(state, |store| set_preference_to_store(store, &key, value))?;
            let _ = window.emit("vault:changed", json!({ "kind": "preference", "key": key }));
            value
        }
        _ => return Ok(None),
    };

    Ok(Some(value))
}
