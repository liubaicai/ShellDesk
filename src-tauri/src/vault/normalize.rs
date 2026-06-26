use base64::Engine;
use serde_json::{json, Value};

use super::{
    default_settings, default_terminal_snippets, merge_private_key_fields, now, random_id,
    read_bounded_string, read_bounded_string_value, MAX_PRIVATE_KEY_BYTES, REMOTE_DESKTOP_APP_KEYS,
};
const DESKTOP_WALLPAPER_PRESET_IDS: &[&str] = &[
    "default",
    "midnight-ops",
    "amber-routes",
    "mist-console",
    "green-health",
    "indigo-traces",
];
const REMOTE_DESKTOP_APP_CATALOG_VERSION: i64 = 12;
const REMOTE_DESKTOP_APP_CATALOG_MIGRATION_KEYS: &[&str] = &[
    "git-manager",
    "cert-manager",
    "nginx-manager",
    "caddy-manager",
    "apache-manager",
    "mongo",
    "search-cluster",
    "message-queue",
    "s3-browser",
    "frp-manager",
    "frps-manager",
    "disk-manager",
    "clickhouse",
    "ai-chat",
];
const TERMINAL_THEME_CHOICES: &[&str] = &[
    "shelldesk-dark",
    "netcatty-dark",
    "tokyo-night",
    "dracula",
    "monokai",
    "solarized-light",
    "netcatty-light",
    "hacker-green",
];
const TERMINAL_CURSOR_INACTIVE_STYLE_CHOICES: &[&str] =
    &["outline", "block", "bar", "underline", "none"];
const AI_PROVIDER_CHOICES: &[&str] = &["openai", "anthropic", "openai-compatible", "custom"];
const AI_API_FORMAT_CHOICES: &[&str] = &["openai", "anthropic"];
const MAX_DESKTOP_WALLPAPER_BYTES: usize = 5 * 1024 * 1024;
const MAX_DESKTOP_WALLPAPER_DATA_URL_LENGTH: usize =
    ((MAX_DESKTOP_WALLPAPER_BYTES as f64) * 1.4) as usize + 128;

pub(crate) fn normalize_app_settings(raw_settings: &Value) -> Result<Value, String> {
    let defaults = default_settings();
    let Some(settings) = raw_settings.as_object() else {
        return Ok(defaults);
    };

    let ai_provider = read_choice(
        settings.get("aiProvider"),
        AI_PROVIDER_CHOICES,
        defaults["aiProvider"].as_str().unwrap_or("openai"),
    );
    let ai_api_format_default = if ai_provider == "anthropic" {
        "anthropic"
    } else {
        defaults["aiApiFormat"].as_str().unwrap_or("openai")
    };
    let ai_api_format = read_choice(
        settings.get("aiApiFormat"),
        AI_API_FORMAT_CHOICES,
        ai_api_format_default,
    );
    let default_ai_api_base_url = default_ai_api_base_url(&ai_provider);
    let default_ai_provider_name = default_ai_provider_name(&ai_provider);
    let desktop_wallpaper_data_url = read_desktop_wallpaper_data_url(
        settings.get("desktopWallpaperDataUrl"),
        defaults["desktopWallpaperDataUrl"].as_str().unwrap_or(""),
    )?;
    let raw_desktop_wallpaper_preset_id = settings
        .get("desktopWallpaperPresetId")
        .and_then(Value::as_str)
        .unwrap_or(
            defaults["desktopWallpaperPresetId"]
                .as_str()
                .unwrap_or("default"),
        );
    let desktop_wallpaper_preset_id =
        if DESKTOP_WALLPAPER_PRESET_IDS.contains(&raw_desktop_wallpaper_preset_id) {
            raw_desktop_wallpaper_preset_id.to_string()
        } else {
            defaults["desktopWallpaperPresetId"]
                .as_str()
                .unwrap_or("default")
                .to_string()
        };
    let desktop_wallpaper_mode = if settings.get("desktopWallpaperMode").and_then(Value::as_str)
        == Some("custom")
        && !desktop_wallpaper_data_url.is_empty()
    {
        "custom"
    } else {
        "preset"
    };
    let language = read_choice(
        settings.get("language"),
        &["zh-CN", "en-US"],
        defaults["language"].as_str().unwrap_or("en-US"),
    );
    let theme = match settings.get("theme").and_then(Value::as_str) {
        Some("light") => "light".to_string(),
        Some("system") => "system".to_string(),
        _ => defaults["theme"].as_str().unwrap_or("dark").to_string(),
    };
    let default_host_view =
        if settings.get("defaultHostView").and_then(Value::as_str) == Some("list") {
            "list"
        } else {
            "grid"
        };
    let desktop_wallpaper_name = read_optional_bounded_string(
        settings.get("desktopWallpaperName"),
        "桌面壁纸名称",
        160,
        true,
        true,
    )?;
    let remote_desktop_layout = read_remote_desktop_layout(settings.get("remoteDesktopLayout"))?;
    let ai_provider_name = read_optional_bounded_string(
        settings.get("aiProviderName"),
        "AI 提供商名称",
        80,
        true,
        true,
    )?;
    let ai_provider_name = if ai_provider_name.is_empty() {
        default_ai_provider_name
    } else {
        ai_provider_name
    };
    let ai_api_base_url =
        read_ai_api_base_url(settings.get("aiApiBaseUrl"), &default_ai_api_base_url)?;
    let ai_api_key =
        read_optional_bounded_string(settings.get("aiApiKey"), "AI API 密钥", 8192, true, true)?;
    let ai_model =
        read_optional_bounded_string(settings.get("aiModel"), "AI 模型", 200, true, true)?;
    let terminal_cursor_style = match settings.get("terminalCursorStyle").and_then(Value::as_str) {
        Some("bar") => "bar".to_string(),
        Some("underline") => "underline".to_string(),
        _ => defaults["terminalCursorStyle"]
            .as_str()
            .unwrap_or("block")
            .to_string(),
    };
    let terminal_snippets = read_terminal_snippets(
        settings.get("terminalSnippets"),
        defaults
            .get("terminalSnippets")
            .cloned()
            .unwrap_or_else(|| default_terminal_snippets(&language)),
    )?;

    Ok(json!({
        "language": language,
        "interfaceFont": read_font_family(settings.get("interfaceFont"), defaults["interfaceFont"].as_str().unwrap_or("Microsoft YaHei UI")),
        "theme": theme,
        "accentColor": read_color_hex(settings.get("accentColor"), defaults["accentColor"].as_str().unwrap_or("#0f6bff")),
        "defaultHostView": default_host_view,
        "minimizeToTrayOnClose": read_bool(settings.get("minimizeToTrayOnClose"), defaults["minimizeToTrayOnClose"].as_bool().unwrap_or(true)),
        "autoUpdateEnabled": read_bool(settings.get("autoUpdateEnabled"), defaults["autoUpdateEnabled"].as_bool().unwrap_or(true)),
        "desktopWallpaperMode": desktop_wallpaper_mode,
        "desktopWallpaperPresetId": desktop_wallpaper_preset_id,
        "desktopWallpaperDataUrl": desktop_wallpaper_data_url,
        "desktopWallpaperName": desktop_wallpaper_name,
        "remoteDesktopLayout": remote_desktop_layout,
        "rememberPasswords": read_bool(settings.get("rememberPasswords"), defaults["rememberPasswords"].as_bool().unwrap_or(true)),
        "rememberKeyPassphrases": read_bool(settings.get("rememberKeyPassphrases"), defaults["rememberKeyPassphrases"].as_bool().unwrap_or(true)),
        "aiProvider": ai_provider,
        "aiProviderName": ai_provider_name,
        "aiApiFormat": ai_api_format,
        "aiApiBaseUrl": ai_api_base_url,
        "aiApiKey": ai_api_key,
        "aiModel": ai_model,
        "terminalFontSize": read_i64_range(settings.get("terminalFontSize"), 11, 20, defaults["terminalFontSize"].as_i64().unwrap_or(13)),
        "terminalFontFamily": read_font_family(settings.get("terminalFontFamily"), defaults["terminalFontFamily"].as_str().unwrap_or("Cascadia Mono")),
        "terminalFontWeight": read_i64_range(settings.get("terminalFontWeight"), 300, 600, defaults["terminalFontWeight"].as_i64().unwrap_or(400)),
        "terminalFontWeightBold": read_i64_range(settings.get("terminalFontWeightBold"), 600, 800, defaults["terminalFontWeightBold"].as_i64().unwrap_or(700)),
        "terminalFontLigatures": read_bool(settings.get("terminalFontLigatures"), defaults["terminalFontLigatures"].as_bool().unwrap_or(true)),
        "terminalLigatures": read_bool(settings.get("terminalLigatures"), defaults["terminalLigatures"].as_bool().unwrap_or(true)),
        "terminalLineHeight": read_f64_range(settings.get("terminalLineHeight"), 1.0, 1.5, defaults["terminalLineHeight"].as_f64().unwrap_or(1.2)),
        "terminalTheme": read_choice(settings.get("terminalTheme"), TERMINAL_THEME_CHOICES, defaults["terminalTheme"].as_str().unwrap_or("shelldesk-dark")),
        "terminalCursorBlink": read_bool(settings.get("terminalCursorBlink"), defaults["terminalCursorBlink"].as_bool().unwrap_or(true)),
        "terminalCursorStyle": terminal_cursor_style,
        "terminalCursorInactiveStyle": read_choice(settings.get("terminalCursorInactiveStyle"), TERMINAL_CURSOR_INACTIVE_STYLE_CHOICES, defaults["terminalCursorInactiveStyle"].as_str().unwrap_or("outline")),
        "terminalScrollback": read_i64_range(settings.get("terminalScrollback"), 1000, 50000, defaults["terminalScrollback"].as_i64().unwrap_or(10000)),
        "terminalScrollSensitivity": read_f64_range(settings.get("terminalScrollSensitivity"), 0.5, 5.0, defaults["terminalScrollSensitivity"].as_f64().unwrap_or(1.0)),
        "terminalFastScrollSensitivity": read_i64_range(settings.get("terminalFastScrollSensitivity"), 2, 20, defaults["terminalFastScrollSensitivity"].as_i64().unwrap_or(5)),
        "terminalScrollOnUserInput": read_bool(settings.get("terminalScrollOnUserInput"), defaults["terminalScrollOnUserInput"].as_bool().unwrap_or(true)),
        "terminalScrollOnEraseInDisplay": read_bool(settings.get("terminalScrollOnEraseInDisplay"), defaults["terminalScrollOnEraseInDisplay"].as_bool().unwrap_or(true)),
        "terminalCopyOnSelect": read_bool(settings.get("terminalCopyOnSelect"), defaults["terminalCopyOnSelect"].as_bool().unwrap_or(true)),
        "terminalRightClickPaste": read_bool(settings.get("terminalRightClickPaste"), defaults["terminalRightClickPaste"].as_bool().unwrap_or(true)),
        "terminalAltClickMovesCursor": read_bool(settings.get("terminalAltClickMovesCursor"), defaults["terminalAltClickMovesCursor"].as_bool().unwrap_or(true)),
        "terminalBracketedPasteMode": read_bool(settings.get("terminalBracketedPasteMode"), defaults["terminalBracketedPasteMode"].as_bool().unwrap_or(true)),
        "terminalMinimumContrastRatio": read_f64_range(settings.get("terminalMinimumContrastRatio"), 1.0, 7.0, defaults["terminalMinimumContrastRatio"].as_f64().unwrap_or(1.0)),
        "terminalScreenReaderMode": read_bool(settings.get("terminalScreenReaderMode"), defaults["terminalScreenReaderMode"].as_bool().unwrap_or(false)),
        "terminalSnippets": terminal_snippets
    }))
}

fn read_choice(value: Option<&Value>, choices: &[&str], fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| choices.contains(value))
        .unwrap_or(fallback)
        .to_string()
}

fn read_bool(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn read_i64_range(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    let number = value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .or_else(|| {
                value
                    .as_f64()
                    .filter(|number| number.fract() == 0.0)
                    .map(|number| number as i64)
            })
    });
    number
        .filter(|number| *number >= min && *number <= max)
        .unwrap_or(fallback)
}

fn read_f64_range(value: Option<&Value>, min: f64, max: f64, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= min && *number <= max)
        .unwrap_or(fallback)
}

fn read_font_family(value: Option<&Value>, fallback: &str) -> String {
    let Some(value) = value.and_then(Value::as_str) else {
        return fallback.to_string();
    };
    let font_family = value
        .replace('\0', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if font_family.is_empty() || font_family.len() > 120 || font_family.contains(['\r', '\n']) {
        fallback.to_string()
    } else {
        font_family
    }
}

fn read_color_hex(value: Option<&Value>, fallback: &str) -> String {
    let Some(value) = value.and_then(Value::as_str) else {
        return fallback.to_string();
    };
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|ch| ch.is_ascii_hexdigit())
    {
        value.to_ascii_lowercase()
    } else {
        fallback.to_string()
    }
}

fn read_optional_bounded_string(
    value: Option<&Value>,
    label: &str,
    max_length: usize,
    trim: bool,
    reject_line_breaks: bool,
) -> Result<String, String> {
    match value {
        Some(Value::String(value)) => {
            read_bounded_string(value, label, max_length, false, trim, reject_line_breaks)
        }
        _ => Ok(String::new()),
    }
}

fn default_ai_api_base_url(provider: &str) -> String {
    match provider {
        "anthropic" => "https://api.anthropic.com".to_string(),
        "openai" => "https://api.openai.com/v1".to_string(),
        _ => String::new(),
    }
}

fn default_ai_provider_name(provider: &str) -> String {
    match provider {
        "anthropic" => "Claude / Anthropic".to_string(),
        "openai-compatible" => "OpenAI 兼容".to_string(),
        "custom" => "自定义提供商".to_string(),
        _ => "OpenAI".to_string(),
    }
}

fn read_ai_api_base_url(value: Option<&Value>, fallback: &str) -> Result<String, String> {
    let Some(value) = value.and_then(Value::as_str) else {
        return Ok(fallback.to_string());
    };
    let api_base_url = value.trim();
    if api_base_url.is_empty() {
        return Ok(String::new());
    }
    if api_base_url.len() > 2048 || api_base_url.contains(['\0', '\r', '\n']) {
        return Err("AI API 地址无效。".to_string());
    }
    let url = url::Url::parse(api_base_url).map_err(|_| "AI API 地址无效。".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("AI API 地址只支持 http 或 https。".to_string());
    }
    Ok(api_base_url.to_string())
}

fn read_desktop_wallpaper_data_url(
    value: Option<&Value>,
    fallback: &str,
) -> Result<String, String> {
    let Some(value) = value.and_then(Value::as_str) else {
        return Ok(fallback.to_string());
    };
    if value.is_empty() {
        return Ok(fallback.to_string());
    }
    if value.len() > MAX_DESKTOP_WALLPAPER_DATA_URL_LENGTH {
        return Err("桌面壁纸无效。".to_string());
    }
    let Some((header, payload)) = value.split_once(',') else {
        return Err("桌面壁纸无效。".to_string());
    };
    let media_type = header.to_ascii_lowercase();
    if !matches!(
        media_type.as_str(),
        "data:image/png;base64"
            | "data:image/jpg;base64"
            | "data:image/jpeg;base64"
            | "data:image/webp;base64"
            | "data:image/gif;base64"
    ) || !payload
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '='))
    {
        return Err("桌面壁纸无效。".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "桌面壁纸无效。".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_DESKTOP_WALLPAPER_BYTES {
        return Err("桌面壁纸为空或超过大小限制。".to_string());
    }
    Ok(value.to_string())
}

fn read_remote_desktop_layout(value: Option<&Value>) -> Result<Value, String> {
    let defaults = default_settings()
        .get("remoteDesktopLayout")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let Some(layout) = value.and_then(Value::as_object) else {
        return Ok(defaults);
    };
    let sort_mode = read_choice(
        layout.get("sortMode"),
        &["custom", "name-asc", "name-desc"],
        defaults["sortMode"].as_str().unwrap_or("custom"),
    );
    let app_catalog_version = layout
        .get("appCatalogVersion")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
        })
        .filter(|number| *number > 0)
        .unwrap_or(1);
    let Some(raw_items) = layout.get("items").and_then(Value::as_array) else {
        let mut next = defaults;
        next["sortMode"] = json!(sort_mode);
        return Ok(next);
    };
    let mut seen_app_keys = Vec::<String>::new();
    let mut items = Vec::new();
    for (index, item) in raw_items
        .iter()
        .take(REMOTE_DESKTOP_APP_KEYS.len() + 12)
        .enumerate()
    {
        let Some(item_object) = item.as_object() else {
            continue;
        };
        match item_object.get("type").and_then(Value::as_str) {
            Some("app") => {
                let Some(app_key) = item_object.get("appKey").and_then(Value::as_str) else {
                    continue;
                };
                if !REMOTE_DESKTOP_APP_KEYS.contains(&app_key)
                    || seen_app_keys.iter().any(|seen| seen == app_key)
                {
                    continue;
                }
                seen_app_keys.push(app_key.to_string());
                items.push(
                    json!({ "id": format!("app:{app_key}"), "type": "app", "appKey": app_key }),
                );
            }
            Some("folder") => {
                let app_keys = item_object
                    .get("appKeys")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(ToString::to_string))
                    .filter(|app_key| {
                        if !REMOTE_DESKTOP_APP_KEYS.contains(&app_key.as_str())
                            || seen_app_keys.iter().any(|seen| seen == app_key)
                        {
                            false
                        } else {
                            seen_app_keys.push(app_key.clone());
                            true
                        }
                    })
                    .collect::<Vec<_>>();
                let fallback_id = format!("folder:{}", index + 1);
                let name = read_optional_bounded_string(
                    item_object.get("name"),
                    "桌面文件夹名称",
                    40,
                    true,
                    true,
                )?;
                let id = read_optional_bounded_string(
                    item_object.get("id"),
                    "桌面文件夹 ID",
                    128,
                    true,
                    true,
                )?;
                items.push(json!({
                    "id": if id.is_empty() { fallback_id } else { id },
                    "type": "folder",
                    "name": if name.is_empty() { "文件夹".to_string() } else { name },
                    "appKeys": app_keys
                }));
            }
            _ => {}
        }
    }
    if app_catalog_version < REMOTE_DESKTOP_APP_CATALOG_VERSION {
        let migration_key_set = REMOTE_DESKTOP_APP_CATALOG_MIGRATION_KEYS
            .iter()
            .copied()
            .collect::<Vec<_>>();
        let legacy_app_keys = REMOTE_DESKTOP_APP_KEYS
            .iter()
            .copied()
            .filter(|app_key| !migration_key_set.contains(app_key))
            .collect::<Vec<_>>();
        let has_all_legacy_apps = legacy_app_keys
            .iter()
            .all(|app_key| seen_app_keys.iter().any(|seen| seen == app_key));
        if has_all_legacy_apps {
            for app_key in REMOTE_DESKTOP_APP_CATALOG_MIGRATION_KEYS {
                if !seen_app_keys.iter().any(|seen| seen == app_key) {
                    items.push(
                        json!({ "id": format!("app:{app_key}"), "type": "app", "appKey": app_key }),
                    );
                }
            }
        }
    }
    Ok(json!({
        "appCatalogVersion": REMOTE_DESKTOP_APP_CATALOG_VERSION,
        "sortMode": sort_mode,
        "items": items
    }))
}

fn read_terminal_snippets(raw_snippets: Option<&Value>, fallback: Value) -> Result<Value, String> {
    let Some(snippets) = raw_snippets else {
        return Ok(fallback);
    };
    let Some(snippets) = snippets.as_array() else {
        return Ok(fallback);
    };
    let mut seen_ids = Vec::<String>::new();
    let mut output = Vec::new();
    for snippet in snippets.iter().take(80) {
        let Some(snippet_object) = snippet.as_object() else {
            continue;
        };
        let label = read_optional_bounded_string(
            snippet_object.get("label"),
            "代码片段名称",
            80,
            true,
            true,
        )?;
        let command = read_optional_bounded_string(
            snippet_object.get("command"),
            "代码片段命令",
            20_000,
            false,
            false,
        )?
        .trim_end()
        .to_string();
        if label.is_empty() || command.is_empty() {
            continue;
        }
        let raw_id =
            read_optional_bounded_string(snippet_object.get("id"), "代码片段 ID", 128, true, true)?;
        let mut id = if raw_id.is_empty() {
            random_id("snippet")
        } else {
            raw_id
        };
        if seen_ids.iter().any(|seen| seen == &id) {
            id = random_id("snippet");
        }
        seen_ids.push(id.clone());
        let mut shortcut = read_optional_bounded_string(
            snippet_object.get("shortcut"),
            "代码片段快捷键",
            80,
            true,
            true,
        )?;
        shortcut = shortcut
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" + ");
        let group = read_optional_bounded_string(
            snippet_object.get("group"),
            "代码片段分组",
            80,
            true,
            true,
        )?;
        let created_at = read_optional_bounded_string(
            snippet_object.get("createdAt"),
            "代码片段创建时间",
            64,
            true,
            true,
        )?;
        let created_at = if created_at.is_empty() {
            now()
        } else {
            created_at
        };
        let updated_at = read_optional_bounded_string(
            snippet_object.get("updatedAt"),
            "代码片段更新时间",
            64,
            true,
            true,
        )?;
        let updated_at = if updated_at.is_empty() {
            now()
        } else {
            updated_at
        };
        output.push(json!({
            "id": id,
            "label": label,
            "command": command,
            "group": group,
            "shortcut": shortcut,
            "createdAt": created_at,
            "updatedAt": updated_at
        }));
    }
    Ok(Value::Array(output))
}

const REMOTE_SYSTEM_TYPE_CHOICES: &[&str] = &[
    "unknown",
    "windows",
    "macos",
    "ubuntu",
    "debian",
    "redhat",
    "centos",
    "fedora",
    "rocky",
    "almalinux",
    "oracle",
    "amazon",
    "arch",
    "manjaro",
    "alpine",
    "opensuse",
    "linuxmint",
    "kali",
    "raspbian",
    "gentoo",
    "nixos",
    "popos",
    "elementary",
    "linux",
    "unix",
];

pub(crate) fn normalize_hosts(value: &Value) -> Result<Value, String> {
    let Some(hosts) = value.as_array() else {
        return Ok(json!([]));
    };
    let mut hosts = hosts
        .iter()
        .map(read_stored_host_record)
        .collect::<Result<Vec<_>, _>>()?;
    sanitize_host_jump_host_references(&mut hosts);
    sort_hosts_by_list_order(&mut hosts);
    Ok(Value::Array(hosts))
}

fn read_stored_host_record(value: &Value) -> Result<Value, String> {
    let Some(host) = value.as_object() else {
        return Err("主机数据无效。".to_string());
    };
    let auth_method = host
        .get("authMethod")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "password" | "key"))
        .ok_or_else(|| "主机登录方式无效。".to_string())?;
    let port = read_port(host.get("port"), "主机端口")?;
    let name = read_bounded_string_value(host.get("name"), "主机名称", 80, true, true, true)?;
    let mut output = json!({
        "id": read_bounded_string_value(host.get("id"), "主机 ID", 128, true, true, true)?,
        "name": name,
        "address": read_bounded_string_value(host.get("address"), "主机地址", 255, true, true, true)?,
        "port": port,
        "username": read_bounded_string_value(host.get("username"), "用户名", 128, true, true, true)?,
        "authMethod": auth_method,
        "password": read_optional_bounded_string(host.get("password"), "SSH 密码", 4096, false, false)?,
        "keyId": read_optional_bounded_string(host.get("keyId"), "密钥 ID", 128, true, true)?,
        "keyPath": read_optional_bounded_string(host.get("keyPath"), "SSH 私钥路径", 1024, true, true)?,
        "passphrase": read_optional_bounded_string(host.get("passphrase"), "SSH 密钥口令", 4096, false, false)?,
        "privilegeMode": read_privilege_mode(host.get("privilegeMode")),
        "rootPassword": read_optional_bounded_string(host.get("rootPassword"), "root 密码", 4096, false, true)?,
        "jumpHostId": read_optional_bounded_string(host.get("jumpHostId"), "跳板机 ID", 128, true, true)?,
        "canBeJumpHost": read_bool(host.get("canBeJumpHost"), false),
        "proxyProfileId": read_optional_bounded_string(host.get("proxyProfileId"), "代理 ID", 128, true, true)?,
        "systemType": read_remote_system_type(host.get("systemType")),
        "systemName": read_optional_bounded_string(host.get("systemName"), "系统名称", 160, true, true)?,
        "hostInfo": read_host_info_snapshot(host.get("hostInfo"))?,
        "lastConnectionStatus": read_host_connection_status(host.get("lastConnectionStatus")),
        "lastConnectionAt": match host.get("lastConnectionAt").and_then(Value::as_str) {
            Some(value) if !value.is_empty() => read_bounded_string(value, "上次连接时间", 64, true, true, true)?,
            _ => String::new()
        },
        "lastConnectionError": read_optional_bounded_string(host.get("lastConnectionError"), "上次连接错误", 4096, true, false)?,
        "group": read_optional_bounded_string(host.get("group"), "分组", 120, true, true)?,
        "tags": read_string_list(host.get("tags"), "主机标签", 8, 256)?,
        "note": read_optional_bounded_string(host.get("note"), "备注", 20_000, true, false)?,
        "createdAt": read_bounded_string_value(host.get("createdAt"), "主机创建时间", 64, true, true, true)?,
        "updatedAt": read_bounded_string_value(host.get("updatedAt"), "主机更新时间", 64, true, true, true)?
    });

    let key_id = output["keyId"].as_str().unwrap_or("");
    let key_path = output["keyPath"].as_str().unwrap_or("");
    if auth_method == "key" && key_id.is_empty() && key_path.is_empty() {
        return Err(format!(
            "主机「{}」缺少私钥信息。",
            output["name"].as_str().unwrap_or("")
        ));
    }
    if auth_method == "password" {
        output["keyId"] = json!("");
        output["keyPath"] = json!("");
        output["passphrase"] = json!("");
    } else {
        output["password"] = json!("");
    }
    if output["privilegeMode"].as_str() != Some("su-root") {
        output["rootPassword"] = json!("");
    }
    if output
        .get("hostInfo")
        .and_then(|value| value.get("address"))
        .and_then(Value::as_str)
        .is_some_and(|address| {
            !address.is_empty() && address != output["address"].as_str().unwrap_or("")
        })
    {
        output["hostInfo"] = Value::Null;
    }
    Ok(output)
}

fn read_privilege_mode(value: Option<&Value>) -> &'static str {
    if value.and_then(Value::as_str) == Some("su-root") {
        "su-root"
    } else {
        "sudo"
    }
}

fn read_host_connection_status(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("success") => "success",
        Some("failed") => "failed",
        _ => "unknown",
    }
}

fn read_remote_system_type(value: Option<&Value>) -> String {
    let normalized = value
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_ascii_lowercase();
    if REMOTE_SYSTEM_TYPE_CHOICES.contains(&normalized.as_str()) {
        normalized
    } else {
        "unknown".to_string()
    }
}

fn read_string_list(
    value: Option<&Value>,
    label: &str,
    max_items: usize,
    max_item_length: usize,
) -> Result<Value, String> {
    let Some(items) = value else {
        return Ok(json!([]));
    };
    let Some(items) = items.as_array() else {
        return Err(format!("{label}无效。"));
    };
    if items.len() > max_items {
        return Err(format!("{label}无效。"));
    }
    items
        .iter()
        .map(|item| match item {
            Value::String(value) => {
                read_bounded_string(value, label, max_item_length, false, true, true)
                    .map(Value::String)
            }
            _ => Err(format!("{label}无效。")),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn read_host_info_snapshot(value: Option<&Value>) -> Result<Value, String> {
    let Some(info) = value.and_then(Value::as_object) else {
        return Ok(Value::Null);
    };
    let collected_at = match info.get("collectedAt").and_then(Value::as_str) {
        Some(value) if !value.trim().is_empty() => {
            read_bounded_string(value, "主机信息采集时间", 64, true, true, true)?
        }
        _ => return Ok(Value::Null),
    };
    let items = info
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .take(32)
        .filter_map(|item| read_host_info_item(item).transpose())
        .collect::<Result<Vec<_>, _>>()?;
    if items.is_empty() {
        return Ok(Value::Null);
    }
    Ok(json!({
        "address": read_optional_bounded_string(info.get("address"), "主机信息地址", 255, true, true)?,
        "collectedAt": collected_at,
        "systemType": read_remote_system_type(info.get("systemType")),
        "systemName": read_optional_bounded_string(info.get("systemName"), "主机信息系统名称", 160, true, true)?,
        "items": items
    }))
}

fn read_host_info_item(value: &Value) -> Result<Option<Value>, String> {
    let Some(item) = value.as_object() else {
        return Ok(None);
    };
    let key = read_optional_bounded_string(item.get("key"), "主机信息键", 80, true, true)?;
    let label = read_optional_bounded_string(item.get("label"), "主机信息标签", 80, true, true)?;
    if key.is_empty() || label.is_empty() {
        return Ok(None);
    }
    let icon = read_optional_bounded_string(item.get("icon"), "主机信息图标", 16, true, true)?;
    let mut output = json!({
        "key": key,
        "label": label,
        "value": read_optional_bounded_string(item.get("value"), "主机信息内容", 20_000, true, false)?
    });
    if !icon.is_empty() {
        output["icon"] = json!(icon);
    }
    Ok(Some(output))
}

fn sanitize_host_jump_host_references(hosts: &mut [Value]) {
    let referenced = hosts
        .iter()
        .filter_map(|host| {
            let jump_host_id = host.get("jumpHostId")?.as_str()?.trim();
            if jump_host_id.is_empty() || jump_host_id == host.get("id")?.as_str()? {
                None
            } else if hosts
                .iter()
                .any(|candidate| candidate.get("id").and_then(Value::as_str) == Some(jump_host_id))
            {
                Some(jump_host_id.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    for host in hosts.iter_mut() {
        if referenced
            .iter()
            .any(|id| host.get("id").and_then(Value::as_str) == Some(id))
        {
            host["canBeJumpHost"] = json!(true);
        }
    }
    let snapshot = hosts.to_vec();
    for host in hosts.iter_mut() {
        let jump_host_id = host
            .get("jumpHostId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let valid_jump_host = !jump_host_id.is_empty()
            && host.get("id").and_then(Value::as_str) != Some(jump_host_id.as_str())
            && snapshot.iter().any(|candidate| {
                candidate.get("id").and_then(Value::as_str) == Some(jump_host_id.as_str())
                    && candidate
                        .get("canBeJumpHost")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            });
        if valid_jump_host {
            host["jumpHostId"] = json!(jump_host_id);
        } else {
            host["jumpHostId"] = json!("");
        }
    }
    let direct_snapshot = hosts.to_vec();
    for host in hosts.iter_mut() {
        let jump_host_id = host.get("jumpHostId").and_then(Value::as_str).unwrap_or("");
        let jump_host_has_parent = direct_snapshot.iter().any(|candidate| {
            candidate.get("id").and_then(Value::as_str) == Some(jump_host_id)
                && !candidate
                    .get("jumpHostId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .is_empty()
        });
        if jump_host_id.is_empty() || jump_host_has_parent {
            host["jumpHostId"] = json!("");
        }
    }
}

fn sort_hosts_by_list_order(hosts: &mut [Value]) {
    hosts.sort_by(|left, right| {
        let created =
            timestamp_millis(right.get("createdAt")).cmp(&timestamp_millis(left.get("createdAt")));
        if created != std::cmp::Ordering::Equal {
            return created;
        }
        let updated =
            timestamp_millis(right.get("updatedAt")).cmp(&timestamp_millis(left.get("updatedAt")));
        if updated != std::cmp::Ordering::Equal {
            return updated;
        }
        left.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(right.get("id").and_then(Value::as_str).unwrap_or(""))
    });
}

fn timestamp_millis(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(0)
}

pub(crate) fn normalize_ssh_keys_for_import(value: &Value) -> Result<Value, String> {
    let Some(keys) = value.as_array() else {
        return Ok(json!([]));
    };
    keys.iter()
        .map(read_vault_key_record)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

pub(crate) fn normalize_ssh_keys_for_store(
    existing: Option<&Value>,
    incoming: &Value,
) -> Result<Value, String> {
    let merged = merge_private_key_fields(existing, incoming)?;
    normalize_ssh_keys_for_import(&merged)
}

fn read_stored_key_record(value: &Value) -> Result<Value, String> {
    let Some(key) = value.as_object() else {
        return Err("密钥数据无效。".to_string());
    };
    let source = if key.get("source").and_then(Value::as_str) == Some("generated") {
        "generated"
    } else {
        "imported"
    };
    let algorithm = read_optional_bounded_string(key.get("algorithm"), "密钥算法", 64, true, true)?;
    Ok(json!({
        "id": read_bounded_string_value(key.get("id"), "密钥 ID", 128, true, true, true)?,
        "name": read_bounded_string_value(key.get("name"), "密钥名称", 80, true, true, true)?,
        "source": source,
        "algorithm": if algorithm.is_empty() { if source == "generated" { "RSA".to_string() } else { "SSH".to_string() } } else { algorithm },
        "fingerprint": read_optional_bounded_string(key.get("fingerprint"), "密钥指纹", 160, true, true)?,
        "publicKey": ensure_public_key_text(key.get("publicKey"))?,
        "passphrase": read_optional_bounded_string(key.get("passphrase"), "SSH 密钥口令", 4096, false, false)?,
        "createdAt": read_bounded_string_value(key.get("createdAt"), "密钥创建时间", 64, true, true, true)?,
        "updatedAt": read_bounded_string_value(key.get("updatedAt"), "密钥更新时间", 64, true, true, true)?
    }))
}

fn read_vault_key_record(value: &Value) -> Result<Value, String> {
    let mut key = read_stored_key_record(value)?;
    key["privateKey"] = json!(ensure_private_key_text(
        value.get("privateKey"),
        "SSH 私钥内容"
    )?);
    Ok(key)
}

fn ensure_public_key_text(value: Option<&Value>) -> Result<String, String> {
    match value {
        Some(Value::String(value)) => {
            read_bounded_string(value, "SSH 公钥", 128 * 1024, false, true, false)
        }
        _ => Ok(String::new()),
    }
}

fn ensure_private_key_text(value: Option<&Value>, label: &str) -> Result<String, String> {
    let Some(Value::String(value)) = value else {
        return Err(format!("{label}无效。"));
    };
    let value = read_bounded_string(
        value,
        label,
        MAX_PRIVATE_KEY_BYTES as usize,
        true,
        false,
        false,
    )?;
    if !value.contains("-----BEGIN ") || !value.contains("PRIVATE KEY-----") {
        return Err(format!("{label}无效。"));
    }
    Ok(value)
}

pub(crate) fn normalize_proxy_profiles(value: &Value) -> Result<Value, String> {
    let Some(profiles) = value.as_array() else {
        return Ok(json!([]));
    };
    profiles
        .iter()
        .map(read_proxy_profile)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn read_proxy_profile(value: &Value) -> Result<Value, String> {
    let Some(profile) = value.as_object() else {
        return Err("代理资料无效。".to_string());
    };
    Ok(json!({
        "id": read_bounded_string_value(profile.get("id"), "代理 ID", 128, true, true, true)?,
        "label": read_bounded_string_value(profile.get("label"), "代理名称", 80, true, true, true)?,
        "config": read_proxy_config(profile.get("config"))?,
        "createdAt": read_bounded_string_value(profile.get("createdAt"), "代理创建时间", 64, true, true, true)?,
        "updatedAt": read_bounded_string_value(profile.get("updatedAt").or_else(|| profile.get("createdAt")), "代理更新时间", 64, true, true, true)?
    }))
}

fn read_proxy_config(value: Option<&Value>) -> Result<Value, String> {
    let Some(config) = value.and_then(Value::as_object) else {
        return Err("代理配置无效。".to_string());
    };
    let proxy_type = config
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "http" | "socks5" | "command"))
        .ok_or_else(|| "代理类型无效。".to_string())?;
    if proxy_type == "command" {
        return Ok(json!({
            "type": proxy_type,
            "host": "",
            "port": 0,
            "command": read_optional_bounded_string(config.get("command"), "代理命令", 4096, false, false)?.trim().to_string(),
            "username": "",
            "password": ""
        }));
    }
    let port = read_port(config.get("port"), "代理端口")?;
    Ok(json!({
        "type": proxy_type,
        "host": read_bounded_string_value(config.get("host"), "代理主机", 255, true, true, true)?,
        "port": port,
        "command": "",
        "username": read_optional_bounded_string(config.get("username"), "代理用户名", 128, true, true)?,
        "password": read_optional_bounded_string(config.get("password"), "代理密码", 4096, false, false)?
    }))
}

pub(crate) fn normalize_known_hosts(value: &Value) -> Result<Value, String> {
    let Some(known_hosts) = value.as_array() else {
        return Ok(json!([]));
    };
    known_hosts
        .iter()
        .map(read_known_host_record)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn read_known_host_record(value: &Value) -> Result<Value, String> {
    let Some(known_host) = value.as_object() else {
        return Err("已知主机数据无效。".to_string());
    };
    let last_seen = match known_host.get("lastSeen").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => {
            read_bounded_string(value, "最近看到时间", 64, true, true, true)?
        }
        _ => String::new(),
    };
    Ok(json!({
        "id": read_bounded_string_value(known_host.get("id"), "已知主机 ID", 128, true, true, true)?,
        "hostname": read_bounded_string_value(known_host.get("hostname"), "已知主机名", 255, true, true, true)?,
        "port": read_port(known_host.get("port"), "已知主机端口")?,
        "keyType": read_optional_bounded_string(known_host.get("keyType"), "主机密钥类型", 80, true, true)?,
        "publicKey": read_optional_bounded_string(known_host.get("publicKey"), "主机公钥", 128 * 1024, true, false)?,
        "fingerprint": read_optional_bounded_string(known_host.get("fingerprint"), "主机指纹", 256, true, true)?,
        "discoveredAt": read_bounded_string_value(known_host.get("discoveredAt"), "发现时间", 64, true, true, true)?,
        "lastSeen": last_seen,
        "convertedToHostId": read_optional_bounded_string(known_host.get("convertedToHostId"), "转换主机 ID", 128, true, true)?
    }))
}

fn read_port(value: Option<&Value>, label: &str) -> Result<i64, String> {
    let port = match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok()))
            .filter(|value| (1..=65535).contains(value)),
        Some(Value::String(value)) => value
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|value| (1..=65535).contains(value)),
        _ => None,
    };
    port.ok_or_else(|| format!("{label}无效。"))
}
