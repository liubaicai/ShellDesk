use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    process::Stdio,
    time::Duration,
};
use tokio::{process::Command, time};

use crate::{error_string, prevent_tokio_process_window};

pub(crate) fn read_known_hosts() -> Result<Value, String> {
    const MAX_KNOWN_HOSTS_FILE_SIZE: u64 = 5 * 1024 * 1024;
    let mut paths = Vec::new();
    let mut chunks = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for file_name in ["known_hosts", "known_hosts2"] {
            let path = home.join(".ssh").join(file_name);
            if let Ok(metadata) = fs::metadata(&path) {
                if metadata.is_file() && metadata.len() <= MAX_KNOWN_HOSTS_FILE_SIZE {
                    if let Ok(content) = fs::read_to_string(&path) {
                        chunks.push(content);
                        paths.push(path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    for path in system_known_hosts_paths() {
        if let Ok(metadata) = fs::metadata(&path) {
            if metadata.is_file() && metadata.len() <= MAX_KNOWN_HOSTS_FILE_SIZE {
                if let Ok(content) = fs::read_to_string(&path) {
                    chunks.push(content);
                    paths.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    let mut seen_paths = HashSet::new();
    paths.retain(|path| seen_paths.insert(path.clone()));
    Ok(json!({ "content": chunks.join("\n"), "paths": paths }))
}

fn system_known_hosts_paths() -> Vec<PathBuf> {
    if cfg!(windows) {
        let program_data = std::env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        vec![program_data.join("ssh").join("known_hosts")]
    } else {
        vec![PathBuf::from("/etc/ssh/ssh_known_hosts")]
    }
}

pub(crate) async fn list_system_fonts() -> Result<Value, String> {
    let fonts = if cfg!(windows) {
        read_windows_fonts().await
    } else if cfg!(target_os = "macos") {
        read_macos_fonts().await
    } else {
        read_linux_fonts().await
    }
    .unwrap_or_default();

    let normalized = unique_sorted_font_names(if fonts.is_empty() {
        fallback_font_families()
    } else {
        fonts
    });
    Ok(json!(normalized))
}

async fn read_windows_fonts() -> Result<Vec<String>, String> {
    let script = r#"
$ErrorActionPreference = 'Stop'
try {
  $__shelldeskUtf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::InputEncoding = $__shelldeskUtf8
  [Console]::OutputEncoding = $__shelldeskUtf8
  $OutputEncoding = $__shelldeskUtf8
} catch {}
Add-Type -AssemblyName System.Drawing
$fontCollection = New-Object System.Drawing.Text.InstalledFontCollection
$fontCollection.Families | ForEach-Object { $_.Name }
"#;
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let mut command = Command::new("powershell.exe");
    prevent_tokio_process_window(&mut command);
    let powershell = command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    if let Ok(Ok(output)) = time::timeout(Duration::from_secs(10), powershell).await {
        if output.status.success() {
            let fonts = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(ToString::to_string)
                .collect::<Vec<_>>();
            if !fonts.is_empty() {
                return Ok(fonts);
            }
        }
    }

    let mut fonts = Vec::new();
    for registry_key in [
        r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
        r"HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
    ] {
        let mut command = Command::new("reg.exe");
        prevent_tokio_process_window(&mut command);
        let output = command
            .args(["query", registry_key])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
        let Ok(Ok(output)) = time::timeout(Duration::from_secs(8), output).await else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("HKEY_") {
                continue;
            }
            let Some((name, _)) = trimmed.split_once("    REG_") else {
                continue;
            };
            fonts.push(normalize_registry_font_name(name));
        }
    }
    Ok(fonts)
}

async fn read_macos_fonts() -> Result<Vec<String>, String> {
    let mut command = Command::new("system_profiler");
    prevent_tokio_process_window(&mut command);
    let output = time::timeout(
        Duration::from_secs(15),
        command
            .args(["SPFontsDataType", "-json"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| "读取 macOS 字体超时。".to_string())?
    .map_err(error_string)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let payload: Value = serde_json::from_slice(&output.stdout).map_err(error_string)?;
    let mut fonts = Vec::new();
    collect_font_names(
        &payload
            .get("SPFontsDataType")
            .cloned()
            .unwrap_or(Value::Null),
        &mut fonts,
    );
    Ok(fonts)
}

async fn read_linux_fonts() -> Result<Vec<String>, String> {
    let mut command = Command::new("fc-list");
    prevent_tokio_process_window(&mut command);
    let output = time::timeout(
        Duration::from_secs(10),
        command
            .args([":", "family"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| "读取 Linux 字体超时。".to_string())?
    .map_err(error_string)?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .flat_map(|line| line.split(','))
        .map(ToString::to_string)
        .collect())
}

fn collect_font_names(value: &Value, fonts: &mut Vec<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_font_names(item, fonts);
            }
        }
        Value::Object(object) => {
            if let Some(family) = object.get("family").and_then(Value::as_str) {
                fonts.push(family.to_string());
            } else if let Some(name) = object.get("_name").and_then(Value::as_str) {
                fonts.push(name.to_string());
            }
            for item in object.values() {
                collect_font_names(item, fonts);
            }
        }
        _ => {}
    }
}

fn unique_sorted_font_names(fonts: Vec<String>) -> Vec<String> {
    let mut values = HashMap::<String, String>::new();
    for font in fonts {
        let normalized = normalize_font_name(&font);
        if normalized.is_empty() {
            continue;
        }
        values
            .entry(normalized.to_lowercase())
            .or_insert(normalized);
    }
    let mut fonts = values.into_values().collect::<Vec<_>>();
    fonts.sort_by_key(|value| value.to_lowercase());
    fonts
}

fn normalize_font_name(value: &str) -> String {
    let font = value
        .replace('\0', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if font.is_empty() || font.len() > 120 || font.starts_with('@') {
        String::new()
    } else {
        font
    }
}

fn normalize_registry_font_name(value: &str) -> String {
    let mut font = normalize_font_name(value);
    for suffix in [
        " (TrueType)",
        " (OpenType)",
        " (Type 1)",
        " (Raster)",
        " (Bitmap)",
    ] {
        if font.ends_with(suffix) {
            font.truncate(font.len().saturating_sub(suffix.len()));
        }
    }
    for suffix in [
        " Extra Bold",
        " Extra Light",
        " Semi Bold",
        " Semibold",
        " Demi Bold",
        " Condensed",
        " Regular",
        " Oblique",
        " Medium",
        " Narrow",
        " Italic",
        " Light",
        " Black",
        " Bold",
        " Thin",
    ] {
        if font.ends_with(suffix) {
            font.truncate(font.len().saturating_sub(suffix.len()));
            break;
        }
    }
    font.trim().to_string()
}

fn fallback_font_families() -> Vec<String> {
    [
        "Microsoft YaHei UI",
        "Microsoft YaHei",
        "Segoe UI Variable",
        "Segoe UI",
        "Arial",
        "Verdana",
        "Georgia",
        "Times New Roman",
        "Cascadia Mono",
        "Consolas",
        "Courier New",
    ]
    .into_iter()
    .map(ToString::to_string)
    .collect()
}
