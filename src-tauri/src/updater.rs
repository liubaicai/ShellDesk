use crate::{error_string, now, sanitize_file_name, vault::read_store, AppState};
use serde_json::{json, Value};
use std::{fs, path::Path, time::Duration};
use tauri::{Emitter, Runtime};
use tauri_plugin_updater::UpdaterExt;

const TAURI_UPDATER_ENDPOINT: &str =
    "https://github.com/liubaicai/ShellDesk/releases/latest/download/latest.json";

fn tauri_updater_public_key() -> Option<String> {
    option_env!("TAURI_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            std::env::var("TAURI_UPDATER_PUBLIC_KEY")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

fn auto_update_support() -> (bool, String) {
    auto_update_support_for(
        std::env::consts::OS,
        cfg!(debug_assertions),
        std::env::var("APPIMAGE").is_ok(),
        tauri_updater_public_key().is_some(),
    )
}

fn auto_update_support_for(
    platform: &str,
    debug_build: bool,
    appimage: bool,
    has_public_key: bool,
) -> (bool, String) {
    if debug_build {
        return (
            false,
            "开发环境不支持自动下载更新，打包后可使用自动更新。".to_string(),
        );
    }
    let platform_supported = match platform {
        "windows" | "macos" => true,
        "linux" => appimage,
        _ => false,
    };
    if !platform_supported {
        let reason = if platform == "linux" {
            "当前 Linux 安装包格式不支持自动更新，请打开 Release 手动下载。"
        } else {
            "当前平台不支持自动更新，请打开 Release 手动下载。"
        };
        return (false, reason.to_string());
    }
    if !has_public_key {
        return (false, "更新模块未配置公钥。".to_string());
    }
    (true, String::new())
}

fn tauri_updater(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Updater>, String> {
    let Some(public_key) = tauri_updater_public_key() else {
        return Ok(None);
    };
    let endpoint = reqwest::Url::parse(TAURI_UPDATER_ENDPOINT).map_err(error_string)?;
    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(error_string)?
        .build()
        .map_err(error_string)?;
    Ok(Some(updater))
}

async fn check_tauri_update(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let Some(updater) = tauri_updater(&app)? else {
        return Ok(None);
    };
    let current_version = app.package_info().version.to_string();
    let checked_at = now();
    match updater.check().await.map_err(error_string)? {
        Some(update) => Ok(Some(json!({
            "repository": "liubaicai/ShellDesk",
            "currentVersion": update.current_version,
            "latestVersion": update.version,
            "updateAvailable": true,
            "releaseName": update
                .body
                .as_deref()
                .unwrap_or(""),
            "releaseTag": format!("v{}", update.version),
            "releaseUrl": "https://github.com/liubaicai/ShellDesk/releases/latest",
            "releaseDate": update
                .date
                .map(|date| date.to_string())
                .unwrap_or_default(),
            "latestYmlUrl": TAURI_UPDATER_ENDPOINT,
            "downloadName": update
                .download_url
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .unwrap_or("ShellDesk-update"),
            "downloadUrl": update.download_url.to_string(),
            "downloadSize": 0,
            "checkedAt": checked_at,
            "source": "tauri"
        }))),
        None => Ok(Some(json!({
            "repository": "liubaicai/ShellDesk",
            "currentVersion": current_version,
            "latestVersion": current_version,
            "updateAvailable": false,
            "releaseName": "",
            "releaseTag": "",
            "releaseUrl": "https://github.com/liubaicai/ShellDesk/releases/latest",
            "releaseDate": null,
            "latestYmlUrl": TAURI_UPDATER_ENDPOINT,
            "downloadName": "",
            "downloadUrl": null,
            "downloadSize": 0,
            "checkedAt": checked_at,
            "source": "tauri"
        }))),
    }
}

pub(crate) async fn check_release_info(app: tauri::AppHandle) -> Result<Value, String> {
    match check_tauri_update(app.clone()).await {
        Ok(Some(update)) => Ok(update),
        Ok(None) => check_github_release(app).await,
        Err(_) => check_github_release(app).await,
    }
}

async fn check_github_release(app: tauri::AppHandle) -> Result<Value, String> {
    let current_version = app.package_info().version.to_string();
    let checked_at = now();
    let release = fetch_latest_release().await?;
    let latest_version = release
        .get("tag_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let asset = select_release_asset(&release).unwrap_or_else(|| json!({}));
    Ok(json!({
        "repository": "liubaicai/ShellDesk",
        "currentVersion": current_version,
        "latestVersion": latest_version,
        "updateAvailable": !latest_version.is_empty() && compare_versions(&latest_version, &current_version) > 0,
        "releaseName": release.get("name").and_then(Value::as_str).unwrap_or(""),
        "releaseTag": release.get("tag_name").and_then(Value::as_str).unwrap_or(""),
        "releaseUrl": release.get("html_url").and_then(Value::as_str).unwrap_or(""),
        "releaseDate": release.get("published_at").cloned().unwrap_or(Value::Null),
        "latestYmlUrl": "",
        "downloadName": asset.get("name").and_then(Value::as_str).unwrap_or(""),
        "downloadUrl": asset.get("browser_download_url").cloned().unwrap_or(Value::Null),
        "downloadSize": asset.get("size").and_then(Value::as_i64).unwrap_or(0),
        "checkedAt": checked_at
    }))
}

async fn fetch_latest_release() -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("ShellDesk-Tauri-Updater")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(error_string)?;
    let response = client
        .get("https://api.github.com/repos/liubaicai/ShellDesk/releases/latest")
        .send()
        .await
        .map_err(error_string)?;
    if !response.status().is_success() {
        return Err(format!("检查更新失败：{}", response.status()));
    }
    response.json().await.map_err(error_string)
}

fn select_release_asset(release: &Value) -> Option<Value> {
    let assets = release.get("assets").and_then(Value::as_array)?;
    select_release_asset_for_platform(assets, std::env::consts::OS, std::env::consts::ARCH)
}

fn select_release_asset_for_platform(
    assets: &[Value],
    platform: &str,
    arch: &str,
) -> Option<Value> {
    assets
        .iter()
        .filter_map(|asset| {
            let name = asset.get("name").and_then(Value::as_str)?;
            let url = asset.get("browser_download_url").and_then(Value::as_str)?;
            if name.is_empty() || url.is_empty() {
                return None;
            }
            score_release_asset(name, platform, arch).map(|score| (asset, score))
        })
        .max_by(|(left_asset, left_score), (right_asset, right_score)| {
            left_score.cmp(right_score).then_with(|| {
                let left_name = left_asset.get("name").and_then(Value::as_str).unwrap_or("");
                let right_name = right_asset
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                right_name.to_lowercase().cmp(&left_name.to_lowercase())
            })
        })
        .map(|(asset, _)| asset.clone())
}

fn score_release_asset(name: &str, platform: &str, arch: &str) -> Option<i32> {
    let lower = name.to_lowercase();
    if is_metadata_asset(&lower) || has_conflicting_platform(&lower, platform) {
        return None;
    }
    let extension_score = platform_extension_score(&lower, platform)?;
    let platform_score = if has_platform_hint(&lower, platform) {
        100
    } else {
        60
    };
    Some(platform_score + extension_score + arch_score(&lower, arch))
}

fn is_metadata_asset(lower_name: &str) -> bool {
    lower_name == "latest.json"
        || lower_name.ends_with(".yml")
        || lower_name.ends_with(".yaml")
        || lower_name.ends_with(".blockmap")
        || lower_name.ends_with(".sig")
}

fn platform_extension_score(lower_name: &str, platform: &str) -> Option<i32> {
    match platform {
        "windows" => {
            if lower_name.ends_with(".exe") {
                Some(80)
            } else if lower_name.ends_with(".msi") {
                Some(70)
            } else {
                None
            }
        }
        "macos" => {
            if lower_name.ends_with(".dmg") {
                Some(80)
            } else if lower_name.ends_with(".app.tar.gz") {
                Some(50)
            } else {
                None
            }
        }
        "linux" => {
            if lower_name.ends_with(".appimage") {
                Some(80)
            } else if lower_name.ends_with(".appimage.tar.gz") {
                Some(50)
            } else if lower_name.ends_with(".deb") {
                Some(70)
            } else if lower_name.ends_with(".rpm") {
                Some(60)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn has_platform_hint(lower_name: &str, platform: &str) -> bool {
    match platform {
        "windows" => {
            lower_name.contains("windows")
                || lower_name.contains("win32")
                || lower_name.contains("-win")
                || lower_name.ends_with(".exe")
                || lower_name.ends_with(".msi")
        }
        "macos" => {
            lower_name.contains("macos")
                || lower_name.contains("darwin")
                || lower_name.contains("-mac")
                || lower_name.ends_with(".dmg")
        }
        "linux" => {
            lower_name.contains("linux")
                || lower_name.ends_with(".appimage")
                || lower_name.ends_with(".appimage.tar.gz")
        }
        _ => false,
    }
}

fn has_conflicting_platform(lower_name: &str, platform: &str) -> bool {
    match platform {
        "windows" => {
            lower_name.contains("macos")
                || lower_name.contains("darwin")
                || lower_name.contains("linux")
                || lower_name.ends_with(".dmg")
                || lower_name.ends_with(".appimage")
                || lower_name.ends_with(".deb")
                || lower_name.ends_with(".rpm")
        }
        "macos" => {
            lower_name.contains("windows")
                || lower_name.contains("win32")
                || lower_name.contains("linux")
                || lower_name.ends_with(".exe")
                || lower_name.ends_with(".msi")
                || lower_name.ends_with(".appimage")
                || lower_name.ends_with(".deb")
                || lower_name.ends_with(".rpm")
        }
        "linux" => {
            lower_name.contains("windows")
                || lower_name.contains("win32")
                || lower_name.contains("macos")
                || lower_name.contains("darwin")
                || lower_name.ends_with(".exe")
                || lower_name.ends_with(".msi")
                || lower_name.ends_with(".dmg")
        }
        _ => false,
    }
}

fn arch_score(lower_name: &str, arch: &str) -> i32 {
    let arch_keys = release_asset_arch_keys(lower_name);
    if arch_keys.is_empty() {
        return 10;
    }
    let target = normalized_arch_key(arch);
    if arch_keys.iter().any(|key| key == &target) {
        80
    } else {
        -1000
    }
}

fn normalized_arch_key(arch: &str) -> String {
    match arch {
        "x86_64" | "amd64" | "x64" => "x64",
        "aarch64" | "arm64" => "arm64",
        "x86" | "i386" | "i686" | "ia32" => "ia32",
        "arm" | "armv7" | "armv7l" => "arm",
        other => other,
    }
    .to_string()
}

fn release_asset_arch_keys(lower_name: &str) -> Vec<String> {
    let mut keys = Vec::new();
    if contains_arch_token(lower_name, &["x64", "amd64", "x86_64"]) {
        keys.push("x64".to_string());
    }
    if contains_arch_token(lower_name, &["arm64", "aarch64"]) {
        keys.push("arm64".to_string());
    }
    if contains_arch_token(lower_name, &["ia32", "i386", "i686"]) {
        keys.push("ia32".to_string());
    }
    if contains_arch_token(lower_name, &["armv7", "armv7l", "arm32"]) {
        keys.push("arm".to_string());
    }
    keys
}

fn contains_arch_token(lower_name: &str, tokens: &[&str]) -> bool {
    tokens.iter().any(|token| {
        lower_name.match_indices(token).any(|(index, _)| {
            let before = lower_name[..index].chars().next_back();
            let after = lower_name[index + token.len()..].chars().next();
            before.is_none_or(|ch| !ch.is_ascii_alphanumeric())
                && after.is_none_or(|ch| !ch.is_ascii_alphanumeric())
        })
    })
}

fn compare_versions(left: &str, right: &str) -> i32 {
    let left = VersionParts::parse(left);
    let right = VersionParts::parse(right);
    for index in 0..left.numbers.len().max(right.numbers.len()) {
        let left_number = left.numbers.get(index).copied().unwrap_or(0);
        let right_number = right.numbers.get(index).copied().unwrap_or(0);
        match left_number.cmp(&right_number) {
            std::cmp::Ordering::Greater => return 1,
            std::cmp::Ordering::Less => return -1,
            std::cmp::Ordering::Equal => {}
        }
    }
    compare_prerelease(&left.prerelease, &right.prerelease)
}

#[derive(Debug, PartialEq, Eq)]
struct VersionParts {
    numbers: Vec<i64>,
    prerelease: Vec<String>,
}

impl VersionParts {
    fn parse(value: &str) -> Self {
        let without_build = value
            .trim()
            .trim_start_matches('v')
            .trim_start_matches('V')
            .split_once('+')
            .map(|(version, _)| version)
            .unwrap_or_else(|| value.trim().trim_start_matches('v').trim_start_matches('V'));
        let (main_version, prerelease) =
            without_build.split_once('-').unwrap_or((without_build, ""));
        let numbers = main_version
            .split('.')
            .map(|part| {
                part.chars()
                    .take_while(|ch| ch.is_ascii_digit())
                    .collect::<String>()
                    .parse::<i64>()
                    .unwrap_or(0)
            })
            .collect::<Vec<_>>();
        let prerelease = prerelease
            .split('.')
            .filter(|part| !part.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        Self {
            numbers,
            prerelease,
        }
    }
}

fn compare_prerelease(left: &[String], right: &[String]) -> i32 {
    if left.is_empty() && right.is_empty() {
        return 0;
    }
    if left.is_empty() {
        return 1;
    }
    if right.is_empty() {
        return -1;
    }
    for index in 0..left.len().max(right.len()) {
        let Some(left_part) = left.get(index) else {
            return -1;
        };
        let Some(right_part) = right.get(index) else {
            return 1;
        };
        let comparison = compare_prerelease_identifier(left_part, right_part);
        if comparison != 0 {
            return comparison;
        }
    }
    0
}

fn compare_prerelease_identifier(left: &str, right: &str) -> i32 {
    let left_number = left.parse::<i64>().ok();
    let right_number = right.parse::<i64>().ok();
    match (left_number, right_number) {
        (Some(left), Some(right)) => match left.cmp(&right) {
            std::cmp::Ordering::Greater => 1,
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
        },
        (Some(_), None) => -1,
        (None, Some(_)) => 1,
        (None, None) => match left.cmp(right) {
            std::cmp::Ordering::Greater => 1,
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
        },
    }
}

pub(crate) async fn check_for_update_download(
    state: AppState,
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    check_for_update_download_inner(state, window, app, false).await
}

async fn check_for_update_download_inner<R, W>(
    state: AppState,
    window: W,
    app: tauri::AppHandle,
    automatic: bool,
) -> Result<Value, String>
where
    R: Runtime,
    W: Emitter<R> + Clone + Send + Sync + 'static,
{
    let (supported, unsupported_reason) = auto_update_support();
    if automatic && !is_auto_update_enabled(&state) {
        return Ok(json!({
            "available": false,
            "supported": supported,
            "error": if supported { Value::Null } else { json!(unsupported_reason) },
            "checking": false,
            "downloading": false,
            "ready": false
        }));
    }
    if !supported {
        let status = update_status(
            "idle",
            &state.data_dir,
            &app.package_info().version.to_string(),
            None,
        );
        set_update_state(&state, status)?;
        return Ok(json!({
            "available": false,
            "supported": false,
            "error": unsupported_reason,
            "checking": false,
            "downloading": false,
            "ready": false
        }));
    }

    let checking = update_status(
        "idle",
        &state.data_dir,
        &app.package_info().version.to_string(),
        None,
    )
    .with_field("isChecking", json!(true));
    set_update_state(&state, checking)?;

    let release_info = check_release_info(app.clone()).await?;
    let available = release_info
        .get("updateAvailable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let version = release_info
        .get("latestVersion")
        .cloned()
        .unwrap_or(Value::Null);
    let status = if available { "available" } else { "idle" };
    let update_state = update_status(
        status,
        &state.data_dir,
        &app.package_info().version.to_string(),
        None,
    )
    .with_field("version", version.clone())
    .with_field(
        "releaseNotes",
        release_info
            .get("releaseName")
            .cloned()
            .unwrap_or(Value::Null),
    )
    .with_field(
        "releaseDate",
        release_info
            .get("releaseDate")
            .cloned()
            .unwrap_or(Value::Null),
    )
    .with_field(
        "downloadUrl",
        release_info
            .get("downloadUrl")
            .cloned()
            .unwrap_or(Value::Null),
    )
    .with_field(
        "downloadName",
        release_info
            .get("downloadName")
            .cloned()
            .unwrap_or(Value::Null),
    )
    .with_field("isChecking", json!(false));
    set_update_state(&state, update_state.clone())?;
    if available {
        let _ = window.emit("app:update:available", update_state);
    } else {
        let _ = window.emit("app:update:not-available", update_state);
    }

    if available {
        let download_result =
            download_tauri_update(state.clone(), window.clone(), app.clone()).await?;
        let success = download_result
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        return Ok(json!({
            "available": true,
            "supported": true,
            "checking": false,
            "downloading": false,
            "ready": success,
            "version": version,
            "releaseNotes": release_info.get("releaseName").cloned().unwrap_or(Value::Null),
            "releaseDate": release_info.get("releaseDate").cloned().unwrap_or(Value::Null),
            "error": download_result.get("error").cloned().unwrap_or(Value::Null)
        }));
    }

    Ok(json!({
        "available": available,
        "supported": true,
        "checking": false,
        "downloading": false,
        "ready": false,
        "version": version,
        "releaseNotes": release_info.get("releaseName").cloned().unwrap_or(Value::Null),
        "releaseDate": release_info.get("releaseDate").cloned().unwrap_or(Value::Null)
    }))
}

pub(crate) fn start_auto_update_check(
    state: AppState,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    delay: Duration,
) {
    let (supported, _) = auto_update_support();
    if !supported {
        return;
    }

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let _ = check_for_update_download_inner(state, window, app, true).await;
    });
}

fn is_auto_update_enabled(state: &AppState) -> bool {
    read_store(state)
        .ok()
        .as_ref()
        .map(auto_update_enabled_from_store)
        .unwrap_or(true)
}

fn auto_update_enabled_from_store(store: &Value) -> bool {
    store
        .pointer("/settings/autoUpdateEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub(crate) async fn download_update(
    state: AppState,
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let (supported, unsupported_reason) = auto_update_support();
    if !supported {
        let status = update_status(
            "error",
            &state.data_dir,
            &app.package_info().version.to_string(),
            Some(&unsupported_reason),
        );
        set_update_state(&state, status.clone())?;
        let _ = window.emit("app:update:error", status);
        return Ok(json!({ "success": false, "error": unsupported_reason }));
    }

    download_tauri_update(state, window, app).await
}

async fn download_tauri_update<R, W>(
    state: AppState,
    window: W,
    app: tauri::AppHandle,
) -> Result<Value, String>
where
    R: Runtime,
    W: Emitter<R> + Clone + Send + Sync + 'static,
{
    let Some(updater) = tauri_updater(&app)? else {
        return Ok(json!({ "success": false, "error": "更新模块未配置公钥。" }));
    };
    let Some(update) = updater.check().await.map_err(error_string)? else {
        return Ok(json!({ "success": false, "error": "当前已是最新版本。" }));
    };

    let version = update.version.clone();
    let updates_dir = state.data_dir.join("updates");
    fs::create_dir_all(&updates_dir).map_err(error_string)?;
    let file_path = updates_dir.join(format!(
        "tauri-{}-{}.update",
        std::env::consts::OS,
        sanitize_file_name(&version)
    ));
    let current_version = app.package_info().version.to_string();
    let downloading = update_status("downloading", &state.data_dir, &current_version, None)
        .with_field("version", json!(version.clone()))
        .with_field("percent", json!(0))
        .with_field("installer", json!("tauri-updater"));
    set_update_state(&state, downloading.clone())?;
    let _ = window.emit("app:update:download-progress", downloading);

    let progress_state = state.clone();
    let progress_window = window.clone();
    let progress_data_dir = state.data_dir.clone();
    let progress_current_version = current_version.clone();
    let progress_version = version.clone();
    let mut downloaded = 0u64;
    let bytes = match update
        .download(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let percent = content_length
                    .filter(|total| *total > 0)
                    .map(|total| ((downloaded as f64 / total as f64) * 100.0).round() as i64)
                    .unwrap_or(0)
                    .clamp(0, 99);
                let status = update_status(
                    "downloading",
                    &progress_data_dir,
                    &progress_current_version,
                    None,
                )
                .with_field("version", json!(progress_version.clone()))
                .with_field("percent", json!(percent))
                .with_field("installer", json!("tauri-updater"));
                let _ = set_update_state(&progress_state, status.clone());
                let _ = progress_window.emit("app:update:download-progress", status);
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            let error_message = error_string(error);
            let status = update_status(
                "error",
                &state.data_dir,
                &current_version,
                Some(&error_message),
            )
            .with_field("version", json!(version));
            set_update_state(&state, status.clone())?;
            let _ = window.emit("app:update:error", status);
            return Ok(json!({ "success": false, "error": error_message }));
        }
    };

    fs::write(&file_path, bytes).map_err(error_string)?;
    *state.pending_tauri_update.lock().map_err(error_string)? = Some(update);
    let ready = update_status("ready", &state.data_dir, &current_version, None)
        .with_field("version", json!(version))
        .with_field("percent", json!(100))
        .with_field("installer", json!("tauri-updater"))
        .with_field("filePath", json!(file_path.to_string_lossy().to_string()));
    set_update_state(&state, ready.clone())?;
    let _ = window.emit("app:update:downloaded", ready);
    Ok(json!({ "success": true }))
}

pub(crate) async fn install_update(
    state: AppState,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let (supported, unsupported_reason) = auto_update_support();
    if !supported {
        return Err(unsupported_reason);
    }
    let status = state.update_state.lock().map_err(error_string)?.clone();
    if status
        .get("installer")
        .and_then(Value::as_str)
        .is_some_and(|installer| installer == "tauri-updater")
    {
        let file_path = status
            .get("filePath")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "安装包尚未下载完成。".to_string())?;
        let bytes = fs::read(file_path).map_err(error_string)?;
        let Some(updater) = tauri_updater(&app)? else {
            return Err("更新模块未配置公钥。".to_string());
        };
        let update = state
            .pending_tauri_update
            .lock()
            .map_err(error_string)?
            .clone();
        let update = match update {
            Some(update) => update,
            None => updater
                .check()
                .await
                .map_err(error_string)?
                .ok_or_else(|| "未找到可安装的更新。".to_string())?,
        };
        update.install(bytes).map_err(error_string)?;
        return Ok(json!(true));
    }

    Err("未找到可由 Tauri 自动安装的更新。".to_string())
}

pub(crate) fn read_update_state(state: &AppState, app: &tauri::AppHandle) -> Value {
    state
        .update_state
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| {
            update_status(
                "idle",
                &state.data_dir,
                &app.package_info().version.to_string(),
                None,
            )
        })
}

fn set_update_state(state: &AppState, value: Value) -> Result<(), String> {
    *state.update_state.lock().map_err(error_string)? = value;
    Ok(())
}

trait JsonObjectExt {
    fn with_field(self, key: &str, value: Value) -> Value;
}

impl JsonObjectExt for Value {
    fn with_field(mut self, key: &str, value: Value) -> Value {
        self[key] = value;
        self
    }
}

pub(crate) fn update_status(
    status: &str,
    _data_dir: &Path,
    version: &str,
    error: Option<&str>,
) -> Value {
    let (supported, unsupported_reason) = auto_update_support();
    json!({
        "status": status,
        "percent": 0,
        "error": error,
        "version": version,
        "releaseNotes": "",
        "releaseDate": null,
        "isChecking": false,
        "supported": supported,
        "unsupportedReason": unsupported_reason,
        "checkedAt": now(),
        "filePath": null
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> Value {
        json!({
            "name": name,
            "browser_download_url": format!("https://example.test/{name}"),
            "size": 123
        })
    }

    #[test]
    fn compare_versions_handles_semver_ordering() {
        assert_eq!(compare_versions("1.2.4", "1.2.3"), 1);
        assert_eq!(compare_versions("v1.2.3", "1.2.3+build.4"), 0);
        assert_eq!(compare_versions("1.2.3", "1.2.4"), -1);
    }

    #[test]
    fn compare_versions_orders_prereleases_below_stable() {
        assert_eq!(compare_versions("1.0.0", "1.0.0-beta.2"), 1);
        assert_eq!(compare_versions("1.0.0-beta.2", "1.0.0-beta.1"), 1);
        assert_eq!(compare_versions("1.0.0-beta.1", "1.0.0"), -1);
    }

    #[test]
    fn auto_update_enabled_defaults_to_true_and_respects_setting() {
        assert!(auto_update_enabled_from_store(&json!({})));
        assert!(auto_update_enabled_from_store(&json!({
            "settings": { "autoUpdateEnabled": true }
        })));
        assert!(!auto_update_enabled_from_store(&json!({
            "settings": { "autoUpdateEnabled": false }
        })));
    }

    #[test]
    fn auto_update_support_matches_legacy_packaging_rules() {
        assert_eq!(
            auto_update_support_for("windows", true, false, true),
            (
                false,
                "开发环境不支持自动下载更新，打包后可使用自动更新。".to_string()
            )
        );
        assert_eq!(
            auto_update_support_for("linux", false, false, true),
            (
                false,
                "当前 Linux 安装包格式不支持自动更新，请打开 Release 手动下载。".to_string()
            )
        );
        assert_eq!(
            auto_update_support_for("windows", false, false, false),
            (false, "更新模块未配置公钥。".to_string())
        );
        assert_eq!(
            auto_update_support_for("macos", false, false, true),
            (true, String::new())
        );
        assert_eq!(
            auto_update_support_for("linux", false, true, true),
            (true, String::new())
        );
    }

    #[test]
    fn select_release_asset_ignores_metadata_for_windows() {
        let assets = vec![
            asset("latest.json"),
            asset("latest.yml"),
            asset("ShellDesk_1.2.3_x64_en-US.msi.blockmap"),
            asset("ShellDesk_1.2.3_x64-setup.exe"),
            asset("ShellDesk_1.2.3_x64_en-US.msi"),
        ];
        let selected = select_release_asset_for_platform(&assets, "windows", "x86_64").unwrap();
        assert_eq!(
            selected.get("name").and_then(Value::as_str),
            Some("ShellDesk_1.2.3_x64-setup.exe")
        );
    }

    #[test]
    fn select_release_asset_filters_conflicting_platforms() {
        let assets = vec![
            asset("ShellDesk_1.2.3_windows_x64-setup.exe"),
            asset("ShellDesk_1.2.3_macos_aarch64.dmg"),
            asset("ShellDesk_1.2.3_linux_x64.AppImage"),
        ];
        let selected = select_release_asset_for_platform(&assets, "linux", "x86_64").unwrap();
        assert_eq!(
            selected.get("name").and_then(Value::as_str),
            Some("ShellDesk_1.2.3_linux_x64.AppImage")
        );
    }

    #[test]
    fn select_release_asset_prefers_matching_architecture() {
        let assets = vec![
            asset("ShellDesk_1.2.3_linux_arm64.AppImage"),
            asset("ShellDesk_1.2.3_linux_x86_64.AppImage"),
        ];
        let selected = select_release_asset_for_platform(&assets, "linux", "x86_64").unwrap();
        assert_eq!(
            selected.get("name").and_then(Value::as_str),
            Some("ShellDesk_1.2.3_linux_x86_64.AppImage")
        );
    }

    #[test]
    fn select_release_asset_accepts_tauri_linux_updater_archives() {
        let assets = vec![
            asset("ShellDesk_1.2.3_x86_64.AppImage.tar.gz.sig"),
            asset("ShellDesk_1.2.3_x86_64.AppImage.tar.gz"),
        ];
        let selected = select_release_asset_for_platform(&assets, "linux", "x86_64").unwrap();
        assert_eq!(
            selected.get("name").and_then(Value::as_str),
            Some("ShellDesk_1.2.3_x86_64.AppImage.tar.gz")
        );
    }

    #[test]
    fn select_release_asset_prefers_manual_appimage_over_updater_archive() {
        let assets = vec![
            asset("ShellDesk_1.2.3_x86_64.AppImage.tar.gz"),
            asset("ShellDesk_1.2.3_x86_64.AppImage"),
        ];
        let selected = select_release_asset_for_platform(&assets, "linux", "x86_64").unwrap();
        assert_eq!(
            selected.get("name").and_then(Value::as_str),
            Some("ShellDesk_1.2.3_x86_64.AppImage")
        );
    }
}
