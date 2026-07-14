import type { RemoteSystemType } from './types';
import type { RemoteTerminalLaunchOptions } from './terminalTypes';

export type VirtualMachineState =
  | 'running'
  | 'idle'
  | 'paused'
  | 'shutdown'
  | 'shutoff'
  | 'crashed'
  | 'pmsuspended'
  | 'unknown';

export type VirtualMachineManagerTab = 'domains' | 'networks' | 'storage';
export type VirtualMachineDetailTab = 'overview' | 'performance' | 'disks' | 'network' | 'snapshots' | 'xml';

export interface VirshHostSummary {
  uri: string;
  virshVersion: string;
  hostname: string;
  hypervisor: string;
  cpuModel: string;
  cpuCount: number;
  memoryKiB: number;
}

export interface VirtualMachineSummary {
  uuid: string;
  name: string;
  state: VirtualMachineState;
  stateLabel: string;
  id: string;
  vcpus: number;
  maxMemoryKiB: number;
  usedMemoryKiB: number;
  persistent: boolean;
  autostart: boolean;
  managedSave: boolean;
  ipAddresses: string[];
}

export interface VirtualMachineDisk {
  device: string;
  type: string;
  target: string;
  bus: string;
  source: string;
  format: string;
  readonly: boolean;
}

export interface VirtualMachineInterface {
  type: string;
  source: string;
  model: string;
  mac: string;
  target: string;
  addresses: string[];
}

export interface VirtualMachineSnapshot {
  name: string;
  state: string;
  parent: string;
  createdAt: string;
  current: boolean;
  description: string;
}

export interface VirtualMachineStats {
  cpuTimeNs: number;
  vcpuCurrent: number;
  balloonCurrentKiB: number;
  balloonMaximumKiB: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface VirtualMachineDetail {
  uuid: string;
  name: string;
  title: string;
  description: string;
  osType: string;
  architecture: string;
  machine: string;
  emulator: string;
  bootDevices: string[];
  vcpus: number;
  currentVcpus: number;
  memoryKiB: number;
  currentMemoryKiB: number;
  disks: VirtualMachineDisk[];
  interfaces: VirtualMachineInterface[];
  snapshots: VirtualMachineSnapshot[];
  stats: VirtualMachineStats;
  displayUri: string;
  xml: string;
}

export interface VirshNetworkSummary {
  uuid: string;
  name: string;
  active: boolean;
  persistent: boolean;
  autostart: boolean;
  bridge: string;
}

export interface VirshStoragePoolSummary {
  uuid: string;
  name: string;
  state: string;
  active: boolean;
  persistent: boolean;
  autostart: boolean;
  capacityBytes: number;
  allocationBytes: number;
  availableBytes: number;
}

export interface VirshStorageVolume {
  name: string;
  type: string;
  capacityBytes: number;
  allocationBytes: number;
  path: string;
}

export type VirtualMachineAction =
  | 'start'
  | 'shutdown'
  | 'reboot'
  | 'suspend'
  | 'resume'
  | 'reset'
  | 'destroy'
  | 'autostart-enable'
  | 'autostart-disable';

export type VirshNetworkAction = 'start' | 'destroy' | 'autostart-enable' | 'autostart-disable';
export type VirshStoragePoolAction = 'start' | 'destroy' | 'refresh' | 'autostart-enable' | 'autostart-disable';

export type VirtualMachinePendingAction =
  | { kind: 'domain'; action: VirtualMachineAction; domain: VirtualMachineSummary }
  | { kind: 'snapshot-revert'; domain: VirtualMachineSummary; snapshot: VirtualMachineSnapshot }
  | { kind: 'snapshot-delete'; domain: VirtualMachineSummary; snapshot: VirtualMachineSnapshot }
  | { kind: 'network'; action: VirshNetworkAction; network: VirshNetworkSummary }
  | { kind: 'pool'; action: VirshStoragePoolAction; pool: VirshStoragePoolSummary };

export interface VirtualMachineSnapshotForm {
  name: string;
  description: string;
  diskOnly: boolean;
  quiesce: boolean;
}

export interface RemoteVirtualMachineManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenTerminal?: (options?: RemoteTerminalLaunchOptions) => void;
  onOpenVnc?: (target: { host: string; port: number }) => void;
}
