use super::{
    compare_tree_snapshots, is_dot_directory, local_download_target_key, remote_path_is_within,
    remove_local_overwrite_target, reserve_transfer_target, sanitize_local_file_name,
    top_level_transfer_summaries, transfer_conflict_policy, TransferConflictPolicy,
    TreeSnapshotEntry,
};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    time::SystemTime,
};

fn entry(kind: &'static str, size: u64) -> TreeSnapshotEntry {
    TreeSnapshotEntry { kind, size }
}

#[test]
fn recursive_sftp_walk_ignores_dot_directories() {
    assert!(is_dot_directory("."));
    assert!(is_dot_directory(".."));
    assert!(!is_dot_directory(".config"));
    assert!(!is_dot_directory("folder"));
}

#[test]
fn transfer_plans_reject_two_sources_that_normalize_to_one_target() {
    let mut targets = BTreeSet::new();
    let first_name = sanitize_local_file_name("a:b.txt", "download");
    let second_name = sanitize_local_file_name("a?b.txt", "download");
    let first = local_download_target_key(Path::new("release").join(first_name).as_path());
    let second = local_download_target_key(Path::new("release").join(second_name).as_path());

    reserve_transfer_target(&mut targets, first, "/srv/a:b.txt").unwrap();
    let error = reserve_transfer_target(&mut targets, second, "/srv/a?b.txt").unwrap_err();
    assert!(error.contains("同一目标"));
}

#[test]
fn transfer_conflict_policy_defaults_to_overwrite_and_accepts_skip() {
    assert_eq!(
        transfer_conflict_policy(Some(&json!({ "conflictPolicy": "skip" }))),
        TransferConflictPolicy::Skip
    );
    assert_eq!(
        transfer_conflict_policy(Some(&json!({ "conflictPolicy": "invalid" }))),
        TransferConflictPolicy::Overwrite
    );
    assert_eq!(
        transfer_conflict_policy(None),
        TransferConflictPolicy::Overwrite
    );
}

#[test]
fn remote_conflict_subtrees_use_path_boundaries() {
    assert!(remote_path_is_within(
        "/root/toolbox/bin/app.exe",
        "/root/toolbox"
    ));
    assert!(remote_path_is_within("/root/toolbox", "/root/toolbox"));
    assert!(!remote_path_is_within(
        "/root/toolbox-old/app.exe",
        "/root/toolbox"
    ));
}

#[test]
fn overwrite_cleanup_removes_conflicting_local_files_and_directories() {
    let unique = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("clock should be after Unix epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "shelldesk-sftp-overwrite-{}-{unique}",
        std::process::id()
    ));
    let file = root.join("file-conflict");
    let directory = root.join("directory-conflict");
    fs::create_dir_all(directory.join("nested")).expect("test directory should be created");
    fs::write(&file, b"conflict").expect("test file should be created");

    let file_metadata = fs::symlink_metadata(&file).expect("test file should exist");
    remove_local_overwrite_target(&file, &file_metadata)
        .expect("conflicting file should be removed");
    let directory_metadata = fs::symlink_metadata(&directory).expect("test directory should exist");
    remove_local_overwrite_target(&directory, &directory_metadata)
        .expect("conflicting directory should be removed recursively");

    assert!(!file.exists());
    assert!(!directory.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn recursive_comparison_counts_nested_differences() {
    let local = BTreeMap::from([
        ("assets".to_string(), entry("directory", 0)),
        ("assets/app.js".to_string(), entry("file", 120)),
        ("assets/style.css".to_string(), entry("file", 80)),
        ("readme.md".to_string(), entry("file", 20)),
    ]);
    let remote = BTreeMap::from([
        ("assets".to_string(), entry("directory", 0)),
        ("assets/app.js".to_string(), entry("file", 100)),
        ("assets/old.js".to_string(), entry("file", 40)),
        ("readme.md".to_string(), entry("file", 20)),
    ]);

    let comparison = compare_tree_snapshots(&local, &remote);
    assert_eq!(comparison.difference_count, 3);
    assert_eq!(
        comparison.local_differences,
        vec!["assets/app.js", "assets/style.css"]
    );
    assert_eq!(
        comparison.remote_differences,
        vec!["assets/app.js", "assets/old.js"]
    );

    let transfer_items = top_level_transfer_summaries(&local, &comparison.local_differences);
    assert_eq!(transfer_items.len(), 1);
    assert_eq!(transfer_items[0]["name"], "assets");
    assert_eq!(transfer_items[0]["size"], 200);
    assert_eq!(transfer_items[0]["fileCount"], 2);
}
