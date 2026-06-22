import { t, type AppLanguage } from '../../i18n';
import { powershellCommand, powershellSingleQuote } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import { getStateLabel, formatShortId } from './containerParsers';
import type { ContainerAction, ContainerConfigForm, ContainerDetail, ContainerRuntime, ContainerRunForm, ContainerSummary, ContainerTroubleshooting, ImagePruneMode, ImageSummary } from './containerTypes';
const CONTAINER_INSPECT_MARKER = '__SHELLDESK_CONTAINER_INSPECT__';
const CONTAINER_STATS_MARKER = '__SHELLDESK_CONTAINER_STATS__';
const CONTAINER_LOGS_MARKER = '__SHELLDESK_CONTAINER_LOGS__';
export function createContainerNameSuggestion(imageRef: string) {
  const imageName = imageRef
    .replace(/^sha256:/, '')
    .split('@')[0]
    .replace(/:[^/:]+$/u, '')
    .split('/')
    .filter(Boolean)
    .pop() || '';
  const normalizedName = imageName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return normalizedName ? `${normalizedName}-app` : '';
}
export function parseMultilineValues(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
export function parseContainerCliTokens(value: string, fieldLabel: string, language: AppLanguage) {
  const tokens: string[] = [];
  let currentToken = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const char of value.trim()) {
    if (escaping) {
      currentToken += char;
      escaping = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        currentToken += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = '';
      }
      continue;
    }
    currentToken += char;
  }
  if (escaping) {
    currentToken += '\\';
  }
  if (quote) {
    throw new Error(t('container.error.unclosedQuote', language, { field: fieldLabel }));
  }
  if (currentToken) {
    tokens.push(currentToken);
  }
  return tokens;
}
export function formatRuntimeCommand(runtime: ContainerRuntime, args: string[]) {
  return `${runtime} ${args.map(shellSingleQuote).join(' ')}`;
}
export function getRuntimeCliCommand(runtime: ContainerRuntime, args: string[], isWindowsHost: boolean) {
  if (isWindowsHost) {
    const powershellArgs = args.map(powershellSingleQuote).join(', ');
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$containerArgs = @(${powershellArgs})
& $runtime @containerArgs 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }
  return `${formatRuntimeCommand(runtime, args)} 2>&1`;
}
export function getRuntimeLabel(runtime: ContainerRuntime | null, language: AppLanguage) {
  if (runtime === 'docker') return 'Docker';
  if (runtime === 'podman') return 'Podman';
  return t('container.runtime.notDetected', language);
}
export function getImageReference(image: ImageSummary) {
  const hasRepository = image.repository && image.repository !== '<none>';
  const hasTag = image.tag && image.tag !== '<none>';
  if (hasRepository && hasTag) {
    return `${image.repository}:${image.tag}`;
  }
  if (hasRepository) {
    return image.repository;
  }
  return image.id;
}
export function getDetectRuntimeCommand(isWindowsHost: boolean, language: AppLanguage) {
  const noRuntime = t('container.error.noRuntime', language);
  if (isWindowsHost) {
    return powershellCommand(`
$docker = Get-Command docker -ErrorAction SilentlyContinue | Select-Object -First 1
if ($docker) { "docker"; exit 0 }
$podman = Get-Command podman -ErrorAction SilentlyContinue | Select-Object -First 1
if ($podman) { "podman"; exit 0 }
Write-Error "${noRuntime}"
exit 127
`);
  }
  return `
if command -v docker >/dev/null 2>&1; then
  printf 'docker\\n'
  exit 0
fi
if command -v podman >/dev/null 2>&1; then
  printf 'podman\\n'
  exit 0
fi
printf '${noRuntime}\\n' >&2
exit 127
`;
}
export function getContainerListCommand(runtime: ContainerRuntime, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
& $runtime ps -a --format '{{json .}}' 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }
  return `${runtime} ps -a --format '{{json .}}' 2>&1`;
}
export function getImageListCommand(runtime: ContainerRuntime, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
& $runtime images --format '{{json .}}' 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }
  return `${runtime} images --format '{{json .}}' 2>&1`;
}
export function getContainerDetailCommand(runtime: ContainerRuntime, containerId: string, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$target = ${powershellSingleQuote(containerId)}
"${CONTAINER_INSPECT_MARKER}"
& $runtime inspect $target 2>&1 | ForEach-Object { $_.ToString() }
"${CONTAINER_STATS_MARKER}"
& $runtime stats --no-stream --format '{{json .}}' $target 2>&1 | ForEach-Object { $_.ToString() }
"${CONTAINER_LOGS_MARKER}"
& $runtime logs --tail 200 $target 2>&1 | ForEach-Object { $_.ToString() }
exit 0
`);
  }
  return `
target=${shellSingleQuote(containerId)}
printf '${CONTAINER_INSPECT_MARKER}\\n'
${runtime} inspect "$target" 2>&1 || true
printf '${CONTAINER_STATS_MARKER}\\n'
${runtime} stats --no-stream --format '{{json .}}' "$target" 2>&1 || true
printf '${CONTAINER_LOGS_MARKER}\\n'
${runtime} logs --tail 200 "$target" 2>&1 || true
`;
}
export function getContainerActionCommand(runtime: ContainerRuntime, action: ContainerAction, containerId: string, isWindowsHost: boolean) {
  const runtimeAction = action === 'remove' ? 'rm' : action;
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$target = ${powershellSingleQuote(containerId)}
& $runtime ${runtimeAction} $target 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }
  return `${runtime} ${runtimeAction} ${shellSingleQuote(containerId)} 2>&1`;
}
export function buildContainerRunArgs(form: ContainerRunForm, language: AppLanguage) {
  const image = form.image.trim();
  if (!image) {
    throw new Error(t('container.error.imageRequired', language));
  }
  const args = [form.createOnly ? 'create' : 'run'];
  const name = form.name.trim();
  const network = form.networkMode === 'custom' ? form.network.trim() : form.networkMode === 'default' ? '' : form.networkMode;
  const hostname = form.hostname.trim();
  const workdir = form.workdir.trim();
  const user = form.user.trim();
  if (form.networkMode === 'custom' && !network) {
    throw new Error(t('container.error.customNetworkRequired', language));
  }
  if (!form.createOnly) {
    args.push('-d');
  }
  if (!form.createOnly && form.removeWhenStopped) {
    args.push('--rm');
  }
  if (name) {
    args.push('--name', name);
  }
  if (form.restartPolicy !== 'no' && (form.createOnly || !form.removeWhenStopped)) {
    args.push('--restart', form.restartPolicy);
  }
  if (network) {
    args.push('--network', network);
  }
  if (hostname) {
    args.push('--hostname', hostname);
  }
  if (workdir) {
    args.push('-w', workdir);
  }
  if (user) {
    args.push('-u', user);
  }
  parseMultilineValues(form.ports).forEach((port) => args.push('-p', port));
  parseMultilineValues(form.volumes).forEach((volume) => args.push('-v', volume));
  parseMultilineValues(form.environment).forEach((env) => args.push('-e', env));
  args.push(...parseContainerCliTokens(form.extraArgs, t('container.ui.extraArgs', language), language));
  args.push(image);
  args.push(...parseContainerCliTokens(form.command, t('container.ui.command', language), language));
  return args;
}
export function buildImagePruneArgs(mode: ImagePruneMode) {
  const args = ['image', 'prune', '--force'];
  if (mode === 'unused') {
    args.push('--all');
  }
  return args;
}
export function buildContainerConfigCommandGroups(containerId: string, form: ContainerConfigForm, detail: ContainerDetail, language: AppLanguage) {
  const groups: string[][] = [];
  const nextName = form.name.trim();
  const cpuLimit = form.cpuLimit.trim();
  const memoryLimit = form.memoryLimit.trim();
  const currentRestartPolicy = detail.config.restartPolicy;
  const updateArgs = ['update'];
  if (nextName && nextName !== detail.name) {
    if (/\s/u.test(nextName)) {
      throw new Error(t('container.error.invalidContainerName', language));
    }
    groups.push(['rename', containerId, nextName]);
  }
  if (form.restartPolicy !== currentRestartPolicy) {
    updateArgs.push('--restart', form.restartPolicy);
  }
  if (cpuLimit) {
    updateArgs.push('--cpus', cpuLimit);
  }
  if (memoryLimit) {
    updateArgs.push('--memory', memoryLimit);
  }
  if (updateArgs.length > 1) {
    updateArgs.push(containerId);
    groups.push(updateArgs);
  }
  if (groups.length === 0) {
    throw new Error(t('container.error.noConfigChange', language));
  }
  return groups;
}
export function getContainerConfigUpdateCommand(runtime: ContainerRuntime, commandGroups: string[][], isWindowsHost: boolean) {
  if (isWindowsHost) {
    const powershellGroups = commandGroups
      .map((group) => `, @(${group.map(powershellSingleQuote).join(', ')})`)
      .join('\n');
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$commandGroups = @(
${powershellGroups}
)
foreach ($containerArgs in $commandGroups) {
  & $runtime @containerArgs 2>&1 | ForEach-Object { $_.ToString() }
  $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
  if ($exitCode -ne 0) { exit $exitCode }
}
exit 0
`);
  }
  return [
    'set -e',
    ...commandGroups.map((args) => `${formatRuntimeCommand(runtime, args)} 2>&1`),
  ].join('\n');
}
export function getImagePullCommand(runtime: ContainerRuntime, imageName: string, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$image = ${powershellSingleQuote(imageName)}
& $runtime pull $image 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }
  return `${runtime} pull ${shellSingleQuote(imageName)} 2>&1`;
}
export function getImageRemoveCommand(runtime: ContainerRuntime, imageRef: string, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$image = ${powershellSingleQuote(imageRef)}
& $runtime rmi $image 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }
  return `${runtime} rmi ${shellSingleQuote(imageRef)} 2>&1`;
}
export function getContainerExecCommand(runtime: ContainerRuntime, containerId: string, command: string, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
$target = ${powershellSingleQuote(containerId)}
$execCommand = ${powershellSingleQuote(command)}
& $runtime exec $target sh -lc $execCommand 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }
  return `${runtime} exec ${shellSingleQuote(containerId)} sh -lc ${shellSingleQuote(command)} 2>&1`;
}
export function matchesContainerQuery(container: ContainerSummary, query: string) {
  if (!query) {
    return true;
  }
  const normalizedQuery = query.toLowerCase();
  const searchableText = [
    container.id,
    container.name,
    container.image,
    container.command,
    container.status,
    container.ports,
  ].filter(Boolean).join(' ').toLowerCase();
  return searchableText.includes(normalizedQuery);
}
export function matchesImageQuery(image: ImageSummary, query: string) {
  if (!query) {
    return true;
  }
  const normalizedQuery = query.toLowerCase();
  return [image.id, image.repository, image.tag, image.size, image.createdAt]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(normalizedQuery);
}
export function buildContainerDiagnostics(detail: ContainerDetail, language: AppLanguage) {
  return [
    t('container.diagnostics.container', language, { name: detail.name }),
    `ID：${detail.id}`,
    t('container.diagnostics.image', language, { image: detail.image }),
    t('container.diagnostics.status', language, { state: getStateLabel(detail.state, language), status: detail.status || '-' }),
    t('container.diagnostics.created', language, { created: detail.createdAt || '-' }),
    `CPU：${detail.stats?.cpu || '-'}`,
    t('container.diagnostics.memory', language, { memory: detail.stats?.memory || '-', percent: detail.stats?.memoryPercent || '-' }),
    '',
    '--- ports ---',
    detail.ports.join('\n') || t('container.diagnostics.noPorts', language),
    '',
    '--- mounts ---',
    detail.mounts.join('\n') || t('container.diagnostics.noMounts', language),
    '',
    '--- logs ---',
    detail.logs || t('container.diagnostics.noLogs', language),
  ].join('\n');
}
export function buildDockerDaemonRestartCommand(language: AppLanguage) {
  return [
    t('container.restart.warning', language),
    'set -e',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  if [ "$(id -u)" -eq 0 ]; then',
    '    systemctl restart docker',
    '  else',
    '    sudo systemctl restart docker',
    '  fi',
    'else',
    '  if [ "$(id -u)" -eq 0 ]; then',
    '    service docker restart',
    '  else',
    '    sudo service docker restart',
    '  fi',
    'fi',
  ].join('\n');
}
export function buildDockerRestartCommand(containerId: string, language: AppLanguage) {
  const target = shellSingleQuote(containerId);
  return [
    buildDockerDaemonRestartCommand(language),
    `docker start ${target}`,
  ].join('\n');
}
export function isDockerNetworkTrouble(output: string, runtime: ContainerRuntime) {
  return (
    runtime === 'docker' &&
    /iptables/i.test(output) &&
    /\bDOCKER\b/.test(output) &&
    /No chain\/target\/match by that name/i.test(output)
  );
}
export function createDockerNetworkTroubleshooting(output: string, commands: string, language: AppLanguage): ContainerTroubleshooting {
  return {
    title: t('container.troubleshooting.title', language),
    message: t('container.troubleshooting.message', language),
    commands,
    rawOutput: output,
  };
}
export function createContainerTroubleshooting(
  output: string,
  runtime: ContainerRuntime,
  action: ContainerAction,
  container: ContainerSummary,
  language: AppLanguage,
): ContainerTroubleshooting | null {
  if ((action !== 'start' && action !== 'restart') || !isDockerNetworkTrouble(output, runtime)) {
    return null;
  }
  return createDockerNetworkTroubleshooting(output, buildDockerRestartCommand(container.id, language), language);
}
