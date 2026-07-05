use serde_json::Value;

mod clickhouse;
mod codec;
mod mongo;
mod mysql;
mod parse;
mod postgres;
mod redis;
mod session;
mod sql;
mod sqlite;
pub(crate) mod tunnel;

pub(crate) use clickhouse::{
    clickhouse_columns, clickhouse_connect, clickhouse_databases, clickhouse_query,
    clickhouse_tables,
};
#[cfg(test)]
use codec::{mongo_ejson_prelude, mongo_ejson_value_expression};
pub(crate) use mongo::{
    mongo_collections, mongo_connect, mongo_databases, mongo_indexes, mongo_query,
};
#[cfg(test)]
use mysql::{is_mysql_authentication_error, mysql_cli_commands, should_fallback_to_mysql_cli};
pub(crate) use mysql::{
    mysql_columns, mysql_connect, mysql_databases, mysql_query, mysql_tables, mysql_update_cell,
};
#[cfg(test)]
use parse::{
    parse_clickhouse_response, parse_mysql_write_metadata, parse_postgres_command_tag_row_count,
    parse_redis_json_command_output, parse_redis_raw_command_output, redis_cli_json_unsupported,
    redis_stream_preview, redis_zset_items,
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
use redis::{redis_set_value_commands, redis_zset_cli_args};
pub(crate) use session::disconnect_db_session;
#[cfg(test)]
use sql::clickhouse_query_with_json_format;
#[cfg(test)]
use sql::{is_mysql_write_statement, mysql_query_with_write_metadata};
pub(crate) use sqlite::{
    sqlite_columns, sqlite_objects, sqlite_open, sqlite_query, sqlite_schema, sqlite_tables,
    sqlite_update_cell,
};
#[cfg(test)]
use sqlite::{sqlite_operation_options, sqlite_options_from_arg, sqlite_use_windows_command};

use crate::{get_connection, AppState, ConnectionKind};

fn database_transport_mode(config: &Value) -> String {
    config
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase()
}

pub(super) fn should_try_database_tunnel(
    state: &AppState,
    connection_id: &str,
    config: &Value,
) -> Result<bool, String> {
    let mode = database_transport_mode(config);
    if tunnel::is_tunnel_mode(config) {
        return Ok(true);
    }
    if mode == "cli" {
        return Ok(false);
    }
    Ok(get_connection(state, connection_id)?.kind != ConnectionKind::Local)
}

pub(super) fn should_fallback_to_database_cli(config: &Value) -> bool {
    database_transport_mode(config) != "tunnel"
}

pub(crate) async fn disconnect_db_session_any(
    state: &AppState,
    args: Vec<Value>,
    kind: &'static str,
) -> Result<Value, String> {
    if tunnel::has_session(state, kind, &args)? {
        return tunnel::disconnect(state, args, kind).await;
    }
    disconnect_db_session(state, args, kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActiveConnection, ConnectionKind};
    use serde_json::json;
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
            temporary_key_paths: Vec::new(),
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
    fn mysql_authentication_errors_skip_cli_fallback() {
        let auth_error = "MySQL 连接失败：error returned from database: 1045 (28000): Access denied for user 'root'@'127.0.0.1' (using password: YES)";
        assert!(is_mysql_authentication_error(auth_error));
        assert!(!should_fallback_to_mysql_cli(
            &json!({ "mode": "auto" }),
            auth_error
        ));
        assert!(!should_fallback_to_mysql_cli(
            &json!({ "mode": "tunnel" }),
            "SSH 隧道连接超时。"
        ));
        assert!(should_fallback_to_mysql_cli(
            &json!({ "mode": "auto" }),
            "SSH 隧道连接超时。"
        ));
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
