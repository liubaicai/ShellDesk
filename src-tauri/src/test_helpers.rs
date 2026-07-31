use crate::{ActiveConnection, ConnectionKind, PrivilegeConfig, SshProfile};
use serde_json::{json, Value};
use std::{collections::HashSet, path::PathBuf};

pub(crate) fn ssh_profile() -> SshProfile {
    SshProfile {
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
        keepalive_enabled: false,
        keepalive_interval_ms: 15_000,
        connect_timeout_ms: 15_000,
    }
}

pub(crate) fn active_ssh_connection(
    system_type: &str,
    privilege: Option<PrivilegeConfig>,
) -> ActiveConnection {
    active_connection(
        ConnectionKind::Ssh,
        json!({ "systemType": system_type }),
        Some(ssh_profile()),
        privilege,
    )
}

fn active_connection(
    kind: ConnectionKind,
    host: Value,
    ssh: Option<SshProfile>,
    privilege: Option<PrivilegeConfig>,
) -> ActiveConnection {
    ActiveConnection {
        id: "conn-1".to_string(),
        kind,
        partition: "persist:conn-1".to_string(),
        proxy_port: 0,
        browser_certificate_trust: HashSet::new(),
        connected_at: "now".to_string(),
        host,
        ssh,
        privilege,
        temporary_key_paths: Vec::<PathBuf>::new(),
    }
}
