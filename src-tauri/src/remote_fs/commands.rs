use crate::{error_string, shell_quote, ActiveConnection};
use base64::Engine;
use chrono::Utc;
use serde_json::{json, Value};

pub(crate) fn remote_sftp_probe_command() -> String {
    [
        "for candidate in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server /usr/local/libexec/sftp-server /usr/local/lib/sftp-server; do",
        "  if [ -x \"$candidate\" ]; then exit 0; fi",
        "done",
        "for config in /etc/ssh/sshd_config /etc/sshd_config; do",
        "  if [ -r \"$config\" ] && grep -Eq '^[[:space:]]*Subsystem[[:space:]]+sftp[[:space:]]+internal-sftp([[:space:]]|$)' \"$config\"; then exit 0; fi",
        "done",
        "command -v sftp-server >/dev/null 2>&1",
    ]
    .join("\n")
}

pub(super) fn remote_basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("download")
        .to_string()
}

pub(super) fn remote_dirname(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "/" {
        return "/".to_string();
    }
    match trimmed.rsplit_once('/') {
        Some(("", _)) => "/".to_string(),
        Some((parent, _)) if !parent.is_empty() => parent.to_string(),
        _ => ".".to_string(),
    }
}

pub(super) fn remote_file_read_command(remote_path: &str) -> String {
    format!(
        "test -f {path} && (base64 < {path} 2>/dev/null || openssl base64 -A < {path}) | tr -d '\\r\\n'",
        path = shell_quote(remote_path)
    )
}

pub(super) fn remote_file_write_command(remote_path: &str) -> String {
    format!(
        r#"parent=$(dirname -- {path}); mkdir -p -- "$parent" && tmp=$(mktemp) && cat > "$tmp" && (base64 -d "$tmp" > {path} 2>/dev/null || base64 -D "$tmp" > {path} 2>/dev/null || openssl base64 -d -A -in "$tmp" -out {path}) ; code=$?; rm -f "$tmp"; exit $code"#,
        path = shell_quote(remote_path)
    )
}

pub(super) fn remote_directory_archive_command(remote_path: &str) -> String {
    let parent = remote_dirname(remote_path);
    let name = remote_basename(remote_path);
    format!(
        "cd {parent} && tar -czf - -- {name} | base64 | tr -d '\\r\\n'",
        parent = shell_quote(&parent),
        name = shell_quote(&name)
    )
}

pub(super) fn join_remote_path(parent: &str, name: &str) -> String {
    if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

pub(super) fn remote_list_directory_command(
    connection: &ActiveConnection,
    remote_path: &str,
) -> String {
    if remote_host_is_windows(connection) {
        return create_powershell_command(&format!(
            r#"$target = {target}
if (-not (Test-Path -LiteralPath $target -PathType Container)) {{
  [Console]::Error.WriteLine('远程目录不存在。')
  exit 40
}}
$resolved = (Resolve-Path -LiteralPath $target).Path
$items = @(Get-ChildItem -LiteralPath $target -Force | ForEach-Object {{
  $entryType = if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {{ 'symlink' }} elseif ($_.PSIsContainer) {{ 'directory' }} else {{ 'file' }}
  $entrySize = if ($_.PSIsContainer) {{ 0 }} else {{ [int64]$_.Length }}
  [pscustomobject]@{{
    name = $_.Name
    longname = $_.FullName
    type = $entryType
    size = $entrySize
    mode = $(if ($_.IsReadOnly) {{ 292 }} else {{ 438 }})
    owner = 0
    group = 0
    modifiedAt = $_.LastWriteTimeUtc.ToString('o')
  }}
}})
[pscustomobject]@{{ path = $resolved; entries = $items }} | ConvertTo-Json -Compress -Depth 5"#,
            target = quote_powershell_string(remote_path)
        ));
    }
    format!(
        "find {} -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\t%s\\t%T@\\n'",
        shell_quote(remote_path)
    )
}

pub(super) fn remote_stat_path_command(connection: &ActiveConnection, remote_path: &str) -> String {
    if remote_host_is_windows(connection) {
        return create_powershell_command(&format!(
            r#"$target = {target}
if (-not (Test-Path -LiteralPath $target)) {{
  [Console]::Error.WriteLine('远程路径不存在。')
  exit 40
}}
$item = Get-Item -LiteralPath $target -Force
$entryType = if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {{ 'symlink' }} elseif ($item.PSIsContainer) {{ 'directory' }} else {{ 'file' }}
$entrySize = if ($item.PSIsContainer) {{ 0 }} else {{ [int64]$item.Length }}
[pscustomobject]@{{
  type = $entryType
  size = $entrySize
  mode = $(if ($item.IsReadOnly) {{ 292 }} else {{ 438 }})
  owner = 0
  group = 0
  modifiedAt = $item.LastWriteTimeUtc.ToString('o')
  accessedAt = $item.LastAccessTimeUtc.ToString('o')
}} | ConvertTo-Json -Compress -Depth 4"#,
            target = quote_powershell_string(remote_path)
        ));
    }
    format!(
        "stat -c '%F\\t%s\\t%a\\t%u\\t%g\\t%Y\\t%X' -- {}",
        shell_quote(remote_path)
    )
}

pub(super) fn remote_read_file_command(connection: &ActiveConnection, remote_path: &str) -> String {
    if remote_host_is_windows(connection) {
        return create_powershell_command(&format!(
            "[Console]::Out.Write([IO.File]::ReadAllText({}))",
            quote_powershell_string(remote_path)
        ));
    }
    format!("cat -- {}", shell_quote(remote_path))
}

pub(super) fn remote_write_file_command(
    connection: &ActiveConnection,
    remote_path: &str,
) -> String {
    if remote_host_is_windows(connection) {
        return create_powershell_command(&format!(
            r#"$target = {target}
$parent = Split-Path -LiteralPath $target -Parent
if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {{
  [Console]::Error.WriteLine('远程目录不存在。')
  exit 40
}}
$content = [Console]::In.ReadToEnd()
[IO.File]::WriteAllText($target, $content, $__shelldeskUtf8)"#,
            target = quote_powershell_string(remote_path)
        ));
    }
    format!("cat > {}", shell_quote(remote_path))
}

pub(super) fn remote_create_directory_command(
    connection: &ActiveConnection,
    remote_path: &str,
) -> String {
    if remote_host_is_windows(connection) {
        return create_powershell_command(&format!(
            "New-Item -ItemType Directory -LiteralPath {} -Force | Out-Null",
            quote_powershell_string(remote_path)
        ));
    }
    format!("mkdir -p -- {}", shell_quote(remote_path))
}

pub(super) fn remote_create_file_command(
    connection: &ActiveConnection,
    remote_path: &str,
) -> String {
    if remote_host_is_windows(connection) {
        return create_powershell_command(&format!(
            r#"$target = {target}
$parent = Split-Path -LiteralPath $target -Parent
if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {{
  [Console]::Error.WriteLine('远程目录不存在。')
  exit 40
}}
New-Item -ItemType File -LiteralPath $target -Force | Out-Null"#,
            target = quote_powershell_string(remote_path)
        ));
    }
    format!(": > {}", shell_quote(remote_path))
}

pub(super) fn remote_delete_path_command(
    connection: &ActiveConnection,
    remote_path: &str,
    entry_type: &str,
) -> String {
    if remote_host_is_windows(connection) {
        return create_powershell_command(&format!(
            "Remove-Item -LiteralPath {} -Force {}",
            quote_powershell_string(remote_path),
            if entry_type == "directory" {
                "-Recurse"
            } else {
                ""
            }
        ));
    }
    if entry_type == "directory" {
        format!("rm -rf -- {}", shell_quote(remote_path))
    } else {
        format!("rm -f -- {}", shell_quote(remote_path))
    }
}

pub(super) fn remote_rename_path_command(
    connection: &ActiveConnection,
    old_path: &str,
    new_path: &str,
) -> String {
    if remote_host_is_windows(connection) {
        return create_powershell_command(&format!(
            "Move-Item -LiteralPath {} -Destination {} -Force",
            quote_powershell_string(old_path),
            quote_powershell_string(new_path)
        ));
    }
    format!("mv -- {} {}", shell_quote(old_path), shell_quote(new_path))
}

pub(super) fn parse_unix_directory_listing(
    output: Value,
    remote_path: String,
) -> Result<Value, String> {
    let stdout = command_stdout(output, "列出远程目录失败。")?;
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.split('\t');
        let name = parts.next().unwrap_or("");
        let kind = parts.next().unwrap_or("f");
        let size = parts
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let modified = parts
            .next()
            .and_then(|value| value.split('.').next())
            .and_then(|value| value.parse::<i64>().ok())
            .and_then(|value| chrono::DateTime::<Utc>::from_timestamp(value, 0))
            .unwrap_or_else(Utc::now)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        entries.push(json!({
            "name": name,
            "longname": "",
            "type": match kind {
                "d" => "directory",
                "l" => "symlink",
                _ => "file",
            },
            "size": size,
            "modifiedAt": modified
        }));
    }
    Ok(json!({ "path": remote_path, "entries": entries }))
}

pub(super) fn parse_unix_path_stat(output: Value) -> Result<Value, String> {
    let stdout = command_stdout(output, "读取远程路径属性失败。")?;
    let mut parts = stdout.trim().split('\t');
    let file_type = parts.next().unwrap_or("");
    let size = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let mode = parts
        .next()
        .and_then(|value| u32::from_str_radix(value, 8).ok())
        .unwrap_or(0);
    let owner = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let group = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let modified = parts.next().and_then(|value| value.parse::<u64>().ok());
    let accessed = parts.next().and_then(|value| value.parse::<u64>().ok());
    Ok(json!({
        "type": if file_type.contains("directory") {
            "directory"
        } else if file_type.contains("symbolic") {
            "symlink"
        } else {
            "file"
        },
        "size": size,
        "mode": mode,
        "owner": owner,
        "group": group,
        "modifiedAt": unix_time_to_iso(modified),
        "accessedAt": unix_time_to_iso(accessed)
    }))
}

pub(super) fn command_stdout(output: Value, fallback_error: &str) -> Result<String, String> {
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) == 0 {
        Ok(output
            .get("stdout")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string())
    } else {
        Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(fallback_error)
            .to_string())
    }
}

pub(super) fn command_json(output: Value, fallback_error: &str) -> Result<Value, String> {
    let stdout = command_stdout(output, fallback_error)?;
    serde_json::from_str(stdout.trim()).map_err(|error| {
        format!(
            "{}：{}",
            fallback_error.trim_end_matches('。'),
            error_string(error)
        )
    })
}

pub(super) fn command_bool(output: Value, fallback_error: &str) -> Result<Value, String> {
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) == 0 {
        Ok(json!(true))
    } else {
        Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(fallback_error)
            .to_string())
    }
}

fn unix_time_to_iso(value: Option<u64>) -> String {
    chrono::DateTime::<Utc>::from_timestamp(value.unwrap_or(0) as i64, 0)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(super) fn normalize_archive_format(format: &str) -> String {
    match format {
        "zip" | "tar" | "tar.gz" | "tgz" | "7z" => format.to_string(),
        _ => "zip".to_string(),
    }
}

pub(super) fn archive_compress_command(
    connection: &ActiveConnection,
    source_paths: &[String],
    format: &str,
    dest_path: &str,
) -> Result<String, String> {
    if remote_host_is_windows(connection) {
        if format != "zip" {
            return Err("Windows 主机暂仅支持 ZIP 压缩。".to_string());
        }
        return Ok(create_powershell_command(&format!(
            "Compress-Archive -LiteralPath @({}) -DestinationPath {} -Force",
            source_paths
                .iter()
                .map(|value| quote_powershell_string(value))
                .collect::<Vec<_>>()
                .join(", "),
            quote_powershell_string(dest_path)
        )));
    }

    let escaped_sources = source_paths
        .iter()
        .map(|value| shell_quote(value))
        .collect::<Vec<_>>()
        .join(" ");
    let escaped_dest = shell_quote(dest_path);
    let command = match format {
        "zip" => format!("zip -r -- {escaped_dest} {escaped_sources}"),
        "tar" => format!("tar cf {escaped_dest} -- {escaped_sources}"),
        "tar.gz" | "tgz" => format!("tar czf {escaped_dest} -- {escaped_sources}"),
        "7z" => format!("7z a {escaped_dest} {escaped_sources}"),
        _ => format!("zip -r -- {escaped_dest} {escaped_sources}"),
    };
    Ok(command)
}

pub(super) fn archive_decompress_command(
    connection: &ActiveConnection,
    archive_path: &str,
    dest_dir: &str,
) -> Result<String, String> {
    let archive_name = remote_basename(archive_path).to_lowercase();
    if remote_host_is_windows(connection) {
        if !archive_name.ends_with(".zip") {
            return Err("Windows 主机暂仅支持 ZIP 解压缩。".to_string());
        }
        return Ok(create_powershell_command(&format!(
            "Expand-Archive -LiteralPath {} -DestinationPath {} -Force",
            quote_powershell_string(archive_path),
            quote_powershell_string(dest_dir)
        )));
    }

    let escaped_archive = shell_quote(archive_path);
    let escaped_dest = shell_quote(dest_dir);
    if archive_name.ends_with(".tar.gz") || archive_name.ends_with(".tgz") {
        Ok(format!(
            "mkdir -p -- {escaped_dest} && tar xzf {escaped_archive} -C {escaped_dest}"
        ))
    } else if archive_name.ends_with(".tar.bz2") || archive_name.ends_with(".tbz2") {
        Ok(format!(
            "mkdir -p -- {escaped_dest} && tar xjf {escaped_archive} -C {escaped_dest}"
        ))
    } else if archive_name.ends_with(".tar.xz") || archive_name.ends_with(".txz") {
        Ok(format!(
            "mkdir -p -- {escaped_dest} && tar xJf {escaped_archive} -C {escaped_dest}"
        ))
    } else if archive_name.ends_with(".tar") {
        Ok(format!(
            "mkdir -p -- {escaped_dest} && tar xf {escaped_archive} -C {escaped_dest}"
        ))
    } else if archive_name.ends_with(".zip") {
        Ok(format!(
            "mkdir -p -- {escaped_dest} && unzip -o -- {escaped_archive} -d {escaped_dest}"
        ))
    } else if archive_name.ends_with(".7z") {
        Ok(format!(
            "mkdir -p -- {escaped_dest} && 7z x -o{escaped_dest} {escaped_archive} -y"
        ))
    } else if archive_name.ends_with(".gz") && !archive_name.ends_with(".tar.gz") {
        let base_name = remote_basename(archive_path)
            .trim_end_matches(".gz")
            .to_string();
        Ok(format!(
            "mkdir -p -- {escaped_dest} && gunzip -c {escaped_archive} > {}/{}",
            escaped_dest,
            shell_quote(&base_name)
        ))
    } else if archive_name.ends_with(".rar") {
        Ok(format!(
            "mkdir -p -- {escaped_dest} && unrar x -o+ {escaped_archive} {escaped_dest}"
        ))
    } else {
        Err(format!(
            "不支持的压缩格式：{}",
            remote_basename(archive_path)
        ))
    }
}

pub(super) fn remote_host_is_windows(connection: &ActiveConnection) -> bool {
    connection
        .host
        .get("systemType")
        .and_then(Value::as_str)
        .is_some_and(|system_type| system_type.eq_ignore_ascii_case("windows"))
}

pub(super) fn quote_powershell_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(super) fn create_powershell_command(script: &str) -> String {
    let prelude = [
        "try {",
        "$__shelldeskUtf8 = New-Object System.Text.UTF8Encoding $false",
        "[Console]::InputEncoding = $__shelldeskUtf8",
        "[Console]::OutputEncoding = $__shelldeskUtf8",
        "$OutputEncoding = $__shelldeskUtf8",
        "} catch {}",
        "try { chcp.com 65001 > $null } catch {}",
    ]
    .join("\n");
    let encoded = base64::engine::general_purpose::STANDARD
        .encode(utf16le_bytes(&format!("{prelude}\n{script}")));
    format!("powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}")
}

pub(super) fn utf16le_bytes(value: &str) -> Vec<u8> {
    value
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect()
}
