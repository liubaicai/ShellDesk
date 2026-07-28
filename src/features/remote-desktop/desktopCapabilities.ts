import {
  desktopApps,
  getAppCapability,
  getDesktopAppToolRequirements,
  getDesktopSystemFamily,
  type DesktopAppKey,
  type DesktopSystemFamily,
  type DesktopToolRequirement,
} from '../../remoteDesktopCatalog';
import { powershellStdinCommand, type RemoteCommandInput } from '../../components/remote-desktop/remoteSystem';
import type { RemoteSystemType } from '../../components/remote-desktop/types';

export type DesktopAppAvailabilityStatus =
  | 'available'
  | 'checking'
  | 'missing'
  | 'unsupported'
  | 'unknown';

export interface DesktopAppAvailability {
  status: DesktopAppAvailabilityStatus;
  missingTools: string[];
}

export type DesktopCapabilitySnapshot = Record<DesktopAppKey, DesktopAppAvailability>;

const capabilitySnapshotCache = new Map<string, DesktopCapabilitySnapshot>();

function requirementTools(requirement: DesktopToolRequirement) {
  return typeof requirement === 'string' ? [requirement] : [...requirement];
}

export function formatToolRequirement(requirement: DesktopToolRequirement) {
  return requirementTools(requirement).join(' / ');
}

function isSupportedSystem(appKey: DesktopAppKey, systemFamily: DesktopSystemFamily | 'unknown') {
  return systemFamily === 'unknown'
    ? null
    : getAppCapability(appKey).supportedSystems.includes(systemFamily);
}

export function createStaticDesktopCapabilitySnapshot(
  systemType?: RemoteSystemType,
): DesktopCapabilitySnapshot {
  const systemFamily = getDesktopSystemFamily(systemType);
  const snapshot = {} as DesktopCapabilitySnapshot;

  if (systemFamily === 'unknown') {
    desktopApps.forEach((app) => {
      snapshot[app.key] = { status: 'unknown', missingTools: [] };
    });
    return snapshot;
  }

  desktopApps.forEach((app) => {
    const isSupported = isSupportedSystem(app.key, systemFamily);
    if (isSupported === false) {
      snapshot[app.key] = { status: 'unsupported', missingTools: [] };
      return;
    }

    const requirements = getDesktopAppToolRequirements(app.key, systemFamily);
    snapshot[app.key] = {
      status: requirements.length > 0 ? 'checking' : 'available',
      missingTools: [],
    };
  });
  return snapshot;
}

function collectProbeTools(systemFamily: DesktopSystemFamily) {
  const tools = new Set<string>();

  desktopApps.forEach((app) => {
    if (!getAppCapability(app.key).supportedSystems.includes(systemFamily)) {
      return;
    }

    getDesktopAppToolRequirements(app.key, systemFamily).forEach((requirement) => {
      requirementTools(requirement).forEach((tool) => {
        if (/^[a-zA-Z0-9._+-]+$/u.test(tool)) {
          tools.add(tool);
        }
      });
    });
  });

  return [...tools].sort();
}

function createCapabilityProbeCommand(
  tools: string[],
  systemFamily: DesktopSystemFamily,
): RemoteCommandInput {
  if (systemFamily === 'windows') {
    const toolList = tools.map((tool) => `'${tool.replaceAll("'", "''")}'`).join(', ');
    return powershellStdinCommand(`
$tools = @(${toolList})
foreach ($tool in $tools) {
  $available = $null -ne (Get-Command $tool -ErrorAction SilentlyContinue)
  Write-Output ("{0}\t{1}" -f $tool, [int]$available)
}
`);
  }

  const toolList = tools.join(' ');
  return {
    command: `for tool in ${toolList}; do if command -v "$tool" >/dev/null 2>&1; then printf '%s\\t1\\n' "$tool"; else printf '%s\\t0\\n' "$tool"; fi; done`,
  };
}

function parseCapabilityProbe(stdout: string) {
  const availability = new Map<string, boolean>();

  stdout.split(/\r?\n/u).forEach((line) => {
    const [tool, rawStatus] = line.trim().split(/\t/u);
    if (tool && (rawStatus === '0' || rawStatus === '1')) {
      availability.set(tool, rawStatus === '1');
    }
  });

  return availability;
}

function applyToolAvailability(
  systemType: RemoteSystemType | undefined,
  toolAvailability: Map<string, boolean> | null,
): DesktopCapabilitySnapshot {
  const systemFamily = getDesktopSystemFamily(systemType);
  const snapshot = createStaticDesktopCapabilitySnapshot(systemType);

  if (systemFamily === 'unknown') {
    return snapshot;
  }

  desktopApps.forEach((app) => {
    if (snapshot[app.key].status !== 'checking') {
      return;
    }

    if (!toolAvailability) {
      snapshot[app.key] = { status: 'unknown', missingTools: [] };
      return;
    }

    const requirements = getDesktopAppToolRequirements(app.key, systemFamily);
    const missingTools = requirements
      .filter((requirement) => !requirementTools(requirement).some((tool) => toolAvailability.get(tool) === true))
      .map(formatToolRequirement);

    snapshot[app.key] = missingTools.length > 0
      ? { status: 'missing', missingTools }
      : { status: 'available', missingTools: [] };
  });

  return snapshot;
}

export async function loadDesktopCapabilitySnapshot(
  connectionId: string,
  systemType?: RemoteSystemType,
  force = false,
) {
  const systemFamily = getDesktopSystemFamily(systemType);
  const cacheKey = `${connectionId}:${systemFamily}`;

  if (!force) {
    const cached = capabilitySnapshotCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  if (systemFamily === 'unknown') {
    return createStaticDesktopCapabilitySnapshot(systemType);
  }

  const tools = collectProbeTools(systemFamily);
  if (tools.length === 0) {
    const snapshot = createStaticDesktopCapabilitySnapshot(systemType);
    capabilitySnapshotCache.set(cacheKey, snapshot);
    return snapshot;
  }

  const api = window.guiSSH?.connections;
  if (!api?.runCommand) {
    return applyToolAvailability(systemType, null);
  }

  try {
    const command = createCapabilityProbeCommand(tools, systemFamily);
    const result = await api.runCommand(connectionId, command.command, command.stdin);
    const snapshot = result.code === 0
      ? applyToolAvailability(systemType, parseCapabilityProbe(result.stdout))
      : applyToolAvailability(systemType, null);
    capabilitySnapshotCache.set(cacheKey, snapshot);
    return snapshot;
  } catch {
    return applyToolAvailability(systemType, null);
  }
}

export function clearDesktopCapabilitySnapshot(connectionId: string) {
  [...capabilitySnapshotCache.keys()]
    .filter((cacheKey) => cacheKey.startsWith(`${connectionId}:`))
    .forEach((cacheKey) => capabilitySnapshotCache.delete(cacheKey));
}
