use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, Document},
    options::ClientOptions as MongoClientOptions,
    Client as MongoClient,
};
use serde_json::{json, Value};
use std::time::Instant;

use super::{
    config::MongoConnectConfig,
    core::{
        open_database_ssh_tunnel, session_key, validate_database_endpoint, DatabaseTunnelSession,
        DbTunnelError, MongoTunnelSession, TunnelOptions,
    },
    percent_encode, timeout_result, METADATA_TIMEOUT, QUERY_TIMEOUT,
};
use crate::{error_string, get_connection, random_id, string_arg, AppState, ConnectionKind};

pub(crate) async fn mongo_connect(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
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
        let endpoint =
            open_database_ssh_tunnel(state, window, &connection_id, &tunnel_options).await?;
        match connect_mongo_direct(&config, &endpoint.host, endpoint.port).await {
            Ok(client) => (client, Some(endpoint.tunnel), endpoint.transport),
            Err(error) => {
                endpoint.tunnel.shutdown().await;
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
            DatabaseTunnelSession::Mongo(MongoTunnelSession {
                tunnel,
                client,
                last_activity: Instant::now(),
            }),
        );
    Ok(json!({
        "mongoId": mongo_id,
        "transport": transport,
        "alreadyConnected": false
    }))
}

pub(crate) async fn mongo_databases(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let client = mongo_client(state, &args)?;
    let databases = timeout_result(METADATA_TIMEOUT, client.list_databases(), |error| {
        DbTunnelError::MongoQuery(error.to_string()).user_message()
    })
    .await?;
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
    let mut cursor = timeout_result(
        METADATA_TIMEOUT,
        client.database(&database).list_collections(),
        |error| DbTunnelError::MongoQuery(error.to_string()).user_message(),
    )
    .await?;
    let mut rows = Vec::new();
    while let Some(collection) = timeout_result(METADATA_TIMEOUT, cursor.try_next(), |error| {
        DbTunnelError::MongoQuery(error.to_string()).user_message()
    })
    .await?
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
    let mut cursor = timeout_result(METADATA_TIMEOUT, collection.list_indexes(), |error| {
        DbTunnelError::MongoQuery(error.to_string()).user_message()
    })
    .await?;
    let mut indexes = Vec::new();
    while let Some(index) = timeout_result(METADATA_TIMEOUT, cursor.try_next(), |error| {
        DbTunnelError::MongoQuery(error.to_string()).user_message()
    })
    .await?
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
    let operation = request
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("find");
    let limit = request
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(100)
        .clamp(1, 1000);
    let collection = client
        .database(&database)
        .collection::<Document>(&collection);
    tokio::time::timeout(QUERY_TIMEOUT, async {
        if operation == "aggregate" {
            let pipeline = mongo_pipeline_from_request(&request)?;
            let mut cursor = collection
                .aggregate(pipeline)
                .await
                .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?;
            let mut documents = Vec::new();
            while let Some(document) = cursor
                .try_next()
                .await
                .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?
            {
                documents.push(bson_to_json(Bson::Document(document)));
                if documents.len() >= limit as usize {
                    break;
                }
            }
            return Ok(json!({
                "documents": documents,
                "count": documents.len(),
                "limit": limit,
                "operation": operation
            }));
        }

        if operation == "insertOne" {
            let document = mongo_document_from_request(&request, "document", "{}")?;
            let result = collection
                .insert_one(document)
                .await
                .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?;
            let inserted_id = bson_to_json(result.inserted_id);
            return Ok(json!({
                "documents": [{ "insertedId": inserted_id.clone() }],
                "count": 1,
                "limit": 1,
                "operation": operation,
                "insertedCount": 1,
                "insertedId": inserted_id
            }));
        }

        if operation == "replaceOne" {
            let replacement = mongo_document_from_request(&request, "document", "{}")?;
            let result = collection
                .replace_one(filter, replacement)
                .await
                .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?;
            return Ok(json!({
                "documents": [{ "matchedCount": result.matched_count, "modifiedCount": result.modified_count }],
                "count": 1,
                "limit": 1,
                "operation": operation,
                "matchedCount": result.matched_count,
                "modifiedCount": result.modified_count
            }));
        }

        if operation == "updateOne" {
            let update = mongo_document_from_request(&request, "update", "{}")?;
            let result = collection
                .update_one(filter, update)
                .await
                .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?;
            let upserted_id = result.upserted_id.map(bson_to_json);
            return Ok(json!({
                "documents": [{ "matchedCount": result.matched_count, "modifiedCount": result.modified_count, "upsertedId": upserted_id }],
                "count": 1,
                "limit": 1,
                "operation": operation,
                "matchedCount": result.matched_count,
                "modifiedCount": result.modified_count,
                "upsertedId": upserted_id
            }));
        }

        if operation == "deleteOne" {
            let result = collection
                .delete_one(filter)
                .await
                .map_err(|error| DbTunnelError::MongoQuery(error.to_string()).user_message())?;
            return Ok(json!({
                "documents": [{ "deletedCount": result.deleted_count }],
                "count": 1,
                "limit": 1,
                "operation": operation,
                "deletedCount": result.deleted_count
            }));
        }

        let mut find = collection.find(filter).limit(limit as i64);
        let projection = mongo_document_option_from_request(&request, "projection")?;
        if let Some(projection) = projection {
            find = find.projection(projection);
        }
        let sort = mongo_document_option_from_request(&request, "sort")?;
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
    })
    .await
    .map_err(|_| DbTunnelError::QueryTimeout.user_message())?
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
    let options = tokio::time::timeout(METADATA_TIMEOUT, MongoClientOptions::parse(&uri))
        .await
        .map_err(|_| DbTunnelError::QueryTimeout.user_message())?
        .map_err(|error| DbTunnelError::MongoConnect(error.to_string()).user_message())?;
    let client = MongoClient::with_options(options)
        .map_err(|error| DbTunnelError::MongoConnect(error.to_string()).user_message())?;
    tokio::time::timeout(
        METADATA_TIMEOUT,
        client
            .database(&config.auth_source)
            .run_command(doc! { "ping": 1 }),
    )
    .await
    .map_err(|_| DbTunnelError::QueryTimeout.user_message())?
    .map_err(|error| DbTunnelError::MongoConnect(error.to_string()).user_message())?;
    Ok(client)
}

fn mongo_client(state: &AppState, args: &[Value]) -> Result<MongoClient, String> {
    let connection_id = string_arg(args, 0)?;
    let session_id = string_arg(args, 1)?;
    let mut guard = state
        .database_tunnel_sessions
        .lock()
        .map_err(error_string)?;
    let session = guard
        .get_mut(&session_key("mongo", &connection_id, &session_id))
        .ok_or_else(|| DbTunnelError::SessionNotFound.user_message())?;
    session.touch();
    match session {
        DatabaseTunnelSession::Mongo(session) => Ok(session.client.clone()),
        other => Err(DbTunnelError::SessionKindMismatch {
            expected: "mongo",
            actual: other.kind(),
        }
        .user_message()),
    }
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

fn mongo_pipeline_from_request(request: &Value) -> Result<Vec<Document>, String> {
    let raw = request
        .get("pipeline")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("[]");
    let value = serde_json::from_str::<Value>(raw)
        .map_err(|error| format!("MongoDB pipeline JSON 无效：{error}"))?;
    let bson = Bson::try_from(value)
        .map_err(|error| format!("MongoDB pipeline Extended JSON 无效：{error}"))?;
    let Bson::Array(stages) = bson else {
        return Err("MongoDB pipeline 必须是 JSON 数组。".to_string());
    };

    stages
        .into_iter()
        .map(|stage| match stage {
            Bson::Document(document) => Ok(document),
            _ => Err("MongoDB pipeline 每个阶段都必须是 JSON 对象。".to_string()),
        })
        .collect()
}

fn bson_to_json(value: Bson) -> Value {
    value.into_relaxed_extjson()
}
