use crate::{
    app_data_dir, askpass::run_askpass_helper_from_env, ipc, proxy::run_proxy_helper_from_args,
    state::AppState,
};
use serde_json::Value;
use std::fs;
use tauri::Manager;

#[tauri::command]
async fn ipc_dispatch(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    ipc::dispatch(app, window, state, channel, args).await
}

pub(crate) fn run() {
    if let Some(exit_code) = run_proxy_helper_from_args() {
        std::process::exit(exit_code);
    }
    if let Some(exit_code) = run_askpass_helper_from_env() {
        std::process::exit(exit_code);
    }

    let data_dir = app_data_dir();
    if let Err(error) = fs::create_dir_all(&data_dir) {
        eprintln!("failed to create app data dir: {error}");
    }

    tauri::Builder::default()
        .manage(AppState::new(data_dir.clone()))
        .invoke_handler(tauri::generate_handler![ipc_dispatch])
        .setup(move |app| {
            // 启动时清理上次崩溃残留的临时 SSH 密钥文件。
            let key_dir = data_dir.join("ssh-keys");
            if key_dir.exists() {
                if let Ok(entries) = fs::read_dir(&key_dir) {
                    for entry in entries.flatten() {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }

            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)?;
            let state = app.state::<AppState>().inner().clone();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("ShellDesk");
                crate::updater::start_auto_update_check(
                    state.clone(),
                    window,
                    app.handle().clone(),
                    std::time::Duration::from_secs(5),
                );
            }
            crate::sync_backend::reload_sync_schedule(&state, app.handle());
            // TODO: Issue #67 - 数据库隧道空闲超时自动断开
            // crate::database::tunnel::start_idle_cleanup(state.clone(), app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ShellDesk");
}
