use super::transfer::TransferReporter;
use crate::error_string;
use futures_util::future;
use russh_sftp::client::{fs::File as SftpFile, SftpSession};
use std::io::SeekFrom;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

#[allow(clippy::too_many_arguments)]
pub(super) async fn download_remote_file_pipelined(
    sftp: &SftpSession,
    remote_path: &str,
    local_file: &mut tokio::fs::File,
    total_size: u64,
    chunk_bytes: usize,
    request_concurrency: usize,
    transferred: &mut u64,
    transfer: &TransferReporter,
) -> Result<(), String> {
    let remaining_chunks = total_size
        .saturating_sub(*transferred)
        .div_ceil(chunk_bytes as u64);
    let lane_count = request_concurrency.max(1).min(
        usize::try_from(remaining_chunks)
            .unwrap_or(usize::MAX)
            .max(1),
    );
    let mut readers = Vec::<SftpFile>::with_capacity(lane_count);
    for _ in 0..lane_count {
        readers.push(
            sftp.open(remote_path.to_string())
                .await
                .map_err(|error| format!("SFTP 打开下载文件失败：{error}"))?,
        );
    }

    while *transferred < total_size {
        transfer.check_canceled()?;
        let batch_start = *transferred;
        let reads = readers
            .iter_mut()
            .enumerate()
            .filter_map(|(lane, reader)| {
                let offset = batch_start
                    .saturating_add((lane as u64).saturating_mul(chunk_bytes as u64));
                if offset >= total_size {
                    return None;
                }
                let expected =
                    usize::try_from((total_size - offset).min(chunk_bytes as u64))
                        .unwrap_or(chunk_bytes);
                Some(async move {
                    reader
                        .seek(SeekFrom::Start(offset))
                        .await
                        .map_err(error_string)?;
                    let mut buffer = vec![0_u8; expected];
                    let mut filled = 0;
                    while filled < expected {
                        let read = reader
                            .read(&mut buffer[filled..])
                            .await
                            .map_err(error_string)?;
                        if read == 0 {
                            break;
                        }
                        filled += read;
                    }
                    if filled != expected {
                        return Err(format!(
                            "SFTP 下载数据提前结束：偏移 {offset}，预期 {expected} 字节，实际 {filled} 字节。"
                        ));
                    }
                    Ok::<Vec<u8>, String>(buffer)
                })
            })
            .collect::<Vec<_>>();
        let chunks = future::try_join_all(reads).await?;
        for chunk in chunks {
            local_file.write_all(&chunk).await.map_err(error_string)?;
            let read = chunk.len() as u64;
            transfer.add_parallel_bytes(read);
            *transferred = (*transferred).saturating_add(read);
        }
    }

    for reader in &mut readers {
        let _ = reader.shutdown().await;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn download_remote_file_sequential(
    sftp: &SftpSession,
    remote_path: &str,
    local_file: &mut tokio::fs::File,
    total_size: u64,
    chunk_bytes: usize,
    transferred: &mut u64,
    transfer: &TransferReporter,
) -> Result<(), String> {
    let mut remote_file = sftp
        .open(remote_path.to_string())
        .await
        .map_err(|error| format!("SFTP 打开下载文件失败：{error}"))?;
    remote_file
        .seek(SeekFrom::Start(*transferred))
        .await
        .map_err(error_string)?;
    let mut buffer = vec![0_u8; chunk_bytes];
    while *transferred < total_size {
        transfer.check_canceled()?;
        let remaining = usize::try_from((total_size - *transferred).min(chunk_bytes as u64))
            .unwrap_or(chunk_bytes);
        let read = remote_file
            .read(&mut buffer[..remaining])
            .await
            .map_err(error_string)?;
        if read == 0 {
            break;
        }
        local_file
            .write_all(&buffer[..read])
            .await
            .map_err(error_string)?;
        transfer.add_parallel_bytes(read as u64);
        *transferred = (*transferred).saturating_add(read as u64);
    }
    let _ = remote_file.shutdown().await;
    Ok(())
}
