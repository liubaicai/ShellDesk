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
    state: AppState,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if let Some(value) = Box::pin(app_channels::dispatch(
        app.clone(),
        window.clone(),
        state.clone(),
        channel.clone(),
        &args,
    ))
    .await?
    {
        return Ok(value);
    }
    if let Some(value) = Box::pin(vault_channels::dispatch(
        state.clone(),
        window.clone(),
        channel.clone(),
        &args,
    ))
    .await?
    {
        return Ok(value);
    }
    if let Some(value) = Box::pin(utility_channels::dispatch(
        app,
        window.clone(),
        state.clone(),
        channel.clone(),
        &args,
    ))
    .await?
    {
        return Ok(value);
    }
    if channel.starts_with("connection:") {
        let missing_channel = channel.clone();
        Box::pin(connection_channels::dispatch(state, window, channel, args))
            .await
            .unwrap_or_else(|| {
                Err(format!(
                    "{} is not implemented in the Tauri/Rust backend yet.",
                    missing_channel
                ))
            })
    } else if channel.starts_with("ai:") {
        Err(format!("Unsupported AI IPC channel: {}", channel))
    } else {
        Err(format!("Unsupported IPC channel: {}", channel))
    }
}
