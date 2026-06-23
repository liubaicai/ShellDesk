use serde_json::{json, Value};

use super::{
    codec::{encode_config_id, json_to_cli_value},
    parse::{
        parse_redis_json_command_output, parse_redis_raw_command_output,
        redis_cli_json_unsupported, redis_lines, redis_pairs_to_object, redis_stream_preview,
        redis_zset_items,
    },
    session::{decode_active_db_session_args, register_db_session},
    should_fallback_to_database_cli, should_try_database_tunnel, tunnel,
};
use crate::{now, ps_quote, read_string_field, run_cli_output, shell_quote, string_arg, AppState};

pub(crate) async fn redis_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let mut fallback_reason = None;
    if should_try_database_tunnel(state, &connection_id, &config)? {
        match tunnel::redis_connect(state, window, args.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) if should_fallback_to_database_cli(&config) => {
                eprintln!("[database] Redis SSH tunnel unavailable, falling back to CLI: {error}");
                fallback_reason = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    let redis_id = encode_config_id("redis", &config)?;
    let _ = run_redis_cli(state, &connection_id, &config, &["PING".to_string()]).await?;
    register_db_session(state, "redis", &connection_id, &redis_id, config)?;
    Ok(json!({
        "redisId": redis_id,
        "transport": "ssh-exec",
        "fallbackReason": fallback_reason,
    }))
}

pub(crate) async fn redis_scan(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "redis", &args)? {
        return tunnel::redis_scan(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let options = args.get(2).cloned().unwrap_or_else(|| json!({}));
    let cursor = read_string_field(&options, "cursor", "0");
    let pattern = read_string_field(&options, "pattern", "*");
    let count = options.get("count").and_then(Value::as_u64).unwrap_or(100);
    let output = run_redis_cli(
        state,
        &connection_id,
        &config,
        &[
            "SCAN".to_string(),
            cursor.clone(),
            "MATCH".to_string(),
            pattern.clone(),
            "COUNT".to_string(),
            count.to_string(),
        ],
    )
    .await?;
    let mut lines = output.lines();
    let next_cursor = lines.next().unwrap_or("0").trim().to_string();
    let mut keys = Vec::new();
    for key in lines.filter(|line| !line.trim().is_empty()) {
        keys.push(redis_key_summary(state, &connection_id, &config, key.trim()).await?);
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
    if tunnel::has_session(state, "redis", &args)? {
        return tunnel::redis_keys(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let pattern = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or("*")
        .to_string();
    let output = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["KEYS".to_string(), pattern],
    )
    .await?;
    let mut keys = Vec::new();
    for key in output.lines().filter(|line| !line.trim().is_empty()) {
        keys.push(redis_key_summary(state, &connection_id, &config, key.trim()).await?);
    }
    Ok(json!(keys))
}

pub(crate) async fn redis_get_value(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "redis", &args)? {
        return tunnel::redis_get_value(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let key = string_arg(&args, 2)?;
    let key_args = vec![key.clone()];
    let redis_type = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["TYPE".to_string(), key.clone()],
    )
    .await?
    .trim()
    .to_string();
    if redis_type == "none" {
        return Err(format!("键 \"{key}\" 不存在。"));
    }
    let ttl = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["TTL".to_string(), key.clone()],
    )
    .await?
    .trim()
    .parse::<i64>()
    .unwrap_or(-1);
    let value = match redis_type.as_str() {
        "hash" => json!(redis_pairs_to_object(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &["HGETALL".to_string(), key.clone()]
            )
            .await?
        )),
        "list" => json!(redis_lines(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &[
                    "LRANGE".to_string(),
                    key.clone(),
                    "0".to_string(),
                    "199".to_string()
                ]
            )
            .await?
        )),
        "set" => json!(redis_lines(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &["SMEMBERS".to_string(), key.clone()]
            )
            .await?
        )),
        "zset" => redis_zset_items(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &[
                    "ZRANGE".to_string(),
                    key.clone(),
                    "0".to_string(),
                    "199".to_string(),
                    "WITHSCORES".to_string(),
                ],
            )
            .await?,
        ),
        "stream" => redis_stream_preview(
            &run_redis_cli(
                state,
                &connection_id,
                &config,
                &[
                    "EVAL".to_string(),
                    redis_stream_preview_lua(),
                    "1".to_string(),
                    key.clone(),
                    "100".to_string(),
                ],
            )
            .await?,
        ),
        _ => json!(
            run_redis_cli(
                state,
                &connection_id,
                &config,
                &["GET".to_string(), key.clone()]
            )
            .await?
        ),
    };
    let size = run_redis_size(state, &connection_id, &config, &redis_type, &key_args)
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
    if tunnel::has_session(state, "redis", &args)? {
        return tunnel::redis_set_value(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let key = string_arg(&args, 2)?;
    let value = args.get(3).cloned().unwrap_or(Value::Null);
    let value_type = string_arg(&args, 4)?;
    let ttl_ms = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["PTTL".to_string(), key.clone()],
    )
    .await?
    .trim()
    .parse::<i64>()
    .unwrap_or(-1);
    let commands = redis_set_value_commands(&key, &value, &value_type, ttl_ms)?;
    for command in commands {
        let _ = run_redis_cli(state, &connection_id, &config, &command).await?;
    }
    Ok(json!(true))
}

pub(super) fn redis_set_value_commands(
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
            json_to_cli_value(value),
        ]),
        "hash" => {
            if let Some(object) = value.as_object() {
                if !object.is_empty() {
                    let mut hset = vec!["HSET".to_string(), key.to_string()];
                    for (field, field_value) in object {
                        hset.push(field.clone());
                        hset.push(json_to_cli_value(field_value));
                    }
                    commands.push(hset);
                }
            } else {
                return Err("Hash 值必须是 JSON 对象。".to_string());
            }
        }
        "list" => {
            if let Some(items) = value.as_array() {
                if !items.is_empty() {
                    let mut rpush = vec!["RPUSH".to_string(), key.to_string()];
                    for item in items {
                        rpush.push(json_to_cli_value(item));
                    }
                    commands.push(rpush);
                }
            } else {
                return Err("List 值必须是 JSON 数组。".to_string());
            }
        }
        "set" => {
            if let Some(items) = value.as_array() {
                if !items.is_empty() {
                    let mut sadd = vec!["SADD".to_string(), key.to_string()];
                    for item in items {
                        sadd.push(json_to_cli_value(item));
                    }
                    commands.push(sadd);
                }
            } else {
                return Err("Set 值必须是 JSON 数组。".to_string());
            }
        }
        "zset" => {
            let zset_args = redis_zset_cli_args(value)?;
            if !zset_args.is_empty() {
                let mut zadd = vec!["ZADD".to_string(), key.to_string()];
                zadd.extend(zset_args);
                commands.push(zadd);
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

pub(crate) async fn redis_delete_key(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "redis", &args)? {
        return tunnel::redis_delete_key(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let key = string_arg(&args, 2)?;
    let _ = run_redis_cli(state, &connection_id, &config, &["DEL".to_string(), key]).await?;
    Ok(json!(true))
}

pub(crate) async fn redis_remove_list_item(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    if tunnel::has_session(state, "redis", &args)? {
        return tunnel::redis_remove_list_item(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let key = string_arg(&args, 2)?;
    let index = args.get(3).and_then(Value::as_i64).unwrap_or(0);
    let len_output = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["LLEN".to_string(), key.clone()],
    )
    .await?;
    let len = len_output.trim().parse::<i64>().unwrap_or(0);
    let normalized_index = if index < 0 { len + index } else { index };
    if normalized_index < 0 || normalized_index >= len {
        return Ok(json!({ "removed": 0 }));
    }
    let marker = format!("__shelldesk_delete__:{}", crate::random_id("redis-list"));
    let _ = run_redis_cli(
        state,
        &connection_id,
        &config,
        &[
            "LSET".to_string(),
            key.clone(),
            normalized_index.to_string(),
            marker.clone(),
        ],
    )
    .await?;
    let output = run_redis_cli(
        state,
        &connection_id,
        &config,
        &["LREM".to_string(), key, "1".to_string(), marker],
    )
    .await?;
    let removed = output.trim().parse::<i64>().unwrap_or(0);
    Ok(json!({ "removed": removed }))
}

pub(crate) async fn redis_command(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "redis", &args)? {
        return tunnel::redis_command(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "redis", &args, 0, 1)?;
    let command = string_arg(&args, 2)?;
    let mut parts = vec![command];
    if let Some(command_args) = args.get(3).and_then(Value::as_array) {
        parts.extend(command_args.iter().map(json_to_cli_value));
    }
    let supports_json =
        match run_redis_cli_json(state, &connection_id, &config, &["PING".to_string()]).await {
            Ok(_) => true,
            Err(error) if redis_cli_json_unsupported(&error) => false,
            Err(error) => return Err(error),
        };
    if supports_json {
        let output = run_redis_cli_json(state, &connection_id, &config, &parts).await?;
        return parse_redis_json_command_output(&output);
    }
    let output = run_redis_cli(state, &connection_id, &config, &parts).await?;
    Ok(parse_redis_raw_command_output(&parts[0], &output))
}

async fn redis_key_summary(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    key: &str,
) -> Result<Value, String> {
    let redis_type = run_redis_cli(
        state,
        connection_id,
        config,
        &["TYPE".to_string(), key.to_string()],
    )
    .await?
    .trim()
    .to_string();
    let ttl = run_redis_cli(
        state,
        connection_id,
        config,
        &["TTL".to_string(), key.to_string()],
    )
    .await?
    .trim()
    .parse::<i64>()
    .unwrap_or(-1);
    let size = run_redis_size(
        state,
        connection_id,
        config,
        &redis_type,
        &[key.to_string()],
    )
    .await
    .unwrap_or(0);
    Ok(json!({ "name": key, "type": redis_type, "ttl": ttl, "size": size, "scannedAt": now() }))
}

async fn run_redis_size(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    redis_type: &str,
    key_args: &[String],
) -> Result<i64, String> {
    let size_command = match redis_type {
        "string" => "STRLEN",
        "hash" => "HLEN",
        "list" => "LLEN",
        "set" => "SCARD",
        "zset" => "ZCARD",
        "stream" => "XLEN",
        _ => return Ok(0),
    };
    let mut args = vec![size_command.to_string()];
    args.extend_from_slice(key_args);
    Ok(run_redis_cli(state, connection_id, config, &args)
        .await?
        .trim()
        .parse::<i64>()
        .unwrap_or(0))
}

async fn run_redis_cli(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    command_args: &[String],
) -> Result<String, String> {
    run_redis_cli_with_mode(state, connection_id, config, "raw", command_args).await
}

async fn run_redis_cli_json(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    command_args: &[String],
) -> Result<String, String> {
    run_redis_cli_with_mode(state, connection_id, config, "json", command_args).await
}

async fn run_redis_cli_with_mode(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    output_mode: &str,
    command_args: &[String],
) -> Result<String, String> {
    let host = read_string_field(config, "host", "127.0.0.1");
    let port = config.get("port").and_then(Value::as_u64).unwrap_or(6379);
    let password = read_string_field(config, "password", "");
    let db = config.get("db").and_then(Value::as_i64).unwrap_or(0);
    let mode_flag = if output_mode == "json" {
        "--json"
    } else {
        "--raw"
    };
    let mut base = format!(
        "redis-cli {} -h {} -p {} -n {}",
        mode_flag,
        shell_quote(&host),
        port,
        db
    );
    let mut ps_base = format!(
        "redis-cli {} -h {} -p {} -n {}",
        mode_flag,
        ps_quote(&host),
        port,
        db
    );
    if !password.is_empty() {
        base = format!("REDISCLI_AUTH={} {base}", shell_quote(&password));
        ps_base = format!("$env:REDISCLI_AUTH = {}; {ps_base}", ps_quote(&password));
    }
    for arg in command_args {
        base.push(' ');
        base.push_str(&shell_quote(arg));
        ps_base.push(' ');
        ps_base.push_str(&ps_quote(arg));
    }
    run_cli_output(
        state,
        connection_id,
        base,
        Some(ps_base),
        "Redis 命令执行失败。",
    )
    .await
}

fn redis_stream_preview_lua() -> String {
    "local limit = tonumber(ARGV[1]) or 100; return cjson.encode(redis.call('XRANGE', KEYS[1], '-', '+', 'COUNT', limit))".to_string()
}

pub(super) fn redis_zset_cli_args(value: &Value) -> Result<Vec<String>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "ZSet 值必须是 JSON 数组。".to_string())?;
    let mut args = Vec::new();
    let mut index = 0;
    while index < items.len() {
        let item = &items[index];
        if let Some(object) = item.as_object() {
            if let (Some(member), Some(score)) = (object.get("member"), object.get("score")) {
                args.push(json_to_cli_value(score));
                args.push(json_to_cli_value(member));
            }
            index += 1;
        } else if index + 1 < items.len() {
            args.push(json_to_cli_value(&items[index + 1]));
            args.push(json_to_cli_value(item));
            index += 2;
        } else {
            index += 1;
        }
    }
    Ok(args)
}
