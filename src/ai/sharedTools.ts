export const SHARED_TOOL_DESCRIPTIONS = `
You have access to the following tools via the remote host:
- run_command: Execute a shell command on the remote host
- read_file: Read a file from the remote host
- write_file: Write content to a file on the remote host
- list_dir: List directory contents on the remote host
- search_files: Search for files or content on the remote host
`;

export function formatToolResult(result: { stdout?: string; stderr?: string; code?: number }): string {
  const parts: string[] = [];

  if (result.stdout) {
    parts.push(`stdout:\n${result.stdout}`);
  }

  if (result.stderr) {
    parts.push(`stderr:\n${result.stderr}`);
  }

  if (result.code !== undefined && result.code !== 0) {
    parts.push(`exit code: ${result.code}`);
  }

  return parts.join('\n\n') || '(no output)';
}

export async function executeForAi(connectionId: string, command: string): Promise<string> {
  const api = window.guiSSH?.connections;

  if (!api) {
    return 'Error: ShellDesk IPC not available';
  }

  try {
    const result = await api.runCommand(connectionId, command);
    return formatToolResult(result);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
