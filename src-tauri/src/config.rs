use crate::vault::{
    normalize_app_settings, normalize_hosts, normalize_known_hosts, normalize_proxy_profiles,
    normalize_ssh_keys_for_import, read_store, to_snapshot, with_store_mut,
};
use crate::{error_string, read_json_file, sanitize_file_name, write_json_file_private, AppState};
use base64::Engine;
use serde_json::{json, Value};
use std::{fs, path::Path};
use tauri::Emitter;

const CONFIG_BUNDLE_FORMAT: &str = "shelldesk-config";
const CONFIG_BUNDLE_VERSION: i64 = 2;
const MAX_CONFIG_IMPORT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES: usize = 50_000_000;

#[derive(Debug, PartialEq, Eq)]
struct TextFileFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct SaveTextFileOptions {
    title: String,
    default_file_name: String,
    content: String,
    filters: Vec<TextFileFilter>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DialogLanguage {
    ZhCn,
    EnUs,
}

#[derive(Debug, PartialEq, Eq)]
struct DialogText {
    select_private_key: &'static str,
    select_public_key: &'static str,
    export_config: &'static str,
    import_config: &'static str,
    save_text_file: &'static str,
    all_files: &'static str,
    markdown: &'static str,
    text_files: &'static str,
    ssh_public_keys: &'static str,
    shell_desk_config: &'static str,
    import_size_error: &'static str,
}

#[derive(Debug, PartialEq, Eq)]
struct KeyFileDialogOptions {
    title: &'static str,
    filters: Vec<TextFileFilter>,
}

fn dialog_language_from_store(store: &Value) -> DialogLanguage {
    if store.pointer("/settings/language").and_then(Value::as_str) == Some("zh-CN") {
        DialogLanguage::ZhCn
    } else {
        DialogLanguage::EnUs
    }
}

fn dialog_text(language: DialogLanguage) -> DialogText {
    match language {
        DialogLanguage::ZhCn => DialogText {
            select_private_key: "选择 SSH 私钥文件",
            select_public_key: "选择 SSH 公钥文件",
            export_config: "导出完整主机配置",
            import_config: "导入完整主机配置",
            save_text_file: "保存文本文件",
            all_files: "All Files",
            markdown: "Markdown",
            text_files: "Text Files",
            ssh_public_keys: "SSH Public Keys",
            shell_desk_config: "ShellDesk Config",
            import_size_error: "备份文件为空或超过大小限制。",
        },
        DialogLanguage::EnUs => DialogText {
            select_private_key: "Choose SSH Private Key",
            select_public_key: "Choose SSH Public Key",
            export_config: "Export Full Host Configuration",
            import_config: "Import Full Host Configuration",
            save_text_file: "Save Text File",
            all_files: "All Files",
            markdown: "Markdown",
            text_files: "Text Files",
            ssh_public_keys: "SSH Public Keys",
            shell_desk_config: "ShellDesk Config",
            import_size_error: "The backup file is empty or exceeds the size limit.",
        },
    }
}

fn key_file_dialog_options(kind: &str, language: DialogLanguage) -> KeyFileDialogOptions {
    let text = dialog_text(language);
    match kind {
        "public" => KeyFileDialogOptions {
            title: text.select_public_key,
            filters: vec![
                TextFileFilter {
                    name: text.ssh_public_keys.to_string(),
                    extensions: vec!["pub".to_string(), "txt".to_string()],
                },
                TextFileFilter {
                    name: text.all_files.to_string(),
                    extensions: vec!["*".to_string()],
                },
            ],
        },
        _ => KeyFileDialogOptions {
            title: text.select_private_key,
            filters: vec![TextFileFilter {
                name: text.all_files.to_string(),
                extensions: vec!["*".to_string()],
            }],
        },
    }
}

pub(crate) fn select_key_file(state: &AppState, kind: &str) -> Result<Value, String> {
    let store = read_store(state)?;
    let options = key_file_dialog_options(kind, dialog_language_from_store(&store));
    let mut dialog = rfd::FileDialog::new().set_title(options.title);
    for filter in &options.filters {
        let extensions = filter
            .extensions
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let Some(path) = dialog.pick_file() else {
        return Ok(json!(""));
    };
    Ok(json!(path.to_string_lossy()))
}

fn read_save_text_file_options(
    payload: &Value,
    language: DialogLanguage,
) -> Result<SaveTextFileOptions, String> {
    if !payload.is_object() {
        return Err("保存文件请求无效。".to_string());
    }
    let text = dialog_text(language);
    let content = payload
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if content.len() > MAX_TEXT_FILE_BYTES {
        return Err("文件内容超过大小限制。".to_string());
    }
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .map(|value| value.replace(['\r', '\n', '\0'], " ").trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| text.save_text_file.to_string());
    let default_file_name = payload
        .get("defaultFileName")
        .and_then(Value::as_str)
        .map(sanitize_file_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("shelldesk-report-{}.md", &crate::now()[..10]));
    let filters = read_text_file_filters(payload.get("filters"))
        .unwrap_or_else(|| default_text_filters(language));
    Ok(SaveTextFileOptions {
        title,
        default_file_name,
        content,
        filters,
    })
}

fn read_text_file_filters(value: Option<&Value>) -> Option<Vec<TextFileFilter>> {
    let filters = value?.as_array()?;
    let parsed = filters
        .iter()
        .take(8)
        .filter_map(|filter| {
            let name = filter
                .get("name")
                .and_then(Value::as_str)
                .map(|value| value.replace(['\r', '\n', '\0'], " ").trim().to_string())
                .filter(|value| !value.is_empty())?;
            let extensions = filter
                .get("extensions")
                .and_then(Value::as_array)?
                .iter()
                .filter_map(|extension| {
                    let extension = extension
                        .as_str()?
                        .trim()
                        .trim_start_matches('.')
                        .to_string();
                    if extension.is_empty()
                        || extension.len() > 16
                        || extension.chars().any(|ch| {
                            !(ch.is_ascii_alphanumeric() || matches!(ch, '*' | '-' | '_'))
                        })
                    {
                        None
                    } else {
                        Some(extension)
                    }
                })
                .collect::<Vec<_>>();
            if extensions.is_empty() {
                None
            } else {
                Some(TextFileFilter { name, extensions })
            }
        })
        .collect::<Vec<_>>();
    if parsed.is_empty() {
        None
    } else {
        Some(parsed)
    }
}

fn default_text_filters(language: DialogLanguage) -> Vec<TextFileFilter> {
    let text = dialog_text(language);
    vec![
        TextFileFilter {
            name: text.markdown.to_string(),
            extensions: vec!["md".to_string()],
        },
        TextFileFilter {
            name: text.text_files.to_string(),
            extensions: vec!["txt".to_string()],
        },
        TextFileFilter {
            name: text.all_files.to_string(),
            extensions: vec!["*".to_string()],
        },
    ]
}

pub(crate) async fn save_text_file(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let payload = args.first().cloned().unwrap_or_else(|| json!({}));
    let store = read_store(state)?;
    let options = read_save_text_file_options(&payload, dialog_language_from_store(&store))?;
    let mut dialog = rfd::FileDialog::new()
        .set_title(&options.title)
        .set_file_name(&options.default_file_name);
    if let Some(documents_dir) = dirs::document_dir() {
        dialog = dialog.set_directory(documents_dir);
    }
    for filter in &options.filters {
        let extensions = filter
            .extensions
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let Some(path) = dialog.save_file() else {
        return Ok(json!(""));
    };
    write_text_file_private(&path, &options.content)?;
    Ok(json!(path.to_string_lossy()))
}

pub(crate) async fn export_config(state: &AppState) -> Result<Value, String> {
    let store = read_store(state)?;
    let text = dialog_text(dialog_language_from_store(&store));
    let mut dialog = rfd::FileDialog::new()
        .set_title(text.export_config)
        .set_file_name(format!("shelldesk-config-{}.json", &crate::now()[..10]))
        .add_filter(text.shell_desk_config, &["json"]);
    if let Some(documents_dir) = dirs::document_dir() {
        dialog = dialog.set_directory(documents_dir);
    }
    let Some(path) = dialog.save_file() else {
        return Ok(json!(""));
    };
    write_json_file_private(&path, &build_config_bundle(&store))?;
    Ok(json!(path.to_string_lossy()))
}

pub(crate) async fn import_config(
    state: &AppState,
    window: &tauri::Window,
) -> Result<Value, String> {
    let current_store = read_store(state)?;
    let language = dialog_language_from_store(&current_store);
    let text = dialog_text(language);
    let Some(path) = rfd::FileDialog::new()
        .set_title(text.import_config)
        .add_filter(text.shell_desk_config, &["json"])
        .pick_file()
    else {
        return Ok(Value::Null);
    };
    validate_config_import_file(&path, language)?;
    let imported = read_config_import_payload(read_json_file(&path, json!({}))?)?;
    let snapshot = with_store_mut(state, |store| {
        for key in [
            "hosts",
            "sshKeys",
            "proxyProfiles",
            "knownHosts",
            "settings",
            "browserBookmarks",
            "remoteConnectionProfiles",
        ] {
            if let Some(value) = imported.get(key) {
                store[key] = value.clone();
            }
        }
        Ok(to_snapshot(state, store.clone()))
    })?;
    let _ = window.emit("vault:changed", json!({ "kind": "vault" }));
    Ok(snapshot)
}

fn validate_config_import_file(path: &Path, language: DialogLanguage) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(error_string)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CONFIG_IMPORT_BYTES {
        return Err(dialog_text(language).import_size_error.to_string());
    }
    Ok(())
}

fn write_text_file_private(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(error_string)?;
    }
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

fn build_config_bundle(store: &Value) -> Value {
    json!({
        "format": CONFIG_BUNDLE_FORMAT,
        "version": CONFIG_BUNDLE_VERSION,
        "exportedAt": crate::now(),
        "hosts": store.get("hosts").cloned().unwrap_or_else(|| json!([])),
        "sshKeys": export_ssh_keys(store.get("sshKeys")),
        "proxyProfiles": store.get("proxyProfiles").cloned().unwrap_or_else(|| json!([])),
        "knownHosts": store.get("knownHosts").cloned().unwrap_or_else(|| json!([])),
        "settings": store.get("settings").cloned().unwrap_or_else(|| json!({})),
        "browserBookmarks": store.get("browserBookmarks").cloned().unwrap_or_else(|| json!([])),
        "remoteConnectionProfiles": export_remote_connection_profiles(store.get("remoteConnectionProfiles"))
    })
}

fn export_ssh_keys(keys: Option<&Value>) -> Value {
    let items = keys.and_then(Value::as_array).cloned().unwrap_or_default();
    Value::Array(
        items
            .into_iter()
            .map(|mut item| {
                let private_key = item
                    .get("privateKey")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(object) = item.as_object_mut() {
                    object.remove("privateKey");
                    object.insert(
                        "privateKeyBase64".to_string(),
                        json!(base64::engine::general_purpose::STANDARD.encode(private_key)),
                    );
                }
                item
            })
            .collect(),
    )
}

fn read_config_import_payload(raw_payload: Value) -> Result<Value, String> {
    if is_config_bundle(&raw_payload) {
        return read_config_bundle_payload(raw_payload);
    }
    read_legacy_snapshot_payload(raw_payload)
}

fn is_config_bundle(payload: &Value) -> bool {
    payload
        .get("format")
        .and_then(Value::as_str)
        .is_some_and(|value| value == CONFIG_BUNDLE_FORMAT)
}

fn read_config_bundle_payload(payload: Value) -> Result<Value, String> {
    let version = payload.get("version").and_then(Value::as_i64).unwrap_or(0);
    if version != 1 && version != CONFIG_BUNDLE_VERSION {
        return Err("备份文件版本不受支持。".to_string());
    }
    ensure_array_field(&payload, "hosts")?;
    ensure_array_field(&payload, "sshKeys")?;
    let mut imported = json!({
        "hosts": normalize_hosts(payload.get("hosts").unwrap_or(&Value::Null))?,
        "sshKeys": normalize_ssh_keys_for_import(&import_bundle_ssh_keys(payload.get("sshKeys"))?)?,
        "proxyProfiles": normalize_proxy_profiles(payload.get("proxyProfiles").unwrap_or(&Value::Null))?,
        "knownHosts": normalize_known_hosts(payload.get("knownHosts").unwrap_or(&Value::Null))?,
        "settings": normalize_app_settings(payload.get("settings").unwrap_or(&Value::Null))?,
        "browserBookmarks": payload.get("browserBookmarks").cloned().unwrap_or_else(|| json!([])),
        "remoteConnectionProfiles": import_remote_connection_profiles(payload.get("remoteConnectionProfiles"))
    });
    normalize_import_collection_shapes(&mut imported);
    Ok(imported)
}

fn read_legacy_snapshot_payload(payload: Value) -> Result<Value, String> {
    if !payload.is_object() {
        return Err("不是受支持的 ShellDesk 完整备份文件。".to_string());
    }
    let mut imported = json!({
        "hosts": normalize_hosts(payload.get("hosts").unwrap_or(&Value::Null))?,
        "sshKeys": normalize_ssh_keys_for_import(payload.get("sshKeys").unwrap_or(&Value::Null))?,
        "proxyProfiles": normalize_proxy_profiles(payload.get("proxyProfiles").unwrap_or(&Value::Null))?,
        "knownHosts": normalize_known_hosts(payload.get("knownHosts").unwrap_or(&Value::Null))?,
        "settings": normalize_app_settings(payload.get("settings").unwrap_or(&Value::Null))?,
        "browserBookmarks": payload.get("browserBookmarks").cloned().unwrap_or_else(|| json!([])),
        "remoteConnectionProfiles": import_remote_connection_profiles(payload.get("remoteConnectionProfiles"))
    });
    normalize_import_collection_shapes(&mut imported);
    Ok(imported)
}

fn ensure_array_field(payload: &Value, key: &str) -> Result<(), String> {
    if payload.get(key).and_then(Value::as_array).is_none() {
        return Err("不是受支持的 ShellDesk 完整备份文件。".to_string());
    }
    Ok(())
}

fn normalize_import_collection_shapes(payload: &mut Value) {
    for key in [
        "hosts",
        "sshKeys",
        "proxyProfiles",
        "knownHosts",
        "browserBookmarks",
    ] {
        if !payload.get(key).is_some_and(Value::is_array) {
            payload[key] = json!([]);
        }
    }
    if !payload.get("settings").is_some_and(Value::is_object) {
        payload["settings"] = normalize_app_settings(&Value::Null).unwrap_or_else(|_| json!({}));
    }
    if !payload
        .get("remoteConnectionProfiles")
        .is_some_and(Value::is_object)
    {
        payload["remoteConnectionProfiles"] = json!({});
    }
}

fn export_remote_connection_profiles(profiles: Option<&Value>) -> Value {
    let Some(profile_object) = profiles.and_then(Value::as_object) else {
        return json!([]);
    };
    let mut exported = Vec::new();
    for (host_id, host_profiles) in profile_object {
        let Some(app_profiles) = host_profiles.as_object() else {
            continue;
        };
        for (app_key, values) in app_profiles {
            exported.push(json!({
                "hostId": host_id,
                "appKey": app_key,
                "values": values,
                "updatedAt": crate::now()
            }));
        }
    }
    exported.sort_by(|left, right| {
        let left_key = format!(
            "{}:{}",
            left.get("hostId").and_then(Value::as_str).unwrap_or(""),
            left.get("appKey").and_then(Value::as_str).unwrap_or("")
        );
        let right_key = format!(
            "{}:{}",
            right.get("hostId").and_then(Value::as_str).unwrap_or(""),
            right.get("appKey").and_then(Value::as_str).unwrap_or("")
        );
        left_key.cmp(&right_key)
    });
    Value::Array(exported)
}

fn import_remote_connection_profiles(profiles: Option<&Value>) -> Value {
    if let Some(object_profiles) = profiles.and_then(Value::as_object) {
        return Value::Object(object_profiles.clone());
    }
    let mut profile_store = serde_json::Map::new();
    let Some(profile_array) = profiles.and_then(Value::as_array) else {
        return Value::Object(profile_store);
    };
    for profile in profile_array {
        let Some(host_id) = profile
            .get("hostId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(app_key) = profile
            .get("appKey")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let values = profile.get("values").cloned().unwrap_or_else(|| json!({}));
        let host_profiles = profile_store
            .entry(host_id.to_string())
            .or_insert_with(|| json!({}));
        if let Some(host_object) = host_profiles.as_object_mut() {
            host_object.entry(app_key.to_string()).or_insert(values);
        }
    }
    Value::Object(profile_store)
}

fn import_bundle_ssh_keys(keys: Option<&Value>) -> Result<Value, String> {
    let items = keys
        .and_then(Value::as_array)
        .ok_or_else(|| "不是受支持的 ShellDesk 完整备份文件。".to_string())?;
    let mut imported = Vec::new();
    for item in items {
        let mut next = item.clone();
        let private_key_base64 = next
            .get("privateKeyBase64")
            .and_then(Value::as_str)
            .unwrap_or("");
        if private_key_base64.is_empty() {
            return Err("SSH 私钥内容无效。".to_string());
        }
        let private_key = base64::engine::general_purpose::STANDARD
            .decode(private_key_base64)
            .map_err(|_| "SSH 私钥内容无效。".to_string())
            .and_then(|bytes| {
                String::from_utf8(bytes).map_err(|_| "SSH 私钥内容无效。".to_string())
            })?;
        if let Some(object) = next.as_object_mut() {
            object.remove("privateKeyBase64");
            object.insert("privateKey".to_string(), json!(private_key));
        }
        imported.push(next);
    }
    Ok(Value::Array(imported))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_text_file_options_preserve_frontend_dialog_payload() {
        let options = read_save_text_file_options(
            &json!({
                "title": "导出 MySQL 查询结果",
                "defaultFileName": "prod/query:result.csv",
                "content": "a,b\n1,2\n",
                "filters": [
                    { "name": "CSV Files", "extensions": [".csv"] },
                    { "name": "All Files", "extensions": ["*"] }
                ]
            }),
            DialogLanguage::ZhCn,
        )
        .unwrap();
        assert_eq!(options.title, "导出 MySQL 查询结果");
        assert_eq!(options.default_file_name, "prod_query_result.csv");
        assert_eq!(options.content, "a,b\n1,2\n");
        assert_eq!(
            options.filters,
            vec![
                TextFileFilter {
                    name: "CSV Files".to_string(),
                    extensions: vec!["csv".to_string()]
                },
                TextFileFilter {
                    name: "All Files".to_string(),
                    extensions: vec!["*".to_string()]
                }
            ]
        );
    }

    #[test]
    fn save_text_file_options_reject_invalid_payload() {
        assert_eq!(
            read_save_text_file_options(&json!(null), DialogLanguage::ZhCn).unwrap_err(),
            "保存文件请求无效。"
        );
    }

    #[test]
    fn save_text_file_options_use_legacy_default_text() {
        let options = read_save_text_file_options(
            &json!({
                "content": "hello"
            }),
            DialogLanguage::EnUs,
        )
        .unwrap();
        assert_eq!(options.title, "Save Text File");
        assert_eq!(
            options.filters,
            vec![
                TextFileFilter {
                    name: "Markdown".to_string(),
                    extensions: vec!["md".to_string()]
                },
                TextFileFilter {
                    name: "Text Files".to_string(),
                    extensions: vec!["txt".to_string()]
                },
                TextFileFilter {
                    name: "All Files".to_string(),
                    extensions: vec!["*".to_string()]
                }
            ]
        );
    }

    #[test]
    fn key_file_dialog_options_match_legacy_filters() {
        let private_options = key_file_dialog_options("private", DialogLanguage::ZhCn);
        assert_eq!(private_options.title, "选择 SSH 私钥文件");
        assert_eq!(
            private_options.filters,
            vec![TextFileFilter {
                name: "All Files".to_string(),
                extensions: vec!["*".to_string()]
            }]
        );

        let public_options = key_file_dialog_options("public", DialogLanguage::EnUs);
        assert_eq!(public_options.title, "Choose SSH Public Key");
        assert_eq!(
            public_options.filters,
            vec![
                TextFileFilter {
                    name: "SSH Public Keys".to_string(),
                    extensions: vec!["pub".to_string(), "txt".to_string()]
                },
                TextFileFilter {
                    name: "All Files".to_string(),
                    extensions: vec!["*".to_string()]
                }
            ]
        );
    }

    #[test]
    fn dialog_text_keeps_legacy_config_labels() {
        let zh = dialog_text(DialogLanguage::ZhCn);
        assert_eq!(zh.export_config, "导出完整主机配置");
        assert_eq!(zh.import_config, "导入完整主机配置");
        assert_eq!(zh.shell_desk_config, "ShellDesk Config");
        assert_eq!(zh.import_size_error, "备份文件为空或超过大小限制。");

        let en = dialog_text(DialogLanguage::EnUs);
        assert_eq!(en.export_config, "Export Full Host Configuration");
        assert_eq!(en.import_config, "Import Full Host Configuration");
        assert_eq!(
            en.import_size_error,
            "The backup file is empty or exceeds the size limit."
        );
    }

    #[test]
    fn dialog_language_reads_vault_settings() {
        assert_eq!(
            dialog_language_from_store(&json!({ "settings": { "language": "zh-CN" } })),
            DialogLanguage::ZhCn
        );
        assert_eq!(
            dialog_language_from_store(&json!({ "settings": { "language": "en-US" } })),
            DialogLanguage::EnUs
        );
    }

    #[test]
    fn config_bundle_exports_private_keys_as_base64() {
        let bundle = build_config_bundle(&json!({
            "hosts": [],
            "sshKeys": [{
                "id": "key-1",
                "name": "prod",
                "privateKey": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
                "publicKey": "ssh-rsa AAAA",
                "passphrase": ""
            }],
            "remoteConnectionProfiles": {
                "host-1": { "mysql": { "password": "secret" } }
            }
        }));
        let key = &bundle["sshKeys"][0];
        assert!(key.get("privateKey").is_none());
        assert_eq!(
            key.get("privateKeyBase64").and_then(Value::as_str),
            Some("LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCmFiYwotLS0tLUVORCBQUklWQVRFIEtFWS0tLS0t")
        );
        assert_eq!(bundle["format"], CONFIG_BUNDLE_FORMAT);
        assert_eq!(bundle["version"], CONFIG_BUNDLE_VERSION);
        assert_eq!(bundle["remoteConnectionProfiles"][0]["hostId"], "host-1");
        assert_eq!(bundle["remoteConnectionProfiles"][0]["appKey"], "mysql");
        assert_eq!(
            bundle["remoteConnectionProfiles"][0]["values"]["password"],
            "secret"
        );
    }

    #[test]
    fn config_bundle_import_restores_private_keys() {
        let imported = read_config_import_payload(json!({
            "format": CONFIG_BUNDLE_FORMAT,
            "version": CONFIG_BUNDLE_VERSION,
            "hosts": [],
            "sshKeys": [{
                "id": "key-1",
                "name": "prod",
                "source": "imported",
                "algorithm": "RSA",
                "fingerprint": "",
                "privateKeyBase64": "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCnByaXZhdGUKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQ==",
                "publicKey": "ssh-rsa AAAA",
                "passphrase": "",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-02T00:00:00.000Z"
            }],
            "remoteConnectionProfiles": [
                { "hostId": "host-1", "appKey": "redis", "values": { "password": "secret" } }
            ]
        }))
        .unwrap();
        assert_eq!(
            imported["sshKeys"][0]["privateKey"],
            "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----"
        );
        assert!(imported["sshKeys"][0].get("privateKeyBase64").is_none());
        assert_eq!(
            imported["remoteConnectionProfiles"]["host-1"]["redis"]["password"],
            "secret"
        );
    }

    #[test]
    fn legacy_snapshot_import_is_still_supported() {
        let imported = read_config_import_payload(json!({
            "hosts": [{
                "id": "host-1",
                "name": "Prod",
                "address": "example.com",
                "port": 22,
                "username": "root",
                "authMethod": "password",
                "password": "secret",
                "group": "",
                "tags": [],
                "note": "",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-02T00:00:00.000Z"
            }],
            "sshKeys": [{
                "id": "key-1",
                "name": "prod",
                "source": "imported",
                "algorithm": "RSA",
                "fingerprint": "",
                "publicKey": "ssh-rsa AAAA",
                "privateKey": "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
                "passphrase": "",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-02T00:00:00.000Z"
            }],
            "settings": { "language": "zh-CN" }
        }))
        .unwrap();
        assert_eq!(imported["hosts"][0]["id"], "host-1");
        assert_eq!(
            imported["sshKeys"][0]["privateKey"],
            "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----"
        );
        assert_eq!(imported["settings"]["language"], "zh-CN");
    }

    #[test]
    fn unsupported_config_bundle_versions_are_rejected() {
        assert_eq!(
            read_config_import_payload(json!({
                "format": CONFIG_BUNDLE_FORMAT,
                "version": 99,
                "hosts": [],
                "sshKeys": []
            }))
            .unwrap_err(),
            "备份文件版本不受支持。"
        );
    }
}
