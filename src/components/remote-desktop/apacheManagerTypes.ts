export type ApacheDistro = 'debian' | 'rhel' | 'alpine' | 'unknown';
export type ApacheSitesLayout = 'debian' | 'rhel';
export type ApacheSiteFilter = 'all' | 'enabled' | 'disabled' | 'ssl' | 'non-ssl';

export interface ApacheInstallation {
  version: string;
  configPath: string;
  configDir: string;
  modulesDir: string;
  availableDir: string | null;
  enabledDir: string | null;
  confDir: string;
  logDir: string;
  binaryPath: string;
  distro: ApacheDistro;
  sitesLayout: ApacheSitesLayout;
  isRunning: boolean;
  loadedModules: string[];
}

export interface ApacheVirtualHost {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  serverName: string;
  serverAlias: string[];
  documentRoot: string;
  listenPorts: string[];
  sslConfig: ApacheSslConfig | null;
  directives: ApacheDirective[];
  isEnabled: boolean;
  enabledPath: string | null;
}

export interface ApacheSslConfig {
  certificateFile: string;
  certificateKeyFile: string;
  chainFile: string | null;
}

export interface ApacheDirective {
  name: string;
  value: string;
  line: number;
}

export interface ApacheConfigFile {
  filename: string;
  fullPath: string;
  rawContent: string;
  virtualHosts: ApacheVirtualHost[];
  lastModified: number;
  fileSize: number;
}

export interface ApacheTestResult {
  success: boolean;
  output: string;
}

export type ApacheTemplateValidationErrorId =
  | 'required'
  | 'unsupportedCharacters'
  | 'spacesOrQuotes'
  | 'invalidUrl'
  | 'invalidPort'
  | 'invalidNumber';

export interface ApacheTemplateValidationResult {
  valid: boolean;
  errorId?: ApacheTemplateValidationErrorId;
  value?: string;
}

export interface ApacheTemplateVariable {
  name: string;
  label: string;
  description: string;
  type: 'text' | 'port' | 'number' | 'select';
  default: string;
  required: boolean;
  options?: string[];
  validate?: (value: string) => ApacheTemplateValidationResult;
}

export interface ApacheConfigTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  variables: ApacheTemplateVariable[];
  render: (values: Record<string, string>) => string;
}
