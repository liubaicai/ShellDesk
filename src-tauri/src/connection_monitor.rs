use crate::command_runner::run_shell;
use crate::{
    get_connection, now, run_ssh_command_for_profile_interactive, shell_quote, string_arg,
    ActiveConnection, AppState, ConnectionKind,
};
use base64::Engine;
use serde_json::{json, Value};
use std::time::Duration;

const BATCH_BEGIN_PREFIX: &str = "__SHELLDESK_BATCH_BEGIN__";
const BATCH_END_PREFIX: &str = "__SHELLDESK_BATCH_END__";
const CONNECTION_STATUS_MARKER: &str = "__SHELLDESK_CONNECTION_READY__";

struct MonitorItem {
    key: &'static str,
    label: &'static str,
    icon: Option<&'static str>,
    command: &'static str,
}

fn connection_status_command() -> String {
    format!("echo {CONNECTION_STATUS_MARKER}")
}

pub(crate) async fn get_connection_status(
    state: AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let connection = get_connection(&state, &connection_id)?;
    let output = run_monitor_command(
        state,
        connection,
        connection_status_command(),
        Duration::from_secs(8),
    )
    .await?;
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) != 0 {
        return Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("目标主机未响应连接探测。")
            .to_string());
    }
    if !output
        .get("stdout")
        .and_then(Value::as_str)
        .is_some_and(|stdout| stdout.contains(CONNECTION_STATUS_MARKER))
    {
        return Err("目标主机未返回连接探测标记。".to_string());
    }
    Ok(json!({ "refreshedAt": now(), "items": [] }))
}

pub(crate) async fn get_connection_system_info(
    state: AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let connection = get_connection(&state, &connection_id)?;
    let is_windows = connection_is_windows(&connection);
    let items = system_info_items(is_windows);
    run_command_report(state, connection, &items, is_windows).await
}

pub(crate) async fn get_connection_metrics(
    state: AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let connection = get_connection(&state, &connection_id)?;
    let is_windows = connection_is_windows(&connection);
    let command = if is_windows {
        create_windows_metrics_command()
    } else {
        create_unix_metrics_command()
    };
    let output = if connection.kind == ConnectionKind::Local {
        run_shell(command, "", Some(Duration::from_secs(15))).await?
    } else {
        run_ssh_command_for_profile_interactive(
            state.clone(),
            connection
                .ssh
                .ok_or_else(|| "SSH profile is unavailable.".to_string())?,
            command,
            String::new(),
        )
        .await?
    };
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) != 0 {
        return Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .unwrap_or("读取系统指标失败。")
            .to_string());
    }
    let stdout = output.get("stdout").and_then(Value::as_str).unwrap_or("");
    let (rx, tx) = parse_metric_pair(stdout, "net");
    Ok(json!({
        "refreshedAt": now(),
        "cpuPercent": clamp_metric_percent(parse_metric_number(stdout, "cpu")),
        "memoryPercent": clamp_metric_percent(parse_metric_number(stdout, "mem")),
        "netRxBytes": clamp_metric_bytes(rx),
        "netTxBytes": clamp_metric_bytes(tx)
    }))
}

async fn run_command_report(
    state: AppState,
    connection: ActiveConnection,
    items: &[MonitorItem],
    is_windows: bool,
) -> Result<Value, String> {
    let command = if is_windows {
        create_windows_batch_command(items)
    } else {
        create_unix_batch_command(items)
    };
    let output = run_monitor_command(state, connection, command, Duration::from_secs(25)).await?;
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) != 0 {
        return Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("读取连接信息失败。")
            .to_string());
    }
    let values = parse_batch_output(output.get("stdout").and_then(Value::as_str).unwrap_or(""));
    Ok(json!({
        "refreshedAt": now(),
        "items": items.iter().map(|item| {
            let mut value = json!({
                "key": item.key,
                "label": item.label,
                "value": values.iter()
                    .find(|(key, _)| key == item.key)
                    .map(|(_, value)| value.as_str())
                    .unwrap_or("获取失败")
            });
            if let Some(icon) = item.icon {
                value["icon"] = json!(icon);
            }
            value
        }).collect::<Vec<_>>()
    }))
}

async fn run_monitor_command(
    state: AppState,
    connection: ActiveConnection,
    command: String,
    timeout: Duration,
) -> Result<Value, String> {
    if connection.kind == ConnectionKind::Local {
        return run_shell(command, "", Some(timeout)).await;
    }
    run_ssh_command_for_profile_interactive(
        state.clone(),
        connection
            .ssh
            .clone()
            .ok_or_else(|| "SSH profile is unavailable.".to_string())?,
        command,
        String::new(),
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

fn system_info_items(is_windows: bool) -> Vec<MonitorItem> {
    if is_windows {
        vec![
            MonitorItem { key: "os", label: "操作系统", icon: Some("🖥️"), command: "$os = Get-CimInstance Win32_OperatingSystem; '{0} {1}' -f $os.Caption, $os.Version" },
            MonitorItem { key: "kernel", label: "系统版本", icon: Some("⚙️"), command: "[Environment]::OSVersion.VersionString" },
            MonitorItem { key: "hostname", label: "主机名", icon: Some("🏠"), command: "[System.Net.Dns]::GetHostName()" },
            MonitorItem { key: "arch", label: "系统架构", icon: Some("🧩"), command: "(Get-CimInstance Win32_OperatingSystem).OSArchitecture" },
            MonitorItem { key: "cpuCores", label: "CPU 核心", icon: Some("🧮"), command: "$cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum; if ($null -eq $cores) { '未检测到' } else { [string][int]$cores }" },
            MonitorItem { key: "memoryTotal", label: "内存总量", icon: Some("🧠"), command: "$os = Get-CimInstance Win32_OperatingSystem; if ($os.TotalVisibleMemorySize) { '{0} GB' -f [math]::Round($os.TotalVisibleMemorySize / 1MB, 1) } else { '未检测到' }" },
            MonitorItem { key: "diskTotal", label: "硬盘总量", icon: Some("💽"), command: "$total = (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Measure-Object -Property Size -Sum).Sum; if ($null -eq $total) { '未检测到' } else { '{0} GB' -f [math]::Round($total / 1GB, 1) }" },
            MonitorItem { key: "cpu", label: "CPU", icon: Some("💻"), command: "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; '{0}; Cores: {1}; Logical: {2}' -f $cpu.Name, $cpu.NumberOfCores, $cpu.NumberOfLogicalProcessors" },
            MonitorItem { key: "memory", label: "内存", icon: Some("🧠"), command: "$os = Get-CimInstance Win32_OperatingSystem; $total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2); $free = [math]::Round($os.FreePhysicalMemory / 1MB, 2); $used = [math]::Round($total - $free, 2); '已用 {0} GB / 总计 {1} GB，空闲 {2} GB' -f $used, $total, $free" },
            MonitorItem { key: "disk", label: "磁盘", icon: Some("💽"), command: "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, VolumeName, FileSystem, @{Name='SizeGB'; Expression={[math]::Round($_.Size / 1GB, 2)}}, @{Name='FreeGB'; Expression={[math]::Round($_.FreeSpace / 1GB, 2)}} | Format-Table -AutoSize | Out-String -Width 220" },
            MonitorItem { key: "uptime", label: "运行时间", icon: Some("⏱️"), command: "$os = Get-CimInstance Win32_OperatingSystem; ((Get-Date) - $os.LastBootUpTime).ToString()" },
            MonitorItem { key: "load", label: "CPU 负载", icon: Some("⚡"), command: "$value = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; if ($null -eq $value) { '0%' } else { '{0}%' -f [math]::Round($value, 1) }" },
            MonitorItem { key: "shell", label: "PowerShell", icon: Some("💻"), command: "'PowerShell ' + $PSVersionTable.PSVersion.ToString()" },
            MonitorItem { key: "user", label: "当前用户", icon: Some("👤"), command: "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name" },
            MonitorItem { key: "locale", label: "系统语言", icon: Some("🌍"), command: "(Get-Culture).Name" },
            MonitorItem { key: "timezone", label: "时区", icon: Some("🌍"), command: "(Get-TimeZone).DisplayName" },
            MonitorItem { key: "gpu", label: "GPU", icon: Some("🎮"), command: "Get-CimInstance Win32_VideoController | Select-Object -First 3 -ExpandProperty Name | Out-String -Width 200" },
            MonitorItem { key: "virt", label: "硬件型号", icon: Some("📫"), command: "$cs = Get-CimInstance Win32_ComputerSystem; '{0} {1}' -f $cs.Manufacturer, $cs.Model" },
            MonitorItem { key: "boot", label: "启动模式", icon: Some("🔄"), command: "try { if (Confirm-SecureBootUEFI) { 'UEFI / Secure Boot' } else { 'UEFI' } } catch { 'Legacy BIOS 或未识别' }" },
        ]
    } else {
        vec![
            MonitorItem { key: "os", label: "操作系统", icon: Some("🖥️"), command: "cat /etc/os-release 2>/dev/null | grep -E \"^PRETTY_NAME|^NAME|^VERSION\" | head -5 || uname -s" },
            MonitorItem { key: "kernel", label: "内核版本", icon: Some("⚙️"), command: "uname -r" },
            MonitorItem { key: "hostname", label: "主机名", icon: Some("🏠"), command: "hostname -f 2>/dev/null || hostname" },
            MonitorItem { key: "arch", label: "系统架构", icon: Some("🧩"), command: "uname -m" },
            MonitorItem { key: "cpuCores", label: "CPU 核心", icon: Some("🧮"), command: "getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo \"未检测到\"" },
            MonitorItem { key: "memoryTotal", label: "内存总量", icon: Some("🧠"), command: "LC_ALL=C free -b 2>/dev/null | awk '/^Mem:/ { printf \"%.1f GB\\n\", $2 / 1024 / 1024 / 1024; found=1 } END { if (!found) print \"未检测到\" }'" },
            MonitorItem { key: "diskTotal", label: "硬盘总量", icon: Some("💽"), command: "df -Pk -x tmpfs -x devtmpfs 2>/dev/null | awk 'NR > 1 && !seen[$1]++ { total += $2 } END { if (total > 0) printf \"%.1f GB\\n\", total / 1024 / 1024; else print \"未检测到\" }'" },
            MonitorItem { key: "cpu", label: "CPU", icon: Some("💻"), command: "LC_ALL=C lscpu 2>/dev/null | grep -E '^(Model name|Socket\\(s\\)|Core\\(s\\) per socket|Thread\\(s\\) per core|CPU\\(s\\)):' | head -6 || grep -m1 'model name' /proc/cpuinfo 2>/dev/null || echo \"未检测到\"" },
            MonitorItem { key: "memory", label: "内存", icon: Some("🧠"), command: "LC_ALL=C free -h 2>/dev/null | grep \"^Mem:\" || vm_stat 2>/dev/null | head -5" },
            MonitorItem { key: "disk", label: "磁盘", icon: Some("💽"), command: "df -h -x tmpfs -x devtmpfs 2>/dev/null | head -12 || df -h 2>/dev/null | head -12 || echo \"未检测到\"" },
            MonitorItem { key: "uptime", label: "运行时间", icon: Some("⏱️"), command: "uptime -p 2>/dev/null || uptime" },
            MonitorItem { key: "load", label: "系统负载", icon: Some("⚡"), command: "cat /proc/loadavg 2>/dev/null || uptime | sed \"s/.*load average: //\"" },
            MonitorItem { key: "shell", label: "默认 Shell", icon: Some("🐚"), command: "echo $SHELL" },
            MonitorItem { key: "user", label: "当前用户", icon: Some("👤"), command: "whoami 2>/dev/null || id -un" },
            MonitorItem { key: "locale", label: "系统语言", icon: Some("🌍"), command: "locale 2>/dev/null | grep LANG= | head -1 || echo $LANG" },
            MonitorItem { key: "timezone", label: "时区", icon: Some("🌍"), command: "timedatectl 2>/dev/null | grep \"Time zone\" || cat /etc/timezone 2>/dev/null || date +\"%Z\"" },
            MonitorItem { key: "gpu", label: "GPU", icon: Some("🎮"), command: "lspci 2>/dev/null | grep -i \"vga\\|3d\\|display\" | head -3 || echo \"未检测到\"" },
            MonitorItem { key: "virt", label: "虚拟化", icon: Some("📫"), command: "systemd-detect-virt 2>/dev/null || cat /proc/cpuinfo 2>/dev/null | grep -c \"hypervisor\" | awk '{if($1>0) print \"虚拟化环境\"; else print \"物理机或未识别\"}' || echo \"未识别\"" },
            MonitorItem { key: "boot", label: "启动模式", icon: Some("🔄"), command: "[ -d /sys/firmware/efi ] && echo \"UEFI\" || echo \"BIOS (Legacy)\"" },
        ]
    }
}

fn create_unix_batch_command(items: &[MonitorItem]) -> String {
    let mut lines = vec![
        "run_item() {".to_string(),
        "  key=\"$1\"".to_string(),
        "  command=\"$2\"".to_string(),
        format!(
            "  printf '%s%s\\n' {} \"$key\"",
            shell_quote(BATCH_BEGIN_PREFIX)
        ),
        "  output=\"$(sh -c \"$command\" 2>&1)\"".to_string(),
        "  status=$?".to_string(),
        "  if [ \"$status\" -ne 0 ] && [ -z \"$output\" ]; then output=\"获取失败\"; fi"
            .to_string(),
        "  if [ -z \"$output\" ]; then output=\"无输出\"; fi".to_string(),
        "  printf '%s\\n' \"$output\"".to_string(),
        format!(
            "  printf '%s%s\\n' {} \"$key\"",
            shell_quote(BATCH_END_PREFIX)
        ),
        "}".to_string(),
        String::new(),
    ];
    lines.extend(items.iter().map(|item| {
        format!(
            "run_item {} {}",
            shell_quote(item.key),
            shell_quote(item.command)
        )
    }));
    format!(
        "sh <<'SHELLDESK_BATCH'\n{}\nSHELLDESK_BATCH",
        lines.join("\n")
    )
}

fn create_windows_batch_command(items: &[MonitorItem]) -> String {
    let invocations = items
        .iter()
        .map(|item| {
            format!(
                "Invoke-ShellDeskItem {} {{ {} }}",
                quote_powershell_string(item.key),
                item.command
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    create_powershell_command(&format!(
        r#"function Invoke-ShellDeskItem([string]$Key, [scriptblock]$Script) {{
  [Console]::Out.WriteLine('{begin}' + $Key)
  try {{
    $result = & $Script 2>&1 | Out-String -Width 260
    if ([string]::IsNullOrWhiteSpace($result)) {{
      [Console]::Out.WriteLine('无输出')
    }} else {{
      [Console]::Out.WriteLine($result.TrimEnd())
    }}
  }} catch {{
    [Console]::Out.WriteLine('获取失败：' + $_.Exception.Message)
  }}
  [Console]::Out.WriteLine('{end}' + $Key)
}}
{invocations}"#,
        begin = BATCH_BEGIN_PREFIX,
        end = BATCH_END_PREFIX,
        invocations = invocations
    ))
}

fn create_unix_metrics_command() -> String {
    r#"sh <<'SHELLDESK_METRICS'
if [ -r /proc/stat ]; then
  read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
  idle1=$((idle + iowait))
  total1=$((user + nice + system + idle + iowait + irq + softirq + steal))
  sleep 0.12
  read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
  idle2=$((idle + iowait))
  total2=$((user + nice + system + idle + iowait + irq + softirq + steal))
  total_delta=$((total2 - total1))
  idle_delta=$((idle2 - idle1))
  awk -v total="$total_delta" -v idle="$idle_delta" 'BEGIN { if (total > 0) printf "cpu=%.1f\n", (total - idle) / total * 100; else print "cpu=0" }'
else
  echo "cpu="
fi

if command -v free >/dev/null 2>&1; then
  LC_ALL=C free | awk '/^Mem:/ { if ($2 > 0) printf "mem=%.1f\n", $3 / $2 * 100; else print "mem=0" }'
elif [ -r /proc/meminfo ]; then
  awk '
    /^MemTotal:/ { total=$2 }
    /^MemAvailable:/ { available=$2 }
    END {
      if (total > 0 && available >= 0) printf "mem=%.1f\n", (total - available) / total * 100;
      else print "mem=0"
    }
  ' /proc/meminfo
else
  echo "mem="
fi

if [ -r /proc/net/dev ]; then
  awk 'NR > 2 { name=$1; sub(":", "", name); if (name != "lo") { rx += $2; tx += $10 } } END { printf "net=%d %d\n", rx, tx }' /proc/net/dev
else
  echo "net=nan nan"
fi
SHELLDESK_METRICS"#
        .to_string()
}

fn create_windows_metrics_command() -> String {
    let script = r#"
$culture = [Globalization.CultureInfo]::InvariantCulture
$cpu = $null
$mem = $null
$rx = $null
$tx = $null

try {
  $cpuValue = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average
  if ($null -ne $cpuValue) { $cpu = [double]$cpuValue }
} catch {}

try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($os -and $os.TotalVisibleMemorySize) {
    $mem = (($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100
  }
} catch {}

try {
  $stats = Get-NetAdapterStatistics -ErrorAction SilentlyContinue
  $rxValue = ($stats | Measure-Object -Property ReceivedBytes -Sum).Sum
  $txValue = ($stats | Measure-Object -Property SentBytes -Sum).Sum
  if ($null -ne $rxValue) { $rx = [int64]$rxValue }
  if ($null -ne $txValue) { $tx = [int64]$txValue }
} catch {}

if ($null -ne $cpu) {
  [Console]::Out.WriteLine([string]::Format($culture, 'cpu={0:0.0}', $cpu))
} else {
  [Console]::Out.WriteLine('cpu=')
}

if ($null -ne $mem) {
  [Console]::Out.WriteLine([string]::Format($culture, 'mem={0:0.0}', $mem))
} else {
  [Console]::Out.WriteLine('mem=')
}

if ($null -ne $rx -and $null -ne $tx) {
  [Console]::Out.WriteLine([string]::Format($culture, 'net={0} {1}', $rx, $tx))
} else {
  [Console]::Out.WriteLine('net=nan nan')
}
"#;
    create_powershell_command(script)
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

fn parse_batch_output(output: &str) -> Vec<(String, String)> {
    let mut values = Vec::new();
    let mut current_key: Option<String> = None;
    let mut current_value = Vec::new();
    for line in output.lines() {
        if let Some(key) = line.strip_prefix(BATCH_BEGIN_PREFIX) {
            current_key = Some(key.trim().to_string());
            current_value.clear();
            continue;
        }
        if let Some(key) = line.strip_prefix(BATCH_END_PREFIX) {
            if current_key.as_deref() == Some(key.trim()) {
                let value = current_value.join("\n").trim().to_string();
                values.push((
                    key.trim().to_string(),
                    if value.is_empty() {
                        "无输出".to_string()
                    } else {
                        value
                    },
                ));
            }
            current_key = None;
            current_value.clear();
            continue;
        }
        if current_key.is_some() {
            current_value.push(line.to_string());
        }
    }
    values
}

fn parse_metric_number(output: &str, key: &str) -> Option<f64> {
    let prefix = format!("{key}=");
    output
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
}

fn parse_metric_pair(output: &str, key: &str) -> (Option<u64>, Option<u64>) {
    let prefix = format!("{key}=");
    let Some(value) = output.lines().find_map(|line| line.strip_prefix(&prefix)) else {
        return (None, None);
    };
    let mut parts = value.split_whitespace();
    (
        parts.next().and_then(|item| item.parse::<u64>().ok()),
        parts.next().and_then(|item| item.parse::<u64>().ok()),
    )
}

fn clamp_metric_percent(value: Option<f64>) -> Value {
    value
        .map(|value| json!(value.clamp(0.0, 100.0)))
        .unwrap_or(Value::Null)
}

fn clamp_metric_bytes(value: Option<u64>) -> Value {
    value.map(|value| json!(value)).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_batch_output_blocks() {
        let output = "__SHELLDESK_BATCH_BEGIN__hostname\nserver-1\n__SHELLDESK_BATCH_END__hostname\n__SHELLDESK_BATCH_BEGIN__memory\nline 1\nline 2\n__SHELLDESK_BATCH_END__memory\n";
        let values = parse_batch_output(output);

        assert_eq!(values[0], ("hostname".to_string(), "server-1".to_string()));
        assert_eq!(
            values[1],
            ("memory".to_string(), "line 1\nline 2".to_string())
        );
    }

    #[test]
    fn connection_status_command_is_a_lightweight_shell_echo() {
        assert_eq!(
            connection_status_command(),
            "echo __SHELLDESK_CONNECTION_READY__"
        );
    }

    #[test]
    fn windows_batch_command_uses_encoded_powershell() {
        let items = system_info_items(true);
        let command = create_windows_batch_command(&items);

        assert!(command
            .starts_with("powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand "));
        assert!(!command.contains("Get-CimInstance Win32_LogicalDisk"));
    }

    #[test]
    fn unix_batch_command_preserves_item_keys() {
        let items = system_info_items(false);
        let command = create_unix_batch_command(&items);

        assert!(command.contains("run_item 'os'"));
        assert!(command.contains(BATCH_BEGIN_PREFIX));
        assert!(command.contains(BATCH_END_PREFIX));
    }

    #[test]
    fn system_info_items_include_frontend_summary_keys() {
        for is_windows in [false, true] {
            let keys = system_info_items(is_windows)
                .into_iter()
                .map(|item| item.key)
                .collect::<Vec<_>>();

            for required in ["os", "hostname", "cpu", "memory", "disk", "user"] {
                assert!(keys.contains(&required));
            }
        }
    }

    #[test]
    fn unix_system_info_memory_commands_force_c_locale() {
        let system_items = system_info_items(false);
        let memory_total = system_items
            .iter()
            .find(|item| item.key == "memoryTotal")
            .expect("memory total item");
        assert!(memory_total.command.contains("LC_ALL=C free -b"));

        let memory_detail = system_items
            .iter()
            .find(|item| item.key == "memory")
            .expect("memory detail item");
        assert!(memory_detail.command.contains("LC_ALL=C free -h"));

        let metrics_command = create_unix_metrics_command();
        assert!(metrics_command.contains("LC_ALL=C free | awk"));
    }
}
