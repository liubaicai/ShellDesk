import { VIRSH_SECTION_MARKER } from './virshCommands';
import type {
  VirshHostSummary,
  VirshNetworkSummary,
  VirshStoragePoolSummary,
  VirshStorageVolume,
  VirtualMachineDetail,
  VirtualMachineDisk,
  VirtualMachineInterface,
  VirtualMachineSnapshot,
  VirtualMachineState,
  VirtualMachineStats,
  VirtualMachineSummary,
} from './virshTypes';

interface OutputSection {
  name: string;
  content: string;
}

const numberPattern = /-?\d+(?:\.\d+)?/;

function splitSections(output: string): OutputSection[] {
  const sections: OutputSection[] = [];
  let current: { name: string; lines: string[] } | null = null;

  for (const line of output.replace(/\r/g, '').split('\n')) {
    if (line.startsWith(VIRSH_SECTION_MARKER)) {
      if (current) sections.push({ name: current.name, content: current.lines.join('\n').trim() });
      current = { name: line.slice(VIRSH_SECTION_MARKER.length).trim(), lines: [] };
      continue;
    }
    current?.lines.push(line);
  }

  if (current) sections.push({ name: current.name, content: current.lines.join('\n').trim() });
  return sections;
}

function parseFields(content: string) {
  const fields = new Map<string, string>();
  for (const line of content.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return fields;
}

function readNumber(fields: Map<string, string>, key: string) {
  const value = Number.parseFloat(fields.get(key) ?? '0');
  return Number.isFinite(value) ? value : 0;
}

function readBoolean(fields: Map<string, string>, key: string) {
  return /^(?:yes|true|enabled|1)$/i.test(fields.get(key) ?? '');
}

export function parseScaledBytes(value: string) {
  const amount = Number.parseFloat(value.match(numberPattern)?.[0] ?? '0');
  if (!Number.isFinite(amount)) return 0;
  const unit = value.toLowerCase();
  if (unit.includes('tib')) return amount * 1024 ** 4;
  if (unit.includes('tb')) return amount * 1000 ** 4;
  if (unit.includes('gib')) return amount * 1024 ** 3;
  if (unit.includes('gb')) return amount * 1000 ** 3;
  if (unit.includes('mib')) return amount * 1024 ** 2;
  if (unit.includes('mb')) return amount * 1000 ** 2;
  if (unit.includes('kib')) return amount * 1024;
  if (unit.includes('kb')) return amount * 1000;
  return amount;
}

export function normalizeVirtualMachineState(value: string): VirtualMachineState {
  const state = value.trim().toLowerCase();
  if (state === 'running') return 'running';
  if (state === 'idle') return 'idle';
  if (state === 'paused') return 'paused';
  if (state === 'in shutdown' || state === 'shutdown') return 'shutdown';
  if (state === 'shut off' || state === 'shutoff') return 'shutoff';
  if (state === 'crashed') return 'crashed';
  if (state === 'pmsuspended') return 'pmsuspended';
  return 'unknown';
}

export function parseVirshOverview(output: string): { host: VirshHostSummary; domains: VirtualMachineSummary[] } {
  const sections = splitSections(output);
  const meta = parseFields(sections.find((item) => item.name === 'meta')?.content ?? '');
  const domains = sections
    .filter((item) => item.name === 'domain')
    .map((item): VirtualMachineSummary => {
      const fields = parseFields(item.content);
      const stateLabel = fields.get('state') || 'unknown';
      return {
        uuid: fields.get('uuid') ?? '',
        name: fields.get('name') || fields.get('uuid') || '-',
        state: normalizeVirtualMachineState(stateLabel),
        stateLabel,
        id: fields.get('id') || '-',
        vcpus: readNumber(fields, 'vcpus'),
        maxMemoryKiB: readNumber(fields, 'maxMemoryKiB'),
        usedMemoryKiB: readNumber(fields, 'usedMemoryKiB'),
        persistent: readBoolean(fields, 'persistent'),
        autostart: readBoolean(fields, 'autostart'),
        managedSave: readBoolean(fields, 'managedSave'),
        ipAddresses: (fields.get('ipAddresses') ?? '').split(',').map((address) => address.trim()).filter(Boolean),
      };
    })
    .filter((item) => item.uuid);

  return {
    host: {
      uri: meta.get('uri') ?? '',
      virshVersion: meta.get('virshVersion') ?? '',
      hostname: meta.get('hostname') ?? '',
      hypervisor: meta.get('hypervisor') ?? '',
      cpuModel: meta.get('cpuModel') ?? '',
      cpuCount: readNumber(meta, 'cpuCount'),
      memoryKiB: readNumber(meta, 'memoryKiB'),
    },
    domains,
  };
}

function elementText(element: Element | null | undefined) {
  return element?.textContent?.trim() ?? '';
}

function parseDomainXml(xml: string) {
  if (!xml.trim()) return null;
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) return null;
  return document;
}

function parseDisks(document: Document | null): VirtualMachineDisk[] {
  if (!document) return [];
  return [...document.querySelectorAll('devices > disk')].map((disk) => {
    const source = disk.querySelector('source');
    const target = disk.querySelector('target');
    const driver = disk.querySelector('driver');
    return {
      device: disk.getAttribute('device') ?? '',
      type: disk.getAttribute('type') ?? '',
      target: target?.getAttribute('dev') ?? '',
      bus: target?.getAttribute('bus') ?? '',
      source: source?.getAttribute('file') ?? source?.getAttribute('dev') ?? source?.getAttribute('name') ?? source?.getAttribute('volume') ?? '',
      format: driver?.getAttribute('type') ?? '',
      readonly: Boolean(disk.querySelector('readonly')),
    };
  });
}

function parseAddressRows(content: string) {
  const addressesByMac = new Map<string, string[]>();
  for (const line of content.split('\n')) {
    const mac = line.match(/(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i)?.[0]?.toLowerCase();
    const ipv4Address = line.match(/(?:\d{1,3}\.){3}\d{1,3}(?:\/\d+)?/)?.[0];
    const ipv6Address = line.match(/(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*[0-9a-f](?:\/\d+)?/i)?.[0];
    const address = ipv4Address || (ipv6Address?.toLowerCase() !== mac ? ipv6Address : undefined);
    if (!mac || !address) continue;
    addressesByMac.set(mac, [...(addressesByMac.get(mac) ?? []), address]);
  }
  return addressesByMac;
}

function parseInterfaces(document: Document | null, addressContent: string): VirtualMachineInterface[] {
  if (!document) return [];
  const addressesByMac = parseAddressRows(addressContent);
  return [...document.querySelectorAll('devices > interface')].map((networkInterface) => {
    const source = networkInterface.querySelector('source');
    const mac = networkInterface.querySelector('mac')?.getAttribute('address')?.toLowerCase() ?? '';
    return {
      type: networkInterface.getAttribute('type') ?? '',
      source: source?.getAttribute('network') ?? source?.getAttribute('bridge') ?? source?.getAttribute('dev') ?? '',
      model: networkInterface.querySelector('model')?.getAttribute('type') ?? '',
      mac,
      target: networkInterface.querySelector('target')?.getAttribute('dev') ?? '',
      addresses: addressesByMac.get(mac) ?? [],
    };
  });
}

function parseStats(content: string): VirtualMachineStats {
  const fields = parseFields(content);
  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  let networkRxBytes = 0;
  let networkTxBytes = 0;
  for (const [key, value] of fields) {
    const numericValue = Number.parseFloat(value) || 0;
    if (/^block\.\d+\.rd\.bytes$/.test(key)) blockReadBytes += numericValue;
    if (/^block\.\d+\.wr\.bytes$/.test(key)) blockWriteBytes += numericValue;
    if (/^net\.\d+\.rx\.bytes$/.test(key)) networkRxBytes += numericValue;
    if (/^net\.\d+\.tx\.bytes$/.test(key)) networkTxBytes += numericValue;
  }
  return {
    cpuTimeNs: readNumber(fields, 'cpu.time'),
    vcpuCurrent: readNumber(fields, 'vcpu.current'),
    balloonCurrentKiB: readNumber(fields, 'balloon.current'),
    balloonMaximumKiB: readNumber(fields, 'balloon.maximum'),
    blockReadBytes,
    blockWriteBytes,
    networkRxBytes,
    networkTxBytes,
  };
}

function parseSnapshotSections(sections: OutputSection[]): VirtualMachineSnapshot[] {
  return sections.filter((item) => item.name === 'snapshot').map((item) => {
    const fields = parseFields(item.content);
    return {
      name: fields.get('name') ?? '',
      state: fields.get('state') ?? '',
      parent: fields.get('parent') ?? '',
      createdAt: fields.get('createdAt') ?? '',
      current: readBoolean(fields, 'current'),
      description: fields.get('description') ?? '',
    };
  }).filter((item) => item.name);
}

export function parseVirshDomainDetail(output: string, fallback: VirtualMachineSummary): VirtualMachineDetail {
  const sections = splitSections(output);
  const xml = sections.find((item) => item.name === 'xml')?.content ?? '';
  const document = parseDomainXml(xml);
  const addressContent = sections.find((item) => item.name === 'addresses')?.content ?? '';
  const memoryElement = document?.querySelector('domain > memory');
  const currentMemoryElement = document?.querySelector('domain > currentMemory');
  const memoryMultiplier = memoryElement?.getAttribute('unit')?.toLowerCase() === 'mib' ? 1024 : 1;
  const currentMemoryMultiplier = currentMemoryElement?.getAttribute('unit')?.toLowerCase() === 'mib' ? 1024 : 1;
  const vcpuElement = document?.querySelector('domain > vcpu');
  return {
    uuid: elementText(document?.querySelector('domain > uuid')) || fallback.uuid,
    name: elementText(document?.querySelector('domain > name')) || fallback.name,
    title: elementText(document?.querySelector('domain > title')),
    description: elementText(document?.querySelector('domain > description')),
    osType: elementText(document?.querySelector('os > type')),
    architecture: document?.querySelector('os > type')?.getAttribute('arch') ?? '',
    machine: document?.querySelector('os > type')?.getAttribute('machine') ?? '',
    emulator: elementText(document?.querySelector('devices > emulator')),
    bootDevices: [...(document?.querySelectorAll('os > boot') ?? [])].map((item) => item.getAttribute('dev') ?? '').filter(Boolean),
    vcpus: Number.parseInt(elementText(vcpuElement), 10) || fallback.vcpus,
    currentVcpus: Number.parseInt(vcpuElement?.getAttribute('current') ?? '', 10) || fallback.vcpus,
    memoryKiB: (Number.parseFloat(elementText(memoryElement)) || fallback.maxMemoryKiB) * memoryMultiplier,
    currentMemoryKiB: (Number.parseFloat(elementText(currentMemoryElement)) || fallback.usedMemoryKiB) * currentMemoryMultiplier,
    disks: parseDisks(document),
    interfaces: parseInterfaces(document, addressContent),
    snapshots: parseSnapshotSections(sections),
    stats: parseStats(sections.find((item) => item.name === 'stats')?.content ?? ''),
    displayUri: sections.find((item) => item.name === 'display')?.content.split('\n').find(Boolean)?.trim() ?? '',
    xml,
  };
}

export function parseVirshResources(output: string): {
  networks: VirshNetworkSummary[];
  pools: VirshStoragePoolSummary[];
  volumesByPool: Map<string, VirshStorageVolume[]>;
} {
  const sections = splitSections(output);
  const networks = sections.filter((item) => item.name === 'network').map((item): VirshNetworkSummary => {
    const fields = parseFields(item.content);
    return {
      uuid: fields.get('uuid') ?? '',
      name: fields.get('name') ?? '',
      active: readBoolean(fields, 'active'),
      persistent: readBoolean(fields, 'persistent'),
      autostart: readBoolean(fields, 'autostart'),
      bridge: fields.get('bridge') ?? '',
    };
  }).filter((item) => item.uuid && item.name);
  const pools = sections.filter((item) => item.name === 'pool').map((item): VirshStoragePoolSummary => {
    const fields = parseFields(item.content);
    const state = fields.get('state') ?? '';
    return {
      uuid: fields.get('uuid') ?? '',
      name: fields.get('name') ?? '',
      state,
      active: state === 'running' || state === 'active',
      persistent: readBoolean(fields, 'persistent'),
      autostart: readBoolean(fields, 'autostart'),
      capacityBytes: parseScaledBytes(fields.get('capacityBytes') ?? ''),
      allocationBytes: parseScaledBytes(fields.get('allocationBytes') ?? ''),
      availableBytes: parseScaledBytes(fields.get('availableBytes') ?? ''),
    };
  }).filter((item) => item.uuid && item.name);
  const volumesByPool = new Map<string, VirshStorageVolume[]>();
  for (const item of sections.filter((section) => section.name === 'volume')) {
    const fields = parseFields(item.content);
    const pool = fields.get('pool') ?? '';
    const name = fields.get('name') ?? '';
    if (!pool || !name) continue;
    volumesByPool.set(pool, [...(volumesByPool.get(pool) ?? []), {
      name,
      type: fields.get('type') ?? '',
      capacityBytes: parseScaledBytes(fields.get('capacityBytes') ?? ''),
      allocationBytes: parseScaledBytes(fields.get('allocationBytes') ?? ''),
      path: fields.get('path') ?? '',
    }]);
  }
  return { networks, pools, volumesByPool };
}

export function parseVncDisplayTarget(displayUri: string): { host: string; port: number } | null {
  if (!displayUri.startsWith('vnc://')) return null;
  try {
    const url = new URL(displayUri);
    const rawPort = Number.parseInt(url.port || '0', 10);
    return {
      host: url.hostname || '127.0.0.1',
      port: rawPort < 100 ? 5900 + rawPort : rawPort,
    };
  } catch {
    return null;
  }
}
