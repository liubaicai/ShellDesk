import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import {
  createS3DeleteObjectCommand,
  createS3DetectCommand,
  createS3DownloadObjectCommand,
  createS3ListBucketsCommand,
  createS3ListObjectsCommand,
  createS3ObjectUrl,
  parseS3Buckets,
  parseS3Objects,
  type S3BucketEntry,
  type S3CliMode,
  type S3ConnectionConfig,
  type S3ObjectEntry,
} from './s3CliParsers';
import type { RemoteSystemType } from './types';

interface RemoteS3BrowserProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type S3Tab = 'objects' | 'raw';
type S3PendingActionKind = 'delete' | 'download';

interface PendingS3Action {
  kind: S3PendingActionKind;
  title: string;
  bucket: string;
  object: S3ObjectEntry;
  command: RemoteCommandInput;
  danger?: boolean;
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
    throw new Error('ShellDesk IPC 未就绪。');
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

function RemoteS3Browser({ connectionId, systemType }: RemoteS3BrowserProps) {
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
  const [activeTab, setActiveTab] = useState<S3Tab>('objects');
  const [rawOutput, setRawOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [objectLoading, setObjectLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
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

  const updateConfig = <Key extends keyof S3ConnectionConfig>(key: Key, value: S3ConnectionConfig[Key]) => {
    setConfig((currentConfig) => ({ ...currentConfig, [key]: value }));
  };

  const detectTools = useCallback(async () => {
    try {
      const result = await runCmd(connectionId, createS3DetectCommand(isWindowsHost));
      const tools = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((tool): tool is S3CliMode => tool === 'mc' || tool === 'aws');

      setAvailableTools(Array.from(new Set(tools)));
      if (tools.length && !tools.includes(mode)) {
        setMode(tools[0]);
      }
    } catch (error) {
      setNotice(getErrorMessage(error));
    }
  }, [connectionId, isWindowsHost, mode]);

  useEffect(() => {
    void detectTools();
  }, [detectTools]);

  const loadBuckets = async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, createS3ListBucketsCommand(mode, config, isWindowsHost));

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || `${mode} bucket 列表读取失败。`);
      }

      const nextBuckets = parseS3Buckets(mode, result.stdout);
      setConnected(true);
      setBuckets(nextBuckets);
      setSelectedBucketName((current) => current && nextBuckets.some((bucket) => bucket.name === current) ? current : nextBuckets[0]?.name ?? '');
      setObjects([]);
      setSelectedObjectKey('');
      setPrefix('');
      setRawOutput(result.stdout || result.stderr);
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(`已读取 ${nextBuckets.length} 个 bucket。`);
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
    setNotice('MinIO / S3 已断开。');
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

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || `${mode} 对象列表读取失败。`);
      }

      const nextObjects = parseS3Objects(mode, result.stdout, normalizedPrefix);
      setObjects(nextObjects);
      setSelectedBucketName(bucketName);
      setPrefix(normalizedPrefix);
      setSelectedObjectKey(nextObjects[0]?.key ?? '');
      setRawOutput(result.stdout || result.stderr);
      setActiveTab('objects');
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(`已读取 ${nextObjects.length} 个对象或前缀。`);
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
        title: `删除 ${object.key}`,
        bucket: selectedBucket.name,
        object,
        command: createS3DeleteObjectCommand(mode, config, selectedBucket.name, object.key, isWindowsHost),
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
        title: `下载 ${object.key}`,
        bucket: selectedBucket.name,
        object,
        command: createS3DownloadObjectCommand(mode, config, selectedBucket.name, object.key, downloadDirectory, isWindowsHost),
      });
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;

    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCmd(connectionId, pendingAction.command);
      const output = result.stdout || result.stderr || '操作已完成。';

      if (result.code !== 0) {
        throw new Error(output);
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
    setNotice('已复制对象 URL。');
  };

  return (
    <section className="s3-browser">
      <header className="s3-toolbar">
        <div className="s3-status-card">
          <span>对象存储</span>
          <strong>{selectedBucket?.name ?? 'MinIO / S3'}</strong>
          <em>{lastRefreshedAt || (availableTools.length ? `${availableTools.join(' / ')} 可用` : '等待检测')}</em>
        </div>
        <div className="s3-mode-switch">
          <button type="button" className={mode === 'mc' ? 'active' : ''} onClick={() => setMode('mc')}>mc</button>
          <button type="button" className={mode === 'aws' ? 'active' : ''} onClick={() => setMode('aws')}>aws</button>
        </div>
        <button type="button" onClick={detectTools}>检测工具</button>
        <button type="button" className="primary" onClick={loadBuckets} disabled={loading}>
          {loading ? '连接中' : connected ? '刷新 Buckets' : '连接 / Buckets'}
        </button>
        <button type="button" onClick={disconnect} disabled={!connected || loading}>
          断开
        </button>
      </header>

      {error ? <DismissibleAlert className="s3-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="s3-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className={`s3-layout ${connected ? 'connected' : ''}`}>
        {!connected ? (
          <aside className="s3-config">
            <div className="s3-config-head">
              <strong>连接配置</strong>
              <span>{mode === 'mc' ? 'MinIO Client' : 'AWS CLI'}</span>
            </div>
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
              <span>远程下载目录</span>
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
            {!buckets.length ? <div className="s3-empty-state">连接后显示 bucket。</div> : null}
          </div>
        </aside>

        <main className="s3-main">
          <div className="s3-addressbar">
            <button type="button" onClick={() => loadObjects(selectedBucket?.name ?? '', getParentPrefix(prefix))} disabled={!selectedBucket || !prefix}>上级</button>
            <button type="button" onClick={() => loadObjects(selectedBucket?.name ?? '', prefix)} disabled={!selectedBucket || objectLoading}>{objectLoading ? '刷新中' : '刷新'}</button>
            <div className="s3-breadcrumb">
              <button type="button" onClick={() => loadObjects(selectedBucket?.name ?? '', '')}>{selectedBucket?.name ?? 'bucket'}</button>
              {breadcrumbs.map((item) => (
                <button key={item.prefix} type="button" onClick={() => loadObjects(selectedBucket?.name ?? '', item.prefix)}>{item.label}</button>
              ))}
            </div>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索当前 prefix" />
          </div>

          <nav className="s3-tabs">
            <button type="button" className={activeTab === 'objects' ? 'active' : ''} onClick={() => setActiveTab('objects')}>对象</button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>原始输出</button>
            <button type="button" onClick={() => copyObjectUrl(selectedObject)} disabled={!selectedObject || selectedObject.type !== 'object'}>复制 URL</button>
          </nav>

          {activeTab === 'objects' ? (
            <section className="s3-table-wrap">
              <table className="s3-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>大小</th>
                    <th>修改时间</th>
                    <th>操作</th>
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
                          <button type="button" onClick={(event) => { event.stopPropagation(); openPrefix(object); }}>打开</button>
                        ) : (
                          <>
                            <button type="button" onClick={(event) => { event.stopPropagation(); prepareDownload(object); }}>下载</button>
                            <button type="button" onClick={(event) => { event.stopPropagation(); void copyObjectUrl(object); }}>URL</button>
                            <button type="button" className="danger" onClick={(event) => { event.stopPropagation(); prepareDelete(object); }}>删除</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!filteredObjects.length ? <tr><td colSpan={5} className="s3-empty-cell">当前 prefix 没有对象。</td></tr> : null}
                </tbody>
              </table>
            </section>
          ) : (
            <pre className="s3-raw-output">{rawOutput || '连接或刷新后显示原始 CLI 输出。'}</pre>
          )}
        </main>

        <aside className="s3-detail">
          <div className="s3-detail-head">
            <strong>对象详情</strong>
            <span>{selectedObject?.type ?? '-'}</span>
          </div>
          <dl>
            <div><dt>Bucket</dt><dd>{selectedBucket?.name ?? '-'}</dd></div>
            <div><dt>Key</dt><dd>{selectedObject?.key ?? '-'}</dd></div>
            <div><dt>名称</dt><dd>{selectedObject?.name ?? '-'}</dd></div>
            <div><dt>大小</dt><dd>{formatSize(selectedObject?.size)}</dd></div>
            <div><dt>修改时间</dt><dd>{formatDate(selectedObject?.lastModified)}</dd></div>
            <div><dt>Content-Type</dt><dd>{selectedObject?.contentType ?? '-'}</dd></div>
          </dl>
          <div className="s3-detail-note">
            首版通过远程 `mc` 或 `aws` CLI 工作；删除对象会先确认，下载会复制到远程主机指定目录。
          </div>
        </aside>
      </div>

      {pendingAction ? createPortal(
        <div className="s3-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`s3-confirm-dialog ${pendingAction.danger ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="s3-confirm-header">
              <span>{pendingAction.danger ? '危险操作确认' : '确认操作'}</span>
              <strong>{pendingAction.title}</strong>
            </div>
            <dl>
              <div><dt>Bucket</dt><dd>{pendingAction.bucket}</dd></div>
              <div><dt>Key</dt><dd>{pendingAction.object.key}</dd></div>
              <div><dt>模式</dt><dd>{mode}</dd></div>
              {pendingAction.kind === 'download' ? <div><dt>目标目录</dt><dd>{downloadDirectory}</dd></div> : null}
            </dl>
            <div className="s3-confirm-note">
              命令中包含访问凭据，ShellDesk 不在确认框展示完整命令。
            </div>
            <div className="s3-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>取消</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? '执行中' : '执行'}
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
