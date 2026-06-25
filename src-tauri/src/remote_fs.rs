use crate::command_runner::run_shell;
use crate::local_fs::{
    create_local_directory, create_local_file, delete_local_path, list_local_directory,
    read_local_file, rename_local_path, set_local_path_permissions, stat_local_path,
    write_local_file,
};
use crate::{
    error_string, get_connection, read_string_field, run_connection_command_with_options,
    run_ssh_command_for_profile_interactive, shell_quote, string_arg, AppState, ConnectionKind,
};
use chrono::Utc;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[path = "remote_fs/commands.rs"]
mod commands;
#[path = "remote_fs/local_transfer.rs"]
mod local_transfer;
#[path = "remote_fs/paths.rs"]
mod paths;
#[path = "remote_fs/remote_io.rs"]
mod remote_io;
#[path = "remote_fs/transfer.rs"]
mod transfer;

pub(crate) use commands::remote_sftp_probe_command;
use commands::{
    archive_compress_command, archive_decompress_command, command_bool, command_json,
    join_remote_path, normalize_archive_format, parse_unix_directory_listing, parse_unix_path_stat,
    remote_create_directory_command, remote_create_file_command, remote_delete_path_command,
    remote_host_is_windows, remote_list_directory_command, remote_read_file_command,
    remote_rename_path_command, remote_stat_path_command, remote_write_file_command,
};
#[cfg(test)]
use commands::{
    remote_directory_archive_command, remote_file_read_command, remote_file_write_command,
};
use local_transfer::{
    copy_local_file_with_transfer, copy_local_path_with_transfer, extract_tar_gz_archive,
    local_path_file_stats,
};
use paths::{
    default_transfer_name, remote_file_name, sanitize_local_file_name, upload_remote_name,
};
#[cfg(test)]
use remote_io::can_retry_remote_file_with_privilege;
use remote_io::{
    download_remote_directory_archive_with_options, read_remote_file_bytes_with_options,
    remote_path_kind, remote_path_size, upload_local_directory_to_remote,
    write_remote_file_bytes_with_options,
};
use transfer::TransferReporter;
pub(crate) use transfer::{cancel_transfer, cancel_transfers_for_connection};

const ALL_FILES_FILTER_NAME: &str = "所有文件";
const UPLOAD_FILES_TITLE: &str = "选择要上传的文件";
const UPLOAD_FOLDERS_TITLE: &str = "选择要上传的文件夹";
const DOWNLOAD_DIRECTORY_TITLE: &str = "选择下载保存目录";

pub(crate) async fn list_connection_directory(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_path = string_arg(&args, 1)?;
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return list_local_directory(vec![
            json!(connection_id),
            json!(remote_path),
            args.get(2).cloned().unwrap_or(Value::Null),
        ]);
    }
    let command = remote_list_directory_command(&connection, &remote_path);
    let output = run_connection_command_with_options(
        state,
        vec![
            json!(connection_id),
            json!(command),
            json!(""),
            args.get(2).cloned().unwrap_or(Value::Null),
        ],
        3,
    )
    .await?;
    if remote_host_is_windows(&connection) {
        command_json(output, "列出远程目录失败。")
    } else {
        parse_unix_directory_listing(output, remote_path)
    }
}

pub(crate) async fn stat_connection_path(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_path = string_arg(&args, 1)?;
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return stat_local_path(vec![
            json!(connection_id),
            json!(remote_path),
            args.get(2).cloned().unwrap_or(Value::Null),
        ]);
    }
    let command = remote_stat_path_command(&connection, &remote_path);
    let output = run_connection_command_with_options(
        state,
        vec![
            json!(connection_id),
            json!(command),
            json!(""),
            args.get(2).cloned().unwrap_or(Value::Null),
        ],
        3,
    )
    .await?;
    if remote_host_is_windows(&connection) {
        command_json(output, "读取远程路径属性失败。")
    } else {
        parse_unix_path_stat(output)
    }
}

pub(crate) async fn read_connection_file(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_path = string_arg(&args, 1)?;
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return read_local_file(vec![
            json!(connection_id),
            json!(remote_path),
            args.get(2).cloned().unwrap_or(Value::Null),
        ]);
    }
    let output = run_connection_command_with_options(
        state,
        vec![
            json!(connection_id),
            json!(remote_read_file_command(&connection, &remote_path)),
            json!(""),
            args.get(2).cloned().unwrap_or(Value::Null),
        ],
        3,
    )
    .await?;
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) != 0 {
        return Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .unwrap_or("读取远程文件失败。")
            .to_string());
    }
    Ok(json!(output
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or("")))
}

pub(crate) async fn write_connection_file(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_path = string_arg(&args, 1)?;
    let content = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return write_local_file(vec![
            json!(connection_id),
            json!(remote_path),
            json!(content),
            args.get(3).cloned().unwrap_or(Value::Null),
        ]);
    }
    let output = run_connection_command_with_options(
        state,
        vec![
            json!(connection_id),
            json!(remote_write_file_command(&connection, &remote_path)),
            json!(content),
            args.get(3).cloned().unwrap_or(Value::Null),
        ],
        3,
    )
    .await?;
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) == 0 {
        Ok(json!(true))
    } else {
        Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .unwrap_or("写入远程文件失败。")
            .to_string())
    }
}

pub(crate) async fn create_connection_directory(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_path = string_arg(&args, 1)?;
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return create_local_directory(vec![
            json!(connection_id),
            json!(remote_path),
            args.get(2).cloned().unwrap_or(Value::Null),
        ]);
    }
    let command = remote_create_directory_command(&connection, &remote_path);
    let output = run_connection_command_with_options(
        state,
        vec![
            json!(connection_id),
            json!(command),
            json!(""),
            args.get(2).cloned().unwrap_or(Value::Null),
        ],
        3,
    )
    .await?;
    command_bool(output, "创建远程目录失败。")
}

pub(crate) async fn create_connection_file(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_path = string_arg(&args, 1)?;
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return create_local_file(vec![
            json!(connection_id),
            json!(remote_path),
            args.get(2).cloned().unwrap_or(Value::Null),
        ]);
    }
    let command = remote_create_file_command(&connection, &remote_path);
    let output = run_connection_command_with_options(
        state,
        vec![
            json!(connection_id),
            json!(command),
            json!(""),
            args.get(2).cloned().unwrap_or(Value::Null),
        ],
        3,
    )
    .await?;
    command_bool(output, "创建远程文件失败。")
}

pub(crate) async fn delete_connection_path(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_path = string_arg(&args, 1)?;
    let entry_type = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or("file")
        .to_string();
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return delete_local_path(vec![
            json!(connection_id),
            json!(remote_path),
            json!(entry_type),
            args.get(3).cloned().unwrap_or(Value::Null),
        ]);
    }
    let command = remote_delete_path_command(&connection, &remote_path, &entry_type);
    let output = run_connection_command_with_options(
        state,
        vec![
            json!(connection_id),
            json!(command),
            json!(""),
            args.get(3).cloned().unwrap_or(Value::Null),
        ],
        3,
    )
    .await?;
    command_bool(output, "删除远程路径失败。")
}

pub(crate) async fn rename_connection_path(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let old_path = string_arg(&args, 1)?;
    let new_path = string_arg(&args, 2)?;
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return rename_local_path(vec![
            json!(connection_id),
            json!(old_path),
            json!(new_path),
            args.get(3).cloned().unwrap_or(Value::Null),
        ]);
    }
    let command = remote_rename_path_command(&connection, &old_path, &new_path);
    let output = run_connection_command_with_options(
        state,
        vec![
            json!(connection_id),
            json!(command),
            json!(""),
            args.get(3).cloned().unwrap_or(Value::Null),
        ],
        3,
    )
    .await?;
    command_bool(output, "重命名远程路径失败。")
}

pub(crate) async fn check_connection_sftp(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return Ok(json!({ "available": true }));
    }
    let profile = connection
        .ssh
        .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
    let output = run_ssh_command_for_profile_interactive(
        state,
        profile,
        remote_sftp_probe_command(),
        String::new(),
    )
    .await?;
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) == 0 {
        return Ok(json!({ "available": true }));
    }
    Ok(json!({
        "available": false,
        "error": output
            .get("stderr")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("远程系统未找到可执行的 sftp-server。")
    }))
}

pub(crate) fn select_upload_items(folders: bool) -> Result<Value, String> {
    let paths = if folders {
        rfd::FileDialog::new()
            .set_title(UPLOAD_FOLDERS_TITLE)
            .pick_folders()
    } else {
        rfd::FileDialog::new()
            .set_title(UPLOAD_FILES_TITLE)
            .add_filter(ALL_FILES_FILTER_NAME, &["*"])
            .pick_files()
    };
    let Some(paths) = paths else {
        return Ok(json!({ "canceled": true, "items": [] }));
    };
    let mut items = Vec::new();
    for path in paths {
        let metadata = fs::metadata(&path).map_err(error_string)?;
        items.push(json!({
            "path": path.to_string_lossy(),
            "name": path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "upload".to_string()),
            "type": if metadata.is_dir() { "directory" } else { "file" },
            "size": if metadata.is_file() { metadata.len() } else { 0 },
            "modifiedAt": metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|duration| chrono::DateTime::<Utc>::from_timestamp(duration.as_secs() as i64, 0)).unwrap_or_else(Utc::now).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        }));
    }
    Ok(json!({ "canceled": false, "items": items }))
}

pub(crate) async fn upload_selected_paths(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
    folders: bool,
    multiple: bool,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_dir = string_arg(&args, 1)?;
    let paths = if folders {
        rfd::FileDialog::new()
            .set_title(UPLOAD_FOLDERS_TITLE)
            .pick_folders()
    } else if multiple {
        rfd::FileDialog::new()
            .set_title(UPLOAD_FILES_TITLE)
            .add_filter(ALL_FILES_FILTER_NAME, &["*"])
            .pick_files()
    } else {
        rfd::FileDialog::new()
            .add_filter(ALL_FILES_FILTER_NAME, &["*"])
            .pick_file()
            .map(|path| vec![path])
    };
    let Some(paths) = paths else {
        return Ok(json!({ "canceled": true }));
    };
    let items = paths
        .into_iter()
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            Some(json!({
                "path": path.to_string_lossy(),
                "name": path.file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_else(|| "upload".to_string()),
                "type": if metadata.is_dir() { "directory" } else { "file" },
                "size": if metadata.is_file() { metadata.len() } else { 0 }
            }))
        })
        .collect::<Vec<_>>();
    upload_connection_paths(
        state,
        window,
        vec![
            json!(connection_id),
            json!(remote_dir),
            json!(items),
            args.get(2).cloned().unwrap_or(Value::Null),
        ],
    )
    .await
}

pub(crate) async fn download_connection_file(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_path = string_arg(&args, 1)?;
    let transfer = TransferReporter::new(
        state,
        window,
        &connection_id,
        "download",
        args.get(2),
        default_transfer_name(&remote_path),
    );
    let default_name =
        sanitize_local_file_name(&remote_file_name(&remote_path, "download"), "download");
    let Some(local_path) = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .add_filter(ALL_FILES_FILTER_NAME, &["*"])
        .save_file()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        let size = fs::metadata(&remote_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        transfer.set_totals(size, 1, 1);
        transfer.start_file(&default_name, size);
        let _copied =
            copy_local_file_with_transfer(&transfer, Path::new(&remote_path), &local_path)?;
        transfer.complete_file();
    } else {
        let profile = connection
            .ssh
            .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
        transfer.set_totals(0, 1, 1);
        transfer.start_file(&default_name, 0);
        transfer.check_canceled()?;
        let bytes = read_remote_file_bytes_with_options(
            state,
            &connection_id,
            profile,
            &remote_path,
            args.get(2),
        )
        .await?;
        transfer.add_bytes(bytes.len() as u64);
        fs::write(&local_path, &bytes).map_err(error_string)?;
        transfer.complete_file();
    }
    let size = fs::metadata(&local_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    transfer.finish(true, None);
    Ok(json!({
        "canceled": false,
        "filePath": local_path.to_string_lossy(),
        "size": size
    }))
}

pub(crate) async fn download_connection_paths(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_paths = args
        .get(1)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let transfer = TransferReporter::new(
        state,
        window,
        &connection_id,
        "download",
        args.get(2),
        "download".to_string(),
    );
    let Some(local_dir) = rfd::FileDialog::new()
        .set_title(DOWNLOAD_DIRECTORY_TITLE)
        .pick_folder()
    else {
        return Ok(json!({ "canceled": true }));
    };
    let connection = get_connection(state, &connection_id)?;
    let mut total_size = 0_u64;
    let mut file_count = 0_u64;
    let mut item_count = 0_u64;
    transfer.set_totals(0, 0, remote_paths.len() as u64);

    for value in remote_paths {
        transfer.check_canceled()?;
        let Some(remote_path) = value.as_str() else {
            continue;
        };
        let file_name = remote_file_name(remote_path, "download");
        let local_path = local_dir.join(sanitize_local_file_name(&file_name, "download"));
        if connection.kind == ConnectionKind::Local {
            let metadata = fs::metadata(remote_path).map_err(error_string)?;
            if metadata.is_file() {
                transfer.start_file(&file_name, metadata.len());
                let copied =
                    copy_local_file_with_transfer(&transfer, Path::new(remote_path), &local_path)?;
                transfer.complete_file();
                total_size += copied;
                file_count += 1;
                item_count += 1;
            } else if metadata.is_dir() {
                let (copied, files) =
                    copy_local_path_with_transfer(&transfer, Path::new(remote_path), &local_path)?;
                total_size += copied;
                file_count += files;
                item_count += 1;
            }
        } else {
            let profile = connection
                .ssh
                .clone()
                .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
            let kind = remote_path_kind(state, profile.clone(), remote_path).await?;
            if kind == "directory" {
                let size = remote_path_size(state, profile.clone(), remote_path)
                    .await
                    .unwrap_or(0);
                transfer.start_file(&file_name, size);
                let bytes = download_remote_directory_archive_with_options(
                    state,
                    &connection_id,
                    profile,
                    remote_path,
                    args.get(2),
                )
                .await?;
                extract_tar_gz_archive(&bytes, &local_dir)?;
                transfer.add_bytes(size.max(bytes.len() as u64));
                transfer.complete_file();
                total_size += size.max(bytes.len() as u64);
                file_count += 1;
                item_count += 1;
            } else {
                let size = remote_path_size(state, profile.clone(), remote_path)
                    .await
                    .unwrap_or(0);
                transfer.start_file(&file_name, size);
                let bytes = read_remote_file_bytes_with_options(
                    state,
                    &connection_id,
                    profile,
                    remote_path,
                    args.get(2),
                )
                .await?;
                fs::write(&local_path, &bytes).map_err(error_string)?;
                transfer.add_bytes(bytes.len() as u64);
                transfer.complete_file();
                total_size += bytes.len() as u64;
                file_count += 1;
                item_count += 1;
            }
        }
    }

    transfer.finish(true, None);
    Ok(json!({
        "canceled": false,
        "directoryPath": local_dir.to_string_lossy(),
        "size": total_size,
        "fileCount": file_count,
        "itemCount": item_count
    }))
}

pub(crate) async fn upload_connection_paths(
    state: &AppState,
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_dir = string_arg(&args, 1)?;
    let items = args
        .get(2)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let item_count = items.len() as u64;
    let transfer = TransferReporter::new(
        state,
        window,
        &connection_id,
        "upload",
        args.get(3),
        "upload".to_string(),
    );
    let connection = get_connection(state, &connection_id)?;
    let mut uploaded_paths = Vec::new();
    let mut total_size = 0_u64;
    let mut file_count = 0_u64;
    let planned_total = items
        .iter()
        .filter_map(|item| {
            let path = PathBuf::from(read_string_field(item, "path", ""));
            Some(local_path_file_stats(&path).0)
        })
        .sum::<u64>();
    let planned_files = items
        .iter()
        .map(|item| {
            let path = PathBuf::from(read_string_field(item, "path", ""));
            local_path_file_stats(&path).1
        })
        .sum::<u64>();
    transfer.set_totals(planned_total, planned_files, items.len() as u64);

    if connection.kind == ConnectionKind::Local {
        fs::create_dir_all(&remote_dir).map_err(error_string)?;
        for item in items {
            transfer.check_canceled()?;
            let local_path = read_string_field(&item, "path", "");
            if local_path.is_empty() {
                continue;
            }
            let local_path_buf = PathBuf::from(&local_path);
            let remote_name = upload_remote_name(&item, &local_path_buf);
            let target = Path::new(&remote_dir).join(remote_name);
            if local_path_buf.is_file() {
                let size = fs::metadata(&local_path_buf).map_err(error_string)?.len();
                transfer.start_file(&default_transfer_name(&local_path), size);
                let copied = copy_local_file_with_transfer(&transfer, &local_path_buf, &target)?;
                transfer.complete_file();
                total_size += copied;
                file_count += 1;
                uploaded_paths.push(json!(target.to_string_lossy()));
            } else if local_path_buf.is_dir() {
                let (copied, files) =
                    copy_local_path_with_transfer(&transfer, &local_path_buf, &target)?;
                total_size += copied;
                file_count += files;
                uploaded_paths.push(json!(target.to_string_lossy()));
            }
        }
    } else {
        let profile = connection
            .ssh
            .clone()
            .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
        for item in items {
            transfer.check_canceled()?;
            let local_path = read_string_field(&item, "path", "");
            if local_path.is_empty() {
                continue;
            }
            let local_path_buf = PathBuf::from(&local_path);
            let remote_name = upload_remote_name(&item, &local_path_buf);
            let remote_path = join_remote_path(&remote_dir, &remote_name);
            if local_path_buf.is_file() {
                let bytes = fs::read(&local_path_buf).map_err(error_string)?;
                transfer.start_file(&remote_name, bytes.len() as u64);
                write_remote_file_bytes_with_options(
                    state,
                    &connection_id,
                    profile.clone(),
                    &remote_path,
                    &bytes,
                    args.get(3),
                )
                .await?;
                transfer.add_bytes(bytes.len() as u64);
                transfer.complete_file();
                let size = fs::metadata(&local_path_buf).map_err(error_string)?.len();
                total_size += size;
                file_count += 1;
                uploaded_paths.push(json!(remote_path));
            } else if local_path_buf.is_dir() {
                let (size, files) = local_path_file_stats(&local_path_buf);
                transfer.start_file(&remote_name, size);
                upload_local_directory_to_remote(
                    state,
                    profile.clone(),
                    &local_path_buf,
                    &remote_dir,
                )
                .await?;
                transfer.add_bytes(size);
                transfer.complete_file();
                total_size += size;
                file_count += files.max(1);
                uploaded_paths.push(json!(remote_path));
            }
        }
    }

    transfer.finish(true, None);
    Ok(json!({
        "canceled": false,
        "remotePath": remote_dir,
        "remotePaths": uploaded_paths,
        "size": total_size,
        "fileCount": file_count,
        "itemCount": item_count
    }))
}

pub(crate) async fn set_connection_path_permissions(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_path = string_arg(&args, 1)?;
    let options = args.get(2).cloned().unwrap_or_else(|| json!({}));
    let mode = options.get("mode").and_then(Value::as_u64).unwrap_or(0o644);
    let recursive = options
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let connection = get_connection(state, &connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return set_local_path_permissions(vec![json!(connection_id), json!(remote_path), options]);
    }
    let command = if recursive {
        format!("chmod -R {:o} -- {}", mode, shell_quote(&remote_path))
    } else {
        format!("chmod {:o} -- {}", mode, shell_quote(&remote_path))
    };
    let output = run_connection_command_with_options(
        state,
        vec![json!(connection_id), json!(command), json!(""), options],
        3,
    )
    .await?;
    command_bool(output, "修改权限失败。")
}

pub(crate) async fn compress_connection_paths(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let source_paths = args
        .get(1)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let requested_format = string_arg(&args, 2).unwrap_or_else(|_| "zip".to_string());
    let format = normalize_archive_format(&requested_format);
    let dest_path = string_arg(&args, 3)?;
    let sources: Vec<String> = source_paths
        .iter()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect();
    if sources.is_empty() {
        return Err("请选择要压缩的路径。".to_string());
    }
    let connection = get_connection(state, &connection_id)?;
    let command = archive_compress_command(&connection, &sources, &format, &dest_path)?;
    let output = if connection.kind == ConnectionKind::Local {
        run_shell(command, "", Some(Duration::from_secs(300))).await?
    } else {
        run_ssh_command_for_profile_interactive(
            state,
            connection
                .ssh
                .ok_or_else(|| "SSH profile is unavailable.".to_string())?,
            command,
            String::new(),
        )
        .await?
    };
    command_bool(output, "压缩失败。")?;
    Ok(json!({ "format": format, "destPath": dest_path }))
}

pub(crate) async fn decompress_connection_archive(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let archive_path = string_arg(&args, 1)?;
    let dest_dir = args
        .get(2)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(".")
        .to_string();
    let connection = get_connection(state, &connection_id)?;
    let command = archive_decompress_command(&connection, &archive_path, &dest_dir)?;
    let output = if connection.kind == ConnectionKind::Local {
        run_shell(command, "", Some(Duration::from_secs(300))).await?
    } else {
        run_ssh_command_for_profile_interactive(
            state,
            connection
                .ssh
                .ok_or_else(|| "SSH profile is unavailable.".to_string())?,
            command,
            String::new(),
        )
        .await?
    };
    command_bool(output, "解压失败。")?;
    Ok(json!({ "archivePath": archive_path, "destDir": dest_dir }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActiveConnection, ActiveTransfer, PrivilegeConfig, SshProfile};
    use std::collections::HashSet;

    fn test_ssh_connection(privilege: Option<PrivilegeConfig>) -> ActiveConnection {
        ActiveConnection {
            id: "conn-1".to_string(),
            kind: ConnectionKind::Ssh,
            partition: "persist:conn-1".to_string(),
            proxy_port: 0,
            browser_certificate_trust: HashSet::new(),
            connected_at: "now".to_string(),
            host: json!({ "systemType": "linux" }),
            ssh: Some(SshProfile {
                address: "example.test".to_string(),
                port: 22,
                username: "user".to_string(),
                auth_method: "password".to_string(),
                password: "secret".to_string(),
                key_path: String::new(),
                known_hosts_path: String::new(),
                proxy_helper_exe: String::new(),
                proxy: None,
                jump: None,
            }),
            privilege,
        }
    }

    fn test_windows_connection() -> ActiveConnection {
        let mut connection = test_ssh_connection(None);
        connection.host = json!({ "systemType": "windows" });
        connection
    }

    #[test]
    fn remote_file_name_handles_unix_and_windows_paths() {
        assert_eq!(
            remote_file_name("/var/log/nginx/access.log", "download"),
            "access.log"
        );
        assert_eq!(
            remote_file_name("C:\\Logs\\app\\error.log", "download"),
            "error.log"
        );
        assert_eq!(remote_file_name("/", "download"), "download");
    }

    #[test]
    fn local_download_file_name_matches_legacy_sanitization() {
        assert_eq!(
            sanitize_local_file_name("logs/../prod:dump?.txt ", "download"),
            "logs_.._prod_dump_.txt"
        );
        assert_eq!(sanitize_local_file_name(" .hidden ", "download"), ".hidden");
        assert_eq!(sanitize_local_file_name("CON.txt", "download"), "download");
        assert_eq!(sanitize_local_file_name("...", "download"), "download");
    }

    #[test]
    fn upload_remote_name_matches_legacy_sanitization() {
        let local_path = PathBuf::from("C:\\Users\\me\\report.txt");

        assert_eq!(
            upload_remote_name(
                &json!({ "remoteName": "../prod:dump?.txt " }),
                local_path.as_path()
            ),
            ".._prod_dump_.txt"
        );
        assert_eq!(
            upload_remote_name(&json!({ "remoteName": "CON.txt" }), local_path.as_path()),
            "upload"
        );
        assert_eq!(
            upload_remote_name(&json!({ "remoteName": "" }), local_path.as_path()),
            "report.txt"
        );
    }

    #[test]
    fn cancel_transfer_matches_active_queue_or_client_id() {
        let state = AppState::new(std::env::temp_dir());
        state.active_transfers.lock().unwrap().insert(
            "queue-1".to_string(),
            ActiveTransfer {
                connection_id: "conn-1".to_string(),
                client_id: Some("client-1".to_string()),
            },
        );

        assert_eq!(
            cancel_transfer(&state, vec![json!("conn-2"), json!("queue-1")]).unwrap(),
            json!(false)
        );
        assert_eq!(
            cancel_transfer(&state, vec![json!("conn-1"), json!("client-1")]).unwrap(),
            json!(true)
        );

        let cancellations = state.transfer_cancellations.lock().unwrap();
        assert!(cancellations.contains("queue-1"));
        assert!(cancellations.contains("client-1"));
    }

    #[test]
    fn cancel_transfer_without_queue_cancels_all_connection_transfers() {
        let state = AppState::new(std::env::temp_dir());
        {
            let mut active_transfers = state.active_transfers.lock().unwrap();
            active_transfers.insert(
                "queue-1".to_string(),
                ActiveTransfer {
                    connection_id: "conn-1".to_string(),
                    client_id: Some("client-1".to_string()),
                },
            );
            active_transfers.insert(
                "queue-2".to_string(),
                ActiveTransfer {
                    connection_id: "conn-2".to_string(),
                    client_id: Some("client-2".to_string()),
                },
            );
        }

        assert_eq!(
            cancel_transfer(&state, vec![json!("conn-1"), json!("")]).unwrap(),
            json!(true)
        );

        let cancellations = state.transfer_cancellations.lock().unwrap();
        assert!(cancellations.contains("queue-1"));
        assert!(cancellations.contains("client-1"));
        assert!(!cancellations.contains("queue-2"));
        assert!(!cancellations.contains("client-2"));
    }

    #[test]
    fn windows_remote_file_commands_use_powershell() {
        let connection = test_windows_connection();

        for command in [
            remote_list_directory_command(&connection, "C:\\Logs"),
            remote_stat_path_command(&connection, "C:\\Logs\\app.log"),
            remote_read_file_command(&connection, "C:\\Logs\\app.log"),
            remote_write_file_command(&connection, "C:\\Logs\\app.log"),
            remote_create_directory_command(&connection, "C:\\Logs\\new"),
            remote_create_file_command(&connection, "C:\\Logs\\new.txt"),
            remote_delete_path_command(&connection, "C:\\Logs\\new", "directory"),
            remote_rename_path_command(&connection, "C:\\Logs\\old.txt", "C:\\Logs\\new.txt"),
        ] {
            assert!(command
                .starts_with("powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "));
        }
    }

    #[test]
    fn unix_remote_file_commands_keep_shell_semantics() {
        let connection = test_ssh_connection(None);

        assert!(remote_list_directory_command(&connection, "/var/log").contains("find '/var/log'"));
        assert!(remote_stat_path_command(&connection, "/var/log/app.log").contains("stat -c"));
        assert_eq!(
            remote_read_file_command(&connection, "/var/log/app.log"),
            "cat -- '/var/log/app.log'"
        );
        assert_eq!(
            remote_rename_path_command(&connection, "/tmp/a", "/tmp/b"),
            "mv -- '/tmp/a' '/tmp/b'"
        );
    }

    #[test]
    fn sftp_probe_command_does_not_mask_missing_server() {
        let command = remote_sftp_probe_command();

        assert!(command.contains("command -v sftp-server"));
        assert!(command.contains("/usr/lib/openssh/sftp-server"));
        assert!(!command.contains("|| true"));
    }

    #[test]
    fn parses_unix_directory_and_stat_outputs() {
        let listing = parse_unix_directory_listing(
            json!({ "code": 0, "stdout": "app.log\tf\t12\t1710000000.0\nlogs\td\t0\t1710000010.0\n" }),
            "/var".to_string(),
        )
        .unwrap();
        assert_eq!(listing["entries"][0]["name"], "app.log");
        assert_eq!(listing["entries"][1]["type"], "directory");

        let stat = parse_unix_path_stat(json!({
            "code": 0,
            "stdout": "regular file\t12\t644\t1000\t1000\t1710000000\t1710000001\n"
        }))
        .unwrap();
        assert_eq!(stat["type"], "file");
        assert_eq!(stat["mode"], 0o644);
    }

    #[test]
    fn retries_remote_file_operation_when_sudo_password_is_supplied() {
        let state = AppState::new(std::env::temp_dir());
        let options = json!({ "sudoPassword": "secret" });

        assert!(can_retry_remote_file_with_privilege(&state, "missing", Some(&options)).unwrap());
    }

    #[test]
    fn retries_remote_file_operation_when_connection_has_su_root_privilege() {
        let state = AppState::new(std::env::temp_dir());
        state.connections.lock().unwrap().insert(
            "conn-1".to_string(),
            test_ssh_connection(Some(PrivilegeConfig {
                mode: "su-root".to_string(),
                password: "root-pass".to_string(),
            })),
        );

        assert!(can_retry_remote_file_with_privilege(&state, "conn-1", None).unwrap());
    }

    #[test]
    fn remote_file_write_command_quotes_target_path() {
        let command = remote_file_write_command("/etc/app's/config.ini");

        assert!(command.contains("'/etc/app'\"'\"'s/config.ini'"));
        assert!(!command.contains("/etc/app's/config.ini >"));
    }

    #[test]
    fn remote_file_read_command_quotes_target_path() {
        let command = remote_file_read_command("/var/lib/app's/data.db");

        assert!(command.contains("'/var/lib/app'\"'\"'s/data.db'"));
        assert!(!command.contains("< /var/lib/app's/data.db"));
    }

    #[test]
    fn remote_directory_archive_command_quotes_parent_and_name() {
        let command = remote_directory_archive_command("/srv/app's/log dir");

        assert!(command.contains("cd '/srv/app'\"'\"'s'"));
        assert!(command.contains("-- 'log dir'"));
    }

    #[test]
    fn archive_compress_command_preserves_tar_format() {
        let connection = test_ssh_connection(None);
        let command = archive_compress_command(
            &connection,
            &["/var/log/app".to_string()],
            "tar",
            "/tmp/logs.tar",
        )
        .unwrap();

        assert!(command.starts_with("tar cf "));
        assert!(!command.contains("tar czf"));
    }

    #[test]
    fn archive_decompress_command_supports_tar_xz_and_gz() {
        let connection = test_ssh_connection(None);

        let tar_xz =
            archive_decompress_command(&connection, "/tmp/archive.tar.xz", "/opt/out").unwrap();
        assert!(tar_xz.contains("tar xJf '/tmp/archive.tar.xz'"));

        let gz = archive_decompress_command(&connection, "/tmp/access.log.gz", "/opt/out").unwrap();
        assert!(gz.contains("gunzip -c '/tmp/access.log.gz'"));
        assert!(gz.contains("> '/opt/out'/'access.log'"));
    }

    #[test]
    fn archive_command_uses_powershell_for_windows_zip() {
        let connection = test_windows_connection();
        let command = archive_compress_command(
            &connection,
            &["C:\\Logs\\app.log".to_string()],
            "zip",
            "C:\\Logs\\app.zip",
        )
        .unwrap();

        assert!(
            command.starts_with("powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ")
        );
        assert!(archive_compress_command(
            &connection,
            &["C:\\Logs".to_string()],
            "tar",
            "C:\\Logs.tar"
        )
        .is_err());
        assert!(archive_decompress_command(&connection, "C:\\Logs\\app.7z", "C:\\Logs").is_err());
    }
}
