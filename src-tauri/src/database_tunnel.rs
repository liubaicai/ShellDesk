use crate::{
    error_string, get_connection, now, random_id,
    ssh_tunnel::{
        config_from_connection, create_tunnel, SshTunnel, SshTunnelConfig, SshTunnelError,
    },
    string_arg, AppState, ConnectionKind,
};
use fred::{
    prelude::{Client as RedisClient, ClientLike, Config as RedisConfig, Value as RedisValue},
    types::{ClusterHash, CustomCommand},
};
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, Document},
    options::ClientOptions as MongoClientOptions,
    Client as MongoClient,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{
    mysql::{MySqlPoolOptions, MySqlRow},
    postgres::{PgPoolOptions, PgRow},
    Column, Executor, MySqlPool, PgPool, Row, TypeInfo,
};
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum DbTunnelError {
    #[error("{0}")]
    InvalidConfig(String),
    #[error(transparent)]
    Tunnel(#[from] SshTunnelError),
    #[error("MySQL 连接失败：{0}")]
    MysqlConnect(#[source] sqlx::Error),
    #[error("MySQL 查询失败：{0}")]
    MysqlQuery(#[source] sqlx::Error),
    #[error("PostgreSQL 连接失败：{0}")]
    PostgresConnect(#[source] sqlx::Error),
    #[error("PostgreSQL 查询失败：{0}")]
    PostgresQuery(#[source] sqlx::Error),
    #[error("ClickHouse 连接失败：{0}")]
    ClickHouseConnect(String),
    #[error("ClickHouse 查询失败：{0}")]
    ClickHouseQuery(String),
    #[error("MongoDB 连接失败：{0}")]
    MongoConnect(String),
    #[error("MongoDB 查询失败：{0}")]
    MongoQuery(String),
    #[error("Redis 连接失败：{0}")]
    RedisConnect(String),
    #[error("Redis 命令失败：{0}")]
    RedisCommand(String),
    #[error("数据库连接已断开。")]
    SessionNotFound,
    #[error("会话类型不匹配，期望 {expected}，实际 {actual}。")]
    SessionKindMismatch {
        expected: &'static str,
        actual: &'static str,
    },
}

impl DbTunnelError {
    pub(crate) fn user_message(&self) -> String {
        self.to_string()
    }
}

pub(crate) enum DatabaseTunnelSession {
    Mysql(MysqlTunnelSession),
    Postgres(PostgresTunnelSession),
    Redis(RedisTunnelSession),
    ClickHouse(ClickHouseTunnelSession),
    Mongo(MongoTunnelSession),
}

impl DatabaseTunnelSession {
    fn kind(&self) -> &'static str {
        match self {
            Self::Mysql(_) => "mysql",
            Self::Postgres(_) => "postgres",
            Self::Redis(_) => "redis",
            Self::ClickHouse(_) => "clickhouse",
            Self::Mongo(_) => "mongo",
        }
    }

    async fn shutdown(self) {
        match self {
            Self::Mysql(session) => session.shutdown().await,
            Self::Postgres(session) => session.shutdown().await,
            Self::Redis(session) => session.shutdown().await,
            Self::ClickHouse(session) => session.shutdown().await,
            Self::Mongo(session) => session.shutdown().await,
        }
    }
}

pub(crate) struct MysqlTunnelSession {
    tunnel: Option<SshTunnel>,
    pool: MySqlPool,
}

pub(crate) struct PostgresTunnelSession {
    tunnel: Option<SshTunnel>,
    pool: PgPool,
}

pub(crate) struct RedisTunnelSession {
    tunnel: Option<SshTunnel>,
    client: RedisClient,
}

pub(crate) struct ClickHouseTunnelSession {
    tunnel: Option<SshTunnel>,
    client: clickhouse::Client,
}

pub(crate) struct MongoTunnelSession {
    tunnel: Option<SshTunnel>,
    client: MongoClient,
}

impl MysqlTunnelSession {
    async fn shutdown(self) {
        self.pool.close().await;
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

impl PostgresTunnelSession {
    async fn shutdown(self) {
        self.pool.close().await;
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

impl RedisTunnelSession {
    async fn shutdown(self) {
        let _ = self.client.quit().await;
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

impl ClickHouseTunnelSession {
    async fn shutdown(self) {
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

impl MongoTunnelSession {
    async fn shutdown(self) {
        self.client.shutdown().await;
        if let Some(tunnel) = self.tunnel {
            let _ = tunnel.shutdown().await;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TunnelOptions {
    pub(crate) remote_host: String,
    pub(crate) remote_port: u16,
    #[serde(default)]
    pub(crate) connect_timeout_ms: Option<u64>,
    #[serde(default)]
    pub(crate) ssh_host: Option<String>,
    #[serde(default)]
    pub(crate) ssh_port: Option<u16>,
    #[serde(default)]
    pub(crate) ssh_user: Option<String>,
    #[serde(default)]
    pub(crate) ssh_password: Option<String>,
    #[serde(default)]
    pub(crate) ssh_key_path: Option<String>,
    #[serde(default)]
    pub(crate) ssh_key_passphrase: Option<String>,
    #[serde(default)]
    pub(crate) known_hosts_path: Option<String>,
}

impl TunnelOptions {
    fn for_database_endpoint(remote_host: String, remote_port: u16) -> Self {
        Self {
            remote_host,
            remote_port,
            connect_timeout_ms: None,
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_password: None,
            ssh_key_path: None,
            ssh_key_passphrase: None,
            known_hosts_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MysqlConnectConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_mysql_port")]
    port: u16,
    #[serde(default = "default_mysql_user")]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    tunnel: Option<TunnelOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PostgresConnectConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_pg_port")]
    port: u16,
    #[serde(default = "default_pg_user")]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default = "default_pg_database")]
    database: String,
    #[serde(default)]
    tunnel: Option<TunnelOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RedisConnectConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_redis_port")]
    port: u16,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: u8,
    #[serde(default)]
    tunnel: Option<TunnelOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickHouseConnectConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default = "default_clickhouse_user")]
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: String,
    #[serde(default)]
    secure: bool,
    #[serde(default)]
    tunnel: Option<TunnelOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MongoConnectConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default = "default_host")]
    host: String,
    #[serde(default = "default_mongo_port")]
    port: u16,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default = "default_mongo_auth_source")]
    auth_source: String,
    #[serde(default)]
    tunnel: Option<TunnelOptions>,
}

fn default_mode() -> String {
    "cli".to_string()
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

fn default_mysql_port() -> u16 {
    3306
}

fn default_mysql_user() -> String {
    "root".to_string()
}

fn default_pg_port() -> u16 {
    5432
}

fn default_pg_user() -> String {
    "postgres".to_string()
}

fn default_pg_database() -> String {
    "postgres".to_string()
}

fn default_redis_port() -> u16 {
    6379
}

fn default_clickhouse_user() -> String {
    "default".to_string()
}

fn default_mongo_port() -> u16 {
    27017
}

fn default_mongo_auth_source() -> String {
    "admin".to_string()
}

fn session_key(kind: &str, connection_id: &str, session_id: &str) -> String {
    format!("{kind}:{connection_id}:{session_id}")
}

pub(crate) fn is_tunnel_mode(config: &Value) -> bool {
    config
        .get("mode")
        .and_then(Value::as_str)
        .is_some_and(|mode| mode.eq_ignore_ascii_case("tunnel"))
}

pub(crate) fn has_session(state: &AppState, kind: &str, args: &[Value]) -> Result<bool, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let key = session_key(kind, &connection_id, &session_id);
    Ok(state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .contains_key(&key))
}

pub(crate) async fn disconnect(
    state: &AppState,
    args: Vec<Value>,
    kind: &'static str,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let session_id = string_arg(&args, 1)?;
    let key = session_key(kind, &connection_id, &session_id);
    let session = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .remove(&key);
    if let Some(session) = session {
        tokio::spawn(async move {
            session.shutdown().await;
        });
    }
    Ok(json!(true))
}

pub(crate) async fn mysql_connect(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
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
        let tunnel_config = tunnel_config_from_options(state, &connection_id, &tunnel_options)?;
        let tunnel = create_tunnel(tunnel_config)
            .await
            .map_err(|error| error.user_message())?;
        let local_addr = tunnel.local_addr();
        match connect_mysql_direct(&config, &local_addr.ip().to_string(), local_addr.port()).await {
            Ok(pool) => (pool, Some(tunnel), "ssh-tunnel"),
            Err(error) => {
                let _ = tunnel.shutdown().await;
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
            DatabaseTunnelSession::Mysql(MysqlTunnelSession { tunnel, pool }),
        );
    Ok(json!({
        "mysqlId": mysql_id,
        "transport": transport,
        "alreadyConnected": false
    }))
}

pub(crate) async fn mysql_databases(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = mysql_pool(state, &args)?;
    let rows = sqlx::query("SHOW DATABASES")
        .fetch_all(&pool)
        .await
        .map_err(|error| DbTunnelError::MysqlQuery(error).user_message())?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>(0).ok())
        .collect::<Vec<_>>()))
}

pub(crate) async fn mysql_tables(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = mysql_pool(state, &args)?;
    let database = string_arg(&args, 2)?;
    let sql = format!("SHOW TABLES FROM {}", mysql_identifier(&database));
    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
        .await
        .map_err(|error| DbTunnelError::MysqlQuery(error).user_message())?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>(0).ok())
        .collect::<Vec<_>>()))
}

pub(crate) async fn mysql_columns(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = mysql_pool(state, &args)?;
    let database = string_arg(&args, 2)?;
    let table = string_arg(&args, 3)?;
    let rows = sqlx::query(
        "SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_KEY,COLUMN_DEFAULT,EXTRA,COLUMN_COMMENT \
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
    )
    .bind(database)
    .bind(table)
    .fetch_all(&pool)
    .await
    .map_err(|error| DbTunnelError::MysqlQuery(error).user_message())?;
    Ok(json!(rows
        .into_iter()
        .map(|row| json!({
            "name": row.try_get::<String, _>(0).unwrap_or_default(),
            "type": row.try_get::<String, _>(1).unwrap_or_default(),
            "nullable": row.try_get::<String, _>(2).is_ok_and(|value| value == "YES"),
            "key": row.try_get::<String, _>(3).unwrap_or_default(),
            "default": row.try_get::<Option<String>, _>(4).ok().flatten(),
            "extra": row.try_get::<String, _>(5).unwrap_or_default(),
            "comment": row.try_get::<String, _>(6).unwrap_or_default()
        }))
        .collect::<Vec<_>>()))
}

pub(crate) async fn mysql_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = mysql_pool(state, &args)?;
    let sql = string_arg(&args, 2)?;
    if is_write_statement(&sql) {
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
    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
        .await
        .map_err(|error| DbTunnelError::MysqlQuery(error).user_message())?;
    Ok(rows_to_json_mysql(rows))
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
        "UPDATE {}.{} SET {} = {} WHERE {}",
        mysql_identifier(&database),
        mysql_identifier(&table),
        mysql_identifier(&column),
        mysql_value_literal(&new_value),
        where_clause
    );
    let result = pool
        .execute(sql.as_str())
        .await
        .map_err(|error| DbTunnelError::MysqlQuery(error).user_message())?;
    Ok(json!({ "affectedRows": result.rows_affected() }))
}

pub(crate) async fn postgres_connect(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
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
        let tunnel_config = tunnel_config_from_options(state, &connection_id, &tunnel_options)?;
        let tunnel = create_tunnel(tunnel_config)
            .await
            .map_err(|error| error.user_message())?;
        let local_addr = tunnel.local_addr();
        match connect_postgres_direct(&config, &local_addr.ip().to_string(), local_addr.port())
            .await
        {
            Ok(pool) => (pool, Some(tunnel), "ssh-tunnel"),
            Err(error) => {
                let _ = tunnel.shutdown().await;
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
    let rows =
        sqlx::query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname")
            .fetch_all(&pool)
            .await
            .map_err(|error| DbTunnelError::PostgresQuery(error).user_message())?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("datname").ok())
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_schemas(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = postgres_pool(state, &args)?;
    let rows = sqlx::query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema') ORDER BY schema_name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|error| DbTunnelError::PostgresQuery(error).user_message())?;
    Ok(json!(rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("schema_name").ok())
        .collect::<Vec<_>>()))
}

pub(crate) async fn postgres_tables(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let pool = postgres_pool(state, &args)?;
    let schema = string_arg(&args, 2)?;
    let rows = sqlx::query(
        "SELECT table_schema, table_name, table_type FROM information_schema.tables \
         WHERE table_schema = $1 ORDER BY table_name",
    )
    .bind(schema)
    .fetch_all(&pool)
    .await
    .map_err(|error| DbTunnelError::PostgresQuery(error).user_message())?;
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
    let rows = sqlx::query(
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
    .fetch_all(&pool)
    .await
    .map_err(|error| DbTunnelError::PostgresQuery(error).user_message())?;
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
    if is_write_statement(&sql) {
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
    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
        .await
        .map_err(|error| DbTunnelError::PostgresQuery(error).user_message())?;
    Ok(rows_to_json_pg(rows))
}

pub(crate) async fn redis_connect(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config_value = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let config: RedisConnectConfig = serde_json::from_value(config_value)
        .map_err(|error| format!("Redis 隧道配置无效：{error}"))?;
    let tunnel_options = config
        .tunnel
        .clone()
        .unwrap_or_else(|| TunnelOptions::for_database_endpoint(config.host.clone(), config.port));
    validate_database_endpoint(&tunnel_options.remote_host, tunnel_options.remote_port)?;

    let connection = get_connection(state, &connection_id)?;
    let (client, tunnel, transport) = if connection.kind == ConnectionKind::Local {
        (
            connect_redis_direct(
                &config,
                &tunnel_options.remote_host,
                tunnel_options.remote_port,
            )
            .await?,
            None,
            "direct",
        )
    } else {
        let tunnel_config = tunnel_config_from_options(state, &connection_id, &tunnel_options)?;
        let tunnel = create_tunnel(tunnel_config)
            .await
            .map_err(|error| error.user_message())?;
        let local_addr = tunnel.local_addr();
        match connect_redis_direct(&config, &local_addr.ip().to_string(), local_addr.port()).await {
            Ok(client) => (client, Some(tunnel), "ssh-tunnel"),
            Err(error) => {
                let _ = tunnel.shutdown().await;
                return Err(error);
            }
        }
    };

    let redis_id = random_id("redis-tunnel");
    state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .insert(
            session_key("redis", &connection_id, &redis_id),
            DatabaseTunnelSession::Redis(RedisTunnelSession { tunnel, client }),
        );
    Ok(json!({
        "redisId": redis_id,
        "transport": transport,
        "alreadyConnected": false
    }))
}

pub(crate) async fn clickhouse_connect(
    state: &AppState,
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
        let tunnel_config = tunnel_config_from_options(state, &connection_id, &tunnel_options)?;
        let tunnel = create_tunnel(tunnel_config)
            .await
            .map_err(|error| error.user_message())?;
        let local_addr = tunnel.local_addr();
        match connect_clickhouse_direct(&config, &local_addr.ip().to_string(), local_addr.port())
            .await
        {
            Ok(client) => (client, Some(tunnel), "ssh-tunnel"),
            Err(error) => {
                let _ = tunnel.shutdown().await;
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
            DatabaseTunnelSession::ClickHouse(ClickHouseTunnelSession { tunnel, client }),
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
    let result = clickhouse_query_sql(state, &args, &sql, None).await?;
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
    let result = clickhouse_query_sql(state, &args, &sql, None).await?;
    Ok(result.get("rows").cloned().unwrap_or_else(|| json!([])))
}

pub(crate) async fn clickhouse_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let sql = string_arg(&args, 2)?;
    let database = args.get(3).and_then(Value::as_str);
    clickhouse_query_sql(state, &args, &sql, database).await
}

pub(crate) async fn mongo_connect(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config_value = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let config: MongoConnectConfig = serde_json::from_value(config_value)
        .map_err(|error| format!("MongoDB 隧道配置无效：{error}"))?;
    let tunnel_options = config
        .tunnel
        .clone()
        .unwrap_or_else(|| TunnelOptions::for_database_endpoint(config.host.clone(), config.port));
    validate_database_endpoint(&tunnel_options.remote_host, tunnel_options.remote_port)?;

    let connection = get_connection(state, &connection_id)?;
    let (client, tunnel, transport) = if connection.kind == ConnectionKind::Local {
        (
            connect_mongo_direct(
                &config,
                &tunnel_options.remote_host,
                tunnel_options.remote_port,
            )
            .await?,
            None,
            "direct",
        )
    } else {
        let tunnel_config = tunnel_config_from_options(state, &connection_id, &tunnel_options)?;
        let tunnel = create_tunnel(tunnel_config)
            .await
            .map_err(|error| error.user_message())?;
        let local_addr = tunnel.local_addr();
        match connect_mongo_direct(&config, &local_addr.ip().to_string(), local_addr.port()).await {
            Ok(client) => (client, Some(tunnel), "ssh-tunnel"),
            Err(error) => {
                let _ = tunnel.shutdown().await;
                return Err(error);
            }
        }
    };

    let mongo_id = random_id("mongo-tunnel");
    state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?
        .insert(
            session_key("mongo", &connection_id, &mongo_id),
            DatabaseTunnelSession::Mongo(MongoTunnelSession { tunnel, client }),
        );
    Ok(json!({
        "mongoId": mongo_id,
        "transport": transport,
        "alreadyConnected": false
    }))
}

pub(crate) async fn mongo_databases(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let client = mongo_client(state, &args)?;
    let databases = client
        .list_databases()
        .await
        .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?;
    let mut rows = databases
        .into_iter()
        .map(|database| {
            json!({
                "name": database.name,
                "sizeOnDisk": database.size_on_disk,
                "empty": database.empty
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(right.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!(rows))
}

pub(crate) async fn mongo_collections(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let client = mongo_client(state, &args)?;
    let database = string_arg(&args, 2)?;
    let mut cursor = client
        .database(&database)
        .list_collections()
        .await
        .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?;
    let mut rows = Vec::new();
    while let Some(collection) = cursor
        .try_next()
        .await
        .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?
    {
        let collection_type = serde_json::to_value(collection.collection_type)
            .ok()
            .and_then(|value| value.as_str().map(ToString::to_string))
            .unwrap_or_else(|| "collection".to_string());
        rows.push(json!({ "name": collection.name, "type": collection_type }));
    }
    rows.sort_by(|left, right| {
        left.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(right.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!(rows))
}

pub(crate) async fn mongo_indexes(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let client = mongo_client(state, &args)?;
    let database = string_arg(&args, 2)?;
    let collection = string_arg(&args, 3)?;
    let collection = client
        .database(&database)
        .collection::<Document>(&collection);
    let mut cursor = collection
        .list_indexes()
        .await
        .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?;
    let mut indexes = Vec::new();
    while let Some(index) = cursor
        .try_next()
        .await
        .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?
    {
        let options = index.options.unwrap_or_default();
        indexes.push(json!({
            "name": options.name.unwrap_or_default(),
            "key": bson_to_json(Bson::Document(index.keys)),
            "unique": options.unique.unwrap_or(false),
            "sparse": options.sparse.unwrap_or(false),
            "expireAfterSeconds": options.expire_after.map(|duration| duration.as_secs())
        }));
    }
    Ok(json!(indexes))
}

pub(crate) async fn mongo_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let client = mongo_client(state, &args)?;
    let request = args.get(2).cloned().unwrap_or_else(|| json!({}));
    let database = request
        .get("database")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let collection = request
        .get("collection")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if database.trim().is_empty() || collection.trim().is_empty() {
        return Err("MongoDB 数据库和集合不能为空。".to_string());
    }
    let filter = mongo_document_from_request(&request, "filter", "{}")?;
    let projection = mongo_document_option_from_request(&request, "projection")?;
    let sort = mongo_document_option_from_request(&request, "sort")?;
    let limit = request
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(100)
        .clamp(1, 1000);
    let collection = client
        .database(&database)
        .collection::<Document>(&collection);
    let mut find = collection.find(filter).limit(limit as i64);
    if let Some(projection) = projection {
        find = find.projection(projection);
    }
    if let Some(sort) = sort {
        find = find.sort(sort);
    }
    let mut cursor = find
        .await
        .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?;
    let mut documents = Vec::new();
    while let Some(document) = cursor
        .try_next()
        .await
        .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?
    {
        documents.push(bson_to_json(Bson::Document(document)));
    }
    Ok(json!({
        "documents": documents,
        "count": documents.len(),
        "limit": limit
    }))
}

pub(crate) async fn redis_scan(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let options = args.get(2).cloned().unwrap_or_else(|| json!({}));
    let cursor = options
        .get("cursor")
        .and_then(Value::as_str)
        .unwrap_or("0")
        .to_string();
    let pattern = options
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or("*")
        .to_string();
    let count = options.get("count").and_then(Value::as_u64).unwrap_or(100);
    let response = redis_command_values(
        state,
        &args,
        "SCAN",
        vec![
            cursor.clone(),
            "MATCH".to_string(),
            pattern.clone(),
            "COUNT".to_string(),
            count.to_string(),
        ],
    )
    .await?;
    let (next_cursor, names) = redis_scan_result(response);
    let mut keys = Vec::new();
    for key in names {
        keys.push(redis_key_summary(state, &args, &key).await?);
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
    let pattern = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or("*")
        .to_string();
    let response = redis_command_values(state, &args, "KEYS", vec![pattern]).await?;
    let mut keys = Vec::new();
    for key in redis_string_list(response) {
        keys.push(redis_key_summary(state, &args, &key).await?);
    }
    Ok(json!(keys))
}

pub(crate) async fn redis_get_value(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let key = string_arg(&args, 2)?;
    let redis_type =
        redis_string(redis_command_values(state, &args, "TYPE", vec![key.clone()]).await?)
            .unwrap_or_else(|| "none".to_string());
    if redis_type == "none" {
        return Err(format!("键 \"{key}\" 不存在。"));
    }
    let ttl = redis_i64(redis_command_values(state, &args, "TTL", vec![key.clone()]).await?)
        .unwrap_or(-1);
    let value = match redis_type.as_str() {
        "hash" => redis_pairs_to_object(
            redis_command_values(state, &args, "HGETALL", vec![key.clone()]).await?,
        ),
        "list" => json!(redis_string_list(
            redis_command_values(
                state,
                &args,
                "LRANGE",
                vec![key.clone(), "0".to_string(), "199".to_string()],
            )
            .await?,
        )),
        "set" => json!(redis_string_list(
            redis_command_values(state, &args, "SMEMBERS", vec![key.clone()]).await?,
        )),
        "zset" => redis_zset_items(
            redis_command_values(
                state,
                &args,
                "ZRANGE",
                vec![
                    key.clone(),
                    "0".to_string(),
                    "199".to_string(),
                    "WITHSCORES".to_string(),
                ],
            )
            .await?,
        ),
        "stream" => json!(redis_value_to_json(
            redis_command_values(
                state,
                &args,
                "XRANGE",
                vec![
                    key.clone(),
                    "-".to_string(),
                    "+".to_string(),
                    "COUNT".to_string(),
                    "100".to_string()
                ],
            )
            .await?,
        )),
        _ => {
            redis_value_to_json(redis_command_values(state, &args, "GET", vec![key.clone()]).await?)
        }
    };
    let size = redis_size(state, &args, &redis_type, &key)
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
    let key = string_arg(&args, 2)?;
    let value = args.get(3).cloned().unwrap_or(Value::Null);
    let value_type = string_arg(&args, 4)?;
    let ttl_ms = redis_i64(redis_command_values(state, &args, "PTTL", vec![key.clone()]).await?)
        .unwrap_or(-1);
    let commands = redis_set_value_commands(&key, &value, &value_type, ttl_ms)?;
    for command in commands {
        let (name, values) = command
            .split_first()
            .ok_or_else(|| "Redis 命令不能为空。".to_string())?;
        let _ = redis_command_values(state, &args, name, values.to_vec()).await?;
    }
    Ok(json!(true))
}

pub(crate) async fn redis_delete_key(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let key = string_arg(&args, 2)?;
    let _ = redis_command_values(state, &args, "DEL", vec![key]).await?;
    Ok(json!(true))
}

pub(crate) async fn redis_command(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let command = string_arg(&args, 2)?;
    let values = args
        .get(3)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|value| json_to_redis_arg(&value))
        .collect::<Vec<_>>();
    let response = redis_command_values(state, &args, &command, values).await?;
    Ok(redis_value_to_json(response))
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
        .acquire_timeout(Duration::from_secs(10))
        .connect(&dsn)
        .await
        .map_err(|error| DbTunnelError::MysqlConnect(error).user_message())?;
    if let Err(error) = sqlx::query("SELECT 1").execute(&pool).await {
        pool.close().await;
        return Err(DbTunnelError::MysqlQuery(error).user_message());
    }
    Ok(pool)
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
        .acquire_timeout(Duration::from_secs(10))
        .connect(&dsn)
        .await
        .map_err(|error| DbTunnelError::PostgresConnect(error).user_message())?;
    if let Err(error) = sqlx::query("SELECT 1").execute(&pool).await {
        pool.close().await;
        return Err(DbTunnelError::PostgresQuery(error).user_message());
    }
    Ok(pool)
}

async fn connect_redis_direct(
    config: &RedisConnectConfig,
    host: &str,
    port: u16,
) -> Result<RedisClient, String> {
    let redis_url = if config.password.is_empty() {
        format!("redis://{}:{}/{}", host, port, config.database)
    } else {
        format!(
            "redis://:{}@{}:{}/{}",
            percent_encode(&config.password),
            host,
            port,
            config.database
        )
    };
    let redis_config =
        RedisConfig::from_url(&redis_url).map_err(|error| format!("Redis URL 无效：{error}"))?;
    let client = RedisClient::new(redis_config, None, None, None);
    client.connect();
    if let Err(error) = client.wait_for_connect().await {
        return Err(DbTunnelError::RedisConnect(error.to_string()).user_message());
    }
    let ping: Result<RedisValue, _> = client
        .custom(
            CustomCommand::new_static("PING", ClusterHash::FirstKey, false),
            Vec::<String>::new(),
        )
        .await;
    if let Err(error) = ping {
        let _ = client.quit().await;
        return Err(DbTunnelError::RedisConnect(error.to_string()).user_message());
    }
    Ok(client)
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
    if let Err(error) = cursor.collect().await {
        return Err(DbTunnelError::ClickHouseConnect(error.to_string()).user_message());
    }
    Ok(client)
}

async fn connect_mongo_direct(
    config: &MongoConnectConfig,
    host: &str,
    port: u16,
) -> Result<MongoClient, String> {
    let uri = if config.username.trim().is_empty() {
        format!("mongodb://{}:{}", host, port)
    } else {
        format!(
            "mongodb://{}:{}@{}:{}/?authSource={}",
            percent_encode(&config.username),
            percent_encode(&config.password),
            host,
            port,
            percent_encode(&config.auth_source)
        )
    };
    let options = MongoClientOptions::parse(&uri)
        .await
        .map_err(|error| DbTunnelError::MongoConnect(error.to_string()).user_message())?;
    let client = MongoClient::with_options(options)
        .map_err(|error| DbTunnelError::MongoConnect(error.to_string()).user_message())?;
    client
        .database(&config.auth_source)
        .run_command(doc! { "ping": 1 })
        .await
        .map_err(|error| DbTunnelError::MongoConnect(error.to_string()).user_message())?;
    Ok(client)
}

fn clickhouse_port(config: &ClickHouseConnectConfig) -> u16 {
    config
        .port
        .unwrap_or(if config.secure { 8443 } else { 8123 })
}

fn mysql_pool(state: &AppState, args: &[Value]) -> Result<MySqlPool, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let guard = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?;
    let session = guard
        .get(&session_key("mysql", &connection_id, &session_id))
        .ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    match session {
        DatabaseTunnelSession::Mysql(session) => Ok(session.pool.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "mysql",
            actual: other.kind(),
        }
        .user_message()),
    }
}

fn clickhouse_client(state: &AppState, args: &[Value]) -> Result<clickhouse::Client, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let guard = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?;
    let session = guard
        .get(&session_key("clickhouse", &connection_id, &session_id))
        .ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    match session {
        DatabaseTunnelSession::ClickHouse(session) => Ok(session.client.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "clickhouse",
            actual: other.kind(),
        }
        .user_message()),
    }
}

fn mongo_client(state: &AppState, args: &[Value]) -> Result<MongoClient, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let guard = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?;
    let session = guard
        .get(&session_key("mongo", &connection_id, &session_id))
        .ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    match session {
        DatabaseTunnelSession::Mongo(session) => Ok(session.client.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "mongo",
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
) -> Result<Value, String> {
    let client = clickhouse_client(state, args)?;
    let client = if let Some(database) = database_override.filter(|database| !database.is_empty()) {
        client.with_database(database.to_string())
    } else {
        client
    };
    let mut cursor = client
        .query(sql)
        .fetch_bytes("JSON")
        .map_err(|error| DbTunnelError::ClickHouseQuery(error.to_string()).user_message())?;
    let bytes = cursor
        .collect()
        .await
        .map_err(|error| DbTunnelError::ClickHouseQuery(error.to_string()).user_message())?;
    let output = String::from_utf8_lossy(&bytes).to_string();
    Ok(parse_clickhouse_response(&output))
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

fn redis_client(state: &AppState, args: &[Value]) -> Result<RedisClient, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let guard = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?;
    let session = guard
        .get(&session_key("redis", &connection_id, &session_id))
        .ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    match session {
        DatabaseTunnelSession::Redis(session) => Ok(session.client.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "redis",
            actual: other.kind(),
        }
        .user_message()),
    }
}

async fn redis_command_values(
    state: &AppState,
    args: &[Value],
    command: &str,
    values: Vec<String>,
) -> Result<RedisValue, String> {
    let client = redis_client(state, args)?;
    client
        .custom(
            CustomCommand::new(command.to_string(), ClusterHash::FirstKey, false),
            values,
        )
        .await
        .map_err(|error| DbTunnelError::RedisCommand(error.to_string()).user_message())
}

async fn redis_key_summary(state: &AppState, args: &[Value], key: &str) -> Result<Value, String> {
    let redis_type =
        redis_string(redis_command_values(state, args, "TYPE", vec![key.to_string()]).await?)
            .unwrap_or_else(|| "none".to_string());
    let ttl = redis_i64(redis_command_values(state, args, "TTL", vec![key.to_string()]).await?)
        .unwrap_or(-1);
    let size = redis_size(state, args, &redis_type, key).await.unwrap_or(0);
    Ok(json!({ "name": key, "type": redis_type, "ttl": ttl, "size": size, "scannedAt": now() }))
}

async fn redis_size(
    state: &AppState,
    args: &[Value],
    redis_type: &str,
    key: &str,
) -> Result<i64, String> {
    let command = match redis_type {
        "string" => "STRLEN",
        "hash" => "HLEN",
        "list" => "LLEN",
        "set" => "SCARD",
        "zset" => "ZCARD",
        "stream" => "XLEN",
        _ => return Ok(0),
    };
    Ok(
        redis_i64(redis_command_values(state, args, command, vec![key.to_string()]).await?)
            .unwrap_or(0),
    )
}

fn rows_to_json_mysql(rows: Vec<MySqlRow>) -> Value {
    let columns = rows.first().map(row_column_names).unwrap_or_default();
    let rows = rows.into_iter().map(mysql_row_to_json).collect::<Vec<_>>();
    json!({ "columns": columns, "rows": rows, "affectedRows": 0 })
}

fn mysql_row_to_json(row: MySqlRow) -> Value {
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        object.insert(
            column.name().to_string(),
            mysql_value_to_json(&row, index, column.type_info().name()),
        );
    }
    Value::Object(object)
}

fn rows_to_json_pg(rows: Vec<PgRow>) -> Value {
    let columns = rows.first().map(row_column_names).unwrap_or_default();
    let row_count = rows.len();
    let rows = rows.into_iter().map(pg_row_to_json).collect::<Vec<_>>();
    json!({ "columns": columns, "rows": rows, "rowCount": row_count })
}

fn pg_row_to_json(row: PgRow) -> Value {
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        object.insert(
            column.name().to_string(),
            pg_value_to_json(&row, index, column.type_info().name()),
        );
    }
    Value::Object(object)
}

fn row_column_names<R>(row: &R) -> Vec<String>
where
    R: Row,
{
    row.columns()
        .iter()
        .map(|column| column.name().to_string())
        .collect()
}

fn mysql_value_to_json(row: &MySqlRow, index: usize, type_name: &str) -> Value {
    if let Ok(value) = row.try_get::<Option<i64>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(value) = row.try_get::<Option<f64>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(value) = row.try_get::<Option<bool>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(value) = row.try_get::<Option<String>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    json!(format!("<unsupported:{type_name}>"))
}

fn pg_value_to_json(row: &PgRow, index: usize, type_name: &str) -> Value {
    if let Ok(value) = row.try_get::<Option<i64>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(value) = row.try_get::<Option<f64>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(value) = row.try_get::<Option<bool>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    if let Ok(value) = row.try_get::<Option<String>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value));
    }
    json!(format!("<unsupported:{type_name}>"))
}

fn tunnel_config_from_options(
    state: &AppState,
    connection_id: &str,
    options: &TunnelOptions,
) -> Result<SshTunnelConfig, String> {
    let overrides = json!({
        "connectTimeoutMs": options.connect_timeout_ms.unwrap_or(15_000),
        "sshHost": options.ssh_host.as_deref().unwrap_or(""),
        "sshPort": options.ssh_port.unwrap_or(22),
        "sshUser": options.ssh_user.as_deref().unwrap_or(""),
        "sshPassword": options
            .ssh_key_passphrase
            .as_deref()
            .or(options.ssh_password.as_deref())
            .unwrap_or(""),
        "sshKeyPath": options.ssh_key_path.as_deref().unwrap_or(""),
        "knownHostsPath": options.known_hosts_path.as_deref().unwrap_or("")
    });
    config_from_connection(
        state,
        connection_id,
        &options.remote_host,
        options.remote_port,
        Some(&overrides),
    )
}

fn validate_database_endpoint(host: &str, port: u16) -> Result<(), String> {
    if host.trim().is_empty() {
        return Err("数据库主机不能为空。".to_string());
    }
    if port == 0 {
        return Err("数据库端口必须在 1-65535 范围内。".to_string());
    }
    Ok(())
}

fn mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn mysql_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
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
        Value::String(value) => mysql_string_literal(value),
        other => mysql_string_literal(&other.to_string()),
    }
}

fn is_write_statement(sql: &str) -> bool {
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
        "insert"
            | "update"
            | "delete"
            | "replace"
            | "truncate"
            | "create"
            | "alter"
            | "drop"
            | "grant"
            | "revoke"
    )
}

fn redis_value_to_json(value: RedisValue) -> Value {
    match value {
        RedisValue::Null => Value::Null,
        RedisValue::Boolean(value) => json!(value),
        RedisValue::Integer(value) => json!(value),
        RedisValue::Double(value) => json!(value),
        RedisValue::String(value) => json!(value.to_string()),
        RedisValue::Bytes(value) => json!(String::from_utf8_lossy(&value).to_string()),
        RedisValue::Array(values) => {
            Value::Array(values.into_iter().map(redis_value_to_json).collect())
        }
        RedisValue::Map(values) => {
            let mut object = Map::new();
            for (key, value) in values.inner().into_iter() {
                object.insert(key.as_str_lossy().to_string(), redis_value_to_json(value));
            }
            Value::Object(object)
        }
        RedisValue::Queued => json!("QUEUED"),
    }
}

fn redis_string(value: RedisValue) -> Option<String> {
    match value {
        RedisValue::String(value) => Some(value.to_string()),
        RedisValue::Bytes(value) => Some(String::from_utf8_lossy(&value).to_string()),
        RedisValue::Integer(value) => Some(value.to_string()),
        RedisValue::Double(value) => Some(value.to_string()),
        RedisValue::Boolean(value) => Some(value.to_string()),
        _ => None,
    }
}

fn redis_i64(value: RedisValue) -> Option<i64> {
    match value {
        RedisValue::Integer(value) => Some(value),
        RedisValue::String(value) => value.parse().ok(),
        RedisValue::Bytes(value) => String::from_utf8_lossy(&value).parse().ok(),
        _ => None,
    }
}

fn redis_string_list(value: RedisValue) -> Vec<String> {
    match value {
        RedisValue::Array(values) => values.into_iter().filter_map(redis_string).collect(),
        other => redis_string(other).into_iter().collect(),
    }
}

fn redis_scan_result(value: RedisValue) -> (String, Vec<String>) {
    let RedisValue::Array(values) = value else {
        return ("0".to_string(), Vec::new());
    };
    let mut values = values.into_iter();
    let cursor = values
        .next()
        .and_then(redis_string)
        .unwrap_or_else(|| "0".to_string());
    let keys = values.next().map(redis_string_list).unwrap_or_default();
    (cursor, keys)
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

fn clickhouse_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn mongo_document_from_request(
    request: &Value,
    field: &str,
    fallback_json: &str,
) -> Result<Document, String> {
    let raw = request
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_json);
    let value = serde_json::from_str::<Value>(raw)
        .map_err(|error| format!("MongoDB {field} JSON 无效：{error}"))?;
    let bson = Bson::try_from(value)
        .map_err(|error| format!("MongoDB {field} Extended JSON 无效：{error}"))?;
    match bson {
        Bson::Document(document) => Ok(document),
        _ => Err(format!("MongoDB {field} 必须是 JSON 对象。")),
    }
}

fn mongo_document_option_from_request(
    request: &Value,
    field: &str,
) -> Result<Option<Document>, String> {
    let Some(raw) = request.get(field).and_then(Value::as_str).map(str::trim) else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    mongo_document_from_request(request, field, "{}").map(Some)
}

fn bson_to_json(value: Bson) -> Value {
    value.into_relaxed_extjson()
}

fn redis_pairs_to_object(value: RedisValue) -> Value {
    let items = redis_string_list(value);
    let mut object = Map::new();
    for pair in items.chunks(2) {
        if let Some(key) = pair.first() {
            object.insert(key.clone(), json!(pair.get(1).cloned().unwrap_or_default()));
        }
    }
    Value::Object(object)
}

fn redis_zset_items(value: RedisValue) -> Value {
    let items = redis_string_list(value);
    let rows = items
        .chunks(2)
        .map(|pair| {
            json!({
                "value": pair.first().cloned().unwrap_or_default(),
                "score": pair.get(1).and_then(|value| value.parse::<f64>().ok()).unwrap_or(0.0)
            })
        })
        .collect::<Vec<_>>();
    json!(rows)
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
            json_to_redis_arg(value),
        ]),
        "hash" => {
            let Some(object) = value.as_object() else {
                return Err("Hash 值必须是 JSON 对象。".to_string());
            };
            if !object.is_empty() {
                let mut command = vec!["HSET".to_string(), key.to_string()];
                for (field, field_value) in object {
                    command.push(field.clone());
                    command.push(json_to_redis_arg(field_value));
                }
                commands.push(command);
            }
        }
        "list" => {
            let Some(items) = value.as_array() else {
                return Err("List 值必须是 JSON 数组。".to_string());
            };
            if !items.is_empty() {
                let mut command = vec!["RPUSH".to_string(), key.to_string()];
                command.extend(items.iter().map(json_to_redis_arg));
                commands.push(command);
            }
        }
        "set" => {
            let Some(items) = value.as_array() else {
                return Err("Set 值必须是 JSON 数组。".to_string());
            };
            if !items.is_empty() {
                let mut command = vec!["SADD".to_string(), key.to_string()];
                command.extend(items.iter().map(json_to_redis_arg));
                commands.push(command);
            }
        }
        "zset" => {
            let Some(items) = value.as_array() else {
                return Err("ZSet 值必须是 JSON 数组。".to_string());
            };
            if !items.is_empty() {
                let mut command = vec!["ZADD".to_string(), key.to_string()];
                for item in items {
                    if let Some(object) = item.as_object() {
                        let member = object
                            .get("value")
                            .or_else(|| object.get("member"))
                            .map(json_to_redis_arg)
                            .unwrap_or_default();
                        let score = object
                            .get("score")
                            .map(json_to_redis_arg)
                            .unwrap_or_else(|| "0".to_string());
                        command.push(score);
                        command.push(member);
                    } else if let Some(pair) = item.as_array().filter(|pair| pair.len() >= 2) {
                        command.push(json_to_redis_arg(&pair[1]));
                        command.push(json_to_redis_arg(&pair[0]));
                    }
                }
                if command.len() > 2 {
                    commands.push(command);
                }
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

fn json_to_redis_arg(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn percent_encode(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_tunnel_mode_only_when_explicit() {
        assert!(is_tunnel_mode(&json!({ "mode": "tunnel" })));
        assert!(is_tunnel_mode(&json!({ "mode": "TUNNEL" })));
        assert!(!is_tunnel_mode(&json!({ "mode": "cli" })));
        assert!(!is_tunnel_mode(&json!({})));
    }

    #[test]
    fn rejects_empty_database_endpoint() {
        assert!(validate_database_endpoint("", 3306).is_err());
        assert!(validate_database_endpoint("127.0.0.1", 0).is_err());
        assert!(validate_database_endpoint("127.0.0.1", 3306).is_ok());
    }

    #[test]
    fn session_key_matches_existing_database_key_shape() {
        assert_eq!(
            session_key("mysql", "conn-1", "mysql-1"),
            "mysql:conn-1:mysql-1"
        );
    }

    #[test]
    fn parses_minimal_mysql_config() {
        let config: MysqlConnectConfig =
            serde_json::from_value(json!({ "mode": "tunnel" })).unwrap();
        assert_eq!(config.mode, "tunnel");
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 3306);
        assert_eq!(config.user, "root");
    }

    #[test]
    fn parses_minimal_postgres_config() {
        let config: PostgresConnectConfig =
            serde_json::from_value(json!({ "mode": "tunnel" })).unwrap();
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 5432);
        assert_eq!(config.user, "postgres");
        assert_eq!(config.database, "postgres");
    }

    #[test]
    fn parses_redis_defaults() {
        let config: RedisConnectConfig =
            serde_json::from_value(json!({ "mode": "tunnel" })).unwrap();
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 6379);
        assert_eq!(config.database, 0);
    }

    #[test]
    fn percent_encodes_connection_string_parts() {
        assert_eq!(percent_encode("user name:p@ss"), "user%20name%3Ap%40ss");
    }
}
