import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import { loadRemoteConnectionProfile, readProfileBoolean, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import {
  createS3DetectCommand,
  createS3DownloadObjectCommand,
  createS3DeleteObjectCommand,
  createS3EnsureMcCommand,
  createS3ListBucketsCommand,
  createS3ListObjectsCommand,
  createS3ObjectUrl,
  createS3UploadObjectCommand,
  parseS3Buckets,
  parseS3Objects,
  type S3BucketEntry,
  type S3CliMode,
  type S3ConnectionConfig,
  type S3ObjectEntry,
} from './s3CliParsers';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface RemoteS3BrowserProps {
  connectionId: string;
  hostId: string;
  systemType?: RemoteSystemType;
}

type S3Tab = 'objects' | 'raw';
type S3PendingActionKind = 'delete' | 'download';

interface PendingS3Action {
  kind: S3PendingActionKind;
  title: string;
  bucket: string;
  object: S3ObjectEntry;
  command?: RemoteCommandInput;
  danger?: boolean;
}

interface S3UploadItem {
  path: string;
  name: string;
}

const defaultConfig: S3ConnectionConfig = {
  endpoint: 'http://127.0.0.1:9000',
  accessKey: '',
  secretKey: '',
  region: 'us-east-1',
  pathStyle: true,
};

function runCmd(connectionId: string, input: RemoteCommandInput) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error(tCurrent('auto.remoteS3Browser.g77vf3'));
  }

  return api.runCommand(connectionId, input.command, input.stdin);
}

function formatSize(value?: number) {
  if (value === undefined) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDate(value?: string) {
  if (!value) return '-';
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toLocaleString(getShellDeskLocale());
}

function ensurePrefix(value: string) {
  const normalized = value.trim().replace(/^\/+/, '');
  return normalized && !normalized.endsWith('/') ? `${normalized}/` : normalized;
}

function getParentPrefix(prefix: string) {
  const parts = ensurePrefix(prefix).split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `${parts.join('/')}/` : '';
}

function createBreadcrumb(prefix: string) {
  const parts = ensurePrefix(prefix).split('/').filter(Boolean);
  return parts.map((part, index) => ({
    label: part,
    prefix: `${parts.slice(0, index + 1).join('/')}/`,
  }));
}

function sanitizeUploadName(name: string) {
  return name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'object.bin';
}

function joinRemotePath(directory: string, name: string, isWindowsHost: boolean) {
  const separator = isWindowsHost ? '\\' : '/';
  return `${directory.replace(/[\\/]+$/, '')}${separator}${name}`;
}

function getS3UploadTempDirectory(isWindowsHost: boolean) {
  return isWindowsHost ? 'C:\\Windows\\Temp\\shelldesk-s3-upload' : '/tmp/shelldesk-s3-upload';
}

function RemoteS3Browser({ connectionId, hostId, systemType }: RemoteS3BrowserProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [mode, setMode] = useState<S3CliMode>('mc');
  const [config, setConfig] = useState<S3ConnectionConfig>(defaultConfig);
  const [buckets, setBuckets] = useState<S3BucketEntry[]>([]);
  const [objects, setObjects] = useState<S3ObjectEntry[]>([]);
  const [selectedBucketName, setSelectedBucketName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [selectedObjectKey, setSelectedObjectKey] = useState('');
  const [search, setSearch] = useState('');
  const [downloadDirectory, setDownloadDirectory] = useState('/tmp');
  const [availableTools, setAvailableTools] = useState<S3CliMode[]>([]);
  const [toolsDetected, setToolsDetected] = useState(false);
  const [activeTab, setActiveTab] = useState<S3Tab>('objects');
  const [rawOutput, setRawOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [objectLoading, setObjectLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [detectingTools, setDetectingTools] = useState(false);
  const [installingMc, setInstallingMc] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const [uploadPrefix, setUploadPrefix] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingS3Action | null>(null);

  const selectedBucket = useMemo(() => {
    return buckets.find((bucket) => bucket.name === selectedBucketName) ?? buckets[0] ?? null;
  }, [buckets, selectedBucketName]);

  const filteredObjects = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return keyword ? objects.filter((object) => object.name.toLowerCase().includes(keyword) || object.key.toLowerCase().includes(keyword)) : objects;
  }, [objects, search]);

  const selectedObject = useMemo(() => {
    return objects.find((object) => object.key === selectedObjectKey) ?? objects.find((object) => object.type === 'object') ?? objects[0] ?? null;
  }, [objects, selectedObjectKey]);

  const breadcrumbs = useMemo(() => createBreadcrumb(prefix), [prefix]);
  const modeDetected = !toolsDetected || availableTools.includes(mode);
  const toolStatusText = detectingTools
    ? '正在检测 S3 CLI'
    : toolsDetected
      ? (availableTools.length ? `已检测: ${availableTools.join(' / ')}` : '未检测到 S3 CLI')
      : '等待检测 S3 CLI';

  const updateConfig = <Key extends keyof S3ConnectionConfig>(key: Key, value: S3ConnectionConfig[Key]) => {
    setConfig((currentConfig) => ({ ...currentConfig, [key]: value }));
  };

  useEffect(() => {
    let disposed = false;

    void loadRemoteConnectionProfile(hostId, 's3-browser').then((profile) => {
      if (disposed || !profile) return;

      const nextMode = readProfileString(profile, 'mode', 'mc');
      setMode(nextMode === 'aws' ? 'aws' : 'mc');
      setConfig({
        endpoint: readProfileString(profile, 'endpoint', defaultConfig.endpoint),
        accessKey: readProfileString(profile, 'accessKey', defaultConfig.accessKey),
        secretKey: readProfileString(profile, 'secretKey', defaultConfig.secretKey),
        region: readProfileString(profile, 'region', defaultConfig.region),
        pathStyle: readProfileBoolean(profile, 'pathStyle', defaultConfig.pathStyle),
      });
    });

    return () => {
      disposed = true;
    };
  }, [hostId]);

  const detectTools = useCallback(async () => {
    setDetectingTools(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, createS3DetectCommand(isWindowsHost));
      const detectedTools = Array.from(new Set(
        (result.stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim().toLowerCase())
          .filter((tool): tool is S3CliMode => tool === 'mc' || tool === 'aws'),
      ));

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || 'S3 CLI 检测失败');
      }

      setAvailableTools(detectedTools);
      setToolsDetected(true);
      setNotice(detectedTools.length ? `已检测到 S3 工具: ${detectedTools.join(' / ')}` : '未检测到 mc 或 aws，请先安装命令行工具。');
    } catch (error) {
      setToolsDetected(true);
      setAvailableTools([]);
      setError(getErrorMessage(error));
    } finally {
      setDetectingTools(false);
    }
  }, [connectionId, isWindowsHost]);

  useEffect(() => {
    void detectTools();
  }, [detectTools]);

  const installMc = useCallback(async () => {
    try {
      setInstallingMc(true);
      const command = createS3EnsureMcCommand(isWindowsHost);
      const result = await runCmd(connectionId, command);

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || 'mc 安装失败');
      }

      const versionLine = (result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse()
        .find((line) => /^mc\s+version/i.test(line) || /^mc\s+/i.test(line));
      setNotice(`mc 已就绪${versionLine ? `: ${versionLine}` : ''}`);
      await detectTools();
    } catch (error) {
      throw new Error(`mc 命令不可用且自动安装失败: ${getErrorMessage(error)}。请手动安装 mc 或切换到 aws 模式。`);
    } finally {
      setInstallingMc(false);
    }
  }, [connectionId, detectTools, isWindowsHost]);

  const ensureMcAvailable = useCallback(async () => {
    if (mode !== 'mc') return;
    await installMc();
  }, [installMc, mode]);

  const loadBuckets = async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, createS3ListBucketsCommand(mode, config, isWindowsHost));
      const output = result.stdout || result.stderr || '';
      setRawOutput(output);

      if (result.code !== 0) {
        throw new Error(output || 'Bucket 列表加载失败');
      }

      const nextBuckets = parseS3Buckets(mode, result.stdout || '');
      setConnected(true);
      setBuckets(nextBuckets);
      setSelectedBucketName((current) => current && nextBuckets.some((bucket) => bucket.name === current) ? current : nextBuckets[0]?.name ?? '');
      setObjects([]);
      setSelectedObjectKey('');
      setPrefix('');
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(tCurrent('auto.remoteS3Browser.rp1fyr', { value0: nextBuckets.length }));
      void saveRemoteConnectionProfile(hostId, 's3-browser', {
        mode,
        endpoint: config.endpoint,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        region: config.region,
        pathStyle: config.pathStyle,
      }).catch(() => undefined);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const disconnect = () => {
    setConnected(false);
    setBuckets([]);
    setObjects([]);
    setSelectedBucketName('');
    setSelectedObjectKey('');
    setPrefix('');
    setSearch('');
    setRawOutput('');
    setLastRefreshedAt('');
    setError('');
    setNotice(tCurrent('auto.remoteS3Browser.1veqr5f'));
    setActiveTab('objects');
  };

  const loadObjects = useCallback(async (bucketName = selectedBucket?.name ?? '', nextPrefix = prefix) => {
    if (!bucketName) {
      setObjects([]);
      return;
    }

    setObjectLoading(true);
    setError('');
    setNotice('');

    try {
      const normalizedPrefix = ensurePrefix(nextPrefix);
      const result = await runCmd(connectionId, createS3ListObjectsCommand(mode, config, bucketName, normalizedPrefix, isWindowsHost));
      const output = result.stdout || result.stderr || '';
      setRawOutput(output);

      if (result.code !== 0) {
        throw new Error(output || '对象列表加载失败');
      }

      const nextObjects = parseS3Objects(mode, result.stdout || '', normalizedPrefix);
      setObjects(nextObjects);
      setSelectedBucketName(bucketName);
      setPrefix(normalizedPrefix);
      setSelectedObjectKey(nextObjects[0]?.key ?? '');
      setActiveTab('objects');
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(tCurrent('auto.remoteS3Browser.1s0sz3e', { value0: nextObjects.length }));
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setObjectLoading(false);
    }
  }, [config, connectionId, isWindowsHost, mode, prefix, selectedBucket?.name]);

  const openBucket = (bucketName: string) => {
    void loadObjects(bucketName, '');
  };

  const openPrefix = (object: S3ObjectEntry) => {
    if (object.type !== 'prefix') return;
    void loadObjects(selectedBucket?.name ?? '', ensurePrefix(object.key));
  };

  const prepareDelete = (object: S3ObjectEntry) => {
    if (!selectedBucket || object.type !== 'object') return;

    try {
      setPendingAction({
        kind: 'delete',
        title: tCurrent('auto.remoteS3Browser.1i54laq', { value0: object.key }),
        bucket: selectedBucket.name,
        object,
        danger: true,
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const prepareDownload = (object: S3ObjectEntry) => {
    if (!selectedBucket || object.type !== 'object') return;

    try {
      setPendingAction({
        kind: 'download',
        title: tCurrent('auto.remoteS3Browser.6mkll2', { value0: object.key }),
        bucket: selectedBucket.name,
        object,
        command: createS3DownloadObjectCommand(mode, config, selectedBucket.name, object.key, downloadDirectory, isWindowsHost),
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const uploadItemsToBucket = useCallback(async (items: S3UploadItem[]) => {
    if (!selectedBucket) {
      throw new Error('请先选择 bucket');
    }

    if (!items.length) {
      return;
    }

    const api = window.guiSSH?.connections;
    if (!api) {
      throw new Error(tCurrent('auto.remoteS3Browser.g77vf3'));
    }

    setUploading(true);
    setError('');
    setNotice('');

    try {
      await ensureMcAvailable();
      const targetPrefix = ensurePrefix(uploadPrefix || prefix);
      const tempDirectory = getS3UploadTempDirectory(isWindowsHost);
      const localItems = items.map((item) => ({
        path: item.path,
        remoteName: sanitizeUploadName(item.name),
      }));

      await api.createDirectory(connectionId, tempDirectory).catch(() => undefined);
      const uploadResult = await api.uploadLocalPaths(connectionId, tempDirectory, localItems);
      if (uploadResult.canceled) {
        setNotice('已取消上传');
        return;
      }

      const remotePaths = uploadResult.remotePaths?.length === localItems.length
        ? uploadResult.remotePaths
        : localItems.map((item) => joinRemotePath(tempDirectory, item.remoteName ?? 'object.bin', isWindowsHost));

      for (let index = 0; index < localItems.length; index += 1) {
        const remotePath = remotePaths[index];
        const objectKey = `${targetPrefix}${localItems[index].remoteName ?? 'object.bin'}`;
        const command = createS3UploadObjectCommand(mode, config, selectedBucket.name, objectKey, remotePath, isWindowsHost);
        const result = await runCmd(connectionId, command);
        if (result.code !== 0) {
          throw new Error(result.stderr || result.stdout || `上传 ${objectKey} 失败`);
        }
        await api.deletePath(connectionId, remotePath, 'file').catch(() => undefined);
      }

      setNotice(`已上传 ${localItems.length} 个对象到 ${selectedBucket.name}/${targetPrefix}`);
      await loadObjects(selectedBucket.name, targetPrefix);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setUploading(false);
    }
  }, [config, connectionId, ensureMcAvailable, isWindowsHost, loadObjects, mode, prefix, selectedBucket, uploadPrefix]);

  const selectUploadFiles = async () => {
    try {
      const result = await window.guiSSH?.connections.selectUploadFiles();
      if (!result || result.canceled) return;
      await uploadItemsToBucket(result.items.filter((item) => item.type === 'file').map((item) => ({
        path: item.path,
        name: item.name,
      })));
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const dropUploadFiles = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragActive(false);

    const files = Array.from(event.dataTransfer.files)
      .map((file) => ({
        path: (file as File & { path?: string }).path ?? '',
        name: file.name,
      }))
      .filter((item) => item.path);

    if (!files.length) {
      setError('当前 WebView 未暴露拖拽文件路径，请使用“选择文件”上传。');
      return;
    }

    await uploadItemsToBucket(files);
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;

    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      let output = tCurrent('auto.remoteS3Browser.1m6h6ak');

      if (pendingAction.kind === 'delete') {
        const result = await runCmd(connectionId, createS3DeleteObjectCommand(mode, config, pendingAction.bucket, pendingAction.object.key, isWindowsHost));
        output = result.stdout || result.stderr || output;

        if (result.code !== 0) {
          throw new Error(output);
        }
      } else if (pendingAction.command) {
        if (pendingAction.kind === 'download') {
          await ensureMcAvailable();
        }
        const result = await runCmd(connectionId, pendingAction.command);
        output = result.stdout || result.stderr || output;

        if (result.code !== 0) {
          throw new Error(output);
        }
      }

      setNotice(output);
      setRawOutput(output);
      const actionKind = pendingAction.kind;
      setPendingAction(null);

      if (actionKind === 'delete') {
        await loadObjects(pendingAction.bucket, prefix);
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const copyObjectUrl = async (object?: S3ObjectEntry | null) => {
    if (!selectedBucket || !object || object.type !== 'object') return;

    await navigator.clipboard.writeText(createS3ObjectUrl(config, selectedBucket.name, object.key));
    setNotice(tCurrent('auto.remoteS3Browser.1e8pmj5'));
  };

  return (
    <section className="s3-browser">
      <header className="s3-toolbar">
        <div className="s3-status-card">
          <span>{tCurrent('auto.remoteS3Browser.1vc65bb')}</span>
          <strong>{selectedBucket?.name ?? 'MinIO / S3'}</strong>
          <em>{lastRefreshedAt || toolStatusText}</em>
        </div>
        <div className="s3-mode-switch">
          <button type="button" className={mode === 'mc' ? 'active' : ''} onClick={() => setMode('mc')}>mc</button>
          <button type="button" className={mode === 'aws' ? 'active' : ''} onClick={() => setMode('aws')}>aws</button>
        </div>
        <button type="button" onClick={detectTools} disabled={detectingTools}>{detectingTools ? '检测中' : tCurrent('auto.remoteS3Browser.93b684')}</button>
        <button type="button" className="primary" onClick={loadBuckets} disabled={loading || !modeDetected}>
          {loading ? tCurrent('auto.remoteS3Browser.h7vocz') : connected ? tCurrent('auto.remoteS3Browser.nabcrd') : tCurrent('auto.remoteS3Browser.1u8k4u')}
        </button>
        <button type="button" onClick={disconnect} disabled={!connected || loading}>
          {tCurrent('auto.remoteS3Browser.a4u4dk')}</button>
      </header>

      {error ? <DismissibleAlert className="s3-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="s3-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className={`s3-layout ${connected ? 'connected' : ''}`}>
        {!connected ? (
          <aside className="s3-config">
            <div className="s3-config-head">
              <strong>{tCurrent('auto.remoteS3Browser.1qcyuf')}</strong>
              <span>{mode === 'mc' ? 'MinIO Client' : 'AWS CLI'} · {toolsDetected ? (modeDetected ? '已检测' : '未安装') : '检测中'}</span>
            </div>
            {toolsDetected && !availableTools.includes('mc') ? (
              <div className="s3-tool-help">
                <strong>未检测到 mc</strong>
                <button type="button" className="primary" onClick={() => { void installMc().catch((error) => setError(getErrorMessage(error))); }} disabled={installingMc}>
                  {installingMc ? '正在安装 mc' : '一键安装 mc'}
                </button>
              </div>
            ) : null}
            {toolsDetected && !availableTools.includes('aws') ? (
              <div className="s3-tool-help">
                <strong>未检测到 aws</strong>
                <span>Linux: curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && unzip awscliv2.zip && sudo ./aws/install</span>
                <span>macOS: curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg" && sudo installer -pkg AWSCLIV2.pkg -target /</span>
                <span>Windows: https://aws.amazon.com/cli/</span>
              </div>
            ) : null}
            <label>
              <span>Endpoint</span>
              <input value={config.endpoint} onChange={(event) => updateConfig('endpoint', event.target.value)} placeholder="http://127.0.0.1:9000" />
            </label>
            <label>
              <span>Access Key</span>
              <input value={config.accessKey} onChange={(event) => updateConfig('accessKey', event.target.value)} />
            </label>
            <label>
              <span>Secret Key</span>
              <input type="password" value={config.secretKey} onChange={(event) => updateConfig('secretKey', event.target.value)} />
            </label>
            <label>
              <span>Region</span>
              <input value={config.region} onChange={(event) => updateConfig('region', event.target.value)} />
            </label>
            <label className="s3-check-row">
              <input type="checkbox" checked={config.pathStyle} onChange={(event) => updateConfig('pathStyle', event.target.checked)} />
              <span>Path-style URL</span>
            </label>
            <label>
              <span>{tCurrent('auto.remoteS3Browser.1srg6m9')}</span>
              <input value={downloadDirectory} onChange={(event) => setDownloadDirectory(event.target.value)} />
            </label>
          </aside>
        ) : null}

        <aside className="s3-bucket-list">
          <div className="s3-panel-head">
            <strong>Buckets</strong>
            <span>{buckets.length}</span>
          </div>
          <div className="s3-bucket-scroll">
            {buckets.map((bucket) => (
              <button
                key={bucket.name}
                type="button"
                className={selectedBucket?.name === bucket.name ? 'active' : ''}
                onClick={() => openBucket(bucket.name)}
              >
                <strong>{bucket.name}</strong>
                <span>{formatDate(bucket.createdAt)}</span>
              </button>
            ))}
            {!buckets.length ? <div className="s3-empty-state">{tCurrent('auto.remoteS3Browser.xiyqv6')}</div> : null}
          </div>
        </aside>

        <main className="s3-main">
          <div className="s3-addressbar">
            <button type="button" onClick={() => loadObjects(selectedBucket?.name ?? '', getParentPrefix(prefix))} disabled={!selectedBucket || !prefix}>{tCurrent('auto.remoteS3Browser.1cs0t8u')}</button>
            <button type="button" onClick={() => loadObjects(selectedBucket?.name ?? '', prefix)} disabled={!selectedBucket || objectLoading}>{objectLoading ? tCurrent('auto.remoteS3Browser.1taxqz1') : tCurrent('auto.remoteS3Browser.12qo56a')}</button>
            <div className="s3-breadcrumb">
              <button type="button" onClick={() => loadObjects(selectedBucket?.name ?? '', '')}>{selectedBucket?.name ?? 'bucket'}</button>
              {breadcrumbs.map((item) => (
                <button key={item.prefix} type="button" onClick={() => loadObjects(selectedBucket?.name ?? '', item.prefix)}>{item.label}</button>
              ))}
            </div>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tCurrent('auto.remoteS3Browser.5fs9hd')} />
          </div>

          <nav className="s3-tabs">
            <button type="button" className={activeTab === 'objects' ? 'active' : ''} onClick={() => setActiveTab('objects')}>{tCurrent('auto.remoteS3Browser.1hptjin')}</button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>{tCurrent('auto.remoteS3Browser.1sxtwbe')}</button>
            <button type="button" onClick={() => copyObjectUrl(selectedObject)} disabled={!selectedObject || selectedObject.type !== 'object'}>{tCurrent('auto.remoteS3Browser.19gy30v')}</button>
            <button type="button" className="primary" onClick={selectUploadFiles} disabled={!selectedBucket || uploading}>{uploading ? '上传中' : '上传'}</button>
          </nav>

          {activeTab === 'objects' ? (
            <section
              className={`s3-table-wrap ${dragActive ? 'drag-active' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={dropUploadFiles}
            >
              <div className="s3-upload-strip">
                <div>
                  <strong>{dragActive ? '松开以上传对象' : '拖拽文件上传到当前目录'}</strong>
                  <span>{selectedBucket ? `${selectedBucket.name}/${ensurePrefix(uploadPrefix || prefix)}` : '请选择 bucket'}</span>
                </div>
                <label>
                  <span>目标前缀</span>
                  <input value={uploadPrefix} onChange={(event) => setUploadPrefix(event.target.value)} placeholder={prefix || '例如 logs/'} />
                </label>
              </div>
              <table className="s3-table">
                <thead>
                  <tr>
                    <th>{tCurrent('auto.remoteS3Browser.hzx914')}</th>
                    <th>{tCurrent('auto.remoteS3Browser.anh4cj')}</th>
                    <th>{tCurrent('auto.remoteS3Browser.1i41a3v')}</th>
                    <th>{tCurrent('auto.remoteS3Browser.gdxblm')}</th>
                    <th>{tCurrent('auto.remoteS3Browser.501w24')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredObjects.map((object) => (
                    <tr
                      key={`${object.type}:${object.key}`}
                      className={selectedObject?.key === object.key ? 'selected' : ''}
                      onClick={() => setSelectedObjectKey(object.key)}
                      onDoubleClick={() => openPrefix(object)}
                    >
                      <td title={object.key}><strong>{object.type === 'prefix' ? `${object.name}/` : object.name}</strong></td>
                      <td><span className={`s3-kind ${object.type}`}>{object.type === 'prefix' ? 'Prefix' : 'Object'}</span></td>
                      <td>{formatSize(object.size)}</td>
                      <td>{formatDate(object.lastModified)}</td>
                      <td>
                        {object.type === 'prefix' ? (
                          <button type="button" onClick={(event) => { event.stopPropagation(); openPrefix(object); }}>{tCurrent('auto.remoteS3Browser.2lh37q')}</button>
                        ) : (
                          <>
                            <button type="button" onClick={(event) => { event.stopPropagation(); prepareDownload(object); }}>{tCurrent('auto.remoteS3Browser.1osfjit')}</button>
                            <button type="button" onClick={(event) => { event.stopPropagation(); void copyObjectUrl(object); }}>URL</button>
                            <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); prepareDelete(object); }}>{tCurrent('auto.remoteS3Browser.1t2vi4h')}</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!filteredObjects.length ? <tr><td colSpan={5} className="s3-empty-cell">{tCurrent('auto.remoteS3Browser.c96qxh')}</td></tr> : null}
                </tbody>
              </table>
            </section>
          ) : (
            <pre className="s3-raw-output">{rawOutput || tCurrent('auto.remoteS3Browser.tzh8so')}</pre>
          )}
        </main>

        <aside className="s3-detail">
          <div className="s3-detail-head">
            <strong>{tCurrent('auto.remoteS3Browser.1ja60i2')}</strong>
            <span>{selectedObject?.type ?? '-'}</span>
          </div>
          <dl>
            <div><dt>Bucket</dt><dd>{selectedBucket?.name ?? '-'}</dd></div>
            <div><dt>Key</dt><dd>{selectedObject?.key ?? '-'}</dd></div>
            <div><dt>{tCurrent('auto.remoteS3Browser.hzx9142')}</dt><dd>{selectedObject?.name ?? '-'}</dd></div>
            <div><dt>{tCurrent('auto.remoteS3Browser.1i41a3v2')}</dt><dd>{formatSize(selectedObject?.size)}</dd></div>
            <div><dt>{tCurrent('auto.remoteS3Browser.gdxblm2')}</dt><dd>{formatDate(selectedObject?.lastModified)}</dd></div>
            <div><dt>Content-Type</dt><dd>{selectedObject?.contentType ?? '-'}</dd></div>
          </dl>
          <div className="s3-detail-note">
            {tCurrent('auto.remoteS3Browser.ulgymz')}</div>
        </aside>
      </div>

      {pendingAction ? createPortal(
        <div className="s3-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`s3-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="s3-confirm-header">
              <span>{pendingAction.danger ? tCurrent('auto.remoteS3Browser.ts3yek') : tCurrent('auto.remoteS3Browser.1gm39ou')}</span>
              <strong>{pendingAction.title}</strong>
            </div>
            <dl>
              <div><dt>Bucket</dt><dd>{pendingAction.bucket}</dd></div>
              <div><dt>Key</dt><dd>{pendingAction.object.key}</dd></div>
              <div><dt>{tCurrent('auto.remoteS3Browser.10317x5')}</dt><dd>{mode}</dd></div>
              {pendingAction.kind === 'download' ? <div><dt>{tCurrent('auto.remoteS3Browser.1k5xqpv')}</dt><dd>{downloadDirectory}</dd></div> : null}
            </dl>
            <div className="s3-confirm-note">
              {tCurrent('auto.remoteS3Browser.14cndvr')}</div>
            <div className="s3-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteS3Browser.1589w37')}</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? tCurrent('auto.remoteS3Browser.6svkbt') : tCurrent('auto.remoteS3Browser.6azgji')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default RemoteS3Browser;
