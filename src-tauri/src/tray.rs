use crate::{error_string, vault, AppState};
use serde_json::Value;
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "show";
const TRAY_QUIT_ID: &str = "quit";

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let menu = MenuBuilder::new(&handle)
        .text(TRAY_SHOW_ID, "显示 ShellDesk")
        .separator()
        .text(TRAY_QUIT_ID, "退出 ShellDesk")
        .build()?;
    let icon = handle.default_window_icon().cloned();

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("ShellDesk")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_ID => show_main_window(app),
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let should_show = matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } | TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            );
            if should_show {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = icon {
        tray = tray.icon(icon);
    }
    tray.build(&handle)?;

    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let state = app.state::<AppState>().inner().clone();
        let window_for_close = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if minimize_to_tray_on_close(&state).unwrap_or(true) {
                    api.prevent_close();
                    let _ = window_for_close.hide();
                }
            }
        });
    }

    Ok(())
}

pub(crate) fn close_window(window: &tauri::Window, state: &AppState) -> Result<(), String> {
    if window.label() == MAIN_WINDOW_LABEL && minimize_to_tray_on_close(state).unwrap_or(true) {
        window.hide().map_err(error_string)?;
        return Ok(());
    }
    window.close().map_err(error_string)
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn minimize_to_tray_on_close(state: &AppState) -> Result<bool, String> {
    let _guard = state.store_lock.lock().map_err(error_string)?;
    let store = vault::read_store(state)?;
    Ok(store
        .get("settings")
        .and_then(|settings| settings.get("minimizeToTrayOnClose"))
        .and_then(Value::as_bool)
        .unwrap_or(true))
}
