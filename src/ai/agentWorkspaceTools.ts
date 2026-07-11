import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export type AgentWorkspaceHost = Pick<
  ShellDeskHostConnectionRequest,
  | 'id'
  | 'name'
  | 'address'
  | 'port'
  | 'username'
  | 'authMethod'
  | 'password'
  | 'keyId'
  | 'keyPath'
  | 'passphrase'
  | 'privilegeMode'
  | 'rootPassword'
  | 'jumpHostId'
  | 'proxyProfileId'
  | 'keepaliveEnabled'
  | 'keepaliveIntervalMs'
  | 'systemType'
  | 'systemName'
> & {
  id: string;
  group: string;
  lastConnectionStatus: string;
};

export interface AgentWorkspaceConnectionResult {
  host: AgentWorkspaceHost;
  connection?: ShellDeskConnectionInfo;
  error?: string;
}

interface AgentWorkspaceToolsOptions {
  getHosts: () => AgentWorkspaceHost[];
  getSelectedHostIds: () => string[];
  connectHosts: (hostIds: string[]) => Promise<AgentWorkspaceConnectionResult[]>;
}

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: {},
  };
}

function hostLabel(host: AgentWorkspaceHost) {
  return host.name.trim() || `${host.username}@${host.address}`;
}

function resolveHosts(rawTargets: string | undefined, options: AgentWorkspaceToolsOptions) {
  const hosts = options.getHosts();
  const tokens = (rawTargets?.split(',').map((value) => value.trim()).filter(Boolean) ?? []);
  const selectedIds = options.getSelectedHostIds();
  const requestedTargets = tokens.length ? tokens : selectedIds;

  if (!requestedTargets.length) {
    return { hosts: [] as AgentWorkspaceHost[], error: 'No hosts specified. Call list_shelldesk_hosts first, or select one or more hosts in the workspace.' };
  }

  const matchedHosts: AgentWorkspaceHost[] = [];
  const unknownTargets: string[] = [];
  for (const target of requestedTargets) {
    const normalized = target.toLocaleLowerCase();
    const host = hosts.find((candidate) => (
      candidate.id === target
      || candidate.name.toLocaleLowerCase() === normalized
      || candidate.address.toLocaleLowerCase() === normalized
    ));
    if (!host) {
      unknownTargets.push(target);
    } else if (!matchedHosts.some((candidate) => candidate.id === host.id)) {
      matchedHosts.push(host);
    }
  }

  return {
    hosts: matchedHosts,
    error: unknownTargets.length ? `Unknown host target(s): ${unknownTargets.join(', ')}` : '',
  };
}

function createListHostsTool(options: AgentWorkspaceToolsOptions): AgentTool {
  return {
    name: 'list_shelldesk_hosts',
    label: 'List ShellDesk hosts',
    description: 'List saved ShellDesk hosts. Returns safe identity and endpoint metadata only; never returns credentials.',
    parameters: Type.Object({}),
    execute: async () => {
      const hosts = options.getHosts();
      if (!hosts.length) {
        return textResult('No saved ShellDesk hosts are available.');
      }

      const text = hosts.map((host) => [
        `id: ${host.id}`,
        `name: ${hostLabel(host)}`,
        `endpoint: ${host.username ? `${host.username}@` : ''}${host.address}:${host.port}`,
        `system: ${host.systemName || host.systemType || 'unknown'}`,
        `group: ${host.group || '-'}`,
      ].join(' | ')).join('\n');
      return textResult(text);
    },
    executionMode: 'sequential',
  };
}

function createRunCommandOnHostsTool(options: AgentWorkspaceToolsOptions): AgentTool {
  return {
    name: 'run_command_on_hosts',
    label: 'Run command on hosts',
    description: 'Connect to one or more saved ShellDesk hosts and run the same shell command concurrently. Omit targets to use the hosts currently selected in the workspace. For explicit targets, provide comma-separated host IDs, names, or addresses.',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to run on every target host.' }),
      targets: Type.Optional(Type.String({ description: 'Optional comma-separated host IDs, names, or addresses.' })),
    }),
    execute: async (_toolCallId, params) => {
      const values = params as { command?: string; targets?: string };
      const command = values.command?.trim();
      if (!command) {
        return textResult('Error: command is required.');
      }

      const resolved = resolveHosts(values.targets, options);
      if (resolved.error || !resolved.hosts.length) {
        return textResult(`Error: ${resolved.error || 'No matching hosts.'}`);
      }

      const connections = await options.connectHosts(resolved.hosts.map((host) => host.id));
      const api = window.guiSSH?.connections;
      const results = await Promise.all(connections.map(async (result) => {
        if (!result.connection) {
          return `${hostLabel(result.host)}\nERROR: ${result.error || 'Connection failed.'}`;
        }
        if (!api?.runCommand) {
          return `${hostLabel(result.host)}\nERROR: ShellDesk command API is unavailable.`;
        }
        try {
          const response = await api.runCommand(result.connection.id, command);
          return `${hostLabel(result.host)} (${result.host.address})\nexit code: ${response.code}\n${response.stdout || response.stderr || '(no output)'}`;
        } catch (error) {
          return `${hostLabel(result.host)}\nERROR: ${error instanceof Error ? error.message : String(error)}`;
        }
      }));

      return textResult(results.join('\n\n---\n\n'));
    },
    executionMode: 'sequential',
  };
}

export function createAgentWorkspaceTools(options: AgentWorkspaceToolsOptions): AgentTool[] {
  return [createListHostsTool(options), createRunCommandOnHostsTool(options)];
}
