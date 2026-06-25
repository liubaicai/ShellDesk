use fred::{
    prelude::{Client as RedisClient, ClientLike, Config as RedisConfig, Value as RedisValue},
    types::{ClusterHash, CustomCommand},
};
use serde_json::{json, Map, Value};
use std::time::Instant;

use super::{
    config::RedisConnectConfig,
    core::{
        open_database_ssh_tunnel, session_key, validate_database_endpoint, DatabaseTunnelSession,
        DbTunnelError, RedisTunnelSession, TunnelOptions,
    },
    percent_encode, timeout_result, METADATA_TIMEOUT, QUERY_TIMEOUT,
};
use crate::{error_string, get_connection, now, random_id, string_arg, AppState, ConnectionKind};

pub(crate) async fn redis_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
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
        let endpoint =
            open_database_ssh_tunnel(state, window, &connection_id, &tunnel_options).await?;
        match connect_redis_direct(&config, &endpoint.host, endpoint.port).await {
            Ok(client) => (client, Some(endpoint.tunnel), endpoint.transport),
            Err(error) => {
                endpoint.tunnel.shutdown().await;
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
            DatabaseTunnelSession::Redis(RedisTunnelSession {
                tunnel,
                client,
                last_activity: Instant::now(),
            }),
        );
    Ok(json!({
        "redisId": redis_id,
        "transport": transport,
        "alreadyConnected": false
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
    let keys = redis_key_summaries(state, &args, &names).await?;
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
    // WARNING: KEYS can block large Redis instances. Prefer redis_scan for new callers.
    let response = redis_command_values(state, &args, "KEYS", vec![pattern]).await?;
    let names = redis_string_list(response);
    let keys = redis_key_summaries(state, &args, &names).await?;
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

pub(crate) async fn redis_remove_list_item(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let key = string_arg(&args, 2)?;
    let index = args.get(3).and_then(Value::as_i64).unwrap_or(0);
    let len = redis_i64(redis_command_values(state, &args, "LLEN", vec![key.clone()]).await?)
        .unwrap_or(0);
    let normalized_index = if index < 0 { len + index } else { index };
    if normalized_index < 0 || normalized_index >= len {
        return Ok(json!({ "removed": 0 }));
    }
    let marker = format!("__shelldesk_delete__:{}", random_id("redis-list"));
    let _ = redis_command_values(
        state,
        &args,
        "LSET",
        vec![key.clone(), normalized_index.to_string(), marker.clone()],
    )
    .await?;
    let removed = redis_i64(
        redis_command_values(state, &args, "LREM", vec![key, "1".to_string(), marker]).await?,
    )
    .unwrap_or(0);
    Ok(json!({ "removed": removed }))
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
    if let Err(error) = timeout_result(METADATA_TIMEOUT, client.wait_for_connect(), |error| {
        DbTunnelError::RedisConnect(error.to_string()).user_message()
    })
    .await
    {
        return Err(error);
    }
    let ping: Result<RedisValue, String> = timeout_result(
        METADATA_TIMEOUT,
        client.custom(
            CustomCommand::new_static("PING", ClusterHash::FirstKey, false),
            Vec::<String>::new(),
        ),
        |error| DbTunnelError::RedisConnect(error.to_string()).user_message(),
    )
    .await;
    if let Err(error) = ping {
        let _ = client.quit().await;
        return Err(error);
    }
    Ok(client)
}

fn redis_client(state: &AppState, args: &[Value]) -> Result<RedisClient, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let mut guard = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?;
    let session = guard
        .get_mut(&session_key("redis", &connection_id, &session_id))
        .ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    session.touch();
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
    timeout_result(
        QUERY_TIMEOUT,
        client.custom(
            CustomCommand::new(command.to_string(), ClusterHash::FirstKey, false),
            values,
        ),
        |error| DbTunnelError::RedisCommand(error.to_string()).user_message(),
    )
    .await
}

async fn redis_key_summaries(
    state: &AppState,
    args: &[Value],
    names: &[String],
) -> Result<Vec<Value>, String> {
    if names.is_empty() {
        return Ok(Vec::new());
    }

    let client = redis_client(state, args)?;
    let pipeline = client.pipeline();
    for key in names {
        let _: RedisValue = pipeline
            .custom(
                CustomCommand::new("TYPE", ClusterHash::FirstKey, false),
                vec![key.clone()],
            )
            .await
            .map_err(|error| DbTunnelError::RedisCommand(error.to_string()).user_message())?;
        let _: RedisValue = pipeline
            .custom(
                CustomCommand::new("TTL", ClusterHash::FirstKey, false),
                vec![key.clone()],
            )
            .await
            .map_err(|error| DbTunnelError::RedisCommand(error.to_string()).user_message())?;
    }
    let results: Vec<RedisValue> = timeout_result(QUERY_TIMEOUT, pipeline.all(), |error| {
        DbTunnelError::RedisCommand(error.to_string()).user_message()
    })
    .await?;

    let mut summaries = Vec::with_capacity(names.len());
    for (index, key) in names.iter().enumerate() {
        let redis_type = results
            .get(index * 2)
            .cloned()
            .and_then(redis_string)
            .unwrap_or_else(|| "none".to_string());
        let ttl = results
            .get(index * 2 + 1)
            .cloned()
            .and_then(redis_i64)
            .unwrap_or(-1);
        let size = redis_size(state, args, &redis_type, key).await.unwrap_or(0);
        summaries.push(
            json!({ "name": key, "type": redis_type, "ttl": ttl, "size": size, "scannedAt": now() }),
        );
    }
    Ok(summaries)
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
