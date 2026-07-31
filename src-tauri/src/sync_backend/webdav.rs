use futures_util::StreamExt;
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::time::sleep;

use crate::{error_string, random_id};

pub(super) const MAX_REMOTE_SYNC_BYTES: usize = 25 * 1024 * 1024;
const WRITE_VERIFY_ATTEMPTS: usize = 3;

pub(super) fn normalize_webdav_url(value: &str, required: bool) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        if required {
            return Err("请输入 WebDAV 地址。".to_string());
        }
        return Ok(String::new());
    }
    let mut parsed = reqwest::Url::parse(trimmed).map_err(|_| "WebDAV 地址无效。".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("WebDAV 地址只支持 http 或 https。".to_string());
    }
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

pub(super) async fn webdav_request(
    config: &Value,
    secrets: &Value,
    method: &str,
    remote_path: &str,
    body: Option<String>,
    content_type: Option<&str>,
    headers: &[(&str, String)],
) -> Result<reqwest::Response, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(
            config
                .get("ignoreCertificateErrors")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(error_string)?;
    let url = webdav_url(config, remote_path)?;
    let username = config
        .get("webdavUsername")
        .and_then(Value::as_str)
        .unwrap_or("");
    let password = secrets
        .get("webdavPassword")
        .and_then(Value::as_str)
        .unwrap_or("");
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(error_string)?;
    let mut request = client
        .request(method, url)
        .basic_auth(username, Some(password));
    if let Some(content_type) = content_type {
        request = request.header("Content-Type", content_type);
    }
    for (key, value) in headers {
        request = request.header(*key, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    request.send().await.map_err(error_string)
}

fn webdav_url(config: &Value, remote_path: &str) -> Result<String, String> {
    let base = config
        .get("webdavUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let mut parsed = reqwest::Url::parse(base).map_err(|_| "WebDAV 地址无效。".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("WebDAV 地址只支持 http 或 https。".to_string());
    }
    let mut path = parsed.path().trim_end_matches('/').to_string();
    let remote = normalize_webdav_remote_path(remote_path)?;
    path.push_str(&remote);
    parsed.set_path(&path);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

pub(super) fn normalize_webdav_remote_path(value: &str) -> Result<String, String> {
    let normalized = value.replace('\\', "/").replace("//", "/");
    let path = if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    };
    let parts = path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty()
        || parts.iter().any(|part| {
            *part == "."
                || *part == ".."
                || part.contains('\0')
                || part.contains('?')
                || part.contains('#')
        })
    {
        return Err("远程同步文件路径无效。".to_string());
    }
    Ok(format!("/{}", parts.join("/")))
}

pub(super) async fn ensure_webdav_directories(
    config: &Value,
    secrets: &Value,
) -> Result<(), String> {
    let remote_path = config
        .get("webdavRemotePath")
        .and_then(Value::as_str)
        .unwrap_or("/ShellDesk/shelldesk-sync.json");
    let normalized = normalize_webdav_remote_path(remote_path)?;
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() <= 1 {
        return Ok(());
    }
    let mut current = String::new();
    for part in parts.iter().take(parts.len() - 1) {
        current.push('/');
        current.push_str(part);
        let response = webdav_request(config, secrets, "MKCOL", &current, None, None, &[]).await?;
        if !matches!(
            response.status().as_u16(),
            200 | 201 | 204 | 301 | 302 | 405 | 409
        ) {
            return Err(webdav_response_error(response, "创建 WebDAV 远程目录").await);
        }
    }
    Ok(())
}

pub(super) fn webdav_test_path(config: &Value) -> String {
    let remote_path = config
        .get("webdavRemotePath")
        .and_then(Value::as_str)
        .unwrap_or("/ShellDesk/shelldesk-sync.json");
    let normalized = normalize_webdav_remote_path(remote_path)
        .unwrap_or_else(|_| "/ShellDesk/shelldesk-sync.json".to_string());
    let parent = normalized
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    format!("{parent}/.shelldesk-webdav-test-{}.txt", random_id("test"))
}

pub(super) async fn webdav_response_error(response: reqwest::Response, action: &str) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if detail.is_empty() {
        format!("{action}失败：{status}")
    } else {
        format!(
            "{action}失败：{status}：{}",
            detail.chars().take(180).collect::<String>()
        )
    }
}

pub(super) async fn webdav_response_body_limited(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|content_length| content_length > limit as u64)
    {
        return Err("远端同步文件超过大小限制。".to_string());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(error_string)?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("远端同步文件超过大小限制。".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(super) async fn verify_webdav_write(
    config: &Value,
    secrets: &Value,
    remote_path: &str,
    expected_body: &str,
    put_etag: &str,
) -> Result<Value, String> {
    let expected_bytes = expected_body.as_bytes();
    let expected_hash = format!("{:x}", Sha256::digest(expected_bytes));
    let mut last_etag = String::new();
    let mut last_status = String::new();
    let mut last_hash = String::new();

    for attempt in 0..WRITE_VERIFY_ATTEMPTS {
        match webdav_request(config, secrets, "GET", remote_path, None, None, &[]).await {
            Ok(response) if response.status().is_success() => {
                last_etag = response
                    .headers()
                    .get("etag")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let bytes = webdav_response_body_limited(response, MAX_REMOTE_SYNC_BYTES).await?;
                last_hash = format!("{:x}", Sha256::digest(&bytes));
                if bytes == expected_bytes {
                    return Ok(json!({
                        "verified": true,
                        "etag": if last_etag.is_empty() { put_etag } else { &last_etag },
                        "sha256": expected_hash,
                    }));
                }
                last_status = "content-mismatch".to_string();
            }
            Ok(response) => {
                last_status = response.status().to_string();
            }
            Err(error) => {
                last_status = error;
            }
        }
        if attempt + 1 < WRITE_VERIFY_ATTEMPTS {
            sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
        }
    }

    if !put_etag.is_empty() && !last_etag.is_empty() && put_etag != last_etag {
        return Err("远端同步文件在写入校验期间被其他设备更新，本次同步基线未推进。".to_string());
    }
    Err(format!(
        "远端同步文件写入后的读回校验失败，本次同步基线未推进（状态：{last_status}，期望摘要：{}，实际摘要：{}）。",
        &expected_hash[..12],
        last_hash.get(..12).unwrap_or("unavailable")
    ))
}

pub(super) fn webdav_write_precondition_headers(
    etag: &str,
    exists: bool,
) -> Vec<(&'static str, String)> {
    if !etag.is_empty() {
        vec![("If-Match", etag.to_string())]
    } else if !exists {
        vec![("If-None-Match", "*".to_string())]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn serve_get_responses(
        listener: TcpListener,
        responses: Vec<(String, String)>,
    ) -> Result<(), String> {
        for (body, etag) in responses {
            let (mut stream, _) = listener.accept().await.map_err(error_string)?;
            let mut request = vec![0u8; 4096];
            let _ = stream.read(&mut request).await.map_err(error_string)?;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nETag: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                etag,
                body,
            );
            stream
                .write_all(response.as_bytes())
                .await
                .map_err(error_string)?;
            stream.shutdown().await.map_err(error_string)?;
        }
        Ok(())
    }

    #[tokio::test]
    async fn write_verification_reads_back_exact_bytes_and_prefers_get_etag() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = r#"{"format":"shelldesk-sync-encrypted","ciphertext":"test"}"#.to_string();
        let server = tokio::spawn(serve_get_responses(
            listener,
            vec![(body.clone(), "\"read-etag\"".to_string())],
        ));
        let config = json!({
            "webdavUrl": format!("http://{address}"),
            "webdavUsername": "test",
            "ignoreCertificateErrors": false,
        });
        let secrets = json!({ "webdavPassword": "test" });

        let verified = verify_webdav_write(&config, &secrets, "/sync.json", &body, "\"put-etag\"")
            .await
            .unwrap();

        assert_eq!(verified["verified"], true);
        assert_eq!(verified["etag"], "\"read-etag\"");
        assert_eq!(verified["sha256"].as_str().map(str::len), Some(64),);
        server.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn write_verification_rejects_a_concurrent_read_back() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let expected = r#"{"ciphertext":"expected"}"#.to_string();
        let responses = (0..WRITE_VERIFY_ATTEMPTS)
            .map(|_| {
                (
                    r#"{"ciphertext":"other-device"}"#.to_string(),
                    "\"other-etag\"".to_string(),
                )
            })
            .collect();
        let server = tokio::spawn(serve_get_responses(listener, responses));
        let config = json!({
            "webdavUrl": format!("http://{address}"),
            "webdavUsername": "test",
            "ignoreCertificateErrors": false,
        });
        let secrets = json!({ "webdavPassword": "test" });

        let error = verify_webdav_write(&config, &secrets, "/sync.json", &expected, "\"put-etag\"")
            .await
            .unwrap_err();

        assert!(error.contains("其他设备更新"));
        assert!(error.contains("基线未推进"));
        server.await.unwrap().unwrap();
    }
}
