import { t, type AppLanguage } from '../../i18n';
import { powershellCommand, powershellSingleQuote } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import { getStateLabel, formatShortId } from './containerParsers';
import type {
  ComposeProjectAction,
  ComposeProjectSummary,
  ContainerAction,
  ContainerComposeForm,
  ContainerConfigForm,
  ContainerDetail,
  ContainerNetworkSummary,
  ContainerNetworkForm,
  ContainerRuntime,
  ContainerRunForm,
  ContainerSummary,
  ContainerTroubleshooting,
  ContainerVolumeForm,
  ContainerVolumeSummary,
  ImagePruneMode,
  ImageSummary,
} from './containerTypes';
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
export function getComposeListCommand(runtime: ContainerRuntime, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
& $runtime compose ls --format json 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -Variable composeOutput
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
if ($exitCode -ne 0 -and $runtime -eq "podman") {
  $errorText = ($composeOutput | ForEach-Object { $_.ToString() }) -join "\n"
  if ($errorText -match "invalid choice: 'ls'" -or $errorText -match "podman-compose") {
    & $runtime ps -a --format '{{json .}}' 2>&1 | ForEach-Object { $_.ToString() }
    $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
  }
}
exit $exitCode
`);
  }
  if (runtime === 'podman') {
    return `
compose_output="$(${runtime} compose ls --format json 2>&1)"
compose_code=$?
if [ "$compose_code" -eq 0 ]; then
  printf '%s\\n' "$compose_output"
  exit 0
fi
case "$compose_output" in
  *"invalid choice: 'ls'"*|*"podman-compose"*)
    ${runtime} ps -a --format '{{json .}}' 2>&1
    exit $?
    ;;
  *)
    printf '%s\\n' "$compose_output" >&2
    exit "$compose_code"
    ;;
esac
`;
  }
  return `${runtime} compose ls --format json 2>&1`;
}
export function getNetworkListCommand(runtime: ContainerRuntime, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
& $runtime network ls --format '{{json .}}' 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }
  return `${runtime} network ls --format '{{json .}}' 2>&1`;
}
export function getVolumeListCommand(runtime: ContainerRuntime, isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$runtime = ${powershellSingleQuote(runtime)}
& $runtime volume ls --format '{{json .}}' 2>&1 | ForEach-Object { $_.ToString() }
$exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
exit $exitCode
`);
  }
  return `${runtime} volume ls --format '{{json .}}' 2>&1`;
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
export function getContainerLogsCommand(runtime: ContainerRuntime, containerId: string, isWindowsHost: boolean, tail = 200, sinceSeconds?: number) {
  const args = ['logs', '--tail', String(Math.max(1, Math.min(tail, 1000)))];
  if (sinceSeconds && sinceSeconds > 0) {
    args.push('--since', `${Math.max(1, Math.min(sinceSeconds, 3600))}s`);
  }
  args.push(containerId);
  return getRuntimeCliCommand(runtime, args, isWindowsHost);
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
  if (form.privileged) {
    args.push('--privileged');
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
function assertCliName(value: string, label: string, language: AppLanguage) {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new Error(t('container.error.resourceNameRequired', language, { field: label }));
  }
  if (/\s/u.test(normalizedValue)) {
    throw new Error(t('container.error.invalidResourceName', language, { field: label }));
  }
  return normalizedValue;
}
function appendMultilineFlags(args: string[], flag: string, value: string) {
  parseMultilineValues(value).forEach((item) => args.push(flag, item));
}
function appendComposeContext(args: string[], projectName: string, workingDir: string, configFiles: string) {
  const normalizedProjectName = projectName.trim();
  const normalizedWorkingDir = workingDir.trim();
  const configFileList = configFiles
    .split(/[\r\n,]+/u)
    .map((item) => item.trim())
    .filter((item) => item && item !== '-');
  if (normalizedWorkingDir && normalizedWorkingDir !== '-') {
    args.push('--project-directory', normalizedWorkingDir);
  }
  configFileList.forEach((configFile) => args.push('-f', configFile));
  if (normalizedProjectName) {
    args.push('-p', normalizedProjectName);
  }
}
export function buildComposeUpArgs(form: ContainerComposeForm, language: AppLanguage) {
  const args = ['compose'];
  const projectName = form.projectName.trim();
  const configFile = form.configFile.trim();
  if (projectName && !/^[a-z0-9][a-z0-9_-]*$/u.test(projectName)) {
    throw new Error(t('container.error.invalidComposeProject', language));
  }
  if (!configFile) {
    throw new Error(t('container.error.composeFileRequired', language));
  }
  appendComposeContext(args, projectName, form.workingDir, configFile);
  const envFile = form.envFile.trim();
  if (envFile) {
    args.push('--env-file', envFile);
  }
  args.push('up', '-d');
  if (form.build) {
    args.push('--build');
  }
  if (form.pull) {
    args.push('--pull', 'always');
  }
  if (form.removeOrphans) {
    args.push('--remove-orphans');
  }
  args.push(...parseContainerCliTokens(form.services, t('container.ui.composeServices', language), language));
  return args;
}
export function buildComposeProjectActionArgs(project: ComposeProjectSummary, action: ComposeProjectAction) {
  const args = ['compose'];
  appendComposeContext(args, project.name, project.workingDir, project.configFiles);
  if (action === 'up') {
    args.push('up', '-d');
  } else {
    args.push(action);
  }
  return args;
}
export function buildNetworkCreateArgs(form: ContainerNetworkForm, language: AppLanguage) {
  const name = assertCliName(form.name, t('container.ui.networkName', language), language);
  const args = ['network', 'create'];
  const driver = form.driver.trim();
  if (driver) {
    args.push('--driver', driver);
  }
  const subnet = form.subnet.trim();
  const gateway = form.gateway.trim();
  const ipRange = form.ipRange.trim();
  if (subnet) {
    args.push('--subnet', subnet);
  }
  if (gateway) {
    args.push('--gateway', gateway);
  }
  if (ipRange) {
    args.push('--ip-range', ipRange);
  }
  if (form.internal) {
    args.push('--internal');
  }
  if (form.attachable) {
    args.push('--attachable');
  }
  if (form.ipv6) {
    args.push('--ipv6');
  }
  appendMultilineFlags(args, '--label', form.labels);
  appendMultilineFlags(args, '--opt', form.options);
  args.push(name);
  return args;
}
export function buildVolumeCreateArgs(form: ContainerVolumeForm, language: AppLanguage) {
  const name = assertCliName(form.name, t('container.ui.volumeName', language), language);
  const args = ['volume', 'create'];
  const driver = form.driver.trim();
  if (driver) {
    args.push('--driver', driver);
  }
  appendMultilineFlags(args, '--label', form.labels);
  appendMultilineFlags(args, '--opt', form.options);
  args.push(name);
  return args;
}
export function buildNetworkRemoveArgs(network: ContainerNetworkSummary) {
  return ['network', 'rm', network.name];
}
export function buildNetworkInspectArgs(network: ContainerNetworkSummary) {
  return ['network', 'inspect', network.name];
}
export function buildNetworkPruneArgs() {
  return ['network', 'prune', '--force'];
}
export function buildVolumeRemoveArgs(volume: ContainerVolumeSummary) {
  return ['volume', 'rm', volume.name];
}
export function buildVolumeInspectArgs(volume: ContainerVolumeSummary) {
  return ['volume', 'inspect', volume.name];
}
export function buildVolumePruneArgs() {
  return ['volume', 'prune', '--force'];
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
