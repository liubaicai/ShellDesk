import { type KeyboardEvent, useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';

interface RemoteRedisProps {
  connectionId: string;
}

type RedisStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type RedisMessageType = 'info' | 'success' | 'warning' | 'error';

interface RedisMessage {
  type: RedisMessageType;
  text: string;
}

interface RedisKeyEntry extends ShellDeskRedisKeySummary {}

interface PendingRedisAction {
  title: string;
  message: string;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
}

const defaultPort = 6379;
const keyPageSize = 200;
const scanCount = 300;
const mutableRedisCommands = new Set([
  'APPEND',
  'DECR',
  'DECRBY',
  'DEL',
  'EXPIRE',
  'EXPIREAT',
  'FLUSHALL',
  'FLUSHDB',
  'HDEL',
  'HMSET',
  'HSET',
  'INCR',
  'INCRBY',
  'LPUSH',
  'LPOP',
  'PERSIST',
  'PEXPIRE',
  'RENAME',
  'RENAMENX',
  'RPOP',
  'RPUSH',
  'SADD',
  'SET',
  'SETEX',
  'UNLINK',
  'ZADD',
  'ZREM',
]);

function formatTtl(ttl?: number): string {
  if (ttl === undefined || Number.isNaN(ttl)) return '未知';
  if (ttl === -1) return '永不过期';
  if (ttl === -2) return '已过期';
  if (ttl < 0) return '未知';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`;
  return `${Math.floor(ttl / 86400)}d`;
}

function getKeyTypeLabel(type: string): string {
  switch (type) {
    case 'string': return 'String';
    case 'hash': return 'Hash';
    case 'list': return 'List';
    case 'set': return 'Set';
    case 'zset': return 'ZSet';
    case 'stream': return 'Stream';
    case 'none': return '不存在';
    default: return type || 'Unknown';
  }
}

function getKeyTypeMark(type: string): string {
  switch (type) {
    case 'string': return 'S';
    case 'hash': return 'H';
    case 'list': return 'L';
    case 'set': return 'SET';
    case 'zset': return 'ZS';
    case 'stream': return 'X';
    default: return '?';
  }
}

function formatSizeHint(type: string, size?: number): string {
  if (size === undefined || Number.isNaN(size)) return '大小未知';
  if (type === 'string') return `${size} B`;
  if (type === 'stream') return `${size} 条`;
  return `${size} 项`;
}

function formatTimestamp(value?: string): string {
  if (!value) return '';
  return new Date(value).toLocaleTimeString(getShellDeskLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function stringifyJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? '' : text;
}

function createValueDraft(result: ShellDeskRedisValueResult): string {
  if (result.type === 'string') {
    return result.value === null || result.value === undefined ? '' : String(result.value);
  }

  if (['hash', 'list', 'set', 'zset', 'stream'].includes(result.type)) {
    return stringifyJson(result.value);
  }

  return result.value === null || result.value === undefined ? '' : String(result.value);
}

function isRedisValueEditable(result: ShellDeskRedisValueResult | null): boolean {
  if (!result) return false;
  return ['string', 'hash', 'list', 'set', 'zset'].includes(result.type) && !result.truncated;
}

function mergeRedisKeyEntries(current: RedisKeyEntry[], incoming: RedisKeyEntry[]): RedisKeyEntry[] {
  const keyMap = new Map<string, RedisKeyEntry>();

  for (const entry of current) {
    keyMap.set(entry.name, entry);
  }

  for (const entry of incoming) {
    keyMap.set(entry.name, entry);
  }

  return Array.from(keyMap.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function parseRedisCommandLine(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && quote === '"') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function getRedisCommandWarning(command: string, args: string[]): string {
  if (command === 'FLUSHALL' || command === 'FLUSHDB') {
    return `${command} 会清空当前 Redis 数据。`;
  }

  if (command === 'KEYS') {
    return 'KEYS 会在大实例上阻塞 Redis，请优先使用左侧 SCAN 浏览。';
  }

  if (command === 'SHUTDOWN' || command === 'CONFIG' || command === 'MONITOR') {
    return `${command} 可能影响 Redis 服务可用性。`;
  }

  if ((command === 'DEL' || command === 'UNLINK') && args.length > 5) {
    return `${command} 将一次处理 ${args.length} 个 key。`;
  }

  return '';
}

function formatCommandResult(result: unknown): string {
  if (result === null) return '(nil)';
  if (result === undefined) return '(空)';
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (Array.isArray(result)) {
    return result.map((item, index) => `${index + 1}) ${formatCommandResult(item)}`).join('\n');
  }
  return stringifyJson(result);
}

function RemoteRedis({ connectionId }: RemoteRedisProps) {
  const api = window.guiSSH;
  const redisIdRef = useRef('');
  const [status, setStatus] = useState<RedisStatus>('disconnected');
  const [errorMessage, setErrorMessage] = useState('');
  const [message, setMessage] = useState<RedisMessage | null>(null);
  const [redisId, setRedisId] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(String(defaultPort));
  const [password, setPassword] = useState('');
  const [dbNum, setDbNum] = useState('0');
  const [keyPattern, setKeyPattern] = useState('*');
  const [favoritePatterns, setFavoritePatterns] = useState<string[]>(['*', 'session:*', 'user:*']);
  const [keys, setKeys] = useState<RedisKeyEntry[]>([]);
  const [scanCursor, setScanCursor] = useState('0');
  const [scanComplete, setScanComplete] = useState(true);
  const [lastScanPattern, setLastScanPattern] = useState('*');
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysPage, setKeysPage] = useState(0);
  const [selectedKey, setSelectedKey] = useState('');
  const [keyValue, setKeyValue] = useState<ShellDeskRedisValueResult | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keyEditorValue, setKeyEditorValue] = useState('');
  const [cmdLine, setCmdLine] = useState('');
  const [cmdResult, setCmdResult] = useState<string | null>(null);
  const [cmdRunning, setCmdRunning] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingRedisAction | null>(null);
  const [pendingRunning, setPendingRunning] = useState(false);

  const isReady = status === 'connected';

  const selectedKeyEntry = useMemo(() => {
    return keys.find((entry) => entry.name === selectedKey) ?? null;
  }, [keys, selectedKey]);

  const pagedKeys = useMemo(() => {
    return keys.slice(keysPage * keyPageSize, (keysPage + 1) * keyPageSize);
  }, [keys, keysPage]);

  const totalKeyPages = useMemo(() => {
    return Math.max(1, Math.ceil(keys.length / keyPageSize));
  }, [keys.length]);

  const valueEditable = isRedisValueEditable(keyValue);

  const scanKeys = useCallback(async (options: { reset?: boolean; redisIdOverride?: string; patternOverride?: string } = {}) => {
    const activeRedisId = options.redisIdOverride ?? redisId;

    if (!api?.connections || !activeRedisId) return;

    const reset = options.reset ?? false;
    const pattern = (options.patternOverride ?? keyPattern.trim()) || '*';
    const cursor = reset ? '0' : scanCursor;

    setKeysLoading(true);
    setMessage(null);

    if (reset) {
      setKeysPage(0);
      setSelectedKey('');
      setKeyValue(null);
      setKeyEditorValue('');
    }

    try {
      const result = await api.connections.redisScan(connectionId, activeRedisId, {
        cursor,
        pattern,
        count: scanCount,
      });

      setKeys((prev) => (reset ? result.keys : mergeRedisKeyEntries(prev, result.keys)));
      setScanCursor(result.cursor);
      setScanComplete(result.complete);
      setLastScanPattern(pattern);
      setMessage({
        type: 'success',
        text: result.complete
          ? `SCAN 完成，本轮载入 ${result.keys.length} 个 key。`
          : `已载入 ${result.keys.length} 个 key，可继续扫描。`,
      });
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setKeysLoading(false);
    }
  }, [api, connectionId, keyPattern, redisId, scanCursor]);

  const resetWorkspace = useCallback(() => {
    setKeys([]);
    setScanCursor('0');
    setScanComplete(true);
    setLastScanPattern(keyPattern || '*');
    setKeysPage(0);
    setSelectedKey('');
    setKeyValue(null);
    setKeyEditorValue('');
    setCmdResult(null);
    setCmdLine('');
    setMessage(null);
  }, [keyPattern]);

  const handleConnect = useCallback(async () => {
    if (!api?.connections) return;

    setStatus('connecting');
    setErrorMessage('');
    setMessage(null);

    try {
      const result = await api.connections.redisConnect(connectionId, {
        host: host || '127.0.0.1',
        port: parseInt(port, 10) || defaultPort,
        password,
        db: parseInt(dbNum, 10) || 0,
      });

      redisIdRef.current = result.redisId;
      setRedisId(result.redisId);
      setStatus('connected');
      await scanKeys({ reset: true, redisIdOverride: result.redisId });
    } catch (error) {
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
    }
  }, [api, connectionId, dbNum, host, password, port, scanKeys]);

  const handleDisconnect = useCallback(async () => {
    if (!api?.connections || !redisId) return;

    try {
      await api.connections.redisDisconnect(connectionId, redisId);
    } catch {
      // ignore disconnect errors
    }

    redisIdRef.current = '';
    setStatus('disconnected');
    setRedisId('');
    resetWorkspace();
  }, [api, connectionId, redisId, resetWorkspace]);

  const handleSelectKey = useCallback(async (key: string) => {
    if (!api?.connections || !redisId) return;

    setSelectedKey(key);
    setKeyLoading(true);
    setMessage(null);
    setKeyEditorValue('');

    try {
      const result = await api.connections.redisGetValue(connectionId, redisId, key);
      setKeyValue(result);
      setKeyEditorValue(createValueDraft(result));
    } catch (error) {
      setKeyValue(null);
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setKeyLoading(false);
    }
  }, [api, connectionId, redisId]);

  const executeSaveKeyValue = useCallback(async () => {
    if (!api?.connections || !redisId || !selectedKey || !keyValue || !valueEditable) return;

    let parsedValue: unknown = keyEditorValue;

    if (keyValue.type !== 'string') {
      try {
        parsedValue = JSON.parse(keyEditorValue);
      } catch {
        setMessage({ type: 'error', text: 'JSON 格式无效，未保存。' });
        return;
      }
    }

    await api.connections.redisSetValue(connectionId, redisId, selectedKey, parsedValue, keyValue.type);
    setMessage({ type: 'success', text: `已保存 ${selectedKey}。` });
    await handleSelectKey(selectedKey);
  }, [api, connectionId, handleSelectKey, keyEditorValue, keyValue, redisId, selectedKey, valueEditable]);

  const requestSaveKeyValue = useCallback(() => {
    if (!selectedKey || !keyValue || !valueEditable) return;

    setPendingAction({
      title: '保存 Redis 值',
      message: keyValue.type === 'string'
        ? `将覆盖 ${selectedKey} 的字符串值。`
        : `将用当前 JSON 覆盖 ${selectedKey} 的完整 ${getKeyTypeLabel(keyValue.type)} 值。`,
      confirmText: '保存',
      onConfirm: executeSaveKeyValue,
    });
  }, [executeSaveKeyValue, keyValue, selectedKey, valueEditable]);

  const executeDeleteKey = useCallback(async () => {
    if (!api?.connections || !redisId || !selectedKey) return;

    await api.connections.redisDeleteKey(connectionId, redisId, selectedKey);
    setKeys((prev) => prev.filter((entry) => entry.name !== selectedKey));
    setSelectedKey('');
    setKeyValue(null);
    setKeyEditorValue('');
    setMessage({ type: 'success', text: `已删除 ${selectedKey}。` });
  }, [api, connectionId, redisId, selectedKey]);

  const requestDeleteKey = useCallback(() => {
    if (!selectedKey) return;

    setPendingAction({
      title: '删除 Redis key',
      message: `删除 ${selectedKey} 后无法从 ShellDesk 恢复。`,
      confirmText: '删除',
      danger: true,
      onConfirm: executeDeleteKey,
    });
  }, [executeDeleteKey, selectedKey]);

  const executeCommand = useCallback(async (line: string) => {
    if (!api?.connections || !redisId || !line.trim()) return;

    const parts = parseRedisCommandLine(line);
    const command = parts[0]?.toUpperCase();

    if (!command) return;

    setCmdRunning(true);
    setCmdResult(null);
    setMessage(null);

    try {
      const result = await api.connections.redisCommand(connectionId, redisId, command, parts.slice(1));
      setCmdResult(formatCommandResult(result));
      setMessage({ type: 'success', text: `${command} 执行完成。` });

      if (mutableRedisCommands.has(command)) {
        await scanKeys({ reset: true });
      }
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setCmdRunning(false);
    }
  }, [api, connectionId, redisId, scanKeys]);

  const handleRunCommand = useCallback(() => {
    const parts = parseRedisCommandLine(cmdLine);
    const command = parts[0]?.toUpperCase();

    if (!command) return;

    const warning = getRedisCommandWarning(command, parts.slice(1));

    if (warning) {
      setPendingAction({
        title: '确认执行 Redis 命令',
        message: warning,
        confirmText: '执行',
        danger: true,
        onConfirm: () => executeCommand(cmdLine),
      });
      return;
    }

    void executeCommand(cmdLine);
  }, [cmdLine, executeCommand]);

  const handleCommandKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleRunCommand();
    }
  }, [handleRunCommand]);

  const handleFormatJson = useCallback(() => {
    try {
      const parsed = JSON.parse(keyEditorValue);
      setKeyEditorValue(stringifyJson(parsed));
      setMessage({ type: 'success', text: 'JSON 已格式化。' });
    } catch {
      setMessage({ type: 'error', text: '当前内容不是有效 JSON。' });
    }
  }, [keyEditorValue]);

  const handleSaveFavoritePattern = useCallback(() => {
    const pattern = keyPattern.trim() || '*';
    setFavoritePatterns((prev) => (prev.includes(pattern) ? prev : [pattern, ...prev].slice(0, 6)));
  }, [keyPattern]);

  const handleConfirmPendingAction = useCallback(async () => {
    if (!pendingAction) return;

    setPendingRunning(true);

    try {
      await pendingAction.onConfirm();
      setPendingAction(null);
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setPendingRunning(false);
    }
  }, [pendingAction]);

  useEffect(() => {
    return () => {
      const activeRedisId = redisIdRef.current;

      if (activeRedisId && api?.connections) {
        api.connections.redisDisconnect(connectionId, activeRedisId).catch(() => {});
      }
    };
  }, [api, connectionId]);

  if (!isReady) {
    return (
      <div className="redis-connect-panel">
        <form
          className="redis-connect-card"
          onSubmit={(event) => {
            event.preventDefault();
            void handleConnect();
          }}
        >
          <div className="redis-connect-heading">
            <span className="redis-connect-mark">R</span>
            <div>
              <h3>连接 Redis 数据库</h3>
              <p className="redis-connect-hint">通过 SSH 通道访问远程 Redis 实例</p>
            </div>
          </div>
          {errorMessage ? <div className="redis-error-banner">{errorMessage}</div> : null}
          <div className="redis-connect-grid">
            <label className="redis-field">
              <span>主机</span>
              <input type="text" value={host} onChange={(event) => setHost(event.target.value)} placeholder="127.0.0.1" disabled={status === 'connecting'} />
            </label>
            <label className="redis-field">
              <span>端口</span>
              <input type="text" value={port} onChange={(event) => setPort(event.target.value)} placeholder="6379" disabled={status === 'connecting'} />
            </label>
          </div>
          <div className="redis-connect-grid">
            <label className="redis-field">
              <span>密码</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="留空表示无密码" disabled={status === 'connecting'} />
            </label>
            <label className="redis-field">
              <span>数据库</span>
              <input type="text" value={dbNum} onChange={(event) => setDbNum(event.target.value)} placeholder="0" disabled={status === 'connecting'} />
            </label>
          </div>
          <div className="redis-tunnel-note">
            <span>连接目标</span>
            <strong>{host || '127.0.0.1'}:{parseInt(port, 10) || defaultPort} · DB {parseInt(dbNum, 10) || 0}</strong>
            <em>TLS 由远端 Redis 监听策略决定，转发失败时会自动尝试远程 TCP 代理。</em>
          </div>
          <button type="submit" className="redis-connect-btn" disabled={status === 'connecting'}>
            {status === 'connecting' ? '连接中...' : '连接 Redis'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <>
      <div className="redis-layout">
        <aside className="redis-sidebar">
          <div className="redis-sidebar-header">
            <div>
              <strong>Key 浏览</strong>
              <span>{keys.length} 个已载入</span>
            </div>
            <button type="button" onClick={() => void scanKeys({ reset: true })} disabled={keysLoading} title="重新扫描">
              {keysLoading ? '...' : '↻'}
            </button>
          </div>
          <div className="redis-key-search">
            <input
              type="search"
              value={keyPattern}
              onChange={(event) => setKeyPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void scanKeys({ reset: true });
                }
              }}
              placeholder="SCAN MATCH，如 user:*"
              spellCheck={false}
            />
            <button type="button" onClick={handleSaveFavoritePattern} title="收藏 pattern">+</button>
          </div>
          <div className="redis-pattern-chips">
            {favoritePatterns.map((pattern) => (
              <button
                key={pattern}
                type="button"
                className={keyPattern === pattern ? 'active' : ''}
                onClick={() => {
                  setKeyPattern(pattern);
                  void scanKeys({ reset: true, patternOverride: pattern });
                }}
              >
                {pattern}
              </button>
            ))}
          </div>
          <div className="redis-key-list">
            {keysLoading && keys.length === 0 ? <div className="redis-key-loading">扫描中...</div> : null}
            {!keysLoading && keys.length === 0 ? <div className="redis-key-empty">没有匹配的 key</div> : null}
            {pagedKeys.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className={`redis-key-btn ${selectedKey === entry.name ? 'selected' : ''}`}
                onClick={() => void handleSelectKey(entry.name)}
                title={`${entry.name}\n${getKeyTypeLabel(entry.type)} · ${formatTtl(entry.ttl)} · ${formatSizeHint(entry.type, entry.size)}`}
              >
                <span className={`redis-key-type-mark type-${entry.type}`}>{getKeyTypeMark(entry.type)}</span>
                <span className="redis-key-name">{entry.name}</span>
                <span className="redis-key-meta">
                  <small>{formatSizeHint(entry.type, entry.size)}</small>
                  <em>{formatTtl(entry.ttl)}</em>
                </span>
              </button>
            ))}
          </div>
          {totalKeyPages > 1 ? (
            <div className="redis-key-pagination">
              <button type="button" disabled={keysPage === 0} onClick={() => setKeysPage(0)}>首页</button>
              <button type="button" disabled={keysPage === 0} onClick={() => setKeysPage(keysPage - 1)}>上一页</button>
              <span>{keysPage + 1} / {totalKeyPages}</span>
              <button type="button" disabled={keysPage >= totalKeyPages - 1} onClick={() => setKeysPage(keysPage + 1)}>下一页</button>
              <button type="button" disabled={keysPage >= totalKeyPages - 1} onClick={() => setKeysPage(totalKeyPages - 1)}>末页</button>
            </div>
          ) : null}
          <div className="redis-scan-footer">
            <span title={`Pattern: ${lastScanPattern}`}>{scanComplete ? '扫描完成' : `Cursor ${scanCursor}`}</span>
            <button type="button" onClick={() => void scanKeys()} disabled={keysLoading || scanComplete}>
              {keysLoading && keys.length > 0 ? '扫描中...' : '继续扫描'}
            </button>
          </div>
        </aside>

        <main className="redis-main">
          <div className="redis-topbar">
            <div className="redis-connection-summary">
              <span className="redis-status-dot" />
              <strong>{host || '127.0.0.1'}:{parseInt(port, 10) || defaultPort}</strong>
              <span>DB {parseInt(dbNum, 10) || 0} · MATCH {lastScanPattern}</span>
            </div>
            <button type="button" className="redis-disconnect-btn" onClick={() => void handleDisconnect()} title="断开 Redis">断开</button>
          </div>

          <section className="redis-value-area">
            {!selectedKey ? (
              <div className="redis-value-placeholder">
                <strong>选择一个 key</strong>
                <span>左侧使用 SCAN 分批浏览，避免一次性拉取整个 key 空间。</span>
              </div>
            ) : keyLoading ? (
              <div className="redis-value-placeholder">正在读取 key...</div>
            ) : keyValue ? (
              <>
                <div className="redis-value-header">
                  <div className="redis-value-title">
                    <strong title={selectedKey}>{selectedKey}</strong>
                    <span>{getKeyTypeLabel(keyValue.type)}</span>
                  </div>
                  <div className="redis-value-meta">
                    <span>TTL {formatTtl(keyValue.ttl ?? selectedKeyEntry?.ttl)}</span>
                    <span>{formatSizeHint(keyValue.type, keyValue.size ?? selectedKeyEntry?.size)}</span>
                    {selectedKeyEntry?.scannedAt ? <span>扫描 {formatTimestamp(selectedKeyEntry.scannedAt)}</span> : null}
                  </div>
                  <div className="redis-value-actions">
                    {keyValue.type === 'string' ? (
                      <button type="button" onClick={handleFormatJson}>格式化 JSON</button>
                    ) : null}
                    <button type="button" className="redis-save-btn" onClick={requestSaveKeyValue} disabled={!valueEditable}>保存</button>
                    <button type="button" className="redis-delete-key-btn" onClick={requestDeleteKey}>删除</button>
                  </div>
                </div>
                {keyValue.truncated ? (
                  <div className="redis-warning-banner">
                    当前只预览前 {keyValue.previewLimit ?? 200} 项。为避免误覆盖，已禁用保存。
                  </div>
                ) : null}
                <textarea
                  className="redis-value-editor"
                  value={keyEditorValue}
                  onChange={(event) => setKeyEditorValue(event.target.value)}
                  disabled={!valueEditable}
                  spellCheck={false}
                />
              </>
            ) : (
              <div className="redis-value-placeholder">无法读取 key 值</div>
            )}
          </section>

          <section className="redis-cmd-area">
            <div className="redis-cmd-toolbar">
              <input
                className="redis-cmd-input"
                value={cmdLine}
                onChange={(event) => setCmdLine(event.target.value)}
                onKeyDown={handleCommandKeyDown}
                placeholder="输入 Redis 命令"
                spellCheck={false}
              />
              <button type="button" className="redis-cmd-run-btn" onClick={handleRunCommand} disabled={cmdRunning || !cmdLine.trim()}>
                {cmdRunning ? '执行中...' : '执行'}
              </button>
            </div>
            {message ? <div className={`redis-message-banner ${message.type}`}>{message.text}</div> : null}
            {cmdResult !== null ? (
              <pre className="redis-cmd-result">{cmdResult}</pre>
            ) : (
              <div className="redis-cmd-placeholder">
                <strong>命令结果</strong>
                <span>FLUSH、KEYS 和批量 DEL/UNLINK 会在执行前再次确认。</span>
              </div>
            )}
          </section>
        </main>
      </div>

      {pendingAction ? createPortal(
        <div className="redis-modal-backdrop" role="presentation">
          <div className="redis-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="redis-confirm-title">
            <div className="redis-confirm-header">
              <strong id="redis-confirm-title">{pendingAction.title}</strong>
              <span>{pendingAction.danger ? '风险操作' : '确认操作'}</span>
            </div>
            <p>{pendingAction.message}</p>
            <div className="redis-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)} disabled={pendingRunning}>取消</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={() => void handleConfirmPendingAction()} disabled={pendingRunning}>
                {pendingRunning ? '处理中...' : pendingAction.confirmText}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export default RemoteRedis;
