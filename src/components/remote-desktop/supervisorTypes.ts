import type { RemoteSystemType } from './types';

export type SupervisorProcessState =
  | 'running'
  | 'starting'
  | 'stopping'
  | 'stopped'
  | 'exited'
  | 'fatal'
  | 'backoff'
  | 'unknown';

export type SupervisorAction = 'start' | 'stop' | 'restart' | 'reload';
export type SupervisorLogStream = 'stdout' | 'stderr';

export interface SupervisorProcess {
  name: string;
  group: string;
  processName: string;
  state: SupervisorProcessState;
  pid: number | null;
  uptime: string;
  description: string;
}

export interface SupervisorRuntime {
  installed: boolean;
  executable: string;
  version: string;
  running: boolean;
  statusMessage: string;
  configFiles: string[];
}

export interface SupervisorManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}
