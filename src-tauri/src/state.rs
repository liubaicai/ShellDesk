use crate::{
    browser_proxy, database::tunnel::DatabaseTunnelSession, http_tunnel::HttpTunnelSession,
    plugin_security::PluginSecurityManager, port_forward::PortForwardRuntimeEntry,
    proxy::SshProxyConfig, ssh_tunnel::SshTunnelHandle, terminal,
    transfer_history::TransferHistory, updater::update_status, zmodem,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fmt,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex},
};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) data_dir: PathBuf,
    pub(crate) connections: Arc<Mutex<HashMap<String, ActiveConnection>>>,
    pub(crate) terminals: Arc<Mutex<HashMap<String, terminal::TerminalSession>>>,
    pub(crate) vnc_proxies: Arc<Mutex<HashMap<String, DesktopProxySession>>>,
    pub(crate) rdp_proxies: Arc<Mutex<HashMap<String, DesktopProxySession>>>,
    pub(crate) browser_proxies: Arc<Mutex<HashMap<String, browser_proxy::BrowserProxySession>>>,
    pub(crate) transfer_cancellations: Arc<Mutex<HashSet<String>>>,
    pub(crate) active_transfers: Arc<Mutex<HashMap<String, ActiveTransfer>>>,
    pub(crate) deferred_connection_closures: Arc<Mutex<HashSet<String>>>,
    pub(crate) transfer_history: TransferHistory,
    pub(crate) zmodem_upload_selections: Arc<Mutex<HashMap<String, zmodem::ZmodemUploadSelection>>>,
    pub(crate) database_sessions: Arc<Mutex<HashMap<String, Value>>>,
    pub(crate) database_tunnel_sessions: Arc<Mutex<HashMap<String, DatabaseTunnelSession>>>,
    pub(crate) http_tunnel_sessions: Arc<Mutex<HashMap<String, HttpTunnelSession>>>,
    pub(crate) port_forward_runtimes: Arc<Mutex<HashMap<String, PortForwardRuntimeEntry>>>,
    pub(crate) plugin_security: PluginSecurityManager,
    pub(crate) update_state: Arc<Mutex<Value>>,
    pub(crate) update_operation_active: Arc<AtomicBool>,
    pub(crate) pending_tauri_update: Arc<Mutex<Option<tauri_plugin_updater::Update>>>,
    pub(crate) sync_schedule_generation: Arc<Mutex<u64>>,
    pub(crate) ui_window: Arc<Mutex<Option<UiWindowRef>>>,
    pub(crate) host_key_responses: Arc<Mutex<HashMap<String, HostKeyRequest>>>,
    pub(crate) keyboard_interactive_responses: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    pub(crate) store_lock: Arc<Mutex<()>>,
    pub(crate) vault_operation_lock: Arc<AsyncMutex<()>>,
}

pub(crate) struct HostKeyRequest {
    pub(crate) sender: oneshot::Sender<Value>,
    pub(crate) hostname: String,
    pub(crate) port: u16,
}

#[derive(Clone)]
pub(crate) struct UiWindowRef {
    pub(crate) window: tauri::Window,
}

impl UiWindowRef {
    pub(crate) fn from_window(window: &tauri::Window) -> Self {
        Self {
            window: window.clone(),
        }
    }

    pub(crate) fn emit<S>(&self, event: &str, payload: S) -> tauri::Result<()>
    where
        S: Serialize + Clone,
    {
        use tauri::Emitter;

        self.window.emit(event, payload)
    }
}

impl AppState {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        let transfer_history = TransferHistory::new(&data_dir);
        let plugin_security = PluginSecurityManager::new(&data_dir);
        Self {
            update_state: Arc::new(Mutex::new(update_status("idle", &data_dir, "1.0.0", None))),
            update_operation_active: Arc::new(AtomicBool::new(false)),
            pending_tauri_update: Arc::new(Mutex::new(None)),
            data_dir,
            connections: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            vnc_proxies: Arc::new(Mutex::new(HashMap::new())),
            rdp_proxies: Arc::new(Mutex::new(HashMap::new())),
            browser_proxies: Arc::new(Mutex::new(HashMap::new())),
            transfer_cancellations: Arc::new(Mutex::new(HashSet::new())),
            active_transfers: Arc::new(Mutex::new(HashMap::new())),
            deferred_connection_closures: Arc::new(Mutex::new(HashSet::new())),
            transfer_history,
            zmodem_upload_selections: Arc::new(Mutex::new(HashMap::new())),
            database_sessions: Arc::new(Mutex::new(HashMap::new())),
            database_tunnel_sessions: Arc::new(Mutex::new(HashMap::new())),
            http_tunnel_sessions: Arc::new(Mutex::new(HashMap::new())),
            port_forward_runtimes: Arc::new(crate::port_forward::new_runtime_map()),
            plugin_security,
            sync_schedule_generation: Arc::new(Mutex::new(0)),
            ui_window: Arc::new(Mutex::new(None)),
            host_key_responses: Arc::new(Mutex::new(HashMap::new())),
            keyboard_interactive_responses: Arc::new(Mutex::new(HashMap::new())),
            store_lock: Arc::new(Mutex::new(())),
            vault_operation_lock: Arc::new(AsyncMutex::new(())),
        }
    }

    pub(crate) fn clone_without_ui_window(&self) -> Self {
        Self {
            data_dir: self.data_dir.clone(),
            connections: self.connections.clone(),
            terminals: self.terminals.clone(),
            vnc_proxies: self.vnc_proxies.clone(),
            rdp_proxies: self.rdp_proxies.clone(),
            browser_proxies: self.browser_proxies.clone(),
            transfer_cancellations: self.transfer_cancellations.clone(),
            active_transfers: self.active_transfers.clone(),
            deferred_connection_closures: self.deferred_connection_closures.clone(),
            transfer_history: self.transfer_history.clone(),
            zmodem_upload_selections: self.zmodem_upload_selections.clone(),
            database_sessions: self.database_sessions.clone(),
            database_tunnel_sessions: self.database_tunnel_sessions.clone(),
            http_tunnel_sessions: self.http_tunnel_sessions.clone(),
            port_forward_runtimes: self.port_forward_runtimes.clone(),
            plugin_security: self.plugin_security.clone(),
            update_state: self.update_state.clone(),
            update_operation_active: self.update_operation_active.clone(),
            pending_tauri_update: self.pending_tauri_update.clone(),
            sync_schedule_generation: self.sync_schedule_generation.clone(),
            ui_window: Arc::new(Mutex::new(None)),
            host_key_responses: self.host_key_responses.clone(),
            keyboard_interactive_responses: self.keyboard_interactive_responses.clone(),
            store_lock: self.store_lock.clone(),
            vault_operation_lock: self.vault_operation_lock.clone(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ActiveTransfer {
    pub(crate) connection_id: String,
    pub(crate) client_id: Option<String>,
    pub(crate) resource_key: Option<String>,
}

#[derive(Clone)]
pub(crate) struct ActiveConnection {
    pub(crate) id: String,
    pub(crate) kind: ConnectionKind,
    pub(crate) partition: String,
    pub(crate) proxy_port: u16,
    pub(crate) browser_certificate_trust: HashSet<String>,
    pub(crate) connected_at: String,
    pub(crate) host: Value,
    pub(crate) ssh: Option<SshProfile>,
    pub(crate) privilege: Option<PrivilegeConfig>,
    pub(crate) temporary_key_paths: Vec<PathBuf>,
}

#[derive(Clone)]
pub(crate) struct SshProfile {
    pub(crate) address: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_method: String,
    pub(crate) password: String,
    pub(crate) key_path: String,
    pub(crate) known_hosts_path: String,
    pub(crate) proxy_helper_exe: String,
    pub(crate) proxy: Option<SshProxyConfig>,
    pub(crate) jump: Option<Box<SshProfile>>,
    pub(crate) keepalive_enabled: bool,
    pub(crate) keepalive_interval_ms: u64,
    pub(crate) connect_timeout_ms: u64,
}

impl fmt::Debug for SshProfile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshProfile")
            .field("address", &self.address)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth_method", &self.auth_method)
            .field("password", &"<redacted>")
            .field("key_path", &self.key_path)
            .field("known_hosts_path", &self.known_hosts_path)
            .field("proxy_helper_exe", &self.proxy_helper_exe)
            .field("proxy", &self.proxy)
            .field("jump", &self.jump)
            .field("keepalive_enabled", &self.keepalive_enabled)
            .field("keepalive_interval_ms", &self.keepalive_interval_ms)
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum ConnectionKind {
    Local,
    Ssh,
}

pub(crate) struct DesktopProxySession {
    pub(crate) connection_id: String,
    pub(crate) cancellation: CancellationToken,
    pub(crate) ssh_tunnel: Option<SshTunnelHandle>,
}

#[derive(Clone)]
pub(crate) struct PrivilegeConfig {
    pub(crate) mode: String,
    pub(crate) password: String,
}
