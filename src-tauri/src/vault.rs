use serde_json::{json, Value};
use std::env;

use crate::{error_string, now, random_id, vault_storage, AppState};

pub(crate) fn with_store_mut<R, F>(state: &AppState, mutate: F) -> Result<R, String>
where
    F: FnOnce(&mut Value) -> Result<R, String>,
{
    let _guard = state.store_lock.lock().map_err(error_string)?;
    let mut store = read_store(state)?;
    let result = mutate(&mut store)?;
    write_store(state, &store)?;
    Ok(result)
}

const MAX_PRIVATE_KEY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PUBLIC_KEY_BYTES: u64 = 128 * 1024;

fn default_store(state: &AppState) -> Value {
    json!({
        "hosts": [],
        "sshKeys": [],
        "proxyProfiles": [],
        "knownHosts": [],
        "settings": default_settings(),
        "browserBookmarks": [],
        "remoteConnectionProfiles": {},
        "preferences": {},
        "storage": storage_info(state)
    })
}

// 默认设置定义（唯一权威源）。
// 前端 App.tsx::defaultAppSettings 和 tauriBridge.ts::createPreviewSettings 为同步 fallback。
// 修改此处后需同步更新前端两处，或运行一致性检查：node scripts/check-default-settings-parity.cjs
pub(crate) fn default_settings() -> Value {
    let language = default_language();
    json!({
        "language": language,
        "interfaceFont": "Microsoft YaHei UI",
        "theme": "dark",
        "accentColor": "#0f6bff",
        "defaultHostView": "grid",
        "minimizeToTrayOnClose": true,
        "autoUpdateEnabled": true,
        "desktopWallpaperMode": "preset",
        "desktopWallpaperPresetId": "default",
        "desktopWallpaperDataUrl": "",
        "desktopWallpaperName": "",
        "remoteDesktopLayout": {
            "appCatalogVersion": 9,
            "sortMode": "custom",
            "items": [
                { "id": "app:files", "type": "app", "appKey": "files" },
                { "id": "app:terminal", "type": "app", "appKey": "terminal" },
                { "id": "app:browser", "type": "app", "appKey": "browser" },
                { "id": "app:settings", "type": "app", "appKey": "settings" }
            ],
            "removedAppKeys": []
        },
        "rememberPasswords": true,
        "rememberKeyPassphrases": true,
        "aiProvider": "openai",
        "aiProviderName": "OpenAI",
        "aiApiFormat": "openai",
        "aiApiBaseUrl": "https://api.openai.com/v1",
        "aiApiKey": "",
        "aiModel": "",
        "webSearchEnabled": false,
        "webSearchProvider": "tavily",
        "webSearchApiKey": "",
        "webSearchApiBaseUrl": "https://api.tavily.com",
        "webSearchMaxResults": 5,
        "terminalFontSize": 13,
        "terminalFontFamily": "Cascadia Mono",
        "terminalFontWeight": 400,
        "terminalFontWeightBold": 700,
        "terminalLigatures": true,
        "terminalFontLigatures": true,
        "terminalLineHeight": 1.2,
        "terminalTheme": "shelldesk-dark",
        "terminalCursorBlink": true,
        "terminalCursorStyle": "block",
        "terminalCursorInactiveStyle": "outline",
        "terminalScrollback": 10000,
        "terminalScrollSensitivity": 1,
        "terminalFastScrollSensitivity": 5,
        "terminalScrollOnUserInput": true,
        "terminalScrollOnEraseInDisplay": true,
        "terminalCopyOnSelect": true,
        "terminalRightClickPaste": true,
        "terminalAltClickMovesCursor": true,
        "terminalBracketedPasteMode": true,
        "terminalMinimumContrastRatio": 1,
        "terminalScreenReaderMode": false,
        "terminalSnippets": default_terminal_snippets(language)
    })
}

fn default_terminal_snippets(language: &str) -> Value {
    let is_chinese = language == "zh-CN";
    let group = if is_chinese {
        "常用巡检"
    } else {
        "Common Checks"
    };
    let snippets = if is_chinese {
        vec![
            ("system-overview", "系统概览", "uname -a && uptime"),
            ("disk-usage", "磁盘占用", "df -h"),
            ("memory-usage", "内存占用", "free -h"),
            (
                "listening-ports",
                "监听端口",
                "ss -tulpen || netstat -tulpen",
            ),
            ("recent-logins", "最近登录", "last -a | head -20"),
        ]
    } else {
        vec![
            ("system-overview", "System overview", "uname -a && uptime"),
            ("disk-usage", "Disk usage", "df -h"),
            ("memory-usage", "Memory usage", "free -h"),
            (
                "listening-ports",
                "Listening ports",
                "ss -tulpen || netstat -tulpen",
            ),
            ("recent-logins", "Recent logins", "last -a | head -20"),
        ]
    };
    Value::Array(
        snippets
            .into_iter()
            .map(|(id, label, command)| {
                json!({
                    "id": format!("builtin:{id}"),
                    "label": label,
                    "command": command,
                    "group": group,
                    "shortcut": "",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                })
            })
            .collect(),
    )
}

fn default_language() -> &'static str {
    detect_system_language().unwrap_or("en-US")
}

fn detect_system_language() -> Option<&'static str> {
    for key in [
        "SHELLDESK_LANGUAGE",
        "LC_ALL",
        "LC_MESSAGES",
        "LANG",
        "LANGUAGE",
    ] {
        if let Ok(value) = env::var(key) {
            if let Some(language) = language_from_locale(&value) {
                return Some(language);
            }
        }
    }
    platform_system_language()
}

fn language_from_locale(locale: &str) -> Option<&'static str> {
    let normalized = locale.trim().replace('_', "-").to_ascii_lowercase();
    if normalized.is_empty() || normalized == "c" || normalized == "posix" {
        return None;
    }
    let primary = normalized
        .split(['-', '.', '@', ':'])
        .next()
        .unwrap_or("")
        .trim();
    if primary == "zh" {
        Some("zh-CN")
    } else {
        Some("en-US")
    }
}

#[cfg(windows)]
fn platform_system_language() -> Option<&'static str> {
    use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
    let language_id = unsafe { GetUserDefaultUILanguage() };
    let primary_language = language_id & 0x03ff;
    if primary_language == 0x04 {
        Some("zh-CN")
    } else if language_id != 0 {
        Some("en-US")
    } else {
        None
    }
}

#[cfg(not(windows))]
fn platform_system_language() -> Option<&'static str> {
    None
}

fn storage_info(state: &AppState) -> Value {
    vault_storage::storage_info(state)
}

pub(crate) fn read_store(state: &AppState) -> Result<Value, String> {
    let defaults = default_store(state);
    let (mut store, should_rewrite) = vault_storage::read_store(state, defaults.clone())?;
    merge_defaults(&mut store, defaults);
    store["storage"] = storage_info(state);
    if should_rewrite {
        write_store(state, &store)?;
    }
    Ok(store)
}

pub(crate) fn write_store(state: &AppState, store: &Value) -> Result<(), String> {
    vault_storage::write_store(state, store)
}

pub(crate) fn snapshot(state: &AppState) -> Result<Value, String> {
    let store = read_store(state)?;
    Ok(to_snapshot(state, store))
}

pub(crate) fn public_snapshot(state: &AppState) -> Result<Value, String> {
    let store = read_store(state)?;
    Ok(to_public_snapshot(state, store))
}

pub(crate) fn to_snapshot(state: &AppState, store: Value) -> Value {
    json!({
        "hosts": store.get("hosts").cloned().unwrap_or_else(|| json!([])),
        "sshKeys": public_ssh_keys(store.get("sshKeys")),
        "proxyProfiles": store.get("proxyProfiles").cloned().unwrap_or_else(|| json!([])),
        "knownHosts": store.get("knownHosts").cloned().unwrap_or_else(|| json!([])),
        "settings": store.get("settings").cloned().unwrap_or_else(default_settings),
        "browserBookmarks": store.get("browserBookmarks").cloned().unwrap_or_else(|| json!([])),
        "storage": storage_info(state)
    })
}

fn to_public_snapshot(state: &AppState, store: Value) -> Value {
    json!({
        "hosts": public_hosts(store.get("hosts")),
        "sshKeys": public_ssh_keys_without_secrets(store.get("sshKeys")),
        "proxyProfiles": public_proxy_profiles(store.get("proxyProfiles")),
        "knownHosts": store.get("knownHosts").cloned().unwrap_or_else(|| json!([])),
        "settings": public_settings(store.get("settings").cloned().unwrap_or_else(default_settings)),
        "browserBookmarks": store.get("browserBookmarks").cloned().unwrap_or_else(|| json!([])),
        "storage": storage_info(state)
    })
}

fn public_hosts(hosts: Option<&Value>) -> Value {
    let items = hosts.and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .map(|mut item| {
                if let Some(object) = item.as_object_mut() {
                    object.insert("password".to_string(), json!(""));
                    object.insert("passphrase".to_string(), json!(""));
                    object.insert("rootPassword".to_string(), json!(""));
                }
                item
            })
            .collect(),
    )
}

fn public_ssh_keys(keys: Option<&Value>) -> Value {
    let items = keys.and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .map(|mut item| {
                if let Some(object) = item.as_object_mut() {
                    object.remove("privateKey");
                }
                item
            })
            .collect(),
    )
}

fn public_ssh_keys_without_secrets(keys: Option<&Value>) -> Value {
    let items = keys.and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .map(|mut item| {
                if let Some(object) = item.as_object_mut() {
                    object.remove("privateKey");
                    object.insert("passphrase".to_string(), json!(""));
                }
                item
            })
            .collect(),
    )
}

fn public_proxy_profiles(profiles: Option<&Value>) -> Value {
    let items = profiles
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .map(|mut item| {
                if let Some(config) = item
                    .as_object_mut()
                    .and_then(|object| object.get_mut("config"))
                    .and_then(Value::as_object_mut)
                {
                    config.insert("password".to_string(), json!(""));
                }
                item
            })
            .collect(),
    )
}

fn public_settings(mut settings: Value) -> Value {
    if let Some(object) = settings.as_object_mut() {
        object.insert("aiApiKey".to_string(), json!(""));
        object.insert("webSearchApiKey".to_string(), json!(""));
    }
    settings
}

pub(crate) fn upsert_vault_collections(
    store: &mut Value,
    raw_payload: Value,
) -> Result<(), String> {
    let Some(payload) = raw_payload.as_object() else {
        return Err("本地数据无效。".to_string());
    };

    let Some(store_object) = store.as_object_mut() else {
        return Err("本地数据无效。".to_string());
    };

    if let Some(value) = payload.get("hosts").filter(|value| value.is_array()) {
        store_object.insert("hosts".to_string(), normalize_hosts(value)?);
    }

    if let Some(value) = payload
        .get("proxyProfiles")
        .filter(|value| value.is_array())
    {
        store_object.insert(
            "proxyProfiles".to_string(),
            normalize_proxy_profiles(value)?,
        );
    }

    if let Some(value) = payload.get("knownHosts").filter(|value| value.is_array()) {
        store_object.insert("knownHosts".to_string(), normalize_known_hosts(value)?);
    }

    if let Some(value) = payload.get("settings") {
        store_object.insert("settings".to_string(), normalize_app_settings(value)?);
    }

    if let Some(value) = payload.get("sshKeys").filter(|value| value.is_array()) {
        let merged = normalize_ssh_keys_for_store(store_object.get("sshKeys"), value)?;
        store_object.insert("sshKeys".to_string(), merged);
    }

    Ok(())
}

#[path = "vault/bookmarks.rs"]
mod bookmarks;
#[path = "vault/normalize.rs"]
mod normalize;
#[path = "vault/preferences.rs"]
mod preferences;
#[path = "vault/remote_profiles.rs"]
mod remote_profiles;
#[path = "vault/ssh_keys.rs"]
mod ssh_keys;
#[path = "vault/validation.rs"]
mod validation;

pub(crate) use bookmarks::{get_bookmarks, save_bookmarks_to_store};
pub(crate) use normalize::{
    normalize_app_settings, normalize_hosts, normalize_known_hosts, normalize_proxy_profiles,
    normalize_ssh_keys_for_import, normalize_ssh_keys_for_store,
};
pub(crate) use preferences::{get_preference, set_preference_to_store};
#[cfg(test)]
use remote_profiles::read_remote_connection_profile_values;
use remote_profiles::REMOTE_DESKTOP_APP_KEYS;
pub(crate) use remote_profiles::{
    get_remote_connection_profile, save_remote_connection_profile_to_store,
};
#[cfg(test)]
use ssh_keys::{
    ensure_unique_ssh_key, public_key_algorithm, public_key_fingerprint, renderer_key_record,
};
pub(crate) use ssh_keys::{generate_key_pair, import_key_pair, merge_private_key_fields};
use validation::{clone_json_with_size_limit, read_bounded_string, read_bounded_string_value};
fn merge_defaults(target: &mut Value, defaults: Value) {
    let Some(target_object) = target.as_object_mut() else {
        *target = defaults;
        return;
    };
    if let Some(default_object) = defaults.as_object() {
        for (key, value) in default_object {
            match target_object.get_mut(key) {
                Some(existing) if existing.is_object() && value.is_object() => {
                    merge_defaults(existing, value.clone());
                }
                Some(_) => {}
                None => {
                    target_object.insert(key.clone(), value.clone());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSA_PUBLIC_KEY: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7";

    #[test]
    fn public_key_fingerprint_matches_openssh_sha256_format() {
        assert_eq!(
            public_key_fingerprint(RSA_PUBLIC_KEY),
            Some("SHA256:HPlRPaJS3AalL0f2B3TkvOVkd9tmwMs8k9hR+TLJWRQ".to_string())
        );
        assert_eq!(public_key_algorithm(RSA_PUBLIC_KEY), Some("ssh-rsa"));
    }

    #[test]
    fn renderer_key_record_removes_private_key() {
        let key = renderer_key_record(json!({
            "id": "key-1",
            "name": "prod",
            "privateKey": "private",
            "publicKey": RSA_PUBLIC_KEY
        }));
        assert!(key.get("privateKey").is_none());
        assert_eq!(key["publicKey"], RSA_PUBLIC_KEY);
    }

    #[test]
    fn public_snapshot_helpers_remove_secrets() {
        let hosts = public_hosts(Some(&json!([{
            "id": "host-1",
            "password": "secret",
            "passphrase": "phrase",
            "rootPassword": "root"
        }])));
        assert_eq!(hosts[0]["password"], "");
        assert_eq!(hosts[0]["passphrase"], "");
        assert_eq!(hosts[0]["rootPassword"], "");

        let keys = public_ssh_keys_without_secrets(Some(&json!([{
            "id": "key-1",
            "privateKey": "private",
            "passphrase": "phrase",
            "publicKey": RSA_PUBLIC_KEY
        }])));
        assert!(keys[0].get("privateKey").is_none());
        assert_eq!(keys[0]["passphrase"], "");
        assert_eq!(keys[0]["publicKey"], RSA_PUBLIC_KEY);

        let profiles = public_proxy_profiles(Some(&json!([{
            "id": "proxy-1",
            "config": { "type": "http", "password": "secret" }
        }])));
        assert_eq!(profiles[0]["config"]["password"], "");

        let settings = public_settings(json!({
            "aiApiKey": "sk-test",
            "webSearchApiKey": "tvly-test",
            "language": "zh-CN"
        }));
        assert_eq!(settings["aiApiKey"], "");
        assert_eq!(settings["webSearchApiKey"], "");
        assert_eq!(settings["language"], "zh-CN");
    }

    #[test]
    fn default_settings_preserve_legacy_host_view() {
        let settings = default_settings();
        assert_eq!(settings["defaultHostView"], "grid");
        assert!(settings["autoUpdateEnabled"].as_bool().unwrap_or(false));
        assert_eq!(settings["terminalSnippets"].as_array().unwrap().len(), 5);
        assert_eq!(
            settings["terminalSnippets"][0]["id"],
            "builtin:system-overview"
        );
    }

    #[test]
    fn normalize_app_settings_migrates_openai_compatible_provider_to_custom() {
        let settings = normalize_app_settings(&json!({
            "aiProvider": "openai-compatible",
            "aiProviderName": "",
            "aiApiFormat": "openai",
            "aiApiBaseUrl": "https://example.com/v1",
            "aiModel": "example-model"
        }))
        .unwrap();

        assert_eq!(settings["aiProvider"], "custom");
        assert_eq!(settings["aiProviderName"], "自定义提供商");
        assert_eq!(settings["aiApiFormat"], "openai");
        assert_eq!(settings["aiApiBaseUrl"], "https://example.com/v1");
        assert_eq!(settings["aiModel"], "example-model");
    }

    #[test]
    fn normalize_app_settings_matches_legacy_ranges_and_fallbacks() {
        let settings = normalize_app_settings(&json!({
            "language": "fr-FR",
            "interfaceFont": "  Cascadia   Code  ",
            "theme": "blue",
            "accentColor": "#ABCDEF",
            "defaultHostView": "table",
            "minimizeToTrayOnClose": "yes",
            "autoUpdateEnabled": false,
            "desktopWallpaperMode": "custom",
            "desktopWallpaperPresetId": "missing",
            "desktopWallpaperDataUrl": "",
            "remoteDesktopLayout": {
                "appCatalogVersion": 9,
                "sortMode": "bad",
                "items": [
                    { "type": "app", "appKey": "terminal" },
                    { "type": "app", "appKey": "terminal" },
                    { "type": "app", "appKey": "bad-app" },
                    { "type": "folder", "id": "", "name": "", "appKeys": ["files", "bad-app", "terminal"] }
                ],
                "removedAppKeys": ["browser", "terminal", "bad-app", "browser"]
            },
            "rememberPasswords": false,
            "aiProvider": "anthropic",
            "aiProviderName": "",
            "terminalFontSize": 99,
            "terminalFontFamily": "  JetBrains   Mono  ",
            "terminalFontWeight": 200,
            "terminalFontWeightBold": 900,
            "terminalLineHeight": 2,
            "terminalTheme": "unknown",
            "terminalCursorStyle": "block",
            "terminalCursorInactiveStyle": "bad",
            "terminalScrollback": 1,
            "terminalScrollSensitivity": 9,
            "terminalFastScrollSensitivity": 1,
            "terminalMinimumContrastRatio": 9,
            "terminalSnippets": [
                { "id": "same", "label": "", "command": "ignored" },
                { "id": "same", "label": "Deploy", "command": "echo ok\n", "shortcut": "Ctrl+ Shift + D" },
                { "id": "same", "label": "Logs", "command": "tail -f app.log" }
            ]
        }))
        .unwrap();

        assert!(matches!(
            settings["language"].as_str(),
            Some("zh-CN" | "en-US")
        ));
        assert_eq!(settings["interfaceFont"], "Cascadia Code");
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["accentColor"], "#abcdef");
        assert_eq!(settings["defaultHostView"], "grid");
        assert_eq!(settings["minimizeToTrayOnClose"], true);
        assert_eq!(settings["autoUpdateEnabled"], false);
        assert_eq!(settings["desktopWallpaperMode"], "preset");
        assert_eq!(settings["desktopWallpaperPresetId"], "default");
        assert_eq!(settings["remoteDesktopLayout"]["sortMode"], "custom");
        assert_eq!(
            settings["remoteDesktopLayout"]["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            settings["remoteDesktopLayout"]["items"][0]["appKey"],
            "terminal"
        );
        assert_eq!(
            settings["remoteDesktopLayout"]["items"][1]["appKeys"],
            json!(["files"])
        );
        assert_eq!(
            settings["remoteDesktopLayout"]["removedAppKeys"],
            json!(["browser"])
        );
        assert_eq!(settings["aiProvider"], "anthropic");
        assert_eq!(settings["aiApiFormat"], "anthropic");
        assert_eq!(settings["aiApiBaseUrl"], "https://api.anthropic.com");
        assert_eq!(settings["aiProviderName"], "Claude / Anthropic");
        assert_eq!(settings["terminalFontSize"], 13);
        assert_eq!(settings["terminalFontFamily"], "JetBrains Mono");
        assert_eq!(settings["terminalFontWeight"], 400);
        assert_eq!(settings["terminalFontWeightBold"], 700);
        assert_eq!(settings["terminalLineHeight"], 1.2);
        assert_eq!(settings["terminalTheme"], "shelldesk-dark");
        assert_eq!(settings["terminalCursorStyle"], "block");
        assert_eq!(settings["terminalCursorInactiveStyle"], "outline");
        assert_eq!(settings["terminalScrollback"], 10000);
        assert_eq!(settings["terminalScrollSensitivity"], 1.0);
        assert_eq!(settings["terminalFastScrollSensitivity"], 5);
        assert_eq!(settings["terminalMinimumContrastRatio"], 1.0);
        let snippets = settings["terminalSnippets"].as_array().unwrap();
        assert_eq!(snippets.len(), 2);
        assert_eq!(snippets[0]["id"], "same");
        assert_ne!(snippets[1]["id"], "same");
        assert_eq!(snippets[0]["command"], "echo ok");
        assert_eq!(snippets[0]["shortcut"], "Ctrl + Shift + D");
    }

    #[test]
    fn normalize_app_settings_rejects_invalid_urls_and_wallpapers() {
        assert_eq!(
            normalize_app_settings(&json!({ "aiApiBaseUrl": "ftp://example.com" })).unwrap_err(),
            "AI API 地址只支持 http 或 https。"
        );
        assert_eq!(
            normalize_app_settings(&json!({
                "desktopWallpaperMode": "custom",
                "desktopWallpaperDataUrl": "data:text/plain;base64,SGVsbG8="
            }))
            .unwrap_err(),
            "桌面壁纸无效。"
        );
    }

    #[test]
    fn normalize_proxy_profiles_matches_legacy_shapes() {
        let profiles = normalize_proxy_profiles(&json!([
            {
                "id": " proxy-1 ",
                "label": " Corp HTTP ",
                "config": {
                    "type": "http",
                    "host": " proxy.example.com ",
                    "port": "8080",
                    "username": " user ",
                    "password": " secret\nvalue ",
                    "command": "ignored"
                },
                "createdAt": "2026-01-01T00:00:00.000Z"
            },
            {
                "id": "proxy-command",
                "label": "Command",
                "config": {
                    "type": "command",
                    "command": "  nc -x proxy:1080 %h %p\n",
                    "host": "ignored",
                    "port": 9999,
                    "username": "ignored",
                    "password": "ignored"
                },
                "createdAt": "2026-01-02T00:00:00.000Z",
                "updatedAt": "2026-01-03T00:00:00.000Z"
            }
        ]))
        .unwrap();

        assert_eq!(profiles[0]["id"], "proxy-1");
        assert_eq!(profiles[0]["label"], "Corp HTTP");
        assert_eq!(profiles[0]["config"]["type"], "http");
        assert_eq!(profiles[0]["config"]["host"], "proxy.example.com");
        assert_eq!(profiles[0]["config"]["port"], 8080);
        assert_eq!(profiles[0]["config"]["username"], "user");
        assert_eq!(profiles[0]["config"]["password"], " secret\nvalue ");
        assert_eq!(profiles[0]["config"]["command"], "");
        assert_eq!(profiles[0]["updatedAt"], "2026-01-01T00:00:00.000Z");
        assert_eq!(profiles[1]["config"]["host"], "");
        assert_eq!(profiles[1]["config"]["port"], 0);
        assert_eq!(profiles[1]["config"]["command"], "nc -x proxy:1080 %h %p");
        assert_eq!(profiles[1]["config"]["username"], "");
        assert_eq!(profiles[1]["config"]["password"], "");
    }

    #[test]
    fn normalize_proxy_profiles_rejects_invalid_records() {
        assert_eq!(
            normalize_proxy_profiles(&json!([{ "id": "proxy-1" }])).unwrap_err(),
            "代理名称无效。"
        );
        assert_eq!(
            normalize_proxy_profiles(&json!([{
                "id": "proxy-1",
                "label": "Proxy",
                "config": { "type": "http", "host": "proxy.example.com", "port": 0 },
                "createdAt": "2026-01-01T00:00:00.000Z"
            }]))
            .unwrap_err(),
            "代理端口无效。"
        );
        assert_eq!(
            normalize_proxy_profiles(&json!([{
                "id": "proxy-1",
                "label": "Proxy",
                "config": { "type": "ftp" },
                "createdAt": "2026-01-01T00:00:00.000Z"
            }]))
            .unwrap_err(),
            "代理类型无效。"
        );
    }

    #[test]
    fn normalize_known_hosts_matches_legacy_shapes() {
        let known_hosts = normalize_known_hosts(&json!([
            {
                "id": " known-1 ",
                "hostname": " example.com ",
                "port": "2222",
                "keyType": " ssh-ed25519 ",
                "publicKey": " ssh-ed25519 AAAA\ncomment ",
                "fingerprint": " SHA256:abc ",
                "discoveredAt": "2026-01-01T00:00:00.000Z",
                "lastSeen": "2026-01-02T00:00:00.000Z",
                "convertedToHostId": " host-1 "
            }
        ]))
        .unwrap();

        assert_eq!(known_hosts[0]["id"], "known-1");
        assert_eq!(known_hosts[0]["hostname"], "example.com");
        assert_eq!(known_hosts[0]["port"], 2222);
        assert_eq!(known_hosts[0]["keyType"], "ssh-ed25519");
        assert_eq!(known_hosts[0]["publicKey"], "ssh-ed25519 AAAA\ncomment");
        assert_eq!(known_hosts[0]["fingerprint"], "SHA256:abc");
        assert_eq!(known_hosts[0]["lastSeen"], "2026-01-02T00:00:00.000Z");
        assert_eq!(known_hosts[0]["convertedToHostId"], "host-1");
    }

    #[test]
    fn normalize_known_hosts_rejects_invalid_records() {
        assert_eq!(
            normalize_known_hosts(&json!([null])).unwrap_err(),
            "已知主机数据无效。"
        );
        assert_eq!(
            normalize_known_hosts(&json!([{
                "id": "known-1",
                "hostname": "example.com",
                "port": 70000,
                "discoveredAt": "2026-01-01T00:00:00.000Z"
            }]))
            .unwrap_err(),
            "已知主机端口无效。"
        );
    }

    fn host_record(id: &str, name: &str, created_at: &str) -> Value {
        json!({
            "id": id,
            "name": name,
            "address": format!("{id}.example.com"),
            "port": 22,
            "username": "root",
            "authMethod": "password",
            "password": "secret",
            "privilegeMode": "sudo",
            "createdAt": created_at,
            "updatedAt": created_at
        })
    }

    fn find_record<'a>(items: &'a Value, id: &str) -> &'a Value {
        items
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
            .unwrap()
    }

    #[test]
    fn normalize_hosts_scrubs_auth_fields_and_sorts_like_legacy_list() {
        let mut password_host = host_record("host-password", "Password", "2026-01-02T00:00:00Z");
        password_host["keyId"] = json!("stale-key");
        password_host["keyPath"] = json!("C:/Users/test/.ssh/id_rsa");
        password_host["passphrase"] = json!("stale-passphrase");
        password_host["rootPassword"] = json!("stale-root");
        password_host["hostInfo"] = json!({
            "address": "other.example.com",
            "collectedAt": "2026-01-02T00:00:00Z",
            "systemType": "ubuntu",
            "items": [{ "key": "kernel", "label": "Kernel", "value": "6.8" }]
        });

        let mut key_host = host_record("host-key", "Key", "2026-01-01T00:00:00Z");
        key_host["authMethod"] = json!("key");
        key_host["password"] = json!("stale-password");
        key_host["keyId"] = json!("key-1");
        key_host["passphrase"] = json!("key-passphrase");
        key_host["privilegeMode"] = json!("su-root");
        key_host["rootPassword"] = json!("root-secret");
        key_host["systemType"] = json!("UBUNTU");
        key_host["hostInfo"] = json!({
            "address": "host-key.example.com",
            "collectedAt": "2026-01-01T00:00:00Z",
            "systemType": "debian",
            "systemName": "Debian",
            "items": [{ "key": "os", "label": "OS", "value": "Debian 12", "icon": "pc" }]
        });

        let hosts = normalize_hosts(&json!([key_host, password_host])).unwrap();

        assert_eq!(hosts[0]["id"], "host-password");
        assert_eq!(hosts[1]["id"], "host-key");
        assert_eq!(hosts[0]["keyId"], "");
        assert_eq!(hosts[0]["keyPath"], "");
        assert_eq!(hosts[0]["passphrase"], "");
        assert_eq!(hosts[0]["rootPassword"], "");
        assert!(hosts[0]["hostInfo"].is_null());
        assert_eq!(hosts[1]["password"], "");
        assert_eq!(hosts[1]["keyId"], "key-1");
        assert_eq!(hosts[1]["passphrase"], "key-passphrase");
        assert_eq!(hosts[1]["rootPassword"], "root-secret");
        assert_eq!(hosts[1]["systemType"], "ubuntu");
        assert_eq!(hosts[1]["hostInfo"]["items"][0]["value"], "Debian 12");
    }

    #[test]
    fn normalize_hosts_cleans_invalid_jump_host_references() {
        let jump = host_record("jump", "Jump", "2026-01-04T00:00:00Z");
        let mut via_jump = host_record("via-jump", "Via Jump", "2026-01-03T00:00:00Z");
        via_jump["jumpHostId"] = json!("jump");
        let mut nested = host_record("nested", "Nested", "2026-01-02T00:00:00Z");
        nested["jumpHostId"] = json!("via-jump");
        let mut self_jump = host_record("self", "Self", "2026-01-01T00:00:00Z");
        self_jump["jumpHostId"] = json!("self");
        let mut missing = host_record("missing", "Missing", "2026-01-01T00:00:01Z");
        missing["jumpHostId"] = json!("no-such-host");

        let hosts = normalize_hosts(&json!([nested, via_jump, jump, self_jump, missing])).unwrap();

        assert_eq!(find_record(&hosts, "jump")["canBeJumpHost"], true);
        assert_eq!(find_record(&hosts, "via-jump")["canBeJumpHost"], true);
        assert_eq!(find_record(&hosts, "via-jump")["jumpHostId"], "jump");
        assert_eq!(find_record(&hosts, "nested")["jumpHostId"], "");
        assert_eq!(find_record(&hosts, "self")["jumpHostId"], "");
        assert_eq!(find_record(&hosts, "missing")["jumpHostId"], "");
    }

    #[test]
    fn normalize_hosts_rejects_invalid_auth_records() {
        let mut missing_auth = host_record("host-1", "Host 1", "2026-01-01T00:00:00Z");
        missing_auth.as_object_mut().unwrap().remove("authMethod");
        assert_eq!(
            normalize_hosts(&json!([missing_auth])).unwrap_err(),
            "主机登录方式无效。"
        );

        let mut key_without_secret = host_record("host-2", "Key Host", "2026-01-01T00:00:00Z");
        key_without_secret["authMethod"] = json!("key");
        key_without_secret["password"] = json!("");
        assert_eq!(
            normalize_hosts(&json!([key_without_secret])).unwrap_err(),
            "主机「Key Host」缺少私钥信息。"
        );
    }

    #[test]
    fn normalize_ssh_keys_merges_private_key_and_validates_content() {
        let existing = json!([{
            "id": "key-1",
            "name": "Prod",
            "source": "generated",
            "algorithm": "",
            "fingerprint": "",
            "publicKey": RSA_PUBLIC_KEY,
            "passphrase": "old-passphrase",
            "privateKey": "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        let incoming = json!([{
            "id": "key-1",
            "name": "Prod",
            "source": "generated",
            "algorithm": "",
            "fingerprint": "",
            "publicKey": RSA_PUBLIC_KEY,
            "passphrase": "new-passphrase",
            "privateKey": "",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-02T00:00:00Z"
        }]);

        let keys = normalize_ssh_keys_for_store(Some(&existing), &incoming).unwrap();
        assert_eq!(keys[0]["algorithm"], "RSA");
        assert_eq!(keys[0]["passphrase"], "new-passphrase");
        assert_eq!(
            keys[0]["privateKey"],
            "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----"
        );

        let invalid_key = json!([{
            "id": "key-2",
            "name": "Invalid",
            "privateKey": "not a private key",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        assert_eq!(
            normalize_ssh_keys_for_import(&invalid_key).unwrap_err(),
            "SSH 私钥内容无效。"
        );
    }

    #[test]
    fn language_from_locale_matches_legacy_language_choices() {
        assert_eq!(language_from_locale("zh-CN"), Some("zh-CN"));
        assert_eq!(language_from_locale("zh_Hans_CN.UTF-8"), Some("zh-CN"));
        assert_eq!(language_from_locale("en-US"), Some("en-US"));
        assert_eq!(language_from_locale("fr-FR"), Some("en-US"));
        assert_eq!(language_from_locale("C"), None);
        assert_eq!(language_from_locale(""), None);
    }

    #[test]
    fn bookmarks_save_matches_legacy_normalization_and_ordering() {
        let mut store = json!({
            "browserBookmarks": [
                {
                    "scope": "old-scope",
                    "bookmarks": [{
                        "id": "old",
                        "title": "Old",
                        "url": "https://old.example",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "updatedAt": "2026-01-01T00:00:00.000Z"
                    }],
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                }
            ]
        });

        let saved = save_bookmarks_to_store(
            &mut store,
            " browser:host-1 ",
            json!([{
                "id": " bookmark-1 ",
                "title": " ShellDesk ",
                "url": " https://example.com ",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-02T00:00:00.000Z"
            }]),
        )
        .unwrap();

        assert_eq!(saved[0]["id"], "bookmark-1");
        assert_eq!(saved[0]["title"], "ShellDesk");
        assert_eq!(saved[0]["url"], "https://example.com");
        assert_eq!(store["browserBookmarks"][0]["scope"], "browser:host-1");
        assert_eq!(store["browserBookmarks"][0]["bookmarks"], saved);
        assert_eq!(store["browserBookmarks"][1]["scope"], "old-scope");
        assert_eq!(
            get_bookmarks(&store, "browser:host-1").unwrap()[0]["id"],
            "bookmark-1"
        );
    }

    #[test]
    fn bookmarks_save_removes_empty_collection() {
        let mut store = json!({
            "browserBookmarks": [
                {
                    "scope": "browser:host-1",
                    "bookmarks": [{
                        "id": "bookmark-1",
                        "title": "ShellDesk",
                        "url": "https://example.com",
                        "createdAt": "2026-01-01T00:00:00.000Z",
                        "updatedAt": "2026-01-01T00:00:00.000Z"
                    }],
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                },
                {
                    "scope": "browser:host-2",
                    "bookmarks": [],
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                }
            ]
        });

        let saved = save_bookmarks_to_store(&mut store, "browser:host-1", json!([])).unwrap();

        assert!(saved.as_array().unwrap().is_empty());
        assert_eq!(store["browserBookmarks"].as_array().unwrap().len(), 1);
        assert_eq!(store["browserBookmarks"][0]["scope"], "browser:host-2");
    }

    #[test]
    fn bookmarks_reject_invalid_records_and_scopes() {
        let mut store = json!({ "browserBookmarks": [] });
        assert_eq!(
            save_bookmarks_to_store(
                &mut store,
                "browser:host-1",
                json!([{ "id": "missing-fields" }])
            )
            .unwrap_err(),
            "书签名称无效。"
        );
        assert_eq!(
            get_bookmarks(&store, "bad\nscope").unwrap_err(),
            "书签范围无效。"
        );
    }

    #[test]
    fn preferences_set_get_and_delete_match_legacy_semantics() {
        let mut store = json!({ "preferences": {} });

        let saved = set_preference_to_store(
            &mut store,
            " terminal.font-size ",
            json!({ "value": 14, "enabled": true }),
        )
        .unwrap();

        assert_eq!(saved["value"], 14);
        assert_eq!(
            get_preference(&store, "terminal.font-size").unwrap()["enabled"],
            true
        );

        let deleted =
            set_preference_to_store(&mut store, "terminal.font-size", Value::Null).unwrap();

        assert!(deleted.is_null());
        assert!(get_preference(&store, "terminal.font-size")
            .unwrap()
            .is_null());
    }

    #[test]
    fn preferences_reject_invalid_keys_and_oversized_values() {
        let mut store = json!({ "preferences": {} });

        assert_eq!(
            get_preference(&store, "bad key").unwrap_err(),
            "偏好设置键无效。"
        );
        assert_eq!(
            set_preference_to_store(&mut store, "", json!(true)).unwrap_err(),
            "请输入偏好设置键。"
        );

        let oversized = "x".repeat(64 * 1024 + 1);
        assert_eq!(
            set_preference_to_store(&mut store, "terminal.theme", json!(oversized)).unwrap_err(),
            "偏好设置内容无效或超过大小限制。"
        );
    }

    #[test]
    fn preferences_create_missing_store_object() {
        let mut store = json!({});

        let saved = set_preference_to_store(&mut store, "sidebar.width", json!(320)).unwrap();

        assert_eq!(saved, json!(320));
        assert_eq!(store["preferences"]["sidebar.width"], 320);
    }

    #[test]
    fn remote_connection_profiles_normalize_values_and_round_trip() {
        let mut store = json!({ "remoteConnectionProfiles": {} });

        let saved = save_remote_connection_profile_to_store(
            &mut store,
            " host-1 ",
            "mysql",
            json!({
                "host": " 127.0.0.1 ",
                "password": " secret\nvalue ",
                "ssl": true,
                "port": 3306,
                "nested": { "ignored": true },
                "bad key": "skipped"
            }),
        )
        .unwrap();

        assert_eq!(saved["host"], " 127.0.0.1 ");
        assert_eq!(saved["password"], " secret\nvalue ");
        assert_eq!(saved["ssl"], true);
        assert_eq!(saved["port"], 3306);
        assert_eq!(saved["nested"], "");
        assert!(saved.get("bad key").is_none());
        assert_eq!(
            get_remote_connection_profile(&store, "host-1", "mysql").unwrap(),
            saved
        );
        assert!(get_remote_connection_profile(&store, "host-1", "redis")
            .unwrap()
            .is_null());
    }

    #[test]
    fn remote_connection_profiles_reject_invalid_app_key_and_large_values() {
        let mut store = json!({ "remoteConnectionProfiles": {} });

        assert_eq!(
            save_remote_connection_profile_to_store(&mut store, "host-1", "unknown-app", json!({}))
                .unwrap_err(),
            "远程组件标识无效。"
        );

        let oversized = "x".repeat(64 * 1024 + 1);
        assert_eq!(
            save_remote_connection_profile_to_store(
                &mut store,
                "host-1",
                "mysql",
                json!({ "payload": oversized })
            )
            .unwrap_err(),
            "远程组件连接配置超过大小限制。"
        );
    }

    #[test]
    fn remote_connection_profiles_limit_items_and_validate_key_length() {
        let mut many_values = serde_json::Map::new();
        for index in 0..90 {
            many_values.insert(format!("key-{index}"), json!(index));
        }
        let values = read_remote_connection_profile_values(Value::Object(many_values)).unwrap();
        assert_eq!(values.as_object().unwrap().len(), 80);

        let long_key = "x".repeat(81);
        assert_eq!(
            read_remote_connection_profile_values(json!({ long_key: true })).unwrap_err(),
            "远程组件配置键无效。"
        );
    }

    #[test]
    fn merge_private_key_fields_restores_existing_private_key() {
        let existing = json!([
            { "id": "key-1", "name": "prod", "privateKey": "private" }
        ]);
        let incoming = json!([
            { "id": "key-1", "name": "prod", "privateKey": "", "publicKey": RSA_PUBLIC_KEY }
        ]);

        let merged = merge_private_key_fields(Some(&existing), &incoming).unwrap();
        assert_eq!(merged[0]["privateKey"], "private");
        assert_eq!(merged[0]["publicKey"], RSA_PUBLIC_KEY);
    }

    #[test]
    fn merge_private_key_fields_rejects_new_key_without_private_key() {
        let incoming = json!([
            { "id": "key-new", "name": "new key", "privateKey": "" }
        ]);

        assert_eq!(
            merge_private_key_fields(Some(&json!([])), &incoming).unwrap_err(),
            "密钥「new key」缺少私钥内容，无法保存。"
        );
    }

    #[test]
    fn upsert_vault_collections_preserves_missing_collections_and_normalizes_settings() {
        let mut store = json!({
            "hosts": [{ "id": "host-existing" }],
            "sshKeys": [{ "id": "key-1", "name": "prod", "privateKey": "private" }],
            "proxyProfiles": [{ "id": "proxy-existing" }],
            "knownHosts": [{ "host": "old.example.com" }],
            "settings": { "language": "zh-CN", "theme": "dark" }
        });

        upsert_vault_collections(
            &mut store,
            json!({
                "hosts": [{
                    "id": "host-next",
                    "name": "Next",
                    "address": "example.com",
                    "port": "22",
                    "username": "root",
                    "authMethod": "password",
                    "password": "secret",
                    "keyId": "stale-key",
                    "passphrase": "stale-passphrase",
                    "privilegeMode": "sudo",
                    "rootPassword": "should-clear",
                    "group": "",
                    "tags": [],
                    "note": "",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-02T00:00:00.000Z"
                }],
                "proxyProfiles": null,
                "knownHosts": "invalid",
                "settings": null
            }),
        )
        .unwrap();

        assert_eq!(store["hosts"][0]["id"], "host-next");
        assert_eq!(store["hosts"][0]["port"], 22);
        assert_eq!(store["hosts"][0]["keyId"], "");
        assert_eq!(store["hosts"][0]["passphrase"], "");
        assert_eq!(store["hosts"][0]["rootPassword"], "");
        assert_eq!(store["proxyProfiles"][0]["id"], "proxy-existing");
        assert_eq!(store["knownHosts"][0]["host"], "old.example.com");
        assert_eq!(store["settings"]["defaultHostView"], "grid");
        assert_eq!(store["settings"]["terminalFontSize"], 13);
        assert_eq!(store["sshKeys"][0]["privateKey"], "private");
    }

    #[test]
    fn upsert_vault_collections_merges_settings_defaults_and_key_secrets() {
        let mut store = json!({
            "hosts": [],
            "sshKeys": [{
                "id": "key-1",
                "name": "prod",
                "privateKey": "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----"
            }],
            "proxyProfiles": [],
            "knownHosts": [],
            "settings": { "language": "en-US", "theme": "dark" }
        });

        upsert_vault_collections(
            &mut store,
            json!({
                "settings": { "language": "zh-CN" },
                "proxyProfiles": [{
                    "id": " proxy-1 ",
                    "label": " Proxy ",
                    "config": { "type": "socks5", "host": " 127.0.0.1 ", "port": "1080" },
                    "createdAt": "2026-01-01T00:00:00.000Z"
                }],
                "knownHosts": [{
                    "id": " known-1 ",
                    "hostname": " example.com ",
                    "port": "22",
                    "discoveredAt": "2026-01-01T00:00:00.000Z"
                }],
                "sshKeys": [{
                    "id": "key-1",
                    "name": "prod",
                    "source": "imported",
                    "algorithm": "",
                    "fingerprint": "",
                    "privateKey": "",
                    "publicKey": RSA_PUBLIC_KEY,
                    "passphrase": "phrase",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "updatedAt": "2026-01-02T00:00:00.000Z"
                }]
            }),
        )
        .unwrap();

        assert_eq!(store["settings"]["language"], "zh-CN");
        assert_eq!(store["settings"]["defaultHostView"], "grid");
        assert_eq!(store["proxyProfiles"][0]["id"], "proxy-1");
        assert_eq!(store["proxyProfiles"][0]["config"]["host"], "127.0.0.1");
        assert_eq!(store["proxyProfiles"][0]["config"]["port"], 1080);
        assert_eq!(store["knownHosts"][0]["id"], "known-1");
        assert_eq!(store["knownHosts"][0]["hostname"], "example.com");
        assert_eq!(store["knownHosts"][0]["port"], 22);
        assert_eq!(
            store["sshKeys"][0]["privateKey"],
            "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----"
        );
        assert_eq!(store["sshKeys"][0]["algorithm"], "SSH");
        assert_eq!(store["sshKeys"][0]["publicKey"], RSA_PUBLIC_KEY);
    }

    #[test]
    fn upsert_vault_collections_rejects_invalid_payload_and_missing_key_secret() {
        let mut store = json!({
            "sshKeys": []
        });

        assert_eq!(
            upsert_vault_collections(&mut store, json!(null)).unwrap_err(),
            "本地数据无效。"
        );
        assert_eq!(
            upsert_vault_collections(
                &mut store,
                json!({ "sshKeys": [{ "id": "key-new", "name": "new key", "privateKey": "" }] })
            )
            .unwrap_err(),
            "密钥「new key」缺少私钥内容，无法保存。"
        );
    }

    #[test]
    fn ensure_unique_ssh_key_rejects_duplicate_private_key() {
        let existing = json!([
            { "id": "key-1", "privateKey": " private\n", "fingerprint": "" }
        ]);
        let next = json!({ "privateKey": "private", "fingerprint": "" });
        assert_eq!(
            ensure_unique_ssh_key(Some(&existing), &next).unwrap_err(),
            "这个 SSH 私钥已经在密钥库中。"
        );
    }

    #[test]
    fn ensure_unique_ssh_key_rejects_duplicate_fingerprint() {
        let existing = json!([
            { "id": "key-1", "privateKey": "", "fingerprint": "SHA256:abc" }
        ]);
        let next = json!({ "privateKey": "other", "fingerprint": "SHA256:abc" });
        assert_eq!(
            ensure_unique_ssh_key(Some(&existing), &next).unwrap_err(),
            "这个 SSH 私钥已经在密钥库中。"
        );
    }
}
