export type RemoteSystemType =
  | 'unknown'
  | 'windows'
  | 'macos'
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
  kind?: 'ssh' | 'local';
  partition: string;
  proxyPort: number;
  connectedAt: string;
  host: {
    id?: string;
    name: string;
    address: string;
    port: number;
    username: string;
    authMethod: 'password' | 'key' | 'agent';
    privilegeMode?: 'sudo' | 'su-root';
    systemType?: RemoteSystemType;
    systemName?: string;
    jumpHost?: {
      id: string;
      name: string;
      address: string;
      port: number;
      username: string;
    };
  };
}
