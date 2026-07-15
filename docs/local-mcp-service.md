# Local MCP service and Skill export

ShellDesk can expose remote hosts saved in its local vault to AI clients running on the same machine. Enable it under **Settings > AI > MCP Service**.

## Endpoint and lifecycle

- Streamable HTTP endpoint: `http://127.0.0.1:38471/mcp`
- Health endpoint: `http://127.0.0.1:38471/health`
- The listener binds to the IPv4 loopback address only.
- `POST /mcp` requires `Content-Type: application/json` and rejects browser requests carrying an `Origin` header to prevent cross-origin pages from blindly triggering remote operations.
- The service starts automatically with ShellDesk when the saved switch is enabled and stops when the switch is disabled or the app exits.
- A port conflict is shown in Settings without preventing ShellDesk from starting.

The server implements `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. Notifications return HTTP 202; JSON-RPC requests return JSON.

## Tools

| Tool | Purpose |
| --- | --- |
| `shelldesk_list_hosts` | Return safe metadata for saved hosts without passwords, passphrases, or private keys. |
| `shelldesk_run_command` | Execute a command through the existing russh connection path. |
| `shelldesk_list_directory` | List a remote directory. |
| `shelldesk_read_file` | Read a UTF-8 text file up to 1 MiB. |
| `shelldesk_write_file` | Write a UTF-8 text file up to 1 MiB. |

Each operation resolves a host by the ID returned from `shelldesk_list_hosts`. It reuses an open ShellDesk connection when available; otherwise it creates a temporary connection using the saved proxy, jump host, authentication, privilege, and host-key settings. Unknown host keys and keyboard-interactive authentication continue to use ShellDesk's native confirmation UI.

## Skill ZIP

The **Export Skill (.zip)** action creates `shelldesk-remote-hosts.zip` with:

- `SKILL.md`
- `agents/openai.yaml` with the local MCP dependency
- `references/mcp-examples.md`
- `scripts/shelldesk_mcp_client.py`, a Python standard-library fallback client

The archive is generated from static templates and never includes the current host list, passwords, SSH private keys, key passphrases, or vault contents. The Settings page provides separate buttons for viewing MCP and Skill call examples before export.
