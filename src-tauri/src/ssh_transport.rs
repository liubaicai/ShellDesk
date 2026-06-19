use crate::askpass::{current_ui_window, start_askpass_broker, AskpassBroker};
use crate::command_runner::{run_shell, run_shell_stream, run_spawned_command_stream};
use crate::proxy::{proxy_helper_env_name, SshProxyConfig};
use crate::{
    error_string, get_connection, now, prevent_process_window, prevent_tokio_process_window,
    read_string_field, string_arg, ActiveConnection, AppState, ConnectionKind, PrivilegeConfig,
    SshProfile,
};
use base64::Engine;
use portable_pty::CommandBuilder;
use serde_json::{json, Value};
use std::{
    process::{Child as StdChild, Command as StdCommand, Stdio},
    time::Duration,
};
use tauri::Emitter;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::Command,
    time,
};
pub(crate) async fn run_connection_command(
    state: &AppState,
    args: Vec<Value>,
) -> Result<Value, String> {
    run_connection_command_with_options(state, args, 3).await
}

pub(crate) async fn run_connection_command_with_options(
    state: &AppState,
    args: Vec<Value>,
    options_index: usize,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let command = string_arg(&args, 1)?;
    let stdin = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let options = args.get(options_index);
    let connection = get_connection(state, &connection_id)?;

    if connection.kind == ConnectionKind::Local {
        return run_shell(command, &stdin, Duration::from_secs(60)).await;
    }

    let profile = connection
        .ssh
        .clone()
        .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
    let privilege = configured_privilege(&connection, options);
    let (command, stdin) = apply_privilege_to_command(command, stdin, privilege.as_ref());
    let result = run_ssh_command_for_connection_with_retry(
        state,
        current_ui_window(state),
        &connection_id,
        profile,
        command,
        stdin,
    )
    .await?;
    assert_privilege_result(&result, privilege.as_ref())?;
    Ok(result)
}

fn configured_privilege(
    connection: &ActiveConnection,
    options: Option<&Value>,
) -> Option<PrivilegeConfig> {
    if connection
        .host
        .get("systemType")
        .and_then(Value::as_str)
        .is_some_and(|system_type| system_type.eq_ignore_ascii_case("windows"))
    {
        return None;
    }
    if let Some(options) = options.filter(|value| value.is_object()) {
        if options.get("sudoPassword").is_some() {
            return Some(PrivilegeConfig {
                mode: "sudo".to_string(),
                password: read_string_field(options, "sudoPassword", ""),
            });
        }
    }
    connection.privilege.clone()
}

fn apply_privilege_to_command(
    command: String,
    stdin: String,
    privilege: Option<&PrivilegeConfig>,
) -> (String, String) {
    let Some(privilege) = privilege else {
        return (command, stdin);
    };
    let quoted = shell_quote(&command);
    let wrapped = match privilege.mode.as_str() {
        "sudo" => [
            "if [ \"$(id -u 2>/dev/null)\" = \"0\" ]; then",
            "IFS= read -r _shelldesk_sudo_password || true;",
            &format!("sh -c {quoted};"),
            "else",
            "IFS= read -r _shelldesk_sudo_password || exit 43;",
            "printf \"%s\\n\" \"$_shelldesk_sudo_password\" | sudo -S -p '' -v &&",
            &format!("sudo -n sh -c {quoted};"),
            "fi",
        ]
        .join(" "),
        "su-root" => [
            "if [ \"$(id -u 2>/dev/null)\" = \"0\" ]; then",
            "IFS= read -r _shelldesk_root_password || true;",
            &format!("sh -c {quoted};"),
            "else",
            &format!("su - root -c {quoted};"),
            "fi",
        ]
        .join(" "),
        _ => command,
    };
    (wrapped, format!("{}\n{}", privilege.password, stdin))
}

fn assert_privilege_result(
    result: &Value,
    privilege: Option<&PrivilegeConfig>,
) -> Result<(), String> {
    let Some(privilege) = privilege else {
        return Ok(());
    };
    if result.get("code").and_then(Value::as_i64).unwrap_or(1) == 0 {
        return Ok(());
    }
    let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or("");
    let stderr_lower = stderr.to_ascii_lowercase();
    if privilege.mode == "sudo"
        && (stderr_lower.contains("sorry, try again")
            || stderr_lower.contains("incorrect password")
            || stderr_lower.contains("authentication failure")
            || stderr_lower.contains("authentication failed"))
    {
        let detail = stderr.trim();
        return Err(format!(
            "SHELLDESK_ELEVATION_AUTH_FAILED:{}",
            if detail.is_empty() {
                "sudo 密码验证失败或当前账号没有提权权限。"
            } else {
                detail
            }
        ));
    }
    if privilege.mode == "su-root" {
        if stderr_lower.contains("must be run from a terminal")
            || stderr_lower.contains("cannot open session")
            || stderr_lower.contains("no tty")
            || stderr_lower.contains("conversation error")
            || stderr_lower.contains("authentication token manipulation")
        {
            let detail = stderr.trim();
            return Err(format!(
                "SHELLDESK_SU_ROOT_UNSUPPORTED:{}",
                if detail.is_empty() {
                    "远程系统无法在非交互 SSH 命令中使用 su root。"
                } else {
                    detail
                }
            ));
        }
        if stderr_lower.contains("authentication failure")
            || stderr_lower.contains("authentication failed")
            || stderr_lower.contains("incorrect password")
            || stderr_lower.contains("permission denied")
            || stderr_lower.contains("denied")
            || stderr.contains("密码")
            || stderr.contains("认证失败")
        {
            let detail = stderr.trim();
            return Err(format!(
                "SHELLDESK_SU_ROOT_AUTH_FAILED:{}",
                if detail.is_empty() {
                    "root 密码验证失败，或当前账号不能通过 su root 提权。"
                } else {
                    detail
                }
            ));
        }
    }
    Ok(())
}

pub(crate) async fn run_connection_command_stream(
    state: &AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let command = string_arg(&args, 1)?;
    let stdin = args
        .get(2)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let stream_id = string_arg(&args, 3)?;
    let connection = get_connection(state, &connection_id)?;

    if connection.kind == ConnectionKind::Local {
        return run_shell_stream(command, stdin, Duration::from_secs(60), window, stream_id).await;
    }

    let profile = connection
        .ssh
        .clone()
        .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
    let privilege = configured_privilege(&connection, args.get(4));
    let (command, stdin) = apply_privilege_to_command(command, stdin, privilege.as_ref());
    let result = run_ssh_command_stream_for_connection_with_retry(
        state,
        window,
        &connection_id,
        profile,
        command,
        stdin,
        stream_id,
    )
    .await?;
    assert_privilege_result(&result, privilege.as_ref())?;
    Ok(result)
}

async fn run_ssh_command_for_connection_with_retry(
    state: &AppState,
    window: Option<tauri::Window>,
    connection_id: &str,
    profile: SshProfile,
    command: String,
    stdin: String,
) -> Result<Value, String> {
    let first = run_ssh_command_for_profile_with_window(
        state,
        window.clone(),
        profile.clone(),
        command.clone(),
        stdin.clone(),
    )
    .await;

    if !should_retry_ssh_attempt(&first) {
        return first;
    }

    let reason = reconnect_reason(&first);
    emit_connection_closed(window.as_ref(), connection_id, &reason);
    emit_connection_reconnecting(window.as_ref(), connection_id, &reason);

    let second =
        run_ssh_command_for_profile_with_window(state, window.clone(), profile, command, stdin)
            .await;
    if should_retry_ssh_attempt(&second) {
        emit_connection_closed(
            window.as_ref(),
            connection_id,
            &format!("SSH 自动重连失败：{}", attempt_message(&second)),
        );
        return second;
    }

    emit_connection_restored(window.as_ref(), connection_id);
    second
}

async fn run_ssh_command_stream_for_connection_with_retry(
    state: &AppState,
    window: tauri::Window,
    connection_id: &str,
    profile: SshProfile,
    command: String,
    stdin: String,
    stream_id: String,
) -> Result<Value, String> {
    let first = run_ssh_command_stream_for_profile(
        state,
        profile.clone(),
        command.clone(),
        stdin.clone(),
        window.clone(),
        stream_id.clone(),
    )
    .await;

    if !should_retry_ssh_attempt(&first) {
        return first;
    }

    let reason = reconnect_reason(&first);
    emit_connection_closed(Some(&window), connection_id, &reason);
    emit_connection_reconnecting(Some(&window), connection_id, &reason);

    let second = run_ssh_command_stream_for_profile(
        state,
        profile,
        command,
        stdin,
        window.clone(),
        stream_id,
    )
    .await;
    if should_retry_ssh_attempt(&second) {
        emit_connection_closed(
            Some(&window),
            connection_id,
            &format!("SSH 自动重连失败：{}", attempt_message(&second)),
        );
        return second;
    }

    emit_connection_restored(Some(&window), connection_id);
    second
}

fn should_retry_ssh_attempt(result: &Result<Value, String>) -> bool {
    match result {
        Ok(output) => ssh_output_is_recoverable(output),
        Err(error) => is_recoverable_ssh_message(error),
    }
}

fn ssh_output_is_recoverable(output: &Value) -> bool {
    if output
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    let code = output.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code != 255 && code != -1 {
        return false;
    }
    is_recoverable_ssh_message(&output_message(output))
}

fn output_message(output: &Value) -> String {
    let stderr = output.get("stderr").and_then(Value::as_str).unwrap_or("");
    let stdout = output.get("stdout").and_then(Value::as_str).unwrap_or("");
    if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.trim().to_string()
    }
}

fn attempt_message(result: &Result<Value, String>) -> String {
    match result {
        Ok(output) => output_message(output),
        Err(error) => error.clone(),
    }
    .trim()
    .to_string()
}

fn reconnect_reason(result: &Result<Value, String>) -> String {
    let detail = attempt_message(result);
    if detail.is_empty() {
        "SSH 通道不可用，正在自动重连。".to_string()
    } else {
        format!("SSH 通道不可用，正在自动重连：{detail}")
    }
}

fn is_recoverable_ssh_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "channel open failure",
        "open failed",
        "not connected",
        "no response from server",
        "cannot open channel",
        "unable to open channel",
        "unable to open session",
        "connection reset",
        "connection timed out",
        "connection closed",
        "broken pipe",
        "kex_exchange_identification",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

fn emit_connection_closed(window: Option<&tauri::Window>, connection_id: &str, reason: &str) {
    emit_connection_event(
        window,
        "connection:closed",
        json!({ "connectionId": connection_id, "reason": reason }),
    );
}

fn emit_connection_reconnecting(window: Option<&tauri::Window>, connection_id: &str, reason: &str) {
    emit_connection_event(
        window,
        "connection:reconnecting",
        json!({ "connectionId": connection_id, "reason": reason, "startedAt": now() }),
    );
}

fn emit_connection_restored(window: Option<&tauri::Window>, connection_id: &str) {
    emit_connection_event(
        window,
        "connection:restored",
        json!({ "connectionId": connection_id, "restoredAt": now() }),
    );
}

fn emit_connection_event(window: Option<&tauri::Window>, event: &str, payload: Value) {
    if let Some(window) = window {
        let _ = window.emit(event, payload);
    }
}

pub(crate) async fn run_ssh_command_stream_for_profile(
    state: &AppState,
    profile: SshProfile,
    command: String,
    stdin: String,
    window: tauri::Window,
    stream_id: String,
) -> Result<Value, String> {
    let _askpass_broker =
        start_optional_askpass_broker(state, Some(window.clone()), &profile).await?;
    let mut child = ssh_process_command(&profile, command, _askpass_broker.as_ref())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(error_string)?;
    run_spawned_command_stream(
        &mut child,
        stdin,
        Duration::from_secs(90),
        window,
        stream_id,
        "SSH command timed out.",
    )
    .await
}

pub(crate) async fn run_ssh_command_for_profile_interactive(
    state: &AppState,
    profile: SshProfile,
    command: String,
    stdin: String,
) -> Result<Value, String> {
    let window = current_ui_window(state);
    run_ssh_command_for_profile_with_window(state, window, profile, command, stdin).await
}

pub(crate) async fn run_ssh_command_for_profile_with_window(
    state: &AppState,
    window: Option<tauri::Window>,
    profile: SshProfile,
    command: String,
    stdin: String,
) -> Result<Value, String> {
    let _askpass_broker = start_optional_askpass_broker(state, window, &profile).await?;
    run_ssh_command_for_profile_with_broker(profile, command, stdin, _askpass_broker.as_ref()).await
}

async fn run_ssh_command_for_profile_with_broker(
    profile: SshProfile,
    command: String,
    stdin: String,
    askpass_broker: Option<&AskpassBroker>,
) -> Result<Value, String> {
    let mut child = ssh_process_command(&profile, command, askpass_broker);
    child
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = child.spawn().map_err(error_string)?;
    if let Some(mut child_stdin) = child.stdin.take() {
        if !stdin.is_empty() {
            child_stdin
                .write_all(stdin.as_bytes())
                .await
                .map_err(error_string)?;
        }
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "SSH stdout is unavailable.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "SSH stderr is unavailable.".to_string())?;
    let stdout_task = tokio::spawn(async move {
        let mut reader = stdout;
        let mut output = Vec::new();
        reader
            .read_to_end(&mut output)
            .await
            .map_err(error_string)?;
        Ok::<Vec<u8>, String>(output)
    });
    let stderr_task = tokio::spawn(async move {
        let mut reader = stderr;
        let mut output = Vec::new();
        reader
            .read_to_end(&mut output)
            .await
            .map_err(error_string)?;
        Ok::<Vec<u8>, String>(output)
    });
    let status = match time::timeout(Duration::from_secs(90), child.wait()).await {
        Ok(result) => result.map_err(error_string)?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err("SSH command timed out.".to_string());
        }
    };
    let stdout = stdout_task.await.map_err(error_string)??;
    let stderr = stderr_task.await.map_err(error_string)??;
    let code = status.code().unwrap_or(-1);
    Ok(json!({
        "stdout": String::from_utf8_lossy(&stdout),
        "stderr": String::from_utf8_lossy(&stderr),
        "code": code,
        "success": status.success()
    }))
}

async fn start_optional_askpass_broker(
    state: &AppState,
    window: Option<tauri::Window>,
    profile: &SshProfile,
) -> Result<Option<AskpassBroker>, String> {
    if profile.auth_method != "password" {
        return Ok(None);
    }
    let Some(window) = window else {
        return Ok(None);
    };
    start_askpass_broker(state, window, profile.clone())
        .await
        .map(Some)
}

fn ssh_process_command(
    profile: &SshProfile,
    command: String,
    askpass_broker: Option<&AskpassBroker>,
) -> Command {
    let mut child = if askpass_broker.is_none() && should_use_sshpass(profile) {
        let mut command = Command::new("sshpass");
        command.arg("-e");
        command.arg("ssh");
        command.env("SSHPASS", &profile.password);
        command
    } else {
        Command::new("ssh")
    };
    child.args(ssh_args(profile));
    child.arg(ssh_destination(profile));
    child.arg(command);
    prevent_tokio_process_window(&mut child);
    apply_askpass_env_tokio(&mut child, profile, askpass_broker);
    apply_proxy_helper_env_tokio(&mut child, profile);
    child
}

pub(crate) fn ssh_args(profile: &SshProfile) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        profile.port.to_string(),
        "-o".to_string(),
        "ConnectTimeout=15".to_string(),
    ];
    args.push("-o".to_string());
    args.push("StrictHostKeyChecking=yes".to_string());
    if !profile.known_hosts_path.is_empty() {
        args.push("-o".to_string());
        args.push(format!("UserKnownHostsFile={}", profile.known_hosts_path));
    }
    if profile.auth_method != "password" {
        args.push("-o".to_string());
        args.push("BatchMode=yes".to_string());
    }
    if !profile.key_path.is_empty() {
        args.push("-i".to_string());
        args.push(profile.key_path.clone());
    }
    if let Some(command) = proxy_command_for_profile(profile) {
        args.push("-o".to_string());
        args.push(format!("ProxyCommand={command}"));
    }
    args
}

pub(crate) fn should_use_sshpass(profile: &SshProfile) -> bool {
    profile.auth_method == "password" && !profile.password.is_empty() && command_exists("sshpass")
}

pub(crate) fn unavailable_password_auth_error(profile: &SshProfile) -> Option<String> {
    if let Some(jump) = profile.jump.as_deref() {
        if jump.auth_method == "password" && !jump.password.is_empty() && !command_exists("sshpass")
        {
            return Some("跳板机密码登录需要先安装 sshpass，或改用 SSH key/agent；当前 askpass 只能可靠处理目标主机的非交互密码提示。".to_string());
        }
        if let Some(error) = unavailable_password_auth_error(jump) {
            return Some(error);
        }
    }
    None
}

pub(crate) fn command_exists(name: &str) -> bool {
    let checker = if cfg!(windows) { "where" } else { "sh" };
    let mut command = StdCommand::new(checker);
    prevent_process_window(&mut command);
    if cfg!(windows) {
        command.arg(name);
    } else {
        command.args(["-lc", &format!("command -v {}", shell_quote(name))]);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub(crate) fn ssh_destination(profile: &SshProfile) -> String {
    if profile.username.trim().is_empty() {
        profile.address.clone()
    } else {
        format!("{}@{}", profile.username, profile.address)
    }
}

fn proxy_command_for_profile(profile: &SshProfile) -> Option<String> {
    if let Some(jump) = profile.jump.as_deref() {
        let mut parts = if should_use_sshpass(jump) {
            vec!["sshpass".to_string(), "-e".to_string(), "ssh".to_string()]
        } else {
            vec!["ssh".to_string()]
        };
        parts.extend(ssh_args(jump).into_iter().map(|arg| shell_arg(&arg)));
        parts.push("-W".to_string());
        parts.push("%h:%p".to_string());
        parts.push(shell_arg(&ssh_destination(jump)));
        return Some(parts.join(" "));
    }

    let proxy = profile.proxy.as_ref()?;
    match proxy.proxy_type.as_str() {
        "command" => Some(
            proxy
                .command
                .replace("{host}", "%h")
                .replace("{port}", "%p"),
        ),
        "http" | "socks5" => Some(network_proxy_command(profile, proxy)),
        _ => None,
    }
}

fn network_proxy_command(profile: &SshProfile, proxy: &SshProxyConfig) -> String {
    format!(
        "{} --shelldesk-proxy-helper {} %h %p",
        proxy_command_arg(&profile.proxy_helper_exe),
        proxy_command_arg(&proxy.helper_id)
    )
}

fn apply_askpass_env_tokio(
    command: &mut Command,
    profile: &SshProfile,
    askpass_broker: Option<&AskpassBroker>,
) {
    if profile.auth_method != "password" {
        return;
    }
    if profile.password.is_empty() && askpass_broker.is_none() {
        return;
    }
    if profile.proxy_helper_exe.trim().is_empty() {
        return;
    }
    command.env("SSH_ASKPASS", &profile.proxy_helper_exe);
    command.env("SSH_ASKPASS_REQUIRE", "force");
    command.env("SHELLDESK_ASKPASS_HELPER", "1");
    if !profile.password.is_empty() {
        command.env(
            "SHELLDESK_ASKPASS_PASSWORD",
            base64::engine::general_purpose::STANDARD.encode(profile.password.as_bytes()),
        );
    }
    if let Some(broker) = askpass_broker {
        command.env("SHELLDESK_ASKPASS_BROKER", &broker.address);
        command.env("SHELLDESK_ASKPASS_TOKEN", &broker.token);
    }
    if std::env::var("DISPLAY").is_err() {
        command.env("DISPLAY", "shelldesk");
    }
}

fn apply_proxy_helper_env_tokio(command: &mut Command, profile: &SshProfile) {
    for (name, value) in proxy_helper_envs(profile) {
        command.env(name, value);
    }
    if let Some(password) = jump_sshpass_password(profile) {
        command.env("SSHPASS", password);
    }
}

pub(crate) fn apply_proxy_helper_env_pty(command: &mut CommandBuilder, profile: &SshProfile) {
    for (name, value) in proxy_helper_envs(profile) {
        command.env(name, value);
    }
    if let Some(password) = jump_sshpass_password(profile) {
        command.env("SSHPASS", password);
    }
}

fn proxy_helper_envs(profile: &SshProfile) -> Vec<(String, String)> {
    let mut envs = Vec::new();
    collect_proxy_helper_envs(profile, &mut envs);
    envs
}

fn collect_proxy_helper_envs(profile: &SshProfile, envs: &mut Vec<(String, String)>) {
    if let Some(proxy) = profile.proxy.as_ref() {
        if matches!(proxy.proxy_type.as_str(), "http" | "socks5") {
            let config = json!({
                "type": proxy.proxy_type,
                "host": proxy.host,
                "port": proxy.port,
                "username": proxy.username,
                "password": proxy.password
            });
            if let Ok(bytes) = serde_json::to_vec(&config) {
                envs.push((
                    proxy_helper_env_name(&proxy.helper_id),
                    base64::engine::general_purpose::STANDARD.encode(bytes),
                ));
            }
        }
    }
    if let Some(jump) = profile.jump.as_deref() {
        collect_proxy_helper_envs(jump, envs);
    }
}

fn jump_sshpass_password(profile: &SshProfile) -> Option<&str> {
    let jump = profile.jump.as_deref()?;
    if should_use_sshpass(jump) {
        Some(jump.password.as_str())
    } else {
        jump_sshpass_password(jump)
    }
}

fn proxy_command_arg(value: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        shell_arg(value)
    }
}

fn shell_arg(value: &str) -> String {
    if value.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/' | ':' | '@' | '%' | '=')
    }) {
        value.to_string()
    } else {
        shell_quote(value)
    }
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub(crate) fn value_to_bytes(value: Value) -> Result<Vec<u8>, String> {
    if let Some(array) = value.as_array() {
        return Ok(array
            .iter()
            .filter_map(Value::as_u64)
            .map(|byte| byte as u8)
            .collect());
    }
    if let Some(object) = value.as_object() {
        if let Some(data) = object.get("data").and_then(Value::as_array) {
            return Ok(data
                .iter()
                .filter_map(Value::as_u64)
                .map(|byte| byte as u8)
                .collect());
        }
    }
    Err("终端二进制输入无效。".to_string())
}

pub(crate) fn start_ssh_local_forward(
    profile: &SshProfile,
    local_port: u16,
    remote_host: &str,
    remote_port: u16,
) -> Result<StdChild, String> {
    let mut command = if should_use_sshpass(profile) {
        let mut command = StdCommand::new("sshpass");
        command.arg("-e");
        command.arg("ssh");
        command.env("SSHPASS", &profile.password);
        command
    } else {
        StdCommand::new("ssh")
    };
    command.args(ssh_args(profile));
    command.arg("-o");
    command.arg("ExitOnForwardFailure=yes");
    command.arg("-N");
    command.arg("-L");
    command.arg(format!(
        "127.0.0.1:{local_port}:{remote_host}:{remote_port}"
    ));
    command.arg(ssh_destination(profile));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    prevent_process_window(&mut command);
    command.spawn().map_err(error_string)
}

pub(crate) async fn wait_for_tcp(host: &str, port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = time::Instant::now() + timeout;
    loop {
        match TcpStream::connect((host, port)).await {
            Ok(_) => return Ok(()),
            Err(error) => {
                if time::Instant::now() >= deadline {
                    return Err(error.to_string());
                }
                time::sleep(Duration::from_millis(150)).await;
            }
        }
    }
}

pub(crate) fn pick_free_local_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(error_string)?;
    let port = listener.local_addr().map_err(error_string)?.port();
    drop(listener);
    Ok(port)
}

pub(crate) async fn run_cli_output(
    state: &AppState,
    connection_id: &str,
    posix_command: String,
    windows_command: Option<String>,
    fallback_error: &str,
) -> Result<String, String> {
    let connection = get_connection(state, connection_id)?;
    let command = if connection.kind == ConnectionKind::Local && cfg!(windows) {
        windows_command.unwrap_or(posix_command)
    } else {
        posix_command
    };
    let output =
        run_connection_command(state, vec![json!(connection_id), json!(command), json!("")])
            .await?;
    if output.get("code").and_then(Value::as_i64).unwrap_or(1) != 0 {
        return Err(output
            .get("stderr")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                output
                    .get("stdout")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or(fallback_error)
            .to_string());
    }
    Ok(output
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string())
}

pub(crate) fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn recoverable_ssh_messages_match_legacy_channel_errors() {
        assert!(is_recoverable_ssh_message(
            "Channel open failure: open failed"
        ));
        assert!(is_recoverable_ssh_message("Not connected"));
        assert!(is_recoverable_ssh_message(
            "Unable to open session: no response from server"
        ));
    }

    #[test]
    fn recoverable_ssh_messages_include_cli_transport_failures() {
        assert!(is_recoverable_ssh_message(
            "kex_exchange_identification: Connection closed by remote host"
        ));
        assert!(is_recoverable_ssh_message(
            "client_loop: send disconnect: Broken pipe"
        ));
        assert!(is_recoverable_ssh_message(
            "ssh: connect to host example.com port 22: Connection timed out"
        ));
    }

    #[test]
    fn ssh_output_retry_requires_transport_exit_code() {
        let recoverable = json!({
            "success": false,
            "code": 255,
            "stderr": "Connection reset by peer",
            "stdout": ""
        });
        assert!(ssh_output_is_recoverable(&recoverable));

        let command_failure = json!({
            "success": false,
            "code": 1,
            "stderr": "command not found",
            "stdout": ""
        });
        assert!(!ssh_output_is_recoverable(&command_failure));
    }

    #[test]
    fn auth_failures_do_not_trigger_reconnect_retry() {
        assert!(!is_recoverable_ssh_message(
            "Permission denied, please try again."
        ));
        assert!(!ssh_output_is_recoverable(&json!({
            "success": false,
            "code": 255,
            "stderr": "Permission denied (publickey,password).",
            "stdout": ""
        })));
    }

    #[test]
    fn reconnect_reason_preserves_failure_detail() {
        let result = Ok(json!({
            "success": false,
            "code": 255,
            "stderr": "Not connected",
            "stdout": ""
        }));
        assert_eq!(
            reconnect_reason(&result),
            "SSH 通道不可用，正在自动重连：Not connected"
        );
    }

    #[tokio::test]
    async fn live_ssh_backend_smoke_uses_env_credentials_when_available() {
        let require_live_smoke = std::env::var("SHELLDESK_REQUIRE_LIVE_SSH_SMOKE")
            .ok()
            .as_deref()
            == Some("1");
        let Some(profile) = live_ssh_profile_from_env_or_dotenv() else {
            if require_live_smoke {
                panic!("live SSH backend smoke requires SHELLDESK_TEST_SSH_HOST, SHELLDESK_TEST_SSH_USERNAME, and either SHELLDESK_TEST_SSH_PASSWORD or SHELLDESK_TEST_SSH_KEY_PATH");
            }
            return;
        };
        if profile.auth_method == "password"
            && !should_use_sshpass(&profile)
            && profile.proxy_helper_exe.trim().is_empty()
        {
            let message = "password auth live SSH backend smoke requires SHELLDESK_TEST_ASKPASS_EXE or sshpass";
            if require_live_smoke {
                panic!("{message}");
            }
            eprintln!("skipping live SSH backend smoke: {message}");
            return;
        }
        let state = AppState::new(
            std::env::temp_dir().join(format!("shelldesk-live-ssh-smoke-{}", std::process::id())),
        );
        let output = run_ssh_command_for_profile_with_window(
            &state,
            None,
            profile.clone(),
            "printf shelldesk-live-smoke".to_string(),
            String::new(),
        )
        .await
        .expect("live SSH backend smoke command should run");

        assert_eq!(output.get("code").and_then(Value::as_i64), Some(0));
        assert_eq!(
            output.get("stdout").and_then(Value::as_str),
            Some("shelldesk-live-smoke")
        );

        run_live_remote_file_smoke(&state, profile.clone()).await;
        run_live_sftp_probe_smoke(&state, profile).await;
    }

    async fn run_live_remote_file_smoke(state: &AppState, profile: SshProfile) {
        let marker = format!("shelldesk-live-file-smoke-{}", std::process::id());
        let command = format!(
            "set -eu\n\
             base=\"${{TMPDIR:-/tmp}}/shelldesk-live-file-smoke-{pid}\"\n\
             rm -rf -- \"$base\"\n\
             mkdir -p -- \"$base\"\n\
             trap 'rm -rf -- \"$base\"' EXIT\n\
             printf %s {marker} > \"$base/file.txt\"\n\
             read_back=$(cat -- \"$base/file.txt\")\n\
             list_back=$(ls -1 -- \"$base\")\n\
             if [ \"$read_back\" != {marker} ]; then echo \"read mismatch\" >&2; exit 12; fi\n\
             if [ \"$list_back\" != \"file.txt\" ]; then echo \"list mismatch: $list_back\" >&2; exit 13; fi\n\
             rm -f -- \"$base/file.txt\"\n\
             if [ -e \"$base/file.txt\" ]; then echo \"delete failed\" >&2; exit 14; fi\n\
             printf 'file=%s\\nlist=%s\\ndeleted=true\\n' \"$read_back\" \"$list_back\"\n",
            pid = std::process::id(),
            marker = shell_quote(&marker)
        );
        let output =
            run_ssh_command_for_profile_with_window(state, None, profile, command, String::new())
                .await
                .expect("live remote file smoke command should run");

        assert_eq!(output.get("code").and_then(Value::as_i64), Some(0));
        let stdout = output.get("stdout").and_then(Value::as_str).unwrap_or("");
        assert!(stdout.contains(&format!("file={marker}")));
        assert!(stdout.contains("list=file.txt"));
        assert!(stdout.contains("deleted=true"));
    }

    async fn run_live_sftp_probe_smoke(state: &AppState, profile: SshProfile) {
        let output = run_ssh_command_for_profile_with_window(
            state,
            None,
            profile,
            crate::remote_fs::remote_sftp_probe_command(),
            String::new(),
        )
        .await
        .expect("live SFTP probe command should run");

        assert_eq!(
            output.get("code").and_then(Value::as_i64),
            Some(0),
            "live SFTP probe should find an executable sftp-server"
        );
    }

    fn live_ssh_profile_from_env_or_dotenv() -> Option<SshProfile> {
        let values = test_env_values();
        let address = test_env_value(&values, "SHELLDESK_TEST_SSH_HOST")?;
        let username = test_env_value(&values, "SHELLDESK_TEST_SSH_USERNAME")?;
        let port = test_env_value(&values, "SHELLDESK_TEST_SSH_PORT")
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22);
        let key_path = test_env_value(&values, "SHELLDESK_TEST_SSH_KEY_PATH").unwrap_or_default();
        let password = test_env_value(&values, "SHELLDESK_TEST_SSH_PASSWORD").unwrap_or_default();
        if key_path.is_empty() && password.is_empty() {
            eprintln!(
                "skipping live SSH backend smoke: missing SHELLDESK_TEST_SSH_PASSWORD or SHELLDESK_TEST_SSH_KEY_PATH"
            );
            return None;
        }

        Some(SshProfile {
            address,
            port,
            username,
            auth_method: if key_path.is_empty() {
                "password".to_string()
            } else {
                "privateKey".to_string()
            },
            password,
            key_path,
            known_hosts_path: test_env_value(&values, "SHELLDESK_TEST_SSH_KNOWN_HOSTS_PATH")
                .unwrap_or_default(),
            proxy_helper_exe: test_env_value(&values, "SHELLDESK_TEST_ASKPASS_EXE")
                .unwrap_or_default(),
            proxy: None,
            jump: None,
        })
    }

    fn test_env_values() -> HashMap<String, String> {
        let mut values = read_dotenv_values();
        for key in [
            "SHELLDESK_TEST_SSH_HOST",
            "SHELLDESK_TEST_SSH_PORT",
            "SHELLDESK_TEST_SSH_USERNAME",
            "SHELLDESK_TEST_SSH_PASSWORD",
            "SHELLDESK_TEST_SSH_KEY_PATH",
            "SHELLDESK_TEST_SSH_KNOWN_HOSTS_PATH",
            "SHELLDESK_TEST_ASKPASS_EXE",
        ] {
            if let Ok(value) = std::env::var(key) {
                values.insert(key.to_string(), value);
            }
        }
        values
    }

    fn read_dotenv_values() -> HashMap<String, String> {
        let Ok(text) = std::fs::read_to_string(dotenv_path()) else {
            return HashMap::new();
        };
        text.lines()
            .filter_map(parse_dotenv_line)
            .collect::<HashMap<_, _>>()
    }

    fn dotenv_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(".env")
    }

    fn parse_dotenv_line(line: &str) -> Option<(String, String)> {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return None;
        }
        let (key, value) = trimmed.split_once('=')?;
        Some((key.trim().to_string(), unquote_dotenv_value(value.trim())))
    }

    fn unquote_dotenv_value(value: &str) -> String {
        if value.len() >= 2 {
            let first = value.as_bytes()[0];
            let last = value.as_bytes()[value.len() - 1];
            if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
                return value[1..value.len() - 1].to_string();
            }
        }
        value.to_string()
    }

    fn test_env_value(values: &HashMap<String, String>, key: &str) -> Option<String> {
        values
            .get(key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value != "change-me")
    }
}
