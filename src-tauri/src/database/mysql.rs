use serde_json::{json, Value};

use super::{
    codec::encode_config_id,
    parse::{parse_mysql_write_metadata, parse_tsv_rows},
    session::{decode_active_db_session_args, register_db_session},
    should_fallback_to_database_cli, should_try_database_tunnel,
    sql::{
        is_mysql_write_statement, mysql_identifier, mysql_query_with_write_metadata,
        mysql_value_literal, sql_string,
    },
    tunnel,
};
use crate::{ps_quote, read_string_field, run_cli_output, shell_quote, string_arg, AppState};

pub(crate) async fn mysql_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let mut fallback_reason = None;
    if should_try_database_tunnel(state, &connection_id, &config)? {
        match tunnel::mysql_connect(state, window, args.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) if should_fallback_to_mysql_cli(&config, &error) => {
                eprintln!(
                    "[database] MySQL TCP tunnel unavailable, using SSH command fallback: {error}"
                );
                fallback_reason = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    let mysql_id = encode_config_id("mysql", &config)?;
    let _ = run_mysql_cli(state, &connection_id, &config, "SELECT 1 AS ok;", None).await?;
    register_db_session(state, "mysql", &connection_id, &mysql_id, config)?;
    Ok(json!({
        "mysqlId": mysql_id,
        "transport": "ssh-exec",
        "fallbackReason": fallback_reason,
    }))
}

pub(super) fn should_fallback_to_mysql_cli(config: &Value, error: &str) -> bool {
    should_fallback_to_database_cli(config) && !is_mysql_authentication_error(error)
}

pub(super) fn is_mysql_authentication_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("access denied for user")
        || normalized.contains("er_access_denied_error")
        || (normalized.contains("1045") && normalized.contains("28000"))
}

pub(crate) async fn mysql_databases(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "mysql", &args)? {
        return tunnel::mysql_databases(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mysql", &args, 0, 1)?;
    let output = run_mysql_cli(state, &connection_id, &config, "SHOW DATABASES;", None).await?;
    Ok(json!(parse_tsv_rows(&output)
        .into_iter()
        .skip(1)
        .filter_map(|row| row.first().cloned())
        .collect::<Vec<_>>()))
}

pub(crate) async fn mysql_tables(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "mysql", &args)? {
        return tunnel::mysql_tables(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mysql", &args, 0, 1)?;
    let database = string_arg(&args, 2)?;
    let sql = format!("SHOW TABLES FROM `{}`;", database.replace('`', "``"));
    let output = run_mysql_cli(state, &connection_id, &config, &sql, None).await?;
    Ok(json!(parse_tsv_rows(&output)
        .into_iter()
        .skip(1)
        .filter_map(|row| row.first().cloned())
        .collect::<Vec<_>>()))
}

pub(crate) async fn mysql_columns(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "mysql", &args)? {
        return tunnel::mysql_columns(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mysql", &args, 0, 1)?;
    let database = string_arg(&args, 2)?;
    let table = string_arg(&args, 3)?;
    let sql = format!(
        "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_KEY,COLUMN_DEFAULT,EXTRA,COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA={} AND TABLE_NAME={} ORDER BY ORDINAL_POSITION;",
        sql_string(&database),
        sql_string(&table)
    );
    let output = run_mysql_cli(state, &connection_id, &config, &sql, None).await?;
    let rows = parse_tsv_rows(&output);
    let columns = rows
        .into_iter()
        .skip(1)
        .map(|row| {
            json!({
                "name": row.get(0).cloned().unwrap_or_default(),
                "type": row.get(1).cloned().unwrap_or_default(),
                "nullable": row.get(2).is_some_and(|value| value == "YES"),
                "key": row.get(3).cloned().unwrap_or_default(),
                "default": row.get(4).filter(|value| value.as_str() != "NULL").cloned(),
                "extra": row.get(5).cloned().unwrap_or_default(),
                "comment": row.get(6).cloned().unwrap_or_default()
            })
        })
        .collect::<Vec<_>>();
    Ok(json!(columns))
}

pub(crate) async fn mysql_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "mysql", &args)? {
        return tunnel::mysql_query(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mysql", &args, 0, 1)?;
    let sql = string_arg(&args, 2)?;
    let database = args.get(3).and_then(Value::as_str);
    let write_statement = is_mysql_write_statement(&sql);
    let query_sql = if write_statement {
        mysql_query_with_write_metadata(&sql)
    } else {
        sql.clone()
    };
    let output = run_mysql_cli(state, &connection_id, &config, &query_sql, database).await?;
    if write_statement {
        let (affected_rows, insert_id) = parse_mysql_write_metadata(&output);
        let mut result = json!({
            "columns": [],
            "rows": [],
            "affectedRows": affected_rows
        });
        if let Some(insert_id) = insert_id {
            result["insertId"] = json!(insert_id);
        }
        return Ok(result);
    }
    let rows = parse_tsv_rows(&output);
    if rows.is_empty() {
        return Ok(json!({ "columns": [], "rows": [] }));
    }
    let columns = rows[0].clone();
    let data_rows = rows
        .into_iter()
        .skip(1)
        .map(|row| {
            let mut object = serde_json::Map::new();
            for (index, column) in columns.iter().enumerate() {
                object.insert(
                    column.clone(),
                    json!(row.get(index).cloned().unwrap_or_default()),
                );
            }
            Value::Object(object)
        })
        .collect::<Vec<_>>();
    Ok(json!({ "columns": columns, "rows": data_rows }))
}

pub(crate) async fn mysql_update_cell(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "mysql", &args)? {
        return tunnel::mysql_update_cell(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mysql", &args, 0, 1)?;
    let database = string_arg(&args, 2)?;
    let table = string_arg(&args, 3)?;
    let pk_column = args.get(4).and_then(Value::as_str).unwrap_or("");
    let pk_value = args.get(5).cloned().unwrap_or(Value::Null);
    let column = string_arg(&args, 6)?;
    let new_value = args.get(7).cloned().unwrap_or(Value::Null);
    let pk_columns = args
        .get(8)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pk_values = args
        .get(9)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let where_clause = if !pk_columns.is_empty() && pk_columns.len() == pk_values.len() {
        pk_columns
            .iter()
            .zip(pk_values.iter())
            .filter_map(|(name, value)| {
                name.as_str().map(|name| {
                    format!(
                        "{} = {}",
                        mysql_identifier(name),
                        mysql_value_literal(value)
                    )
                })
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    } else if !pk_column.is_empty() {
        format!(
            "{} = {}",
            mysql_identifier(pk_column),
            mysql_value_literal(&pk_value)
        )
    } else {
        return Err("无法定位要更新的 MySQL 行。".to_string());
    };
    if where_clause.trim().is_empty() {
        return Err("无法定位要更新的 MySQL 行。".to_string());
    }
    let sql = format!(
        "UPDATE {}.{} SET {} = {} WHERE {}; SELECT ROW_COUNT() AS affectedRows;",
        mysql_identifier(&database),
        mysql_identifier(&table),
        mysql_identifier(&column),
        mysql_value_literal(&new_value),
        where_clause
    );
    let output = run_mysql_cli(state, &connection_id, &config, &sql, None).await?;
    let rows = parse_tsv_rows(&output);
    let affected_rows = rows
        .into_iter()
        .skip(1)
        .find_map(|row| row.first().and_then(|value| value.parse::<i64>().ok()))
        .unwrap_or(0);
    Ok(json!({ "affectedRows": affected_rows }))
}

async fn run_mysql_cli(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    sql: &str,
    database_override: Option<&str>,
) -> Result<String, String> {
    let host = read_string_field(config, "host", "127.0.0.1");
    let port = config.get("port").and_then(Value::as_u64).unwrap_or(3306);
    let user = read_string_field(config, "user", "root");
    let password = read_string_field(config, "password", "");
    let database = database_override
        .map(ToString::to_string)
        .unwrap_or_else(|| read_string_field(config, "database", ""));
    let (posix_command, windows_command) =
        mysql_cli_commands(&host, port, &user, &password, &database, sql);
    run_cli_output(
        state,
        connection_id,
        posix_command,
        Some(windows_command),
        "MySQL 命令执行失败。",
    )
    .await
}

pub(super) fn mysql_cli_commands(
    host: &str,
    port: u64,
    user: &str,
    password: &str,
    database: &str,
    sql: &str,
) -> (String, String) {
    let mut posix = format!(
        "mysql --batch --raw --host={} --port={} --user={}",
        shell_quote(&host),
        port,
        shell_quote(&user)
    );
    let mut windows = format!(
        "mysql --batch --raw --host={} --port={} --user={}",
        ps_quote(host),
        port,
        ps_quote(user)
    );
    if !password.is_empty() {
        posix = format!("MYSQL_PWD={} {posix}", shell_quote(password));
        windows = format!("$env:MYSQL_PWD = {}; {windows}", ps_quote(password));
    }
    if !database.is_empty() {
        posix.push(' ');
        posix.push_str(&shell_quote(database));
        windows.push(' ');
        windows.push_str(&ps_quote(database));
    }
    posix.push_str(" --execute ");
    posix.push_str(&shell_quote(sql));
    windows.push_str(" --execute ");
    windows.push_str(&ps_quote(sql));
    (posix, windows)
}
