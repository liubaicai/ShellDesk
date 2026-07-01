use crate::{
    browser_proxy, database::tunnel::DatabaseTunnelSession, http_tunnel::HttpTunnelSession,
    proxy::SshProxyConfig, ssh_tunnel::SshTunnelHandle, terminal, updater::update_status, zmodem,
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fmt,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) data_dir: PathBuf,
    pub(crate) connections: Arc<Mutex<HashMap<String, ActiveConnection>>>,
    pub(crate) terminals: Arc<Mutex<HashMap<String, terminal::TerminalSession>>>,
    pub(crate) vnc_proxies: Arc<Mutex<HashMap<String, VncProxySession>>>,
    pub(crate) browser_proxies: Arc<Mutex<HashMap<String, browser_proxy::BrowserProxySession>>>,
    pub(crate) transfer_cancellations: Arc<Mutex<HashSet<String>>>,
    pub(crate) active_transfers: Arc<Mutex<HashMap<String, ActiveTransfer>>>,
    pub(crate) zmodem_upload_selections: Arc<Mutex<HashMap<String, zmodem::ZmodemUploadSelection>>>,
    pub(crate) database_sessions: Arc<Mutex<HashMap<String, Value>>>,
    pub(crate) database_tunnel_sessions: Arc<Mutex<HashMap<String, DatabaseTunnelSession>>>,
    pub(crate) http_tunnel_sessions: Arc<Mutex<HashMap<String, HttpTunnelSession>>>,
    pub(crate) update_state: Arc<Mutex<Value>>,
    pub(crate) pending_tauri_update: Arc<Mutex<Option<tauri_plugin_updater::Update>>>,
    pub(crate) sync_schedule_generation: Arc<Mutex<u64>>,
    pub(crate) ui_window: Arc<Mutex<Option<tauri::Window>>>,
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

impl AppState {
    pub(crate) fn new(data_dir: PathBuf) -> Self {
        Self {
            update_state: Arc::new(Mutex::new(update_status("idle", &data_dir, "1.0.0", None))),
            pending_tauri_update: Arc::new(Mutex::new(None)),
            data_dir,
            connections: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            vnc_proxies: Arc::new(Mutex::new(HashMap::new())),
            browser_proxies: Arc::new(Mutex::new(HashMap::new())),
            transfer_cancellations: Arc::new(Mutex::new(HashSet::new())),
            active_transfers: Arc::new(Mutex::new(HashMap::new())),
            zmodem_upload_selections: Arc::new(Mutex::new(HashMap::new())),
            database_sessions: Arc::new(Mutex::new(HashMap::new())),
            database_tunnel_sessions: Arc::new(Mutex::new(HashMap::new())),
            http_tunnel_sessions: Arc::new(Mutex::new(HashMap::new())),
            sync_schedule_generation: Arc::new(Mutex::new(0)),
            ui_window: Arc::new(Mutex::new(None)),
            host_key_responses: Arc::new(Mutex::new(HashMap::new())),
            keyboard_interactive_responses: Arc::new(Mutex::new(HashMap::new())),
            store_lock: Arc::new(Mutex::new(())),
            vault_operation_lock: Arc::new(AsyncMutex::new(())),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ActiveTransfer {
    pub(crate) connection_id: String,
    pub(crate) client_id: Option<String>,
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
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum ConnectionKind {
    Local,
    Ssh,
}

pub(crate) struct VncProxySession {
    pub(crate) connection_id: String,
    pub(crate) shutdown: Option<oneshot::Sender<()>>,
    pub(crate) ssh_tunnel: Option<SshTunnelHandle>,
}

#[derive(Clone)]
pub(crate) struct PrivilegeConfig {
    pub(crate) mode: String,
    pub(crate) password: String,
}
