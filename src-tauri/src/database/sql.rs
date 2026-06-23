use serde_json::Value;

pub(super) fn is_mysql_write_statement(sql: &str) -> bool {
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

pub(super) fn mysql_query_with_write_metadata(sql: &str) -> String {
    let trimmed = sql.trim();
    let without_trailing_semicolons = trimmed.trim_end_matches(';').trim_end();
    format!("{without_trailing_semicolons}; SELECT ROW_COUNT() AS affectedRows, LAST_INSERT_ID() AS insertId;")
}

pub(super) fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

pub(super) fn mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

pub(super) fn mysql_value_literal(value: &Value) -> String {
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

pub(super) fn clickhouse_query_with_json_format(sql: &str) -> String {
    let trimmed = sql.trim_end();
    if clickhouse_query_has_format_clause(trimmed) {
        return sql.to_string();
    }
    let without_trailing_semicolon = trimmed.trim_end_matches(';').trim_end();
    format!("{without_trailing_semicolon} FORMAT JSON")
}

pub(super) fn clickhouse_query_has_format_clause(sql: &str) -> bool {
    sql.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .any(|token| token.eq_ignore_ascii_case("format"))
}

pub(super) fn pg_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(super) fn pg_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(super) fn pg_value_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => {
            if *value {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Value::Number(number) => number.to_string(),
        Value::String(value) => pg_literal(value),
        other => pg_literal(&other.to_string()),
    }
}

pub(super) fn sqlite_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(super) fn sqlite_value_literal(value: &Value) -> String {
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

pub(super) fn sqlite_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(super) fn sqlite_identifier_literal(value: &str) -> String {
    sqlite_literal(value)
}

pub(super) fn clickhouse_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}
