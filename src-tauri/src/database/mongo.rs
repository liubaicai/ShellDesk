use serde_json::{json, Value};

use super::{
    codec::{encode_config_id, js_string, mongo_ejson_prelude, mongo_ejson_value_expression},
    session::{decode_active_db_session_args, register_db_session},
    should_fallback_to_database_cli, should_try_database_tunnel, tunnel,
};
use crate::{
    error_string, ps_quote, read_string_field, run_cli_output, shell_quote, string_arg, AppState,
};

pub(crate) async fn mongo_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let config = args.get(1).cloned().unwrap_or_else(|| json!({}));
    let mut fallback_reason = None;
    if should_try_database_tunnel(state, &connection_id, &config)? {
        match tunnel::mongo_connect(state, window, args.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) if should_fallback_to_database_cli(&config) => {
                eprintln!(
                    "[database] MongoDB SSH tunnel unavailable, falling back to CLI: {error}"
                );
                fallback_reason = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    let mongo_id = encode_config_id("mongo", &config)?;
    let _ = run_mongo_eval(
        state,
        &connection_id,
        &config,
        "JSON.stringify(db.adminCommand({ ping: 1 }))",
        None,
    )
    .await?;
    register_db_session(state, "mongo", &connection_id, &mongo_id, config)?;
    Ok(json!({
        "mongoId": mongo_id,
        "transport": "ssh-exec",
        "fallbackReason": fallback_reason,
    }))
}

pub(crate) async fn mongo_databases(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "mongo", &args)? {
        return tunnel::mongo_databases(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mongo", &args, 0, 1)?;
    let output = run_mongo_eval(
        state,
        &connection_id,
        &config,
        &format!(
            "{} __shelldeskStringify(db.adminCommand({{ listDatabases: 1 }}).databases.map((database) => ({{ name: database.name, sizeOnDisk: database.sizeOnDisk, empty: !!database.empty }})).sort((left, right) => left.name.localeCompare(right.name)))",
            mongo_ejson_prelude()
        ),
        None,
    )
    .await?;
    serde_json::from_str(&output).map_err(error_string)
}

pub(crate) async fn mongo_collections(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "mongo", &args)? {
        return tunnel::mongo_collections(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mongo", &args, 0, 1)?;
    let database = string_arg(&args, 2)?;
    let script = format!(
        "{} __shelldeskStringify(db.getCollectionInfos().map((c) => ({{ name: c.name, type: c.type || 'collection' }})).sort((left, right) => left.name.localeCompare(right.name)))",
        mongo_ejson_prelude()
    );
    let output = run_mongo_eval(state, &connection_id, &config, &script, Some(&database)).await?;
    serde_json::from_str(&output).map_err(error_string)
}

pub(crate) async fn mongo_indexes(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "mongo", &args)? {
        return tunnel::mongo_indexes(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mongo", &args, 0, 1)?;
    let database = string_arg(&args, 2)?;
    let collection = string_arg(&args, 3)?;
    let script = format!(
        "{} __shelldeskStringify(db.getCollection({}).getIndexes().map((i) => ({{ name: i.name || '', key: i.key || {{}}, unique: !!i.unique, sparse: !!i.sparse, expireAfterSeconds: i.expireAfterSeconds }})))",
        mongo_ejson_prelude(),
        js_string(&collection)
    );
    let output = run_mongo_eval(state, &connection_id, &config, &script, Some(&database)).await?;
    serde_json::from_str(&output).map_err(error_string)
}

pub(crate) async fn mongo_query(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    if tunnel::has_session(state, "mongo", &args)? {
        return tunnel::mongo_query(state, args).await;
    }
    let (connection_id, config) = decode_active_db_session_args(state, "mongo", &args, 0, 1)?;
    let request = args.get(2).cloned().unwrap_or_else(|| json!({}));
    let database = read_string_field(&request, "database", "");
    let collection = read_string_field(&request, "collection", "");
    let filter = read_string_field(&request, "filter", "{}");
    let projection = read_string_field(&request, "projection", "");
    let sort = read_string_field(&request, "sort", "");
    let operation = read_string_field(&request, "operation", "find");
    let pipeline = read_string_field(&request, "pipeline", "[]");
    let document = read_string_field(&request, "document", "{}");
    let update = read_string_field(&request, "update", "{}");
    let limit = request
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(100)
        .clamp(1, 1000);
    let filter_expr = mongo_ejson_value_expression(&filter, "{}");
    let projection_expr = mongo_ejson_value_expression(&projection, "undefined");
    let sort_expr = mongo_ejson_value_expression(&sort, "undefined");
    let pipeline_expr = mongo_ejson_value_expression(&pipeline, "[]");
    let document_expr = mongo_ejson_value_expression(&document, "{}");
    let update_expr = mongo_ejson_value_expression(&update, "{}");
    let collection_expr = js_string(&collection);
    let script = match operation.as_str() {
        "aggregate" => format!(
            "{} const pipeline = {}; const cursor = db.getCollection({}).aggregate(pipeline); const docs = cursor.limit({limit}).toArray(); __shelldeskStringify({{ documents: docs, count: docs.length, limit: {limit}, operation: 'aggregate' }})",
            mongo_ejson_prelude(),
            pipeline_expr,
            collection_expr,
        ),
        "insertOne" => format!(
            "{} const document = {}; const result = db.getCollection({}).insertOne(document); __shelldeskStringify({{ documents: [{{ insertedId: result.insertedId }}], count: 1, limit: 1, operation: 'insertOne', insertedCount: result.acknowledged ? 1 : 0, insertedId: result.insertedId }})",
            mongo_ejson_prelude(),
            document_expr,
            collection_expr,
        ),
        "replaceOne" => format!(
            "{} const filter = {}; const document = {}; const result = db.getCollection({}).replaceOne(filter, document); __shelldeskStringify({{ documents: [{{ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }}], count: 1, limit: 1, operation: 'replaceOne', matchedCount: result.matchedCount, modifiedCount: result.modifiedCount }})",
            mongo_ejson_prelude(),
            filter_expr,
            document_expr,
            collection_expr,
        ),
        "updateOne" => format!(
            "{} const filter = {}; const update = {}; const result = db.getCollection({}).updateOne(filter, update); __shelldeskStringify({{ documents: [{{ matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, upsertedId: result.upsertedId }}], count: 1, limit: 1, operation: 'updateOne', matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, upsertedId: result.upsertedId }})",
            mongo_ejson_prelude(),
            filter_expr,
            update_expr,
            collection_expr,
        ),
        "deleteOne" => format!(
            "{} const filter = {}; const result = db.getCollection({}).deleteOne(filter); __shelldeskStringify({{ documents: [{{ deletedCount: result.deletedCount }}], count: 1, limit: 1, operation: 'deleteOne', deletedCount: result.deletedCount }})",
            mongo_ejson_prelude(),
            filter_expr,
            collection_expr,
        ),
        _ => {
            let mut script = format!(
                "{} const filter = {}; const projection = {}; const sort = {}; let cursor = db.getCollection({}).find(filter, projection === undefined ? undefined : {{ projection }});",
                mongo_ejson_prelude(),
                filter_expr,
                projection_expr,
                sort_expr,
                collection_expr,
            );
            script.push_str(" if (sort !== undefined) { cursor = cursor.sort(sort); }");
            script.push_str(&format!(
                " const docs = cursor.limit({limit}).toArray(); __shelldeskStringify({{ documents: docs, count: docs.length, limit: {limit}, operation: 'find' }})"
            ));
            script
        }
    };
    let output = run_mongo_eval(state, &connection_id, &config, &script, Some(&database)).await?;
    serde_json::from_str(&output).map_err(error_string)
}

async fn run_mongo_eval(
    state: &AppState,
    connection_id: &str,
    config: &Value,
    script: &str,
    database_override: Option<&str>,
) -> Result<String, String> {
    let host = read_string_field(config, "host", "127.0.0.1");
    let port = config.get("port").and_then(Value::as_u64).unwrap_or(27017);
    let username = read_string_field(config, "username", "");
    let password = read_string_field(config, "password", "");
    let auth_source = read_string_field(config, "authSource", "admin");
    let database = database_override.unwrap_or(&auth_source);
    let mut posix = format!(
        "mongosh --quiet --host {} --port {} {}",
        shell_quote(&host),
        port,
        shell_quote(database)
    );
    let mut windows = format!(
        "mongosh --quiet --host {} --port {} {}",
        ps_quote(&host),
        port,
        ps_quote(database)
    );
    if !username.is_empty() {
        posix.push_str(&format!(
            " -u {} -p {} --authenticationDatabase {}",
            shell_quote(&username),
            shell_quote(&password),
            shell_quote(&auth_source)
        ));
        windows.push_str(&format!(
            " -u {} -p {} --authenticationDatabase {}",
            ps_quote(&username),
            ps_quote(&password),
            ps_quote(&auth_source)
        ));
    }
    posix.push_str(&format!(" --eval {}", shell_quote(script)));
    windows.push_str(&format!(" --eval {}", ps_quote(script)));
    run_cli_output(
        state,
        connection_id,
        posix,
        Some(windows),
        "MongoDB 命令执行失败。",
    )
    .await
}
