use crate::updater::{
    check_for_update_download, check_release_info, download_update, install_update,
    read_update_state,
};
use crate::{app as app_handlers, error_string, tray, AppState};
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
        "app:get-info" => json!(app_handlers::get_info(&app)),
        "app:open-external" => app_handlers::open_external(args.to_vec())?,
        "app:open-connection-window" => {
            app_handlers::open_connection_window(&app, &state, args.to_vec())?
        }
        "app:open-agent-window" => app_handlers::open_agent_window(&app)?,
        "app:open-main-ai-settings" => app_handlers::open_main_ai_settings(&app)?,
        "app:show-main-window" => app_handlers::show_main_window(&app)?,
        "app:check-for-updates" => {
            let result = check_release_info(app.clone()).await;
            match &result {
                Ok(value) => append_update_log_entry(&state, &app, value, "check"),
                Err(error) => append_update_log_entry(
                    &state,
                    &app,
                    &json!({ "success": false, "error": error }),
                    "check",
                ),
            }
            result?
        }
        "app:get-update-status" => read_update_state(&state, &app),
        "app:check-for-update-download" => {
            check_for_update_download(state.clone(), window.clone(), app.clone()).await?
        }
        "app:download-update" => {
            let result = download_update(state.clone(), window.clone(), app.clone()).await?;
            append_update_log_entry(&state, &app, &result, "download");
            result
        }
        "app:install-update" => {
            let result = install_update(state.clone(), app.clone()).await;
            match &result {
                Ok(value) => append_update_log_entry(&state, &app, value, "install"),
                Err(error) => append_update_log_entry(
                    &state,
                    &app,
                    &json!({ "success": false, "error": error }),
                    "install",
                ),
            }
            result?
        }

        "window:show" => {
            window.show().map_err(error_string)?;
            Value::Null
        }
        "window:start-dragging" => {
            window.start_dragging().map_err(error_string)?;
            Value::Null
        }
        "window:minimize" => {
            window.minimize().map_err(error_string)?;
            Value::Null
        }
        "window:toggle-maximize" => {
            let maximized = window.is_maximized().map_err(error_string)?;
            if maximized {
                window.unmaximize().map_err(error_string)?;
                let _ = window.emit(
                    "window:maximize-state-changed",
                    json!({ "maximized": false }),
                );
                json!(false)
            } else {
                window.maximize().map_err(error_string)?;
                let _ = window.emit(
                    "window:maximize-state-changed",
                    json!({ "maximized": true }),
                );
                json!(true)
            }
        }
        "window:is-maximized" => json!(window.is_maximized().map_err(error_string)?),
        "window:close" => {
            tray::close_window(&window, &state)?;
            Value::Null
        }
        _ => return Ok(None),
    };

    Ok(Some(value))
}

fn append_update_log_entry(state: &AppState, app: &tauri::AppHandle, result: &Value, action: &str) {
    let success = result
        .get("success")
        .and_then(Value::as_bool)
        .or_else(|| {
            result
                .get("updateAvailable")
                .and_then(Value::as_bool)
                .map(|_| true)
        })
        .unwrap_or(true);
    let (level, message) = match action {
        "check" if !success => ("error", "软件更新检查失败。"),
        "check" => (
            "info",
            if result
                .get("updateAvailable")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "软件更新检查完成：发现新版本。"
            } else {
                "软件更新检查完成：当前已是最新版本。"
            },
        ),
        "download" if success => ("success", "软件更新下载完成。"),
        "install" if success => ("success", "已请求安装软件更新。"),
        "download" => ("error", "软件更新下载失败。"),
        _ => ("error", "软件更新安装失败。"),
    };
    let detail = result.get("error").and_then(Value::as_str).unwrap_or("");
    let entry = json!({
        "id": crate::random_id("update-log"),
        "timestamp": crate::now(),
        "category": "system",
        "level": level,
        "message": message,
        "detail": detail,
        "component": "updater"
    });

    if crate::logs::append_entry(state, entry.clone()).is_ok() {
        let _ = app.emit("logs:changed", json!({ "kind": "append", "entry": entry }));
    }
}
