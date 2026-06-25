use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tauri::Emitter;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time,
};

use crate::{error_string, prevent_tokio_process_window};

pub(crate) async fn run_shell(
    command: String,
    stdin: &str,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    let mut child = if cfg!(windows) {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &command,
        ]);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", &command]);
        cmd
    };
    prevent_tokio_process_window(&mut child);

    let mut child = child
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(error_string)?;

    if let Some(mut child_stdin) = child.stdin.take() {
        if !stdin.is_empty() {
            child_stdin
                .write_all(stdin.as_bytes())
                .await
                .map_err(error_string)?;
        }
    }

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Process stdout is unavailable.".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Process stderr is unavailable.".to_string())?;
    let stdout_task = tokio::spawn(async move {
        let mut output = Vec::new();
        stdout
            .read_to_end(&mut output)
            .await
            .map_err(error_string)?;
        Ok::<Vec<u8>, String>(output)
    });
    let stderr_task = tokio::spawn(async move {
        let mut output = Vec::new();
        stderr
            .read_to_end(&mut output)
            .await
            .map_err(error_string)?;
        Ok::<Vec<u8>, String>(output)
    });
    let status = if let Some(timeout) = timeout {
        match time::timeout(timeout, child.wait()).await {
            Ok(result) => result.map_err(error_string)?,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                return Err(format!(
                    "Command timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
        }
    } else {
        child.wait().await.map_err(error_string)?
    };
    let stdout = stdout_task.await.map_err(error_string)??;
    let stderr = stderr_task.await.map_err(error_string)??;
    Ok(json!({
        "stdout": String::from_utf8_lossy(&stdout),
        "stderr": String::from_utf8_lossy(&stderr),
        "code": status.code().unwrap_or(-1),
        "signal": null,
        "success": status.success()
    }))
}

pub(crate) async fn run_shell_stream(
    command: String,
    stdin: String,
    timeout: Option<Duration>,
    window: tauri::Window,
    stream_id: String,
) -> Result<Value, String> {
    let mut child = if cfg!(windows) {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &command,
        ]);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", &command]);
        cmd
    };
    prevent_tokio_process_window(&mut child);

    let mut child = child
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(error_string)?;

    run_spawned_command_stream(
        &mut child,
        stdin,
        timeout,
        window,
        stream_id,
        "Command timed out.",
    )
    .await
}

pub(crate) async fn run_spawned_command_stream(
    child: &mut tokio::process::Child,
    stdin: String,
    timeout: Option<Duration>,
    window: tauri::Window,
    stream_id: String,
    timeout_message: &str,
) -> Result<Value, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Process stdout is unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Process stderr is unavailable.".to_string())?;
    let stdout_task = tokio::spawn(read_process_stream(
        stdout,
        window.clone(),
        stream_id.clone(),
        "stdout",
    ));
    let stderr_task = tokio::spawn(read_process_stream(
        stderr,
        window.clone(),
        stream_id.clone(),
        "stderr",
    ));

    if let Some(mut child_stdin) = child.stdin.take() {
        if !stdin.is_empty() {
            child_stdin
                .write_all(stdin.as_bytes())
                .await
                .map_err(error_string)?;
        }
    }

    let status = if let Some(timeout) = timeout {
        match time::timeout(timeout, child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(error)) => return Err(error_string(error)),
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                return Err(timeout_message.to_string());
            }
        }
    } else {
        child.wait().await.map_err(error_string)?
    };

    let stdout = stdout_task.await.map_err(error_string)??;
    let stderr = stderr_task.await.map_err(error_string)??;
    Ok(json!({
        "stdout": stdout,
        "stderr": stderr,
        "code": status.code().unwrap_or(-1),
        "signal": null,
        "success": status.success()
    }))
}

async fn read_process_stream<R>(
    mut reader: R,
    window: tauri::Window,
    stream_id: String,
    stream_name: &'static str,
) -> Result<String, String>
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 8192];
    let mut output = Vec::new();
    loop {
        let read = reader.read(&mut buffer).await.map_err(error_string)?;
        if read == 0 {
            break;
        }
        output.extend_from_slice(&buffer[..read]);
        let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
        let _ = window.emit(
            "connection:run-command-stream:chunk",
            json!({ "streamId": stream_id, "chunk": chunk, "stream": stream_name }),
        );
    }
    Ok(String::from_utf8_lossy(&output).to_string())
}
