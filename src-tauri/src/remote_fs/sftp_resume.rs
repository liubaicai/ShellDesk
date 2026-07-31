use super::commands::join_remote_path;
use crate::{
    error_string, random_id, read_json_file, replace_file_atomic, write_json_file_private,
};
use russh_sftp::{client::SftpSession, protocol::FileAttributes};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tokio::io::{AsyncRead, AsyncReadExt};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TransferSourceFingerprint {
    path: String,
    size: u64,
    modified_at_millis: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDownloadCheckpoint {
    source: TransferSourceFingerprint,
}

pub(super) fn remote_source_fingerprint(
    remote_path: &str,
    metadata: &FileAttributes,
) -> TransferSourceFingerprint {
    TransferSourceFingerprint {
        path: remote_path.to_string(),
        size: metadata.size.unwrap_or(0),
        modified_at_millis: metadata.mtime.map(|value| u64::from(value) * 1_000),
    }
}

pub(super) fn local_source_fingerprint(
    local_path: &Path,
    metadata: &fs::Metadata,
) -> TransferSourceFingerprint {
    let modified_at_millis = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| u64::try_from(value.as_millis()).ok());
    TransferSourceFingerprint {
        path: local_path.to_string_lossy().to_string(),
        size: metadata.len(),
        modified_at_millis,
    }
}

fn fingerprint_token(fingerprint: &TransferSourceFingerprint) -> String {
    let mut hasher = Sha256::new();
    hasher.update(fingerprint.path.as_bytes());
    hasher.update(fingerprint.size.to_le_bytes());
    hasher.update(
        fingerprint
            .modified_at_millis
            .unwrap_or(u64::MAX)
            .to_le_bytes(),
    );
    hasher
        .finalize()
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn local_download_staging_paths(local_path: &Path) -> (PathBuf, PathBuf) {
    let file_name = local_path
        .file_name()
        .map(|value| value.to_string_lossy())
        .unwrap_or_else(|| "download".into());
    let part_path = local_path.with_file_name(format!(".{file_name}.shelldesk.part"));
    let checkpoint_path = local_path.with_file_name(format!(".{file_name}.shelldesk.part.json"));
    (part_path, checkpoint_path)
}

pub(super) fn remove_local_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error_string(error)),
    }
}

pub(super) fn prepare_local_download_staging(
    local_path: &Path,
    fingerprint: &TransferSourceFingerprint,
) -> Result<(PathBuf, PathBuf, u64), String> {
    let (part_path, checkpoint_path) = local_download_staging_paths(local_path);
    let checkpoint_matches = read_json_file(&checkpoint_path, Value::Null)
        .ok()
        .and_then(|value| serde_json::from_value::<LocalDownloadCheckpoint>(value).ok())
        .is_some_and(|checkpoint| checkpoint.source == *fingerprint);
    let part_size = fs::metadata(&part_path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len());
    let resume_offset = if checkpoint_matches {
        part_size
            .filter(|size| *size <= fingerprint.size)
            .unwrap_or(0)
    } else {
        0
    };
    if !checkpoint_matches || part_size.is_some_and(|size| size > fingerprint.size) {
        remove_local_file_if_exists(&part_path)?;
        remove_local_file_if_exists(&checkpoint_path)?;
    }
    write_json_file_private(
        &checkpoint_path,
        &serde_json::to_value(LocalDownloadCheckpoint {
            source: fingerprint.clone(),
        })
        .map_err(error_string)?,
    )?;
    Ok((part_path, checkpoint_path, resume_offset))
}

fn remote_parent_and_name(path: &str) -> (&str, &str) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", name)) => ("/", name),
        Some((parent, name)) => (parent, name),
        None => ("", trimmed),
    }
}

pub(super) fn remote_upload_staging_path(
    remote_path: &str,
    fingerprint: &TransferSourceFingerprint,
) -> String {
    let (parent, name) = remote_parent_and_name(remote_path);
    join_remote_path(
        parent,
        &format!(".{name}.shelldesk-{}.part", fingerprint_token(fingerprint)),
    )
}

async fn prefix_digest<R>(reader: &mut R, length: u64) -> Result<Option<[u8; 32]>, String>
where
    R: AsyncRead + Unpin,
{
    let mut remaining = length;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 256 * 1024];
    while remaining > 0 {
        let limit = usize::try_from(remaining.min(buffer.len() as u64)).map_err(error_string)?;
        let read = reader
            .read(&mut buffer[..limit])
            .await
            .map_err(error_string)?;
        if read == 0 {
            return Ok(None);
        }
        hasher.update(&buffer[..read]);
        remaining = remaining.saturating_sub(read as u64);
    }
    Ok(Some(hasher.finalize().into()))
}

pub(super) async fn resume_prefix_matches(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
    length: u64,
) -> Result<bool, String> {
    if length == 0 {
        return Ok(true);
    }
    let mut remote_file = sftp
        .open(remote_path.to_string())
        .await
        .map_err(|error| format!("SFTP 打开断点校验文件失败：{error}"))?;
    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(error_string)?;
    let (remote_digest, local_digest) = tokio::try_join!(
        prefix_digest(&mut remote_file, length),
        prefix_digest(&mut local_file, length),
    )?;
    Ok(remote_digest.is_some() && remote_digest == local_digest)
}

fn remote_backup_path(remote_path: &str) -> String {
    let (parent, name) = remote_parent_and_name(remote_path);
    join_remote_path(
        parent,
        &format!(".{name}.shelldesk-{}.backup", random_id("replace")),
    )
}

pub(super) async fn replace_remote_file(
    sftp: &SftpSession,
    staging_path: &str,
    target_path: &str,
) -> Result<(), String> {
    match sftp
        .rename(staging_path.to_string(), target_path.to_string())
        .await
    {
        Ok(()) => return Ok(()),
        Err(rename_error) => {
            let target_exists = sftp
                .try_exists(target_path.to_string())
                .await
                .map_err(|error| format!("SFTP 检查待替换目标失败：{error}"))?;
            if !target_exists {
                return Err(format!("SFTP 原子替换上传目标失败：{rename_error}"));
            }
        }
    }

    let backup_path = remote_backup_path(target_path);
    sftp.rename(target_path.to_string(), backup_path.clone())
        .await
        .map_err(|error| format!("SFTP 备份待替换目标失败：{error}"))?;
    match sftp
        .rename(staging_path.to_string(), target_path.to_string())
        .await
    {
        Ok(()) => {
            let _ = sftp.remove_file(backup_path).await;
            Ok(())
        }
        Err(error) => {
            let rollback_error = sftp
                .rename(backup_path, target_path.to_string())
                .await
                .err();
            Err(match rollback_error {
                Some(rollback_error) => {
                    format!("SFTP 替换上传目标失败：{error}；恢复原文件也失败：{rollback_error}")
                }
                None => format!("SFTP 替换上传目标失败：{error}，已恢复原文件。"),
            })
        }
    }
}

pub(super) fn replace_local_download(part_path: &Path, target_path: &Path) -> Result<(), String> {
    replace_file_atomic(part_path, target_path)
}

#[cfg(test)]
mod tests {
    use super::{
        local_download_staging_paths, prepare_local_download_staging, remote_upload_staging_path,
        TransferSourceFingerprint,
    };
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn prefix_digest_requires_the_complete_requested_prefix() {
        let (mut writer, mut reader) = tokio::io::duplex(32);
        writer.write_all(b"checkpoint").await.unwrap();
        drop(writer);
        assert!(super::prefix_digest(&mut reader, 10)
            .await
            .unwrap()
            .is_some());

        let (mut short_writer, mut short_reader) = tokio::io::duplex(32);
        short_writer.write_all(b"short").await.unwrap();
        drop(short_writer);
        assert!(super::prefix_digest(&mut short_reader, 10)
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn resumable_staging_paths_are_hidden_and_fingerprint_scoped() {
        let local_target = PathBuf::from("D:/downloads/release.zip");
        let (part_path, checkpoint_path) = local_download_staging_paths(&local_target);
        assert_eq!(
            part_path.file_name().unwrap().to_string_lossy(),
            ".release.zip.shelldesk.part"
        );
        assert_eq!(
            checkpoint_path.file_name().unwrap().to_string_lossy(),
            ".release.zip.shelldesk.part.json"
        );

        let first = TransferSourceFingerprint {
            path: "D:/build/release.zip".to_string(),
            size: 1024,
            modified_at_millis: Some(1_700_000_000_000),
        };
        let changed = TransferSourceFingerprint {
            modified_at_millis: Some(1_700_000_001_000),
            ..first.clone()
        };
        let first_path = remote_upload_staging_path("/srv/release.zip", &first);
        let changed_path = remote_upload_staging_path("/srv/release.zip", &changed);
        assert!(first_path.starts_with("/srv/.release.zip.shelldesk-"));
        assert!(first_path.ends_with(".part"));
        assert_ne!(first_path, changed_path);
    }

    #[test]
    fn local_download_resume_requires_a_matching_source_fingerprint() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "shelldesk-sftp-resume-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("archive.tar");
        let fingerprint = TransferSourceFingerprint {
            path: "/srv/archive.tar".to_string(),
            size: 10,
            modified_at_millis: Some(1_700_000_000_000),
        };
        let (part_path, _checkpoint_path, offset) =
            prepare_local_download_staging(&target, &fingerprint).unwrap();
        assert_eq!(offset, 0);
        fs::write(&part_path, b"1234").unwrap();

        let (_, _, resumed_offset) = prepare_local_download_staging(&target, &fingerprint).unwrap();
        assert_eq!(resumed_offset, 4);

        let changed = TransferSourceFingerprint {
            size: 11,
            ..fingerprint
        };
        let (_, _, reset_offset) = prepare_local_download_staging(&target, &changed).unwrap();
        assert_eq!(reset_offset, 0);
        assert!(!part_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completed_local_download_replaces_the_old_target_atomically() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "shelldesk-sftp-replace-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("release.zip");
        let part = root.join(".release.zip.shelldesk.part");
        fs::write(&target, b"old").unwrap();
        fs::write(&part, b"new").unwrap();

        super::replace_local_download(&part, &target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(!part.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
