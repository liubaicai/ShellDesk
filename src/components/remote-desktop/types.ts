export type RemoteSystemType =
  | 'unknown'
  | 'windows'
  | 'ubuntu'
  | 'debian'
  | 'redhat'
  | 'centos'
  | 'fedora'
  | 'rocky'
  | 'almalinux'
  | 'oracle'
  | 'amazon'
  | 'arch'
  | 'manjaro'
  | 'alpine'
  | 'opensuse'
  | 'linuxmint'
  | 'kali'
  | 'raspbian'
  | 'gentoo'
  | 'nixos'
  | 'popos'
  | 'elementary'
  | 'linux'
  | 'unix';

export interface RemoteConnectionInfo {
  id: string;
  partition: string;
  proxyPort: number;
  connectedAt: string;
  host: {
    name: string;
    address: string;
    port: number;
    username: string;
    authMethod: 'password' | 'key' | 'agent';
    systemType?: RemoteSystemType;
    systemName?: string;
  };
}
