use super::{download_sftp_paths, upload_sftp_paths};
use crate::{
    connection, error_string, get_connection, string_arg, ActiveTransfer, AppState, ConnectionKind,
};
use futures_util::{stream, StreamExt};
use serde_json::{json, Map, Value};
use std::{collections::HashSet, thread};
use tauri::{Emitter, Manager};

const DEFAULT_TRANSFER_CONCURRENCY: usize = 2;
const MAX_TRANSFER_CONCURRENCY: usize = 4;

#[derive(Clone)]
struct SftpTransferJob {
    id: String,
    direction: String,
    source_paths: Vec<String>,
    target_path: String,
    options: Value,
}

pub(crate) fn enqueue_sftp_transfers(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let connection = get_connection(&state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return Err("后台 SFTP 传输需要远程 SSH 连接。".to_string());
    }
    let concurrency = transfer_concurrency(args.get(2));
    let jobs = parse_jobs(&connection_id, args.get(1).and_then(Value::as_array))?;
    if jobs.is_empty() {
        return Ok(json!({ "queuedIds": [] }));
    }
    register_jobs(&state, &connection_id, &jobs)?;
    let queued_ids = jobs.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
    for job in &jobs {
        emit_queued_task(&state, &window, &connection_id, job);
    }

    let runtime_state = state.clone();
    let runtime_window = window.clone();
    let runtime_connection_id = connection_id.clone();
    let runtime_queued_ids = queued_ids.clone();
    let spawn_result = thread::Builder::new()
        .name(format!("sftp-transfer-{connection_id}"))
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            match runtime {
                Ok(runtime) => runtime.block_on(async move {
                    stream::iter(jobs)
                        .for_each_concurrent(Some(concurrency), |job| {
                            run_job(
                                runtime_state.clone(),
                                runtime_window.clone(),
                                runtime_connection_id.clone(),
                                job,
                            )
                        })
                        .await;
                }),
                Err(error) => {
                    fail_registered_jobs(
                        &runtime_state,
                        &runtime_window,
                        &runtime_connection_id,
                        &runtime_queued_ids,
                        &format!("创建后台传输运行时失败：{error}"),
                    );
                }
            }
        });
    if let Err(error) = spawn_result {
        fail_registered_jobs(
            &state,
            &window,
            &connection_id,
            &queued_ids,
            &format!("启动后台传输线程失败：{error}"),
        );
        return Err(error_string(error));
    }

    Ok(json!({ "queuedIds": queued_ids }))
}

async fn run_job(
    state: AppState,
    window: tauri::Window,
    connection_id: String,
    job: SftpTransferJob,
) {
    if transfer_is_canceled(&state, &job.id) {
        finish_runtime_job(&state, &window, &connection_id, &job.id, "canceled", None);
        return;
    }

    let args = if job.direction == "upload" {
        let items = job
            .source_paths
            .iter()
            .map(|path| json!({ "path": path }))
            .collect::<Vec<_>>();
        vec![
            json!(connection_id),
            json!(job.target_path),
            json!(items),
            job.options,
        ]
    } else {
        vec![
            json!(connection_id),
            json!(job.source_paths),
            json!(job.target_path),
            job.options,
        ]
    };
    let result = if job.direction == "upload" {
        upload_sftp_paths(state.clone(), window.clone(), args).await
    } else {
        download_sftp_paths(state.clone(), window.clone(), args).await
    };

    if let Err(error) = result {
        let canceled = error.contains("取消") || error.to_ascii_lowercase().contains("cancel");
        finish_runtime_job(
            &state,
            &window,
            &connection_id,
            &job.id,
            if canceled { "canceled" } else { "failed" },
            if canceled { None } else { Some(&error) },
        );
    } else {
        unregister_runtime_job(&state, &connection_id, &job.id);
    }
}

fn parse_jobs(
    connection_id: &str,
    values: Option<&Vec<Value>>,
) -> Result<Vec<SftpTransferJob>, String> {
    let mut jobs = Vec::new();
    let mut ids = HashSet::new();
    for value in values.into_iter().flatten() {
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "后台传输任务缺少 id。".to_string())?
            .to_string();
        if !ids.insert(id.clone()) {
            return Err(format!("后台传输任务 id 重复：{id}"));
        }
        let direction = value.get("direction").and_then(Value::as_str).unwrap_or("");
        if !matches!(direction, "upload" | "download") {
            return Err(format!("后台传输方向无效：{direction}"));
        }
        let source_paths = value
            .get("sourcePaths")
            .and_then(Value::as_array)
            .map(|paths| {
                paths
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if source_paths.is_empty() {
            return Err(format!("后台传输任务 {id} 没有来源路径。"));
        }
        let target_path = value
            .get("targetPath")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("后台传输任务 {id} 没有目标路径。"))?
            .to_string();
        let label = value
            .get("label")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                source_paths
                    .first()
                    .map(String::as_str)
                    .unwrap_or(direction)
            });
        let mut options = Map::new();
        options.insert("transferClientId".to_string(), json!(id));
        options.insert("queueId".to_string(), json!(id));
        options.insert("connectionId".to_string(), json!(connection_id));
        options.insert("label".to_string(), json!(label));
        options.insert("sourcePaths".to_string(), json!(source_paths));
        options.insert("targetPath".to_string(), json!(target_path));
        for (source_key, target_key) in [
            ("hostId", "hostId"),
            ("hostName", "hostName"),
            ("plannedSize", "expectedTotal"),
            ("plannedFileCount", "expectedFileCount"),
            ("conflictPolicy", "conflictPolicy"),
        ] {
            if let Some(option) = value.get(source_key).filter(|option| !option.is_null()) {
                options.insert(target_key.to_string(), option.clone());
            }
        }
        jobs.push(SftpTransferJob {
            id,
            direction: direction.to_string(),
            source_paths,
            target_path,
            options: Value::Object(options),
        });
    }
    Ok(jobs)
}

fn register_jobs(
    state: &AppState,
    connection_id: &str,
    jobs: &[SftpTransferJob],
) -> Result<(), String> {
    let mut active_transfers = state.active_transfers.lock().map_err(error_string)?;
    if let Some(job) = jobs
        .iter()
        .find(|job| active_transfers.contains_key(&job.id))
    {
        return Err(format!("传输任务已在运行：{}", job.id));
    }
    for job in jobs {
        active_transfers.insert(
            job.id.clone(),
            ActiveTransfer {
                connection_id: connection_id.to_string(),
                client_id: Some(job.id.clone()),
            },
        );
    }
    Ok(())
}

fn emit_queued_task(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
    job: &SftpTransferJob,
) {
    let payload = json!({
        "connectionId": connection_id,
        "queueId": job.id,
        "clientId": job.id,
        "hostId": job.options.get("hostId").cloned().unwrap_or(Value::Null),
        "hostName": job.options.get("hostName").cloned().unwrap_or(Value::Null),
        "type": job.direction,
        "label": job.options.get("label").cloned().unwrap_or(Value::Null),
        "sourcePaths": job.source_paths,
        "targetPath": job.target_path,
        "fileName": job.options.get("label").cloned().unwrap_or_else(|| json!(job.direction)),
        "transferred": 0,
        "total": job.options.get("expectedTotal").and_then(Value::as_u64).unwrap_or(0),
        "completedFiles": 0,
        "totalFiles": job.options.get("expectedFileCount").and_then(Value::as_u64).unwrap_or(0),
        "completedItems": 0,
        "totalItems": job.options.get("expectedFileCount").and_then(Value::as_u64).unwrap_or(0),
        "phase": "planning",
    });
    if let Some(task) = state.transfer_history.record_queued(&payload) {
        let _ = window.app_handle().emit("transfer:task-changed", task);
    }
}

fn transfer_is_canceled(state: &AppState, id: &str) -> bool {
    state
        .transfer_cancellations
        .lock()
        .map(|cancellations| cancellations.contains(id))
        .unwrap_or(false)
}

fn finish_runtime_job(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
    id: &str,
    status: &str,
    error: Option<&str>,
) {
    if let Some(task) = state
        .transfer_history
        .record_terminal_status(id, status, error)
    {
        let _ = window.app_handle().emit("transfer:task-changed", task);
    }
    unregister_runtime_job(state, connection_id, id);
}

fn unregister_runtime_job(state: &AppState, connection_id: &str, id: &str) {
    if let Ok(mut active_transfers) = state.active_transfers.lock() {
        active_transfers.remove(id);
    }
    if let Ok(mut cancellations) = state.transfer_cancellations.lock() {
        cancellations.remove(id);
    }
    let _ = connection::finish_deferred_connection_close(state, connection_id);
}

fn fail_registered_jobs(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
    ids: &[String],
    error: &str,
) {
    for id in ids {
        finish_runtime_job(state, window, connection_id, id, "failed", Some(error));
    }
}

fn transfer_concurrency(value: Option<&Value>) -> usize {
    value
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TRANSFER_CONCURRENCY as u64)
        .clamp(1, MAX_TRANSFER_CONCURRENCY as u64) as usize
}

#[cfg(test)]
mod tests {
    use super::{parse_jobs, transfer_concurrency};
    use serde_json::json;

    #[test]
    fn parses_runtime_jobs_into_existing_sftp_options() {
        let jobs = parse_jobs(
            "connection-1",
            Some(&vec![json!({
                "id": "queue-1",
                "direction": "upload",
                "label": "release.zip",
                "sourcePaths": ["D:/release.zip"],
                "targetPath": "/srv/releases",
                "plannedSize": 1024,
                "plannedFileCount": 1,
                "conflictPolicy": "skip",
                "hostId": "host-1",
                "hostName": "Production",
            })]),
        )
        .unwrap();

        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, "queue-1");
        assert_eq!(jobs[0].options["queueId"], "queue-1");
        assert_eq!(jobs[0].options["expectedTotal"], 1024);
        assert_eq!(jobs[0].options["conflictPolicy"], "skip");
    }

    #[test]
    fn transfer_concurrency_is_bounded() {
        assert_eq!(transfer_concurrency(None), 2);
        assert_eq!(transfer_concurrency(Some(&json!(0))), 1);
        assert_eq!(transfer_concurrency(Some(&json!(3))), 3);
        assert_eq!(transfer_concurrency(Some(&json!(99))), 4);
    }
}
