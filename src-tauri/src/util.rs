use chrono::Utc;
use rand::{distributions::Alphanumeric, Rng};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("ShellDesk")
}

pub(crate) fn node_platform() -> String {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
    .to_string()
}

pub(crate) fn read_json_file(path: &Path, fallback: Value) -> Result<Value, String> {
    if !path.exists() {
        return Ok(fallback);
    }
    let content = fs::read_to_string(path).map_err(error_string)?;
    serde_json::from_str(&content).map_err(error_string)
}

pub(crate) fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(error_string)?;
    }
    let content = serde_json::to_string_pretty(value).map_err(error_string)?;
    fs::write(path, content).map_err(error_string)
}

pub(crate) fn write_json_file_private(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(error_string)?;
    }
    let content = serde_json::to_string_pretty(value).map_err(error_string)?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(error_string)?;
        file.write_all(content.as_bytes()).map_err(error_string)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, content).map_err(error_string)
    }
}

pub(crate) fn sanitize_file_name(value: &str) -> String {
    let mut output = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim_matches(['.', ' '])
        .to_string();
    if output.is_empty() {
        output = "download".to_string();
    }
    output
}

pub(crate) fn https_url_origin(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!("https://{host}{port}"))
}

pub(crate) fn string_arg(args: &[Value], index: usize) -> Result<String, String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| format!("Missing string argument at index {}.", index))
}

pub(crate) fn read_string_field(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

pub(crate) fn read_u16_field(value: &Value, key: &str, fallback: u16) -> u16 {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(fallback)
}

pub(crate) fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

pub(crate) fn random_id(prefix: &str) -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(12)
        .map(char::from)
        .collect();
    format!("{}-{}", prefix, suffix)
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn whoami() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "local".to_string())
}

pub(crate) fn prevent_process_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

pub(crate) fn prevent_tokio_process_window(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

pub(crate) fn error_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}
