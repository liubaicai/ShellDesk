use russh_sftp::client::Config;
use serde_json::Value;

const BALANCED_PACKET_BYTES: u32 = 256 * 1024;
const BALANCED_CONCURRENT_WRITES: usize = 16;
const BALANCED_CONCURRENT_READS: usize = 8;
const COMPATIBILITY_PACKET_BYTES: u32 = 32 * 1024;
const REQUEST_TIMEOUT_SECS: u64 = 30;
const SMALL_FILE_BYTES: u64 = 512 * 1024;
const LARGE_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SftpTransferProfile {
    Balanced,
    Compatibility,
}

impl SftpTransferProfile {
    pub(super) fn from_options(options: Option<&Value>) -> Self {
        match options
            .and_then(|value| value.get("transferProfile"))
            .and_then(Value::as_str)
        {
            Some("compatibility") => Self::Compatibility,
            _ => Self::Balanced,
        }
    }

    pub(super) fn client_config(self) -> Config {
        match self {
            Self::Balanced => Config {
                max_packet_len: BALANCED_PACKET_BYTES,
                max_concurrent_writes: BALANCED_CONCURRENT_WRITES,
                request_timeout_secs: REQUEST_TIMEOUT_SECS,
            },
            Self::Compatibility => Config {
                max_packet_len: COMPATIBILITY_PACKET_BYTES,
                max_concurrent_writes: 1,
                request_timeout_secs: REQUEST_TIMEOUT_SECS,
            },
        }
    }

    pub(super) fn buffer_bytes(self) -> usize {
        self.client_config().max_packet_len as usize
    }

    pub(super) fn file_concurrency(self, total_bytes: u64, file_count: usize) -> usize {
        if file_count <= 1 || self == Self::Compatibility {
            return 1;
        }
        let average_bytes = total_bytes / file_count as u64;
        let maximum = if average_bytes <= SMALL_FILE_BYTES {
            8
        } else if average_bytes >= LARGE_FILE_BYTES {
            2
        } else {
            4
        };
        file_count.min(maximum)
    }

    pub(super) fn runtime_concurrency_cap(self) -> usize {
        match self {
            Self::Balanced => 4,
            Self::Compatibility => 1,
        }
    }

    pub(super) fn download_request_concurrency(self, file_concurrency: usize) -> usize {
        match self {
            Self::Balanced => (BALANCED_CONCURRENT_READS / file_concurrency.max(1)).max(1),
            Self::Compatibility => 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SftpTransferProfile;
    use russh_sftp::{
        client::SftpSession,
        protocol::{FileAttributes, Handle, OpenFlags, Status, StatusCode},
        server::{self, Handler},
    };
    use std::{
        sync::{Arc, Mutex},
        time::Instant,
    };
    use tokio::io::AsyncWriteExt;

    #[derive(Clone, Default)]
    struct RecordedWrites {
        bytes: Arc<Mutex<Vec<u8>>>,
        request_sizes: Arc<Mutex<Vec<usize>>>,
    }

    struct RecordingServer {
        recorded: RecordedWrites,
    }

    impl Handler for RecordingServer {
        type Error = StatusCode;

        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }

        async fn open(
            &mut self,
            id: u32,
            _filename: String,
            _pflags: OpenFlags,
            _attrs: FileAttributes,
        ) -> Result<Handle, Self::Error> {
            Ok(Handle {
                id,
                handle: "benchmark-file".to_string(),
            })
        }

        async fn write(
            &mut self,
            id: u32,
            _handle: String,
            offset: u64,
            data: Vec<u8>,
        ) -> Result<Status, Self::Error> {
            let offset = usize::try_from(offset).map_err(|_| StatusCode::Failure)?;
            let end = offset.checked_add(data.len()).ok_or(StatusCode::Failure)?;
            let mut bytes = self
                .recorded
                .bytes
                .lock()
                .map_err(|_| StatusCode::Failure)?;
            if bytes.len() < end {
                bytes.resize(end, 0);
            }
            bytes[offset..end].copy_from_slice(&data);
            self.recorded
                .request_sizes
                .lock()
                .map_err(|_| StatusCode::Failure)?
                .push(data.len());
            Ok(ok_status(id))
        }

        async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
            Ok(ok_status(id))
        }
    }

    fn ok_status(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }

    async fn run_workload(
        profile: SftpTransferProfile,
        server_packet_limit: u32,
        payload: &[u8],
    ) -> RecordedWrites {
        let (client_stream, server_stream) = tokio::io::duplex(1024 * 1024);
        let recorded = RecordedWrites::default();
        server::run_with_config(
            server_stream,
            RecordingServer {
                recorded: recorded.clone(),
            },
            server::Config {
                max_client_packet_len: server_packet_limit,
            },
        )
        .await;
        let session = SftpSession::new_with_config(client_stream, profile.client_config())
            .await
            .unwrap();
        let mut file = session.create("/benchmark.bin").await.unwrap();
        file.write_all(payload).await.unwrap();
        file.shutdown().await.unwrap();
        session.close().await.unwrap();
        recorded
    }

    #[test]
    fn balanced_pipeline_stays_inside_the_memory_budget() {
        let profile = SftpTransferProfile::Balanced;
        let config = profile.client_config();
        assert_eq!(config.max_concurrent_writes, 16);
        assert_eq!(profile.file_concurrency(8 * 128 * 1024, 8), 8);
        assert_eq!(
            config.max_packet_len as usize
                * config.max_concurrent_writes
                * profile.file_concurrency(8 * 128 * 1024, 8),
            32 * 1024 * 1024
        );
        assert_eq!(profile.file_concurrency(256 * 1024 * 1024, 4), 2);
        assert_eq!(profile.download_request_concurrency(1), 8);
        assert_eq!(profile.download_request_concurrency(2), 4);
        assert_eq!(profile.download_request_concurrency(8), 1);
    }

    #[test]
    fn compatibility_profile_caps_every_parallelism_layer() {
        let profile = SftpTransferProfile::Compatibility;
        let config = profile.client_config();
        assert_eq!(config.max_packet_len, 32 * 1024);
        assert_eq!(config.max_concurrent_writes, 1);
        assert_eq!(profile.file_concurrency(u64::MAX, 10_000), 1);
        assert_eq!(profile.runtime_concurrency_cap(), 1);
        assert_eq!(profile.download_request_concurrency(1), 1);
    }

    #[tokio::test]
    async fn compatibility_profile_transfers_through_a_strict_packet_server() {
        let payload = vec![0x5a; 512 * 1024];
        let recorded = run_workload(SftpTransferProfile::Compatibility, 40 * 1024, &payload).await;
        assert_eq!(*recorded.bytes.lock().unwrap(), payload);
        assert!(recorded
            .request_sizes
            .lock()
            .unwrap()
            .iter()
            .all(|size| *size <= 32 * 1024));
    }

    #[tokio::test]
    async fn representative_workload_uses_fewer_balanced_requests() {
        let payload = vec![0xa5; 2 * 1024 * 1024];
        let balanced = run_workload(SftpTransferProfile::Balanced, 256 * 1024, &payload).await;
        let compatibility =
            run_workload(SftpTransferProfile::Compatibility, 40 * 1024, &payload).await;
        assert_eq!(*balanced.bytes.lock().unwrap(), payload);
        assert_eq!(*compatibility.bytes.lock().unwrap(), payload);
        let balanced_requests = balanced.request_sizes.lock().unwrap().len();
        let compatibility_requests = compatibility.request_sizes.lock().unwrap().len();
        assert!(
            balanced_requests * 4 < compatibility_requests,
            "balanced={balanced_requests}, compatibility={compatibility_requests}"
        );
    }

    #[tokio::test]
    #[ignore = "manual in-memory throughput benchmark"]
    async fn sftp_profile_benchmark() {
        let payload = vec![0x7f; 8 * 1024 * 1024];
        for (profile, packet_limit) in [
            (SftpTransferProfile::Balanced, 256 * 1024),
            (SftpTransferProfile::Compatibility, 40 * 1024),
        ] {
            let started = Instant::now();
            let recorded = run_workload(profile, packet_limit, &payload).await;
            let elapsed = started.elapsed();
            let requests = recorded.request_sizes.lock().unwrap().len();
            let mib_per_second = payload.len() as f64 / (1024.0 * 1024.0) / elapsed.as_secs_f64();
            eprintln!(
                "{profile:?}: {requests} write requests, {mib_per_second:.1} MiB/s in-memory"
            );
        }
    }
}
