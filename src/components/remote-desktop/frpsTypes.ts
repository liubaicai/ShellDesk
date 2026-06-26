import type { RemoteSystemType } from './types';

export type FrpsServiceMode = 'systemd' | 'process';

export interface FrpsConfig {
  bindAddr: string;
  bindPort: number;
  token: string;
  vhostHTTPPort: number;
  vhostHTTPSPort: number;
  subDomainHost: string;
  dashboardAddr: string;
  dashboardPort: number;
  dashboardUser: string;
  dashboardPassword: string;
  logTo: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  logMaxDays: number;
  maxPoolCount: number;
  tcpMux: boolean;
}

export interface FrpsProxyInfo {
  name: string;
  type: string;
  status: 'online' | 'offline';
  clientAddr: string;
  lastStartTime?: string;
  lastCloseTime?: string;
  trafficIn?: number;
  trafficOut?: number;
  curConns?: number;
}

export interface FrpsStatus {
  installed: boolean;
  version: string;
  running: boolean;
  serviceMode: FrpsServiceMode;
  configPath: string;
}

export interface FrpsManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}
