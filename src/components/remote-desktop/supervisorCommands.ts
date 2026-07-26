import type { RemoteCommandInput } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import type { SupervisorAction, SupervisorLogStream } from './supervisorTypes';

const commonConfigFiles = [
  '/etc/supervisor/supervisord.conf',
  '/etc/supervisord.conf',
  '/usr/local/etc/supervisord.conf',
  '/opt/homebrew/etc/supervisord.conf',
];

const commonConfigDirectories = [
  '/etc/supervisor/conf.d',
  '/etc/supervisord.d',
  '/usr/local/etc/supervisor.d',
  '/opt/homebrew/etc/supervisor.d',
];

function command(value: string): RemoteCommandInput {
  return { command: value };
}

function quoteArguments(values: string[]) {
  return values.map(shellSingleQuote).join(' ');
}

export function createSupervisorDetectCommand(): RemoteCommandInput {
  const fileCandidates = commonConfigFiles.map(shellSingleQuote).join(' ');
  const directoryCandidates = commonConfigDirectories.map(shellSingleQuote).join(' ');

  return command(`
if ! command -v supervisorctl >/dev/null 2>&1; then
  echo "installed=false"
  exit 0
fi

echo "installed=true"
echo "executable=$(command -v supervisorctl)"
SUPERVISOR_VERSION="$(supervisord --version 2>/dev/null | head -n 1)"
if [ -z "$SUPERVISOR_VERSION" ]; then
  SUPERVISOR_VERSION="$(supervisorctl version 2>/dev/null | head -n 1)"
fi
echo "version=$SUPERVISOR_VERSION"

SUPERVISOR_PID="$(supervisorctl pid 2>&1)"
SUPERVISOR_PID_CODE=$?
if [ "$SUPERVISOR_PID_CODE" -eq 0 ] && printf '%s' "$SUPERVISOR_PID" | grep -Eq '^[0-9]+$'; then
  echo "running=true"
  echo "statusMessage="
else
  echo "running=false"
  echo "statusMessage=$(printf '%s' "$SUPERVISOR_PID" | head -n 1)"
fi

{
  for candidate in ${fileCandidates}; do
    [ -f "$candidate" ] && printf '%s\\n' "$candidate"
  done
  for directory in ${directoryCandidates}; do
    if [ -d "$directory" ]; then
      find "$directory" -maxdepth 1 -type f \\( -name '*.conf' -o -name '*.ini' \\) -print 2>/dev/null
    fi
  done
} | awk 'NF && !seen[$0]++ { print "config=" $0 }'
`);
}

export function createSupervisorStatusCommand(): RemoteCommandInput {
  return command('supervisorctl status 2>&1');
}

export function createSupervisorActionCommand(action: SupervisorAction, targets: string[] = []): RemoteCommandInput {
  if (action === 'reload') {
    return command('supervisorctl reload 2>&1');
  }

  const safeTargets = targets.map((target) => target.trim()).filter(Boolean).slice(0, 100);
  if (safeTargets.length === 0) {
    throw new Error('Supervisor action requires at least one process.');
  }

  return command(`supervisorctl ${action} ${quoteArguments(safeTargets)} 2>&1`);
}

export function createSupervisorLogCommand(target: string, stream: SupervisorLogStream): RemoteCommandInput {
  return command(`supervisorctl tail ${shellSingleQuote(target.trim())} ${stream} 2>&1`);
}

export function createSupervisorReadConfigCommand(path: string): RemoteCommandInput {
  return command(`head -n 600 ${shellSingleQuote(path.trim())} 2>&1`);
}
