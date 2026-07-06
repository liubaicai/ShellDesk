use serde_json::{json, Value};

use super::{
    codec::encode_config_id,
    parse::{parse_csv_objects, parse_csv_query},
    session::{decode_active_db_session_args, register_db_session},
    sql::{sqlite_identifier, sqlite_identifier_literal, sqlite_literal, sqlite_value_literal},
};
use crate::{
    get_connection, ps_quote, read_string_field, run_connection_command, shell_quote, string_arg,
    AppState, ConnectionKind,
};

pub(crate) async fn sqlite_open(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let file_path = string_arg(&args, 1)?;
    let options = sqlite_options_from_arg(args.get(2));
    let config = json!({ "filePath": file_path, "options": options });
    let sqlite_id = encode_config_id("sqlite", &config)?;
    let _ = run_sqlite_cli(state, &connection_id, &config, "SELECT 1 AS ok;", None).await?;
    register_db_session(state, "sqlite", &connection_id, &sqlite_id, config.clone())?;
    Ok(
        json!({ "sqliteId": sqlite_id, "filePath": config.get("filePath").cloned().unwrap_or(Value::Null) }),
    )
}

pub(crate) async fn sqlite_tables(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let (connection_id, config) = decode_active_db_session_args(state, "sqlite", &args, 0, 1)?;
    let options = sqlite_operation_options(&config, args.get(2));
    let output = run_sqlite_cli(
        state,
        &connection_id,
        &config,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
        Some(&options),
    )
    .await?;
    let rows = parse_csv_objects(&output)?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| row.get("name").cloned())
        .collect::<Vec<_>>()))
}

pub(crate) async fn sqlite_objects(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let (connection_id, config) = decode_active_db_session_args(state, "sqlite", &args, 0, 1)?;
    let options = sqlite_operation_options(&config, args.get(2));
    let output = run_sqlite_cli(
        state,
        &connection_id,
        &config,
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type IN ('table','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name;",
        Some(&options),
    )
    .await?;
    let rows = parse_csv_objects(&output)?;
    Ok(json!(rows
        .into_iter()
        .map(|row| json!({
            "type": row.get("type").cloned().unwrap_or_default(),
            "name": row.get("name").cloned().unwrap_or_default(),
            "tableName": row.get("tableName").cloned().unwrap_or_default(),
            "sql": row.get("sql").cloned().unwrap_or_default()
        }))
        .collect::<Vec<_>>()))
}

pub(crate) async fn sqlite_columns(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let (connection_id, config) = decode_active_db_session_args(state, "sqlite", &args, 0, 1)?;
    let table = string_arg(&args, 2)?;
    let options = sqlite_operation_options(&config, args.get(3));
    let sql = format!("PRAGMA table_info({});", sqlite_identifier_literal(&table));
    let output = run_sqlite_cli(state, &connection_id, &config, &sql, Some(&options)).await?;
    let rows = parse_csv_objects(&output)?;
    Ok(json!(rows
        .into_iter()
        .map(|row| json!({
            "name": row.get("name").cloned().unwrap_or_default(),
            "type": row.get("type").cloned().unwrap_or_default(),
            "nullable": row.get("notnull").is_none_or(|value| value != "1"),
            "pk": row.get("pk").is_some_and(|value| value != "0"),
            "defaultValue": row.get("dflt_value").cloned()
        }))
        .collect::<Vec<_>>()))
}

pub(crate) async fn sqlite_schema(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let (connection_id, config) = decode_active_db_session_args(state, "sqlite", &args, 0, 1)?;
    let object_type = string_arg(&args, 2)?;
    let object_name = string_arg(&args, 3)?;
    let options = sqlite_operation_options(&config, args.get(4));
    let sql = format!(
        "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = {} AND name = {} LIMIT 1;",
        sqlite_literal(&object_type),
        sqlite_literal(&object_name)
    );
    let output = run_sqlite_cli(state, &connection_id, &config, &sql, Some(&options)).await?;
    let rows = parse_csv_objects(&output)?;
    let Some(row) = rows.first() else {
        return Ok(Value::Null);
    };
    Ok(json!({
        "type": row.get("type").cloned().unwrap_or_default(),
        "name": row.get("name").cloned().unwrap_or_default(),
        "tableName": row.get("tableName").cloned().unwrap_or_default(),
        "sql": row.get("sql").cloned().unwrap_or_default()
    }))
}

pub(crate) async fn sqlite_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let (connection_id, config) = decode_active_db_session_args(state, "sqlite", &args, 0, 1)?;
    let sql = string_arg(&args, 2)?;
    let options = sqlite_operation_options(&config, args.get(3));
    let output = run_sqlite_cli(state, &connection_id, &config, &sql, Some(&options)).await?;
    let (columns, rows) = parse_csv_query(&output)?;
    Ok(json!({ "columns": columns, "rows": rows }))
}

pub(crate) async fn sqlite_update_cell(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let (connection_id, config) = decode_active_db_session_args(state, "sqlite", &args, 0, 1)?;
    let table = string_arg(&args, 2)?;
    let column = string_arg(&args, 3)?;
    let new_value = args.get(4).cloned().unwrap_or(Value::Null);
    let target = args.get(5).cloned().unwrap_or_else(|| json!({}));
    let options = sqlite_operation_options(&config, args.get(6));
    let where_clause = if let Some(rowid) = target.get("rowid") {
        format!("rowid = {}", sqlite_value_literal(rowid))
    } else {
        let pk_columns = target
            .get("pkColumns")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let pk_values = target
            .get("pkValues")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if pk_columns.is_empty() || pk_columns.len() != pk_values.len() {
            return Err("SQLite 更新目标无效。".to_string());
        }
        pk_columns
            .iter()
            .zip(pk_values.iter())
            .filter_map(|(name, value)| {
                name.as_str().map(|name| {
                    format!(
                        "{} = {}",
                        sqlite_identifier(name),
                        sqlite_value_literal(value)
                    )
                })
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    };
    let sql = format!(
        "UPDATE {} SET {} = {} WHERE {};",
        sqlite_identifier(&table),
        sqlite_identifier(&column),
        sqlite_value_literal(&new_value),
        where_clause
    );
    let _ = run_sqlite_cli(state, &connection_id, &config, &sql, Some(&options)).await?;
    Ok(json!(true))
}

pub(super) fn sqlite_options_from_arg(raw_options: Option<&Value>) -> Value {
    let Some(options) = raw_options.filter(|value| value.is_object()) else {
        return json!({});
    };
    let mut normalized = serde_json::Map::new();
    if let Some(sudo_password) = options.get("sudoPassword").and_then(Value::as_str) {
        normalized.insert("sudoPassword".to_string(), json!(sudo_password));
    }
    Value::Object(normalized)
}

pub(super) fn sqlite_operation_options(config: &Value, raw_options: Option<&Value>) -> Value {
    let options = sqlite_options_from_arg(raw_options);
    if options.as_object().is_some_and(|object| !object.is_empty()) {
        return options;
    }
    config
        .get("options")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}))
}

async fn run_sqlite_cli(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    sql: &str,
    options: Option<&Value>,
) -> Result<String, String> {
    let file_path = read_string_field(config, "filePath", "");
    if file_path.is_empty() {
        return Err("SQLite 文件路径为空。".to_string());
    }
    let connection = get_connection(state, connection_id)?;
    let use_windows_command = sqlite_use_windows_command(&connection);
    let posix = format!(
        "sqlite3 -header -csv {} {}",
        shell_quote(&file_path),
        shell_quote(sql)
    );
    let windows = format!(
        "sqlite3 -header -csv {} {}",
        ps_quote(&file_path),
        ps_quote(sql)
    );
    let command = if use_windows_command { windows } else { posix };
    let effective_options = options
        .cloned()
        .or_else(|| {
            config
                .get("options")
                .filter(|value| value.is_object())
                .cloned()
        })
        .unwrap_or_else(|| json!({}));
    let mut args = vec![json!(connection_id), json!(command), json!("")];
    if effective_options
        .as_object()
        .is_some_and(|object| !object.is_empty())
    {
        args.push(effective_options);
    }
    let output = run_connection_command(state.clone(), args).await?;
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) != 0 {
        return Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                output
                    .get("stdout")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or("SQLite 命令执行失败。")
            .to_string());
    }
    Ok(output
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string())
}

pub(super) fn sqlite_use_windows_command(connection: &crate::ActiveConnection) -> bool {
    if connection.kind == ConnectionKind::Local {
        return cfg!(windows);
    }
    connection
        .host
        .get("systemType")
        .and_then(Value::as_str)
        .is_some_and(|system_type| system_type.eq_ignore_ascii_case("windows"))
}
