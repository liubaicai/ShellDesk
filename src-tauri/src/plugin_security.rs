use crate::{error_string, now, read_json_file, write_json_file_private};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

const POLICY_VERSION: u64 = 1;
const MAX_PERMISSION_GRANTS: usize = 16;
const MAX_SCOPES_PER_GRANT: usize = 32;
const MAX_AUDIT_ENTRIES: usize = 500;
const AUDIT_FILE: &str = "plugin-security-audit.json";

#[derive(Clone, Copy)]
enum ScopeKind {
    None,
    HttpsOrigin,
    PluginPath,
    HostId,
    SettingKey,
}

#[derive(Clone, Copy)]
struct PermissionDefinition {
    id: &'static str,
    risk: &'static str,
    scope_kind: ScopeKind,
}

const PERMISSIONS: [PermissionDefinition; 9] = [
    PermissionDefinition {
        id: "settings.read",
        risk: "low",
        scope_kind: ScopeKind::SettingKey,
    },
    PermissionDefinition {
        id: "hosts.metadata.read",
        risk: "medium",
        scope_kind: ScopeKind::HostId,
    },
    PermissionDefinition {
        id: "plugin.storage.read",
        risk: "low",
        scope_kind: ScopeKind::PluginPath,
    },
    PermissionDefinition {
        id: "plugin.storage.write",
        risk: "medium",
        scope_kind: ScopeKind::PluginPath,
    },
    PermissionDefinition {
        id: "network.connect",
        risk: "high",
        scope_kind: ScopeKind::HttpsOrigin,
    },
    PermissionDefinition {
        id: "terminal.open",
        risk: "high",
        scope_kind: ScopeKind::HostId,
    },
    PermissionDefinition {
        id: "terminal.write",
        risk: "critical",
        scope_kind: ScopeKind::HostId,
    },
    PermissionDefinition {
        id: "clipboard.write",
        risk: "medium",
        scope_kind: ScopeKind::None,
    },
    PermissionDefinition {
        id: "notifications.show",
        risk: "low",
        scope_kind: ScopeKind::None,
    },
];

#[derive(Clone)]
struct PermissionGrant {
    permission: &'static PermissionDefinition,
    scopes: Vec<String>,
}

#[derive(Clone)]
struct ReviewedManifest {
    id: String,
    version: String,
    permissions: Vec<PermissionGrant>,
}

#[derive(Clone)]
pub(crate) struct PluginSecurityManager {
    audit_path: PathBuf,
    audit_entries: Arc<Mutex<Vec<Value>>>,
}

impl PluginSecurityManager {
    pub(crate) fn new(data_dir: &Path) -> Self {
        let audit_path = data_dir.join(AUDIT_FILE);
        let mut audit_entries = read_json_file(&audit_path, json!([]))
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter(is_valid_audit_entry)
            .collect::<Vec<_>>();
        audit_entries.truncate(MAX_AUDIT_ENTRIES);

        Self {
            audit_path,
            audit_entries: Arc::new(Mutex::new(audit_entries)),
        }
    }

    pub(crate) fn policy(&self) -> Value {
        json!({
            "policyVersion": POLICY_VERSION,
            "defaultDecision": "deny",
            "capabilityIssuedByReview": false,
            "auditFailureBehavior": "deny",
            "permissions": PERMISSIONS.iter().map(|permission| json!({
                "permission": permission.id,
                "risk": permission.risk,
                "scopeKind": scope_kind_name(permission.scope_kind),
                "scopeRequired": !matches!(permission.scope_kind, ScopeKind::None),
            })).collect::<Vec<_>>(),
            "isolationDefaults": {
                "workerProcess": "required",
                "environment": "empty",
                "hostFilesystem": "denied",
                "pluginStorage": "plugin-private",
                "network": "denied",
            },
        })
    }

    pub(crate) fn review_manifest(&self, value: &Value) -> Result<Value, String> {
        let audit_plugin_id = value
            .get("id")
            .and_then(Value::as_str)
            .map(sanitize_audit_text)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "<invalid>".to_string());
        let manifest = match parse_manifest(value) {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = self.record_audit(&audit_plugin_id, "manifest.review", "denied", &error);
                return Err(error);
            }
        };

        self.record_audit(
            &manifest.id,
            "manifest.review",
            "allowed",
            "Manifest syntax and declared scopes passed policy review; no runtime capability was issued.",
        )?;

        let declared = manifest
            .permissions
            .iter()
            .map(|grant| grant.permission.id)
            .collect::<HashSet<_>>();
        let decisions = PERMISSIONS
            .iter()
            .map(|permission| {
                let grant = manifest
                    .permissions
                    .iter()
                    .find(|grant| grant.permission.id == permission.id);
                json!({
                    "permission": permission.id,
                    "decision": if declared.contains(permission.id) { "allow" } else { "deny" },
                    "reason": if declared.contains(permission.id) { "declared-and-scoped" } else { "not-declared" },
                    "scopes": grant.map(|grant| grant.scopes.clone()).unwrap_or_default(),
                })
            })
            .collect::<Vec<_>>();

        Ok(json!({
            "valid": true,
            "policyVersion": POLICY_VERSION,
            "pluginId": manifest.id,
            "version": manifest.version,
            "capabilityIssued": false,
            "decisions": decisions,
            "isolation": {
                "namespace": format!("plugins/{}", manifest.id),
                "storageRoot": format!("plugin-data/{}", manifest.id),
                "workerProcess": "required",
                "environment": "empty",
                "hostFilesystem": "denied",
                "network": if declared.contains("network.connect") { "declared-https-origins-only" } else { "denied" },
            },
        }))
    }

    pub(crate) fn audit_entries(&self) -> Result<Value, String> {
        let entries = self
            .audit_entries
            .lock()
            .map_err(|_| "Plugin security audit lock is unavailable.".to_string())?;
        Ok(Value::Array(entries.clone()))
    }

    fn record_audit(
        &self,
        plugin_id: &str,
        operation: &str,
        decision: &str,
        reason: &str,
    ) -> Result<(), String> {
        let mut entries = self
            .audit_entries
            .lock()
            .map_err(|_| "Plugin security audit lock is unavailable.".to_string())?;
        entries.insert(
            0,
            json!({
                "timestamp": now(),
                "pluginId": sanitize_audit_text(plugin_id),
                "operation": operation,
                "decision": decision,
                "reason": sanitize_audit_text(reason),
            }),
        );
        entries.truncate(MAX_AUDIT_ENTRIES);
        write_json_file_private(&self.audit_path, &Value::Array(entries.clone()))
    }
}

fn parse_manifest(value: &Value) -> Result<ReviewedManifest, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Plugin manifest must be an object.".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| valid_plugin_id(id))
        .ok_or_else(|| {
            "Plugin id must use 1-64 lowercase ASCII letters, digits, dots, dashes, or underscores and cannot contain path traversal."
                .to_string()
        })?
        .to_string();
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|version| {
            !version.is_empty()
                && version.len() <= 64
                && version.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+' | '_')
                })
        })
        .ok_or_else(|| "Plugin version must be a non-empty safe version token.".to_string())?
        .to_string();
    let permission_values = object
        .get("permissions")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Plugin permissions must be an explicit array; omit access by using an empty array."
                .to_string()
        })?;
    if permission_values.len() > MAX_PERMISSION_GRANTS {
        return Err(format!(
            "Plugin manifest declares more than {MAX_PERMISSION_GRANTS} permissions."
        ));
    }

    let mut seen_permissions = HashSet::new();
    let mut permissions = Vec::with_capacity(permission_values.len());
    for permission_value in permission_values {
        let permission_object = permission_value.as_object().ok_or_else(|| {
            "Each plugin permission must be an object with permission and scopes fields."
                .to_string()
        })?;
        let permission_id = permission_object
            .get("permission")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        let permission = PERMISSIONS
            .iter()
            .find(|permission| permission.id == permission_id)
            .ok_or_else(|| {
                format!("Unknown plugin permission '{permission_id}' is denied by default.")
            })?;
        if !seen_permissions.insert(permission.id) {
            return Err(format!(
                "Plugin permission '{}' is declared more than once.",
                permission.id
            ));
        }
        let scope_values = permission_object
            .get("scopes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if scope_values.len() > MAX_SCOPES_PER_GRANT {
            return Err(format!(
                "Plugin permission '{}' declares more than {MAX_SCOPES_PER_GRANT} scopes.",
                permission.id
            ));
        }
        if matches!(permission.scope_kind, ScopeKind::None) && !scope_values.is_empty() {
            return Err(format!(
                "Plugin permission '{}' does not accept scopes.",
                permission.id
            ));
        }
        if !matches!(permission.scope_kind, ScopeKind::None) && scope_values.is_empty() {
            return Err(format!(
                "Plugin permission '{}' requires at least one explicit scope.",
                permission.id
            ));
        }
        let mut scopes = Vec::with_capacity(scope_values.len());
        for scope in scope_values {
            let raw_scope = scope.as_str().ok_or_else(|| {
                format!(
                    "Plugin permission '{}' scopes must be strings.",
                    permission.id
                )
            })?;
            let normalized_scope = normalize_scope(permission.scope_kind, raw_scope)
                .map_err(|error| format!("Invalid scope for '{}': {error}", permission.id))?;
            if !scopes.contains(&normalized_scope) {
                scopes.push(normalized_scope);
            }
        }
        permissions.push(PermissionGrant { permission, scopes });
    }

    Ok(ReviewedManifest {
        id,
        version,
        permissions,
    })
}

fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.contains("..")
        && id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '-' | '_')
        })
        && id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
}

fn normalize_scope(kind: ScopeKind, scope: &str) -> Result<String, String> {
    let scope = scope.trim();
    if scope.is_empty() || scope.len() > 256 || scope.chars().any(char::is_control) {
        return Err("scope is empty, too long, or contains control characters".to_string());
    }
    match kind {
        ScopeKind::None => Err("this permission is unscoped".to_string()),
        ScopeKind::HttpsOrigin => normalize_https_origin(scope),
        ScopeKind::PluginPath => normalize_plugin_path(scope),
        ScopeKind::HostId => normalize_identifier_scope(scope, "host id"),
        ScopeKind::SettingKey => {
            const ALLOWED_SETTINGS: [&str; 4] =
                ["language", "theme", "accentColor", "interfaceFont"];
            if ALLOWED_SETTINGS.contains(&scope) {
                Ok(scope.to_string())
            } else {
                Err("setting key is not in the public plugin settings allowlist".to_string())
            }
        }
    }
}

fn normalize_https_origin(scope: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(scope).map_err(error_string)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "network scope must be an HTTPS origin without credentials, paths, query, or fragment"
                .to_string(),
        );
    }
    let host = url
        .host_str()
        .ok_or_else(|| "network scope is missing a host".to_string())?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Ok(format!("https://{host}{port}"))
}

fn normalize_plugin_path(scope: &str) -> Result<String, String> {
    let normalized = scope.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err("plugin storage scope must be relative".to_string());
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part
                    .to_str()
                    .ok_or_else(|| "plugin storage scope must be UTF-8".to_string())?;
                if part.contains(':') {
                    return Err("plugin storage scope cannot contain a path prefix".to_string());
                }
                parts.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("plugin storage scope cannot escape plugin-private storage".to_string());
            }
        }
    }
    if parts.is_empty() {
        Ok(".".to_string())
    } else {
        Ok(parts.join("/"))
    }
}

fn normalize_identifier_scope(scope: &str, label: &str) -> Result<String, String> {
    if scope.len() <= 128
        && scope.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
    {
        Ok(scope.to_string())
    } else {
        Err(format!("{label} contains unsupported characters"))
    }
}

fn scope_kind_name(kind: ScopeKind) -> &'static str {
    match kind {
        ScopeKind::None => "none",
        ScopeKind::HttpsOrigin => "https-origin",
        ScopeKind::PluginPath => "plugin-path",
        ScopeKind::HostId => "host-id",
        ScopeKind::SettingKey => "setting-key",
    }
}

fn sanitize_audit_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(256)
        .collect()
}

fn is_valid_audit_entry(value: &Value) -> bool {
    value.get("timestamp").and_then(Value::as_str).is_some()
        && value.get("pluginId").and_then(Value::as_str).is_some()
        && value.get("operation").and_then(Value::as_str).is_some()
        && value.get("decision").and_then(Value::as_str).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(crate::random_id(prefix));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn manager(test_dir: &TestDirectory) -> PluginSecurityManager {
        PluginSecurityManager::new(&test_dir.path)
    }

    #[test]
    fn empty_permission_manifest_is_default_deny() {
        let test_dir = TestDirectory::new("plugin-security-default-deny");
        let result = manager(&test_dir)
            .review_manifest(&json!({
                "id": "example.plugin",
                "version": "1.0.0",
                "permissions": [],
            }))
            .unwrap();
        let decisions = result["decisions"].as_array().unwrap();

        assert!(decisions
            .iter()
            .all(|decision| decision["decision"] == "deny"));
        assert_eq!(result["capabilityIssued"], false);
        assert_eq!(result["isolation"]["hostFilesystem"], "denied");
        assert_eq!(result["isolation"]["network"], "denied");
    }

    #[test]
    fn unknown_permissions_and_path_traversal_are_denied() {
        let test_dir = TestDirectory::new("plugin-security-invalid");
        let security = manager(&test_dir);

        assert!(security
            .review_manifest(&json!({
                "id": "example.plugin",
                "version": "1.0.0",
                "permissions": [{ "permission": "vault.secrets.read", "scopes": [] }],
            }))
            .unwrap_err()
            .contains("denied by default"));
        assert!(security
            .review_manifest(&json!({
                "id": "../../escape",
                "version": "1.0.0",
                "permissions": [],
            }))
            .is_err());
        assert!(security
            .review_manifest(&json!({
                "id": "example.plugin",
                "version": "1.0.0",
                "permissions": [{
                    "permission": "plugin.storage.write",
                    "scopes": ["../../vault.json"],
                }],
            }))
            .unwrap_err()
            .contains("cannot escape"));
    }

    #[test]
    fn scoped_permissions_are_normalized_and_audited_without_manifest_secrets() {
        let test_dir = TestDirectory::new("plugin-security-scopes");
        let security = manager(&test_dir);
        let result = security
            .review_manifest(&json!({
                "id": "example.plugin",
                "version": "2.0.0-beta",
                "apiKey": "must-not-enter-audit",
                "permissions": [
                    {
                        "permission": "network.connect",
                        "scopes": ["https://EXAMPLE.com:443"],
                    },
                    {
                        "permission": "plugin.storage.read",
                        "scopes": ["cache/./reports"],
                    },
                ],
            }))
            .unwrap();
        let decisions = result["decisions"].as_array().unwrap();
        let network = decisions
            .iter()
            .find(|decision| decision["permission"] == "network.connect")
            .unwrap();
        let storage = decisions
            .iter()
            .find(|decision| decision["permission"] == "plugin.storage.read")
            .unwrap();

        assert_eq!(network["decision"], "allow");
        assert_eq!(network["scopes"], json!(["https://example.com"]));
        assert_eq!(storage["scopes"], json!(["cache/reports"]));
        let audit = security.audit_entries().unwrap().to_string();
        assert!(audit.contains("manifest.review"));
        assert!(!audit.contains("must-not-enter-audit"));
    }
}
