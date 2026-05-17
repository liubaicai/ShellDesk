import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage } from './desktopUtils';

interface RemoteRedisProps {
  connectionId: string;
}

type RedisStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface RedisKeyEntry {
  name: string;
  type: string;
  ttl: number;
}

const defaultPort = 6379;
const pageSize = 200;

function formatTtl(ttl: number): string {
  if (ttl === -1) return '永不过期';
  if (ttl === -2) return '已过期';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`;
  return `${Math.floor(ttl / 86400)}d`;
}

function RemoteRedis({ connectionId }: RemoteRedisProps) {
  const api = window.guiSSH;
  const [status, setStatus] = useState<RedisStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [redisId, setRedisId] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(String(defaultPort));
  const [password, setPassword] = useState('');
  const [dbNum, setDbNum] = useState('0');
  const [keyPattern, setKeyPattern] = useState('*');
  const [keys, setKeys] = useState<RedisKeyEntry[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [keyValue, setKeyValue] = useState<{ type: string; value: unknown } | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [cmdLine, setCmdLine] = useState('');
  const [cmdResult, setCmdResult] = useState<string | null>(null);
  const [cmdError, setCmdError] = useState('');
  const [cmdRunning, setCmdRunning] = useState(false);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysPage, setKeysPage] = useState(0);
  const [keyEditorValue, setKeyEditorValue] = useState('');
  const cmdLineRef = useRef<HTMLInputElement | null>(null);
  const keyEditorRef = useRef<HTMLTextAreaElement | null>(null);

  const isReady = status === 'connected';

  const handleConnect = useCallback(async () => {
    if (!api?.connections) return;
    setStatus('connecting');
    setErrorMessage('');
    try {
      const result = await api.connections.redisConnect(connectionId, {
        host: host || '127.0.0.1',
        port: parseInt(port, 10) || defaultPort,
        password,
        db: parseInt(dbNum, 10) || 0,
      });
      setRedisId(result.redisId);
      setStatus('connected');
    } catch (error) {
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
    }
  }, [api, connectionId, host, port, password, dbNum]);

  const handleDisconnect = useCallback(async () => {
    if (!api?.connections || !redisId) return;
    try { await api.connections.redisDisconnect(connectionId, redisId); } catch { /* ignore */ }
    setStatus('disconnected');
    setRedisId('');
    setKeys([]);
    setSelectedKey('');
    setKeyValue(null);
    setCmdResult(null);
    setCmdError('');
    setCmdLine('');
  }, [api, connectionId, redisId]);

  const loadKeys = useCallback(async (pattern?: string) => {
    if (!api?.connections || !redisId) return;
    setKeysLoading(true);
    setKeysPage(0);
    try {
      const result = await api.connections.redisKeys(connectionId, redisId, pattern ?? keyPattern);
      setKeys(result);
    } catch (error) {
      setCmdError(getErrorMessage(error));
    } finally {
      setKeysLoading(false);
    }
  }, [api, connectionId, redisId, keyPattern]);

  const handleSelectKey = useCallback(async (key: string) => {
    if (!api?.connections || !redisId) return;
    setSelectedKey(key);
    setKeyLoading(true);
    setKeyEditorValue('');
    try {
      const result = await api.connections.redisGetValue(connectionId, redisId, key);
      setKeyValue(result);
      const val = result.value;
      if (result.type === 'string') {
        setKeyEditorValue(val === null ? '' : String(val));
      } else if (result.type === 'hash') {
        setKeyEditorValue(JSON.stringify(val, null, 2));
      } else if (result.type === 'list') {
        setKeyEditorValue(JSON.stringify(val, null, 2));
      } else if (result.type === 'set') {
        setKeyEditorValue(JSON.stringify(val, null, 2));
      } else if (result.type === 'zset') {
        setKeyEditorValue(JSON.stringify(val, null, 2));
      } else {
        setKeyEditorValue(String(val));
      }
    } catch (error) {
      setCmdError(getErrorMessage(error));
      setKeyValue(null);
    } finally {
      setKeyLoading(false);
    }
  }, [api, connectionId, redisId]);

  const handleSaveKeyValue = useCallback(async () => {
    if (!api?.connections || !redisId || !selectedKey || !keyValue) return;
    try {
      let parsedValue: unknown = keyEditorValue;
      if (keyValue.type === 'hash' || keyValue.type === 'list' || keyValue.type === 'set' || keyValue.type === 'zset') {
        try { parsedValue = JSON.parse(keyEditorValue); } catch { setCmdError('JSON 格式无效'); return; }
      }
      await api.connections.redisSetValue(connectionId, redisId, selectedKey, parsedValue, keyValue.type);
      setCmdError('');
      handleSelectKey(selectedKey);
    } catch (error) {
      setCmdError(getErrorMessage(error));
    }
  }, [api, connectionId, redisId, selectedKey, keyValue, keyEditorValue, handleSelectKey]);

  const handleDeleteKey = useCallback(async () => {
    if (!api?.connections || !redisId || !selectedKey) return;
    try {
      await api.connections.redisDeleteKey(connectionId, redisId, selectedKey);
      setSelectedKey('');
      setKeyValue(null);
      loadKeys();
    } catch (error) {
      setCmdError(getErrorMessage(error));
    }
  }, [api, connectionId, redisId, selectedKey, loadKeys]);

  const handleRunCommand = useCallback(async () => {
    if (!api?.connections || !redisId || !cmdLine.trim()) return;
    setCmdRunning(true);
    setCmdError('');
    setCmdResult(null);
    try {
      const parts = cmdLine.trim().split(/\s+/);
      const command = parts[0].toUpperCase();
      const args = parts.slice(1);
      const result = await api.connections.redisCommand(connectionId, redisId, command, args);
      setCmdResult(formatCommandResult(result));
    } catch (error) {
      setCmdError(getErrorMessage(error));
    } finally {
      setCmdRunning(false);
    }
  }, [api, connectionId, redisId, cmdLine]);

  const handleCmdKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); handleRunCommand(); }
  }, [handleRunCommand]);

  const pagedKeys = useMemo(() => {
    return keys.slice(keysPage * pageSize, (keysPage + 1) * pageSize);
  }, [keys, keysPage]);

  const totalKeyPages = useMemo(() => Math.ceil(keys.length / pageSize), [keys]);

  const filteredKeyTypeLabel = (type: string) => {
    switch (type) {
      case 'string': return '📝 字符串';
      case 'hash': return '📦 哈希';
      case 'list': return '📋 列表';
      case 'set': return '🔗 集合';
      case 'zset': return '📊 有序集合';
      case 'stream': return '📡 流';
      default: return type;
    }
  };

  useEffect(() => {
    if (isReady) loadKeys();
  }, [isReady]);

  useEffect(() => {
    return () => {
      if (redisId && api?.connections) {
        api.connections.redisDisconnect(connectionId, redisId).catch(() => {});
      }
    };
  }, []);

  if (!isReady) {
    return (
      <div className="redis-connect-panel">
        <div className="redis-connect-card">
          <h3>连接 Redis 数据库</h3>
          <p className="redis-connect-hint">通过 SSH 隧道安全连接目标机器的 Redis</p>
          {errorMessage ? <div className="redis-error-banner">{errorMessage}</div> : null}
          <label className="redis-field">
            <span>主机</span>
            <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="127.0.0.1" disabled={status === 'connecting'} />
          </label>
          <label className="redis-field">
            <span>端口</span>
            <input type="text" value={port} onChange={(e) => setPort(e.target.value)} placeholder="6379" disabled={status === 'connecting'} />
          </label>
          <label className="redis-field">
            <span>密码</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="留空表示无密码" disabled={status === 'connecting'} />
          </label>
          <label className="redis-field">
            <span>数据库</span>
            <input type="text" value={dbNum} onChange={(e) => setDbNum(e.target.value)} placeholder="0" disabled={status === 'connecting'} />
          </label>
          <button type="button" className="redis-connect-btn" onClick={handleConnect} disabled={status === 'connecting'}>
            {status === 'connecting' ? '连接中...' : '连接'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="redis-layout">
      <aside className="redis-sidebar">
        <div className="redis-sidebar-header">
          <strong>键列表</strong>
          <span className="redis-connection-badge" title={`${host}:${port} DB${dbNum}`}>{`${host}:${port}`}</span>
          <button type="button" className="redis-disconnect-btn" onClick={handleDisconnect} title="断开连接">断开</button>
        </div>
        <div className="redis-key-search">
          <input type="text" value={keyPattern} onChange={(e) => setKeyPattern(e.target.value)}
            placeholder="键匹配模式 (如 user:*)" spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter') loadKeys(); }} />
          <button type="button" onClick={() => loadKeys()} title="刷新">🔄</button>
        </div>
        <div className="redis-key-list">
          {keysLoading ? <div className="redis-key-loading">加载中...</div> : null}
          {!keysLoading && keys.length === 0 ? <div className="redis-key-empty">无匹配的键</div> : null}
          {pagedKeys.map((entry) => (
            <button key={entry.name} type="button"
              className={`redis-key-btn ${selectedKey === entry.name ? 'selected' : ''}`}
              onClick={() => handleSelectKey(entry.name)}>
              <span className="redis-key-type-icon">{getKeyTypeIcon(entry.type)}</span>
              <span className="redis-key-name">{entry.name}</span>
              <span className="redis-key-ttl" title={`TTL: ${entry.ttl}s`}>{formatTtl(entry.ttl)}</span>
            </button>
          ))}
        </div>
        {totalKeyPages > 1 ? (
          <div className="redis-key-pagination">
            <button type="button" disabled={keysPage === 0} onClick={() => setKeysPage(0)}>«</button>
            <button type="button" disabled={keysPage === 0} onClick={() => setKeysPage(keysPage - 1)}>‹</button>
            <span>{keysPage + 1}/{totalKeyPages}</span>
            <button type="button" disabled={keysPage >= totalKeyPages - 1} onClick={() => setKeysPage(keysPage + 1)}>›</button>
            <button type="button" disabled={keysPage >= totalKeyPages - 1} onClick={() => setKeysPage(totalKeyPages - 1)}>»</button>
          </div>
        ) : null}
        <div className="redis-key-count">{keys.length} 个键</div>
      </aside>
      <div className="redis-main">
        <div className="redis-value-area">
          {!selectedKey ? (
            <div className="redis-value-placeholder">选择一个键以查看其值</div>
          ) : keyLoading ? (
            <div className="redis-value-placeholder">加载中...</div>
          ) : keyValue ? (
            <>
              <div className="redis-value-header">
                <span className="redis-value-key-name">{selectedKey}</span>
                <span className="redis-value-type-badge">{filteredKeyTypeLabel(keyValue.type)}</span>
                {(() => {
                  const entry = keys.find((k) => k.name === selectedKey);
                  return entry ? <span className="redis-value-ttl" title={`TTL: ${entry.ttl}s`}>TTL: {formatTtl(entry.ttl)}</span> : null;
                })()}
                <button type="button" className="redis-save-btn" onClick={handleSaveKeyValue}>保存</button>
                <button type="button" className="redis-delete-key-btn" onClick={handleDeleteKey}>删除键</button>
              </div>
              <textarea ref={keyEditorRef} className="redis-value-editor" value={keyEditorValue}
                onChange={(e) => setKeyEditorValue(e.target.value)} spellCheck={false} />
            </>
          ) : (
            <div className="redis-value-placeholder">无法读取键值</div>
          )}
        </div>
        <div className="redis-cmd-area">
          <div className="redis-cmd-toolbar">
            <input ref={cmdLineRef} className="redis-cmd-input" value={cmdLine}
              onChange={(e) => setCmdLine(e.target.value)} onKeyDown={handleCmdKeyDown}
              placeholder="输入 Redis 命令..." spellCheck={false} />
            <button type="button" className="redis-cmd-run-btn" onClick={handleRunCommand} disabled={cmdRunning || !cmdLine.trim()}>
              {cmdRunning ? '执行中...' : '执行'}
            </button>
          </div>
          {cmdError ? <div className="redis-error-banner">{cmdError}</div> : null}
          {cmdResult !== null ? (
            <pre className="redis-cmd-result">{cmdResult}</pre>
          ) : (
            <div className="redis-cmd-placeholder">命令结果将显示在此处</div>
          )}
        </div>
      </div>
    </div>
  );
}

function getKeyTypeIcon(type: string): string {
  switch (type) {
    case 'string': return '📝';
    case 'hash': return '📦';
    case 'list': return '📋';
    case 'set': return '🔗';
    case 'zset': return '📊';
    case 'stream': return '📡';
    default: return '❓';
  }
}

function formatCommandResult(result: unknown): string {
  if (result === null) return '(nil)';
  if (result === undefined) return '(空)';
  if (typeof result === 'string') return result;
  if (typeof result === 'number') return String(result);
  if (Array.isArray(result)) {
    return result.map((item, i) => `${i + 1}) ${formatCommandResult(item)}`).join('\n');
  }
  return JSON.stringify(result, null, 2);
}

export default RemoteRedis;
