use serde_json::{json, Value};
use std::time::Instant;

use super::{
    config::{clickhouse_port, ClickHouseConnectConfig},
    core::{
        open_database_ssh_tunnel, session_key, validate_database_endpoint, ClickHouseTunnelSession,
        DatabaseTunnelSession, DbTunnelError, TunnelOptions,
    },
    MAX_QUERY_ROWS, METADATA_TIMEOUT, QUERY_TIMEOUT,
};
use crate::{error_string, get_connection, random_id, string_arg, AppState, ConnectionKind};

pub(crate) async fn clickhouse_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config_value = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let config: ClickHouseConnectConfig = serde_json::from_value(config_value)
        .map_err(|error| format!("ClickHouse 隧道配置无效：{error}"))?;
    let remote_port = clickhouse_port(&config);
    let tunnel_options = config
        .tunnel
        .clone()
        .unwrap_or_else(|| TunnelOptions::for_database_endpoint(config.host.clone(), remote_port));
    validate_database_endpoint(&tunnel_options.remote_host, tunnel_options.remote_port)?;
    if config.user.trim().is_empty() {
        return Err("ClickHouse 用户名不能为空。".to_string());
    }
    let connection = get_connection(state, &connection_id)?;
    let (client, tunnel, transport) = if connection.kind == ConnectionKind::Local {
        (
            connect_clickhouse_direct(
                &config,
                &tunnel_options.remote_host,
                tunnel_options.remote_port,
            )
            .await?,
            None,
            "direct",
        )
    } else {
        let endpoint =
            open_database_ssh_tunnel(state, window, &connection_id, &tunnel_options).await?;
        match connect_clickhouse_direct(&config, &endpoint.host, endpoint.port).await {
            Ok(client) => (client, Some(endpoint.tunnel), endpoint.transport),
            Err(error) => {
                endpoint.tunnel.shutdown().await;
                return Err(error);
            }
        }
    };
    let clickhouse_id = random_id("clickhouse-tunnel");
    state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .insert(
            session_key("clickhouse", &connection_id, &clickhouse_id),
            DatabaseTunnelSession::ClickHouse(ClickHouseTunnelSession {
                tunnel,
                client,
                last_activity: Instant::now(),
            }),
        );
    Ok(json!({
        "clickhouseId": clickhouse_id,
        "transport": transport,
        "alreadyConnected": false
    }))
}

pub(crate) async fn clickhouse_databases(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let result = clickhouse_query_sql(
        state,
        &args,
        "SELECT name FROM system.databases ORDER BY name",
        None,
        METADATA_TIMEOUT,
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
    let database = string_arg(&args, 2)?;
    let sql = format!(
        "SELECT name, engine, total_rows AS totalRows, total_bytes AS totalBytes FROM system.tables WHERE database = {} ORDER BY name",
        clickhouse_string_literal(&database)
    );
    let result = clickhouse_query_sql(state, &args, &sql, None, METADATA_TIMEOUT).await?;
    Ok(result.get("rows").cloned().unwrap_or_else(|| json!([])))
}

pub(crate) async fn clickhouse_columns(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let database = string_arg(&args, 2)?;
    let table = string_arg(&args, 3)?;
    let sql = format!(
        "SELECT name, type, default_kind AS defaultKind, default_expression AS defaultExpression, comment, is_in_primary_key AS isPrimaryKey, is_in_sorting_key AS isSortingKey FROM system.columns WHERE database = {} AND table = {} ORDER BY position",
        clickhouse_string_literal(&database),
        clickhouse_string_literal(&table)
    );
    let result = clickhouse_query_sql(state, &args, &sql, None, METADATA_TIMEOUT).await?;
    Ok(result.get("rows").cloned().unwrap_or_else(|| json!([])))
}

pub(crate) async fn clickhouse_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let sql = string_arg(&args, 2)?;
    let database = args.get(3).and_then(Value::as_str);
    clickhouse_query_sql(state, &args, &sql, database, QUERY_TIMEOUT).await
}

async fn connect_clickhouse_direct(
    config: &ClickHouseConnectConfig,
    host: &str,
    port: u16,
) -> Result<clickhouse::Client, String> {
    let scheme = if config.secure { "https" } else { "http" };
    let mut client = clickhouse::Client::default()
        .with_url(format!("{scheme}://{host}:{port}"))
        .with_user(config.user.clone());
    if !config.password.is_empty() {
        client = client.with_password(config.password.clone());
    }
    if !config.database.is_empty() {
        client = client.with_database(config.database.clone());
    }
    let mut cursor = client
        .query("SELECT 1 AS ok")
        .fetch_bytes("JSON")
        .map_err(|error| DbTunnelError::ClickHouseConnect(error.to_string()).user_message())?;
    let collect_result = tokio::time::timeout(METADATA_TIMEOUT, cursor.collect())
        .await
        .map_err(|_| DbTunnelError::QueryTimeout.user_message())?;
    if let Err(error) = collect_result {
        return Err(DbTunnelError::ClickHouseConnect(error.to_string()).user_message());
    }
    Ok(client)
}

fn clickhouse_client(state: &AppState, args: &[Value]) -> Result<clickhouse::Client, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let mut guard = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?;
    let session = guard
        .get_mut(&session_key("clickhouse", &connection_id, &session_id))
        .ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    session.touch();
    match session {
        DatabaseTunnelSession::ClickHouse(session) => Ok(session.client.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "clickhouse",
            actual: other.kind(),
        }
        .user_message()),
    }
}

async fn clickhouse_query_sql(
    state: &AppState,
    args: &[Value],
    sql: &str,
    database_override: Option<&str>,
    timeout: std::time::Duration,
) -> Result<Value, String> {
    let client = clickhouse_client(state, args)?;
    let client = if let Some(database) = database_override.filter(|database| !database.is_empty()) {
        client.with_database(database.to_string())
    } else {
        client
    };
    let mut cursor = client
        .query(sql)
        .with_option("max_execution_time", timeout.as_secs().to_string())
        .with_option("max_result_rows", (MAX_QUERY_ROWS + 1).to_string())
        .with_option("result_overflow_mode", "break")
        .fetch_bytes("JSON")
        .map_err(|error| DbTunnelError::ClickHouseQuery(error.to_string()).user_message())?;
    let bytes = tokio::time::timeout(timeout, cursor.collect())
        .await
        .map_err(|_| DbTunnelError::QueryTimeout.user_message())?
        .map_err(|error| DbTunnelError::ClickHouseQuery(error.to_string()).user_message())?;
    let output = String::from_utf8_lossy(&bytes).to_string();
    Ok(parse_clickhouse_response(&output))
}

#[cfg(test)]
pub(super) fn parse_clickhouse_response(output: &str) -> Value {
    parse_clickhouse_response_inner(output)
}

#[cfg(not(test))]
fn parse_clickhouse_response(output: &str) -> Value {
    parse_clickhouse_response_inner(output)
}

fn parse_clickhouse_response_inner(output: &str) -> Value {
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
    let mut rows = raw
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
    let truncated = rows.len() > MAX_QUERY_ROWS;
    if truncated {
        rows.truncate(MAX_QUERY_ROWS);
    }
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
        "truncated": truncated,
        "statistics": statistics
    })
}

fn clickhouse_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}
