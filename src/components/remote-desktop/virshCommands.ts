import type { RemoteCommandInput } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import type {
  VirshStorageVolumeForm,
  VirshNetworkAction,
  VirshStoragePoolAction,
  VirtualMachineAction,
  VirtualMachineCreateForm,
  VirtualMachineDeleteForm,
  VirtualMachineDiskForm,
  VirtualMachineInterfaceForm,
  VirtualMachineMigrationForm,
  VirtualMachineSettingsForm,
  VirtualMachineSnapshotForm,
} from './virshTypes';
import { buildDomainXml } from './virshDomainXml';

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

export function getVirtualMachineCreateCommand(uri: string, form: VirtualMachineCreateForm): RemoteCommandInput {
  const createsVolume = form.storageMode === 'new-volume';
  const volumeCreate = createsVolume
    ? `shelldesk_virsh vol-create-as ${shellSingleQuote(form.storagePool)} ${shellSingleQuote(form.volumeName)} ${Math.max(1, form.diskSizeGiB)}G --format qcow2\nvolume_created=1`
    : '';
  const rollback = createsVolume
    ? `if [ "$volume_created" = 1 ]; then shelldesk_virsh vol-delete ${shellSingleQuote(form.volumeName)} --pool ${shellSingleQuote(form.storagePool)} >/dev/null 2>&1 || true; fi`
    : ':';
  const postCreate = [
    form.autostart ? `shelldesk_virsh autostart ${shellSingleQuote(form.name.trim())}` : '',
    form.startAfterCreate ? `shelldesk_virsh start ${shellSingleQuote(form.name.trim())}` : '',
  ].filter(Boolean).join('\n');
  return {
    command: `${virshPrelude(uri)}
set -e
xml_file="$(mktemp)" || exit 1
trap 'rm -f "$xml_file"' EXIT
cat > "$xml_file"
volume_created=0
${volumeCreate}
if ! shelldesk_virsh define "$xml_file" --validate; then
  ${rollback}
  exit 1
fi
${postCreate}`,
    stdin: buildDomainXml(form),
  };
}

export function getVirtualMachineCloneCommand(uri: string, uuid: string, name: string): RemoteCommandInput {
  return {
    command: `${virshPrelude(uri)}
set -e
if ! command -v virt-clone >/dev/null 2>&1; then
  printf '%s\n' 'virt-clone is required to clone virtual machines.' >&2
  exit 127
fi
virt-clone --connect "$SHELLDESK_VIRSH_URI" --original ${shellSingleQuote(uuid)} --name ${shellSingleQuote(name.trim())} --auto-clone`,
  };
}

export function getVirtualMachineSettingsCommand(uri: string, uuid: string, form: VirtualMachineSettingsForm): RemoteCommandInput {
  const quotedUuid = shellSingleQuote(uuid);
  const vcpus = Math.max(1, Math.round(form.vcpus));
  const memoryKiB = Math.max(128, Math.round(form.memoryMiB)) * 1024;
  const live = form.applyLive
    ? `
shelldesk_virsh setvcpus ${quotedUuid} ${vcpus} --live
shelldesk_virsh setmem ${quotedUuid} ${memoryKiB} --live`
    : '';
  const autostart = form.autostart
    ? `shelldesk_virsh autostart ${quotedUuid}`
    : `shelldesk_virsh autostart ${quotedUuid} --disable`;
  return {
    command: `${virshPrelude(uri)}
set -e
shelldesk_virsh setvcpus ${quotedUuid} ${vcpus} --config
shelldesk_virsh setmaxmem ${quotedUuid} ${memoryKiB} --config
shelldesk_virsh setmem ${quotedUuid} ${memoryKiB} --config${live}
${autostart}`,
  };
}

export function getVirtualMachineAttachDiskCommand(uri: string, uuid: string, form: VirtualMachineDiskForm): RemoteCommandInput {
  const flags = ['--config', form.live ? '--live' : '', '--targetbus', form.bus, '--subdriver', form.format, form.readonly ? '--readonly' : ''].filter(Boolean);
  return { command: `${virshPrelude(uri)}\nset -e\nshelldesk_virsh attach-disk ${shellSingleQuote(uuid)} ${shellSingleQuote(form.source.trim())} ${shellSingleQuote(form.target.trim())} ${flags.join(' ')}` };
}

export function getVirtualMachineDetachDiskCommand(uri: string, uuid: string, target: string, live: boolean): RemoteCommandInput {
  return { command: `${virshPrelude(uri)}\nset -e\nshelldesk_virsh detach-disk ${shellSingleQuote(uuid)} ${shellSingleQuote(target)} --config ${live ? '--live' : ''}` };
}

export function getVirtualMachineAttachInterfaceCommand(uri: string, uuid: string, form: VirtualMachineInterfaceForm): RemoteCommandInput {
  const flags = ['--config', form.live ? '--live' : '', '--model', form.model || 'virtio', form.mac.trim() ? `--mac ${shellSingleQuote(form.mac.trim())}` : ''].filter(Boolean);
  return { command: `${virshPrelude(uri)}\nset -e\nshelldesk_virsh attach-interface ${shellSingleQuote(uuid)} ${form.type} ${shellSingleQuote(form.source.trim())} ${flags.join(' ')}` };
}

export function getVirtualMachineDetachInterfaceCommand(uri: string, uuid: string, type: string, mac: string, live: boolean): RemoteCommandInput {
  return { command: `${virshPrelude(uri)}\nset -e\nshelldesk_virsh detach-interface ${shellSingleQuote(uuid)} ${shellSingleQuote(type)} --mac ${shellSingleQuote(mac)} --config ${live ? '--live' : ''}` };
}

export function getVirtualMachineDeleteCommand(uri: string, uuid: string, form: VirtualMachineDeleteForm): RemoteCommandInput {
  const flags = [
    '--managed-save',
    form.removeSnapshotsMetadata ? '--snapshots-metadata' : '',
    form.removeNvram ? '--nvram' : '',
    form.removeStorage ? '--remove-all-storage --delete-storage-volume-snapshots' : '',
  ].filter(Boolean).join(' ');
  return {
    command: `${virshPrelude(uri)}
set -e
${form.forceStop ? `if shelldesk_virsh domstate ${shellSingleQuote(uuid)} | grep -Eqi 'running|paused|idle'; then shelldesk_virsh destroy ${shellSingleQuote(uuid)}; fi` : ''}
shelldesk_virsh undefine ${shellSingleQuote(uuid)} ${flags}`,
  };
}

export function getVirtualMachineMigrationCommand(uri: string, uuid: string, form: VirtualMachineMigrationForm): RemoteCommandInput {
  const flags = [
    form.live ? '--live' : '--offline',
    form.persistent ? '--persistent' : '',
    form.undefineSource ? '--undefinesource' : '',
    form.copyStorage === 'all' ? '--copy-storage-all' : '',
    form.copyStorage === 'incremental' ? '--copy-storage-inc' : '',
    form.peerToPeer ? '--p2p' : '--direct',
    form.tunnelled ? '--tunnelled' : '',
  ].filter(Boolean).join(' ');
  return { command: `${virshPrelude(uri)}\nset -e\nshelldesk_virsh migrate ${flags} ${shellSingleQuote(uuid)} ${shellSingleQuote(form.destinationUri.trim())}` };
}

export function getVirtualMachineDefineXmlCommand(uri: string, xml: string): RemoteCommandInput {
  return {
    command: `${virshPrelude(uri)}
set -e
xml_file="$(mktemp)" || exit 1
trap 'rm -f "$xml_file"' EXIT
cat > "$xml_file"
shelldesk_virsh define "$xml_file" --validate`,
    stdin: xml,
  };
}

export function getVirshStorageVolumeCreateCommand(uri: string, form: VirshStorageVolumeForm): RemoteCommandInput {
  const capacity = Math.max(0.1, form.capacityGiB);
  const allocation = Math.max(0, Math.min(form.allocationGiB, capacity));
  return {
    command: `${virshPrelude(uri)}\nset -e\nshelldesk_virsh vol-create-as ${shellSingleQuote(form.pool)} ${shellSingleQuote(form.name.trim())} ${capacity}G --allocation ${allocation}G --format ${form.format}`,
  };
}

export function getVirshStorageVolumeDeleteCommand(uri: string, pool: string, name: string): RemoteCommandInput {
  return { command: `${virshPrelude(uri)}\nset -e\nshelldesk_virsh vol-delete ${shellSingleQuote(name)} --pool ${shellSingleQuote(pool)}` };
}
