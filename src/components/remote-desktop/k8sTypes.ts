import type { RemoteSystemType } from './types';

export interface KubectlList<T> {
  apiVersion: string;
  items: T[];
}

export interface KubectlItem<T> {
  apiVersion: string;
  data: T;
}

export type K8sRuntimeStatus = 'available' | 'unavailable' | 'checking';

export interface K8sNamespace {
  name: string;
  status: string;
  age: string;
}

export interface K8sPod {
  name: string;
  namespace: string;
  status: string;
  nodeName: string;
  podIP: string;
  age: string;
  creationTimestamp: string;
  containers: number;
  readyContainers: number;
  restartCount: number;
  containerImages: string[];
}

export interface K8sPodContainer {
  name: string;
  image: string;
  state: string;
  stateDetail: string;
  ready: boolean;
  restartCount: number;
  ports: string;
}

export interface K8sPodCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface K8sPodEvent {
  type: string;
  reason: string;
  message: string;
  firstTimestamp: string;
  lastTimestamp: string;
  count: number;
  source: string;
}

export interface K8sPodDetail {
  pod: K8sPod;
  containers: K8sPodContainer[];
  conditions: K8sPodCondition[];
  events: K8sPodEvent[];
  labels: Record<string, string>;
  annotations: Record<string, string>;
  serviceAccount: string;
  qosClass: string;
  nodeName: string;
  hostIP: string;
  podIP: string;
}

export interface K8sNode {
  name: string;
  status: string;
  roles: string;
  internalIP: string;
  externalIP: string;
  osImage: string;
  kernelVersion: string;
  containerRuntime: string;
  kubeletVersion: string;
  age: string;
  creationTimestamp: string;
  cpuCapacity: string;
  memoryCapacity: string;
  podCapacity: string;
  cpuAllocatable: string;
  memoryAllocatable: string;
  podAllocatable: string;
  conditions: K8sNodeCondition[];
}

export interface K8sNodeCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastHeartbeatTime?: string;
}

export interface K8sContext {
  name: string;
  cluster: string;
  user: string;
  namespace: string;
  isCurrent: boolean;
}

export type WorkloadKind = 'deployment' | 'statefulset' | 'daemonset';

export interface K8sWorkloadSummary {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  desired: number;
  current: number;
  ready: number;
  upToDate: number;
  available?: number;
  age: string;
  creationTimestamp: string;
  images: string[];
  selector: string;
}

export interface K8sWorkloadDetail {
  summary: K8sWorkloadSummary;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  strategy: string;
  minReadySeconds: number;
  revisionHistoryLimit: number;
  conditions: string[];
  containers: K8sPodContainer[];
}

export interface K8sService {
  name: string;
  namespace: string;
  type: string;
  clusterIP: string;
  externalIP?: string;
  ports: string;
  selector: string;
  age: string;
}

export interface K8sConfigMap {
  name: string;
  namespace: string;
  dataKeys: string;
  dataCount: number;
  age: string;
}

export interface K8sSecret {
  name: string;
  namespace: string;
  type: string;
  dataCount: number;
  age: string;
}

export type K8sManagerTab = 'pods' | 'workloads' | 'services' | 'configmaps' | 'secrets' | 'nodes';
export type WorkloadSubTab = 'deployments' | 'statefulsets' | 'daemonsets';
export type PodFilter = 'all' | 'running' | 'pending' | 'succeeded' | 'failed';

export interface RemoteK8sManagerProps {
  connectionId: string;
  systemType: RemoteSystemType;
}
