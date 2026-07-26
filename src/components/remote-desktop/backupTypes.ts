import type { S3CliMode, S3ConnectionConfig } from './s3CliParsers';
import type { RemoteCommandInput } from './remoteSystem';

export type BackupSourceType = 'files' | 'mysql' | 'postgres' | 'mongo' | 'sqlite';
export type BackupTransferTarget = 'remote' | 'local' | 's3';
export type BackupPlanFrequency = 'daily' | 'weekly';

export interface BackupDraft {
  label: string;
  sourceType: BackupSourceType;
  sourcePath: string;
  database: string;
  databaseHost: string;
  databasePort: string;
  databaseUsername: string;
  databasePassword: string;
  mongoAuthDatabase: string;
  remoteDirectory: string;
  incremental: boolean;
  transferTarget: BackupTransferTarget;
}

export interface BackupS3Target extends S3ConnectionConfig {
  mode: S3CliMode;
  bucket: string;
  prefix: string;
}

export interface BackupEntry {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  kind: BackupSourceType;
}

export interface BackupPlan {
  id: string;
  label: string;
  sourceType: BackupSourceType;
  schedule: string;
  enabled: boolean;
  scriptPath?: string;
}

export interface BackupCommand {
  input: RemoteCommandInput;
  preview: string;
  kind: BackupSourceType;
}

export interface BackupPlanDraft {
  cronExpression: string;
  frequency: BackupPlanFrequency;
  time: string;
  weekday: string;
}

export interface BackupValidationResult {
  checksum: string;
  detail: string;
}
