use super::*;
use std::fs;

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(random_id(prefix));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[test]
fn local_sync_store_rejects_future_and_unknown_versioned_formats() {
    for value in [
        json!({
            "format": "shelldesk-sync-settings",
            "version": 2,
        }),
        json!({
            "format": "another-sync-store",
            "version": 1,
        }),
    ] {
        let directory = TestDirectory::new("sync-store-invariant");
        let state = AppState::new(directory.path.clone());
        write_json_file(&sync_path(&state), &value).unwrap();

        let error = read_sync_store(&state).unwrap_err();
        assert!(error.contains("不受支持"));
        assert!(error.contains("拒绝"));
    }
}

#[test]
fn local_legacy_sync_store_migrates_only_when_unversioned() {
    let directory = TestDirectory::new("sync-store-legacy");
    let state = AppState::new(directory.path.clone());
    write_json_file(
        &sync_path(&state),
        &json!({
            "enabled": false,
            "deviceId": "legacy-device",
            "lastRecords": {},
            "lastTombstones": {},
        }),
    )
    .unwrap();

    let migrated = read_sync_store(&state).unwrap();
    assert_eq!(migrated["format"], "shelldesk-sync-settings");
    assert_eq!(migrated["version"], 1);
    assert_eq!(
        migrated.pointer("/state/deviceId"),
        Some(&json!("legacy-device"))
    );
}
