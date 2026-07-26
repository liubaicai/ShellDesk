import type { SupervisorProcess, SupervisorProcessState, SupervisorRuntime } from './supervisorTypes';

const knownStates = new Map<string, SupervisorProcessState>([
  ['RUNNING', 'running'],
  ['STARTING', 'starting'],
  ['STOPPING', 'stopping'],
  ['STOPPED', 'stopped'],
  ['EXITED', 'exited'],
  ['FATAL', 'fatal'],
  ['BACKOFF', 'backoff'],
  ['UNKNOWN', 'unknown'],
]);

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/gu, '');
}

function parseKeyValues(stdout: string) {
  const values = new Map<string, string[]>();

  stripAnsi(stdout).split(/\r?\n/u).forEach((rawLine) => {
    const line = rawLine.trim();
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      return;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1).trim();
    values.set(key, [...(values.get(key) ?? []), value]);
  });

  return values;
}

export function parseSupervisorDetectOutput(stdout: string): SupervisorRuntime {
  const values = parseKeyValues(stdout);

  return {
    installed: values.get('installed')?.[0] === 'true',
    executable: values.get('executable')?.[0] ?? '',
    version: values.get('version')?.[0] ?? '',
    running: values.get('running')?.[0] === 'true',
    statusMessage: values.get('statusMessage')?.[0] ?? '',
    configFiles: [...new Set(values.get('config') ?? [])],
  };
}

export function parseSupervisorStatusOutput(stdout: string): SupervisorProcess[] {
  return stripAnsi(stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): SupervisorProcess[] => {
      const match = /^(\S+)\s+([A-Z]+)(?:\s+(.*))?$/u.exec(line);
      if (!match) {
        return [];
      }

      const [, name, rawState, rawDescription = ''] = match;
      const state = knownStates.get(rawState);
      if (!state) {
        return [];
      }

      const groupSeparator = name.indexOf(':');
      const pidMatch = /\bpid\s+(\d+)/iu.exec(rawDescription);
      const uptimeMatch = /\buptime\s+(.+)$/iu.exec(rawDescription);

      return [{
        name,
        group: groupSeparator > 0 ? name.slice(0, groupSeparator) : '',
        processName: groupSeparator > 0 ? name.slice(groupSeparator + 1) : name,
        state,
        pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
        uptime: uptimeMatch?.[1]?.trim() ?? '',
        description: rawDescription.trim(),
      }];
    });
}

export function parseSupervisorTextOutput(stdout: string) {
  return stripAnsi(stdout).trim();
}
