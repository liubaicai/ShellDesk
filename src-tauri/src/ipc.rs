use crate::askpass::remember_ui_window;
#[path = "ipc/app_channels.rs"]
mod app_channels;
#[path = "ipc/connection_channels.rs"]
mod connection_channels;
#[path = "ipc/utility_channels.rs"]
mod utility_channels;
#[path = "ipc/vault_channels.rs"]
mod vault_channels;

use crate::AppState;
use serde_json::Value;
pub(crate) async fn dispatch(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    remember_ui_window(&state, &window);
    if let Some(value) =
        app_channels::dispatch(&app, &window, &state, channel.as_str(), &args).await?
    {
        return Ok(value);
    }
    if let Some(value) = vault_channels::dispatch(&state, &window, channel.as_str(), &args).await? {
        return Ok(value);
    }
    if let Some(value) =
        utility_channels::dispatch(&app, &window, &state, channel.as_str(), &args).await?
    {
        return Ok(value);
    }
    match channel.as_str() {
        channel if channel.starts_with("connection:") => {
            connection_channels::dispatch(&state, window, channel, args)
                .await
                .unwrap_or_else(|| {
                    Err(format!(
                        "{} is not implemented in the Tauri/Rust backend yet.",
                        channel
                    ))
                })
        }
        channel if channel.starts_with("ai:") => {
            Err(format!("Unsupported AI IPC channel: {}", channel))
        }
        _ => Err(format!("Unsupported IPC channel: {}", channel)),
    }
}
