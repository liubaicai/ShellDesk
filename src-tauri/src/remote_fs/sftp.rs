use super::{
    commands::join_remote_path, paths::sanitize_local_file_name, transfer::TransferReporter,
};
use crate::{
    error_string, get_connection,
    russh_client::{connect_authenticated, RusshSession},
    string_arg, AppState, ConnectionKind, UiWindowRef,
};
use chrono::{DateTime, Utc};
use futures_util::{stream, StreamExt, TryStreamExt};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, FileType},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TRANSFER_CHUNK_BYTES: usize = 256 * 1024;
const SFTP_FILE_CONCURRENCY: usize = 8;
const LOCAL_SCAN_IO_TIMEOUT: Duration = Duration::from_secs(20);
const LOCAL_SCAN_CANCEL_POLL: Duration = Duration::from_millis(200);
const MAX_COMPARE_ENTRIES: usize = 50_000;
const MAX_RECURSIVE_SFTP_ENTRIES: usize = 100_000;
const SFTP_SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum TransferConflictPolicy {
    #[default]
    Overwrite,
    Skip,
}

fn transfer_conflict_policy(options: Option<&Value>) -> TransferConflictPolicy {
    match options
        .and_then(|value| value.get("conflictPolicy"))
        .and_then(Value::as_str)
    {
        Some("skip") => TransferConflictPolicy::Skip,
        _ => TransferConflictPolicy::Overwrite,
    }
}

fn remote_path_is_within(path: &str, parent: &str) -> bool {
    path == parent
        || path
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn is_dot_directory(name: &str) -> bool {
    matches!(name, "." | "..")
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TreeSnapshotEntry {
    kind: &'static str,
    size: u64,
}

#[derive(Debug, PartialEq, Eq)]
struct TreeComparison {
    local_differences: Vec<String>,
    remote_differences: Vec<String>,
    difference_count: usize,
}

struct OpenSftpSession {
    ssh: RusshSession,
    sftp: SftpSession,
}

impl OpenSftpSession {
    async fn close(mut self) {
        let _ = tokio::time::timeout(SFTP_SESSION_CLOSE_TIMEOUT, self.sftp.close()).await;
        let _ = tokio::time::timeout(SFTP_SESSION_CLOSE_TIMEOUT, self.ssh.disconnect()).await;
    }
}

async fn open_sftp_session(
    state: &AppState,
    window: &tauri::Window,
    connection_id: &str,
) -> Result<OpenSftpSession, String> {
    let connection = get_connection(state, connection_id)?;
    if connection.kind == ConnectionKind::Local {
        return Err("本地连接不需要 SFTP 会话。".to_string());
    }
    let profile = connection
        .ssh
        .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
    let ssh = connect_authenticated(
        Some(state.clone()),
        Some(UiWindowRef::from_window(window)),
        profile,
    )
    .await?;
    let channel = ssh
        .handle()
        .channel_open_session()
        .await
        .map_err(|error| format!("SFTP 会话通道打开失败：{error}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| format!("SSH 服务器拒绝 SFTP 子系统：{error}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| format!("SFTP 初始化失败：{error}"))?;
    sftp.set_timeout(30);
    Ok(OpenSftpSession { ssh, sftp })
}

fn file_type(metadata: &FileAttributes) -> &'static str {
    match metadata.file_type() {
        FileType::Dir => "directory",
        FileType::Symlink => "symlink",
        _ => "file",
    }
}

fn local_file_type(file_type: &fs::FileType) -> &'static str {
    if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "file"
    }
}

fn remove_local_overwrite_target(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    if metadata.is_dir() {
        return fs::remove_dir_all(path).map_err(error_string);
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(_) if metadata.file_type().is_symlink() => fs::remove_dir(path).map_err(error_string),
        Err(error) => Err(error_string(error)),
    }
}

fn insert_snapshot_entry(
    snapshot: &mut BTreeMap<String, TreeSnapshotEntry>,
    path: String,
    entry: TreeSnapshotEntry,
) -> Result<(), String> {
    if snapshot.len() >= MAX_COMPARE_ENTRIES {
        return Err(format!(
            "目录比较项目超过 {MAX_COMPARE_ENTRIES} 个，请缩小比较范围。"
        ));
    }
    snapshot.insert(path, entry);
    Ok(())
}

fn collect_local_tree(root: &Path) -> Result<BTreeMap<String, TreeSnapshotEntry>, String> {
    if !root.is_dir() {
        return Err(format!("本地比较路径不是目录：{}", root.display()));
    }

    let mut snapshot = BTreeMap::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((directory, relative_directory)) = stack.pop() {
        for entry in fs::read_dir(&directory).map_err(error_string)? {
            let entry = entry.map_err(error_string)?;
            let name = entry.file_name().to_string_lossy().to_string();
            let relative_path = if relative_directory.is_empty() {
                name
            } else {
                format!("{relative_directory}/{name}")
            };
            let file_type = entry.file_type().map_err(error_string)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(error_string)?;
            let kind = local_file_type(&file_type);
            insert_snapshot_entry(
                &mut snapshot,
                relative_path.clone(),
                TreeSnapshotEntry {
                    kind,
                    size: if kind == "file" { metadata.len() } else { 0 },
                },
            )?;
            if file_type.is_dir() {
                stack.push((entry.path(), relative_path));
            }
        }
    }
    Ok(snapshot)
}

async fn collect_remote_tree(
    sftp: &SftpSession,
    root: String,
) -> Result<BTreeMap<String, TreeSnapshotEntry>, String> {
    let mut snapshot = BTreeMap::new();
    let mut stack = vec![(root, String::new())];
    while let Some((directory, relative_directory)) = stack.pop() {
        let entries = sftp
            .read_dir(directory)
            .await
            .map_err(|error| format!("SFTP 递归比较目录失败：{error}"))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let relative_path = if relative_directory.is_empty() {
                name
            } else {
                format!("{relative_directory}/{name}")
            };
            let metadata = entry.metadata();
            let kind = file_type(&metadata);
            insert_snapshot_entry(
                &mut snapshot,
                relative_path.clone(),
                TreeSnapshotEntry {
                    kind,
                    size: if kind == "file" {
                        metadata.size.unwrap_or(0)
                    } else {
                        0
                    },
                },
            )?;
            if metadata.is_dir() {
                stack.push((entry.path(), relative_path));
            }
        }
    }
    Ok(snapshot)
}

fn compare_tree_snapshots(
    local: &BTreeMap<String, TreeSnapshotEntry>,
    remote: &BTreeMap<String, TreeSnapshotEntry>,
) -> TreeComparison {
    let all_paths = local
        .keys()
        .chain(remote.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut local_differences = Vec::new();
    let mut remote_differences = Vec::new();
    let mut difference_count = 0;

    for path in all_paths {
        let local_entry = local.get(&path);
        let remote_entry = remote.get(&path);
        let different = match (local_entry, remote_entry) {
            (Some(left), Some(right)) => {
                left.kind != right.kind || (left.kind == "file" && left.size != right.size)
            }
            _ => true,
        };
        if !different {
            continue;
        }
        difference_count += 1;
        if local_entry.is_some() {
            local_differences.push(path.clone());
        }
        if remote_entry.is_some() {
            remote_differences.push(path);
        }
    }

    TreeComparison {
        local_differences,
        remote_differences,
        difference_count,
    }
}

fn top_level_transfer_summaries(
    snapshot: &BTreeMap<String, TreeSnapshotEntry>,
    differences: &[String],
) -> Vec<Value> {
    let names = differences
        .iter()
        .filter_map(|path| path.split('/').next())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();

    names
        .into_iter()
        .map(|name| {
            let prefix = format!("{name}/");
            let mut size = 0_u64;
            let mut file_count = 0_u64;
            for (path, entry) in snapshot {
                if entry.kind == "file" && (path == &name || path.starts_with(&prefix)) {
                    size = size.saturating_add(entry.size);
                    file_count = file_count.saturating_add(1);
                }
            }
            json!({ "name": name, "size": size, "fileCount": file_count })
        })
        .collect()
}

fn permissions_text(metadata: &FileAttributes) -> String {
    let prefix = match metadata.file_type() {
        FileType::Dir => 'd',
        FileType::Symlink => 'l',
        _ => '-',
    };
    format!("{prefix}{}", metadata.permissions())
}

fn unix_time_to_iso(value: Option<u32>) -> String {
    value
        .and_then(|seconds| UNIX_EPOCH.checked_add(std::time::Duration::from_secs(seconds as u64)))
        .map(|value| DateTime::<Utc>::from(value).to_rfc3339())
        .unwrap_or_default()
}

fn metadata_json(metadata: &FileAttributes) -> Value {
    json!({
        "type": file_type(metadata),
        "size": metadata.size.unwrap_or(0),
        "mode": metadata.permissions.unwrap_or(0) & 0o7777,
        "owner": metadata.uid.unwrap_or(0),
        "group": metadata.gid.unwrap_or(0),
        "modifiedAt": unix_time_to_iso(metadata.mtime),
        "accessedAt": unix_time_to_iso(metadata.atime),
    })
}

pub(crate) async fn list_sftp_directory(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let requested_path = string_arg(&args, 1)?;
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    let path = session
        .sftp
        .canonicalize(if requested_path.trim().is_empty() {
            "."
        } else {
            &requested_path
        })
        .await
        .map_err(|error| format!("SFTP 路径解析失败：{error}"))?;
    let read_dir = session
        .sftp
        .read_dir(path.clone())
        .await
        .map_err(|error| format!("SFTP 列目录失败：{error}"))?;
    let entries = read_dir
        .filter_map(|entry| {
            let name = entry.file_name();
            if is_dot_directory(&name) {
                return None;
            }
            let metadata = entry.metadata();
            Some(json!({
                "name": name,
                "longname": format!("{} {}", permissions_text(&metadata), name),
                "type": file_type(&metadata),
                "size": metadata.size.unwrap_or(0),
                "modifiedAt": unix_time_to_iso(metadata.mtime),
                "mode": metadata.permissions.unwrap_or(0) & 0o7777,
                "owner": metadata.user.clone().unwrap_or_else(|| metadata.uid.unwrap_or(0).to_string()),
                "group": metadata.group.clone().unwrap_or_else(|| metadata.gid.unwrap_or(0).to_string()),
                "permissions": permissions_text(&metadata),
            }))
        })
        .collect::<Vec<_>>();
    session.close().await;
    Ok(json!({ "path": path, "entries": entries }))
}

pub(crate) async fn compare_sftp_directory(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let local_path = PathBuf::from(string_arg(&args, 1)?);
    let requested_remote_path = string_arg(&args, 2)?;
    let local_snapshot = collect_local_tree(&local_path)?;
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    let remote_path = session
        .sftp
        .canonicalize(if requested_remote_path.trim().is_empty() {
            "."
        } else {
            &requested_remote_path
        })
        .await
        .map_err(|error| format!("SFTP 比较路径解析失败：{error}"))?;
    let remote_snapshot = collect_remote_tree(&session.sftp, remote_path.clone()).await?;
    session.close().await;

    let comparison = compare_tree_snapshots(&local_snapshot, &remote_snapshot);
    let local_transfer_items =
        top_level_transfer_summaries(&local_snapshot, &comparison.local_differences);
    let remote_transfer_items =
        top_level_transfer_summaries(&remote_snapshot, &comparison.remote_differences);
    Ok(json!({
        "localPath": local_path.to_string_lossy(),
        "remotePath": remote_path,
        "differenceCount": comparison.difference_count,
        "localDifferences": comparison.local_differences,
        "remoteDifferences": comparison.remote_differences,
        "localTransferItems": local_transfer_items,
        "remoteTransferItems": remote_transfer_items,
    }))
}

pub(crate) async fn stat_sftp_path(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let path = string_arg(&args, 1)?;
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    let metadata = session
        .sftp
        .symlink_metadata(path)
        .await
        .map_err(|error| format!("SFTP 读取属性失败：{error}"))?;
    let value = metadata_json(&metadata);
    session.close().await;
    Ok(value)
}

pub(crate) async fn create_sftp_directory(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let path = string_arg(&args, 1)?;
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    session
        .sftp
        .create_dir(path)
        .await
        .map_err(|error| format!("SFTP 新建目录失败：{error}"))?;
    session.close().await;
    Ok(json!(true))
}

pub(crate) async fn create_sftp_file(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let path = string_arg(&args, 1)?;
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    let mut file = session
        .sftp
        .create(path)
        .await
        .map_err(|error| format!("SFTP 新建文件失败：{error}"))?;
    file.shutdown().await.map_err(error_string)?;
    session.close().await;
    Ok(json!(true))
}

async fn remove_sftp_tree(
    sftp: &SftpSession,
    path: String,
    entry_type: &str,
) -> Result<(), String> {
    if entry_type != "directory" {
        return sftp
            .remove_file(path)
            .await
            .map_err(|error| format!("SFTP 删除文件失败：{error}"));
    }

    let mut directories = vec![path.clone()];
    let mut visited = BTreeSet::new();
    let mut discovered = Vec::new();
    let mut files = Vec::new();
    let mut processed_entries = 0_usize;
    while let Some(directory) = directories.pop() {
        if !visited.insert(directory.clone()) {
            continue;
        }
        if visited.len() > MAX_RECURSIVE_SFTP_ENTRIES {
            return Err(format!(
                "待删除目录超过 {MAX_RECURSIVE_SFTP_ENTRIES} 项，请缩小删除范围。"
            ));
        }
        discovered.push(directory.clone());
        let entries = sftp
            .read_dir(directory.clone())
            .await
            .map_err(|error| format!("SFTP 读取待删除目录失败：{error}"))?;
        for entry in entries {
            let child_name = entry.file_name();
            if is_dot_directory(&child_name) {
                continue;
            }
            processed_entries = processed_entries.saturating_add(1);
            if processed_entries > MAX_RECURSIVE_SFTP_ENTRIES {
                return Err(format!(
                    "待删除目录超过 {MAX_RECURSIVE_SFTP_ENTRIES} 项，请缩小删除范围。"
                ));
            }
            let child_path = join_remote_path(&directory, &child_name);
            if entry.file_type().is_dir() {
                directories.push(child_path);
            } else {
                files.push(child_path);
            }
        }
    }
    stream::iter(files)
        .map(|file| async move {
            sftp.remove_file(file)
                .await
                .map_err(|error| format!("SFTP 删除文件失败：{error}"))
        })
        .buffer_unordered(SFTP_FILE_CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    for directory in discovered.into_iter().rev() {
        sftp.remove_dir(directory)
            .await
            .map_err(|error| format!("SFTP 删除目录失败：{error}"))?;
    }
    Ok(())
}

pub(crate) async fn delete_sftp_path(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let path = string_arg(&args, 1)?;
    let entry_type = args.get(2).and_then(Value::as_str).unwrap_or("file");
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    remove_sftp_tree(&session.sftp, path, entry_type).await?;
    session.close().await;
    Ok(json!(true))
}

pub(crate) async fn rename_sftp_path(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let old_path = string_arg(&args, 1)?;
    let new_path = string_arg(&args, 2)?;
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    session
        .sftp
        .rename(old_path, new_path)
        .await
        .map_err(|error| format!("SFTP 重命名失败：{error}"))?;
    session.close().await;
    Ok(json!(true))
}

pub(crate) async fn set_sftp_path_permissions(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let root_path = string_arg(&args, 1)?;
    let options = args.get(2).cloned().unwrap_or_else(|| json!({}));
    let mode = options.get("mode").and_then(Value::as_u64).unwrap_or(0o644);
    if mode > 0o7777 {
        return Err("SFTP 权限模式必须是 0000 到 7777 的八进制值。".to_string());
    }
    let mode = mode as u32;
    let recursive = options
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    let mut paths = vec![root_path];
    let mut visited = BTreeSet::new();
    while let Some(path) = paths.pop() {
        if !visited.insert(path.clone()) {
            continue;
        }
        if visited.len() > MAX_RECURSIVE_SFTP_ENTRIES {
            return Err(format!(
                "递归权限项目超过 {MAX_RECURSIVE_SFTP_ENTRIES} 项，请缩小操作范围。"
            ));
        }
        let current = session
            .sftp
            .symlink_metadata(path.clone())
            .await
            .map_err(|error| format!("SFTP 读取权限失败：{error}"))?;
        if recursive && current.is_dir() {
            let entries = session
                .sftp
                .read_dir(path.clone())
                .await
                .map_err(|error| format!("SFTP 读取递归目录失败：{error}"))?;
            paths.extend(entries.filter_map(|entry| {
                let name = entry.file_name();
                (!is_dot_directory(&name)).then(|| entry.path())
            }));
        }
        let mut next = FileAttributes::empty();
        next.permissions = Some((current.permissions.unwrap_or(0) & !0o7777) | mode);
        session
            .sftp
            .set_metadata(path, next)
            .await
            .map_err(|error| format!("SFTP 修改权限失败：{error}"))?;
    }
    session.close().await;
    Ok(json!(true))
}

#[derive(Clone)]
struct RemoteDownloadItem {
    remote_path: String,
    relative_path: PathBuf,
    size: u64,
}

async fn download_remote_file(
    sftp: &SftpSession,
    local_dir: &Path,
    item: RemoteDownloadItem,
    transfer: &TransferReporter,
) -> Result<u64, String> {
    transfer.check_canceled()?;
    let file_name = item
        .relative_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    transfer.start_parallel_file(&file_name);
    let local_path = local_dir.join(&item.relative_path);
    let mut remote_file = sftp
        .open(item.remote_path)
        .await
        .map_err(|error| format!("SFTP 打开下载文件失败：{error}"))?;
    let mut local_file = tokio::fs::File::create(&local_path)
        .await
        .map_err(error_string)?;
    let mut transferred = 0_u64;
    let mut buffer = vec![0_u8; TRANSFER_CHUNK_BYTES];
    loop {
        transfer.check_canceled()?;
        let read = remote_file.read(&mut buffer).await.map_err(error_string)?;
        if read == 0 {
            break;
        }
        local_file
            .write_all(&buffer[..read])
            .await
            .map_err(error_string)?;
        transfer.add_parallel_bytes(read as u64);
        transferred = transferred.saturating_add(read as u64);
    }
    local_file.flush().await.map_err(error_string)?;
    transfer.complete_file();
    Ok(transferred)
}

async fn collect_remote_download_plan(
    sftp: &SftpSession,
    roots: &[String],
    transfer: &TransferReporter,
) -> Result<(Vec<PathBuf>, Vec<RemoteDownloadItem>), String> {
    let mut directories = Vec::new();
    let mut files = Vec::new();
    let mut visited_directories = BTreeSet::new();
    let mut processed_entries = 0_usize;
    for root in roots {
        transfer.check_canceled()?;
        let name = sanitize_local_file_name(
            root.trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("download"),
            "download",
        );
        let metadata = sftp
            .symlink_metadata(root.clone())
            .await
            .map_err(|error| format!("SFTP 读取下载项失败：{error}"))?;
        if metadata.is_dir() {
            let root_relative = PathBuf::from(&name);
            let mut stack = vec![(root.clone(), root_relative.clone())];
            while let Some((remote_dir, relative_dir)) = stack.pop() {
                transfer.check_canceled()?;
                if !visited_directories.insert(remote_dir.clone()) {
                    continue;
                }
                directories.push(relative_dir.clone());
                transfer.discover_directory();
                let entries = sftp
                    .read_dir(remote_dir.clone())
                    .await
                    .map_err(|error| format!("SFTP 扫描下载目录失败：{error}"))?;
                for entry in entries {
                    transfer.check_canceled()?;
                    let remote_name = entry.file_name();
                    if is_dot_directory(&remote_name) {
                        continue;
                    }
                    processed_entries = processed_entries.saturating_add(1);
                    if processed_entries > MAX_RECURSIVE_SFTP_ENTRIES {
                        return Err(format!(
                            "下载目录超过 {MAX_RECURSIVE_SFTP_ENTRIES} 项，请缩小下载范围。"
                        ));
                    }
                    let child_name = sanitize_local_file_name(&remote_name, "download");
                    let child_remote = join_remote_path(&remote_dir, &remote_name);
                    let child_relative = relative_dir.join(child_name);
                    let child_metadata = entry.metadata();
                    if child_metadata.is_dir() {
                        stack.push((child_remote, child_relative));
                    } else {
                        files.push(RemoteDownloadItem {
                            remote_path: child_remote,
                            relative_path: child_relative,
                            size: child_metadata.size.unwrap_or(0),
                        });
                        transfer.discover_file();
                    }
                }
            }
        } else {
            files.push(RemoteDownloadItem {
                remote_path: root.clone(),
                relative_path: PathBuf::from(name),
                size: metadata.size.unwrap_or(0),
            });
            transfer.discover_file();
        }
    }
    Ok((directories, files))
}

pub(crate) async fn download_sftp_paths(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_paths = args
        .get(1)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let local_dir = PathBuf::from(string_arg(&args, 2)?);
    let conflict_policy = transfer_conflict_policy(args.get(3));
    let transfer = Arc::new(TransferReporter::new(
        &state,
        &window,
        &connection_id,
        "download",
        args.get(3),
        "download".to_string(),
    ));
    transfer.start_preparing(0);
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    transfer.start_planning();
    let (directories, mut files) =
        collect_remote_download_plan(&session.sftp, &remote_paths, &transfer).await?;
    let mut skipped_count = 0_u64;
    let mut blocked_directories = Vec::<PathBuf>::new();
    transfer.start_preparing(directories.len() as u64);
    for directory in directories {
        transfer.check_canceled()?;
        let blocked = blocked_directories
            .iter()
            .any(|parent| directory.starts_with(parent));
        if conflict_policy == TransferConflictPolicy::Skip && blocked {
            skipped_count = skipped_count.saturating_add(1);
            transfer.complete_directory();
            continue;
        }
        let target = local_dir.join(&directory);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_metadata) if conflict_policy == TransferConflictPolicy::Skip => {
                blocked_directories.push(directory);
                skipped_count = skipped_count.saturating_add(1);
            }
            Ok(metadata) => {
                remove_local_overwrite_target(&target, &metadata)?;
                fs::create_dir_all(&target).map_err(error_string)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(&target).map_err(error_string)?;
            }
            Err(error) => return Err(error_string(error)),
        }
        transfer.complete_directory();
    }
    if conflict_policy == TransferConflictPolicy::Skip {
        let mut transferable_files = Vec::with_capacity(files.len());
        for item in files {
            transfer.check_canceled()?;
            if blocked_directories
                .iter()
                .any(|parent| item.relative_path.starts_with(parent))
            {
                skipped_count = skipped_count.saturating_add(1);
                continue;
            }
            match fs::symlink_metadata(local_dir.join(&item.relative_path)) {
                Ok(_) => skipped_count = skipped_count.saturating_add(1),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    transferable_files.push(item)
                }
                Err(error) => return Err(error_string(error)),
            }
        }
        files = transferable_files;
    } else {
        for item in &files {
            transfer.check_canceled()?;
            let target = local_dir.join(&item.relative_path);
            match fs::symlink_metadata(&target) {
                Ok(metadata) if metadata.is_dir() || metadata.file_type().is_symlink() => {
                    remove_local_overwrite_target(&target, &metadata)?;
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error_string(error)),
            }
        }
    }
    let total = files.iter().map(|item| item.size).sum();
    transfer.set_totals(total, files.len() as u64, files.len() as u64);
    let transferred = stream::iter(files.iter().cloned())
        .map(|item| download_remote_file(&session.sftp, &local_dir, item, transfer.as_ref()))
        .buffer_unordered(SFTP_FILE_CONCURRENCY)
        .try_fold(0_u64, |total, size| async move {
            Ok(total.saturating_add(size))
        })
        .await?;
    session.close().await;
    transfer.finish(true, None);
    Ok(json!({
        "canceled": false,
        "directoryPath": local_dir.to_string_lossy(),
        "size": transferred,
        "fileCount": files.len(),
        "itemCount": remote_paths.len(),
        "skippedCount": skipped_count,
    }))
}

#[derive(Clone)]
struct LocalUploadItem {
    local_path: PathBuf,
    remote_path: String,
    size: u64,
}

enum LocalUploadPathKind {
    Directory,
    File(u64),
    Symlink,
    Other,
}

struct LocalUploadDirectoryEntry {
    path: PathBuf,
    kind: LocalUploadPathKind,
}

async fn run_local_scan_io<T, F>(
    path: &Path,
    transfer: &TransferReporter,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let display_path = path.to_string_lossy().to_string();
    transfer.set_scanning_path(&display_path);
    let mut task = tokio::task::spawn_blocking(operation);
    let timeout = tokio::time::sleep(LOCAL_SCAN_IO_TIMEOUT);
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            result = &mut task => {
                return result
                    .map_err(|error| format!("扫描本地路径失败（{display_path}）：{error}"))?;
            }
            _ = &mut timeout => {
                task.abort();
                return Err(format!(
                    "扫描本地路径超过 {} 秒，可能是失效的网络路径、映射盘或目录联接：{display_path}",
                    LOCAL_SCAN_IO_TIMEOUT.as_secs()
                ));
            }
            _ = tokio::time::sleep(LOCAL_SCAN_CANCEL_POLL) => {
                if let Err(error) = transfer.check_canceled() {
                    task.abort();
                    return Err(error);
                }
            }
        }
    }
}

async fn inspect_local_upload_path(
    path: PathBuf,
    transfer: &TransferReporter,
) -> Result<LocalUploadPathKind, String> {
    let operation_path = path.clone();
    run_local_scan_io(&path, transfer, move || {
        let metadata = fs::symlink_metadata(&operation_path).map_err(error_string)?;
        let file_type = metadata.file_type();
        Ok(if file_type.is_symlink() {
            LocalUploadPathKind::Symlink
        } else if metadata.is_dir() {
            LocalUploadPathKind::Directory
        } else if metadata.is_file() {
            LocalUploadPathKind::File(metadata.len())
        } else {
            LocalUploadPathKind::Other
        })
    })
    .await
}

async fn read_local_upload_directory(
    directory: PathBuf,
    transfer: &TransferReporter,
) -> Result<Vec<LocalUploadDirectoryEntry>, String> {
    let operation_path = directory.clone();
    run_local_scan_io(&directory, transfer, move || {
        let mut entries = Vec::new();
        for entry in fs::read_dir(&operation_path).map_err(error_string)? {
            let entry = entry.map_err(error_string)?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(error_string)?;
            let kind = if file_type.is_symlink() {
                // Never follow local symlinks or Windows directory junctions.
                // A stale network target can otherwise block scanning forever.
                LocalUploadPathKind::Symlink
            } else if file_type.is_dir() {
                LocalUploadPathKind::Directory
            } else if file_type.is_file() {
                LocalUploadPathKind::File(entry.metadata().map_err(error_string)?.len())
            } else {
                LocalUploadPathKind::Other
            };
            entries.push(LocalUploadDirectoryEntry { path, kind });
        }
        Ok(entries)
    })
    .await
}

async fn upload_local_file(
    sftp: &SftpSession,
    item: LocalUploadItem,
    transfer: &TransferReporter,
) -> Result<u64, String> {
    transfer.check_canceled()?;
    let file_name = item
        .local_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "upload".to_string());
    transfer.start_parallel_file(&file_name);
    let mut local_file = tokio::fs::File::open(&item.local_path)
        .await
        .map_err(error_string)?;
    let mut remote_file = sftp
        .create(item.remote_path)
        .await
        .map_err(|error| format!("SFTP 打开上传文件失败：{error}"))?;
    let mut transferred = 0_u64;
    let mut buffer = vec![0_u8; TRANSFER_CHUNK_BYTES];
    loop {
        transfer.check_canceled()?;
        let read = local_file.read(&mut buffer).await.map_err(error_string)?;
        if read == 0 {
            break;
        }
        remote_file
            .write_all(&buffer[..read])
            .await
            .map_err(error_string)?;
        transfer.add_parallel_bytes(read as u64);
        transferred = transferred.saturating_add(read as u64);
    }
    remote_file.flush().await.map_err(error_string)?;
    remote_file.shutdown().await.map_err(error_string)?;
    transfer.complete_file();
    Ok(transferred)
}

async fn collect_local_upload_plan(
    items: &[Value],
    remote_dir: &str,
    transfer: &TransferReporter,
) -> Result<(Vec<String>, Vec<LocalUploadItem>), String> {
    let mut directories = Vec::new();
    let mut files = Vec::new();
    for item in items {
        transfer.check_canceled()?;
        let local_path = PathBuf::from(item.get("path").and_then(Value::as_str).unwrap_or(""));
        if local_path.as_os_str().is_empty() {
            continue;
        }
        let remote_name = item
            .get("remoteName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| {
                local_path
                    .file_name()
                    .map(|value| value.to_string_lossy().to_string())
            })
            .unwrap_or_else(|| "upload".to_string());
        let target = join_remote_path(remote_dir, &remote_name);
        match inspect_local_upload_path(local_path.clone(), transfer).await? {
            LocalUploadPathKind::Directory => {
                let mut stack = vec![(local_path, target)];
                while let Some((local_dir, remote_target)) = stack.pop() {
                    transfer.check_canceled()?;
                    directories.push(remote_target.clone());
                    transfer.discover_directory();
                    for entry in read_local_upload_directory(local_dir, transfer).await? {
                        transfer.check_canceled()?;
                        let child_path = entry.path;
                        let child_target = join_remote_path(
                            &remote_target,
                            &child_path.file_name().unwrap_or_default().to_string_lossy(),
                        );
                        match entry.kind {
                            LocalUploadPathKind::Directory => {
                                stack.push((child_path, child_target))
                            }
                            LocalUploadPathKind::File(size) => {
                                files.push(LocalUploadItem {
                                    local_path: child_path,
                                    remote_path: child_target,
                                    size,
                                });
                                transfer.discover_file();
                            }
                            LocalUploadPathKind::Symlink | LocalUploadPathKind::Other => {}
                        }
                    }
                }
            }
            LocalUploadPathKind::File(size) => {
                files.push(LocalUploadItem {
                    local_path,
                    remote_path: target,
                    size,
                });
                transfer.discover_file();
            }
            LocalUploadPathKind::Symlink | LocalUploadPathKind::Other => {}
        }
    }
    Ok((directories, files))
}

pub(crate) async fn upload_sftp_paths(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let remote_dir = string_arg(&args, 1)?;
    let items = args
        .get(2)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let conflict_policy = transfer_conflict_policy(args.get(3));
    let transfer = Arc::new(TransferReporter::new(
        &state,
        &window,
        &connection_id,
        "upload",
        args.get(3),
        "upload".to_string(),
    ));
    transfer.start_planning();
    let item_count = items.len();
    let (directories, mut files) =
        match collect_local_upload_plan(&items, &remote_dir, &transfer).await {
            Ok(plan) => plan,
            Err(error) => {
                transfer.finish(false, Some(&error));
                return Err(error);
            }
        };
    transfer.start_preparing(directories.len() as u64);
    let session = open_sftp_session(&state, &window, &connection_id).await?;
    let mut skipped_count = 0_u64;
    let mut blocked_directories = Vec::<String>::new();
    for directory in directories {
        transfer.check_canceled()?;
        let blocked = blocked_directories
            .iter()
            .any(|parent| remote_path_is_within(&directory, parent));
        if conflict_policy == TransferConflictPolicy::Skip && blocked {
            skipped_count = skipped_count.saturating_add(1);
            transfer.complete_directory();
            continue;
        }
        let exists = session
            .sftp
            .try_exists(directory.clone())
            .await
            .map_err(|error| format!("SFTP 检查目录失败：{error}"))?;
        if !exists {
            session
                .sftp
                .create_dir(directory.clone())
                .await
                .map_err(|error| format!("SFTP 新建上传目录失败：{error}"))?;
        } else {
            let metadata = session
                .sftp
                .symlink_metadata(directory.clone())
                .await
                .map_err(|error| format!("SFTP 读取目标目录失败：{error}"))?;
            if !metadata.is_dir() {
                if conflict_policy == TransferConflictPolicy::Skip {
                    blocked_directories.push(directory);
                    skipped_count = skipped_count.saturating_add(1);
                } else {
                    let entry_type = file_type(&metadata);
                    remove_sftp_tree(&session.sftp, directory.clone(), entry_type).await?;
                    session
                        .sftp
                        .create_dir(directory)
                        .await
                        .map_err(|error| format!("SFTP 替换冲突目录失败：{error}"))?;
                }
            }
        }
        transfer.complete_directory();
    }
    if conflict_policy == TransferConflictPolicy::Skip {
        let mut transferable_files = Vec::with_capacity(files.len());
        for item in files {
            transfer.check_canceled()?;
            if blocked_directories
                .iter()
                .any(|parent| remote_path_is_within(&item.remote_path, parent))
            {
                skipped_count = skipped_count.saturating_add(1);
                continue;
            }
            let exists = session
                .sftp
                .try_exists(item.remote_path.clone())
                .await
                .map_err(|error| format!("SFTP 检查目标文件失败：{error}"))?;
            if exists {
                skipped_count = skipped_count.saturating_add(1);
            } else {
                transferable_files.push(item);
            }
        }
        files = transferable_files;
    } else {
        for item in &files {
            transfer.check_canceled()?;
            let exists = session
                .sftp
                .try_exists(item.remote_path.clone())
                .await
                .map_err(|error| format!("SFTP 检查目标文件失败：{error}"))?;
            if !exists {
                continue;
            }
            let metadata = session
                .sftp
                .symlink_metadata(item.remote_path.clone())
                .await
                .map_err(|error| format!("SFTP 读取目标文件失败：{error}"))?;
            if metadata.is_dir() || metadata.file_type() == FileType::Symlink {
                let entry_type = file_type(&metadata);
                remove_sftp_tree(&session.sftp, item.remote_path.clone(), entry_type).await?;
            }
        }
    }
    let total = files.iter().map(|item| item.size).sum();
    transfer.set_totals(total, files.len() as u64, files.len() as u64);
    let transferred = stream::iter(files.iter().cloned())
        .map(|item| upload_local_file(&session.sftp, item, transfer.as_ref()))
        .buffer_unordered(SFTP_FILE_CONCURRENCY)
        .try_fold(0_u64, |total, size| async move {
            Ok(total.saturating_add(size))
        })
        .await?;
    session.close().await;
    transfer.finish(true, None);
    let uploaded_paths = files
        .iter()
        .map(|item| json!(item.remote_path))
        .collect::<Vec<_>>();
    Ok(json!({
        "canceled": false,
        "remotePath": remote_dir,
        "remotePaths": uploaded_paths,
        "size": transferred,
        "fileCount": files.len(),
        "itemCount": item_count,
        "skippedCount": skipped_count,
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        compare_tree_snapshots, is_dot_directory, remote_path_is_within,
        remove_local_overwrite_target, top_level_transfer_summaries, transfer_conflict_policy,
        TransferConflictPolicy, TreeSnapshotEntry,
    };
    use serde_json::json;
    use std::{collections::BTreeMap, fs, time::SystemTime};

    fn entry(kind: &'static str, size: u64) -> TreeSnapshotEntry {
        TreeSnapshotEntry { kind, size }
    }

    #[test]
    fn recursive_sftp_walk_ignores_dot_directories() {
        assert!(is_dot_directory("."));
        assert!(is_dot_directory(".."));
        assert!(!is_dot_directory(".config"));
        assert!(!is_dot_directory("folder"));
    }

    #[test]
    fn transfer_conflict_policy_defaults_to_overwrite_and_accepts_skip() {
        assert_eq!(
            transfer_conflict_policy(Some(&json!({ "conflictPolicy": "skip" }))),
            TransferConflictPolicy::Skip
        );
        assert_eq!(
            transfer_conflict_policy(Some(&json!({ "conflictPolicy": "invalid" }))),
            TransferConflictPolicy::Overwrite
        );
        assert_eq!(
            transfer_conflict_policy(None),
            TransferConflictPolicy::Overwrite
        );
    }

    #[test]
    fn remote_conflict_subtrees_use_path_boundaries() {
        assert!(remote_path_is_within(
            "/root/toolbox/bin/app.exe",
            "/root/toolbox"
        ));
        assert!(remote_path_is_within("/root/toolbox", "/root/toolbox"));
        assert!(!remote_path_is_within(
            "/root/toolbox-old/app.exe",
            "/root/toolbox"
        ));
    }

    #[test]
    fn overwrite_cleanup_removes_conflicting_local_files_and_directories() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "shelldesk-sftp-overwrite-{}-{unique}",
            std::process::id()
        ));
        let file = root.join("file-conflict");
        let directory = root.join("directory-conflict");
        fs::create_dir_all(directory.join("nested")).expect("test directory should be created");
        fs::write(&file, b"conflict").expect("test file should be created");

        let file_metadata = fs::symlink_metadata(&file).expect("test file should exist");
        remove_local_overwrite_target(&file, &file_metadata)
            .expect("conflicting file should be removed");
        let directory_metadata =
            fs::symlink_metadata(&directory).expect("test directory should exist");
        remove_local_overwrite_target(&directory, &directory_metadata)
            .expect("conflicting directory should be removed recursively");

        assert!(!file.exists());
        assert!(!directory.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recursive_comparison_counts_nested_differences() {
        let local = BTreeMap::from([
            ("assets".to_string(), entry("directory", 0)),
            ("assets/app.js".to_string(), entry("file", 120)),
            ("assets/style.css".to_string(), entry("file", 80)),
            ("readme.md".to_string(), entry("file", 20)),
        ]);
        let remote = BTreeMap::from([
            ("assets".to_string(), entry("directory", 0)),
            ("assets/app.js".to_string(), entry("file", 100)),
            ("assets/old.js".to_string(), entry("file", 40)),
            ("readme.md".to_string(), entry("file", 20)),
        ]);

        let comparison = compare_tree_snapshots(&local, &remote);
        assert_eq!(comparison.difference_count, 3);
        assert_eq!(
            comparison.local_differences,
            vec!["assets/app.js", "assets/style.css"]
        );
        assert_eq!(
            comparison.remote_differences,
            vec!["assets/app.js", "assets/old.js"]
        );

        let transfer_items = top_level_transfer_summaries(&local, &comparison.local_differences);
        assert_eq!(transfer_items.len(), 1);
        assert_eq!(transfer_items[0]["name"], "assets");
        assert_eq!(transfer_items[0]["size"], 200);
        assert_eq!(transfer_items[0]["fileCount"], 2);
    }
}
