use serde_json::{json, Value};
use sqlx::{mysql::MySqlPoolOptions, Executor, MySqlPool};
use std::time::Instant;

use super::{
    config::MysqlConnectConfig,
    core::{
        open_database_ssh_tunnel, session_key, validate_database_endpoint, DatabaseTunnelSession,
        DbTunnelError, MysqlTunnelSession, TunnelOptions,
    },
    percent_encode,
    rows::{
        bind_mysql_value, fetch_mysql_rows_limited, has_returning_clause, is_write_statement,
        mysql_identifier, mysql_text_value, rows_to_json_mysql,
    },
    timeout_result, METADATA_TIMEOUT, QUERY_TIMEOUT,
};
use crate::{error_string, get_connection, random_id, string_arg, AppState, ConnectionKind};

pub(crate) async fn mysql_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config_value = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let config: MysqlConnectConfig = serde_json::from_value(config_value)
        .map_err(|error| format!("MySQL 隧道配置无效：{error}"))?;
    let tunnel_options = config
        .tunnel
        .clone()
        .unwrap_or_else(|| TunnelOptions::for_database_endpoint(config.host.clone(), config.port));
    validate_database_endpoint(&tunnel_options.remote_host, tunnel_options.remote_port)?;
    if config.user.trim().is_empty() {
        return Err("MySQL 用户名不能为空。".to_string());
    }

    let connection = get_connection(state, &connection_id)?;
    let (pool, tunnel, transport) = if connection.kind == ConnectionKind::Local {
        (
            connect_mysql_direct(
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
        match connect_mysql_direct(&config, &endpoint.host, endpoint.port).await {
            Ok(pool) => (pool, Some(endpoint.tunnel), endpoint.transport),
            Err(error) => {
                endpoint.tunnel.shutdown().await;
                return Err(error);
            }
        }
    };

    let mysql_id = random_id("mysql-tunnel");
    state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .insert(
            session_key("mysql", &connection_id, &mysql_id),
            DatabaseTunnelSession::Mysql(MysqlTunnelSession {
                tunnel,
                pool,
                last_activity: Instant::now(),
            }),
        );
    Ok(json!({
        "mysqlId": mysql_id,
        "transport": transport,
        "alreadyConnected": false
    }))
}

pub(crate) async fn mysql_databases(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = mysql_pool(state, &args)?;
    let rows = timeout_result(
        METADATA_TIMEOUT,
        sqlx::query("SHOW DATABASES").fetch_all(&pool),
        |error| DbTunnelError::MysqlQuery(error).user_message(),
    )
    .await?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| mysql_text_value(&row, 0))
        .collect::<Vec<_>>()))
}

pub(crate) async fn mysql_tables(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = mysql_pool(state, &args)?;
    let database = string_arg(&args, 2)?;
    let sql = format!("SHOW TABLES FROM {}", mysql_identifier(&database));
    let rows = timeout_result(
        METADATA_TIMEOUT,
        sqlx::query(&sql).fetch_all(&pool),
        |error| DbTunnelError::MysqlQuery(error).user_message(),
    )
    .await?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| mysql_text_value(&row, 0))
        .collect::<Vec<_>>()))
}

pub(crate) async fn mysql_columns(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = mysql_pool(state, &args)?;
    let database = string_arg(&args, 2)?;
    let table = string_arg(&args, 3)?;
    let rows = timeout_result(
        METADATA_TIMEOUT,
        sqlx::query(
            "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_KEY,COLUMN_DEFAULT,EXTRA,COLUMN_COMMENT \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&pool),
        |error| DbTunnelError::MysqlQuery(error).user_message(),
    )
    .await?;
    Ok(json!(rows
        .into_iter()
        .map(|row| json!({
            "name": mysql_text_value(&row, 0).unwrap_or_default(),
            "type": mysql_text_value(&row, 1).unwrap_or_default(),
            "nullable": mysql_text_value(&row, 2).is_some_and(|value| value == "YES"),
            "key": mysql_text_value(&row, 3).unwrap_or_default(),
            "default": mysql_text_value(&row, 4),
            "extra": mysql_text_value(&row, 5).unwrap_or_default(),
            "comment": mysql_text_value(&row, 6).unwrap_or_default()
        }))
        .collect::<Vec<_>>()))
}

pub(crate) async fn mysql_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = mysql_pool(state, &args)?;
    let sql = string_arg(&args, 2)?;
    tokio::time::timeout(QUERY_TIMEOUT, async {
        if is_write_statement(&sql) && !has_returning_clause(&sql) {
            let result = pool
                .execute(sql.as_str())
                .await
                .map_err(|error| DbTunnelError::MysqlQuery(error).user_message())?;
            let mut value = json!({
                "columns": [],
                "rows": [],
                "affectedRows": result.rows_affected()
            });
            let insert_id = result.last_insert_id();
            if insert_id != 0 {
                value["insertId"] = json!(insert_id.to_string());
            }
            return Ok(value);
        }
        let rows = fetch_mysql_rows_limited(&pool, &sql).await?;
        Ok(rows_to_json_mysql(rows))
    })
    .await
    .map_err(|_| DbTunnelError::QueryTimeout.user_message())?
}

pub(crate) async fn mysql_update_cell(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = mysql_pool(state, &args)?;
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
    let where_values = if !pk_columns.is_empty() && pk_columns.len() == pk_values.len() {
        pk_columns
            .iter()
            .zip(pk_values.iter())
            .filter_map(|(name, value)| {
                name.as_str()
                    .map(|name| (format!("{} = ?", mysql_identifier(name)), value.clone()))
            })
            .collect::<Vec<_>>()
    } else if !pk_column.is_empty() {
        vec![(
            format!("{} = ?", mysql_identifier(pk_column)),
            pk_value.clone(),
        )]
    } else {
        return Err("无法定位要更新的 MySQL 行。".to_string());
    };
    let where_clause = where_values
        .iter()
        .map(|(clause, _)| clause.as_str())
        .collect::<Vec<_>>()
        .join(" AND ");
    if where_clause.trim().is_empty() {
        return Err("无法定位要更新的 MySQL 行。".to_string());
    }
    let sql = format!(
        "UPDATE {}.{} SET {} = ? WHERE {}",
        mysql_identifier(&database),
        mysql_identifier(&table),
        mysql_identifier(&column),
        where_clause
    );
    let mut query = bind_mysql_value(sqlx::query(&sql), new_value);
    for (_, value) in where_values {
        query = bind_mysql_value(query, value);
    }
    let result = timeout_result(QUERY_TIMEOUT, query.execute(&pool), |error| {
        DbTunnelError::MysqlQuery(error).user_message()
    })
    .await?;
    Ok(json!({ "affectedRows": result.rows_affected() }))
}

async fn connect_mysql_direct(
    config: &MysqlConnectConfig,
    host: &str,
    port: u16,
) -> Result<MySqlPool, String> {
    let dsn = format!(
        "mysql://{}:{}@{}:{}/{}",
        percent_encode(&config.user),
        percent_encode(&config.password),
        host,
        port,
        percent_encode(config.database.as_deref().unwrap_or(""))
    );
    let pool = MySqlPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&dsn)
        .await
        .map_err(|error| DbTunnelError::MysqlConnect(error).user_message())?;
    if let Err(error) = timeout_result(
        METADATA_TIMEOUT,
        sqlx::query("SELECT 1").execute(&pool),
        |error| DbTunnelError::MysqlQuery(error).user_message(),
    )
    .await
    {
        pool.close().await;
        return Err(error);
    }
    Ok(pool)
}

fn mysql_pool(state: &AppState, args: &[Value]) -> Result<MySqlPool, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let mut guard = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?;
    let session = guard
        .get_mut(&session_key("mysql", &connection_id, &session_id))
        .ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    session.touch();
    match session {
        DatabaseTunnelSession::Mysql(session) => Ok(session.pool.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "mysql",
            actual: other.kind(),
        }
        .user_message()),
    }
}
