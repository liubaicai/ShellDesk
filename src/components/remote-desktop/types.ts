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
    authMethod: 'password' | 'key';
  };
}
