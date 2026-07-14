import type { RemoteCommandInput } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import type {
  VirshNetworkAction,
  VirshStoragePoolAction,
  VirtualMachineAction,
  VirtualMachineSnapshotForm,
} from './virshTypes';

export const VIRSH_SECTION_MARKER = '__SHELLDESK_VIRSH_SECTION__=';

function virshPrelude(uri: string) {
  return [
    'export LC_ALL=C LANG=C',
    `SHELLDESK_VIRSH_URI=${shellSingleQuote(uri.trim())}`,
    'shelldesk_virsh() { virsh --connect "$SHELLDESK_VIRSH_URI" "$@"; }',
  ].join('\n');
}

function section(name: string) {
  return `printf '${VIRSH_SECTION_MARKER}%s\\n' ${shellSingleQuote(name)}`;
}

export function getVirshDetectCommand(uri: string): RemoteCommandInput {
  return {
    command: `${virshPrelude(uri)}
if ! command -v virsh >/dev/null 2>&1; then
  printf '${VIRSH_SECTION_MARKER}error\\nVIRSH_NOT_FOUND\\n'
  exit 127
fi
${section('meta')}
printf 'virshVersion='; virsh --version 2>/dev/null || true
printf 'uri='; shelldesk_virsh uri
printf 'hostname='; shelldesk_virsh hostname 2>/dev/null || true
printf 'hypervisor='; shelldesk_virsh version --daemon 2>/dev/null | awk -F': *' '/Running hypervisor/ { print $2; exit }'
node_info="$(shelldesk_virsh nodeinfo 2>/dev/null || true)"
printf 'cpuModel=%s\\n' "$(printf '%s\\n' "$node_info" | awk -F': *' '/^CPU model/ { print $2; exit }')"
printf 'cpuCount=%s\\n' "$(printf '%s\\n' "$node_info" | awk -F': *' '/^CPU\(s\)/ { print $2; exit }')"
printf 'memoryKiB=%s\\n' "$(printf '%s\\n' "$node_info" | awk -F': *' '/^Memory size/ { gsub(/[^0-9]/, "", $2); print $2; exit }')"
uuids="$(shelldesk_virsh list --all --uuid)" || exit $?
for uuid in $uuids; do
  ${section('domain')}
  printf 'uuid=%s\\n' "$uuid"
  printf 'name='; shelldesk_virsh domname "$uuid"
  printf 'state='; shelldesk_virsh domstate "$uuid" 2>/dev/null || printf 'unknown\\n'
  domain_info="$(shelldesk_virsh dominfo "$uuid" 2>/dev/null || true)"
  printf 'id=%s\\n' "$(printf '%s\\n' "$domain_info" | awk -F': *' '/^Id/ { print $2; exit }')"
  printf 'vcpus=%s\\n' "$(printf '%s\\n' "$domain_info" | awk -F': *' '/^CPU\(s\)/ { print $2; exit }')"
  printf 'maxMemoryKiB=%s\\n' "$(printf '%s\\n' "$domain_info" | awk -F': *' '/^Max memory/ { gsub(/[^0-9]/, "", $2); print $2; exit }')"
  printf 'usedMemoryKiB=%s\\n' "$(printf '%s\\n' "$domain_info" | awk -F': *' '/^Used memory/ { gsub(/[^0-9]/, "", $2); print $2; exit }')"
  printf 'persistent=%s\\n' "$(printf '%s\\n' "$domain_info" | awk -F': *' '/^Persistent/ { print tolower($2); exit }')"
  printf 'autostart=%s\\n' "$(printf '%s\\n' "$domain_info" | awk -F': *' '/^Autostart/ { print tolower($2); exit }')"
  printf 'managedSave=%s\\n' "$(printf '%s\\n' "$domain_info" | awk -F': *' '/^Managed save/ { print tolower($2); exit }')"
  addresses="$(shelldesk_virsh domifaddr "$uuid" --full --source agent 2>/dev/null || shelldesk_virsh domifaddr "$uuid" --full --source lease 2>/dev/null || true)"
  printf 'ipAddresses=%s\\n' "$(printf '%s\\n' "$addresses" | awk '$4 ~ /^[0-9]/ { sub(/\\/.*/, "", $4); if (!seen[$4]++) { if (out != "") out=out ","; out=out $4 } } END { print out }')"
done`,
  };
}

export function getVirshDomainDetailCommand(uri: string, uuid: string): RemoteCommandInput {
  const quotedUuid = shellSingleQuote(uuid);
  return {
    command: `${virshPrelude(uri)}
${section('xml')}
shelldesk_virsh dumpxml ${quotedUuid}
${section('stats')}
shelldesk_virsh domstats --state --cpu-total --balloon --vcpu --interface --block ${quotedUuid} 2>/dev/null || true
${section('addresses')}
shelldesk_virsh domifaddr ${quotedUuid} --full --source agent 2>/dev/null || shelldesk_virsh domifaddr ${quotedUuid} --full --source lease 2>/dev/null || true
${section('display')}
shelldesk_virsh domdisplay ${quotedUuid} 2>/dev/null || true
${section('snapshots')}
snapshots="$(shelldesk_virsh snapshot-list ${quotedUuid} --name 2>/dev/null || true)"
printf '%s\\n' "$snapshots" | while IFS= read -r snapshot; do
  [ -n "$snapshot" ] || continue
  ${section('snapshot')}
  printf 'name=%s\\n' "$snapshot"
  snapshot_info="$(shelldesk_virsh snapshot-info ${quotedUuid} "$snapshot" 2>/dev/null || true)"
  printf 'state=%s\\n' "$(printf '%s\\n' "$snapshot_info" | awk -F': *' '/^State/ { print $2; exit }')"
  printf 'parent=%s\\n' "$(printf '%s\\n' "$snapshot_info" | awk -F': *' '/^Parent/ { print $2; exit }')"
  printf 'createdAt=%s\\n' "$(printf '%s\\n' "$snapshot_info" | awk -F': *' '/^Creation Time/ { print $2; exit }')"
  printf 'current=%s\\n' "$(printf '%s\\n' "$snapshot_info" | awk -F': *' '/^Current/ { print tolower($2); exit }')"
  printf 'description=%s\\n' "$(printf '%s\\n' "$snapshot_info" | awk -F': *' '/^Description/ { print $2; exit }')"
done`,
  };
}

export function getVirshResourcesCommand(uri: string): RemoteCommandInput {
  return {
    command: `${virshPrelude(uri)}
network_uuids="$(shelldesk_virsh net-list --all --uuid)" || exit $?
for uuid in $network_uuids; do
  ${section('network')}
  printf 'uuid=%s\\n' "$uuid"
  printf 'name='; shelldesk_virsh net-name "$uuid"
  info="$(shelldesk_virsh net-info "$uuid" 2>/dev/null || true)"
  printf 'active=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^Active/ { print tolower($2); exit }')"
  printf 'persistent=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^Persistent/ { print tolower($2); exit }')"
  printf 'autostart=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^Autostart/ { print tolower($2); exit }')"
  printf 'bridge=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^Bridge/ { print $2; exit }')"
done
pool_uuids="$(shelldesk_virsh pool-list --all --uuid)" || exit $?
for uuid in $pool_uuids; do
  ${section('pool')}
  printf 'uuid=%s\\n' "$uuid"
  name="$(shelldesk_virsh pool-name "$uuid")"
  printf 'name=%s\\n' "$name"
  info="$(shelldesk_virsh pool-info "$uuid" 2>/dev/null || true)"
  printf 'state=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^State/ { print tolower($2); exit }')"
  printf 'persistent=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^Persistent/ { print tolower($2); exit }')"
  printf 'autostart=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^Autostart/ { print tolower($2); exit }')"
  printf 'capacityBytes=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^Capacity/ { print $2; exit }')"
  printf 'allocationBytes=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^Allocation/ { print $2; exit }')"
  printf 'availableBytes=%s\\n' "$(printf '%s\\n' "$info" | awk -F': *' '/^Available/ { print $2; exit }')"
  if printf '%s\\n' "$info" | grep -qi '^State:.*running'; then
    volumes="$(shelldesk_virsh vol-list "$name" --name 2>/dev/null || true)"
    printf '%s\\n' "$volumes" | while IFS= read -r volume; do
      [ -n "$volume" ] || continue
      ${section('volume')}
      printf 'pool=%s\\nname=%s\\n' "$name" "$volume"
      volume_info="$(shelldesk_virsh vol-info "$volume" --pool "$name" 2>/dev/null || true)"
      printf 'type=%s\\n' "$(printf '%s\\n' "$volume_info" | awk -F': *' '/^Type/ { print $2; exit }')"
      printf 'capacityBytes=%s\\n' "$(printf '%s\\n' "$volume_info" | awk -F': *' '/^Capacity/ { print $2; exit }')"
      printf 'allocationBytes=%s\\n' "$(printf '%s\\n' "$volume_info" | awk -F': *' '/^Allocation/ { print $2; exit }')"
      printf 'path='; shelldesk_virsh vol-path "$volume" --pool "$name" 2>/dev/null || true
    done
  fi
done`,
  };
}

export function getVirtualMachineActionCommand(uri: string, uuid: string, action: VirtualMachineAction): RemoteCommandInput {
  const commandByAction: Record<VirtualMachineAction, string> = {
    start: `start ${shellSingleQuote(uuid)}`,
    shutdown: `shutdown ${shellSingleQuote(uuid)}`,
    reboot: `reboot ${shellSingleQuote(uuid)}`,
    suspend: `suspend ${shellSingleQuote(uuid)}`,
    resume: `resume ${shellSingleQuote(uuid)}`,
    reset: `reset ${shellSingleQuote(uuid)}`,
    destroy: `destroy ${shellSingleQuote(uuid)}`,
    'autostart-enable': `autostart ${shellSingleQuote(uuid)}`,
    'autostart-disable': `autostart ${shellSingleQuote(uuid)} --disable`,
  };
  return { command: `${virshPrelude(uri)}\nshelldesk_virsh ${commandByAction[action]}` };
}

export function getSnapshotCreateCommand(uri: string, uuid: string, form: VirtualMachineSnapshotForm): RemoteCommandInput {
  const flags = ['--atomic'];
  if (form.diskOnly) flags.push('--disk-only');
  if (form.quiesce) flags.push('--quiesce');
  return {
    command: `${virshPrelude(uri)}\nshelldesk_virsh snapshot-create-as ${shellSingleQuote(uuid)} ${shellSingleQuote(form.name.trim())} ${shellSingleQuote(form.description.trim())} ${flags.join(' ')}`,
  };
}

export function getSnapshotActionCommand(uri: string, uuid: string, snapshotName: string, action: 'revert' | 'delete'): RemoteCommandInput {
  const command = action === 'revert'
    ? `snapshot-revert ${shellSingleQuote(uuid)} ${shellSingleQuote(snapshotName)}`
    : `snapshot-delete ${shellSingleQuote(uuid)} ${shellSingleQuote(snapshotName)}`;
  return { command: `${virshPrelude(uri)}\nshelldesk_virsh ${command}` };
}

export function getVirshNetworkActionCommand(uri: string, name: string, action: VirshNetworkAction): RemoteCommandInput {
  const commandByAction: Record<VirshNetworkAction, string> = {
    start: `net-start ${shellSingleQuote(name)}`,
    destroy: `net-destroy ${shellSingleQuote(name)}`,
    'autostart-enable': `net-autostart ${shellSingleQuote(name)}`,
    'autostart-disable': `net-autostart ${shellSingleQuote(name)} --disable`,
  };
  return { command: `${virshPrelude(uri)}\nshelldesk_virsh ${commandByAction[action]}` };
}

export function getVirshStoragePoolActionCommand(uri: string, name: string, action: VirshStoragePoolAction): RemoteCommandInput {
  const commandByAction: Record<VirshStoragePoolAction, string> = {
    start: `pool-start ${shellSingleQuote(name)}`,
    destroy: `pool-destroy ${shellSingleQuote(name)}`,
    refresh: `pool-refresh ${shellSingleQuote(name)}`,
    'autostart-enable': `pool-autostart ${shellSingleQuote(name)}`,
    'autostart-disable': `pool-autostart ${shellSingleQuote(name)} --disable`,
  };
  return { command: `${virshPrelude(uri)}\nshelldesk_virsh ${commandByAction[action]}` };
}

export function getVirshConsoleCommand(uri: string, uuid: string, useSudo: boolean, force = false) {
  const command = `virsh --connect ${shellSingleQuote(uri)} console ${shellSingleQuote(uuid)} ${force ? '--force' : '--safe'}`;
  return useSudo ? `sudo ${command}` : command;
}
