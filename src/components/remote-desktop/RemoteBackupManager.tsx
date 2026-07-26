import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import backupManagerIcon from '../../assets/desktop-icons/backup-manager.png';
import { getCurrentAppLocale, tCurrent } from '../../i18n';
import DismissibleAlert from './DismissibleAlert';
import {
  createBackupCommand,
  createBackupToolDetectionCommand,
  createDeleteBackupCommand,
  createDeleteBackupPlanCommand,
  createListBackupPlansCommand,
  createListBackupsCommand,
  createRestoreBackupCommand,
  createSaveBackupPlanCommand,
  createValidateBackupCommand,
  defaultUnixBackupDirectory,
  defaultWindowsBackupDirectory,
  getBackupCommandPreview,
} from './backupCommands';
import {
  parseBackupEntries,
  parseBackupPlans,
  parseBackupValidation,
  parseCreatedBackupPath,
  parseDetectedBackupTools,
} from './backupParsers';
import type {
  BackupDraft,
  BackupEntry,
  BackupPlan,
  BackupPlanDraft,
  BackupS3Target,
  BackupSourceType,
  BackupTransferTarget,
  BackupValidationResult,
} from './backupTypes';
import { getErrorMessage } from './desktopUtils';
import {
  loadRemoteConnectionProfile,
  readProfileBoolean,
  readProfileString,
  saveRemoteConnectionProfile,
} from './remoteConnectionProfiles';
import { isWindowsSystem } from './remoteSystem';
import { createS3UploadObjectCommand } from './s3CliParsers';
import { getCachedSudoOptions, useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';

interface RemoteBackupManagerProps {
  connectionId: string;
  hostId: string;
  systemType?: RemoteSystemType;
  onOpenScheduledTasks?: () => void;
}

type BackupTab = 'create' | 'history' | 'plans';
type PendingAction =
  | { kind: 'delete-backup'; entry: BackupEntry }
  | { kind: 'restore'; entry: BackupEntry }
  | { kind: 'delete-plan'; plan: BackupPlan };

const sourceTypes: BackupSourceType[] = ['files', 'mysql', 'postgres', 'mongo', 'sqlite'];
const transferTargets: BackupTransferTarget[] = ['remote', 'local', 's3'];
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const sourceDefaultPorts: Partial<Record<BackupSourceType, string>> = {
  mysql: '3306',
  postgres: '5432',
  mongo: '27017',
};
const requiredTools: Record<BackupSourceType, string[]> = {
  files: ['tar'],
  mysql: ['mysqldump', 'gzip', 'mysql'],
  postgres: ['pg_dump', 'pg_restore'],
  mongo: ['mongodump', 'mongorestore'],
  sqlite: ['sqlite3'],
};

function createDefaultDraft(isWindowsHost: boolean): BackupDraft {
  return {
    label: 'production',
    sourceType: 'files',
    sourcePath: isWindowsHost ? 'C:\\Data' : '/var/www',
    database: 'app',
    databaseHost: '127.0.0.1',
    databasePort: '3306',
    databaseUsername: '',
    databasePassword: '',
    mongoAuthDatabase: 'admin',
    remoteDirectory: isWindowsHost ? defaultWindowsBackupDirectory : defaultUnixBackupDirectory,
    incremental: false,
    transferTarget: 'remote',
  };
}

function createDefaultS3Target(): BackupS3Target {
  return {
    mode: 'mc',
    endpoint: 'https://s3.example.com',
    accessKey: '',
    secretKey: '',
    region: 'us-east-1',
    pathStyle: true,
    bucket: '',
    prefix: 'shelldesk',
  };
}

function createDefaultPlanDraft(): BackupPlanDraft {
  return {
    cronExpression: '0 2 * * *',
    frequency: 'daily',
    time: '02:00',
    weekday: 'Sunday',
  };
}

function isSourceType(value: string): value is BackupSourceType {
  return sourceTypes.includes(value as BackupSourceType);
}

function isTransferTarget(value: string): value is BackupTransferTarget {
  return transferTargets.includes(value as BackupTransferTarget);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaledValue = value / (1024 ** unitIndex);
  return `${scaledValue >= 10 || unitIndex === 0 ? scaledValue.toFixed(0) : scaledValue.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value || '-'
    : new Intl.DateTimeFormat(getCurrentAppLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function getRemoteFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function getResultText(result: { stdout: string; stderr: string; code: number }) {
  return [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
}

function BackupGlyph({ name }: { name: 'archive' | 'database' | 'folder' | 'history' | 'schedule' | 'shield' }) {
  const paths = {
    archive: <><path d="M4 7.5h16v12H4z" /><path d="M3 4.5h18v3H3zM9 12h6" /></>,
    database: <><ellipse cx="12" cy="5.5" rx="7" ry="3" /><path d="M5 5.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6M5 11.5v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
    folder: <path d="M3.5 6.5h6l2-2h9v15h-17z" />,
    history: <><path d="M4.5 8a8 8 0 1 1-.2 7" /><path d="M4.5 3.5V8H9M12 8v4l3 2" /></>,
    schedule: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16M8 14h3" /></>,
    shield: <><path d="M12 3.5 19 6v5.5c0 4.4-2.8 7.4-7 9-4.2-1.6-7-4.6-7-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function RemoteBackupManager({
  connectionId,
  hostId,
  systemType,
  onOpenScheduledTasks,
}: RemoteBackupManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, runCommandStream, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const [activeTab, setActiveTab] = useState<BackupTab>('create');
  const [draft, setDraft] = useState<BackupDraft>(() => createDefaultDraft(isWindowsHost));
  const [s3Target, setS3Target] = useState<BackupS3Target>(createDefaultS3Target);
  const [planDraft, setPlanDraft] = useState<BackupPlanDraft>(createDefaultPlanDraft);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [plans, setPlans] = useState<BackupPlan[]>([]);
  const [detectedTools, setDetectedTools] = useState<string[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  const [selectedBackupPath, setSelectedBackupPath] = useState('');
  const [restorePath, setRestorePath] = useState(isWindowsHost ? '$env:USERPROFILE\\shelldesk-restore' : '$HOME/shelldesk-restore');
  const [validation, setValidation] = useState<{ entryName: string; result: BackupValidationResult } | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [planRunning, setPlanRunning] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [streamOutput, setStreamOutput] = useState('');
  const initialRefreshDoneRef = useRef(false);

  const commandPreview = useMemo(() => getBackupCommandPreview(draft), [draft]);
  const filteredBackups = useMemo(() => {
    const searchText = historySearch.trim().toLowerCase();
    return searchText
      ? backups.filter((entry) => entry.name.toLowerCase().includes(searchText) || entry.kind.includes(searchText))
      : backups;
  }, [backups, historySearch]);
  const selectedBackup = useMemo(
    () => backups.find((entry) => entry.path === selectedBackupPath) ?? backups[0] ?? null,
    [backups, selectedBackupPath],
  );
  const relevantTools = requiredTools[draft.sourceType];
  const availableRelevantTools = relevantTools.filter((tool) => detectedTools.includes(tool));

  const updateDraft = <Key extends keyof BackupDraft>(key: Key, value: BackupDraft[Key]) => {
    setDraft((currentDraft) => ({ ...currentDraft, [key]: value }));
  };
  const updateS3Target = <Key extends keyof BackupS3Target>(key: Key, value: BackupS3Target[Key]) => {
    setS3Target((currentTarget) => ({ ...currentTarget, [key]: value }));
  };

  useEffect(() => {
    let disposed = false;
    void loadRemoteConnectionProfile(hostId, 'backup-manager').then((profile) => {
      if (disposed) return;
      if (profile) {
        const sourceTypeValue = readProfileString(profile, 'sourceType', 'files');
        const transferTargetValue = readProfileString(profile, 'transferTarget', 'remote');
        setDraft((currentDraft) => ({
          ...currentDraft,
          label: readProfileString(profile, 'label', currentDraft.label),
          sourceType: isSourceType(sourceTypeValue) ? sourceTypeValue : currentDraft.sourceType,
          sourcePath: readProfileString(profile, 'sourcePath', currentDraft.sourcePath),
          database: readProfileString(profile, 'database', currentDraft.database),
          databaseHost: readProfileString(profile, 'databaseHost', currentDraft.databaseHost),
          databasePort: readProfileString(profile, 'databasePort', currentDraft.databasePort),
          databaseUsername: readProfileString(profile, 'databaseUsername', currentDraft.databaseUsername),
          mongoAuthDatabase: readProfileString(profile, 'mongoAuthDatabase', currentDraft.mongoAuthDatabase),
          remoteDirectory: readProfileString(profile, 'remoteDirectory', currentDraft.remoteDirectory),
          incremental: readProfileBoolean(profile, 'incremental', currentDraft.incremental),
          transferTarget: isTransferTarget(transferTargetValue) ? transferTargetValue : currentDraft.transferTarget,
        }));
        const s3Mode = readProfileString(profile, 's3Mode', 'mc');
        setS3Target((currentTarget) => ({
          ...currentTarget,
          mode: s3Mode === 'aws' ? 'aws' : 'mc',
          endpoint: readProfileString(profile, 's3Endpoint', currentTarget.endpoint),
          region: readProfileString(profile, 's3Region', currentTarget.region),
          bucket: readProfileString(profile, 's3Bucket', currentTarget.bucket),
          prefix: readProfileString(profile, 's3Prefix', currentTarget.prefix),
          pathStyle: readProfileBoolean(profile, 's3PathStyle', currentTarget.pathStyle),
        }));
      }
      setProfileReady(true);
    });
    return () => {
      disposed = true;
    };
  }, [hostId]);

  const persistNonSecretProfile = useCallback(async () => {
    await saveRemoteConnectionProfile(hostId, 'backup-manager', {
      label: draft.label,
      sourceType: draft.sourceType,
      sourcePath: draft.sourcePath,
      database: draft.database,
      databaseHost: draft.databaseHost,
      databasePort: draft.databasePort,
      databaseUsername: draft.databaseUsername,
      mongoAuthDatabase: draft.mongoAuthDatabase,
      remoteDirectory: draft.remoteDirectory,
      incremental: draft.incremental,
      transferTarget: draft.transferTarget,
      s3Mode: s3Target.mode,
      s3Endpoint: s3Target.endpoint,
      s3Region: s3Target.region,
      s3Bucket: s3Target.bucket,
      s3Prefix: s3Target.prefix,
      s3PathStyle: s3Target.pathStyle,
    }).catch(() => undefined);
  }, [draft, hostId, s3Target]);

  const loadBackups = useCallback(async () => {
    const result = await runCommand(createListBackupsCommand(draft.remoteDirectory, isWindowsHost));
    if (result.code !== 0) throw new Error(getResultText(result));
    const nextBackups = parseBackupEntries(result.stdout, isWindowsHost);
    setBackups(nextBackups);
    setSelectedBackupPath((currentPath) => (
      nextBackups.some((entry) => entry.path === currentPath) ? currentPath : nextBackups[0]?.path ?? ''
    ));
  }, [draft.remoteDirectory, isWindowsHost, runCommand]);

  const loadPlans = useCallback(async () => {
    const result = await runCommand(createListBackupPlansCommand(isWindowsHost));
    if (result.code !== 0) throw new Error(getResultText(result));
    setPlans(parseBackupPlans(result.stdout, isWindowsHost));
  }, [isWindowsHost, runCommand]);

  const detectTools = useCallback(async () => {
    const result = await runCommand(createBackupToolDetectionCommand(isWindowsHost));
    if (result.code !== 0) throw new Error(getResultText(result));
    setDetectedTools(parseDetectedBackupTools(result.stdout));
  }, [isWindowsHost, runCommand]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await Promise.all([detectTools(), loadBackups(), loadPlans()]);
    } catch (loadError) {
      setError(tCurrent('auto.backupManager.error.load', { value0: getErrorMessage(loadError) }));
    } finally {
      setLoading(false);
    }
  }, [detectTools, loadBackups, loadPlans]);

  useEffect(() => {
    if (profileReady && !initialRefreshDoneRef.current) {
      initialRefreshDoneRef.current = true;
      void refreshAll();
    }
  }, [profileReady, refreshAll]);

  const appendStreamOutput = useCallback((chunk: string, stream: 'stdout' | 'stderr') => {
    if (!chunk) return;
    setStreamOutput((currentOutput) => `${currentOutput}${stream === 'stderr' ? '[stderr] ' : ''}${chunk}`.slice(-24_000));
  }, []);

  const uploadBackupToS3 = async (remotePath: string) => {
    if (!s3Target.endpoint.trim() || !s3Target.accessKey.trim() || !s3Target.secretKey.trim() || !s3Target.bucket.trim()) {
      throw new Error(tCurrent('auto.backupManager.error.s3Config'));
    }
    const api = window.guiSSH?.connections;
    if (!api) throw new Error(tCurrent('auto.backupManager.error.noApi'));
    const fileName = getRemoteFileName(remotePath);
    const normalizedPrefix = s3Target.prefix.trim().replace(/^\/+|\/+$/g, '');
    const objectKey = normalizedPrefix ? `${normalizedPrefix}/${fileName}` : fileName;
    const generatedInput = createS3UploadObjectCommand(s3Target.mode, s3Target, s3Target.bucket, objectKey, remotePath, isWindowsHost);
    const input = !isWindowsHost && !generatedInput.stdin
      ? { command: 'sh -s', stdin: `set -eu\n${generatedInput.command}` }
      : generatedInput;
    const result = await api.runCommand(connectionId, input.command, input.stdin);
    if (result.code !== 0) throw new Error(getResultText(result));
    setNotice(tCurrent('auto.backupManager.notice.s3Uploaded', { value0: `${s3Target.bucket}/${objectKey}` }));
  };

  const runBackup = async () => {
    setRunning(true);
    setError('');
    setNotice('');
    setStreamOutput('');
    try {
      const command = createBackupCommand(draft, isWindowsHost);
      const result = await runCommandStream(command.input, undefined, { onChunk: appendStreamOutput });
      const resultText = getResultText(result);
      if (resultText) setStreamOutput((currentOutput) => currentOutput || resultText);
      if (result.code !== 0) throw new Error(getResultText(result));
      const remotePath = parseCreatedBackupPath(result.stdout);
      if (!remotePath) throw new Error(tCurrent('auto.backupManager.error.noCreatedPath'));
      setNotice(tCurrent('auto.backupManager.notice.created', { value0: getRemoteFileName(remotePath) }));

      if (draft.transferTarget === 'local') {
        const api = window.guiSSH?.connections;
        if (!api) throw new Error(tCurrent('auto.backupManager.error.noApi'));
        const downloadResult = await api.downloadFile(connectionId, remotePath, getCachedSudoOptions(connectionId));
        setNotice(tCurrent(downloadResult.canceled
          ? 'auto.backupManager.notice.downloadCanceled'
          : 'auto.backupManager.notice.localDownloaded'));
      } else if (draft.transferTarget === 's3') {
        await uploadBackupToS3(remotePath);
      }

      await persistNonSecretProfile();
      await loadBackups();
      setActiveTab('history');
    } catch (actionError) {
      setError(tCurrent('auto.backupManager.error.action', { value0: getErrorMessage(actionError) }));
    } finally {
      setRunning(false);
    }
  };

  const validateBackup = async (entry: BackupEntry) => {
    setRunning(true);
    setError('');
    setNotice('');
    try {
      const result = await runCommand(createValidateBackupCommand(entry, isWindowsHost));
      if (result.code !== 0) throw new Error(getResultText(result));
      const validationResult = parseBackupValidation(result.stdout);
      setValidation({ entryName: entry.name, result: validationResult });
      setSelectedBackupPath(entry.path);
      setNotice(tCurrent('auto.backupManager.notice.validated', { value0: entry.name }));
    } catch (actionError) {
      setError(tCurrent('auto.backupManager.error.action', { value0: getErrorMessage(actionError) }));
    } finally {
      setRunning(false);
    }
  };

  const downloadBackup = async (entry: BackupEntry) => {
    setRunning(true);
    setError('');
    setNotice('');
    try {
      const api = window.guiSSH?.connections;
      if (!api) throw new Error(tCurrent('auto.backupManager.error.noApi'));
      const result = await api.downloadFile(connectionId, entry.path, getCachedSudoOptions(connectionId));
      setNotice(tCurrent(result.canceled
        ? 'auto.backupManager.notice.downloadCanceled'
        : 'auto.backupManager.notice.localDownloaded'));
    } catch (actionError) {
      setError(tCurrent('auto.backupManager.error.action', { value0: getErrorMessage(actionError) }));
    } finally {
      setRunning(false);
    }
  };

  const savePlan = async () => {
    setPlanRunning(true);
    setError('');
    setNotice('');
    try {
      const result = await runCommand(createSaveBackupPlanCommand(draft, planDraft, isWindowsHost));
      if (result.code !== 0) throw new Error(getResultText(result));
      await persistNonSecretProfile();
      await loadPlans();
      setNotice(tCurrent('auto.backupManager.notice.planSaved', { value0: draft.label }));
    } catch (actionError) {
      setError(tCurrent('auto.backupManager.error.action', { value0: getErrorMessage(actionError) }));
    } finally {
      setPlanRunning(false);
    }
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;
    setRunning(true);
    setError('');
    setNotice('');
    try {
      if (pendingAction.kind === 'delete-backup') {
        const result = await runCommand(createDeleteBackupCommand(pendingAction.entry, isWindowsHost));
        if (result.code !== 0) throw new Error(getResultText(result));
        await loadBackups();
        setNotice(tCurrent('auto.backupManager.notice.deleted', { value0: pendingAction.entry.name }));
      } else if (pendingAction.kind === 'delete-plan') {
        const result = await runCommand(createDeleteBackupPlanCommand(pendingAction.plan.id, isWindowsHost));
        if (result.code !== 0) throw new Error(getResultText(result));
        await loadPlans();
        setNotice(tCurrent('auto.backupManager.notice.planDeleted', { value0: pendingAction.plan.label }));
      } else {
        setStreamOutput('');
        const validationResult = await runCommand(createValidateBackupCommand(pendingAction.entry, isWindowsHost));
        if (validationResult.code !== 0) throw new Error(getResultText(validationResult));
        setValidation({ entryName: pendingAction.entry.name, result: parseBackupValidation(validationResult.stdout) });
        const restoreCommand = createRestoreBackupCommand(pendingAction.entry, draft, restorePath, isWindowsHost);
        const result = await runCommandStream(restoreCommand.input, undefined, { onChunk: appendStreamOutput });
        if (result.code !== 0) throw new Error(getResultText(result));
        setNotice(tCurrent('auto.backupManager.notice.restored', {
          value0: pendingAction.entry.kind === 'files' || pendingAction.entry.kind === 'sqlite' ? restorePath : draft.database,
        }));
      }
    } catch (actionError) {
      setError(tCurrent('auto.backupManager.error.action', { value0: getErrorMessage(actionError) }));
    } finally {
      setPendingAction(null);
      setRunning(false);
    }
  };

  const selectSourceType = (sourceType: BackupSourceType) => {
    setDraft((currentDraft) => ({
      ...currentDraft,
      sourceType,
      databasePort: sourceDefaultPorts[sourceType] ?? currentDraft.databasePort,
      incremental: sourceType === 'files' ? currentDraft.incremental : false,
    }));
  };

  const openRestoreConfirmation = (entry: BackupEntry) => {
    if (entry.kind === 'sqlite') {
      setRestorePath(isWindowsHost ? '$env:USERPROFILE\\shelldesk-restored.sqlite3' : '$HOME/shelldesk-restored.sqlite3');
    } else if (entry.kind === 'files') {
      setRestorePath(isWindowsHost ? '$env:USERPROFILE\\shelldesk-restore' : '$HOME/shelldesk-restore');
    }
    setPendingAction({ kind: 'restore', entry });
  };

  const pendingTitle = pendingAction?.kind === 'delete-backup'
    ? tCurrent('auto.backupManager.confirm.deleteTitle')
    : pendingAction?.kind === 'delete-plan'
      ? tCurrent('auto.backupManager.confirm.planTitle')
      : tCurrent('auto.backupManager.confirm.restoreTitle');
  const pendingText = pendingAction?.kind === 'delete-backup'
    ? tCurrent('auto.backupManager.confirm.deleteText', { value0: pendingAction.entry.name })
    : pendingAction?.kind === 'delete-plan'
      ? tCurrent('auto.backupManager.confirm.planText', { value0: pendingAction.plan.label })
      : pendingAction?.kind === 'restore'
        ? tCurrent('auto.backupManager.confirm.restoreText', {
          value0: pendingAction.entry.name,
          value1: pendingAction.entry.kind === 'files' || pendingAction.entry.kind === 'sqlite' ? restorePath : draft.database,
        })
        : '';

  return (
    <section className="backup-manager">
      <header className="backup-manager-header">
        <div className="backup-manager-heading">
          <img src={backupManagerIcon} alt="" />
          <div>
            <h2>{tCurrent('auto.backupManager.title')}</h2>
            <p>{tCurrent('auto.backupManager.subtitle')}</p>
          </div>
        </div>
        <div className="backup-manager-header-actions">
          <span className="backup-manager-health"><i />{tCurrent('auto.backupManager.ready')}</span>
          <button type="button" onClick={() => void refreshAll()} disabled={loading || running}>
            {loading ? tCurrent('auto.backupManager.refreshing') : tCurrent('auto.backupManager.refresh')}
          </button>
        </div>
      </header>

      <div className="backup-manager-stats">
        <article><BackupGlyph name="history" /><span>{tCurrent('auto.backupManager.stats.backups')}</span><strong>{backups.length}</strong></article>
        <article><BackupGlyph name="schedule" /><span>{tCurrent('auto.backupManager.stats.plans')}</span><strong>{plans.length}</strong></article>
        <article><BackupGlyph name="shield" /><span>{tCurrent('auto.backupManager.stats.tools')}</span><strong>{detectedTools.length}</strong></article>
        <article className="path-stat"><BackupGlyph name="folder" /><span>{tCurrent('auto.backupManager.stats.storage')}</span><strong title={draft.remoteDirectory}>{draft.remoteDirectory}</strong></article>
      </div>

      <nav className="backup-manager-tabs" role="tablist" aria-label={tCurrent('auto.backupManager.tabsLabel')}>
        {(['create', 'history', 'plans'] as BackupTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={activeTab === tab ? 'active' : ''}
            onClick={() => setActiveTab(tab)}
          >
            <BackupGlyph name={tab === 'create' ? 'archive' : tab === 'history' ? 'history' : 'schedule'} />
            {tCurrent(`auto.backupManager.tab.${tab}`)}
          </button>
        ))}
      </nav>

      {error ? <DismissibleAlert className="backup-manager-alert error" onDismiss={() => setError('')}>{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="backup-manager-alert success" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="backup-manager-content">
        {activeTab === 'create' ? (
          <div className="backup-create-layout">
            <div className="backup-create-main">
              <section className="backup-card source-card">
                <div className="backup-card-heading">
                  <div><strong>{tCurrent('auto.backupManager.source.title')}</strong><span>{tCurrent('auto.backupManager.source.hint')}</span></div>
                </div>
                <div className="backup-source-grid">
                  {sourceTypes.map((sourceType) => (
                    <button
                      key={sourceType}
                      type="button"
                      aria-pressed={draft.sourceType === sourceType}
                      className={draft.sourceType === sourceType ? 'active' : ''}
                      onClick={() => selectSourceType(sourceType)}
                    >
                      <BackupGlyph name={sourceType === 'files' ? 'folder' : 'database'} />
                      <span>{tCurrent(`auto.backupManager.source.${sourceType}`)}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="backup-card backup-form-card">
                <div className="backup-form-grid">
                  <label>
                    <span>{tCurrent('auto.backupManager.field.name')}</span>
                    <input value={draft.label} onChange={(event) => updateDraft('label', event.target.value)} placeholder={tCurrent('auto.backupManager.field.namePlaceholder')} />
                  </label>
                  <label className="wide">
                    <span>{tCurrent('auto.backupManager.field.remoteDirectory')}</span>
                    <input value={draft.remoteDirectory} onChange={(event) => updateDraft('remoteDirectory', event.target.value)} />
                  </label>
                  {draft.sourceType === 'files' || draft.sourceType === 'sqlite' ? (
                    <label className="wide">
                      <span>{tCurrent('auto.backupManager.field.sourcePath')}</span>
                      <input value={draft.sourcePath} onChange={(event) => updateDraft('sourcePath', event.target.value)} placeholder={tCurrent('auto.backupManager.field.sourcePathPlaceholder')} />
                    </label>
                  ) : (
                    <>
                      <label>
                        <span>{tCurrent('auto.backupManager.field.host')}</span>
                        <input value={draft.databaseHost} onChange={(event) => updateDraft('databaseHost', event.target.value)} />
                      </label>
                      <label>
                        <span>{tCurrent('auto.backupManager.field.port')}</span>
                        <input inputMode="numeric" value={draft.databasePort} onChange={(event) => updateDraft('databasePort', event.target.value)} />
                      </label>
                      <label>
                        <span>{tCurrent('auto.backupManager.field.database')}</span>
                        <input value={draft.database} onChange={(event) => updateDraft('database', event.target.value)} />
                      </label>
                      <label>
                        <span>{tCurrent('auto.backupManager.field.username')}</span>
                        <input autoComplete="username" value={draft.databaseUsername} onChange={(event) => updateDraft('databaseUsername', event.target.value)} />
                      </label>
                      <label>
                        <span>{tCurrent('auto.backupManager.field.password')}</span>
                        <input type="password" autoComplete="off" value={draft.databasePassword} onChange={(event) => updateDraft('databasePassword', event.target.value)} placeholder={tCurrent('auto.backupManager.field.passwordPlaceholder')} />
                      </label>
                      {draft.sourceType === 'mongo' ? (
                        <label>
                          <span>{tCurrent('auto.backupManager.field.authDatabase')}</span>
                          <input value={draft.mongoAuthDatabase} onChange={(event) => updateDraft('mongoAuthDatabase', event.target.value)} />
                        </label>
                      ) : null}
                    </>
                  )}
                </div>
                {draft.sourceType === 'files' ? (
                  <label className={`backup-toggle-row ${isWindowsHost ? 'disabled' : ''}`}>
                    <input type="checkbox" checked={draft.incremental} disabled={isWindowsHost} onChange={(event) => updateDraft('incremental', event.target.checked)} />
                    <span><strong>{tCurrent('auto.backupManager.incremental')}</strong><small>{tCurrent('auto.backupManager.incrementalHint')}</small></span>
                  </label>
                ) : null}
              </section>

              <section className="backup-card transfer-card">
                <div className="backup-card-heading"><div><strong>{tCurrent('auto.backupManager.transfer.title')}</strong></div></div>
                <div className="backup-segmented">
                  {transferTargets.map((target) => (
                    <button key={target} type="button" className={draft.transferTarget === target ? 'active' : ''} onClick={() => updateDraft('transferTarget', target)}>
                      {tCurrent(`auto.backupManager.transfer.${target}`)}
                    </button>
                  ))}
                </div>
                {draft.transferTarget === 's3' ? (
                  <div className="backup-s3-panel">
                    <div className="backup-form-grid">
                      <label>
                        <span>{tCurrent('auto.backupManager.s3.mode')}</span>
                        <select value={s3Target.mode} onChange={(event) => updateS3Target('mode', event.target.value === 'aws' ? 'aws' : 'mc')}>
                          <option value="mc">MinIO Client (mc)</option>
                          <option value="aws">AWS CLI</option>
                        </select>
                      </label>
                      <label className="wide">
                        <span>{tCurrent('auto.backupManager.s3.endpoint')}</span>
                        <input value={s3Target.endpoint} onChange={(event) => updateS3Target('endpoint', event.target.value)} placeholder="https://s3.example.com" />
                      </label>
                      <label>
                        <span>{tCurrent('auto.backupManager.s3.accessKey')}</span>
                        <input type="password" autoComplete="off" value={s3Target.accessKey} onChange={(event) => updateS3Target('accessKey', event.target.value)} />
                      </label>
                      <label>
                        <span>{tCurrent('auto.backupManager.s3.secretKey')}</span>
                        <input type="password" autoComplete="off" value={s3Target.secretKey} onChange={(event) => updateS3Target('secretKey', event.target.value)} />
                      </label>
                      <label>
                        <span>{tCurrent('auto.backupManager.s3.bucket')}</span>
                        <input value={s3Target.bucket} onChange={(event) => updateS3Target('bucket', event.target.value)} />
                      </label>
                      <label>
                        <span>{tCurrent('auto.backupManager.s3.prefix')}</span>
                        <input value={s3Target.prefix} onChange={(event) => updateS3Target('prefix', event.target.value)} />
                      </label>
                      <label>
                        <span>{tCurrent('auto.backupManager.s3.region')}</span>
                        <input value={s3Target.region} onChange={(event) => updateS3Target('region', event.target.value)} />
                      </label>
                      <label className="backup-inline-check">
                        <input type="checkbox" checked={s3Target.pathStyle} onChange={(event) => updateS3Target('pathStyle', event.target.checked)} />
                        <span>{tCurrent('auto.backupManager.s3.pathStyle')}</span>
                      </label>
                    </div>
                    <p className="backup-security-note"><BackupGlyph name="shield" />{tCurrent('auto.backupManager.s3.sessionOnly')}</p>
                  </div>
                ) : null}
              </section>
            </div>

            <aside className="backup-create-aside">
              <section className="backup-card backup-preview-card">
                <div className="backup-card-heading"><div><strong>{tCurrent('auto.backupManager.preview.title')}</strong><span>{tCurrent('auto.backupManager.preview.hint')}</span></div></div>
                <code>{commandPreview}</code>
                <button type="button" className="backup-primary-action" onClick={() => void runBackup()} disabled={running || loading}>
                  <BackupGlyph name="archive" />
                  {running ? tCurrent('auto.backupManager.creating') : tCurrent('auto.backupManager.create')}
                </button>
              </section>
              <section className="backup-card backup-tools-card">
                <div className="backup-card-heading"><div><strong>{tCurrent('auto.backupManager.tools.title')}</strong><span>{availableRelevantTools.length}/{relevantTools.length}</span></div></div>
                <div className="backup-tool-list">
                  {relevantTools.map((tool) => {
                    const available = detectedTools.includes(tool);
                    return <div key={tool}><code>{tool}</code><span className={available ? 'available' : 'missing'}>{tCurrent(available ? 'auto.backupManager.tools.available' : 'auto.backupManager.tools.missing')}</span></div>;
                  })}
                </div>
              </section>
              <section className="backup-card backup-output-card">
                <div className="backup-card-heading"><div><strong>{tCurrent('auto.backupManager.output.title')}</strong></div></div>
                <pre>{streamOutput || tCurrent('auto.backupManager.output.empty')}</pre>
              </section>
            </aside>
          </div>
        ) : null}

        {activeTab === 'history' ? (
          <div className="backup-history-layout">
            <section className="backup-card backup-history-card">
              <div className="backup-history-toolbar">
                <div><strong>{tCurrent('auto.backupManager.history.title')}</strong><span>{tCurrent('auto.backupManager.history.hint')}</span></div>
                <div>
                  <input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder={tCurrent('auto.backupManager.history.search')} />
                  <button type="button" onClick={() => void loadBackups()} disabled={running || loading}>{tCurrent('auto.backupManager.refresh')}</button>
                </div>
              </div>
              <div className="backup-table-frame">
                <table>
                  <thead><tr>
                    <th>{tCurrent('auto.backupManager.history.name')}</th>
                    <th>{tCurrent('auto.backupManager.history.type')}</th>
                    <th>{tCurrent('auto.backupManager.history.size')}</th>
                    <th>{tCurrent('auto.backupManager.history.modified')}</th>
                    <th>{tCurrent('auto.backupManager.history.actions')}</th>
                  </tr></thead>
                  <tbody>
                    {filteredBackups.map((entry) => (
                      <tr key={entry.path} className={selectedBackup?.path === entry.path ? 'selected' : ''} onClick={() => setSelectedBackupPath(entry.path)}>
                        <td><span className="backup-file-icon"><BackupGlyph name={entry.kind === 'files' ? 'folder' : 'database'} /></span><span><strong>{entry.name}</strong><small title={entry.path}>{entry.path}</small></span></td>
                        <td><span className={`backup-kind kind-${entry.kind}`}>{tCurrent(`auto.backupManager.source.${entry.kind}`)}</span></td>
                        <td>{formatBytes(entry.size)}</td>
                        <td>{formatDate(entry.modifiedAt)}</td>
                        <td>
                          <div className="backup-row-actions">
                            <button type="button" onClick={(event) => { event.stopPropagation(); void validateBackup(entry); }} disabled={running}>{tCurrent('auto.backupManager.action.validate')}</button>
                            <button type="button" onClick={(event) => { event.stopPropagation(); void downloadBackup(entry); }} disabled={running}>{tCurrent('auto.backupManager.action.download')}</button>
                            <button type="button" onClick={(event) => { event.stopPropagation(); openRestoreConfirmation(entry); }} disabled={running}>{tCurrent('auto.backupManager.action.restore')}</button>
                            <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); setPendingAction({ kind: 'delete-backup', entry }); }} disabled={running}>{tCurrent('auto.backupManager.action.delete')}</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!filteredBackups.length ? <tr><td colSpan={5} className="backup-empty-cell">{tCurrent('auto.backupManager.history.empty')}</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </section>
            <aside className="backup-history-aside">
              <section className="backup-card backup-validation-card">
                <div className="backup-card-heading"><div><strong>{tCurrent('auto.backupManager.validation.title')}</strong><span>{validation?.entryName ?? selectedBackup?.name ?? '-'}</span></div><BackupGlyph name="shield" /></div>
                {validation ? (
                  <dl>
                    <div><dt>{tCurrent('auto.backupManager.validation.checksum')}</dt><dd title={validation.result.checksum}>{validation.result.checksum}</dd></div>
                    <div><dt>{tCurrent('auto.backupManager.validation.detail')}</dt><dd>{validation.result.detail}</dd></div>
                  </dl>
                ) : <p>{tCurrent('auto.backupManager.validation.none')}</p>}
              </section>
              <section className="backup-card backup-output-card">
                <div className="backup-card-heading"><div><strong>{tCurrent('auto.backupManager.output.title')}</strong></div></div>
                <pre>{streamOutput || tCurrent('auto.backupManager.output.empty')}</pre>
              </section>
            </aside>
          </div>
        ) : null}

        {activeTab === 'plans' ? (
          <div className="backup-plans-layout">
            <section className="backup-card backup-plan-editor">
              <div className="backup-card-heading"><div><strong>{tCurrent('auto.backupManager.plans.title')}</strong><span>{tCurrent('auto.backupManager.plans.hint')}</span></div></div>
              <p className="backup-security-note"><BackupGlyph name="shield" />{tCurrent('auto.backupManager.plans.security')}</p>
              <div className="backup-plan-fields">
                {isWindowsHost ? (
                  <>
                    <label>
                      <span>{tCurrent('auto.backupManager.plans.frequency')}</span>
                      <select value={planDraft.frequency} onChange={(event) => setPlanDraft({ ...planDraft, frequency: event.target.value === 'weekly' ? 'weekly' : 'daily' })}>
                        <option value="daily">{tCurrent('auto.backupManager.plans.daily')}</option>
                        <option value="weekly">{tCurrent('auto.backupManager.plans.weekly')}</option>
                      </select>
                    </label>
                    <label>
                      <span>{tCurrent('auto.backupManager.plans.time')}</span>
                      <input type="time" value={planDraft.time} onChange={(event) => setPlanDraft({ ...planDraft, time: event.target.value })} />
                    </label>
                    {planDraft.frequency === 'weekly' ? (
                      <label>
                        <span>{tCurrent('auto.backupManager.plans.weekday')}</span>
                        <select value={planDraft.weekday} onChange={(event) => setPlanDraft({ ...planDraft, weekday: event.target.value })}>
                          {weekdays.map((weekday) => <option key={weekday} value={weekday}>{tCurrent(`auto.backupManager.weekday.${weekday}`)}</option>)}
                        </select>
                      </label>
                    ) : null}
                  </>
                ) : (
                  <label className="wide">
                    <span>{tCurrent('auto.backupManager.plans.cron')}</span>
                    <input value={planDraft.cronExpression} onChange={(event) => setPlanDraft({ ...planDraft, cronExpression: event.target.value })} placeholder="0 2 * * *" />
                  </label>
                )}
              </div>
              <div className="backup-plan-actions">
                {onOpenScheduledTasks ? <button type="button" onClick={onOpenScheduledTasks}>{tCurrent('auto.backupManager.plans.openScheduled')}</button> : null}
                <button type="button" className="primary" onClick={() => void savePlan()} disabled={planRunning || running}>
                  {planRunning ? tCurrent('auto.backupManager.plans.saving') : tCurrent('auto.backupManager.plans.save')}
                </button>
              </div>
            </section>
            <section className="backup-card backup-plan-list-card">
              <div className="backup-card-heading"><div><strong>{tCurrent('auto.backupManager.plans.title')}</strong><span>{plans.length}</span></div></div>
              <div className="backup-plan-list">
                {plans.map((plan) => (
                  <article key={plan.id}>
                    <span className="backup-plan-icon"><BackupGlyph name="schedule" /></span>
                    <div><strong>{plan.label}</strong><small>{tCurrent(`auto.backupManager.source.${plan.sourceType}`)} · {plan.schedule}</small></div>
                    <span className={plan.enabled ? 'enabled' : 'disabled'}>{tCurrent(plan.enabled ? 'auto.backupManager.plans.enabled' : 'auto.backupManager.plans.disabled')}</span>
                    <button type="button" className="danger" onClick={() => setPendingAction({ kind: 'delete-plan', plan })} disabled={running}>{tCurrent('auto.backupManager.action.delete')}</button>
                  </article>
                ))}
                {!plans.length ? <div className="backup-empty-state"><BackupGlyph name="schedule" /><span>{tCurrent('auto.backupManager.plans.empty')}</span></div> : null}
              </div>
            </section>
          </div>
        ) : null}
      </div>

      {sudoPrompt}
      {pendingAction ? createPortal(
        <div className="backup-confirm-overlay" role="presentation" onMouseDown={() => !running && setPendingAction(null)}>
          <div className="backup-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="backup-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="backup-confirm-icon"><BackupGlyph name={pendingAction.kind === 'restore' ? 'history' : 'shield'} /></div>
            <div>
              <h3 id="backup-confirm-title">{pendingTitle}</h3>
              <p>{pendingText}</p>
            </div>
            {pendingAction.kind === 'restore' && (pendingAction.entry.kind === 'files' || pendingAction.entry.kind === 'sqlite') ? (
              <label>
                <span>{tCurrent('auto.backupManager.field.restorePath')}</span>
                <input value={restorePath} onChange={(event) => setRestorePath(event.target.value)} autoFocus />
              </label>
            ) : null}
            <div className="backup-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)} disabled={running}>{tCurrent('common.cancel')}</button>
              <button type="button" className={pendingAction.kind === 'restore' ? 'primary' : 'danger'} onClick={() => void executePendingAction()} disabled={running}>
                {running ? tCurrent('auto.backupManager.working') : tCurrent('auto.backupManager.confirm.execute')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default RemoteBackupManager;
