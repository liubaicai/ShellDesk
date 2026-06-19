use crate::{database, AppState};
use serde_json::Value;

pub(crate) fn is_database_channel(channel: &str) -> bool {
    channel.starts_with("connection:mysql-")
        || channel.starts_with("connection:postgres-")
        || channel.starts_with("connection:redis-")
        || channel.starts_with("connection:sqlite-")
        || channel.starts_with("connection:clickhouse-")
        || channel.starts_with("connection:mongo-")
}

pub(crate) async fn dispatch(
    state: &AppState,
    channel: &str,
    args: Vec<Value>,
) -> Option<Result<Value, String>> {
    let result = match channel {
        "connection:mysql-connect" => database::mysql_connect(state, args).await,
        "connection:mysql-disconnect" => {
            database::disconnect_db_session_any(state, args, "mysql").await
        }
        "connection:mysql-databases" => database::mysql_databases(state, args).await,
        "connection:mysql-tables" => database::mysql_tables(state, args).await,
        "connection:mysql-columns" => database::mysql_columns(state, args).await,
        "connection:mysql-query" => database::mysql_query(state, args).await,
        "connection:mysql-update-cell" => database::mysql_update_cell(state, args).await,

        "connection:postgres-connect" => database::postgres_connect(state, args).await,
        "connection:postgres-disconnect" => {
            database::disconnect_db_session_any(state, args, "postgres").await
        }
        "connection:postgres-databases" => database::postgres_databases(state, args).await,
        "connection:postgres-schemas" => database::postgres_schemas(state, args).await,
        "connection:postgres-tables" => database::postgres_tables(state, args).await,
        "connection:postgres-columns" => database::postgres_columns(state, args).await,
        "connection:postgres-query" => database::postgres_query(state, args).await,

        "connection:redis-connect" => database::redis_connect(state, args).await,
        "connection:redis-disconnect" => {
            database::disconnect_db_session_any(state, args, "redis").await
        }
        "connection:redis-scan" => database::redis_scan(state, args).await,
        "connection:redis-keys" => database::redis_keys(state, args).await,
        "connection:redis-get-value" => database::redis_get_value(state, args).await,
        "connection:redis-set-value" => database::redis_set_value(state, args).await,
        "connection:redis-delete-key" => database::redis_delete_key(state, args).await,
        "connection:redis-command" => database::redis_command(state, args).await,

        "connection:sqlite-open" => database::sqlite_open(state, args).await,
        "connection:sqlite-close" => database::disconnect_db_session(state, args, "sqlite"),
        "connection:sqlite-tables" => database::sqlite_tables(state, args).await,
        "connection:sqlite-objects" => database::sqlite_objects(state, args).await,
        "connection:sqlite-columns" => database::sqlite_columns(state, args).await,
        "connection:sqlite-schema" => database::sqlite_schema(state, args).await,
        "connection:sqlite-query" => database::sqlite_query(state, args).await,
        "connection:sqlite-update-cell" => database::sqlite_update_cell(state, args).await,

        "connection:clickhouse-connect" => database::clickhouse_connect(state, args).await,
        "connection:clickhouse-disconnect" => {
            database::disconnect_db_session_any(state, args, "clickhouse").await
        }
        "connection:clickhouse-databases" => database::clickhouse_databases(state, args).await,
        "connection:clickhouse-tables" => database::clickhouse_tables(state, args).await,
        "connection:clickhouse-columns" => database::clickhouse_columns(state, args).await,
        "connection:clickhouse-query" => database::clickhouse_query(state, args).await,

        "connection:mongo-connect" => database::mongo_connect(state, args).await,
        "connection:mongo-disconnect" => {
            database::disconnect_db_session_any(state, args, "mongo").await
        }
        "connection:mongo-databases" => database::mongo_databases(state, args).await,
        "connection:mongo-collections" => database::mongo_collections(state, args).await,
        "connection:mongo-indexes" => database::mongo_indexes(state, args).await,
        "connection:mongo-query" => database::mongo_query(state, args).await,

        _ => return None,
    };

    Some(result)
}
