import type { RemoteSystemType } from './types';

export type FrpcProxyType = 'tcp' | 'udp' | 'http' | 'https' | 'stcp' | 'xtcp';
export type FrpcServiceMode = 'systemd' | 'process';
export type FrpcProxyStatus = 'active' | 'inactive' | 'error' | 'unknown';

export interface FrpcServerConfig {
  serverAddr: string;
  serverPort: number;
  token: string;
}

export interface FrpcProxy {
  name: string;
  type: FrpcProxyType;
  localIP: string;
  localPort: number;
  remotePort?: number;
  customDomains?: string[];
  subDomain?: string;
  secretKey?: string;
  encryption?: boolean;
  compression?: boolean;
  locations?: string[];
  status?: FrpcProxyStatus;
  connections?: number;
  trafficIn?: number;
  trafficOut?: number;
}

export interface FrpcConfig {
  server: FrpcServerConfig;
  proxies: FrpcProxy[];
}

export interface FrpcStatus {
  installed: boolean;
  version: string;
  running: boolean;
  serviceMode: FrpcServiceMode;
  configPath: string;
  adminAddr?: string;
  adminPort?: number;
}

export interface FrpManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}
