use crate::askpass::AskpassBroker;
use crate::{
    apply_askpass_env_pty, apply_proxy_helper_env_pty, error_string, get_connection,
    should_use_sshpass, ssh_args_with_askpass, ssh_destination, start_optional_askpass_broker,
    string_arg, value_to_bytes, ActiveConnection, AppState, ConnectionKind,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::Emitter;

pub(crate) struct TerminalSession {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    _askpass_broker: Option<AskpassBroker>,
}

impl TerminalSession {
    fn close(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.close();
    }
}

struct TerminalLaunchOptions {
    shell: String,
    initial_command: String,
    working_directory: String,
}

struct TerminalStartupPlan {
    initial_input: String,
    root_password: String,
    after_auth_input: String,
}

pub(crate) async fn start_terminal(
    state: &AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let terminal_id = string_arg(&args, 1)?;
    validate_terminal_id(&terminal_id)?;
    let (columns, rows) = read_terminal_size(&args)?;
    let launch_options = read_terminal_launch_options(args.get(4))?;
    let connection = get_connection(state, &connection_id)?;
    let terminal_key = terminal_key(&connection_id, &terminal_id);
    if state
        .terminals
        .lock()
        .map_err(error_string)?
        .contains_key(&terminal_key)
    {
        return Ok(json!(true));
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(error_string)?;

    let askpass_broker = connection
        .ssh
        .as_ref()
        .map(|profile| start_optional_askpass_broker(state, Some(window.clone()), profile));
    let askpass_broker = match askpass_broker {
        Some(future) => future.await?,
        None => None,
    };
    let cmd =
        terminal_command_for_connection(&connection, &launch_options, askpass_broker.as_ref())?;
    let child = pair.slave.spawn_command(cmd).map_err(error_string)?;
    let mut reader = pair.master.try_clone_reader().map_err(error_string)?;
    let writer = pair.master.take_writer().map_err(error_string)?;
    let master = Arc::new(Mutex::new(pair.master));
    let writer = Arc::new(Mutex::new(writer));
    let startup_plan = create_terminal_startup_plan(&connection, &launch_options);
    let startup_writer = writer.clone();
    let event_connection_id = connection_id.clone();
    let event_terminal_id = terminal_id.clone();
    let terminals_clone = state.terminals.clone();
    let key_clone = terminal_key.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut terminal_prompt_buffer = String::new();
        let pending_after_auth_input =
            Arc::new(Mutex::new(if startup_plan.after_auth_input.is_empty() {
                None
            } else {
                Some(startup_plan.after_auth_input)
            }));
        let mut pending_root_password = startup_plan.root_password;
        let mut root_password_sent = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let data = String::from_utf8_lossy(&buffer[..count]).to_string();
                    handle_auto_su_root(
                        &data,
                        &startup_writer,
                        &mut terminal_prompt_buffer,
                        &mut pending_root_password,
                        &mut root_password_sent,
                        &pending_after_auth_input,
                    );
                    let _ = window.emit(
                        "terminal:data",
                        json!({
                            "connectionId": event_connection_id,
                            "terminalId": event_terminal_id,
                            "data": data
                        }),
                    );
                }
                Err(_) => break,
            }
        }
        let _ = window.emit(
            "terminal:exit",
            json!({
                "connectionId": event_connection_id,
                "terminalId": event_terminal_id,
                "code": null,
                "signal": null
            }),
        );
        if let Ok(mut map) = terminals_clone.lock() {
            map.remove(&key_clone);
        }
    });

    if !startup_plan.initial_input.is_empty() {
        writer
            .lock()
            .map_err(error_string)?
            .write_all(startup_plan.initial_input.as_bytes())
            .map_err(error_string)?;
    }

    state.terminals.lock().map_err(error_string)?.insert(
        terminal_key,
        TerminalSession {
            master,
            writer,
            child: Some(child),
            _askpass_broker: askpass_broker,
        },
    );

    Ok(json!(true))
}

fn terminal_command_for_connection(
    connection: &ActiveConnection,
    launch_options: &TerminalLaunchOptions,
    askpass_broker: Option<&AskpassBroker>,
) -> Result<CommandBuilder, String> {
    if connection.kind == ConnectionKind::Local {
        let mut cmd = local_terminal_command(launch_options);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if !launch_options.working_directory.is_empty() {
            cmd.cwd(PathBuf::from(&launch_options.working_directory));
        }
        return Ok(cmd);
    }

    let profile = connection
        .ssh
        .clone()
        .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
    let mut cmd = if should_use_sshpass(&profile) {
        let mut command = CommandBuilder::new("sshpass");
        command.arg("-e");
        command.arg("ssh");
        command.env("SSHPASS", &profile.password);
        command
    } else {
        CommandBuilder::new("ssh")
    };
    cmd.args(ssh_args_with_askpass(
        &profile,
        askpass_broker.is_some() || !profile.password.is_empty(),
    ));
    cmd.arg("-tt");
    cmd.arg(ssh_destination(&profile));
    cmd.env("TERM", "xterm-256color");
    apply_askpass_env_pty(&mut cmd, &profile, askpass_broker);
    apply_proxy_helper_env_pty(&mut cmd, &profile);
    Ok(cmd)
}

fn local_terminal_command(launch_options: &TerminalLaunchOptions) -> CommandBuilder {
    let requested_shell = launch_options.shell.trim();
    if !requested_shell.is_empty() {
        return CommandBuilder::new(requested_shell);
    }

    if cfg!(windows) {
        let startup_command = [
            "try { Remove-Module PSReadLine -ErrorAction SilentlyContinue } catch {}",
            "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
            "$OutputEncoding = [Console]::OutputEncoding",
        ]
        .join("; ");
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NoExit",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &startup_command,
        ]);
        return cmd;
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd
}

fn read_terminal_launch_options(
    raw_options: Option<&Value>,
) -> Result<TerminalLaunchOptions, String> {
    let Some(raw_options) = raw_options.and_then(Value::as_object) else {
        return Ok(TerminalLaunchOptions {
            shell: String::new(),
            initial_command: String::new(),
            working_directory: String::new(),
        });
    };

    Ok(TerminalLaunchOptions {
        shell: read_optional_terminal_launch_text(
            raw_options.get("shell"),
            "终端 Shell",
            160,
            false,
        )?,
        initial_command: read_optional_terminal_launch_text(
            raw_options.get("initialCommand"),
            "终端初始命令",
            8192,
            true,
        )?,
        working_directory: read_optional_terminal_launch_text(
            raw_options.get("workingDirectory"),
            "终端工作目录",
            1024,
            false,
        )?,
    })
}

fn read_optional_terminal_launch_text(
    raw_value: Option<&Value>,
    label: &str,
    max_length: usize,
    allow_newlines: bool,
) -> Result<String, String> {
    let Some(value) = raw_value.and_then(Value::as_str).map(str::trim) else {
        return Ok(String::new());
    };
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.len() > max_length
        || value.contains('\0')
        || (!allow_newlines && (value.contains('\r') || value.contains('\n')))
    {
        return Err(format!("{label}无效。"));
    }
    Ok(value.to_string())
}

fn create_terminal_startup_plan(
    connection: &ActiveConnection,
    launch_options: &TerminalLaunchOptions,
) -> TerminalStartupPlan {
    let startup_input = create_terminal_startup_input(connection, launch_options);
    let system_type = connection
        .host
        .get("systemType")
        .and_then(Value::as_str)
        .unwrap_or("");
    if connection.kind == ConnectionKind::Ssh
        && system_type != "windows"
        && connection
            .privilege
            .as_ref()
            .is_some_and(|privilege| privilege.mode == "su-root" && !privilege.password.is_empty())
    {
        return TerminalStartupPlan {
            initial_input: "su - root\r".to_string(),
            root_password: connection
                .privilege
                .as_ref()
                .map(|privilege| privilege.password.clone())
                .unwrap_or_default(),
            after_auth_input: startup_input,
        };
    }

    TerminalStartupPlan {
        initial_input: startup_input,
        root_password: String::new(),
        after_auth_input: String::new(),
    }
}

fn create_terminal_startup_input(
    connection: &ActiveConnection,
    launch_options: &TerminalLaunchOptions,
) -> String {
    let mut startup_lines = Vec::new();
    let system_type = connection
        .host
        .get("systemType")
        .and_then(Value::as_str)
        .unwrap_or("");

    if connection.kind == ConnectionKind::Ssh && !launch_options.working_directory.is_empty() {
        startup_lines.push(format!(
            "cd {}",
            quote_terminal_startup_directory(&launch_options.working_directory, system_type)
        ));
    }

    if connection.kind == ConnectionKind::Ssh && !launch_options.shell.is_empty() {
        startup_lines.push(launch_options.shell.clone());
    }

    if !launch_options.initial_command.is_empty() {
        startup_lines.push(
            launch_options
                .initial_command
                .replace("\r\n", "\r")
                .replace('\n', "\r"),
        );
    }

    if startup_lines.is_empty() {
        String::new()
    } else {
        format!("{}\r", startup_lines.join("\r"))
    }
}

fn quote_terminal_startup_directory(directory: &str, system_type: &str) -> String {
    if system_type == "windows" {
        return format!("\"{}\"", directory.replace('"', "\"\""));
    }
    format!("'{}'", directory.replace('\'', "'\\''"))
}

fn handle_auto_su_root(
    data: &str,
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    terminal_prompt_buffer: &mut String,
    pending_root_password: &mut String,
    root_password_sent: &mut bool,
    pending_after_auth_input: &Arc<Mutex<Option<String>>>,
) {
    if pending_root_password.is_empty()
        && pending_after_auth_input
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|_| ()))
            .is_none()
    {
        return;
    }

    terminal_prompt_buffer.push_str(data);
    if terminal_prompt_buffer.len() > 2048 {
        let split_at = terminal_prompt_buffer.len().saturating_sub(2048);
        terminal_prompt_buffer.drain(..split_at);
    }

    if *root_password_sent && is_terminal_su_authentication_failure(terminal_prompt_buffer) {
        if let Ok(mut pending) = pending_after_auth_input.lock() {
            *pending = None;
        }
        return;
    }

    if *root_password_sent && is_terminal_likely_root_prompt(terminal_prompt_buffer) {
        flush_after_auth_input(writer, pending_after_auth_input);
        return;
    }

    if !*root_password_sent
        && !pending_root_password.is_empty()
        && is_terminal_password_prompt(terminal_prompt_buffer)
    {
        let password = std::mem::take(pending_root_password);
        *root_password_sent = true;
        if let Ok(mut writer) = writer.lock() {
            let _ = writer.write_all(format!("{password}\r").as_bytes());
        }
        let delayed_writer = writer.clone();
        let delayed_input = pending_after_auth_input.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(4));
            flush_after_auth_input(&delayed_writer, &delayed_input);
        });
    }
}

fn flush_after_auth_input(
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    pending_after_auth_input: &Arc<Mutex<Option<String>>>,
) {
    let input = pending_after_auth_input
        .lock()
        .ok()
        .and_then(|mut pending| pending.take());
    if let Some(input) = input {
        if let Ok(mut writer) = writer.lock() {
            let _ = writer.write_all(input.as_bytes());
        }
    }
}

fn strip_terminal_control_sequences(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if matches!(chars.peek(), Some('[')) {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
                continue;
            }
            if matches!(chars.peek(), Some(']')) {
                chars.next();
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && matches!(chars.peek(), Some('\\')) {
                        chars.next();
                        break;
                    }
                }
                continue;
            }
        }
        output.push(if ch == '\r' { '\n' } else { ch });
    }
    output
}

fn is_terminal_password_prompt(value: &str) -> bool {
    let stripped = strip_terminal_control_sequences(value);
    let line = stripped.lines().last().unwrap_or("").trim();
    let lower = line.to_lowercase();
    line.ends_with(':')
        && (lower.contains("password") || line.contains('密') || line.contains("口令"))
}

fn is_terminal_su_authentication_failure(value: &str) -> bool {
    let stripped = strip_terminal_control_sequences(value).to_lowercase();
    stripped.contains("authentication failure")
        || stripped.contains("authentication failed")
        || stripped.contains("incorrect password")
        || stripped.contains("permission denied")
        || stripped.contains("认证失败")
        || stripped.contains("鉴定故障")
        || stripped.contains("密码") && (stripped.contains("错误") || stripped.contains("失败"))
}

fn is_terminal_likely_root_prompt(value: &str) -> bool {
    strip_terminal_control_sequences(value)
        .lines()
        .last()
        .map(str::trim_end)
        .is_some_and(|line| line.ends_with('#'))
}

fn validate_terminal_id(terminal_id: &str) -> Result<(), String> {
    if terminal_id.is_empty()
        || terminal_id.len() > 120
        || !terminal_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, ':' | '_' | '-'))
    {
        return Err("终端标识无效。".to_string());
    }
    Ok(())
}

fn read_terminal_size(args: &[Value]) -> Result<(u16, u16), String> {
    let columns = read_terminal_dimension(args.get(2), 100, 20, 300)?;
    let rows = read_terminal_dimension(args.get(3), 30, 5, 120)?;
    validate_terminal_size(columns, rows)?;
    Ok((columns, rows))
}

fn read_terminal_dimension(
    value: Option<&Value>,
    fallback: u16,
    min: u64,
    max: u64,
) -> Result<u16, String> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let Some(next) = value.as_u64() else {
        return Err("终端尺寸无效。".to_string());
    };
    if next < min || next > max {
        return Err("终端尺寸无效。".to_string());
    }
    Ok(next as u16)
}

fn validate_terminal_size(columns: u16, rows: u16) -> Result<(), String> {
    if !(20..=300).contains(&columns) || !(5..=120).contains(&rows) {
        return Err("终端尺寸无效。".to_string());
    }
    Ok(())
}

pub(crate) fn resize_terminal(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let terminal_id = string_arg(&args, 1)?;
    let (columns, rows) = read_terminal_size(&args)?;
    let key = terminal_key(&connection_id, &terminal_id);
    let terminals = state.terminals.lock().map_err(error_string)?;
    let terminal = terminals
        .get(&key)
        .ok_or_else(|| "终端尚未启动。".to_string())?;
    terminal
        .master
        .lock()
        .map_err(error_string)?
        .resize(PtySize {
            rows,
            cols: columns,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(error_string)?;
    Ok(json!(true))
}

pub(crate) fn write_terminal(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let terminal_id = string_arg(&args, 1)?;
    let data = string_arg(&args, 2)?;
    let key = terminal_key(&connection_id, &terminal_id);
    let terminals = state.terminals.lock().map_err(error_string)?;
    let terminal = terminals
        .get(&key)
        .ok_or_else(|| "终端尚未启动。".to_string())?;
    terminal
        .writer
        .lock()
        .map_err(error_string)?
        .write_all(data.as_bytes())
        .map_err(error_string)?;
    Ok(json!(true))
}

pub(crate) fn write_terminal_bytes(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let terminal_id = string_arg(&args, 1)?;
    let bytes = value_to_bytes(args.get(2).cloned().unwrap_or(Value::Null))?;
    let key = terminal_key(&connection_id, &terminal_id);
    let terminals = state.terminals.lock().map_err(error_string)?;
    let terminal = terminals
        .get(&key)
        .ok_or_else(|| "终端尚未启动。".to_string())?;
    terminal
        .writer
        .lock()
        .map_err(error_string)?
        .write_all(&bytes)
        .map_err(error_string)?;
    Ok(json!(true))
}

pub(crate) fn close_terminal(state: &AppState, args: Vec<Value>) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let terminal_id = string_arg(&args, 1)?;
    let key = terminal_key(&connection_id, &terminal_id);
    if let Some(mut terminal) = state.terminals.lock().map_err(error_string)?.remove(&key) {
        terminal.close();
    }
    Ok(json!(true))
}

pub(crate) fn close_terminals_for_connection(
    state: &AppState,
    connection_id: &str,
) -> Result<usize, String> {
    let keys = terminal_keys_for_connection(
        state
            .terminals
            .lock()
            .map_err(error_string)?
            .keys()
            .map(String::as_str),
        connection_id,
    );
    let mut terminals = state.terminals.lock().map_err(error_string)?;
    let mut closed = 0;
    for key in keys {
        if let Some(mut terminal) = terminals.remove(&key) {
            terminal.close();
            closed += 1;
        }
    }
    Ok(closed)
}

fn terminal_key(connection_id: &str, terminal_id: &str) -> String {
    format!("{connection_id}:{terminal_id}")
}

fn terminal_keys_for_connection<'a>(
    keys: impl Iterator<Item = &'a str>,
    connection_id: &str,
) -> Vec<String> {
    let prefix = format!("{connection_id}:");
    keys.filter(|key| key.starts_with(&prefix))
        .map(ToString::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SshProfile;
    use serde_json::json;
    use std::collections::HashSet;

    fn ssh_connection(
        system_type: &str,
        privilege: Option<crate::PrivilegeConfig>,
    ) -> ActiveConnection {
        ActiveConnection {
            id: "conn-1".to_string(),
            kind: ConnectionKind::Ssh,
            partition: "persist:conn-1".to_string(),
            proxy_port: 0,
            browser_certificate_trust: HashSet::new(),
            connected_at: "now".to_string(),
            host: json!({ "systemType": system_type }),
            ssh: Some(SshProfile {
                address: "example.test".to_string(),
                port: 22,
                username: "root".to_string(),
                auth_method: "password".to_string(),
                password: "secret".to_string(),
                key_path: String::new(),
                known_hosts_path: String::new(),
                proxy_helper_exe: String::new(),
                proxy: None,
                jump: None,
            }),
            privilege,
        }
    }

    #[test]
    fn creates_remote_terminal_startup_input() {
        let connection = ssh_connection("linux", None);
        let launch_options = TerminalLaunchOptions {
            shell: "bash".to_string(),
            initial_command: "echo one\necho two".to_string(),
            working_directory: "/var/log/app's".to_string(),
        };

        assert_eq!(
            create_terminal_startup_input(&connection, &launch_options),
            "cd '/var/log/app'\\''s'\rbash\recho one\recho two\r"
        );
    }

    #[test]
    fn creates_su_root_terminal_startup_plan() {
        let connection = ssh_connection(
            "linux",
            Some(crate::PrivilegeConfig {
                mode: "su-root".to_string(),
                password: "root-pass".to_string(),
            }),
        );
        let launch_options = TerminalLaunchOptions {
            shell: String::new(),
            initial_command: "whoami".to_string(),
            working_directory: String::new(),
        };

        let plan = create_terminal_startup_plan(&connection, &launch_options);

        assert_eq!(plan.initial_input, "su - root\r");
        assert_eq!(plan.root_password, "root-pass");
        assert_eq!(plan.after_auth_input, "whoami\r");
    }

    #[test]
    fn rejects_invalid_terminal_launch_options() {
        let options = json!({ "shell": "bash\nzsh" });
        assert!(read_terminal_launch_options(Some(&options)).is_err());
    }

    #[test]
    fn terminal_size_rejects_out_of_range_values_before_u16_cast() {
        let too_large = vec![
            json!("conn-1"),
            json!("term-1"),
            json!(65556_u64),
            json!(24),
        ];
        assert!(read_terminal_size(&too_large).is_err());

        let invalid_rows = vec![json!("conn-1"), json!("term-1"), json!(80), json!(4)];
        assert!(read_terminal_size(&invalid_rows).is_err());

        let valid = vec![json!("conn-1"), json!("term-1"), json!(120), json!(40)];
        assert_eq!(read_terminal_size(&valid).unwrap(), (120, 40));
    }

    #[test]
    fn terminal_keys_for_connection_match_only_prefixed_sessions() {
        let keys = terminal_keys_for_connection(
            [
                "conn-1:term-a",
                "conn-10:term-b",
                "conn-1-extra:term-c",
                "conn-1:term-d",
            ]
            .into_iter(),
            "conn-1",
        );
        assert_eq!(
            keys,
            vec!["conn-1:term-a".to_string(), "conn-1:term-d".to_string()]
        );
    }
}
