use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::{fs, path::PathBuf};

use crate::{error_string, now, AppState};

const MAX_SESSION_ID_LENGTH: usize = 160;
const MAX_TITLE_LENGTH: usize = 240;
const MAX_MESSAGE_CONTENT_LENGTH: usize = 2_000_000;

fn database_path(state: &AppState) -> PathBuf {
    state.data_dir.join("agent_sessions.sqlite")
}

fn open_database(state: &AppState) -> Result<Connection, String> {
    if let Some(parent) = database_path(state).parent() {
        fs::create_dir_all(parent).map_err(error_string)?;
    }
    let connection = Connection::open(database_path(state)).map_err(error_string)?;
    connection
        .execute_batch(
            "PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS agent_sessions (
               id TEXT PRIMARY KEY NOT NULL,
               kind TEXT NOT NULL CHECK(kind IN ('task', 'host')),
               host_id TEXT NOT NULL DEFAULT '',
               title TEXT NOT NULL,
               messages_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_agent_sessions_kind_updated ON agent_sessions(kind, updated_at DESC);",
        )
        .map_err(error_string)?;
    Ok(connection)
}

pub(crate) fn get_sessions(state: &AppState) -> Result<Value, String> {
    let connection = open_database(state)?;
    let mut statement = connection
        .prepare(
            "SELECT id, kind, host_id, title, messages_json, created_at, updated_at
             FROM agent_sessions ORDER BY updated_at DESC, rowid DESC",
        )
        .map_err(error_string)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(error_string)?;

    let mut tasks = Vec::new();
    let mut host_sessions = Map::new();
    for row in rows {
        let (id, kind, host_id, title, messages_json, created_at, updated_at) =
            row.map_err(error_string)?;
        let messages = serde_json::from_str::<Value>(&messages_json).unwrap_or_else(|_| json!([]));
        let session = json!({
            "id": id,
            "title": title,
            "messages": messages,
            "createdAt": created_at,
            "updatedAt": updated_at,
        });
        if kind == "host" && !host_id.is_empty() {
            host_sessions.insert(host_id, session);
        } else {
            tasks.push(session);
        }
    }

    Ok(json!({ "tasks": tasks, "hostSessions": host_sessions }))
}

pub(crate) fn save_session(state: &AppState, payload: Value) -> Result<Value, String> {
    let session = normalize_session(&payload)?;
    let connection = open_database(state)?;
    connection
        .execute(
            "INSERT INTO agent_sessions (id, kind, host_id, title, messages_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind,
               host_id = excluded.host_id,
               title = excluded.title,
               messages_json = excluded.messages_json,
               updated_at = excluded.updated_at",
            params![
                session.id,
                session.kind,
                session.host_id,
                session.title,
                serde_json::to_string(&session.messages).map_err(error_string)?,
                session.created_at,
                session.updated_at,
            ],
        )
        .map_err(error_string)?;
    Ok(session.to_value())
}

pub(crate) fn delete_session(state: &AppState, args: &[Value]) -> Result<Value, String> {
    let id = args
        .first()
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= MAX_SESSION_ID_LENGTH)
        .ok_or_else(|| "任务会话标识无效。".to_string())?;
    let connection = open_database(state)?;
    connection
        .execute("DELETE FROM agent_sessions WHERE id = ?1", [id])
        .map_err(error_string)?;
    Ok(json!(true))
}

struct AgentSessionRecord {
    id: String,
    kind: String,
    host_id: String,
    title: String,
    messages: Value,
    created_at: String,
    updated_at: String,
}

impl AgentSessionRecord {
    fn to_value(&self) -> Value {
        json!({
            "id": self.id,
            "kind": self.kind,
            "hostId": self.host_id,
            "title": self.title,
            "messages": self.messages,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }
}

fn normalize_session(payload: &Value) -> Result<AgentSessionRecord, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "任务会话内容无效。".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= MAX_SESSION_ID_LENGTH)
        .ok_or_else(|| "任务会话标识无效。".to_string())?
        .to_string();
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "task" | "host"))
        .ok_or_else(|| "任务会话类型无效。".to_string())?
        .to_string();
    let host_id = object
        .get("hostId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if kind == "host" && host_id.is_empty() {
        return Err("主机会话缺少主机标识。".to_string());
    }
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(MAX_TITLE_LENGTH)
        .collect::<String>();
    let messages = normalize_messages(object.get("messages"))?;
    let created_at = object
        .get("createdAt")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(now);
    let updated_at = object
        .get("updatedAt")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(now);

    Ok(AgentSessionRecord {
        id,
        kind,
        host_id,
        title,
        messages,
        created_at,
        updated_at,
    })
}

fn normalize_messages(value: Option<&Value>) -> Result<Value, String> {
    let Some(messages) = value.and_then(Value::as_array) else {
        return Ok(json!([]));
    };
    let mut normalized = Vec::with_capacity(messages.len());
    for message in messages {
        let Some(object) = message.as_object() else {
            continue;
        };
        let role = object.get("role").and_then(Value::as_str).unwrap_or("");
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        let content = object.get("content").and_then(Value::as_str).unwrap_or("");
        if content.len() > MAX_MESSAGE_CONTENT_LENGTH {
            return Err("任务消息过长。".to_string());
        }
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if id.is_empty() || id.len() > MAX_SESSION_ID_LENGTH {
            return Err("任务消息标识无效。".to_string());
        }
        let created_at = object
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        normalized.push(json!({
            "id": id,
            "role": role,
            "content": content,
            "createdAt": if created_at.is_empty() { now() } else { created_at.to_string() },
        }));
    }
    Ok(Value::Array(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_only_supported_chat_message_roles() {
        let value = json!({
            "id": "task-1", "kind": "task", "title": "Task", "messages": [
                { "id": "m1", "role": "user", "content": "hello", "createdAt": "2026-01-01T00:00:00Z" },
                { "id": "m2", "role": "system", "content": "ignore" }
            ]
        });
        let session = normalize_session(&value).expect("session should normalize");
        assert_eq!(session.messages.as_array().map(Vec::len), Some(1));
    }
}
