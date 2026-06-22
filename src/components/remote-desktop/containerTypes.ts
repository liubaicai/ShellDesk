import type { RemoteSystemType } from './types';

export type ContainerRuntime = 'docker' | 'podman';
export type ContainerState = 'running' | 'exited' | 'paused' | 'created' | 'unknown';

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  command?: string;
  status: string;
  state: ContainerState;
  ports: string;
  createdAt?: string;
  runningFor?: string;
}

export interface ImageSummary {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt?: string;
}

export interface RemoteContainerManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

export interface ContainerStats {
  cpu: string;
  memory: string;
  memoryPercent: string;
  netIO: string;
  blockIO: string;
  pids: string;
  raw: string;
  error?: string;
}

export type RestartPolicy = 'no' | 'on-failure' | 'unless-stopped' | 'always';
export type RunNetworkMode = 'default' | 'bridge' | 'host' | 'none' | 'custom';

export interface ContainerRuntimeConfig {
  restartPolicy: RestartPolicy;
  restartPolicyText: string;
  networkMode: string;
  privileged: string;
  hostname: string;
  user: string;
  workingDir: string;
  entrypoint: string;
  command: string;
  labels: string[];
  resources: Array<{ label: string; value: string }>;
}

export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  status: string;
  state: ContainerState;
  createdAt?: string;
  ports: string[];
  mounts: string[];
  env: string[];
  logs: string;
  inspectText: string;
  statsText: string;
  stats?: ContainerStats;
  config: ContainerRuntimeConfig;
  inspectError?: string;
}

export interface ContainerTroubleshooting {
  title: string;
  message: string;
  commands: string;
  rawOutput: string;
}

export interface ContainerRunForm {
  image: string;
  name: string;
  ports: string;
  volumes: string;
  environment: string;
  restartPolicy: RestartPolicy;
  networkMode: RunNetworkMode;
  network: string;
  hostname: string;
  workdir: string;
  user: string;
  command: string;
  extraArgs: string;
  createOnly: boolean;
  removeWhenStopped: boolean;
}

export interface ContainerConfigForm {
  name: string;
  restartPolicy: RestartPolicy;
  cpuLimit: string;
  memoryLimit: string;
}

export type ManagerTab = 'containers' | 'images';
export type ContainerFilter = 'all' | ContainerState;
export type DetailTab = 'summary' | 'config' | 'logs' | 'inspect' | 'exec';
export type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill' | 'remove';
export type ImagePruneMode = 'dangling' | 'unused';

export type PendingAction =
  | { kind: 'container'; action: 'remove'; container: ContainerSummary }
  | { kind: 'image'; action: 'remove'; image: ImageSummary };
