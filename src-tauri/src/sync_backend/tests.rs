use super::*;
use base64::Engine;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

fn electron_safe_storage_encrypt(plaintext: &str) -> String {
    let mut bytes = plaintext.as_bytes().to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    assert_ne!(ok, 0);
    let encrypted = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    if !output.pbData.is_null() {
        unsafe {
            let _ = LocalFree(output.pbData as _);
        }
    }
    base64::engine::general_purpose::STANDARD.encode(encrypted)
}

#[test]
fn decrypts_windows_dpapi_safe_storage_payload() {
    let plaintext = r#"{"webdavPassword":"webdav-secret","syncPassphrase":"sync-secret"}"#;
    let ciphertext = electron_safe_storage_encrypt(plaintext);
    let decrypted = decrypt_electron_safe_storage(&ciphertext).unwrap();
    assert_eq!(decrypted, plaintext);
}

#[test]
fn normalizes_electron_protected_sync_store() {
    let ciphertext = electron_safe_storage_encrypt(
        r#"{"webdavPassword":"webdav-secret","syncPassphrase":"sync-secret"}"#,
    );
    let normalized = normalize_electron_protected_sync_store(json!({
        "format": "shelldesk-sync-settings",
        "version": 1,
        "protected": true,
        "ciphertext": ciphertext,
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "config": {
            "enabled": true,
            "webdavUrl": "https://dav.example.com/root",
            "webdavUsername": "alice",
            "webdavRemotePath": "/ShellDesk/sync.json",
            "intervalMinutes": 20
        },
        "state": {
            "deviceId": "device-1",
            "lastRecords": {},
            "lastTombstones": {}
        }
    }))
    .unwrap();

    assert_eq!(
        normalized
            .pointer("/secrets/webdavPassword")
            .and_then(Value::as_str),
        Some("webdav-secret")
    );
    assert_eq!(
        normalized
            .pointer("/secrets/syncPassphrase")
            .and_then(Value::as_str),
        Some("sync-secret")
    );
    assert_eq!(
        normalized
            .pointer("/config/webdavUsername")
            .and_then(Value::as_str),
        Some("alice")
    );
    assert_eq!(
        normalized
            .pointer("/state/deviceId")
            .and_then(Value::as_str),
        Some("device-1")
    );
}

#[test]
fn webdav_write_precondition_headers_match_legacy_etag_rules() {
    assert_eq!(
        webdav_write_precondition_headers("\"abc\"", true),
        vec![("If-Match", "\"abc\"".to_string())]
    );
    assert_eq!(
        webdav_write_precondition_headers("", false),
        vec![("If-None-Match", "*".to_string())]
    );
    assert!(webdav_write_precondition_headers("", true).is_empty());
}

#[test]
fn sync_footprint_tracks_record_and_tombstone_hashes_only() {
    let first = create_sync_footprint(
        &json!({
            "host:1": {
                "id": "host:1",
                "type": "host",
                "hash": "hash-a",
                "payload": { "name": "alpha" }
            }
        }),
        &json!({
            "bookmark:1": {
                "id": "bookmark:1",
                "type": "bookmark",
                "hash": "hash-b",
                "deletedAt": "2026-06-18T00:00:00.000Z"
            }
        }),
    );
    let second = create_sync_footprint(
        &json!({
            "host:1": {
                "id": "host:1",
                "type": "host",
                "hash": "hash-a",
                "payload": { "name": "renamed but same hash" }
            }
        }),
        &json!({
            "bookmark:1": {
                "id": "bookmark:1",
                "type": "bookmark",
                "hash": "hash-b",
                "deletedAt": "2026-06-19T00:00:00.000Z"
            }
        }),
    );
    let changed = create_sync_footprint(
        &json!({
            "host:1": {
                "id": "host:1",
                "type": "host",
                "hash": "hash-c",
                "payload": { "name": "alpha" }
            }
        }),
        &json!({
            "bookmark:1": {
                "id": "bookmark:1",
                "type": "bookmark",
                "hash": "hash-b"
            }
        }),
    );

    assert_eq!(first, second);
    assert_ne!(first, changed);
}

#[test]
fn initial_sync_divergence_requires_no_baseline_and_existing_remote_difference() {
    let local_records = json!({
        "host:local": {
            "id": "host:local",
            "type": "host",
            "hash": "local-hash"
        }
    });
    let local = json!({
        "localRecords": local_records,
        "localTombstones": {},
        "footprint": create_sync_footprint(&local_records, &json!({}))
    });
    let mut remote = create_empty_remote_document();
    remote["records"] = json!({
        "host:remote": {
            "id": "host:remote",
            "type": "host",
            "hash": "remote-hash"
        }
    });
    let empty_state = json!({
        "lastRecords": {},
        "lastTombstones": {},
        "lastRemoteEtag": ""
    });
    let synced_state = json!({
        "lastRecords": {
            "host:local": {
                "type": "host",
                "hash": "local-hash"
            }
        },
        "lastTombstones": {},
        "lastRemoteEtag": "\"etag-1\""
    });

    assert!(is_initial_sync_divergence(
        &empty_state,
        &local,
        &remote,
        true
    ));
    assert!(!is_initial_sync_divergence(
        &empty_state,
        &local,
        &remote,
        false
    ));
    assert!(!is_initial_sync_divergence(
        &synced_state,
        &local,
        &remote,
        true
    ));
    assert!(should_request_initial_sync_resolution(
        &empty_state,
        &local,
        &remote,
        true,
        false
    ));
    assert!(!should_request_initial_sync_resolution(
        &empty_state,
        &local,
        &remote,
        true,
        true
    ));
    assert!(applies_empty_vault_resolution("restoreRemote", 0, 135));
    assert!(applies_empty_vault_resolution("keepEmpty", 0, 135));
    assert!(!applies_empty_vault_resolution("", 0, 135));
    assert!(!applies_empty_vault_resolution("restoreRemote", 1, 135));

    remote["records"] = json!({
        "host:local": {
            "id": "host:local",
            "type": "host",
            "hash": "local-hash"
        }
    });
    assert!(!is_initial_sync_divergence(
        &empty_state,
        &local,
        &remote,
        true
    ));
}
