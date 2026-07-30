use crate::{error_string, read_json_file, string_arg, write_json_file_private, AppState};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    cmp::Reverse,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const TRANSFER_HISTORY_FILE: &str = "transfer-history.json";
const MAX_TRANSFER_HISTORY: usize = 200;

#[derive(Clone)]
pub(crate) struct TransferHistory {
    path: PathBuf,
    tasks: Arc<Mutex<Vec<Value>>>,
}

impl TransferHistory {
    pub(crate) fn new(data_dir: &Path) -> Self {
        let path = data_dir.join(TRANSFER_HISTORY_FILE);
        let mut tasks = read_json_file(&path, json!([]))
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(normalize_stored_task)
            .collect::<Vec<_>>();
        prune_tasks(&mut tasks);

        let history = Self {
            path,
            tasks: Arc::new(Mutex::new(tasks)),
        };
        let _ = history.persist();
        history
    }

    pub(crate) fn record_progress(&self, payload: &Value, persist: bool) -> Option<Value> {
        let id = transfer_id(payload)?;
        let now = Utc::now().to_rfc3339();
        let mut tasks = self.tasks.lock().ok()?;
        let task = tasks
            .iter_mut()
            .find(|task| task.get("id").and_then(Value::as_str) == Some(id.as_str()));
        let task = match task {
            Some(task) => task,
            None => {
                tasks.push(json!({
                    "id": id,
                    "createdAt": now,
                }));
                tasks.last_mut()?
            }
        };
        merge_transfer_payload(task, payload);
        task["status"] = json!("running");
        task["updatedAt"] = json!(now);
        task.as_object_mut()?.remove("finishedAt");
        task.as_object_mut()?.remove("error");
        task.as_object_mut()?.remove("errorCode");
        let snapshot = task.clone();
        prune_tasks(&mut tasks);
        drop(tasks);
        if persist {
            let _ = self.persist();
        }
        Some(snapshot)
    }

    pub(crate) fn record_end(&self, payload: &Value) -> Option<Value> {
        let id = transfer_id(payload)?;
        let now = Utc::now().to_rfc3339();
        let mut tasks = self.tasks.lock().ok()?;
        let task = tasks
            .iter_mut()
            .find(|task| task.get("id").and_then(Value::as_str) == Some(id.as_str()));
        let task = match task {
            Some(task) => task,
            None => {
                tasks.push(json!({
                    "id": id,
                    "createdAt": now,
                }));
                tasks.last_mut()?
            }
        };
        merge_transfer_payload(task, payload);
        let error = payload.get("error").and_then(Value::as_str).unwrap_or("");
        let status = if payload
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "completed"
        } else if error.contains("取消") || error.to_ascii_lowercase().contains("cancel") {
            "canceled"
        } else {
            "failed"
        };
        task["status"] = json!(status);
        task["updatedAt"] = json!(now);
        task["finishedAt"] = json!(now);
        if !error.is_empty() {
            task["error"] = json!(error);
        }
        let snapshot = task.clone();
        prune_tasks(&mut tasks);
        drop(tasks);
        let _ = self.persist();
        Some(snapshot)
    }

    pub(crate) fn list(&self) -> Value {
        let mut tasks = self
            .tasks
            .lock()
            .map(|tasks| tasks.clone())
            .unwrap_or_default();
        tasks.sort_by_key(|task| Reverse(task_timestamp(task)));
        json!(tasks)
    }

    pub(crate) fn remove(&self, id: &str) -> Result<bool, String> {
        let mut tasks = self.tasks.lock().map_err(error_string)?;
        let before = tasks.len();
        tasks.retain(|task| {
            let matches = task.get("id").and_then(Value::as_str) == Some(id);
            let running = task.get("status").and_then(Value::as_str) == Some("running");
            !matches || running
        });
        let removed = tasks.len() != before;
        drop(tasks);
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    pub(crate) fn clear_finished(&self) -> Result<u64, String> {
        let mut tasks = self.tasks.lock().map_err(error_string)?;
        let before = tasks.len();
        tasks.retain(|task| task.get("status").and_then(Value::as_str) == Some("running"));
        let removed = before.saturating_sub(tasks.len()) as u64;
        drop(tasks);
        if removed > 0 {
            self.persist()?;
        }
        Ok(removed)
    }

    fn persist(&self) -> Result<(), String> {
        let mut tasks = self.tasks.lock().map_err(error_string)?.clone();
        prune_tasks(&mut tasks);
        write_json_file_private(&self.path, &json!(tasks))
    }
}

fn transfer_id(payload: &Value) -> Option<String> {
    payload
        .get("queueId")
        .or_else(|| payload.get("clientId"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

fn merge_transfer_payload(task: &mut Value, payload: &Value) {
    let Some(task) = task.as_object_mut() else {
        return;
    };
    let Some(payload) = payload.as_object() else {
        return;
    };
    for key in [
        "queueId",
        "clientId",
        "connectionId",
        "hostId",
        "hostName",
        "type",
        "label",
        "fileName",
        "sourcePaths",
        "targetPath",
        "transferred",
        "total",
        "currentFileTransferred",
        "currentFileTotal",
        "completedFiles",
        "totalFiles",
        "completedItems",
        "totalItems",
        "phase",
        "discoveredFiles",
        "discoveredDirectories",
        "preparedDirectories",
        "totalDirectories",
    ] {
        if let Some(value) = payload.get(key) {
            task.insert(key.to_string(), value.clone());
        }
    }
}

fn normalize_stored_task(value: Value) -> Option<Value> {
    let mut task = value.as_object()?.clone();
    let id = task.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let status = task
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("failed");
    if status == "running" {
        task.insert("status".to_string(), json!("failed"));
        task.insert("errorCode".to_string(), json!("interrupted-on-exit"));
        let now = Utc::now().to_rfc3339();
        task.insert("updatedAt".to_string(), json!(now));
        task.insert("finishedAt".to_string(), json!(now));
    }
    Some(Value::Object(task))
}

fn task_timestamp(task: &Value) -> String {
    task.get("updatedAt")
        .or_else(|| task.get("createdAt"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn prune_tasks(tasks: &mut Vec<Value>) {
    tasks.sort_by_key(|task| Reverse(task_timestamp(task)));
    let mut finished_count = 0;
    tasks.retain(|task| {
        if task.get("status").and_then(Value::as_str) == Some("running") {
            return true;
        }
        finished_count += 1;
        finished_count <= MAX_TRANSFER_HISTORY
    });
}

pub(crate) fn list_transfers(state: &AppState) -> Value {
    state.transfer_history.list()
}

pub(crate) fn remove_transfer(state: &AppState, args: &[Value]) -> Result<Value, String> {
    let id = string_arg(args, 0)?;
    state.transfer_history.remove(&id).map(Value::Bool)
}

pub(crate) fn clear_finished_transfers(state: &AppState) -> Result<Value, String> {
    state
        .transfer_history
        .clear_finished()
        .map(|count| json!(count))
}

#[cfg(test)]
mod tests {
    use super::TransferHistory;
    use crate::random_id;
    use serde_json::json;
    use std::fs;

    #[test]
    fn transfer_history_persists_and_recovers_interrupted_tasks() {
        let directory = std::env::temp_dir().join(random_id("transfer-history-test"));
        fs::create_dir_all(&directory).unwrap();
        let history = TransferHistory::new(&directory);
        let progress = json!({
            "queueId": "queue-1",
            "connectionId": "connection-1",
            "type": "upload",
            "fileName": "archive.zip",
            "transferred": 128,
            "total": 1024,
        });
        history.record_progress(&progress, true).unwrap();

        let restored = TransferHistory::new(&directory).list();
        let task = restored.as_array().unwrap().first().unwrap();
        assert_eq!(task["id"], "queue-1");
        assert_eq!(task["status"], "failed");
        assert_eq!(task["transferred"], 128);
        assert_eq!(task["errorCode"], "interrupted-on-exit");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn active_tasks_cannot_be_dismissed() {
        let directory = std::env::temp_dir().join(random_id("transfer-history-test"));
        fs::create_dir_all(&directory).unwrap();
        let history = TransferHistory::new(&directory);
        history
            .record_progress(
                &json!({
                    "queueId": "queue-1",
                    "type": "download",
                    "fileName": "backup.tar",
                    "transferred": 0,
                    "total": 100,
                }),
                false,
            )
            .unwrap();

        assert!(!history.remove("queue-1").unwrap());
        assert_eq!(history.list().as_array().unwrap().len(), 1);
        fs::remove_dir_all(directory).unwrap();
    }
}
