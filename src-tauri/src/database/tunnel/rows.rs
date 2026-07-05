use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat, Utc};
use futures_util::TryStreamExt;
use serde_json::{json, Map, Value};
use sqlx::{
    mysql::{MySqlArguments, MySqlRow},
    postgres::PgRow,
    Column, Executor, MySql, PgPool, Row, TypeInfo,
};

use super::{core::DbTunnelError, MAX_QUERY_ROWS};

pub(super) fn rows_to_json_mysql(rows: Vec<MySqlRow>) -> Value {
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

pub(super) fn rows_to_json_pg(rows: Vec<PgRow>) -> Value {
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

pub(super) async fn fetch_mysql_rows_limited<'executor, ExecutorType>(
    executor: ExecutorType,
    sql: &'executor str,
) -> Result<Vec<MySqlRow>, String>
where
    ExecutorType: Executor<'executor, Database = MySql>,
{
    let mut stream = sqlx::raw_sql(sql).fetch_many(executor);
    let mut rows = Vec::new();
    while let Some(result) = stream
        .try_next()
        .await
        .map_err(|error| DbTunnelError::MysqlQuery(error).user_message())?
    {
        if let sqlx::Either::Right(row) = result {
            rows.push(row);
            if rows.len() >= MAX_QUERY_ROWS {
                break;
            }
        }
    }
    Ok(rows)
}

pub(super) async fn fetch_pg_rows_limited(pool: &PgPool, sql: &str) -> Result<Vec<PgRow>, String> {
    let mut stream = sqlx::raw_sql(sql).fetch_many(pool);
    let mut rows = Vec::new();
    while let Some(result) = stream
        .try_next()
        .await
        .map_err(|error| DbTunnelError::PostgresQuery(error).user_message())?
    {
        if let sqlx::Either::Right(row) = result {
            rows.push(row);
            if rows.len() >= MAX_QUERY_ROWS {
                break;
            }
        }
    }
    Ok(rows)
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
    if let Ok(value) = row.try_get::<Option<u64>, _>(index) {
        return value.map_or(Value::Null, mysql_unsigned_integer_to_json);
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
    if let Ok(value) = row.try_get::<String, _>(index) {
        return json!(value);
    }
    if let Ok(value) = row.try_get::<Option<Vec<u8>>, _>(index) {
        return value.map_or(Value::Null, mysql_bytes_to_json);
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        return mysql_bytes_to_json(value);
    }
    json!(format!("<unsupported:{type_name}>"))
}

#[cfg(test)]
pub(super) fn mysql_unsigned_integer_to_json(value: u64) -> Value {
    mysql_unsigned_integer_to_json_inner(value)
}

#[cfg(not(test))]
fn mysql_unsigned_integer_to_json(value: u64) -> Value {
    mysql_unsigned_integer_to_json_inner(value)
}

fn mysql_unsigned_integer_to_json_inner(value: u64) -> Value {
    json!(value)
}

pub(super) fn mysql_text_value(row: &MySqlRow, index: usize) -> Option<String> {
    if let Ok(value) = row.try_get::<Option<String>, _>(index) {
        return value;
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        return Some(value);
    }
    if let Ok(value) = row.try_get::<Option<Vec<u8>>, _>(index) {
        return value.map(mysql_bytes_to_display_string);
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        return Some(mysql_bytes_to_display_string(value));
    }
    None
}

#[cfg(test)]
pub(super) fn mysql_bytes_to_json(bytes: Vec<u8>) -> Value {
    mysql_bytes_to_json_inner(bytes)
}

#[cfg(not(test))]
fn mysql_bytes_to_json(bytes: Vec<u8>) -> Value {
    mysql_bytes_to_json_inner(bytes)
}

fn mysql_bytes_to_json_inner(bytes: Vec<u8>) -> Value {
    json!(mysql_bytes_to_display_string(bytes))
}

#[cfg(test)]
pub(super) fn mysql_bytes_to_display_string(bytes: Vec<u8>) -> String {
    mysql_bytes_to_display_string_inner(bytes)
}

#[cfg(not(test))]
fn mysql_bytes_to_display_string(bytes: Vec<u8>) -> String {
    mysql_bytes_to_display_string_inner(bytes)
}

fn mysql_bytes_to_display_string_inner(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|error| {
        let bytes = error.into_bytes();
        let mut output = String::with_capacity(2 + bytes.len() * 2);
        output.push_str("0x");
        for byte in bytes {
            output.push_str(&format!("{byte:02X}"));
        }
        output
    })
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
    if let Ok(value) = row.try_get::<String, _>(index) {
        return json!(value);
    }
    if let Ok(value) = row.try_get::<Option<DateTime<Utc>>, _>(index) {
        return value.map_or(Value::Null, |value| {
            json!(value.to_rfc3339_opts(SecondsFormat::Millis, true))
        });
    }
    if let Ok(value) = row.try_get::<DateTime<Utc>, _>(index) {
        return json!(value.to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    if let Ok(value) = row.try_get::<Option<NaiveDateTime>, _>(index) {
        return value.map_or(Value::Null, |value| {
            json!(value.format("%Y-%m-%d %H:%M:%S%.f").to_string())
        });
    }
    if let Ok(value) = row.try_get::<NaiveDateTime, _>(index) {
        return json!(value.format("%Y-%m-%d %H:%M:%S%.f").to_string());
    }
    if let Ok(value) = row.try_get::<Option<NaiveDate>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value.to_string()));
    }
    if let Ok(value) = row.try_get::<NaiveDate, _>(index) {
        return json!(value.to_string());
    }
    if let Ok(value) = row.try_get::<Option<NaiveTime>, _>(index) {
        return value.map_or(Value::Null, |value| json!(value.to_string()));
    }
    if let Ok(value) = row.try_get::<NaiveTime, _>(index) {
        return json!(value.to_string());
    }
    json!(format!("<unsupported:{type_name}>"))
}

pub(super) fn mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

pub(super) fn bind_mysql_value<'q>(
    query: sqlx::query::Query<'q, MySql, MySqlArguments>,
    value: Value,
) -> sqlx::query::Query<'q, MySql, MySqlArguments> {
    match value {
        Value::Null => query.bind(Option::<String>::None),
        Value::Bool(value) => query.bind(value),
        Value::Number(number) => {
            if let Some(value) = number.as_i64() {
                query.bind(value)
            } else if let Some(value) = number.as_u64() {
                query.bind(value.to_string())
            } else if let Some(value) = number.as_f64() {
                query.bind(value)
            } else {
                query.bind(number.to_string())
            }
        }
        Value::String(value) => query.bind(value),
        other => query.bind(other.to_string()),
    }
}

pub(super) fn is_write_statement(sql: &str) -> bool {
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

pub(super) fn has_returning_clause(sql: &str) -> bool {
    contains_sql_keyword(sql, "returning")
}

fn contains_sql_keyword(sql: &str, keyword: &str) -> bool {
    sql.split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .any(|token| token.eq_ignore_ascii_case(keyword))
}
