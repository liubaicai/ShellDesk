use super::{paths::sanitize_local_file_name, sftp::upload_sftp_paths};
use crate::{error_string, random_id, string_arg, value_to_bytes, AppState};
use serde_json::{json, Value};
use std::fs;

const MAX_TERMINAL_CLIPBOARD_IMAGE_BYTES: usize = 10 * 1024 * 1024;

pub(crate) async fn upload_sftp_bytes(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_dir = string_arg(&args, 1)?;
    let requested_name = string_arg(&args, 2)?;
    let bytes = value_to_bytes(args.get(3).cloned().unwrap_or(Value::Null))?;
    if bytes.is_empty() || bytes.len() > MAX_TERMINAL_CLIPBOARD_IMAGE_BYTES {
        return Err("终端剪贴板图片必须介于 1 字节和 10 MiB 之间。".to_string());
    }
    let file_name = sanitize_local_file_name(&requested_name, "shelldesk-paste.png");
    let temp_dir = std::env::temp_dir().join(random_id("shelldesk-terminal-paste"));
    fs::create_dir_all(&temp_dir).map_err(error_string)?;
    let temp_path = temp_dir.join(&file_name);
    if let Err(error) = fs::write(&temp_path, &bytes).map_err(error_string) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(error);
    }
    let result = upload_sftp_paths(
        state,
        window,
        vec![
            json!(connection_id),
            json!(remote_dir),
            json!([{ "path": temp_path.to_string_lossy(), "remoteName": file_name }]),
            json!({ "label": "terminal-clipboard-image" }),
        ],
    )
    .await;
    let _ = fs::remove_dir_all(&temp_dir);
    result
}
