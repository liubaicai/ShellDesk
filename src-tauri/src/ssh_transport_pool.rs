use crate::{
    russh_client::{connect_authenticated, RusshSession},
    AppState, SshProfile, UiWindowRef,
};
use russh::{client, Channel};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::Mutex as AsyncMutex;

const MAX_CHANNEL_LEASES_PER_TRANSPORT: usize = 8;
const POOLED_TRANSPORT_KEEPALIVE_INTERVAL_MS: u64 = 15_000;

fn pooled_transport_profile(mut profile: SshProfile) -> SshProfile {
    profile.keepalive_enabled = true;
    if profile.keepalive_interval_ms == 0 {
        profile.keepalive_interval_ms = POOLED_TRANSPORT_KEEPALIVE_INTERVAL_MS;
    }
    profile
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SshTransportLeaseKind {
    Terminal,
    SftpBrowse,
    SftpTransfer,
}

struct SshTransportSlot {
    session: AsyncMutex<Option<RusshSession>>,
    lease_count: AtomicUsize,
}

impl SshTransportSlot {
    fn new() -> Self {
        Self {
            session: AsyncMutex::new(None),
            lease_count: AtomicUsize::new(0),
        }
    }

    async fn ensure_connected(
        &self,
        state: AppState,
        window: Option<UiWindowRef>,
        profile: SshProfile,
    ) -> Result<(), String> {
        let mut session = self.session.lock().await;
        if session
            .as_ref()
            .is_some_and(|current| !current.handle().is_closed())
        {
            return Ok(());
        }

        if let Some(mut stale) = session.take() {
            stale.disconnect().await;
        }
        *session = Some(connect_authenticated(Some(state), window, profile).await?);
        Ok(())
    }

    async fn open_session_channel(&self) -> Result<Channel<client::Msg>, String> {
        let session = self.session.lock().await;
        let current = session
            .as_ref()
            .ok_or_else(|| "SSH 认证连接尚未建立。".to_string())?;
        if current.handle().is_closed() {
            return Err("SSH 认证连接已关闭。".to_string());
        }
        current
            .handle()
            .channel_open_session()
            .await
            .map_err(|error| format!("SSH 会话通道打开失败：{error}"))
    }

    async fn disconnect(&self) {
        if let Some(mut session) = self.session.lock().await.take() {
            session.disconnect().await;
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct SshTransportPool {
    slots: Arc<Mutex<HashMap<String, Vec<Arc<SshTransportSlot>>>>>,
}

impl SshTransportPool {
    fn reserve_slot(
        &self,
        connection_id: &str,
        kind: SshTransportLeaseKind,
    ) -> Result<SshTransportLease, String> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|error| format!("SSH 连接池锁定失败：{error}"))?;
        let connection_slots = slots.entry(connection_id.to_string()).or_default();
        let slot = connection_slots
            .iter()
            .filter(|slot| {
                slot.lease_count.load(Ordering::Relaxed) < MAX_CHANNEL_LEASES_PER_TRANSPORT
            })
            .min_by_key(|slot| slot.lease_count.load(Ordering::Relaxed))
            .cloned()
            .unwrap_or_else(|| {
                let slot = Arc::new(SshTransportSlot::new());
                connection_slots.push(slot.clone());
                slot
            });
        Ok(SshTransportLease::new(
            connection_id.to_string(),
            kind,
            slot,
        ))
    }

    pub(crate) async fn open_session_channel(
        &self,
        state: AppState,
        window: Option<UiWindowRef>,
        connection_id: &str,
        profile: SshProfile,
        kind: SshTransportLeaseKind,
    ) -> Result<(SshTransportLease, Channel<client::Msg>), String> {
        let lease = self.reserve_slot(connection_id, kind)?;
        lease
            .slot
            .ensure_connected(state, window, pooled_transport_profile(profile))
            .await?;
        let channel = lease.slot.open_session_channel().await?;
        Ok((lease, channel))
    }

    pub(crate) fn invalidate(&self, connection_id: &str) {
        let slot = self
            .slots
            .lock()
            .ok()
            .and_then(|mut slots| slots.remove(connection_id));
        if let Some(slots) = slot {
            for slot in slots {
                tauri::async_runtime::spawn(async move {
                    slot.disconnect().await;
                });
            }
        }
    }

    #[cfg(test)]
    fn transport_count(&self) -> usize {
        self.slots
            .lock()
            .map(|slots| slots.values().map(Vec::len).sum())
            .unwrap_or(0)
    }
}

pub(crate) struct SshTransportLease {
    _connection_id: String,
    _kind: SshTransportLeaseKind,
    slot: Arc<SshTransportSlot>,
}

impl SshTransportLease {
    fn new(
        connection_id: String,
        kind: SshTransportLeaseKind,
        slot: Arc<SshTransportSlot>,
    ) -> Self {
        slot.lease_count.fetch_add(1, Ordering::Relaxed);
        Self {
            _connection_id: connection_id,
            _kind: kind,
            slot,
        }
    }

    #[cfg(test)]
    fn connection_id(&self) -> &str {
        &self._connection_id
    }

    #[cfg(test)]
    fn kind(&self) -> SshTransportLeaseKind {
        self._kind
    }

    #[cfg(test)]
    pub(crate) fn shares_transport_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.slot, &other.slot)
    }
}

impl Drop for SshTransportLease {
    fn drop(&mut self) {
        self.slot.lease_count.fetch_sub(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_pool_can_be_invalidated_without_side_effects() {
        let pool = SshTransportPool::default();
        pool.invalidate("missing");
        assert_eq!(pool.transport_count(), 0);
    }

    #[test]
    fn lease_tracks_kind_and_connection_identity() {
        let slot = Arc::new(SshTransportSlot::new());
        let lease = SshTransportLease::new(
            "connection-1".to_string(),
            SshTransportLeaseKind::Terminal,
            slot.clone(),
        );
        assert_eq!(lease.connection_id(), "connection-1");
        assert_eq!(lease.kind(), SshTransportLeaseKind::Terminal);
        assert_eq!(slot.lease_count.load(Ordering::Relaxed), 1);
        drop(lease);
        assert_eq!(slot.lease_count.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn pool_opens_another_transport_before_exceeding_channel_capacity() {
        let pool = SshTransportPool::default();
        let mut leases = Vec::new();
        for _ in 0..MAX_CHANNEL_LEASES_PER_TRANSPORT {
            leases.push(
                pool.reserve_slot("connection-1", SshTransportLeaseKind::Terminal)
                    .unwrap(),
            );
        }
        assert_eq!(pool.transport_count(), 1);
        leases.push(
            pool.reserve_slot("connection-1", SshTransportLeaseKind::SftpTransfer)
                .unwrap(),
        );
        assert_eq!(pool.transport_count(), 2);
    }
}
