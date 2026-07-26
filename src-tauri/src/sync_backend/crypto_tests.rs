use super::*;
use base64::Engine;
use serde_json::json;

const TEST_PASSPHRASE: &str = "ShellDesk 测试密码";

fn test_document() -> Value {
    json!({
        "title": "远端同步",
        "nested": {
            "enabled": true,
            "items": ["你好", "ShellDesk", null],
            "count": 3
        }
    })
}

fn encrypted_fixture() -> Value {
    encrypt_remote_document(&test_document(), TEST_PASSPHRASE).unwrap()
}

fn mutate_encoded_byte(wrapper: &mut Value, key: &str) {
    let encoded = wrapper.get(key).and_then(Value::as_str).unwrap();
    let mut bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    bytes[0] ^= 0x01;
    wrapper[key] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
}

#[test]
fn encrypted_document_round_trips_nested_unicode_json() {
    let document = test_document();
    let encrypted = encrypt_remote_document(&document, TEST_PASSPHRASE).unwrap();

    assert_eq!(
        decrypt_remote_document(&encrypted, TEST_PASSPHRASE).unwrap(),
        document
    );
}

#[test]
fn encrypting_the_same_document_twice_uses_fresh_random_values() {
    let first = encrypted_fixture();
    let second = encrypted_fixture();

    assert_ne!(first["salt"], second["salt"]);
    assert_ne!(first["iv"], second["iv"]);
    assert_ne!(first["ciphertext"], second["ciphertext"]);
}

#[test]
fn decrypt_rejects_wrong_passphrase() {
    let encrypted = encrypted_fixture();

    assert_eq!(
        decrypt_remote_document(&encrypted, "错误密码").unwrap_err(),
        DAMAGED_SYNC_DOCUMENT_ERROR
    );
}

#[test]
fn decrypt_rejects_tampered_tag_and_ciphertext() {
    let encrypted = encrypted_fixture();

    for key in ["tag", "ciphertext"] {
        let mut tampered = encrypted.clone();
        mutate_encoded_byte(&mut tampered, key);
        assert_eq!(
            decrypt_remote_document(&tampered, TEST_PASSPHRASE).unwrap_err(),
            DAMAGED_SYNC_DOCUMENT_ERROR,
            "tampered {key} must be rejected"
        );
    }
}

#[test]
fn decrypt_rejects_invalid_base64() {
    let mut encrypted = encrypted_fixture();
    encrypted["salt"] = json!("%%%");

    assert_eq!(
        decrypt_remote_document(&encrypted, TEST_PASSPHRASE).unwrap_err(),
        DAMAGED_SYNC_DOCUMENT_ERROR
    );
}

#[test]
fn decrypt_rejects_invalid_format() {
    let mut encrypted = encrypted_fixture();
    encrypted["format"] = json!("unsupported");

    assert_eq!(
        decrypt_remote_document(&encrypted, TEST_PASSPHRASE).unwrap_err(),
        "远端同步文件不是 ShellDesk 加密同步包。"
    );
}

#[test]
fn decrypt_rejects_invalid_salt_iv_and_tag_lengths() {
    let encrypted = encrypted_fixture();
    for (key, lengths) in [
        ("salt", [SYNC_SALT_LENGTH - 1, SYNC_SALT_LENGTH + 1]),
        ("iv", [SYNC_IV_LENGTH - 1, SYNC_IV_LENGTH + 1]),
        ("tag", [SYNC_TAG_LENGTH - 1, SYNC_TAG_LENGTH + 1]),
    ] {
        for length in lengths {
            let mut malformed = encrypted.clone();
            malformed[key] =
                json!(base64::engine::general_purpose::STANDARD.encode(vec![0u8; length]));
            assert_eq!(
                decrypt_remote_document(&malformed, TEST_PASSPHRASE).unwrap_err(),
                DAMAGED_SYNC_DOCUMENT_ERROR,
                "{key} length {length} must be rejected"
            );
        }
    }
}
