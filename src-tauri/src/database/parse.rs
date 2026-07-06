use std::collections::HashMap;

use serde_json::{json, Value};

use crate::error_string;

pub(super) fn parse_csv_query(output: &str) -> Result<(Vec<String>, Vec<Value>), String> {
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

pub(super) fn parse_csv_objects(output: &str) -> Result<Vec<HashMap<String, String>>, String> {
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

pub(super) fn parse_clickhouse_response(output: &str) -> Value {
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

pub(super) fn parse_tsv_rows(value: &str) -> Vec<Vec<String>> {
    value
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.split('\t').map(|cell| cell.to_string()).collect())
        .collect()
}

pub(super) fn parse_mysql_write_metadata(output: &str) -> (i64, Option<String>) {
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

pub(super) fn parse_postgres_command_tag_row_count(output: &str) -> Option<Option<u64>> {
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

pub(super) fn redis_lines(output: &str) -> Vec<String> {
    output.lines().map(ToString::to_string).collect()
}

pub(super) fn redis_pairs_to_object(output: &str) -> Value {
    let mut object = serde_json::Map::new();
    let mut lines = output.lines();
    while let Some(key) = lines.next() {
        let value = lines.next().unwrap_or("");
        object.insert(key.to_string(), json!(value));
    }
    Value::Object(object)
}

pub(super) fn redis_zset_items(output: &str) -> Value {
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

pub(super) fn redis_stream_preview(output: &str) -> Value {
    serde_json::from_str(output.trim()).unwrap_or_else(|_| json!(redis_lines(output)))
}

pub(super) fn redis_cli_json_unsupported(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("--json")
        && (normalized.contains("unrecognized")
            || normalized.contains("unknown")
            || normalized.contains("invalid option")
            || normalized.contains("bad number of args")
            || normalized.contains("usage: redis-cli"))
}

pub(super) fn parse_redis_json_command_output(output: &str) -> Result<Value, String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(trimmed).map_err(error_string)
}

pub(super) fn parse_redis_raw_command_output(command: &str, output: &str) -> Value {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_csv_query_preserves_quoted_commas_and_empty_cells() {
        let (columns, rows) =
            parse_csv_query("id,name,note\n1,Alice,\"hello, world\"\n2,Bob,\n").unwrap();

        assert_eq!(columns, vec!["id", "name", "note"]);
        assert_eq!(
            rows,
            vec![
                json!({ "id": "1", "name": "Alice", "note": "hello, world" }),
                json!({ "id": "2", "name": "Bob", "note": "" }),
            ]
        );
    }

    #[test]
    fn parse_clickhouse_response_uses_meta_statistics_and_row_count() {
        let response = parse_clickhouse_response(
            r#"{
                "meta": [{"name": "id"}, {"name": "name"}],
                "data": [{"id": 1, "name": "alice"}],
                "rows": 7,
                "statistics": {"elapsed": 0.25, "rows_read": 10, "bytes_read": 128}
            }"#,
        );

        assert_eq!(response["columns"], json!(["id", "name"]));
        assert_eq!(response["rows"], json!([{ "id": 1, "name": "alice" }]));
        assert_eq!(response["rowCount"], json!(7));
        assert_eq!(
            response["statistics"],
            json!({ "elapsed": 0.25, "rowsRead": 10, "bytesRead": 128 })
        );
    }

    #[test]
    fn parse_clickhouse_response_wraps_plain_text_as_response_row() {
        let response = parse_clickhouse_response("Syntax error near FROM");

        assert_eq!(response["columns"], json!(["response"]));
        assert_eq!(
            response["rows"],
            json!([{ "response": "Syntax error near FROM" }])
        );
        assert_eq!(response["rowCount"], json!(1));
    }

    #[test]
    fn parse_mysql_write_metadata_reads_last_metadata_table() {
        let (affected_rows, insert_id) = parse_mysql_write_metadata(
            "affectedRows\tinsertId\n1\t12\nnoise\tvalue\naffectedRows\tinsertId\n3\t42\n",
        );

        assert_eq!(affected_rows, 3);
        assert_eq!(insert_id.as_deref(), Some("42"));
    }

    #[test]
    fn parse_mysql_write_metadata_ignores_empty_or_zero_insert_id() {
        assert_eq!(
            parse_mysql_write_metadata("affectedRows\tinsertId\n5\t0\n"),
            (5, None)
        );
        assert_eq!(
            parse_mysql_write_metadata("affectedRows\tinsertId\n2\t\n"),
            (2, None)
        );
    }

    #[test]
    fn parse_postgres_command_tag_row_count_handles_write_and_ddl_tags() {
        assert_eq!(
            parse_postgres_command_tag_row_count("INSERT 0 4"),
            Some(Some(4))
        );
        assert_eq!(
            parse_postgres_command_tag_row_count("UPDATE 12"),
            Some(Some(12))
        );
        assert_eq!(
            parse_postgres_command_tag_row_count("CREATE TABLE"),
            Some(None)
        );
        assert_eq!(
            parse_postgres_command_tag_row_count("SELECT 1\nSELECT 2"),
            None
        );
        assert_eq!(parse_postgres_command_tag_row_count("NOTICE created"), None);
    }

    #[test]
    fn redis_pairs_and_zset_outputs_keep_odd_trailing_values() {
        assert_eq!(
            redis_pairs_to_object("name\nalice\nrole\nadmin\nmissing\n"),
            json!({ "name": "alice", "role": "admin", "missing": "" })
        );
        assert_eq!(
            redis_zset_items("alice\n1.5\nbob\nnot-a-number\ncarol\n"),
            json!([
                { "member": "alice", "score": 1.5 },
                { "member": "bob", "score": "not-a-number" },
                { "member": "carol", "score": "" }
            ])
        );
    }

    #[test]
    fn redis_cli_json_unsupported_detects_common_cli_errors() {
        assert!(redis_cli_json_unsupported(
            "redis-cli: unrecognized option '--json'"
        ));
        assert!(redis_cli_json_unsupported("ERR unknown option --json"));
        assert!(redis_cli_json_unsupported("usage: redis-cli --json"));
        assert!(!redis_cli_json_unsupported(
            "NOAUTH Authentication required"
        ));
    }

    #[test]
    fn parse_redis_raw_command_output_coerces_integer_reply_commands_only() {
        assert_eq!(parse_redis_raw_command_output("del", "3\n"), json!(3));
        assert_eq!(parse_redis_raw_command_output("get", "3\n"), json!("3"));
        assert_eq!(
            parse_redis_raw_command_output("lrange", "a\nb\n"),
            json!(["a", "b"])
        );
        assert_eq!(parse_redis_raw_command_output("get", ""), Value::Null);
    }
}
