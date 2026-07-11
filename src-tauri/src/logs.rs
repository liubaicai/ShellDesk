use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::{collections::HashSet, fs, path::PathBuf};

use crate::{error_string, now, AppState};

const MAX_LOG_ENTRIES: usize = 5_000;

fn logs_path(state: &AppState) -> PathBuf {
    state.data_dir.join("logs.json")
}

fn logs_database_path(state: &AppState) -> PathBuf {
    state.data_dir.join("logs.sqlite")
}

pub(crate) fn get_entries(state: &AppState) -> Result<Value, String> {
    Ok(Value::Array(read_log_entries(state)))
}

pub(crate) fn clear_entries(state: &AppState) -> Result<Value, String> {
    write_log_entries(state, &[])?;
    Ok(json!([]))
}

pub(crate) fn save_entries(state: &AppState, entries: Value) -> Result<Value, String> {
    let parsed_entries = read_log_entry_list(&entries)?;
    if entries.as_array().is_some_and(Vec::is_empty) {
        write_log_entries(state, &[])?;
        return get_entries(state);
    }
    let existing_entries = read_log_entries(state);
    let existing_entries = Value::Array(existing_entries);
    let existing_entries = read_log_entry_list(&existing_entries)?;
    let merged = merge_log_entries(&parsed_entries, &existing_entries);
    write_log_entries(state, &merged)?;
    get_entries(state)
}

pub(crate) fn append_entry(state: &AppState, entry: Value) -> Result<Value, String> {
    let Some(parsed_entry) = read_log_entry(&entry)? else {
        return Err("日志条目无效。".to_string());
    };
    let connection = open_logs_database(state)?;
    upsert_log_entry(&connection, &parsed_entry)?;
    prune_log_entries(&connection)?;
    get_entries(state)
}

fn read_log_entries(state: &AppState) -> Vec<Value> {
    let Ok(connection) = open_logs_database(state) else {
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT id, timestamp, category, level, message, detail, component, host_id, host_name, host_address
         FROM log_entries ORDER BY timestamp DESC, rowid DESC LIMIT ?1",
    ) else {
        return Vec::new();
    };
    let Ok(entries) = statement.query_map([MAX_LOG_ENTRIES as i64], log_entry_from_row) else {
        return Vec::new();
    };
    entries.filter_map(Result::ok).collect()
}

fn write_log_entries(state: &AppState, entries: &[Value]) -> Result<(), String> {
    let connection = open_logs_database(state)?;
    connection
        .execute("DELETE FROM log_entries", [])
        .map_err(error_string)?;
    for entry in entries.iter().take(MAX_LOG_ENTRIES).rev() {
        upsert_log_entry(&connection, entry)?;
    }
    Ok(())
}

fn open_logs_database(state: &AppState) -> Result<Connection, String> {
    if let Some(parent) = logs_database_path(state).parent() {
        fs::create_dir_all(parent).map_err(error_string)?;
    }
    let connection = Connection::open(logs_database_path(state)).map_err(error_string)?;
    connection
        .execute_batch(
            "PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS log_entries (
               id TEXT PRIMARY KEY NOT NULL,
               timestamp TEXT NOT NULL,
               category TEXT NOT NULL,
               level TEXT NOT NULL,
               message TEXT NOT NULL,
               detail TEXT NOT NULL,
               component TEXT NOT NULL DEFAULT '',
               host_id TEXT NOT NULL DEFAULT '',
               host_name TEXT NOT NULL DEFAULT '',
               host_address TEXT NOT NULL DEFAULT ''
             );
             CREATE INDEX IF NOT EXISTS idx_log_entries_timestamp ON log_entries(timestamp DESC);
             CREATE TABLE IF NOT EXISTS log_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
        )
        .map_err(error_string)?;
    migrate_legacy_log_entries(&connection, state)?;
    Ok(connection)
}

fn migrate_legacy_log_entries(connection: &Connection, state: &AppState) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM log_metadata WHERE key = 'legacy-json-migrated'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(error_string)?;
    if migrated.is_some() {
        return Ok(());
    }

    let legacy_entries = read_legacy_log_entries(state);
    for entry in legacy_entries.iter().take(MAX_LOG_ENTRIES).rev() {
        upsert_log_entry(connection, entry)?;
    }
    connection
        .execute(
            "INSERT INTO log_metadata (key, value) VALUES ('legacy-json-migrated', '1')",
            [],
        )
        .map_err(error_string)?;
    Ok(())
}

fn read_legacy_log_entries(state: &AppState) -> Vec<Value> {
    let Ok(content) = fs::read_to_string(logs_path(state)) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Vec::new();
    };
    read_log_entry_list(&value).unwrap_or_default()
}

fn upsert_log_entry(connection: &Connection, entry: &Value) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO log_entries (id, timestamp, category, level, message, detail, component, host_id, host_name, host_address)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               timestamp = excluded.timestamp, category = excluded.category, level = excluded.level,
               message = excluded.message, detail = excluded.detail, component = excluded.component,
               host_id = excluded.host_id, host_name = excluded.host_name, host_address = excluded.host_address",
            params![
                entry["id"].as_str().unwrap_or_default(),
                entry["timestamp"].as_str().unwrap_or_default(),
                entry["category"].as_str().unwrap_or("system"),
                entry["level"].as_str().unwrap_or("info"),
                entry["message"].as_str().unwrap_or_default(),
                entry["detail"].as_str().unwrap_or_default(),
                entry["component"].as_str().unwrap_or_default(),
                entry["hostId"].as_str().unwrap_or_default(),
                entry["hostName"].as_str().unwrap_or_default(),
                entry["hostAddress"].as_str().unwrap_or_default(),
            ],
        )
        .map_err(error_string)?;
    Ok(())
}

fn prune_log_entries(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM log_entries WHERE id NOT IN (
               SELECT id FROM log_entries ORDER BY timestamp DESC, rowid DESC LIMIT ?1
             )",
            [MAX_LOG_ENTRIES as i64],
        )
        .map_err(error_string)?;
    Ok(())
}

fn log_entry_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut entry = Map::new();
    entry.insert("id".to_string(), json!(row.get::<_, String>(0)?));
    entry.insert("timestamp".to_string(), json!(row.get::<_, String>(1)?));
    entry.insert("category".to_string(), json!(row.get::<_, String>(2)?));
    entry.insert("level".to_string(), json!(row.get::<_, String>(3)?));
    entry.insert("message".to_string(), json!(row.get::<_, String>(4)?));
    entry.insert("detail".to_string(), json!(row.get::<_, String>(5)?));
    for (column, key) in [
        (6, "component"),
        (7, "hostId"),
        (8, "hostName"),
        (9, "hostAddress"),
    ] {
        let value = row.get::<_, String>(column)?;
        if !value.is_empty() {
            entry.insert(key.to_string(), json!(value));
        }
    }
    Ok(Value::Object(entry))
}

fn read_log_entry_list(entries: &Value) -> Result<Vec<Value>, String> {
    let Some(items) = entries.as_array() else {
        return Ok(Vec::new());
    };
    items
        .iter()
        .take(MAX_LOG_ENTRIES)
        .filter_map(|entry| read_log_entry(entry).transpose())
        .collect()
}

fn read_log_entry(entry: &Value) -> Result<Option<Value>, String> {
    let Some(raw_entry) = entry.as_object() else {
        return Ok(None);
    };
    let id = raw_entry
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| read_bounded_string(value, "日志 ID", 120, true, true, true))
        .transpose()?
        .unwrap_or_default();
    let timestamp = raw_entry
        .get("timestamp")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| read_bounded_string(value, "日志时间", 80, true, true, true))
        .transpose()?
        .unwrap_or_else(now);
    let category = raw_entry
        .get("category")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "connection" | "host" | "key" | "config" | "system"))
        .unwrap_or("system")
        .to_string();
    let level = raw_entry
        .get("level")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "info" | "success" | "warning" | "error"))
        .unwrap_or("info")
        .to_string();
    let message = read_bounded_string(
        &js_string(raw_entry.get("message").unwrap_or(&Value::Null)),
        "日志内容",
        500,
        false,
        true,
        false,
    )?;
    let detail = read_bounded_string(
        &js_string(raw_entry.get("detail").unwrap_or(&Value::Null)),
        "日志详情",
        4000,
        false,
        true,
        false,
    )?;
    let component = optional_string(raw_entry, "component", "日志组件", 180)?;
    let host_id = optional_string(raw_entry, "hostId", "日志主机 ID", 180)?;
    let host_name = optional_string(raw_entry, "hostName", "日志主机名称", 180)?;
    let host_address = optional_string(raw_entry, "hostAddress", "日志主机地址", 255)?;

    if id.is_empty() || message.is_empty() {
        return Ok(None);
    }

    let mut output = Map::new();
    output.insert("id".to_string(), json!(id));
    output.insert("timestamp".to_string(), json!(timestamp));
    output.insert("category".to_string(), json!(category));
    output.insert("level".to_string(), json!(level));
    output.insert("message".to_string(), json!(message));
    output.insert("detail".to_string(), json!(detail));
    if !component.is_empty() {
        output.insert("component".to_string(), json!(component));
    }
    if !host_id.is_empty() {
        output.insert("hostId".to_string(), json!(host_id));
    }
    if !host_name.is_empty() {
        output.insert("hostName".to_string(), json!(host_name));
    }
    if !host_address.is_empty() {
        output.insert("hostAddress".to_string(), json!(host_address));
    }
    Ok(Some(Value::Object(output)))
}

fn optional_string(
    entry: &Map<String, Value>,
    key: &str,
    label: &str,
    max_length: usize,
) -> Result<String, String> {
    entry
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(|value| read_bounded_string(value, label, max_length, false, true, true))
        .transpose()
        .map(Option::unwrap_or_default)
}

fn read_bounded_string(
    value: &str,
    label: &str,
    max_length: usize,
    required: bool,
    trim: bool,
    reject_line_breaks: bool,
) -> Result<String, String> {
    let next_value = if trim {
        value.trim().to_string()
    } else {
        value.to_string()
    };
    if required && next_value.is_empty() {
        return Err(format!("请输入{}。", label));
    }
    if next_value.chars().count() > max_length
        || next_value.contains('\0')
        || (reject_line_breaks && next_value.contains(['\r', '\n']))
    {
        return Err(format!("{}无效。", label));
    }
    Ok(next_value)
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn merge_log_entries(primary_entries: &[Value], secondary_entries: &[Value]) -> Vec<Value> {
    let mut seen_ids = HashSet::new();
    let mut merged_entries = Vec::new();
    for entry in primary_entries.iter().chain(secondary_entries) {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !seen_ids.insert(id.to_string()) {
            continue;
        }
        merged_entries.push(entry.clone());
        if merged_entries.len() >= MAX_LOG_ENTRIES {
            break;
        }
    }
    merged_entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{random_id, AppState};

    fn temp_state() -> AppState {
        let path = std::env::temp_dir().join(random_id("shelldesk-logs-test"));
        AppState::new(path)
    }

    #[test]
    fn append_entry_validates_and_prepends_legacy_log_entries() {
        let state = temp_state();
        let first = append_entry(
            &state,
            json!({
                "id": "entry-1",
                "timestamp": "2026-01-01T00:00:00.000Z",
                "category": "connection",
                "level": "success",
                "message": "connected",
                "detail": "host ready",
                "component": "terminal",
                "hostId": "host-1",
                "hostName": "Prod",
                "hostAddress": "10.0.0.1"
            }),
        )
        .unwrap();
        assert_eq!(first[0]["id"], "entry-1");
        assert_eq!(first[0]["category"], "connection");
        assert_eq!(first[0]["level"], "success");
        assert_eq!(first[0]["component"], "terminal");

        let second = append_entry(
            &state,
            json!({
                "id": "entry-2",
                "message": "newer",
                "category": "unknown",
                "level": "verbose"
            }),
        )
        .unwrap();
        assert_eq!(second[0]["id"], "entry-2");
        assert_eq!(second[0]["category"], "system");
        assert_eq!(second[0]["level"], "info");
        assert_eq!(second[1]["id"], "entry-1");

        fs::remove_dir_all(&state.data_dir).ok();
    }

    #[test]
    fn append_entry_rejects_invalid_log_entries() {
        let state = temp_state();
        assert_eq!(
            append_entry(&state, json!({ "id": "entry-1", "message": "" })).unwrap_err(),
            "日志条目无效。"
        );
        fs::remove_dir_all(&state.data_dir).ok();
    }

    #[test]
    fn save_entries_filters_merges_deduplicates_and_clears() {
        let state = temp_state();
        append_entry(&state, json!({ "id": "old", "message": "old message" })).unwrap();
        let saved = save_entries(
            &state,
            json!([
                { "id": "new", "message": "new message" },
                { "id": "old", "message": "replacement wins" },
                { "id": "", "message": "ignored" },
                null
            ]),
        )
        .unwrap();
        assert_eq!(saved.as_array().unwrap().len(), 2);
        assert_eq!(saved[0]["id"], "new");
        assert_eq!(saved[1]["id"], "old");
        assert_eq!(saved[1]["message"], "replacement wins");

        let cleared = save_entries(&state, json!([])).unwrap();
        assert!(cleared.as_array().unwrap().is_empty());
        fs::remove_dir_all(&state.data_dir).ok();
    }

    #[test]
    fn read_log_entries_tolerates_corrupt_or_non_array_files() {
        let state = temp_state();
        fs::create_dir_all(&state.data_dir).unwrap();
        fs::write(logs_path(&state), "{").unwrap();
        assert!(get_entries(&state).unwrap().as_array().unwrap().is_empty());
        fs::write(logs_path(&state), "{}").unwrap();
        assert!(get_entries(&state).unwrap().as_array().unwrap().is_empty());
        fs::remove_dir_all(&state.data_dir).ok();
    }

    #[test]
    fn legacy_json_entries_are_imported_once_into_sqlite() {
        let state = temp_state();
        fs::create_dir_all(&state.data_dir).unwrap();
        fs::write(
            logs_path(&state),
            serde_json::to_string(&json!([
                {
                    "id": "legacy-entry",
                    "timestamp": "2026-01-01T00:00:00.000Z",
                    "category": "connection",
                    "level": "success",
                    "message": "legacy entry"
                }
            ]))
            .unwrap(),
        )
        .unwrap();

        let imported = get_entries(&state).unwrap();
        assert_eq!(imported[0]["id"], "legacy-entry");
        assert!(logs_database_path(&state).exists());

        write_log_entries(&state, &[]).unwrap();
        let after_clear = get_entries(&state).unwrap();
        assert!(after_clear.as_array().unwrap().is_empty());

        fs::remove_dir_all(&state.data_dir).ok();
    }
}
