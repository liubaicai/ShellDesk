use crate::russh_client::connect_authenticated;
use crate::{
    error_string, get_connection, prevent_tokio_process_window, string_arg, value_to_bytes,
    ActiveConnection, AppState, ConnectionKind, UiWindowRef,
};
use russh::ChannelMsg;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tauri::Emitter;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::{self, Instant},
};

pub(crate) struct TerminalSession {
    control_tx: mpsc::UnboundedSender<TerminalControl>,
    task: Option<JoinHandle<()>>,
}

impl TerminalSession {
    fn close(&mut self) {
        let _ = self.control_tx.send(TerminalControl::Close);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.close();
    }
}

enum TerminalControl {
    Input(Vec<u8>),
    Resize { columns: u16, rows: u16 },
    Close,
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

struct SuRootAutomation {
    terminal_prompt_buffer: String,
    pending_root_password: String,
    root_password_sent: bool,
    pending_after_auth_input: Option<String>,
    delayed_after_auth_at: Option<Instant>,
}

impl SuRootAutomation {
    fn new(plan: &TerminalStartupPlan) -> Self {
        Self {
            terminal_prompt_buffer: String::new(),
            pending_root_password: plan.root_password.clone(),
            root_password_sent: false,
            pending_after_auth_input: if plan.after_auth_input.is_empty() {
                None
            } else {
                Some(plan.after_auth_input.clone())
            },
            delayed_after_auth_at: None,
        }
    }

    fn observe_output(&mut self, data: &str) -> Vec<Vec<u8>> {
        if self.pending_root_password.is_empty() && self.pending_after_auth_input.is_none() {
            return Vec::new();
        }

        self.terminal_prompt_buffer.push_str(data);
        if self.terminal_prompt_buffer.len() > 2048 {
            let split_at = self.terminal_prompt_buffer.len().saturating_sub(2048);
            self.terminal_prompt_buffer.drain(..split_at);
        }

        if self.root_password_sent
            && is_terminal_su_authentication_failure(&self.terminal_prompt_buffer)
        {
            self.pending_after_auth_input = None;
            self.delayed_after_auth_at = None;
            return Vec::new();
        }

        if self.root_password_sent && is_terminal_likely_root_prompt(&self.terminal_prompt_buffer) {
            return self.flush_after_auth_input();
        }

        if !self.root_password_sent
            && !self.pending_root_password.is_empty()
            && is_terminal_password_prompt(&self.terminal_prompt_buffer)
        {
            let password = std::mem::take(&mut self.pending_root_password);
            self.root_password_sent = true;
            self.delayed_after_auth_at = Some(Instant::now() + Duration::from_secs(4));
            return vec![format!("{password}\r").into_bytes()];
        }

        Vec::new()
    }

    fn flush_due_after_auth_input(&mut self) -> Vec<Vec<u8>> {
        if self
            .delayed_after_auth_at
            .is_none_or(|deadline| Instant::now() < deadline)
        {
            return Vec::new();
        }
        self.flush_after_auth_input()
    }

    fn flush_after_auth_input(&mut self) -> Vec<Vec<u8>> {
        self.delayed_after_auth_at = None;
        self.pending_after_auth_input
            .take()
            .map(|input| vec![input.into_bytes()])
            .unwrap_or_default()
    }
}

pub(crate) async fn start_terminal(
    state: AppState,
    window: tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    let connection_id = string_arg(&args, 0)?;
    let terminal_id = string_arg(&args, 1)?;
    validate_terminal_id(&terminal_id)?;
    let (columns, rows) = read_terminal_size(&args)?;
    let launch_options = read_terminal_launch_options(args.get(4))?;
    let connection = get_connection(&state, &connection_id)?;
    let terminal_key = terminal_key(&connection_id, &terminal_id);
    if state
        .terminals
        .lock()
        .map_err(error_string)?
        .contains_key(&terminal_key)
    {
        return Ok(json!(true));
    }

    let session = if connection.kind == ConnectionKind::Local {
        start_local_terminal_session(
            state.clone(),
            window,
            connection,
            connection_id.clone(),
            terminal_id.clone(),
            terminal_key.clone(),
            columns,
            rows,
            launch_options,
        )
        .await?
    } else {
        start_ssh_terminal_session(
            state.clone(),
            window,
            connection,
            connection_id.clone(),
            terminal_id.clone(),
            terminal_key.clone(),
            columns,
            rows,
            launch_options,
        )
        .await?
    };

    state
        .terminals
        .lock()
        .map_err(error_string)?
        .insert(terminal_key, session);
    Ok(json!(true))
}

#[allow(clippy::too_many_arguments)]
async fn start_ssh_terminal_session(
    state: AppState,
    window: tauri::Window,
    connection: ActiveConnection,
    connection_id: String,
    terminal_id: String,
    terminal_key: String,
    columns: u16,
    rows: u16,
    launch_options: TerminalLaunchOptions,
) -> Result<TerminalSession, String> {
    let profile = connection
        .ssh
        .clone()
        .ok_or_else(|| "SSH profile is unavailable.".to_string())?;
    let startup_plan = create_terminal_startup_plan(&connection, &launch_options);
    let (control_tx, mut control_rx) = mpsc::unbounded_channel();
    let terminals = state.terminals.clone();
    let initial_input = startup_plan.initial_input.clone();
    let mut automation = SuRootAutomation::new(&startup_plan);
    let (setup_tx, setup_rx) = oneshot::channel::<Result<(), String>>();

    let task =
        tokio::task::spawn_blocking(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = setup_tx.send(Err(error_string(error)));
                    return;
                }
            };
            let mut setup_tx = Some(setup_tx);
            let result = runtime.block_on(async {
            let mut session = connect_authenticated(
                Some(state.clone()),
                Some(UiWindowRef::from_window(&window)),
                profile,
            )
            .await?;
            let channel = session
                .handle()
                .channel_open_session()
                .await
                .map_err(|error| format!("SSH 终端通道打开失败：{error}"))?;
            channel
                .request_pty(
                    true,
                    "xterm-256color",
                    u32::from(columns),
                    u32::from(rows),
                    0,
                    0,
                    &[],
                )
                .await
                .map_err(|error| format!("SSH PTY 请求失败：{error}"))?;
            if should_launch_ssh_remote_shell(&connection, &launch_options) {
                let command = create_ssh_remote_shell_command(&launch_options);
                channel
                    .exec(true, command.as_bytes())
                    .await
                    .map_err(|error| format!("SSH 远程 Shell 启动失败：{error}"))?;
            } else {
                channel
                    .request_shell(true)
                    .await
                    .map_err(|error| format!("SSH 远程 Shell 启动失败：{error}"))?;
            }
            let (mut read_half, write_half) = channel.split();
            if let Some(sender) = setup_tx.take() {
                let _ = sender.send(Ok(()));
            }
            if !initial_input.is_empty() {
                let mut writer = write_half.make_writer();
                let _ = writer.write_all(initial_input.as_bytes()).await;
                let _ = writer.flush().await;
            }

            let mut exit_code: Option<i32> = None;
            let mut exit_signal: Option<String> = None;
            let mut automation_tick = time::interval(Duration::from_millis(250));
            loop {
                tokio::select! {
                    message = read_half.wait() => {
                        let Some(message) = message else {
                            break;
                        };
                        match message {
                            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                                let text = String::from_utf8_lossy(&data).to_string();
                                for input in automation.observe_output(&text) {
                                    let mut writer = write_half.make_writer();
                                    let _ = writer.write_all(&input).await;
                                    let _ = writer.flush().await;
                                }
                                emit_terminal_data(&window, &connection_id, &terminal_id, text);
                            }
                            ChannelMsg::ExitStatus { exit_status } => {
                                exit_code = Some(i32::try_from(exit_status).unwrap_or(-1));
                            }
                            ChannelMsg::ExitSignal { signal_name, .. } => {
                                exit_code = Some(-1);
                                exit_signal = Some(format!("{signal_name:?}"));
                            }
                            ChannelMsg::Close => break,
                            _ => {}
                        }
                    }
                    control = control_rx.recv() => {
                        match control {
                            Some(TerminalControl::Input(data)) => {
                                let mut writer = write_half.make_writer();
                                let _ = writer.write_all(&data).await;
                                let _ = writer.flush().await;
                            }
                            Some(TerminalControl::Resize { columns, rows }) => {
                                let _ = write_half
                                    .window_change(u32::from(columns), u32::from(rows), 0, 0)
                                    .await;
                            }
                            Some(TerminalControl::Close) | None => {
                                let _ = write_half.close().await;
                                break;
                            }
                        }
                    }
                    _ = automation_tick.tick() => {
                        for input in automation.flush_due_after_auth_input() {
                            let mut writer = write_half.make_writer();
                            let _ = writer.write_all(&input).await;
                            let _ = writer.flush().await;
                        }
                    }
                }
            }
            session.disconnect().await;
            emit_terminal_exit(&window, &connection_id, &terminal_id, exit_code, exit_signal);
            if let Ok(mut map) = terminals.lock() {
                map.remove(&terminal_key);
            }
            Ok::<(), String>(())
        });
            if let Err(error) = result {
                if let Some(sender) = setup_tx.take() {
                    let _ = sender.send(Err(error));
                }
            }
        });
    match setup_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(error),
        Err(_) => return Err("SSH 终端启动任务已结束。".to_string()),
    }

    Ok(TerminalSession {
        control_tx,
        task: Some(task),
    })
}

#[allow(clippy::too_many_arguments)]
async fn start_local_terminal_session(
    state: AppState,
    window: tauri::Window,
    connection: ActiveConnection,
    connection_id: String,
    terminal_id: String,
    terminal_key: String,
    _columns: u16,
    _rows: u16,
    launch_options: TerminalLaunchOptions,
) -> Result<TerminalSession, String> {
    let startup_plan = create_terminal_startup_plan(&connection, &launch_options);
    let mut command = local_terminal_command(&launch_options);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if !launch_options.working_directory.is_empty() {
        command.current_dir(PathBuf::from(&launch_options.working_directory));
    }
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    prevent_tokio_process_window(&mut command);
    let mut child = command.spawn().map_err(error_string)?;
    let mut child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "本地终端输入通道不可用。".to_string())?;
    let mut child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "本地终端输出通道不可用。".to_string())?;
    let mut child_stderr = child
        .stderr
        .take()
        .ok_or_else(|| "本地终端错误输出通道不可用。".to_string())?;
    let (control_tx, mut control_rx) = mpsc::unbounded_channel();
    let terminals = state.terminals.clone();
    let initial_input = startup_plan.initial_input.into_bytes();

    let task = tokio::spawn(async move {
        if !initial_input.is_empty() {
            let _ = child_stdin.write_all(&initial_input).await;
            let _ = child_stdin.flush().await;
        }

        let mut stdout_done = false;
        let mut stderr_done = false;
        let mut wait_done = false;
        let mut exit_code: Option<i32> = None;
        let mut stdout_buffer = [0_u8; 8192];
        let mut stderr_buffer = [0_u8; 8192];
        loop {
            if wait_done && stdout_done && stderr_done {
                break;
            }
            tokio::select! {
                control = control_rx.recv() => {
                    match control {
                        Some(TerminalControl::Input(data)) => {
                            let _ = child_stdin.write_all(&data).await;
                            let _ = child_stdin.flush().await;
                        }
                        Some(TerminalControl::Resize { .. }) => {}
                        Some(TerminalControl::Close) | None => {
                            let _ = child.kill().await;
                            break;
                        }
                    }
                }
                status = child.wait(), if !wait_done => {
                    wait_done = true;
                    exit_code = status.ok().and_then(|status| status.code());
                }
                read = child_stdout.read(&mut stdout_buffer), if !stdout_done => {
                    match read {
                        Ok(0) => stdout_done = true,
                        Ok(count) => emit_terminal_data(
                            &window,
                            &connection_id,
                            &terminal_id,
                            String::from_utf8_lossy(&stdout_buffer[..count]).to_string(),
                        ),
                        Err(_) => stdout_done = true,
                    }
                }
                read = child_stderr.read(&mut stderr_buffer), if !stderr_done => {
                    match read {
                        Ok(0) => stderr_done = true,
                        Ok(count) => emit_terminal_data(
                            &window,
                            &connection_id,
                            &terminal_id,
                            String::from_utf8_lossy(&stderr_buffer[..count]).to_string(),
                        ),
                        Err(_) => stderr_done = true,
                    }
                }
            }
        }
        emit_terminal_exit(&window, &connection_id, &terminal_id, exit_code, None);
        if let Ok(mut map) = terminals.lock() {
            map.remove(&terminal_key);
        }
    });

    Ok(TerminalSession {
        control_tx,
        task: Some(task),
    })
}

fn local_terminal_command(launch_options: &TerminalLaunchOptions) -> Command {
    let requested_shell = launch_options.shell.trim();
    if !requested_shell.is_empty() {
        return Command::new(requested_shell);
    }

    if cfg!(windows) {
        let startup_command = [
            "try { Remove-Module PSReadLine -ErrorAction SilentlyContinue } catch {}",
            "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
            "$OutputEncoding = [Console]::OutputEncoding",
        ]
        .join("; ");
        let mut cmd = Command::new("powershell.exe");
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
    let mut cmd = Command::new(shell);
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
    let remote_shell_launched = should_launch_ssh_remote_shell(connection, launch_options);

    if connection.kind == ConnectionKind::Ssh
        && !remote_shell_launched
        && !launch_options.working_directory.is_empty()
    {
        startup_lines.push(format!(
            "cd {}",
            quote_terminal_startup_directory(&launch_options.working_directory, system_type)
        ));
    }

    if connection.kind == ConnectionKind::Ssh
        && !remote_shell_launched
        && !launch_options.shell.is_empty()
    {
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

fn should_launch_ssh_remote_shell(
    connection: &ActiveConnection,
    launch_options: &TerminalLaunchOptions,
) -> bool {
    if connection.kind != ConnectionKind::Ssh || launch_options.working_directory.is_empty() {
        return false;
    }

    let system_type = connection
        .host
        .get("systemType")
        .and_then(Value::as_str)
        .unwrap_or("");
    if system_type == "windows" {
        return false;
    }

    !connection
        .privilege
        .as_ref()
        .is_some_and(|privilege| privilege.mode == "su-root" && !privilege.password.is_empty())
}

fn create_ssh_remote_shell_command(launch_options: &TerminalLaunchOptions) -> String {
    let shell = launch_options.shell.trim();
    let shell_command = if shell.is_empty() {
        "exec \"${SHELL:-/bin/sh}\" -l".to_string()
    } else {
        format!("exec {shell}")
    };
    format!(
        "cd {} && {}",
        quote_terminal_startup_directory(&launch_options.working_directory, "linux"),
        shell_command
    )
}

fn quote_terminal_startup_directory(directory: &str, system_type: &str) -> String {
    if system_type == "windows" {
        return format!("\"{}\"", directory.replace('"', "\"\""));
    }
    format!("'{}'", directory.replace('\'', "'\\''"))
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

fn emit_terminal_data(
    window: &tauri::Window,
    connection_id: &str,
    terminal_id: &str,
    data: String,
) {
    let _ = window.emit(
        "terminal:data",
        json!({
            "connectionId": connection_id,
            "terminalId": terminal_id,
            "data": data
        }),
    );
}

fn emit_terminal_exit(
    window: &tauri::Window,
    connection_id: &str,
    terminal_id: &str,
    code: Option<i32>,
    signal: Option<String>,
) {
    let _ = window.emit(
        "terminal:exit",
        json!({
            "connectionId": connection_id,
            "terminalId": terminal_id,
            "code": code,
            "signal": signal
        }),
    );
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
        .control_tx
        .send(TerminalControl::Resize { columns, rows })
        .map_err(|_| "终端尚未启动。".to_string())?;
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
        .control_tx
        .send(TerminalControl::Input(data.into_bytes()))
        .map_err(|_| "终端尚未启动。".to_string())?;
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
        .control_tx
        .send(TerminalControl::Input(bytes))
        .map_err(|_| "终端尚未启动。".to_string())?;
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
    use crate::test_helpers::active_ssh_connection;
    use serde_json::json;

    fn ssh_connection(
        system_type: &str,
        privilege: Option<crate::PrivilegeConfig>,
    ) -> ActiveConnection {
        let mut connection = active_ssh_connection(system_type, privilege);
        if let Some(profile) = connection.ssh.as_mut() {
            profile.username = "root".to_string();
        }
        connection
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
            "echo one\recho two\r"
        );
    }

    #[test]
    fn creates_ssh_remote_shell_command_for_working_directory() {
        let launch_options = TerminalLaunchOptions {
            shell: "bash".to_string(),
            initial_command: String::new(),
            working_directory: "/var/log/app's".to_string(),
        };

        assert_eq!(
            create_ssh_remote_shell_command(&launch_options),
            "cd '/var/log/app'\\''s' && exec bash"
        );
    }

    #[test]
    fn keeps_windows_remote_startup_input() {
        let connection = ssh_connection("windows", None);
        let launch_options = TerminalLaunchOptions {
            shell: "powershell".to_string(),
            initial_command: "Write-Host ok".to_string(),
            working_directory: r#"C:\Users\root"#.to_string(),
        };

        assert_eq!(
            create_terminal_startup_input(&connection, &launch_options),
            "cd \"C:\\Users\\root\"\rpowershell\rWrite-Host ok\r"
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
