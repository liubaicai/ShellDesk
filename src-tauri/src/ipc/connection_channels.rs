#[path = "database_channels.rs"]
mod database_channels;

use crate::{
    browser_proxy, connection, connection_monitor, http_tunnel, remote_fs, run_connection_command,
    run_connection_command_stream, terminal, vnc, zmodem, AppState,
};
use serde_json::{json, Value};
use tauri::Manager;

pub(crate) async fn dispatch(
    state: &AppState,
    window: tauri::Window,
    channel: &str,
    args: Vec<Value>,
) -> Option<Result<Value, String>> {
    if database_channels::is_database_channel(channel) {
        return database_channels::dispatch(state, &window, channel, args).await;
    }

    let result = match channel {
        "connection:connect" => connection::connect_ssh(state, &window, args).await,
        "connection:open-local" => connection::open_local_connection(state),
        "connection:host-key-response" => {
            connection::respond_host_key_verification(state, window.app_handle(), args)
        }
        "connection:keyboard-interactive-response" => {
            connection::respond_keyboard_interactive(state, args)
        }
        "connection:trust-browser-certificate" => {
            connection::trust_browser_certificate(state, args)
        }
        "connection:browser-resolve-url" => {
            browser_proxy::browser_resolve_url(state, &window, args).await
        }
        "connection:get-ipc-capabilities" => {
            Ok(json!({ "terminalSessions": true, "terminalBinary": true }))
        }
        "connection:disconnect" => connection::disconnect_connection(state, &window, args),
        "connection:get-info" => connection::get_connection_info(state, args),
        "connection:get-status" => connection_monitor::get_connection_status(state, args).await,
        "connection:get-system-info" => {
            connection_monitor::get_connection_system_info(state, args).await
        }
        "connection:get-metrics" => connection_monitor::get_connection_metrics(state, args).await,
        "connection:start-terminal" => terminal::start_terminal(state, window, args).await,
        "connection:write-terminal" => terminal::write_terminal(state, args),
        "connection:write-terminal-binary" => terminal::write_terminal_bytes(state, args),
        "connection:resize-terminal" => terminal::resize_terminal(state, args),
        "connection:close-terminal" => terminal::close_terminal(state, args),
        "connection:run-command" => run_connection_command(state, args).await,
        "connection:run-command-stream" => run_connection_command_stream(state, window, args).await,
        "connection:http-tunnel-get" => http_tunnel::get(state, &window, args).await,
        "connection:http-tunnel-post" => http_tunnel::post(state, &window, args).await,
        "connection:http-tunnel-put" => http_tunnel::put(state, &window, args).await,
        "connection:http-tunnel-delete" => http_tunnel::delete(state, &window, args).await,
        "connection:list-directory" => remote_fs::list_connection_directory(state, args).await,
        "connection:stat-path" => remote_fs::stat_connection_path(state, args).await,
        "connection:read-file" => remote_fs::read_connection_file(state, args).await,
        "connection:write-file" => remote_fs::write_connection_file(state, args).await,
        "connection:create-directory" => remote_fs::create_connection_directory(state, args).await,
        "connection:create-file" => remote_fs::create_connection_file(state, args).await,
        "connection:delete-path" => remote_fs::delete_connection_path(state, args).await,
        "connection:rename-path" => remote_fs::rename_connection_path(state, args).await,
        "connection:set-path-permissions" => {
            remote_fs::set_connection_path_permissions(state, args).await
        }
        "connection:check-sftp" => remote_fs::check_connection_sftp(state, args).await,
        "connection:select-upload-files" => remote_fs::select_upload_items(false),
        "connection:select-upload-folders" => remote_fs::select_upload_items(true),
        "connection:download-file" => {
            remote_fs::download_connection_file(state, &window, args).await
        }
        "connection:download-paths" => {
            remote_fs::download_connection_paths(state, &window, args).await
        }
        "connection:upload-local-paths" => {
            remote_fs::upload_connection_paths(state, &window, args).await
        }
        "connection:upload-file" => {
            remote_fs::upload_selected_paths(state, &window, args, false, false).await
        }
        "connection:upload-files" => {
            remote_fs::upload_selected_paths(state, &window, args, false, true).await
        }
        "connection:upload-paths" => {
            remote_fs::upload_selected_paths(state, &window, args, true, true).await
        }
        "connection:cancel-transfer" => remote_fs::cancel_transfer(state, args),
        "connection:compress" => remote_fs::compress_connection_paths(state, args).await,
        "connection:decompress" => remote_fs::decompress_connection_archive(state, args).await,
        "connection:zmodem-select-upload-files" => zmodem::select_zmodem_upload_files(state),
        "connection:zmodem-read-upload-file" => zmodem::read_zmodem_upload_file(state, args),
        "connection:zmodem-release-upload-files" => {
            zmodem::release_zmodem_upload_files(state, args)
        }
        "connection:zmodem-save-file" => zmodem::save_zmodem_file(args),
        "connection:vnc-probe" => vnc::probe(state, &window, args).await,
        "connection:vnc-start" => vnc::start(state, &window, args).await,
        "connection:vnc-stop" => vnc::stop(state, args),
        _ => return None,
    };

    Some(result)
}
