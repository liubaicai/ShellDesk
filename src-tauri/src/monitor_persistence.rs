use crate::command_runner::run_shell;
use crate::{
    get_connection, run_ssh_command_for_profile_interactive, shell_quote, string_arg,
    ActiveConnection, AppState, ConnectionKind,
};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::time::Duration;

const COLLECTOR_SCRIPT: &str = include_str!("monitor_persistence/collector.py");
const CRON_MARKER: &str = "# SHELLDESK_MONITOR";
const WINDOWS_TASK_NAME: &str = "ShellDesk Monitor Collector";
const JSON_BASE64_PREFIX: &str = "__SHELLDESK_MONITOR_JSON_BASE64__";
const INTERVAL_MINUTES: u64 = 5;
const DEFAULT_HISTORY_LIMIT: u64 = 2016;
const MAX_HISTORY_LIMIT: u64 = 5000;

const UNIX_WRAPPER: &str = r#"#!/bin/sh
set -eu
script="$HOME/.shelldesk/monitor/collector.py"
if command -v python3 >/dev/null 2>&1; then
  exec python3 "$script" "$@"
fi
if command -v python >/dev/null 2>&1; then
  exec python "$script" "$@"
fi
echo "Persistent monitoring requires Python 3 with the sqlite3 standard library." >&2
exit 127
"#;

const WINDOWS_WRAPPER: &str = r#"$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $env:USERPROFILE '.shelldesk\monitor\collector.py'
$candidates = @(
  @{ Name = 'python.exe'; Prefix = @() },
  @{ Name = 'python3.exe'; Prefix = @() },
  @{ Name = 'py.exe'; Prefix = @('-3') }
)
foreach ($candidate in $candidates) {
  $command = Get-Command $candidate.Name -ErrorAction SilentlyContinue
  if ($null -eq $command) { continue }
  & $command.Source @($candidate.Prefix) -c 'import sqlite3' 2>$null
  if ($LASTEXITCODE -ne 0) { continue }
  & $command.Source @($candidate.Prefix) $scriptPath @args
  exit $LASTEXITCODE
}
Write-Error 'Persistent monitoring requires Python 3 with the sqlite3 standard library.'
exit 127
"#;

pub(crate) async fn get_status(state: AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let connection = get_connection(&state, &connection_id)?;
    let is_windows = connection_is_windows(&connection);
    let output = run_monitor_command(
        state,
        connection,
        create_status_command(is_windows),
        String::new(),
        Duration::from_secs(30),
    )
    .await?;
    let stdout = checked_stdout(&output, "读取持久化监控状态失败。")?;
    let enabled = parse_scheduler_enabled(stdout);
    let mut status = parse_json_output(stdout).unwrap_or_else(|| fallback_status(false));
    if let Some(object) = status.as_object_mut() {
        object.insert("enabled".to_string(), json!(enabled));
        object.insert("intervalMinutes".to_string(), json!(INTERVAL_MINUTES));
    }
    Ok(status)
}

pub(crate) async fn set_enabled(state: AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let enabled = args
        .get(1)
        .and_then(Value::as_bool)
        .ok_or_else(|| "持久化监控开关参数无效。".to_string())?;
    let connection = get_connection(&state, &connection_id)?;
    let is_windows = connection_is_windows(&connection);
    let (command, stdin) = if enabled {
        create_enable_command(is_windows)
    } else {
        (create_disable_command(is_windows), String::new())
    };
    let output = run_monitor_command(
        state.clone(),
        connection.clone(),
        command,
        stdin,
        Duration::from_secs(60),
    )
    .await?;
    checked_stdout(
        &output,
        if enabled {
            "开启持久化监控失败。"
        } else {
            "关闭持久化监控失败。"
        },
    )?;

    let status_output = run_monitor_command(
        state,
        connection,
        create_status_command(is_windows),
        String::new(),
        Duration::from_secs(30),
    )
    .await?;
    let stdout = checked_stdout(&status_output, "刷新持久化监控状态失败。")?;
    let scheduler_enabled = parse_scheduler_enabled(stdout);
    let mut status = parse_json_output(stdout).unwrap_or_else(|| fallback_status(true));
    if let Some(object) = status.as_object_mut() {
        object.insert("enabled".to_string(), json!(scheduler_enabled));
        object.insert("intervalMinutes".to_string(), json!(INTERVAL_MINUTES));
    }
    Ok(status)
}

pub(crate) async fn get_history(state: AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let since_ms = args.get(1).and_then(Value::as_u64).unwrap_or(0);
    let limit = args
        .get(2)
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .clamp(1, MAX_HISTORY_LIMIT);
    let connection = get_connection(&state, &connection_id)?;
    let is_windows = connection_is_windows(&connection);
    let output = run_monitor_command(
        state,
        connection,
        create_history_command(is_windows, since_ms, limit),
        String::new(),
        Duration::from_secs(30),
    )
    .await?;
    let stdout = checked_stdout(&output, "读取持久化监控历史失败。")?;
    parse_base64_json_output(stdout)
        .or_else(|| parse_json_output(stdout))
        .ok_or_else(|| "持久化监控历史返回格式无效。".to_string())
}

pub(crate) async fn set_thresholds(state: AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let thresholds = args
        .get(1)
        .and_then(Value::as_object)
        .ok_or_else(|| "告警阈值参数无效。".to_string())?;
    let normalized = normalize_thresholds(thresholds)?;
    let encoded = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(&normalized).map_err(crate::error_string)?);
    let connection = get_connection(&state, &connection_id)?;
    let is_windows = connection_is_windows(&connection);
    let output = run_monitor_command(
        state,
        connection,
        create_configure_command(is_windows, &encoded),
        String::new(),
        Duration::from_secs(30),
    )
    .await?;
    let stdout = checked_stdout(&output, "保存告警阈值失败。")?;
    parse_json_output(stdout).ok_or_else(|| "告警阈值返回格式无效。".to_string())
}

fn normalize_thresholds(thresholds: &Map<String, Value>) -> Result<Value, String> {
    let mut normalized = Map::new();
    for metric in ["cpu", "memory", "disk"] {
        let value = thresholds
            .get(metric)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && (1.0..=100.0).contains(value))
            .ok_or_else(|| format!("{metric} 告警阈值必须在 1 到 100 之间。"))?;
        normalized.insert(metric.to_string(), json!(value));
    }
    Ok(Value::Object(normalized))
}

async fn run_monitor_command(
    state: AppState,
    connection: ActiveConnection,
    command: String,
    stdin: String,
    timeout: Duration,
) -> Result<Value, String> {
    if connection.kind == ConnectionKind::Local {
        return run_shell(command, &stdin, Some(timeout)).await;
    }
    run_ssh_command_for_profile_interactive(
        state,
        connection
            .ssh
            .ok_or_else(|| "SSH profile is unavailable.".to_string())?,
        command,
        stdin,
    )
    .await
}

fn connection_is_windows(connection: &ActiveConnection) -> bool {
    if connection.kind == ConnectionKind::Local {
        return cfg!(windows);
    }
    connection
        .host
        .get("systemType")
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("windows"))
}

fn checked_stdout<'a>(output: &'a Value, fallback: &str) -> Result<&'a str, String> {
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) != 0 {
        return Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| output.get("stdout").and_then(Value::as_str))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(fallback)
            .trim()
            .to_string());
    }
    Ok(output.get("stdout").and_then(Value::as_str).unwrap_or(""))
}

fn parse_scheduler_enabled(output: &str) -> bool {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix("scheduler="))
        .is_some_and(|value| value.trim() == "1")
}

fn parse_json_output(output: &str) -> Option<Value> {
    output
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

fn parse_base64_json_output(output: &str) -> Option<Value> {
    let encoded = output.split_once(JSON_BASE64_PREFIX)?.1;
    let compact = encoded
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(compact)
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn fallback_status(configured: bool) -> Value {
    json!({
        "configured": configured,
        "enabled": false,
        "databasePath": Value::Null,
        "sampleCount": 0,
        "lastSampleAt": Value::Null,
        "intervalMinutes": INTERVAL_MINUTES,
        "retentionDays": 30,
        "thresholds": { "cpu": 90, "memory": 90, "disk": 85 }
    })
}

fn create_status_command(is_windows: bool) -> String {
    if is_windows {
        return create_powershell_command(&format!(
            r#"$taskName = {task_name}
$wrapper = Join-Path $env:USERPROFILE '.shelldesk\monitor\collect.ps1'
schtasks.exe /Query /TN $taskName *> $null
$enabled = if ($LASTEXITCODE -eq 0) {{ '1' }} else {{ '0' }}
[Console]::Out.WriteLine('scheduler=' + $enabled)
if (Test-Path -LiteralPath $wrapper) {{
  & $wrapper status
  exit $LASTEXITCODE
}}
[Console]::Out.WriteLine('{{"configured":false,"databasePath":null,"sampleCount":0,"lastSampleAt":null,"intervalMinutes":5,"retentionDays":30,"thresholds":{{"cpu":90,"memory":90,"disk":85}}}}')"#,
            task_name = quote_powershell_string(WINDOWS_TASK_NAME),
        ));
    }
    format!(
        r#"sh <<'SHELLDESK_MONITOR_STATUS'
wrapper="$HOME/.shelldesk/monitor/collect.sh"
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -F '{marker}' >/dev/null 2>&1; then enabled=1; else enabled=0; fi
printf 'scheduler=%s\n' "$enabled"
if [ -x "$wrapper" ]; then
  "$wrapper" status
else
  printf '%s\n' '{{"configured":false,"databasePath":null,"sampleCount":0,"lastSampleAt":null,"intervalMinutes":5,"retentionDays":30,"thresholds":{{"cpu":90,"memory":90,"disk":85}}}}'
fi
SHELLDESK_MONITOR_STATUS"#,
        marker = CRON_MARKER,
    )
}

fn create_enable_command(is_windows: bool) -> (String, String) {
    let collector_b64 = base64::engine::general_purpose::STANDARD.encode(COLLECTOR_SCRIPT);
    if is_windows {
        let wrapper_b64 = base64::engine::general_purpose::STANDARD.encode(WINDOWS_WRAPPER);
        return (
            create_powershell_command(&format!(
                r#"$ErrorActionPreference = 'Stop'
$monitorDir = Join-Path $env:USERPROFILE '.shelldesk\monitor'
$collector = Join-Path $monitorDir 'collector.py'
$wrapper = Join-Path $monitorDir 'collect.ps1'
New-Item -ItemType Directory -Path $monitorDir -Force | Out-Null
$collectorEncoded = [Console]::In.ReadToEnd().Trim()
[IO.File]::WriteAllBytes($collector, [Convert]::FromBase64String($collectorEncoded))
[IO.File]::WriteAllBytes($wrapper, [Convert]::FromBase64String('{wrapper_b64}'))
& $wrapper collect
if ($LASTEXITCODE -ne 0) {{ throw 'Initial persistent monitoring sample failed.' }}
$taskRun = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $wrapper + '" collect'
schtasks.exe /Create /SC MINUTE /MO {interval} /TN {task_name} /TR $taskRun /F | Out-Null
if ($LASTEXITCODE -ne 0) {{ throw 'Unable to create the ShellDesk monitoring scheduled task.' }}"#,
                interval = INTERVAL_MINUTES,
                task_name = quote_powershell_string(WINDOWS_TASK_NAME),
            )),
            collector_b64,
        );
    }

    let wrapper_b64 = base64::engine::general_purpose::STANDARD.encode(UNIX_WRAPPER);
    let cron_line = format!(
        "*/{INTERVAL_MINUTES} * * * * \"$HOME/.shelldesk/monitor/collect.sh\" collect >/dev/null 2>&1 {CRON_MARKER}"
    );
    (
        format!(
            r#"set -eu
if ! command -v crontab >/dev/null 2>&1; then
  echo 'Persistent monitoring requires a user crontab implementation.' >&2
  exit 127
fi
if command -v python3 >/dev/null 2>&1; then python_cmd="$(command -v python3)"; elif command -v python >/dev/null 2>&1; then python_cmd="$(command -v python)"; else
  echo 'Persistent monitoring requires Python 3 with the sqlite3 standard library.' >&2
  exit 127
fi
"$python_cmd" -c 'import sqlite3' >/dev/null 2>&1 || {{ echo 'Python sqlite3 support is unavailable.' >&2; exit 127; }}
monitor_dir="$HOME/.shelldesk/monitor"
mkdir -p "$monitor_dir"
chmod 700 "$monitor_dir"
export SHELLDESK_MONITOR_DIR="$monitor_dir"
export SHELLDESK_MONITOR_WRAPPER_B64='{wrapper_b64}'
"$python_cmd" -c 'import base64,os,pathlib,sys; p=pathlib.Path(os.environ["SHELLDESK_MONITOR_DIR"]); (p/"collector.py").write_bytes(base64.b64decode(sys.stdin.buffer.read())); (p/"collect.sh").write_bytes(base64.b64decode(os.environ["SHELLDESK_MONITOR_WRAPPER_B64"]))'
chmod 700 "$monitor_dir/collector.py" "$monitor_dir/collect.sh"
"$monitor_dir/collect.sh" collect >/dev/null
current="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "$current" | sed '\|{marker}$|d')"
{{
  if [ -n "$filtered" ]; then printf '%s\n' "$filtered"; fi
  printf '%s\n' '{cron_line}'
}} | crontab -"#,
            marker = CRON_MARKER,
            cron_line = cron_line,
        ),
        collector_b64,
    )
}

fn create_disable_command(is_windows: bool) -> String {
    if is_windows {
        return create_powershell_command(&format!(
            r#"schtasks.exe /Query /TN {task_name} *> $null
if ($LASTEXITCODE -eq 0) {{
  schtasks.exe /Delete /TN {task_name} /F | Out-Null
  if ($LASTEXITCODE -ne 0) {{ throw 'Unable to remove the ShellDesk monitoring scheduled task.' }}
}}"#,
            task_name = quote_powershell_string(WINDOWS_TASK_NAME),
        ));
    }
    format!(
        r#"sh <<'SHELLDESK_MONITOR_DISABLE'
set -eu
if ! command -v crontab >/dev/null 2>&1; then exit 0; fi
current="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "$current" | sed '\|{marker}$|d')"
if [ "$filtered" = "$current" ]; then exit 0; fi
if [ -n "$filtered" ]; then printf '%s\n' "$filtered" | crontab -; else crontab -r 2>/dev/null || true; fi
SHELLDESK_MONITOR_DISABLE"#,
        marker = CRON_MARKER,
    )
}

fn create_history_command(is_windows: bool, since_ms: u64, limit: u64) -> String {
    if is_windows {
        return create_powershell_command(&format!(
            r#"$wrapper = Join-Path $env:USERPROFILE '.shelldesk\monitor\collect.ps1'
if (Test-Path -LiteralPath $wrapper) {{
  $lines = @(& $wrapper history {since_ms} {limit})
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {{ exit $exitCode }}
  $json = [string]::Join("`n", $lines)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  [Console]::Out.WriteLine('{prefix}' + $encoded)
  exit 0
}}
[Console]::Out.WriteLine('{prefix}' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{{"samples":[],"alerts":[],"thresholds":{{"cpu":90,"memory":90,"disk":85}}}}')))"#,
            prefix = JSON_BASE64_PREFIX,
        ));
    }
    let empty_payload = format!(
        "{JSON_BASE64_PREFIX}{}",
        base64::engine::general_purpose::STANDARD
            .encode(r#"{"samples":[],"alerts":[],"thresholds":{"cpu":90,"memory":90,"disk":85}}"#)
    );
    format!(
        r#"sh <<'SHELLDESK_MONITOR_HISTORY'
wrapper="$HOME/.shelldesk/monitor/collect.sh"
if [ -x "$wrapper" ]; then
  if command -v python3 >/dev/null 2>&1; then python_cmd="$(command -v python3)"; else python_cmd="$(command -v python)"; fi
  "$python_cmd" -c 'import base64,subprocess,sys; result=subprocess.run([sys.argv[1], "history", sys.argv[2], sys.argv[3]], stdout=subprocess.PIPE, stderr=subprocess.PIPE); sys.stderr.buffer.write(result.stderr); print(sys.argv[4] + base64.b64encode(result.stdout).decode("ascii")); raise SystemExit(result.returncode)' "$wrapper" {since_ms} {limit} '{prefix}'
else
  printf '%s\n' '{empty_payload}'
fi
SHELLDESK_MONITOR_HISTORY"#,
        prefix = JSON_BASE64_PREFIX,
        empty_payload = empty_payload,
    )
}

fn create_configure_command(is_windows: bool, encoded: &str) -> String {
    if is_windows {
        return create_powershell_command(&format!(
            r#"$wrapper = Join-Path $env:USERPROFILE '.shelldesk\monitor\collect.ps1'
if (-not (Test-Path -LiteralPath $wrapper)) {{ throw 'Persistent monitoring is not configured.' }}
& $wrapper configure '{encoded}'
exit $LASTEXITCODE"#,
        ));
    }
    format!(
        "wrapper=\"$HOME/.shelldesk/monitor/collect.sh\"; [ -x \"$wrapper\" ] || {{ echo 'Persistent monitoring is not configured.' >&2; exit 1; }}; \"$wrapper\" configure {}",
        shell_quote(encoded)
    )
}

fn quote_powershell_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn create_powershell_command(script: &str) -> String {
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
    format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        powershell_encoded(&format!("{prelude}\n{script}"))
    )
}

fn powershell_encoded(script: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_enable_command_installs_five_minute_cron_without_deleting_history() {
        let (enable, stdin) = create_enable_command(false);
        let disable = create_disable_command(false);

        assert!(enable.contains("*/5 * * * *"));
        assert!(enable.contains(CRON_MARKER));
        assert!(!enable.contains("SHELLDESK_MONITOR_INSTALL"));
        assert!(enable.contains("sys.stdin.buffer.read()"));
        assert!(enable.len() < 10_000);
        assert!(stdin.len() > enable.len());
        assert!(enable.contains("monitor.sqlite3") || COLLECTOR_SCRIPT.contains("monitor.sqlite3"));
        assert!(!disable.contains("rm -"));
    }

    #[test]
    fn windows_enable_command_uses_current_user_scheduled_task() {
        let (command, stdin) = create_enable_command(true);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(command.split_whitespace().last().expect("encoded command"))
            .expect("base64");
        let utf16 = decoded
            .chunks_exact(2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
            .collect::<Vec<_>>();
        let script = String::from_utf16(&utf16).expect("powershell script");

        assert!(script.contains("schtasks.exe /Create"));
        assert!(script.contains("/SC MINUTE /MO 5"));
        assert!(script.contains("[Console]::In.ReadToEnd()"));
        assert!(command.len() < 20_000);
        assert!(!stdin.is_empty());
        assert!(!script.contains("/RU SYSTEM"));
    }

    #[test]
    fn threshold_validation_rejects_out_of_range_values() {
        let thresholds = json!({ "cpu": 90, "memory": 0, "disk": 85 });
        assert!(normalize_thresholds(thresholds.as_object().unwrap()).is_err());
    }

    #[test]
    fn parses_scheduler_and_last_json_line() {
        let output = "scheduler=1\n{\"configured\":true}\n";
        assert!(parse_scheduler_enabled(output));
        assert_eq!(parse_json_output(output).unwrap()["configured"], true);
    }

    #[test]
    fn parses_line_wrapped_base64_history_output() {
        let json = r#"{"samples":[{"timestamp":1}],"alerts":[],"thresholds":{"cpu":90,"memory":90,"disk":85}}"#;
        let encoded = base64::engine::general_purpose::STANDARD.encode(json);
        let midpoint = encoded.len() / 2;
        let output = format!(
            "{JSON_BASE64_PREFIX}{}\r\n{}\r\n",
            &encoded[..midpoint],
            &encoded[midpoint..]
        );

        let parsed = parse_base64_json_output(&output).expect("encoded JSON");
        assert_eq!(parsed["samples"][0]["timestamp"], 1);
    }
}
