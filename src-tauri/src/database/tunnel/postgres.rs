use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, Executor, PgPool, Row};

use super::super::sql::{pg_identifier, pg_value_literal};
use super::{
    config::PostgresConnectConfig,
    core::{
        open_database_ssh_tunnel, session_key, validate_database_endpoint, DatabaseTunnelSession,
        DbTunnelError, PostgresTunnelSession, TunnelOptions,
    },
    percent_encode,
    rows::{fetch_pg_rows_limited, has_returning_clause, is_write_statement, rows_to_json_pg},
    timeout_result, METADATA_TIMEOUT, QUERY_TIMEOUT,
};
use crate::{error_string, get_connection, random_id, string_arg, AppState, ConnectionKind};

pub(crate) async fn postgres_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config_value = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let config: PostgresConnectConfig = serde_json::from_value(config_value)
        .map_err(|error| format!("PostgreSQL 隧道配置无效：{error}"))?;
    let tunnel_options = config
        .tunnel
        .clone()
        .unwrap_or_else(|| TunnelOptions::for_database_endpoint(config.host.clone(), config.port));
    validate_database_endpoint(&tunnel_options.remote_host, tunnel_options.remote_port)?;
    if config.user.trim().is_empty() {
        return Err("PostgreSQL 用户名不能为空。".to_string());
    }

    let connection = get_connection(state, &connection_id)?;
    let (pool, tunnel, transport) = if connection.kind == ConnectionKind::Local {
        (
            connect_postgres_direct(
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
        match connect_postgres_direct(&config, &endpoint.host, endpoint.port).await {
            Ok(pool) => (pool, Some(endpoint.tunnel), endpoint.transport),
            Err(error) => {
                endpoint.tunnel.shutdown().await;
                return Err(error);
            }
        }
    };

    let postgres_id = random_id("postgres-tunnel");
    state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .insert(
            session_key("postgres", &connection_id, &postgres_id),
            DatabaseTunnelSession::Postgres(PostgresTunnelSession { tunnel, pool }),
        );
    Ok(json!({
        "postgresId": postgres_id,
        "transport": transport,
        "alreadyConnected": false
    }))
}

pub(crate) async fn postgres_databases(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let pool = postgres_pool(state, &args)?;
    let rows = timeout_result(
        METADATA_TIMEOUT,
        sqlx::query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
            .fetch_all(&pool),
        |error| DbTunnelError::PostgresQuery(error).user_message(),
    )
    .await?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("datname").ok())
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_schemas(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = postgres_pool(state, &args)?;
    let rows = timeout_result(
        METADATA_TIMEOUT,
        sqlx::query(
            "SELECT nspname AS schema_name \
             FROM pg_catalog.pg_namespace \
             WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg_%' \
             ORDER BY nspname",
        )
        .fetch_all(&pool),
        |error| DbTunnelError::PostgresQuery(error).user_message(),
    )
    .await?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("schema_name").ok())
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_tables(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = postgres_pool(state, &args)?;
    let schema = string_arg(&args, 2)?;
    let rows = timeout_result(
        METADATA_TIMEOUT,
        sqlx::query(
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
             WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
             ORDER BY c.relname",
        )
        .bind(schema)
        .fetch_all(&pool),
        |error| DbTunnelError::PostgresQuery(error).user_message(),
    )
    .await?;
    Ok(json!(rows
        .into_iter()
        .map(|row| json!({
            "schema": row.try_get::<String, _>("table_schema").unwrap_or_default(),
            "name": row.try_get::<String, _>("table_name").unwrap_or_default(),
            "type": row.try_get::<String, _>("table_type").unwrap_or_default()
        }))
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_columns(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = postgres_pool(state, &args)?;
    let schema = string_arg(&args, 2)?;
    let table = string_arg(&args, 3)?;
    let rows = timeout_result(
        METADATA_TIMEOUT,
        sqlx::query(
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
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position
"#,
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool),
        |error| DbTunnelError::PostgresQuery(error).user_message(),
    )
    .await?;
    Ok(json!(rows
        .into_iter()
        .map(|row| json!({
            "name": row.try_get::<String, _>("column_name").unwrap_or_default(),
            "dataType": row.try_get::<String, _>("data_type").unwrap_or_default(),
            "nullable": row.try_get::<String, _>("is_nullable").is_ok_and(|value| value == "YES"),
            "defaultValue": row.try_get::<Option<String>, _>("column_default").ok().flatten(),
            "isPrimaryKey": row.try_get::<bool, _>("is_primary_key").unwrap_or(false)
        }))
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = postgres_pool(state, &args)?;
    let sql = string_arg(&args, 2)?;
    tokio::time::timeout(QUERY_TIMEOUT, async {
        if is_write_statement(&sql) && !has_returning_clause(&sql) {
            let result = pool
                .execute(sql.as_str())
                .await
                .map_err(|error| DbTunnelError::PostgresQuery(error).user_message())?;
            return Ok(json!({
                "columns": [],
                "rows": [],
                "rowCount": result.rows_affected()
            }));
        }
        let rows = fetch_pg_rows_limited(&pool, &sql).await?;
        Ok(rows_to_json_pg(rows))
    })
    .await
    .map_err(|_| DbTunnelError::QueryTimeout.user_message())?
}

pub(crate) async fn postgres_update_cell(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let pool = postgres_pool(state, &args)?;
    let schema = string_arg(&args, 2)?;
    let table = string_arg(&args, 3)?;
    let column = string_arg(&args, 4)?;
    let new_value = args.get(5).cloned().unwrap_or(Value::Null);
    let pk_columns = args
        .get(6)
        .and_then(Value::as_array)
        .ok_or_else(|| "PostgreSQL 主键列参数无效。".to_string())?;
    let pk_values = args
        .get(7)
        .and_then(Value::as_array)
        .ok_or_else(|| "PostgreSQL 主键值参数无效。".to_string())?;

    if pk_columns.is_empty() || pk_columns.len() != pk_values.len() {
        return Err("PostgreSQL 主键条件不完整，无法更新单元格。".to_string());
    }

    let where_clause = pk_columns
        .iter()
        .zip(pk_values.iter())
        .map(|(pk_column, pk_value)| {
            let pk_column = pk_column
                .as_str()
                .ok_or_else(|| "PostgreSQL 主键列参数无效。".to_string())?;
            Ok(format!(
                "{} IS NOT DISTINCT FROM {}",
                pg_identifier(pk_column),
                pg_value_literal(pk_value)
            ))
        })
        .collect::<Result<Vec<_>, String>>()?
        .join(" AND ");
    let sql = format!(
        "UPDATE {}.{} SET {} = {} WHERE {}",
        pg_identifier(&schema),
        pg_identifier(&table),
        pg_identifier(&column),
        pg_value_literal(&new_value),
        where_clause
    );
    let result = timeout_result(QUERY_TIMEOUT, sqlx::query(&sql).execute(&pool), |error| {
        DbTunnelError::PostgresQuery(error).user_message()
    })
    .await?;
    Ok(json!({ "affectedRows": result.rows_affected() }))
}

async fn connect_postgres_direct(
    config: &PostgresConnectConfig,
    host: &str,
    port: u16,
) -> Result<PgPool, String> {
    let dsn = format!(
        "postgres://{}:{}@{}:{}/{}",
        percent_encode(&config.user),
        percent_encode(&config.password),
        host,
        port,
        percent_encode(&config.database)
    );
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&dsn)
        .await
        .map_err(|error| DbTunnelError::PostgresConnect(error).user_message())?;
    if let Err(error) = timeout_result(
        METADATA_TIMEOUT,
        sqlx::query("SELECT 1").execute(&pool),
        |error| DbTunnelError::PostgresQuery(error).user_message(),
    )
    .await
    {
        pool.close().await;
        return Err(error);
    }
    Ok(pool)
}

fn postgres_pool(state: &AppState, args: &[Value]) -> Result<PgPool, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let guard = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?;
    let session = guard
        .get(&session_key("postgres", &connection_id, &session_id))
        .ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    match session {
        DatabaseTunnelSession::Postgres(session) => Ok(session.pool.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "postgres",
            actual: other.kind(),
        }
        .user_message()),
    }
}
