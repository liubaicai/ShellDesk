use std::{future::IntoFuture, time::Duration};

mod clickhouse;
mod config;
mod core;
mod mongo;
mod mysql;
mod postgres;
mod redis;
mod rows;

#[cfg(test)]
use clickhouse::parse_clickhouse_response;
pub(crate) use clickhouse::{
    clickhouse_columns, clickhouse_connect, clickhouse_databases, clickhouse_query,
    clickhouse_tables,
};
#[cfg(test)]
use config::{MysqlConnectConfig, PostgresConnectConfig, RedisConnectConfig};
use core::DbTunnelError;
pub(crate) use core::{
    disconnect, has_session, is_tunnel_mode, DatabaseTunnelSession, TunnelOptions,
};
#[cfg(test)]
use core::{session_key, validate_database_endpoint};
pub(crate) use mongo::{
    mongo_collections, mongo_connect, mongo_databases, mongo_indexes, mongo_query,
};
pub(crate) use mysql::{
    mysql_columns, mysql_connect, mysql_databases, mysql_query, mysql_tables, mysql_update_cell,
};
pub(crate) use postgres::{
    postgres_columns, postgres_connect, postgres_databases, postgres_query, postgres_schemas,
    postgres_tables, postgres_update_cell,
};
pub(crate) use redis::{
    redis_command, redis_connect, redis_delete_key, redis_get_value, redis_keys,
    redis_remove_list_item, redis_scan, redis_set_value,
};
#[cfg(test)]
use rows::{mysql_bytes_to_display_string, mysql_bytes_to_json, mysql_unsigned_integer_to_json};

const MAX_QUERY_ROWS: usize = 10_000;
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
const METADATA_TIMEOUT: Duration = Duration::from_secs(30);

async fn timeout_result<T, E, F, M>(
    duration: Duration,
    future: F,
    map_error: M,
) -> Result<T, String>
where
    F: IntoFuture<Output = Result<T, E>>,
    M: FnOnce(E) -> String,
{
    tokio::time::timeout(duration, future.into_future())
        .await
        .map_err(|_| DbTunnelError::QueryTimeout.user_message())?
        .map_err(map_error)
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
    use serde_json::json;

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
    fn mysql_bytes_decode_utf8_text_values() {
        assert_eq!(
            mysql_bytes_to_display_string(b"information_schema".to_vec()),
            "information_schema"
        );
        assert_eq!(mysql_bytes_to_json(b"mysql".to_vec()), json!("mysql"));
    }

    #[test]
    fn mysql_bytes_fall_back_to_hex_for_binary_values() {
        assert_eq!(
            mysql_bytes_to_display_string(vec![0xff, 0x00, 0x41]),
            "0xFF0041"
        );
    }

    #[test]
    fn mysql_unsigned_integer_values_stay_numeric() {
        assert_eq!(mysql_unsigned_integer_to_json(1), json!(1_u64));
        assert_eq!(
            mysql_unsigned_integer_to_json(u32::MAX as u64),
            json!(u32::MAX)
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
    fn parse_clickhouse_response_marks_and_limits_truncated_rows() {
        let rows = (0..=MAX_QUERY_ROWS)
            .map(|index| json!({ "value": index }))
            .collect::<Vec<_>>();
        let output = json!({
            "meta": [{ "name": "value", "type": "UInt64" }],
            "data": rows,
            "rows": MAX_QUERY_ROWS + 1
        })
        .to_string();

        let parsed = parse_clickhouse_response(&output);
        assert_eq!(parsed["truncated"], json!(true));
        assert_eq!(
            parsed["rows"].as_array().map(Vec::len),
            Some(MAX_QUERY_ROWS)
        );
        assert_eq!(parsed["rowCount"], json!(MAX_QUERY_ROWS + 1));
    }

    #[test]
    fn percent_encodes_connection_string_parts() {
        assert_eq!(percent_encode("user name:p@ss"), "user%20name%3Ap%40ss");
    }
}
