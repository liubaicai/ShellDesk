use chrono::Utc;
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

#[cfg(windows)]
use crate::prevent_process_window;
use crate::{error_string, string_arg};

const MAX_REMOTE_TEXT_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_REMOTE_TEXT_WRITE_BYTES: usize = 10 * 1024 * 1024;

pub(crate) fn list_local_directory(args: Vec<Value>) -> Result<Value, String> {
    let path = path_arg(&args, 1)?;
    #[cfg(windows)]
    if path == *"/" {
        return list_windows_drive_roots();
    }
    let metadata = fs::metadata(&path).map_err(error_string)?;
    if !metadata.is_dir() {
        return Err("本地路径不是目录。".to_string());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(error_string)? {
        let Ok(entry) = entry else {
            continue;
        };
        if let Some(value) = local_directory_entry(&entry) {
            entries.push(value);
        }
    }
    Ok(json!({
        "path": display_path(&path),
        "entries": entries
    }))
}

pub(crate) fn stat_local_path(args: Vec<Value>) -> Result<Value, String> {
    let path = path_arg(&args, 1)?;
    let metadata = fs::symlink_metadata(&path).map_err(error_string)?;
    Ok(json!({
        "type": local_entry_type(&metadata),
        "size": metadata.len(),
        "mode": metadata_mode(&metadata),
        "owner": metadata_owner(&metadata),
        "group": metadata_group(&metadata),
        "modifiedAt": system_time_to_iso(metadata.modified().ok()),
        "accessedAt": system_time_to_iso(metadata.accessed().ok())
    }))
}

pub(crate) fn read_local_file(args: Vec<Value>) -> Result<Value, String> {
    let path = path_arg(&args, 1)?;
    let options = args.get(2).cloned().unwrap_or(Value::Null);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if should_retry_local_with_windows_elevation(&error) => {
            return read_local_file_with_windows_elevation(&path);
        }
        Err(error) if should_retry_local_with_sudo(&error, &options) => {
            return read_local_file_with_sudo(&path, &options);
        }
        Err(error) => return Err(error_string(error)),
    };
    if !metadata.is_file() {
        return Err("只能用记事本打开本地文件。".to_string());
    }
    if metadata.len() > MAX_REMOTE_TEXT_FILE_BYTES {
        return Err(format!(
            "文件超过 {} MB，请用本地编辑器打开。",
            MAX_REMOTE_TEXT_FILE_BYTES / 1024 / 1024
        ));
    }
    match fs::read_to_string(&path) {
        Ok(value) => Ok(json!(value)),
        Err(error) if should_retry_local_with_windows_elevation(&error) => {
            read_local_file_with_windows_elevation(&path)
        }
        Err(error) if should_retry_local_with_sudo(&error, &options) => {
            read_local_file_with_sudo(&path, &options)
        }
        Err(error) => Err(error_string(error)),
    }
}

pub(crate) fn write_local_file(args: Vec<Value>) -> Result<Value, String> {
    let path = path_arg(&args, 1)?;
    assert_mutable_local_path(&path)?;
    let content = args.get(2).and_then(Value::as_str).unwrap_or("");
    let options = args.get(3).cloned().unwrap_or(Value::Null);
    if content.len() > MAX_REMOTE_TEXT_WRITE_BYTES {
        return Err(format!(
            "文件内容超过 {} MB，请使用本地编辑器保存大文件。",
            MAX_REMOTE_TEXT_WRITE_BYTES / 1024 / 1024
        ));
    }
    match fs::write(&path, content) {
        Ok(()) => Ok(json!(true)),
        Err(error) if should_retry_local_with_windows_elevation(&error) => {
            write_local_file_with_windows_elevation(&path, content)
        }
        Err(error) if should_retry_local_with_sudo(&error, &options) => {
            write_local_file_with_sudo(&path, content, &options)
        }
        Err(error) => Err(error_string(error)),
    }
}

pub(crate) fn create_local_directory(args: Vec<Value>) -> Result<Value, String> {
    let path = path_arg(&args, 1)?;
    assert_mutable_local_path(&path)?;
    let options = args.get(2).cloned().unwrap_or(Value::Null);
    match fs::create_dir(&path) {
        Ok(()) => Ok(json!(true)),
        Err(error) if should_retry_local_with_windows_elevation(&error) => {
            create_local_directory_with_windows_elevation(&path)
        }
        Err(error) if should_retry_local_with_sudo(&error, &options) => {
            create_local_directory_with_sudo(&path, &options)
        }
        Err(error) => Err(error_string(error)),
    }
}

pub(crate) fn create_local_file(args: Vec<Value>) -> Result<Value, String> {
    let path = path_arg(&args, 1)?;
    assert_mutable_local_path(&path)?;
    let options = args.get(2).cloned().unwrap_or(Value::Null);
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
    {
        Ok(_file) => Ok(json!(true)),
        Err(error) if should_retry_local_with_windows_elevation(&error) => {
            create_local_file_with_windows_elevation(&path)
        }
        Err(error) if should_retry_local_with_sudo(&error, &options) => {
            create_local_file_with_sudo(&path, &options)
        }
        Err(error) => Err(error_string(error)),
    }
}

pub(crate) fn delete_local_path(args: Vec<Value>) -> Result<Value, String> {
    let path = path_arg(&args, 1)?;
    assert_mutable_local_path(&path)?;
    let entry_type = args.get(2).and_then(Value::as_str).unwrap_or("file");
    let options = args.get(3).cloned().unwrap_or(Value::Null);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if should_retry_local_with_windows_elevation(&error) => {
            return delete_local_path_with_windows_elevation(&path, entry_type);
        }
        Err(error) if should_retry_local_with_sudo(&error, &options) => {
            return delete_local_path_with_sudo(&path, entry_type, &options);
        }
        Err(error) => return Err(error_string(error)),
    };
    let result = if metadata.is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    match result {
        Ok(()) => Ok(json!(true)),
        Err(error) if should_retry_local_with_windows_elevation(&error) => {
            delete_local_path_with_windows_elevation(&path, entry_type)
        }
        Err(error) if should_retry_local_with_sudo(&error, &options) => {
            delete_local_path_with_sudo(&path, entry_type, &options)
        }
        Err(error) => Err(error_string(error)),
    }
}

pub(crate) fn rename_local_path(args: Vec<Value>) -> Result<Value, String> {
    let old_path = path_arg(&args, 1)?;
    let new_path = path_arg(&args, 2)?;
    assert_mutable_local_path(&old_path)?;
    assert_mutable_local_path(&new_path)?;
    let options = args.get(3).cloned().unwrap_or(Value::Null);
    match fs::rename(&old_path, &new_path) {
        Ok(()) => Ok(json!(true)),
        Err(error) if should_retry_local_with_windows_elevation(&error) => {
            rename_local_path_with_windows_elevation(&old_path, &new_path)
        }
        Err(error) if should_retry_local_with_sudo(&error, &options) => {
            rename_local_path_with_sudo(&old_path, &new_path, &options)
        }
        Err(error) => Err(error_string(error)),
    }
}

pub(crate) fn set_local_path_permissions(args: Vec<Value>) -> Result<Value, String> {
    let path = path_arg(&args, 1)?;
    assert_mutable_local_path(&path)?;
    let options = args.get(2).cloned().unwrap_or_else(|| json!({}));
    let mode = options.get("mode").and_then(Value::as_u64).unwrap_or(0o644) as u32;
    let recursive = options
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    #[cfg(windows)]
    {
        let _ = (mode, recursive);
        Err("Windows 本地路径权限编辑暂不支持 chmod 语义。".to_string())
    }

    #[cfg(unix)]
    {
        match set_unix_permissions(&path, mode, recursive) {
            Ok(()) => Ok(json!(true)),
            Err(error) if should_retry_local_with_sudo(&error, &options) => {
                set_local_path_permissions_with_sudo(&path, mode, recursive, &options)
            }
            Err(error) => Err(error_string(error)),
        }
    }
}

fn path_arg(args: &[Value], index: usize) -> Result<PathBuf, String> {
    string_arg(args, index).map(normalize_local_path)
}

fn sudo_password(options: &Value) -> Option<String> {
    options
        .get("sudoPassword")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn should_retry_local_with_sudo(error: &io::Error, options: &Value) -> bool {
    cfg!(unix)
        && error.kind() == io::ErrorKind::PermissionDenied
        && sudo_password(options).is_some()
}

fn should_retry_local_with_windows_elevation(error: &io::Error) -> bool {
    cfg!(windows) && error.kind() == io::ErrorKind::PermissionDenied
}

fn local_sudo_read_args(path: &Path) -> Vec<String> {
    vec![
        "-S".to_string(),
        "-p".to_string(),
        String::new(),
        "--".to_string(),
        "sh".to_string(),
        "-c".to_string(),
        "test -f \"$1\" || { printf '%s\\n' '只能用记事本打开本地文件。' >&2; exit 2; }; size=$(wc -c < \"$1\" | tr -d ' '); if [ \"${size:-0}\" -gt \"$2\" ]; then printf '%s\\n' '文件超过 5 MB，请用本地编辑器打开。' >&2; exit 3; fi; cat -- \"$1\"".to_string(),
        "shelldesk".to_string(),
        path.to_string_lossy().to_string(),
        MAX_REMOTE_TEXT_FILE_BYTES.to_string(),
    ]
}

fn local_sudo_write_args(path: &Path) -> Vec<String> {
    vec![
        "-S".to_string(),
        "-p".to_string(),
        String::new(),
        "--".to_string(),
        "sh".to_string(),
        "-c".to_string(),
        "cat > \"$1\"".to_string(),
        "shelldesk".to_string(),
        path.to_string_lossy().to_string(),
    ]
}

fn local_sudo_create_directory_args(path: &Path) -> Vec<String> {
    local_sudo_shell_args("mkdir \"$1\"", &[path.to_string_lossy().to_string()])
}

fn local_sudo_create_file_args(path: &Path) -> Vec<String> {
    local_sudo_shell_args("set -C; : > \"$1\"", &[path.to_string_lossy().to_string()])
}

fn local_sudo_delete_path_args(path: &Path, entry_type: &str) -> Vec<String> {
    let command = if entry_type == "directory" {
        "rm -rf \"$1\""
    } else {
        "rm -f \"$1\""
    };
    local_sudo_shell_args(command, &[path.to_string_lossy().to_string()])
}

fn local_sudo_rename_path_args(old_path: &Path, new_path: &Path) -> Vec<String> {
    local_sudo_shell_args(
        "mv \"$1\" \"$2\"",
        &[
            old_path.to_string_lossy().to_string(),
            new_path.to_string_lossy().to_string(),
        ],
    )
}

#[cfg(any(unix, test))]
fn local_sudo_chmod_args(path: &Path, mode: u32, recursive: bool) -> Vec<String> {
    let command = if recursive {
        "chmod -R \"$1\" \"$2\""
    } else {
        "chmod \"$1\" \"$2\""
    };
    local_sudo_shell_args(
        command,
        &[format!("{:o}", mode), path.to_string_lossy().to_string()],
    )
}

fn local_sudo_shell_args(command: &str, command_args: &[String]) -> Vec<String> {
    let mut args = vec![
        "-S".to_string(),
        "-p".to_string(),
        String::new(),
        "--".to_string(),
        "sh".to_string(),
        "-c".to_string(),
        command.to_string(),
        "shelldesk".to_string(),
    ];
    args.extend(command_args.iter().cloned());
    args
}

fn run_local_sudo(args: Vec<String>, stdin: String) -> Result<Vec<u8>, String> {
    #[cfg(not(unix))]
    {
        let _ = (args, stdin);
        Err("当前平台不支持 sudo 本地提权。".to_string())
    }

    #[cfg(unix)]
    {
        use std::{
            io::Write,
            process::{Command, Stdio},
        };

        let mut child = Command::new("sudo")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(error_string)?;
        if let Some(mut child_stdin) = child.stdin.take() {
            child_stdin
                .write_all(stdin.as_bytes())
                .map_err(error_string)?;
        }
        let output = child.wait_with_output().map_err(error_string)?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Err(if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!(
                    "sudo 命令失败，退出码 {}",
                    output.status.code().unwrap_or(-1)
                )
            })
        }
    }
}

fn read_local_file_with_sudo(path: &Path, options: &Value) -> Result<Value, String> {
    let password =
        sudo_password(options).ok_or_else(|| "需要 sudo 密码才能读取该本地文件。".to_string())?;
    let stdout = run_local_sudo(local_sudo_read_args(path), format!("{password}\n"))?;
    if stdout.len() > MAX_REMOTE_TEXT_FILE_BYTES as usize {
        return Err(format!(
            "文件超过 {} MB，请用本地编辑器打开。",
            MAX_REMOTE_TEXT_FILE_BYTES / 1024 / 1024
        ));
    }
    String::from_utf8(stdout)
        .map(|value| json!(value))
        .map_err(|_| "本地文件不是有效的 UTF-8 文本。".to_string())
}

fn write_local_file_with_sudo(
    path: &Path,
    content: &str,
    options: &Value,
) -> Result<Value, String> {
    let password =
        sudo_password(options).ok_or_else(|| "需要 sudo 密码才能写入该本地文件。".to_string())?;
    run_local_sudo(
        local_sudo_write_args(path),
        format!("{password}\n{content}"),
    )?;
    Ok(json!(true))
}

fn create_local_directory_with_sudo(path: &Path, options: &Value) -> Result<Value, String> {
    let password =
        sudo_password(options).ok_or_else(|| "需要 sudo 密码才能创建该本地目录。".to_string())?;
    run_local_sudo(
        local_sudo_create_directory_args(path),
        format!("{password}\n"),
    )?;
    Ok(json!(true))
}

fn create_local_file_with_sudo(path: &Path, options: &Value) -> Result<Value, String> {
    let password =
        sudo_password(options).ok_or_else(|| "需要 sudo 密码才能创建该本地文件。".to_string())?;
    run_local_sudo(local_sudo_create_file_args(path), format!("{password}\n"))?;
    Ok(json!(true))
}

fn delete_local_path_with_sudo(
    path: &Path,
    entry_type: &str,
    options: &Value,
) -> Result<Value, String> {
    let password =
        sudo_password(options).ok_or_else(|| "需要 sudo 密码才能删除该本地路径。".to_string())?;
    run_local_sudo(
        local_sudo_delete_path_args(path, entry_type),
        format!("{password}\n"),
    )?;
    Ok(json!(true))
}

fn rename_local_path_with_sudo(
    old_path: &Path,
    new_path: &Path,
    options: &Value,
) -> Result<Value, String> {
    let password =
        sudo_password(options).ok_or_else(|| "需要 sudo 密码才能重命名该本地路径。".to_string())?;
    run_local_sudo(
        local_sudo_rename_path_args(old_path, new_path),
        format!("{password}\n"),
    )?;
    Ok(json!(true))
}

#[cfg(unix)]
fn set_local_path_permissions_with_sudo(
    path: &Path,
    mode: u32,
    recursive: bool,
    options: &Value,
) -> Result<Value, String> {
    let password = sudo_password(options)
        .ok_or_else(|| "需要 sudo 密码才能修改该本地路径权限。".to_string())?;
    run_local_sudo(
        local_sudo_chmod_args(path, mode, recursive),
        format!("{password}\n"),
    )?;
    Ok(json!(true))
}

#[cfg(windows)]
fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn windows_elevated_temp_dir(kind: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "shelldesk-{}-{}-{}",
        kind,
        std::process::id(),
        Utc::now().timestamp_millis()
    ))
}

#[cfg(windows)]
fn windows_elevated_operation_script(script_body: &str, result_path: &Path) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$resultPath = {result_path}
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
try {{
{script_body}
  [System.IO.File]::WriteAllText($resultPath, (@{{ ok = $true }} | ConvertTo-Json -Compress), $utf8NoBom)
  exit 0
}} catch {{
  [System.IO.File]::WriteAllText($resultPath, (@{{ ok = $false; error = $_.Exception.Message }} | ConvertTo-Json -Compress), $utf8NoBom)
  exit 1
}}
"#,
        result_path = powershell_single_quote(&result_path.to_string_lossy())
    )
}

#[cfg(windows)]
fn windows_elevated_launcher_script(operation_script_path: &Path) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  {operation_script_path}
) -Verb RunAs -Wait -PassThru
if ($null -ne $process.ExitCode) {{
  exit $process.ExitCode
}}
"#,
        operation_script_path = powershell_single_quote(&operation_script_path.to_string_lossy())
    )
}

#[cfg(windows)]
fn run_windows_elevated_powershell(script_body: &str) -> Result<(), String> {
    use std::process::Command;

    let temp_dir = windows_elevated_temp_dir("elevated");
    let operation_script_path = temp_dir.join("operation.ps1");
    let launcher_script_path = temp_dir.join("launch.ps1");
    let result_path = temp_dir.join("result.json");
    fs::create_dir_all(&temp_dir).map_err(error_string)?;
    fs::write(
        &operation_script_path,
        windows_elevated_operation_script(script_body, &result_path),
    )
    .map_err(error_string)?;
    fs::write(
        &launcher_script_path,
        windows_elevated_launcher_script(&operation_script_path),
    )
    .map_err(error_string)?;

    let mut command = Command::new("powershell.exe");
    prevent_process_window(&mut command);
    let output = command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&launcher_script_path)
        .current_dir(&temp_dir)
        .output()
        .map_err(error_string);

    let result = match output {
        Ok(output) => {
            let result_text = fs::read_to_string(&result_path);
            match result_text {
                Ok(text) => {
                    let payload: Value = serde_json::from_str(text.trim()).map_err(error_string)?;
                    if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                        Ok(())
                    } else {
                        Err(payload
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("提权操作失败。")
                            .to_string())
                    }
                }
                Err(error) => {
                    if output.status.success() {
                        Err("提权操作没有返回执行结果。".to_string())
                    } else {
                        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        Err(if !stderr.is_empty() {
                            stderr
                        } else if !stdout.is_empty() {
                            stdout
                        } else if error.kind() == io::ErrorKind::NotFound {
                            "管理员授权已取消或提权操作未完成。".to_string()
                        } else {
                            error_string(error)
                        })
                    }
                }
            }
        }
        Err(error) => Err(error),
    };

    let _ = fs::remove_dir_all(&temp_dir);
    result
}

#[cfg(windows)]
fn read_local_file_with_windows_elevation(path: &Path) -> Result<Value, String> {
    let temp_dir = windows_elevated_temp_dir("read");
    fs::create_dir_all(&temp_dir).map_err(error_string)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("file.txt");
    let temp_file = temp_dir.join(file_name);
    let script = format!(
        r#"if (-not (Test-Path -LiteralPath {source} -PathType Leaf)) {{
  throw '只能用记事本打开本地文件。'
}}
Copy-Item -LiteralPath {source} -Destination {destination} -Force -ErrorAction Stop"#,
        source = powershell_single_quote(&path.to_string_lossy()),
        destination = powershell_single_quote(&temp_file.to_string_lossy())
    );
    let result = run_windows_elevated_powershell(&script).and_then(|()| {
        let metadata = fs::metadata(&temp_file).map_err(error_string)?;
        if metadata.len() > MAX_REMOTE_TEXT_FILE_BYTES {
            return Err(format!(
                "文件超过 {} MB，请用本地编辑器打开。",
                MAX_REMOTE_TEXT_FILE_BYTES / 1024 / 1024
            ));
        }
        fs::read_to_string(&temp_file)
            .map(|value| json!(value))
            .map_err(error_string)
    });
    let _ = fs::remove_dir_all(&temp_dir);
    result
}

#[cfg(not(windows))]
fn read_local_file_with_windows_elevation(_path: &Path) -> Result<Value, String> {
    Err("当前平台不支持 Windows UAC 本地提权。".to_string())
}

#[cfg(windows)]
fn write_local_file_with_windows_elevation(path: &Path, content: &str) -> Result<Value, String> {
    let temp_dir = windows_elevated_temp_dir("write");
    fs::create_dir_all(&temp_dir).map_err(error_string)?;
    let temp_file = temp_dir.join("content.txt");
    fs::write(&temp_file, content).map_err(error_string)?;
    let script = format!(
        "Copy-Item -LiteralPath {source} -Destination {destination} -Force -ErrorAction Stop",
        source = powershell_single_quote(&temp_file.to_string_lossy()),
        destination = powershell_single_quote(&path.to_string_lossy())
    );
    let result = run_windows_elevated_powershell(&script).map(|()| json!(true));
    let _ = fs::remove_dir_all(&temp_dir);
    result
}

#[cfg(not(windows))]
fn write_local_file_with_windows_elevation(_path: &Path, _content: &str) -> Result<Value, String> {
    Err("当前平台不支持 Windows UAC 本地提权。".to_string())
}

#[cfg(windows)]
fn create_local_directory_with_windows_elevation(path: &Path) -> Result<Value, String> {
    let script = format!(
        "New-Item -ItemType Directory -LiteralPath {} -ErrorAction Stop | Out-Null",
        powershell_single_quote(&path.to_string_lossy())
    );
    run_windows_elevated_powershell(&script).map(|()| json!(true))
}

#[cfg(not(windows))]
fn create_local_directory_with_windows_elevation(_path: &Path) -> Result<Value, String> {
    Err("当前平台不支持 Windows UAC 本地提权。".to_string())
}

#[cfg(windows)]
fn create_local_file_with_windows_elevation(path: &Path) -> Result<Value, String> {
    let target = powershell_single_quote(&path.to_string_lossy());
    let script = format!(
        r#"if (Test-Path -LiteralPath {target}) {{
  throw '文件已存在。'
}}
New-Item -ItemType File -LiteralPath {target} -ErrorAction Stop | Out-Null"#,
    );
    run_windows_elevated_powershell(&script).map(|()| json!(true))
}

#[cfg(not(windows))]
fn create_local_file_with_windows_elevation(_path: &Path) -> Result<Value, String> {
    Err("当前平台不支持 Windows UAC 本地提权。".to_string())
}

#[cfg(windows)]
fn delete_local_path_with_windows_elevation(
    path: &Path,
    entry_type: &str,
) -> Result<Value, String> {
    let recurse = if entry_type == "directory" {
        " -Recurse"
    } else {
        ""
    };
    let script = format!(
        "Remove-Item -LiteralPath {} -Force{} -ErrorAction Stop",
        powershell_single_quote(&path.to_string_lossy()),
        recurse
    );
    run_windows_elevated_powershell(&script).map(|()| json!(true))
}

#[cfg(not(windows))]
fn delete_local_path_with_windows_elevation(
    _path: &Path,
    _entry_type: &str,
) -> Result<Value, String> {
    Err("当前平台不支持 Windows UAC 本地提权。".to_string())
}

#[cfg(windows)]
fn rename_local_path_with_windows_elevation(
    old_path: &Path,
    new_path: &Path,
) -> Result<Value, String> {
    let script = format!(
        "Move-Item -LiteralPath {} -Destination {} -ErrorAction Stop",
        powershell_single_quote(&old_path.to_string_lossy()),
        powershell_single_quote(&new_path.to_string_lossy())
    );
    run_windows_elevated_powershell(&script).map(|()| json!(true))
}

#[cfg(not(windows))]
fn rename_local_path_with_windows_elevation(
    _old_path: &Path,
    _new_path: &Path,
) -> Result<Value, String> {
    Err("当前平台不支持 Windows UAC 本地提权。".to_string())
}

fn normalize_local_path(raw_path: String) -> PathBuf {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == "~" {
        return dirs::home_dir()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
    }

    #[cfg(windows)]
    {
        if trimmed == "/" {
            return PathBuf::from("/");
        }
        let without_leading_drive_slash = trimmed
            .strip_prefix('/')
            .filter(|value| value.len() >= 2 && value.as_bytes()[1] == b':')
            .unwrap_or(trimmed);
        let native_path = without_leading_drive_slash.replace('/', "\\");
        let drive_root = native_path.as_bytes();
        if native_path.len() == 2 && drive_root[1] == b':' {
            return PathBuf::from(format!("{native_path}\\"));
        }
        let path = PathBuf::from(&native_path);
        if path.is_absolute() {
            return path;
        }
        dirs::home_dir()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."))
            .join(path)
    }

    #[cfg(not(windows))]
    {
        let path = PathBuf::from(trimmed);
        if path.is_absolute() {
            path
        } else {
            dirs::home_dir()
                .or_else(|| std::env::current_dir().ok())
                .unwrap_or_else(|| PathBuf::from("."))
                .join(path)
        }
    }
}

fn assert_mutable_local_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path == Path::new("/") {
        return Err("不允许对该本地路径执行管理操作。".to_string());
    }
    if let Some(home) = dirs::home_dir() {
        if path == home {
            return Err("不允许对该本地路径执行管理操作。".to_string());
        }
    }
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        let normalized = text.trim_end_matches(['\\', '/']);
        if normalized.len() == 2 && normalized.as_bytes()[1] == b':' {
            return Err("不允许对该本地路径执行管理操作。".to_string());
        }
    }
    Ok(())
}

fn local_directory_entry(entry: &fs::DirEntry) -> Option<Value> {
    let metadata = entry.metadata().ok()?;
    let symlink_metadata = entry.path().symlink_metadata().ok().unwrap_or(metadata);
    let entry_type = local_entry_type(&symlink_metadata);
    let mut value = json!({
        "name": entry.file_name().to_string_lossy(),
        "longname": entry.file_name().to_string_lossy(),
        "type": entry_type,
        "size": if symlink_metadata.is_file() { symlink_metadata.len() } else { 0 },
        "mode": metadata_mode(&symlink_metadata),
        "owner": metadata_owner(&symlink_metadata),
        "group": metadata_group(&symlink_metadata),
        "modifiedAt": system_time_to_iso(symlink_metadata.modified().ok())
    });
    if entry_type == "symlink" {
        value["targetType"] = json!(symlink_target_type(&entry.path()));
        if let Ok(target) = fs::read_link(entry.path()) {
            value["targetPath"] = json!(display_path(&target));
        }
    }
    Some(value)
}

fn local_entry_type(metadata: &fs::Metadata) -> &'static str {
    if metadata.file_type().is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "file"
    }
}

fn symlink_target_type(path: &Path) -> &'static str {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => "directory",
        Ok(metadata) if metadata.is_file() => "file",
        _ => "unknown",
    }
}

fn metadata_mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.mode()
    }
    #[cfg(not(unix))]
    {
        if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

fn metadata_owner(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.uid()
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        0
    }
}

fn metadata_group(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.gid()
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        0
    }
}

fn display_path(path: &Path) -> String {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy().replace('\\', "/");
        if value.len() == 2 && value.as_bytes()[1] == b':' {
            format!("{value}/")
        } else {
            value
        }
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().to_string()
    }
}

#[cfg(windows)]
fn list_windows_drive_roots() -> Result<Value, String> {
    let mut entries = Vec::new();
    for letter in b'A'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        if let Ok(metadata) = fs::metadata(&path) {
            if metadata.is_dir() {
                entries.push(json!({
                    "name": format!("{}:", letter as char),
                    "longname": path,
                    "type": "directory",
                    "size": 0,
                    "mode": metadata_mode(&metadata),
                    "owner": metadata_owner(&metadata),
                    "group": metadata_group(&metadata),
                    "modifiedAt": system_time_to_iso(metadata.modified().ok())
                }));
            }
        }
    }
    Ok(json!({ "path": "/", "entries": entries }))
}

#[cfg(unix)]
fn set_unix_permissions(path: &Path, mode: u32, recursive: bool) -> Result<(), io::Error> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_symlink() {
        let mut permissions = metadata.permissions();
        permissions.set_mode(mode);
        fs::set_permissions(path, permissions)?;
    }
    if recursive && metadata.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            set_unix_permissions(&entry.path(), mode, true)?;
        }
    }
    Ok(())
}

fn system_time_to_iso(value: Option<std::time::SystemTime>) -> String {
    value
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| chrono::DateTime::<Utc>::from_timestamp(duration.as_secs() as i64, 0))
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "shelldesk-local-fs-test-{}-{}",
            std::process::id(),
            name
        ))
    }

    #[test]
    fn normalizes_empty_local_path_to_home_or_current_dir() {
        let path = normalize_local_path("".to_string());
        assert!(path.is_absolute() || path == *".");
    }

    #[cfg(windows)]
    #[test]
    fn keeps_windows_drive_root_displayable() {
        assert_eq!(
            normalize_local_path("/C:".to_string()),
            PathBuf::from("C:\\")
        );
        assert_eq!(display_path(&PathBuf::from("C:\\")), "C:/");
    }

    #[test]
    fn rejects_root_as_mutable_path() {
        assert!(assert_mutable_local_path(Path::new("/")).is_err());
    }

    #[test]
    fn read_local_file_rejects_legacy_large_text_limit() {
        let path = temp_file_path("read-large.txt");
        fs::write(&path, vec![b'x'; MAX_REMOTE_TEXT_FILE_BYTES as usize + 1]).unwrap();

        let result = read_local_file(vec![json!("local"), json!(path.to_string_lossy())]);

        let _ = fs::remove_file(&path);
        assert_eq!(result.unwrap_err(), "文件超过 5 MB，请用本地编辑器打开。");
    }

    #[test]
    fn write_local_file_rejects_legacy_large_text_limit() {
        let path = temp_file_path("write-large.txt");

        let result = write_local_file(vec![
            json!("local"),
            json!(path.to_string_lossy()),
            json!("x".repeat(MAX_REMOTE_TEXT_WRITE_BYTES + 1)),
        ]);

        let _ = fs::remove_file(&path);
        assert_eq!(
            result.unwrap_err(),
            "文件内容超过 10 MB，请使用本地编辑器保存大文件。"
        );
    }

    #[test]
    fn sudo_password_options_match_frontend_shape() {
        assert_eq!(
            sudo_password(&json!({ "sudoPassword": "secret" })),
            Some("secret".to_string())
        );
        assert_eq!(sudo_password(&json!({})), None);
    }

    #[cfg(unix)]
    #[test]
    fn permission_denied_with_sudo_password_triggers_local_sudo_retry() {
        let error = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        assert!(should_retry_local_with_sudo(
            &error,
            &json!({ "sudoPassword": "secret" })
        ));
    }

    #[test]
    fn local_sudo_commands_keep_path_as_argument() {
        let path = PathBuf::from("/tmp/shell desk.txt");
        let read_args = local_sudo_read_args(&path);
        let write_args = local_sudo_write_args(&path);
        let create_dir_args = local_sudo_create_directory_args(&path);
        let create_file_args = local_sudo_create_file_args(&path);
        let delete_file_args = local_sudo_delete_path_args(&path, "file");
        let delete_dir_args = local_sudo_delete_path_args(&path, "directory");
        let rename_args = local_sudo_rename_path_args(&path, Path::new("/tmp/new name.txt"));
        let chmod_args = local_sudo_chmod_args(&path, 0o755, true);

        assert_eq!(read_args[0], "-S");
        assert_eq!(read_args[8], path.to_string_lossy());
        assert_eq!(read_args[9], MAX_REMOTE_TEXT_FILE_BYTES.to_string());
        assert_eq!(write_args[0], "-S");
        assert_eq!(write_args[8], path.to_string_lossy());
        assert_eq!(create_dir_args[6], "mkdir \"$1\"");
        assert_eq!(create_dir_args[8], path.to_string_lossy());
        assert_eq!(create_file_args[6], "set -C; : > \"$1\"");
        assert_eq!(create_file_args[8], path.to_string_lossy());
        assert_eq!(delete_file_args[6], "rm -f \"$1\"");
        assert_eq!(delete_dir_args[6], "rm -rf \"$1\"");
        assert_eq!(rename_args[6], "mv \"$1\" \"$2\"");
        assert_eq!(rename_args[8], path.to_string_lossy());
        assert_eq!(rename_args[9], "/tmp/new name.txt");
        assert_eq!(chmod_args[6], "chmod -R \"$1\" \"$2\"");
        assert_eq!(chmod_args[8], "755");
        assert_eq!(chmod_args[9], path.to_string_lossy());
    }

    #[cfg(windows)]
    #[test]
    fn powershell_single_quote_escapes_paths() {
        assert_eq!(
            powershell_single_quote("C:\\A B\\it's.txt"),
            "'C:\\A B\\it''s.txt'"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_elevation_launcher_uses_runas() {
        let launcher = windows_elevated_launcher_script(Path::new("C:\\Temp\\operation.ps1"));

        assert!(launcher.contains("Start-Process"));
        assert!(launcher.contains("-Verb RunAs"));
        assert!(launcher.contains("'C:\\Temp\\operation.ps1'"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_elevation_operation_writes_result_json() {
        let operation = windows_elevated_operation_script(
            "Copy-Item -LiteralPath 'a' -Destination 'b'",
            Path::new("C:\\Temp\\result.json"),
        );

        assert!(operation.contains("$resultPath = 'C:\\Temp\\result.json'"));
        assert!(operation.contains("ConvertTo-Json -Compress"));
        assert!(operation.contains("Copy-Item -LiteralPath 'a' -Destination 'b'"));
    }
}
