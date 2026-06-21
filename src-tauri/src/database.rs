use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::{
    error_string, get_connection, now, ps_quote, read_string_field, run_cli_output,
    run_connection_command, shell_quote, string_arg, AppState, ConnectionKind,
};

fn database_transport_mode(config: &Value) -> String {
    config
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase()
}

fn should_try_database_tunnel(
    state: &AppState,
    connection_id: &str,
    config: &Value,
) -> Result<bool, String> {
    let mode = database_transport_mode(config);
    if crate::database_tunnel::is_tunnel_mode(config) {
        return Ok(true);
    }
    if mode == "cli" {
        return Ok(false);
    }
    Ok(get_connection(state, connection_id)?.kind != ConnectionKind::Local)
}

fn should_fallback_to_database_cli(config: &Value) -> bool {
    database_transport_mode(config) != "tunnel"
}

pub(crate) async fn mysql_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    if should_try_database_tunnel(state, &connection_id, &config)? {
        match crate::database_tunnel::mysql_connect(state, window, args.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) if should_fallback_to_database_cli(&config) => {
                eprintln!(
                    "[database] MySQL TCP tunnel unavailable, using SSH command fallback: {error}"
                );
            }
            Err(error) => return Err(error),
        }
    }
    let mysql_id = encode_config_id("mysql", &config)?;
    let _ = run_mysql_cli(state, &connection_id, &config, "SELECT 1 AS ok;", None).await?;
    register_db_session(state, "mysql", &connection_id, &mysql_id, config)?;
    Ok(json!({
        "mysqlId": mysql_id,
        "transport": "ssh-exec"
    }))
}

fn register_db_session(
    state: &AppState,
    kind: &str,
    connection_id: &str,
    session_id: &str,
    config: Value,
) -> Result<(), String> {
    state
        .database_sessions
        .lock()
        .map_err(error_string)?
        .insert(db_session_key(kind, connection_id, session_id), config);
    Ok(())
}

pub(crate) fn disconnect_db_session(
    state: &AppState,
    args: Vec<Value>,
    kind: &str,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let session_id = string_arg(&args, 1)?;
    state
        .database_sessions
        .lock()
        .map_err(error_string)?
        .remove(&db_session_key(kind, &connection_id, &session_id));
    Ok(json!(true))
}

pub(crate) async fn disconnect_db_session_any(
    state: &AppState,
    args: Vec<Value>,
    kind: &'static str,
) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, kind, &args)? {
        return crate::database_tunnel::disconnect(state, args, kind).await;
    }
    disconnect_db_session(state, args, kind)
}

fn decode_active_db_session_args(
    state: &AppState,
    kind: &str,
    args: &[Value],
    connection_index: usize,
    session_index: usize,
) -> Result<(String, Value), String> {
    let connection_id = string_arg(args, connection_index)?;
    let session_id = string_arg(args, session_index)?;
    let key = db_session_key(kind, &connection_id, &session_id);
    let config = state
        .database_sessions
        .lock()
        .map_err(error_string)?
        .get(&key)
        .cloned()
        .ok_or_else(|| format!("{} 连接已断开。", db_display_name(kind)))?;
    Ok((connection_id, config))
}

fn db_session_key(kind: &str, connection_id: &str, session_id: &str) -> String {
    format!("{kind}:{connection_id}:{session_id}")
}

fn db_display_name(kind: &str) -> &'static str {
    match kind {
        "mysql" => "MySQL",
        "postgres" => "PostgreSQL",
        "redis" => "Redis",
        "sqlite" => "SQLite",
        "clickhouse" => "ClickHouse",
        "mongo" => "MongoDB",
        _ => "数据库",
    }
}

fn parse_csv_query(output: &str) -> Result<(Vec<String>, Vec<Value>), String> {
    if output.trim().is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(output.as_bytes());
    let columns = reader
        .headers()
        .map_err(error_string)?
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.map_err(error_string)?;
        let mut object = serde_json::Map::new();
        for (index, column) in columns.iter().enumerate() {
            object.insert(column.clone(), json!(record.get(index).unwrap_or("")));
        }
        rows.push(Value::Object(object));
    }
    Ok((columns, rows))
}

fn parse_csv_objects(output: &str) -> Result<Vec<HashMap<String, String>>, String> {
    let (columns, rows) = parse_csv_query(output)?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let object = row.as_object()?;
            let mut map = HashMap::new();
            for column in &columns {
                map.insert(
                    column.clone(),
                    object
                        .get(column)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                );
            }
            Some(map)
        })
        .collect())
}

pub(crate) async fn mysql_databases(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "mysql", &args)? {
        return crate::database_tunnel::mysql_databases(state, args).await;
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
    if crate::database_tunnel::has_session(state, "mysql", &args)? {
        return crate::database_tunnel::mysql_tables(state, args).await;
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
    if crate::database_tunnel::has_session(state, "mysql", &args)? {
        return crate::database_tunnel::mysql_columns(state, args).await;
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
    if crate::database_tunnel::has_session(state, "mysql", &args)? {
        return crate::database_tunnel::mysql_query(state, args).await;
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
    if crate::database_tunnel::has_session(state, "mysql", &args)? {
        return crate::database_tunnel::mysql_update_cell(state, args).await;
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

pub(crate) async fn postgres_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    if should_try_database_tunnel(state, &connection_id, &config)? {
        match crate::database_tunnel::postgres_connect(state, window, args.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) if should_fallback_to_database_cli(&config) => {
                eprintln!(
                    "[database] PostgreSQL SSH tunnel unavailable, falling back to CLI: {error}"
                );
            }
            Err(error) => return Err(error),
        }
    }
    let postgres_id = encode_config_id("postgres", &config)?;
    let _ = run_postgres_cli(state, &connection_id, &config, "SELECT 1 AS ok;").await?;
    register_db_session(state, "postgres", &connection_id, &postgres_id, config)?;
    Ok(json!({ "postgresId": postgres_id, "transport": "ssh-exec" }))
}

pub(crate) async fn postgres_databases(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "postgres", &args)? {
        return crate::database_tunnel::postgres_databases(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "postgres", &args, 0, 1)?;
    let output = run_postgres_cli(
        state,
        &connection_id,
        &config,
        "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;",
    )
    .await?;
    let rows = parse_csv_objects(&output)?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| row.get("datname").cloned())
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_schemas(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "postgres", &args)? {
        return crate::database_tunnel::postgres_schemas(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "postgres", &args, 0, 1)?;
    let output = run_postgres_cli(
        state,
        &connection_id,
        &config,
        "SELECT nspname AS schema_name \
         FROM pg_catalog.pg_namespace \
         WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg_%' \
         ORDER BY nspname;",
    )
    .await?;
    let rows = parse_csv_objects(&output)?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| row.get("schema_name").cloned())
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_tables(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "postgres", &args)? {
        return crate::database_tunnel::postgres_tables(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "postgres", &args, 0, 1)?;
    let schema = string_arg(&args, 2)?;
    let sql = format!(
        "SELECT n.nspname AS table_schema, \
                c.relname AS table_name, \
                CASE c.relkind \
                  WHEN 'r' THEN 'BASE TABLE' \
                  WHEN 'p' THEN 'PARTITIONED TABLE' \
                  WHEN 'v' THEN 'VIEW' \
                  WHEN 'm' THEN 'MATERIALIZED VIEW' \
                  WHEN 'f' THEN 'FOREIGN TABLE' \
                  ELSE c.relkind::text \
                END AS table_type \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = {} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
         ORDER BY c.relname;",
        pg_literal(&schema)
    );
    let output = run_postgres_cli(state, &connection_id, &config, &sql).await?;
    let rows = parse_csv_objects(&output)?;
    Ok(json!(rows
        .into_iter()
        .map(|row| json!({
            "schema": row.get("table_schema").cloned().unwrap_or_default(),
            "name": row.get("table_name").cloned().unwrap_or_default(),
            "type": row.get("table_type").cloned().unwrap_or_default()
        }))
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_columns(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "postgres", &args)? {
        return crate::database_tunnel::postgres_columns(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "postgres", &args, 0, 1)?;
    let schema = string_arg(&args, 2)?;
    let table = string_arg(&args, 3)?;
    let sql = format!(
        r#"
SELECT
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.column_default,
  EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = c.table_schema
      AND tc.table_name = c.table_name
      AND kcu.column_name = c.column_name
  ) AS is_primary_key
FROM information_schema.columns c
WHERE c.table_schema = {} AND c.table_name = {}
ORDER BY c.ordinal_position;
"#,
        pg_literal(&schema),
        pg_literal(&table)
    );
    let output = run_postgres_cli(state, &connection_id, &config, &sql).await?;
    let rows = parse_csv_objects(&output)?;
    Ok(json!(rows
        .into_iter()
        .map(|row| json!({
            "name": row.get("column_name").cloned().unwrap_or_default(),
            "dataType": row.get("data_type").cloned().unwrap_or_default(),
            "nullable": row.get("is_nullable").is_some_and(|value| value == "YES"),
            "defaultValue": row.get("column_default").cloned(),
            "isPrimaryKey": row.get("is_primary_key").is_some_and(|value| value == "t" || value == "true")
        }))
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "postgres", &args)? {
        return crate::database_tunnel::postgres_query(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "postgres", &args, 0, 1)?;
    let sql = string_arg(&args, 2)?;
    let output = run_postgres_cli(state, &connection_id, &config, &sql).await?;
    if let Some(row_count) = parse_postgres_command_tag_row_count(&output) {
        let mut result = json!({ "columns": [], "rows": [] });
        if let Some(row_count) = row_count {
            result["rowCount"] = json!(row_count);
        }
        return Ok(result);
    }
    let (columns, rows) = parse_csv_query(&output)?;
    Ok(json!({ "columns": columns, "rows": rows, "rowCount": rows.len() }))
}

async fn run_postgres_cli(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    sql: &str,
) -> Result<String, String> {
    let host = read_string_field(config, "host", "127.0.0.1");
    let port = config.get("port").and_then(Value::as_u64).unwrap_or(5432);
    let user = read_string_field(config, "user", "postgres");
    let password = read_string_field(config, "password", "");
    let database = read_string_field(config, "database", "postgres");
    let posix = format!(
        "PGPASSWORD={} psql --no-psqlrc --csv -h {} -p {} -U {} -d {} -c {}",
        shell_quote(&password),
        shell_quote(&host),
        port,
        shell_quote(&user),
        shell_quote(&database),
        shell_quote(sql)
    );
    let windows = format!(
        "$env:PGPASSWORD = {}; psql --no-psqlrc --csv -h {} -p {} -U {} -d {} -c {}",
        ps_quote(&password),
        ps_quote(&host),
        port,
        ps_quote(&user),
        ps_quote(&database),
        ps_quote(sql)
    );
    run_cli_output(
        state,
        connection_id,
        posix,
        Some(windows),
        "PostgreSQL 命令执行失败。",
    )
    .await
}

pub(crate) async fn redis_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    if should_try_database_tunnel(state, &connection_id, &config)? {
        match crate::database_tunnel::redis_connect(state, window, args.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) if should_fallback_to_database_cli(&config) => {
                eprintln!("[database] Redis SSH tunnel unavailable, falling back to CLI: {error}");
            }
            Err(error) => return Err(error),
        }
    }
    let redis_id = encode_config_id("redis", &config)?;
    let _ = run_redis_cli(state, &connection_id, &config, &["PING".to_string()]).await?;
    register_db_session(state, "redis", &connection_id, &redis_id, config)?;
    Ok(json!({ "redisId": redis_id }))
}

pub(crate) async fn redis_scan(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "redis", &args)? {
        return crate::database_tunnel::redis_scan(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let options = args.get(2).cloned().unwrap_or_else(|| json!({}));
    let cursor = read_string_field(&options, "cursor", "0");
    let pattern = read_string_field(&options, "pattern", "*");
    let count = options.get("count").and_then(Value::as_u64).unwrap_or(100);
    let output = run_redis_cli(
        state,
        &connection_id,
        &config,
        &[
            "SCAN".to_string(),
            cursor.clone(),
            "MATCH".to_string(),
            pattern.clone(),
            "COUNT".to_string(),
            count.to_string(),
        ],
    )
    .await?;
    let mut lines = output.lines();
    let next_cursor = lines.next().unwrap_or("0").trim().to_string();
    let mut keys = Vec::new();
    for key in lines.filter(|line| !line.trim().is_empty()) {
        keys.push(redis_key_summary(state, &connection_id, &config, key.trim()).await?);
    }
    Ok(json!({
        "cursor": next_cursor,
        "complete": next_cursor == "0",
        "pattern": pattern,
        "scannedAt": now(),
        "keys": keys
    }))
}

pub(crate) async fn redis_keys(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "redis", &args)? {
        return crate::database_tunnel::redis_keys(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let pattern = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or("*")
        .to_string();
    let output = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["KEYS".to_string(), pattern],
    )
    .await?;
    let mut keys = Vec::new();
    for key in output.lines().filter(|line| !line.trim().is_empty()) {
        keys.push(redis_key_summary(state, &connection_id, &config, key.trim()).await?);
    }
    Ok(json!(keys))
}

pub(crate) async fn redis_get_value(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "redis", &args)? {
        return crate::database_tunnel::redis_get_value(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let key = string_arg(&args, 2)?;
    let key_args = vec![key.clone()];
    let redis_type = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["TYPE".to_string(), key.clone()],
    )
    .await?
    .trim()
    .to_string();
    if redis_type == "none" {
        return Err(format!("键 \"{key}\" 不存在。"));
    }
    let ttl = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["TTL".to_string(), key.clone()],
    )
    .await?
    .trim()
    .parse::<i64>()
    .unwrap_or(-1);
    let value = match redis_type.as_str() {
        "hash" => json!(redis_pairs_to_object(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &["HGETALL".to_string(), key.clone()]
            )
            .await?
        )),
        "list" => json!(redis_lines(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &[
                    "LRANGE".to_string(),
                    key.clone(),
                    "0".to_string(),
                    "199".to_string()
                ]
            )
            .await?
        )),
        "set" => json!(redis_lines(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &["SMEMBERS".to_string(), key.clone()]
            )
            .await?
        )),
        "zset" => redis_zset_items(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &[
                    "ZRANGE".to_string(),
                    key.clone(),
                    "0".to_string(),
                    "199".to_string(),
                    "WITHSCORES".to_string(),
                ],
            )
            .await?,
        ),
        "stream" => redis_stream_preview(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &[
                    "EVAL".to_string(),
                    redis_stream_preview_lua(),
                    "1".to_string(),
                    key.clone(),
                    "100".to_string(),
                ],
            )
            .await?,
        ),
        _ => json!(
            run_redis_cli(
                state,
                &connection_id,
                &config,
                &["GET".to_string(), key.clone()]
            )
            .await?
        ),
    };
    let size = run_redis_size(state, &connection_id, &config, &redis_type, &key_args)
        .await
        .unwrap_or(0);
    let truncated = if redis_type == "stream" {
        size > 100
    } else {
        size > 200
    };
    Ok(json!({
        "type": redis_type,
        "value": value,
        "ttl": ttl,
        "size": size,
        "count": size,
        "previewLimit": 200,
        "truncated": truncated
    }))
}

pub(crate) async fn redis_set_value(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "redis", &args)? {
        return crate::database_tunnel::redis_set_value(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let key = string_arg(&args, 2)?;
    let value = args.get(3).cloned().unwrap_or(Value::Null);
    let value_type = string_arg(&args, 4)?;
    let ttl_ms = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["PTTL".to_string(), key.clone()],
    )
    .await?
    .trim()
    .parse::<i64>()
    .unwrap_or(-1);
    let commands = redis_set_value_commands(&key, &value, &value_type, ttl_ms)?;
    for command in commands {
        let _ = run_redis_cli(state, &connection_id, &config, &command).await?;
    }
    Ok(json!(true))
}

fn redis_set_value_commands(
    key: &str,
    value: &Value,
    value_type: &str,
    ttl_ms: i64,
) -> Result<Vec<Vec<String>>, String> {
    let mut commands = vec![vec!["DEL".to_string(), key.to_string()]];
    match value_type {
        "string" => commands.push(vec![
            "SET".to_string(),
            key.to_string(),
            json_to_cli_value(value),
        ]),
        "hash" => {
            if let Some(object) = value.as_object() {
                if !object.is_empty() {
                    let mut hset = vec!["HSET".to_string(), key.to_string()];
                    for (field, field_value) in object {
                        hset.push(field.clone());
                        hset.push(json_to_cli_value(field_value));
                    }
                    commands.push(hset);
                }
            } else {
                return Err("Hash 值必须是 JSON 对象。".to_string());
            }
        }
        "list" => {
            if let Some(items) = value.as_array() {
                if !items.is_empty() {
                    let mut rpush = vec!["RPUSH".to_string(), key.to_string()];
                    for item in items {
                        rpush.push(json_to_cli_value(item));
                    }
                    commands.push(rpush);
                }
            } else {
                return Err("List 值必须是 JSON 数组。".to_string());
            }
        }
        "set" => {
            if let Some(items) = value.as_array() {
                if !items.is_empty() {
                    let mut sadd = vec!["SADD".to_string(), key.to_string()];
                    for item in items {
                        sadd.push(json_to_cli_value(item));
                    }
                    commands.push(sadd);
                }
            } else {
                return Err("Set 值必须是 JSON 数组。".to_string());
            }
        }
        "zset" => {
            let zset_args = redis_zset_cli_args(value)?;
            if !zset_args.is_empty() {
                let mut zadd = vec!["ZADD".to_string(), key.to_string()];
                zadd.extend(zset_args);
                commands.push(zadd);
            }
        }
        _ => return Err(format!("暂不支持保存 {} 类型。", value_type)),
    }
    if ttl_ms > 0 {
        commands.push(vec![
            "PEXPIRE".to_string(),
            key.to_string(),
            ttl_ms.to_string(),
        ]);
    }
    Ok(commands)
}

pub(crate) async fn redis_delete_key(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "redis", &args)? {
        return crate::database_tunnel::redis_delete_key(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let key = string_arg(&args, 2)?;
    let _ = run_redis_cli(state, &connection_id, &config, &["DEL".to_string(), key]).await?;
    Ok(json!(true))
}

pub(crate) async fn redis_command(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "redis", &args)? {
        return crate::database_tunnel::redis_command(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let command = string_arg(&args, 2)?;
    let mut parts = vec![command];
    if let Some(command_args) = args.get(3).and_then(Value::as_array) {
        parts.extend(command_args.iter().map(json_to_cli_value));
    }
    let supports_json =
        match run_redis_cli_json(state, &connection_id, &config, &["PING".to_string()]).await {
            Ok(_) => true,
            Err(error) if redis_cli_json_unsupported(&error) => false,
            Err(error) => return Err(error),
        };
    if supports_json {
        let output = run_redis_cli_json(state, &connection_id, &config, &parts).await?;
        return parse_redis_json_command_output(&output);
    }
    let output = run_redis_cli(state, &connection_id, &config, &parts).await?;
    Ok(parse_redis_raw_command_output(&parts[0], &output))
}

async fn redis_key_summary(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    key: &str,
) -> Result<Value, String> {
    let redis_type = run_redis_cli(
        state,
        connection_id,
        config,
        &["TYPE".to_string(), key.to_string()],
    )
    .await?
    .trim()
    .to_string();
    let ttl = run_redis_cli(
        state,
        connection_id,
        config,
        &["TTL".to_string(), key.to_string()],
    )
    .await?
    .trim()
    .parse::<i64>()
    .unwrap_or(-1);
    let size = run_redis_size(
        state,
        connection_id,
        config,
        &redis_type,
        &[key.to_string()],
    )
    .await
    .unwrap_or(0);
    Ok(json!({ "name": key, "type": redis_type, "ttl": ttl, "size": size, "scannedAt": now() }))
}

async fn run_redis_size(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    redis_type: &str,
    key_args: &[String],
) -> Result<i64, String> {
    let size_command = match redis_type {
        "string" => "STRLEN",
        "hash" => "HLEN",
        "list" => "LLEN",
        "set" => "SCARD",
        "zset" => "ZCARD",
        "stream" => "XLEN",
        _ => return Ok(0),
    };
    let mut args = vec![size_command.to_string()];
    args.extend_from_slice(key_args);
    Ok(run_redis_cli(state, connection_id, config, &args)
        .await?
        .trim()
        .parse::<i64>()
        .unwrap_or(0))
}

async fn run_redis_cli(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    command_args: &[String],
) -> Result<String, String> {
    run_redis_cli_with_mode(state, connection_id, config, "raw", command_args).await
}

async fn run_redis_cli_json(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    command_args: &[String],
) -> Result<String, String> {
    run_redis_cli_with_mode(state, connection_id, config, "json", command_args).await
}

async fn run_redis_cli_with_mode(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    output_mode: &str,
    command_args: &[String],
) -> Result<String, String> {
    let host = read_string_field(config, "host", "127.0.0.1");
    let port = config.get("port").and_then(Value::as_u64).unwrap_or(6379);
    let password = read_string_field(config, "password", "");
    let db = config.get("db").and_then(Value::as_i64).unwrap_or(0);
    let mode_flag = if output_mode == "json" {
        "--json"
    } else {
        "--raw"
    };
    let mut base = format!(
        "redis-cli {} -h {} -p {} -n {}",
        mode_flag,
        shell_quote(&host),
        port,
        db
    );
    let mut ps_base = format!(
        "redis-cli {} -h {} -p {} -n {}",
        mode_flag,
        ps_quote(&host),
        port,
        db
    );
    if !password.is_empty() {
        base = format!("REDISCLI_AUTH={} {base}", shell_quote(&password));
        ps_base = format!("$env:REDISCLI_AUTH = {}; {ps_base}", ps_quote(&password));
    }
    for arg in command_args {
        base.push(' ');
        base.push_str(&shell_quote(arg));
        ps_base.push(' ');
        ps_base.push_str(&ps_quote(arg));
    }
    run_cli_output(
        state,
        connection_id,
        base,
        Some(ps_base),
        "Redis 命令执行失败。",
    )
    .await
}

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
            "nullable": !row.get("notnull").is_some_and(|value| value == "1"),
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

fn sqlite_options_from_arg(raw_options: Option<&Value>) -> Value {
    let Some(options) = raw_options.filter(|value| value.is_object()) else {
        return json!({});
    };
    let mut normalized = serde_json::Map::new();
    if let Some(sudo_password) = options.get("sudoPassword").and_then(Value::as_str) {
        normalized.insert("sudoPassword".to_string(), json!(sudo_password));
    }
    Value::Object(normalized)
}

fn sqlite_operation_options(config: &Value, raw_options: Option<&Value>) -> Value {
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
    let output = run_connection_command(state, args).await?;
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

fn sqlite_use_windows_command(connection: &crate::ActiveConnection) -> bool {
    if connection.kind == ConnectionKind::Local {
        return cfg!(windows);
    }
    connection
        .host
        .get("systemType")
        .and_then(Value::as_str)
        .is_some_and(|system_type| system_type.eq_ignore_ascii_case("windows"))
}

pub(crate) async fn clickhouse_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let mut fallback_reason = None;
    if should_try_database_tunnel(state, &connection_id, &config)? {
        match crate::database_tunnel::clickhouse_connect(state, window, args.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) if should_fallback_to_database_cli(&config) => {
                eprintln!(
                    "[database] ClickHouse SSH tunnel unavailable, falling back to CLI: {error}"
                );
                fallback_reason = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    let clickhouse_id = encode_config_id("clickhouse", &config)?;
    let _ = run_clickhouse_query(state, &connection_id, &config, "SELECT 1 AS ok", None).await?;
    register_db_session(state, "clickhouse", &connection_id, &clickhouse_id, config)?;
    Ok(json!({
        "clickhouseId": clickhouse_id,
        "transport": "ssh-exec",
        "fallbackReason": fallback_reason,
    }))
}

pub(crate) async fn clickhouse_databases(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "clickhouse", &args)? {
        return crate::database_tunnel::clickhouse_databases(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "clickhouse", &args, 0, 1)?;
    let result = run_clickhouse_query(
        state,
        &connection_id,
        &config,
        "SELECT name FROM system.databases ORDER BY name",
        None,
    )
    .await?;
    Ok(json!(result
        .get("rows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row
            .get("name")
            .and_then(Value::as_str)
            .map(ToString::to_string))
        .collect::<Vec<_>>()))
}

pub(crate) async fn clickhouse_tables(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "clickhouse", &args)? {
        return crate::database_tunnel::clickhouse_tables(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "clickhouse", &args, 0, 1)?;
    let database = string_arg(&args, 2)?;
    let sql = format!(
        "SELECT name, engine, total_rows AS totalRows, total_bytes AS totalBytes FROM system.tables WHERE database = {} ORDER BY name",
        clickhouse_literal(&database)
    );
    let result = run_clickhouse_query(state, &connection_id, &config, &sql, None).await?;
    Ok(result.get("rows").cloned().unwrap_or_else(|| json!([])))
}

pub(crate) async fn clickhouse_columns(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "clickhouse", &args)? {
        return crate::database_tunnel::clickhouse_columns(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "clickhouse", &args, 0, 1)?;
    let database = string_arg(&args, 2)?;
    let table = string_arg(&args, 3)?;
    let sql = format!(
        "SELECT name, type, default_kind AS defaultKind, default_expression AS defaultExpression, comment, is_in_primary_key AS isPrimaryKey, is_in_sorting_key AS isSortingKey FROM system.columns WHERE database = {} AND table = {} ORDER BY position",
        clickhouse_literal(&database),
        clickhouse_literal(&table)
    );
    let result = run_clickhouse_query(state, &connection_id, &config, &sql, None).await?;
    Ok(result.get("rows").cloned().unwrap_or_else(|| json!([])))
}

pub(crate) async fn clickhouse_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "clickhouse", &args)? {
        return crate::database_tunnel::clickhouse_query(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "clickhouse", &args, 0, 1)?;
    let sql = string_arg(&args, 2)?;
    let database = args.get(3).and_then(Value::as_str);
    run_clickhouse_query(state, &connection_id, &config, &sql, database).await
}

async fn run_clickhouse_query(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    sql: &str,
    database_override: Option<&str>,
) -> Result<Value, String> {
    let host = read_string_field(config, "host", "127.0.0.1");
    let secure = config
        .get("secure")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let port = config
        .get("port")
        .and_then(Value::as_u64)
        .unwrap_or(if secure { 8443 } else { 8123 });
    let scheme = if secure { "https" } else { "http" };
    let user = read_string_field(config, "user", "default");
    let password = read_string_field(config, "password", "");
    let database = database_override
        .map(ToString::to_string)
        .unwrap_or_else(|| read_string_field(config, "database", ""));
    let mut url = format!("{scheme}://{host}:{port}/?default_format=JSON");
    if !database.is_empty() {
        url.push_str("&database=");
        url.push_str(&url_encode(&database));
    }
    let sql_with_format = clickhouse_query_with_json_format(sql);
    let mut posix = format!(
        "curl -fsS -u {} --data-binary {} {}",
        shell_quote(&format!("{user}:{password}")),
        shell_quote(&sql_with_format),
        shell_quote(&url)
    );
    let mut windows = format!(
        "curl.exe -fsS -u {} --data-binary {} {}",
        ps_quote(&format!("{user}:{password}")),
        ps_quote(&sql_with_format),
        ps_quote(&url)
    );
    if password.is_empty() {
        posix = format!(
            "curl -fsS --data-binary {} {}",
            shell_quote(&sql_with_format),
            shell_quote(&url)
        );
        windows = format!(
            "curl.exe -fsS --data-binary {} {}",
            ps_quote(&sql_with_format),
            ps_quote(&url)
        );
    }
    let output = run_cli_output(
        state,
        connection_id,
        posix,
        Some(windows),
        "ClickHouse 查询失败。",
    )
    .await?;
    Ok(parse_clickhouse_response(&output))
}

fn parse_clickhouse_response(output: &str) -> Value {
    let text = output.trim();
    if text.is_empty() {
        return json!({
            "columns": [],
            "rows": [],
            "rowCount": 0
        });
    }
    let Ok(raw) = serde_json::from_str::<Value>(text) else {
        return json!({
            "columns": ["response"],
            "rows": [{ "response": output }],
            "rowCount": 1
        });
    };
    let rows = raw
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    if item.is_object() {
                        item.clone()
                    } else {
                        json!({ "value": item })
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let columns = raw
        .get("meta")
        .and_then(Value::as_array)
        .map(|meta| {
            meta.iter()
                .filter_map(|item| {
                    item.get("name")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
                .collect::<Vec<_>>()
        })
        .filter(|columns| !columns.is_empty())
        .unwrap_or_else(|| {
            rows.first()
                .and_then(Value::as_object)
                .map(|object| object.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        });
    let row_count = raw
        .get("rows")
        .and_then(Value::as_u64)
        .unwrap_or(rows.len() as u64);
    let statistics = raw
        .get("statistics")
        .and_then(Value::as_object)
        .map(|_| {
            json!({
                "elapsed": raw.pointer("/statistics/elapsed").cloned().unwrap_or(json!(0)),
                "rowsRead": raw.pointer("/statistics/rows_read").cloned().unwrap_or(json!(0)),
                "bytesRead": raw.pointer("/statistics/bytes_read").cloned().unwrap_or(json!(0))
            })
        })
        .unwrap_or(Value::Null);
    json!({
        "columns": columns,
        "rows": rows,
        "rowCount": row_count,
        "statistics": statistics
    })
}

pub(crate) async fn mongo_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    if should_try_database_tunnel(state, &connection_id, &config)? {
        match crate::database_tunnel::mongo_connect(state, window, args.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) if should_fallback_to_database_cli(&config) => {
                eprintln!(
                    "[database] MongoDB SSH tunnel unavailable, falling back to CLI: {error}"
                );
            }
            Err(error) => return Err(error),
        }
    }
    let mongo_id = encode_config_id("mongo", &config)?;
    let _ = run_mongo_eval(
        state,
        &connection_id,
        &config,
        "JSON.stringify(db.adminCommand({ ping: 1 }))",
        None,
    )
    .await?;
    register_db_session(state, "mongo", &connection_id, &mongo_id, config)?;
    Ok(json!({ "mongoId": mongo_id, "transport": "ssh-exec" }))
}

pub(crate) async fn mongo_databases(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "mongo", &args)? {
        return crate::database_tunnel::mongo_databases(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mongo", &args, 0, 1)?;
    let output = run_mongo_eval(
        state,
        &connection_id,
        &config,
        &format!(
            "{} __shelldeskStringify(db.adminCommand({{ listDatabases: 1 }}).databases.map((database) => ({{ name: database.name, sizeOnDisk: database.sizeOnDisk, empty: !!database.empty }})).sort((left, right) => left.name.localeCompare(right.name)))",
            mongo_ejson_prelude()
        ),
        None,
    )
    .await?;
    serde_json::from_str(&output).map_err(error_string)
}

pub(crate) async fn mongo_collections(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "mongo", &args)? {
        return crate::database_tunnel::mongo_collections(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mongo", &args, 0, 1)?;
    let database = string_arg(&args, 2)?;
    let script = format!(
        "{} __shelldeskStringify(db.getCollectionInfos().map((c) => ({{ name: c.name, type: c.type || 'collection' }})).sort((left, right) => left.name.localeCompare(right.name)))",
        mongo_ejson_prelude()
    );
    let output = run_mongo_eval(state, &connection_id, &config, &script, Some(&database)).await?;
    serde_json::from_str(&output).map_err(error_string)
}

pub(crate) async fn mongo_indexes(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "mongo", &args)? {
        return crate::database_tunnel::mongo_indexes(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mongo", &args, 0, 1)?;
    let database = string_arg(&args, 2)?;
    let collection = string_arg(&args, 3)?;
    let script = format!(
        "{} __shelldeskStringify(db.getCollection({}).getIndexes().map((i) => ({{ name: i.name || '', key: i.key || {{}}, unique: !!i.unique, sparse: !!i.sparse, expireAfterSeconds: i.expireAfterSeconds }})))",
        mongo_ejson_prelude(),
        js_string(&collection)
    );
    let output = run_mongo_eval(state, &connection_id, &config, &script, Some(&database)).await?;
    serde_json::from_str(&output).map_err(error_string)
}

pub(crate) async fn mongo_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if crate::database_tunnel::has_session(state, "mongo", &args)? {
        return crate::database_tunnel::mongo_query(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mongo", &args, 0, 1)?;
    let request = args.get(2).cloned().unwrap_or_else(|| json!({}));
    let database = read_string_field(&request, "database", "");
    let collection = read_string_field(&request, "collection", "");
    let filter = read_string_field(&request, "filter", "{}");
    let projection = read_string_field(&request, "projection", "");
    let sort = read_string_field(&request, "sort", "");
    let limit = request
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(100)
        .clamp(1, 1000);
    let filter_expr = mongo_ejson_value_expression(&filter, "{}");
    let projection_expr = mongo_ejson_value_expression(&projection, "undefined");
    let sort_expr = mongo_ejson_value_expression(&sort, "undefined");
    let mut script = format!(
        "{} const filter = {}; const projection = {}; const sort = {}; let cursor = db.getCollection({}).find(filter, projection === undefined ? undefined : {{ projection }});",
        mongo_ejson_prelude(),
        filter_expr,
        projection_expr,
        sort_expr,
        js_string(&collection),
    );
    script.push_str(" if (sort !== undefined) { cursor = cursor.sort(sort); }");
    script.push_str(&format!(" const docs = cursor.limit({limit}).toArray(); __shelldeskStringify({{ documents: docs, count: docs.length, limit: {limit} }})"));
    let output = run_mongo_eval(state, &connection_id, &config, &script, Some(&database)).await?;
    serde_json::from_str(&output).map_err(error_string)
}

async fn run_mongo_eval(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    script: &str,
    database_override: Option<&str>,
) -> Result<String, String> {
    let host = read_string_field(config, "host", "127.0.0.1");
    let port = config.get("port").and_then(Value::as_u64).unwrap_or(27017);
    let username = read_string_field(config, "username", "");
    let password = read_string_field(config, "password", "");
    let auth_source = read_string_field(config, "authSource", "admin");
    let database = database_override.unwrap_or(&auth_source);
    let mut posix = format!(
        "mongosh --quiet --host {} --port {} {}",
        shell_quote(&host),
        port,
        shell_quote(database)
    );
    let mut windows = format!(
        "mongosh --quiet --host {} --port {} {}",
        ps_quote(&host),
        port,
        ps_quote(database)
    );
    if !username.is_empty() {
        posix.push_str(&format!(
            " -u {} -p {} --authenticationDatabase {}",
            shell_quote(&username),
            shell_quote(&password),
            shell_quote(&auth_source)
        ));
        windows.push_str(&format!(
            " -u {} -p {} --authenticationDatabase {}",
            ps_quote(&username),
            ps_quote(&password),
            ps_quote(&auth_source)
        ));
    }
    posix.push_str(&format!(" --eval {}", shell_quote(script)));
    windows.push_str(&format!(" --eval {}", ps_quote(script)));
    run_cli_output(
        state,
        connection_id,
        posix,
        Some(windows),
        "MongoDB 命令执行失败。",
    )
    .await
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

fn mysql_cli_commands(
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

fn encode_config_id(prefix: &str, value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(error_string)?;
    Ok(format!(
        "{}:{}",
        prefix,
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    ))
}

fn parse_tsv_rows(value: &str) -> Vec<Vec<String>> {
    value
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.split('\t').map(|cell| cell.to_string()).collect())
        .collect()
}

fn is_mysql_write_statement(sql: &str) -> bool {
    let statement = sql.trim_start();
    let statement = statement
        .strip_prefix('\u{feff}')
        .unwrap_or(statement)
        .trim_start();
    let keyword = statement
        .split(|character: char| !character.is_ascii_alphabetic())
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        keyword.as_str(),
        "insert" | "update" | "delete" | "replace" | "truncate" | "create" | "alter" | "drop"
    )
}

fn mysql_query_with_write_metadata(sql: &str) -> String {
    let trimmed = sql.trim();
    let without_trailing_semicolons = trimmed.trim_end_matches(';').trim_end();
    format!("{without_trailing_semicolons}; SELECT ROW_COUNT() AS affectedRows, LAST_INSERT_ID() AS insertId;")
}

fn parse_mysql_write_metadata(output: &str) -> (i64, Option<String>) {
    let rows = parse_tsv_rows(output);
    let Some(header_index) = rows.iter().rposition(|row| {
        row.first().is_some_and(|column| column == "affectedRows")
            && row.get(1).is_some_and(|column| column == "insertId")
    }) else {
        return (0, None);
    };
    let values = rows.get(header_index + 1);
    let affected_rows = values
        .and_then(|row| row.first())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let insert_id = values
        .and_then(|row| row.get(1))
        .filter(|value| !value.is_empty() && value.as_str() != "0")
        .cloned();
    (affected_rows, insert_id)
}

fn parse_postgres_command_tag_row_count(output: &str) -> Option<Option<u64>> {
    let mut lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let line = lines.next()?;
    if lines.next().is_some() {
        return None;
    }
    let parts = line.split_whitespace().collect::<Vec<_>>();
    let command = parts.first()?.to_ascii_uppercase();
    match command.as_str() {
        "INSERT" if parts.len() >= 3 => Some(parts.last().and_then(|value| value.parse().ok())),
        "UPDATE" | "DELETE" | "MERGE" | "COPY" | "MOVE" | "FETCH" if parts.len() == 2 => {
            Some(parts.get(1).and_then(|value| value.parse().ok()))
        }
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "BEGIN" | "COMMIT" | "ROLLBACK" => Some(None),
        _ => None,
    }
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn mysql_value_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => {
            if *value {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        Value::Number(number) => number.to_string(),
        Value::String(value) => sql_string(value),
        other => sql_string(&other.to_string()),
    }
}

fn clickhouse_query_with_json_format(sql: &str) -> String {
    let trimmed = sql.trim_end();
    if clickhouse_query_has_format_clause(trimmed) {
        return sql.to_string();
    }
    let without_trailing_semicolon = trimmed.trim_end_matches(';').trim_end();
    format!("{without_trailing_semicolon} FORMAT JSON")
}

fn clickhouse_query_has_format_clause(sql: &str) -> bool {
    sql.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .any(|token| token.eq_ignore_ascii_case("format"))
}

fn pg_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sqlite_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sqlite_value_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => {
            if *value {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        Value::Number(number) => number.to_string(),
        Value::String(value) => sqlite_literal(value),
        other => sqlite_literal(&other.to_string()),
    }
}

fn sqlite_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn sqlite_identifier_literal(value: &str) -> String {
    sqlite_literal(value)
}

fn clickhouse_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn url_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn mongo_ejson_prelude() -> &'static str {
    "const __shelldeskParseEjson = (text) => { if (typeof EJSON !== 'undefined' && EJSON.parse) { return EJSON.parse(text, { relaxed: true }); } return JSON.parse(text); }; const __shelldeskStringify = (value) => { if (typeof EJSON !== 'undefined' && EJSON.stringify) { try { return EJSON.stringify(value, null, 0, { relaxed: false }); } catch (_error) { return EJSON.stringify(value, { relaxed: false }); } } return JSON.stringify(value); };"
}

fn mongo_ejson_value_expression(raw: &str, fallback_js: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        fallback_js.to_string()
    } else {
        format!("__shelldeskParseEjson({})", js_string(trimmed))
    }
}

fn redis_lines(output: &str) -> Vec<String> {
    output.lines().map(ToString::to_string).collect()
}

fn redis_pairs_to_object(output: &str) -> Value {
    let mut object = serde_json::Map::new();
    let mut lines = output.lines();
    while let Some(key) = lines.next() {
        let value = lines.next().unwrap_or("");
        object.insert(key.to_string(), json!(value));
    }
    Value::Object(object)
}

fn redis_zset_items(output: &str) -> Value {
    let mut items = Vec::new();
    let mut lines = output.lines();
    while let Some(member) = lines.next() {
        let score = lines.next().unwrap_or("");
        let score = score
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(|value| json!(value))
            .unwrap_or_else(|| json!(score));
        items.push(json!({ "member": member, "score": score }));
    }
    json!(items)
}

fn redis_stream_preview_lua() -> String {
    "local limit = tonumber(ARGV[1]) or 100; return cjson.encode(redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', limit))".to_string()
}

fn redis_stream_preview(output: &str) -> Value {
    serde_json::from_str(output.trim()).unwrap_or_else(|_| json!(redis_lines(output)))
}

fn redis_cli_json_unsupported(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("--json")
        && (normalized.contains("unrecognized")
            || normalized.contains("unknown")
            || normalized.contains("invalid option")
            || normalized.contains("bad number of args")
            || normalized.contains("usage: redis-cli"))
}

fn parse_redis_json_command_output(output: &str) -> Result<Value, String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(trimmed).map_err(error_string)
}

fn parse_redis_raw_command_output(command: &str, output: &str) -> Value {
    let lines = redis_lines(output);
    if lines.is_empty() {
        return Value::Null;
    }
    if lines.len() == 1 {
        let value = lines[0].clone();
        if redis_integer_reply_command(command) {
            if let Ok(number) = value.parse::<i64>() {
                return json!(number);
            }
        }
        return json!(value);
    }
    json!(lines)
}

fn redis_integer_reply_command(command: &str) -> bool {
    matches!(
        command.to_ascii_uppercase().as_str(),
        "APPEND"
            | "BITCOUNT"
            | "BITPOS"
            | "DBSIZE"
            | "DECR"
            | "DECRBY"
            | "DEL"
            | "EXISTS"
            | "EXPIRE"
            | "EXPIREAT"
            | "EXPIRETIME"
            | "HDEL"
            | "HEXISTS"
            | "HLEN"
            | "HSET"
            | "HSETNX"
            | "INCR"
            | "INCRBY"
            | "LINSERT"
            | "LLEN"
            | "LPUSH"
            | "LPUSHX"
            | "PERSIST"
            | "PEXPIRE"
            | "PEXPIREAT"
            | "PEXPIRETIME"
            | "PFADD"
            | "PFCOUNT"
            | "PUBLISH"
            | "RENAMENX"
            | "RPUSH"
            | "RPUSHX"
            | "SADD"
            | "SCARD"
            | "SISMEMBER"
            | "SMISMEMBER"
            | "SREM"
            | "STRLEN"
            | "TTL"
            | "UNLINK"
            | "ZADD"
            | "ZCARD"
            | "ZCOUNT"
            | "ZLEXCOUNT"
            | "ZREM"
            | "ZREMRANGEBYLEX"
            | "ZREMRANGEBYRANK"
            | "ZREMRANGEBYSCORE"
            | "ZRANK"
            | "ZREVRANK"
            | "XACK"
            | "XDEL"
            | "XLEN"
            | "XTRIM"
    )
}

fn redis_zset_cli_args(value: &Value) -> Result<Vec<String>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "ZSet 值必须是 JSON 数组。".to_string())?;
    let mut args = Vec::new();
    let mut index = 0;
    while index < items.len() {
        let item = &items[index];
        if let Some(object) = item.as_object() {
            if let (Some(member), Some(score)) = (object.get("member"), object.get("score")) {
                args.push(json_to_cli_value(score));
                args.push(json_to_cli_value(member));
            }
            index += 1;
        } else if index + 1 < items.len() {
            args.push(json_to_cli_value(&items[index + 1]));
            args.push(json_to_cli_value(item));
            index += 2;
        } else {
            index += 1;
        }
    }
    Ok(args)
}

fn json_to_cli_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActiveConnection, ConnectionKind};
    use std::collections::HashSet;

    fn test_connection(kind: ConnectionKind, system_type: &str) -> ActiveConnection {
        ActiveConnection {
            id: "test-connection".to_string(),
            kind,
            partition: "test-partition".to_string(),
            proxy_port: 0,
            browser_certificate_trust: HashSet::new(),
            connected_at: "2026-06-18T00:00:00.000Z".to_string(),
            host: json!({ "systemType": system_type }),
            ssh: None,
            privilege: None,
        }
    }

    #[test]
    fn redis_zset_items_preserve_member_score_shape() {
        assert_eq!(
            redis_zset_items("alpha\n1.5\nbeta\n2\n"),
            json!([
                { "member": "alpha", "score": 1.5 },
                { "member": "beta", "score": 2.0 }
            ])
        );
    }

    #[test]
    fn redis_stream_preview_preserves_xrange_entry_shape() {
        assert_eq!(
            redis_stream_preview(
                r#"[["1670000000000-0",["field","value","count","2"]],["1670000000001-0",["status","ok"]]]"#
            ),
            json!([
                ["1670000000000-0", ["field", "value", "count", "2"]],
                ["1670000000001-0", ["status", "ok"]]
            ])
        );
    }

    #[test]
    fn redis_stream_preview_keeps_legacy_raw_fallback() {
        assert_eq!(
            redis_stream_preview("1670000000000-0\nfield\nvalue\n"),
            json!(["1670000000000-0", "field", "value"])
        );
    }

    #[test]
    fn redis_json_command_output_preserves_ioredis_like_types() {
        assert_eq!(
            parse_redis_json_command_output(r#""PONG""#).unwrap(),
            json!("PONG")
        );
        assert_eq!(parse_redis_json_command_output("3").unwrap(), json!(3));
        assert_eq!(
            parse_redis_json_command_output(r#"["field","value"]"#).unwrap(),
            json!(["field", "value"])
        );
        assert_eq!(
            parse_redis_json_command_output("null").unwrap(),
            Value::Null
        );
    }

    #[test]
    fn redis_raw_command_output_keeps_strings_unless_command_is_integer_reply() {
        assert_eq!(parse_redis_raw_command_output("GET", "123"), json!("123"));
        assert_eq!(parse_redis_raw_command_output("DEL", "2"), json!(2));
        assert_eq!(
            parse_redis_raw_command_output("HGETALL", "field\nvalue\ncount\n2"),
            json!(["field", "value", "count", "2"])
        );
        assert_eq!(parse_redis_raw_command_output("GET", ""), Value::Null);
    }

    #[test]
    fn redis_json_unsupported_detection_is_narrow() {
        assert!(redis_cli_json_unsupported(
            "Unrecognized option or bad number of args for: '--json'"
        ));
        assert!(redis_cli_json_unsupported(
            "Usage: redis-cli [OPTIONS] --json"
        ));
        assert!(!redis_cli_json_unsupported(
            "NOAUTH Authentication required."
        ));
        assert!(!redis_cli_json_unsupported("ERR unknown command 'BOGUS'"));
    }

    #[test]
    fn redis_zset_cli_args_accept_object_items() {
        assert_eq!(
            redis_zset_cli_args(&json!([
                { "member": "alpha", "score": 1.5 },
                { "member": "beta", "score": "2" }
            ]))
            .unwrap(),
            vec![
                "1.5".to_string(),
                "alpha".to_string(),
                "2".to_string(),
                "beta".to_string()
            ]
        );
    }

    #[test]
    fn redis_zset_cli_args_accept_alternating_array_items() {
        assert_eq!(
            redis_zset_cli_args(&json!(["alpha", 1.5, "beta", "2"])).unwrap(),
            vec![
                "1.5".to_string(),
                "alpha".to_string(),
                "2".to_string(),
                "beta".to_string()
            ]
        );
    }

    #[test]
    fn redis_set_value_commands_preserve_ttl_after_zset_write() {
        assert_eq!(
            redis_set_value_commands(
                "rank",
                &json!([{ "member": "alpha", "score": 1.5 }]),
                "zset",
                3000
            )
            .unwrap(),
            vec![
                vec!["DEL".to_string(), "rank".to_string()],
                vec![
                    "ZADD".to_string(),
                    "rank".to_string(),
                    "1.5".to_string(),
                    "alpha".to_string()
                ],
                vec![
                    "PEXPIRE".to_string(),
                    "rank".to_string(),
                    "3000".to_string()
                ]
            ]
        );
    }

    #[test]
    fn redis_set_value_commands_reject_unsupported_types() {
        assert_eq!(
            redis_set_value_commands("events", &json!([]), "stream", -1).unwrap_err(),
            "暂不支持保存 stream 类型。"
        );
    }

    #[test]
    fn redis_set_value_commands_validate_collection_shapes() {
        assert_eq!(
            redis_set_value_commands("hash-key", &json!([]), "hash", -1).unwrap_err(),
            "Hash 值必须是 JSON 对象。"
        );
        assert_eq!(
            redis_set_value_commands("list-key", &json!({}), "list", -1).unwrap_err(),
            "List 值必须是 JSON 数组。"
        );
        assert_eq!(
            redis_set_value_commands("set-key", &json!({}), "set", -1).unwrap_err(),
            "Set 值必须是 JSON 数组。"
        );
        assert_eq!(
            redis_set_value_commands("zset-key", &json!({}), "zset", -1).unwrap_err(),
            "ZSet 值必须是 JSON 数组。"
        );
    }

    #[test]
    fn sqlite_options_keep_only_sudo_password() {
        assert_eq!(
            sqlite_options_from_arg(Some(&json!({
                "sudoPassword": "secret",
                "ignored": true
            }))),
            json!({ "sudoPassword": "secret" })
        );
        assert_eq!(sqlite_options_from_arg(Some(&json!(null))), json!({}));
        assert_eq!(
            sqlite_options_from_arg(Some(&json!({ "sudoPassword": 123 }))),
            json!({})
        );
    }

    #[test]
    fn sqlite_operation_options_prefer_call_options_over_session_options() {
        let config = json!({ "options": { "sudoPassword": "session" } });
        assert_eq!(
            sqlite_operation_options(&config, Some(&json!({}))),
            json!({ "sudoPassword": "session" })
        );
        assert_eq!(
            sqlite_operation_options(&config, Some(&json!({ "sudoPassword": "call" }))),
            json!({ "sudoPassword": "call" })
        );
    }

    #[test]
    fn sqlite_windows_command_selection_uses_target_system() {
        assert!(!sqlite_use_windows_command(&test_connection(
            ConnectionKind::Ssh,
            "linux"
        )));
        assert!(sqlite_use_windows_command(&test_connection(
            ConnectionKind::Ssh,
            "windows"
        )));
    }

    #[test]
    fn mysql_cli_commands_use_shell_specific_password_env() {
        let (posix, windows) = mysql_cli_commands(
            "127.0.0.1",
            3306,
            "root",
            "secret value",
            "app_db",
            "SELECT 1;",
        );
        assert!(posix.starts_with("MYSQL_PWD='secret value' mysql "));
        assert!(windows.starts_with("$env:MYSQL_PWD = 'secret value'; mysql "));
        assert!(posix.contains(" 'app_db' --execute 'SELECT 1;'"));
        assert!(windows.contains(" 'app_db' --execute 'SELECT 1;'"));
        assert!(!posix.contains("--password"));
        assert!(!windows.contains("--password"));
    }

    #[test]
    fn mysql_cli_commands_omit_password_env_when_empty() {
        let (posix, windows) =
            mysql_cli_commands("localhost", 3306, "root", "", "", "SHOW DATABASES;");
        assert!(posix.starts_with("mysql --batch --raw "));
        assert!(windows.starts_with("mysql --batch --raw "));
        assert!(!posix.contains("MYSQL_PWD"));
        assert!(!windows.contains("MYSQL_PWD"));
    }

    #[test]
    fn mysql_query_detects_write_statements_for_result_metadata() {
        assert!(is_mysql_write_statement(" update users set name = 'a'"));
        assert!(is_mysql_write_statement(
            "\u{feff}INSERT INTO users(name) VALUES ('a')"
        ));
        assert!(is_mysql_write_statement("DELETE FROM users WHERE id = 1"));
        assert!(is_mysql_write_statement("CREATE TABLE t(id int)"));
        assert!(!is_mysql_write_statement("SELECT * FROM users"));
        assert!(!is_mysql_write_statement("SHOW TABLES"));
        assert!(!is_mysql_write_statement(
            "WITH recent AS (SELECT 1) SELECT * FROM recent"
        ));
    }

    #[test]
    fn mysql_query_appends_same_connection_write_metadata_query() {
        assert_eq!(
            mysql_query_with_write_metadata("UPDATE users SET name = 'a'; "),
            "UPDATE users SET name = 'a'; SELECT ROW_COUNT() AS affectedRows, LAST_INSERT_ID() AS insertId;"
        );
    }

    #[test]
    fn mysql_write_metadata_parser_uses_last_metadata_result_set() {
        assert_eq!(
            parse_mysql_write_metadata("affectedRows\tinsertId\n2\t0\n"),
            (2, None)
        );
        assert_eq!(
            parse_mysql_write_metadata("id\n1\naffectedRows\tinsertId\n1\t42\n"),
            (1, Some("42".to_string()))
        );
        assert_eq!(parse_mysql_write_metadata(""), (0, None));
    }

    #[test]
    fn postgres_command_tags_preserve_write_row_count() {
        assert_eq!(
            parse_postgres_command_tag_row_count("UPDATE 3\n"),
            Some(Some(3))
        );
        assert_eq!(
            parse_postgres_command_tag_row_count("DELETE 0\n"),
            Some(Some(0))
        );
        assert_eq!(
            parse_postgres_command_tag_row_count("INSERT 0 42\n"),
            Some(Some(42))
        );
        assert_eq!(
            parse_postgres_command_tag_row_count("CREATE TABLE\n"),
            Some(None)
        );
    }

    #[test]
    fn postgres_command_tag_parser_leaves_csv_results_alone() {
        assert_eq!(
            parse_postgres_command_tag_row_count("id,name\n1,Ada\n"),
            None
        );
        assert_eq!(
            parse_postgres_command_tag_row_count("UPDATE 3\nvalue\n"),
            None
        );
        assert_eq!(parse_postgres_command_tag_row_count("SELECT 1\n"), None);
    }

    #[test]
    fn clickhouse_response_parser_handles_empty_and_plain_text_responses() {
        assert_eq!(
            parse_clickhouse_response(""),
            json!({ "columns": [], "rows": [], "rowCount": 0 })
        );
        assert_eq!(
            parse_clickhouse_response("Ok.\n"),
            json!({
                "columns": ["response"],
                "rows": [{ "response": "Ok.\n" }],
                "rowCount": 1
            })
        );
    }

    #[test]
    fn clickhouse_query_format_removes_trailing_semicolon_before_json_format() {
        assert_eq!(
            clickhouse_query_with_json_format("SELECT * FROM `soc`.`normalized_events` LIMIT 50;"),
            "SELECT * FROM `soc`.`normalized_events` LIMIT 50 FORMAT JSON"
        );
        assert_eq!(
            clickhouse_query_with_json_format("SELECT * FROM events LIMIT 50   ;  "),
            "SELECT * FROM events LIMIT 50 FORMAT JSON"
        );
    }

    #[test]
    fn clickhouse_query_format_preserves_existing_format_clause() {
        assert_eq!(
            clickhouse_query_with_json_format("SELECT * FROM events FORMAT JSONEachRow"),
            "SELECT * FROM events FORMAT JSONEachRow"
        );
        assert_eq!(
            clickhouse_query_with_json_format("SELECT * FROM events\nFORMAT JSON;"),
            "SELECT * FROM events\nFORMAT JSON;"
        );
    }

    #[test]
    fn clickhouse_response_parser_preserves_json_columns_rows_and_statistics() {
        let parsed = parse_clickhouse_response(
            r#"{
                "meta": [{"name": "name"}, {"name": "totalRows"}],
                "data": [{"name": "events", "totalRows": "12"}],
                "rows": 1,
                "statistics": {"elapsed": 0.1, "rows_read": 1, "bytes_read": 24}
            }"#,
        );

        assert_eq!(
            parsed,
            json!({
                "columns": ["name", "totalRows"],
                "rows": [{"name": "events", "totalRows": "12"}],
                "rowCount": 1,
                "statistics": { "elapsed": 0.1, "rowsRead": 1, "bytesRead": 24 }
            })
        );
    }

    #[test]
    fn clickhouse_response_parser_wraps_scalar_rows_like_legacy_fallback() {
        let parsed = parse_clickhouse_response(r#"{ "data": ["alpha", "beta"] }"#);

        assert_eq!(
            parsed,
            json!({
                "columns": ["value"],
                "rows": [{ "value": "alpha" }, { "value": "beta" }],
                "rowCount": 2,
                "statistics": null
            })
        );
    }

    #[test]
    fn mongo_ejson_expression_parses_extended_json_and_preserves_empty_fallbacks() {
        assert_eq!(
            mongo_ejson_value_expression(
                r#"{ "_id": { "$oid": "507f1f77bcf86cd799439011" } }"#,
                "{}"
            ),
            r#"__shelldeskParseEjson("{ \"_id\": { \"$oid\": \"507f1f77bcf86cd799439011\" } }")"#
        );
        assert_eq!(
            mongo_ejson_value_expression("   ", "undefined"),
            "undefined"
        );
    }

    #[test]
    fn mongo_ejson_prelude_uses_canonical_ejson_stringify() {
        let prelude = mongo_ejson_prelude();

        assert!(prelude.contains("__shelldeskParseEjson"));
        assert!(prelude.contains("EJSON.parse"));
        assert!(prelude.contains("relaxed: true"));
        assert!(prelude.contains("EJSON.stringify"));
        assert!(prelude.contains("relaxed: false"));
    }
}
