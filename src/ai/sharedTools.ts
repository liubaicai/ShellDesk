import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AiToolDetails } from './types';

const DEFAULT_MAX_OUTPUT_LENGTH = 50000;

export const SHARED_TOOL_DEFINITIONS = [
  {
    name: 'run_command',
    description: 'Execute a shell command on the connected remote host.',
  },
  {
    name: 'read_file',
    description: 'Read a text file from the connected remote host.',
  },
  {
    name: 'write_file',
    description: 'Write text content to a file on the connected remote host.',
  },
  {
    name: 'list_dir',
    description: 'List directory contents on the connected remote host.',
  },
  {
    name: 'search_files',
    description: 'Search file names or file contents on the connected remote host.',
  },
] as const;

interface RunCommandParams {
  command: string;
}

interface PathParams {
  path: string;
}

interface WriteFileParams {
  path: string;
  content: string;
}

interface SearchFilesParams {
  path: string;
  query: string;
  mode?: 'content' | 'name';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toBase64(value: string): string {
  return btoa(unescape(encodeURIComponent(value)));
}

function truncateOutput(output: string, maxOutputLength = DEFAULT_MAX_OUTPUT_LENGTH): string {
  if (output.length <= maxOutputLength) {
    return output;
  }

  return `${output.slice(0, maxOutputLength)}\n\n[Output truncated at ${maxOutputLength} characters]`;
}

export function formatToolResult(result: { stdout?: string; stderr?: string; code?: number }, maxOutputLength = DEFAULT_MAX_OUTPUT_LENGTH): string {
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

  return truncateOutput(parts.join('\n\n') || '(no output)', maxOutputLength);
}

async function runRemoteCommand(
  connectionId: string | undefined,
  command: string,
): Promise<{ text: string; details: AiToolDetails }> {
  if (!connectionId) {
    return {
      text: 'Error: no remote connection is available for this tool.',
      details: { command },
    };
  }

  const api = window.guiSSH?.connections;

  if (!api?.runCommand) {
    return {
      text: 'Error: ShellDesk IPC is not available.',
      details: { command },
    };
  }

  try {
    const result = await api.runCommand(connectionId, command);

    return {
      text: formatToolResult(result),
      details: { command, exitCode: result.code, stderr: result.stderr },
    };
  } catch (error) {
    return {
      text: truncateOutput(`Error: ${error instanceof Error ? error.message : String(error)}`),
      details: { command },
    };
  }
}

function textResult(text: string, details: AiToolDetails = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

export function createSharedTools(connectionId?: string): AgentTool[] {
  return [
    {
      name: 'run_command',
      label: 'Run command',
      description: 'Execute a shell command on the connected remote host.',
      parameters: Type.Object({
        command: Type.String({ description: 'Shell command to execute.' }),
      }),
      execute: async (_toolCallId, params) => {
        const { command } = params as RunCommandParams;
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
    {
      name: 'read_file',
      label: 'Read file',
      description: 'Read a text file from the connected remote host using cat.',
      parameters: Type.Object({
        path: Type.String({ description: 'Absolute or relative file path to read.' }),
      }),
      execute: async (_toolCallId, params) => {
        const { path } = params as PathParams;
        const command = `cat -- ${shellQuote(path)}`;
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
    {
      name: 'write_file',
      label: 'Write file',
      description: 'Write UTF-8 text content to a remote file. Path and content are base64-encoded before reaching the shell.',
      parameters: Type.Object({
        path: Type.String({ description: 'Absolute or relative file path to write.' }),
        content: Type.String({ description: 'UTF-8 text content to write.' }),
      }),
      execute: async (_toolCallId, params) => {
        const { path, content } = params as WriteFileParams;
        const encodedPath = toBase64(path);
        const encodedContent = toBase64(content);
        const command = [
          'python3 - <<\'PY\'',
          'import base64',
          'import pathlib',
          `path = pathlib.Path(base64.b64decode(${JSON.stringify(encodedPath)}).decode("utf-8"))`,
          `content = base64.b64decode(${JSON.stringify(encodedContent)})`,
          'if path.parent != pathlib.Path("."):',
          '    path.parent.mkdir(parents=True, exist_ok=True)',
          'path.write_bytes(content)',
          'print(f"wrote {len(content)} bytes to {path}")',
          'PY',
        ].join('\n');
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
    {
      name: 'list_dir',
      label: 'List directory',
      description: 'List directory contents on the connected remote host using ls -la.',
      parameters: Type.Object({
        path: Type.String({ description: 'Directory path to list.' }),
      }),
      execute: async (_toolCallId, params) => {
        const { path } = params as PathParams;
        const command = `ls -la -- ${shellQuote(path)}`;
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
    {
      name: 'search_files',
      label: 'Search files',
      description: 'Search file names with find or file contents with grep on the connected remote host.',
      parameters: Type.Object({
        path: Type.String({ description: 'Directory path to search.' }),
        query: Type.String({ description: 'Search query.' }),
        mode: Type.Optional(Type.Union([
          Type.Literal('content'),
          Type.Literal('name'),
        ], { description: 'Use content for grep -rn or name for find -iname.' })),
      }),
      execute: async (_toolCallId, params) => {
        const { path, query, mode = 'content' } = params as SearchFilesParams;
        const command = mode === 'name'
          ? `find ${shellQuote(path)} -iname ${shellQuote(`*${query}*`)} -print`
          : `grep -rn -- ${shellQuote(query)} ${shellQuote(path)}`;
        const result = await runRemoteCommand(connectionId, command);
        return textResult(result.text, result.details);
      },
      executionMode: 'sequential',
    },
  ];
}

export async function executeForAi(connectionId: string, command: string): Promise<string> {
  const result = await runRemoteCommand(connectionId, command);
  return result.text;
}
