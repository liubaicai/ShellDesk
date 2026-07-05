import { type KeyboardEvent, useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';
import {
  appendDatabaseFallbackReason,
  describeDatabaseTransport,
  formatTimestamp,
} from './databaseUtils';
import DismissibleAlert from './DismissibleAlert';
import NotepadEditor from './NotepadEditor';
import { loadRemoteConnectionProfile, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import { tCurrent } from '../../i18n';

interface RemoteRedisProps {
  connectionId: string;
  hostId: string;
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
  error?: string;
  onConfirm: () => Promise<void>;
}

type RedisElementEditorType = 'hash' | 'list' | 'set';

interface RedisElementDraft {
  mode: 'add' | 'edit';
  type: RedisElementEditorType;
  field: string;
  value: string;
  index?: number;
  previousField?: string;
  previousValue?: string;
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
  'LSET',
  'LREM',
  'LPUSH',
  'LPOP',
  'PERSIST',
  'PEXPIRE',
  'RENAME',
  'RENAMENX',
  'RPOP',
  'RPUSH',
  'SADD',
  'SREM',
  'SET',
  'SETEX',
  'UNLINK',
  'ZADD',
  'ZREM',
]);

function getShellDeskEditorTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') {
    return 'dark';
  }

  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function formatTtl(ttl?: number): string {
  if (ttl === undefined || Number.isNaN(ttl)) return tCurrent('auto.remoteRedis.1lpnuh4');
  if (ttl === -1) return tCurrent('auto.remoteRedis.4rvo30');
  if (ttl === -2) return tCurrent('auto.remoteRedis.1g217or');
  if (ttl < 0) return tCurrent('auto.remoteRedis.1lpnuh42');
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
    case 'none': return tCurrent('auto.remoteRedis.pwcxvc');
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
  if (size === undefined || Number.isNaN(size)) return tCurrent('auto.remoteRedis.1ng00oy');
  if (type === 'string') return `${size} B`;
  if (type === 'stream') return tCurrent('auto.remoteRedis.1h15ve7', { value0: size });
  return tCurrent('auto.remoteRedis.1eo5imv', { value0: size });
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
    return tCurrent('auto.remoteRedis.115zf4i', { value0: command });
  }

  if (command === 'KEYS') {
    return tCurrent('auto.remoteRedis.190ecco');
  }

  if (command === 'SHUTDOWN' || command === 'CONFIG' || command === 'MONITOR') {
    return tCurrent('auto.remoteRedis.wk8tnn', { value0: command });
  }

  if ((command === 'DEL' || command === 'UNLINK') && args.length > 5) {
    return tCurrent('auto.remoteRedis.11vwroa', { value0: command, value1: args.length });
  }

  return '';
}

function formatCommandResult(result: unknown): string {
  if (result === null) return '(nil)';
  if (result === undefined) return tCurrent('auto.remoteRedis.1htdcm2');
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (Array.isArray(result)) {
    return result.map((item, index) => `${index + 1}) ${formatCommandResult(item)}`).join('\n');
  }
  return stringifyJson(result);
}

function stringifyRedisElementValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stringifyJson(value);
}

function getRedisElementEditorType(result: ShellDeskRedisValueResult | null): RedisElementEditorType | null {
  if (!result || result.truncated) return null;
  return result.type === 'hash' || result.type === 'list' || result.type === 'set' ? result.type : null;
}

function RedisValueEditor({
  ariaLabel,
  value,
  language,
  readOnly,
  theme,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  language: string;
  readOnly: boolean;
  theme: 'light' | 'dark';
  onChange: (value: string) => void;
}) {
  return (
    <NotepadEditor
      ariaLabel={ariaLabel}
      className="redis-value-codemirror"
      content={value}
      language={language}
      readOnly={readOnly}
      theme={theme}
      wrapEnabled
      onChange={onChange}
      onCursorChange={() => undefined}
    />
  );
}

function RemoteRedis({ connectionId, hostId }: RemoteRedisProps) {
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
  const [ttlDraft, setTtlDraft] = useState('');
  const [ttlSaving, setTtlSaving] = useState(false);
  const [elementDraft, setElementDraft] = useState<RedisElementDraft | null>(null);
  const [elementSaving, setElementSaving] = useState(false);
  const [cmdLine, setCmdLine] = useState('');
  const [cmdResult, setCmdResult] = useState<string | null>(null);
  const [cmdRunning, setCmdRunning] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingRedisAction | null>(null);
  const [pendingRunning, setPendingRunning] = useState(false);
  const [editorTheme, setEditorTheme] = useState<'light' | 'dark'>(getShellDeskEditorTheme);

  const isReady = status === 'connected';

  useEffect(() => {
    let disposed = false;

    void loadRemoteConnectionProfile(hostId, 'redis').then((profile) => {
      if (disposed || !profile) return;

      setHost(readProfileString(profile, 'host', '127.0.0.1'));
      setPort(readProfileString(profile, 'port', String(defaultPort)));
      setPassword(readProfileString(profile, 'password', ''));
      setDbNum(readProfileString(profile, 'dbNum', '0'));
    });

    return () => {
      disposed = true;
    };
  }, [hostId]);

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
  const elementEditorType = getRedisElementEditorType(keyValue);
  const hashEntries = useMemo(() => {
    if (elementEditorType !== 'hash' || !keyValue || !keyValue.value || Array.isArray(keyValue.value) || typeof keyValue.value !== 'object') {
      return [];
    }

    return Object.entries(keyValue.value as Record<string, unknown>);
  }, [elementEditorType, keyValue]);
  const listItems = useMemo(() => {
    if (elementEditorType !== 'list' || !keyValue || !Array.isArray(keyValue.value)) return [];
    return keyValue.value;
  }, [elementEditorType, keyValue]);
  const setMembers = useMemo(() => {
    if (elementEditorType !== 'set' || !keyValue || !Array.isArray(keyValue.value)) return [];
    return keyValue.value;
  }, [elementEditorType, keyValue]);

  const scanKeys = useCallback(async (options: { reset?: boolean; redisIdOverride?: string; patternOverride?: string; preserveSelection?: boolean; silent?: boolean } = {}) => {
    const activeRedisId = options.redisIdOverride ?? redisId;

    if (!api?.connections || !activeRedisId) return;

    const reset = options.reset ?? false;
    const pattern = (options.patternOverride ?? keyPattern.trim()) || '*';
    const cursor = reset ? '0' : scanCursor;

    setKeysLoading(true);
    if (!options.silent) {
      setMessage(null);
    }

    if (reset) {
      setKeysPage(0);
      if (!options.preserveSelection) {
        setSelectedKey('');
        setKeyValue(null);
        setKeyEditorValue('');
        setTtlDraft('');
        setElementDraft(null);
      }
    }

    try {
      const result = await api.connections.redisScan(connectionId, activeRedisId, {
        cursor,
        pattern,
        count: scanCount,
      });

      setKeys((prev) => {
        if (!reset) return mergeRedisKeyEntries(prev, result.keys);
        if (!options.preserveSelection || !selectedKey || result.keys.some((entry) => entry.name === selectedKey)) {
          return result.keys;
        }

        const selectedEntry = prev.find((entry) => entry.name === selectedKey);
        return selectedEntry ? mergeRedisKeyEntries(result.keys, [selectedEntry]) : result.keys;
      });
      setScanCursor(result.cursor);
      setScanComplete(result.complete);
      setLastScanPattern(pattern);
      if (!options.silent) {
        setMessage({
          type: 'success',
          text: result.complete
            ? tCurrent('auto.remoteRedis.11ex6ku', { value0: result.keys.length })
            : tCurrent('auto.remoteRedis.tatd7g', { value0: result.keys.length }),
        });
      }
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setKeysLoading(false);
    }
  }, [api, connectionId, keyPattern, redisId, scanCursor, selectedKey]);

  const resetWorkspace = useCallback(() => {
    setKeys([]);
    setScanCursor('0');
    setScanComplete(true);
    setLastScanPattern(keyPattern || '*');
    setKeysPage(0);
    setSelectedKey('');
    setKeyValue(null);
    setKeyEditorValue('');
    setTtlDraft('');
    setElementDraft(null);
    setCmdResult(null);
    setCmdLine('');
    setMessage(null);
  }, [keyPattern]);

  const handleConnect = useCallback(async () => {
    if (!api?.connections) return;

    setStatus('connecting');
    setErrorMessage('');
    setMessage(null);

    let createdRedisId = '';
    try {
      const nextPort = parseInt(port, 10) || defaultPort;
      const nextDb = parseInt(dbNum, 10) || 0;
      const result = await api.connections.redisConnect(connectionId, {
        mode: 'auto',
        host: host || '127.0.0.1',
        port: nextPort,
        password,
        db: nextDb,
      });

      createdRedisId = result.redisId;
      redisIdRef.current = result.redisId;
      setRedisId(result.redisId);
      setStatus('connected');
      void saveRemoteConnectionProfile(hostId, 'redis', {
        host: host || '127.0.0.1',
        port: String(nextPort),
        password,
        dbNum: String(nextDb),
      }).catch(() => undefined);
      await scanKeys({ reset: true, redisIdOverride: result.redisId });
      const successMessage = tCurrent('redis.connection.success', {
        transport: describeDatabaseTransport(result.transport),
        host: host || '127.0.0.1',
        port: nextPort,
        database: nextDb,
      });
      setMessage({
        type: 'success',
        text: appendDatabaseFallbackReason(successMessage, result.fallbackReason),
      });
    } catch (error) {
      if (createdRedisId) {
        try {
          await api.connections.redisDisconnect(connectionId, createdRedisId);
        } catch {
          // ignore cleanup errors after partial connect failure
        }
      }
      if (redisIdRef.current === createdRedisId) {
        redisIdRef.current = '';
      }
      setRedisId((current) => (current === createdRedisId ? '' : current));
      setStatus('error');
      setErrorMessage(getErrorMessage(error));
    }
  }, [api, connectionId, dbNum, host, hostId, password, port, scanKeys]);

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
    setElementDraft(null);

    try {
      const result = await api.connections.redisGetValue(connectionId, redisId, key);
      setKeyValue(result);
      setKeyEditorValue(createValueDraft(result));
      setTtlDraft(result.ttl !== undefined && result.ttl > 0 ? String(result.ttl) : '');
    } catch (error) {
      setKeyValue(null);
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setKeyLoading(false);
    }
  }, [api, connectionId, redisId]);

  const refreshSelectedKey = useCallback(async () => {
    if (!selectedKey) return;

    await handleSelectKey(selectedKey);
    await scanKeys({ reset: true, preserveSelection: true, silent: true });
  }, [handleSelectKey, scanKeys, selectedKey]);

  const runRedisMutation = useCallback(async (command: string, args: string[]) => {
    if (!api?.connections || !redisId) return;

    await api.connections.redisCommand(connectionId, redisId, command, args);
  }, [api, connectionId, redisId]);

  const handleSaveTtl = useCallback(async (persist = false) => {
    if (!selectedKey || ttlSaving) return;

    const draft = ttlDraft.trim();
    const seconds = Number.parseInt(draft, 10);

    if (!persist && (!/^\d+$/.test(draft) || !Number.isFinite(seconds) || seconds <= 0)) {
      setMessage({ type: 'error', text: tCurrent('redis.ttl.invalid') });
      return;
    }

    setTtlSaving(true);
    setMessage(null);

    try {
      if (persist) {
        await runRedisMutation('PERSIST', [selectedKey]);
      } else {
        await runRedisMutation('EXPIRE', [selectedKey, String(seconds)]);
      }

      setMessage({
        type: 'success',
        text: persist
          ? tCurrent('redis.ttl.persisted', { value0: selectedKey })
          : tCurrent('redis.ttl.saved', { value0: selectedKey, value1: seconds }),
      });
      await refreshSelectedKey();
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setTtlSaving(false);
    }
  }, [refreshSelectedKey, runRedisMutation, selectedKey, ttlDraft, ttlSaving]);

  const requestDeleteRedisElement = useCallback((draft: RedisElementDraft) => {
    if (!selectedKey) return;

    setPendingAction({
      title: tCurrent('redis.element.deleteTitle'),
      message: tCurrent('redis.element.deleteMessage', {
        value0: draft.type === 'list' ? `#${draft.index}` : (draft.previousField ?? draft.previousValue ?? draft.field),
        value1: selectedKey,
      }),
      confirmText: tCurrent('auto.remoteRedis.1t2vi4h'),
      danger: true,
      onConfirm: async () => {
        if (draft.type === 'hash') {
          await runRedisMutation('HDEL', [selectedKey, draft.previousField ?? draft.field]);
        } else if (draft.type === 'list') {
          if (!api?.connections || !redisId) return;
          await api.connections.redisRemoveListItem(connectionId, redisId, selectedKey, draft.index ?? 0);
        } else {
          await runRedisMutation('SREM', [selectedKey, draft.previousValue ?? draft.value]);
        }

        setMessage({ type: 'success', text: tCurrent('redis.element.deleted') });
        await refreshSelectedKey();
      },
    });
  }, [api, connectionId, redisId, refreshSelectedKey, runRedisMutation, selectedKey]);

  const handleSaveRedisElement = useCallback(async () => {
    if (!elementDraft || !selectedKey || elementSaving) return;

    const field = elementDraft.field.trim();
    const value = elementDraft.value;

    if (elementDraft.type === 'hash' && !field) {
      setMessage({ type: 'error', text: tCurrent('redis.element.fieldRequired') });
      return;
    }

    setElementSaving(true);
    setMessage(null);

    try {
      if (elementDraft.type === 'hash') {
        if (elementDraft.mode === 'edit' && elementDraft.previousField && elementDraft.previousField !== field) {
          await runRedisMutation('HDEL', [selectedKey, elementDraft.previousField]);
        }
        await runRedisMutation('HSET', [selectedKey, field, value]);
      } else if (elementDraft.type === 'list') {
        if (elementDraft.mode === 'add') {
          await runRedisMutation('RPUSH', [selectedKey, value]);
        } else {
          await runRedisMutation('LSET', [selectedKey, String(elementDraft.index ?? 0), value]);
        }
      } else if (elementDraft.mode === 'add') {
        await runRedisMutation('SADD', [selectedKey, value]);
      } else {
        const previousValue = elementDraft.previousValue ?? value;
        if (previousValue !== value) {
          await runRedisMutation('SREM', [selectedKey, previousValue]);
          await runRedisMutation('SADD', [selectedKey, value]);
        }
      }

      setElementDraft(null);
      setMessage({ type: 'success', text: tCurrent('redis.element.saved') });
      await refreshSelectedKey();
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error) });
    } finally {
      setElementSaving(false);
    }
  }, [elementDraft, elementSaving, refreshSelectedKey, runRedisMutation, selectedKey]);

  const executeSaveKeyValue = useCallback(async () => {
    if (!api?.connections || !redisId || !selectedKey || !keyValue || !valueEditable) return;

    let parsedValue: unknown = keyEditorValue;

    if (keyValue.type !== 'string') {
      try {
        parsedValue = JSON.parse(keyEditorValue);
      } catch {
        setMessage({ type: 'error', text: tCurrent('auto.remoteRedis.q2kfzb') });
        return;
      }
    }

    await api.connections.redisSetValue(connectionId, redisId, selectedKey, parsedValue, keyValue.type);
    setMessage({ type: 'success', text: tCurrent('auto.remoteRedis.18xg1s5', { value0: selectedKey }) });
    await refreshSelectedKey();
  }, [api, connectionId, keyEditorValue, keyValue, redisId, refreshSelectedKey, selectedKey, valueEditable]);

  const requestSaveKeyValue = useCallback(() => {
    if (!selectedKey || !keyValue || !valueEditable) return;

    setPendingAction({
      title: tCurrent('auto.remoteRedis.tajv3b'),
      message: keyValue.type === 'string'
        ? tCurrent('auto.remoteRedis.8vhb21', { value0: selectedKey })
        : tCurrent('auto.remoteRedis.4eus9o', { value0: selectedKey, value1: getKeyTypeLabel(keyValue.type) }),
      confirmText: tCurrent('auto.remoteRedis.1c3mapc'),
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
    setTtlDraft('');
    setElementDraft(null);
    setMessage({ type: 'success', text: tCurrent('auto.remoteRedis.1rox8rk', { value0: selectedKey }) });
  }, [api, connectionId, redisId, selectedKey]);

  const requestDeleteKey = useCallback(() => {
    if (!selectedKey) return;

    setPendingAction({
      title: tCurrent('auto.remoteRedis.4vxqix'),
      message: tCurrent('auto.remoteRedis.1e19tg9', { value0: selectedKey }),
      confirmText: tCurrent('auto.remoteRedis.1t2vi4h'),
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
      setMessage({ type: 'success', text: tCurrent('auto.remoteRedis.1tjuigr', { value0: command }) });

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
        title: tCurrent('auto.remoteRedis.16ir790'),
        message: warning,
        confirmText: tCurrent('auto.remoteRedis.6azgji'),
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
      setMessage({ type: 'success', text: tCurrent('auto.remoteRedis.ed12q0') });
    } catch {
      setMessage({ type: 'error', text: tCurrent('auto.remoteRedis.wcfma') });
    }
  }, [keyEditorValue]);

  const handleSaveFavoritePattern = useCallback(() => {
    const pattern = keyPattern.trim() || '*';
    setFavoritePatterns((prev) => (prev.includes(pattern) ? prev : [pattern, ...prev].slice(0, 6)));
  }, [keyPattern]);

  const handleConfirmPendingAction = useCallback(async () => {
    if (!pendingAction) return;

    setPendingRunning(true);
    setPendingAction((current) => (current ? { ...current, error: '' } : current));

    try {
      await pendingAction.onConfirm();
      setPendingAction(null);
    } catch (error) {
      setPendingAction((current) => (current ? { ...current, error: getErrorMessage(error) } : current));
    } finally {
      setPendingRunning(false);
    }
  }, [pendingAction]);

  const renderRedisElementEditor = () => {
    if (!elementEditorType || !keyValue) return null;

    const elementCount = elementEditorType === 'hash'
      ? hashEntries.length
      : elementEditorType === 'list'
        ? listItems.length
        : setMembers.length;

    return (
      <div className="redis-element-editor">
        <div className="redis-element-toolbar">
          <div>
            <strong>{tCurrent('redis.element.title', { value0: getKeyTypeLabel(elementEditorType) })}</strong>
            <span>{tCurrent('redis.element.count', { value0: elementCount })}</span>
          </div>
          <button
            type="button"
            className="redis-save-btn"
            onClick={() => setElementDraft({
              mode: 'add',
              type: elementEditorType,
              field: '',
              value: '',
            })}
          >
            {tCurrent('redis.element.add')}
          </button>
        </div>

        {elementDraft ? (
          <div className="redis-element-form">
            <div className="redis-element-form-title">
              <strong>{elementDraft.mode === 'add' ? tCurrent('redis.element.addTitle') : tCurrent('redis.element.editTitle')}</strong>
              <button type="button" onClick={() => setElementDraft(null)} disabled={elementSaving}>{tCurrent('auto.remoteRedis.1589w37')}</button>
            </div>
            {elementDraft.type === 'hash' ? (
              <label>
                <span>{tCurrent('redis.element.field')}</span>
                <input
                  type="text"
                  value={elementDraft.field}
                  onChange={(event) => setElementDraft((current) => current ? { ...current, field: event.target.value } : current)}
                  disabled={elementSaving}
                  spellCheck={false}
                />
              </label>
            ) : null}
            <label>
              <span>{elementDraft.type === 'set' ? tCurrent('redis.element.member') : tCurrent('redis.element.value')}</span>
              <textarea
                value={elementDraft.value}
                onChange={(event) => setElementDraft((current) => current ? { ...current, value: event.target.value } : current)}
                disabled={elementSaving}
                spellCheck={false}
              />
            </label>
            <div className="redis-element-form-actions">
              <button type="button" className="redis-save-btn" onClick={() => void handleSaveRedisElement()} disabled={elementSaving}>
                {elementSaving ? tCurrent('auto.remoteRedis.1j4vco4') : tCurrent('auto.remoteRedis.1c3mapc')}
              </button>
            </div>
          </div>
        ) : null}

        <div className="redis-element-table" role="table" aria-label={tCurrent('redis.element.title', { value0: getKeyTypeLabel(elementEditorType) })}>
          {elementEditorType === 'hash' ? hashEntries.map(([field, value]) => (
            <div className="redis-element-row" role="row" key={field}>
              <span className="redis-element-index" role="cell">{field}</span>
              <pre role="cell">{stringifyRedisElementValue(value)}</pre>
              <span className="redis-element-row-actions" role="cell">
                <button
                  type="button"
                  onClick={() => setElementDraft({
                    mode: 'edit',
                    type: 'hash',
                    field,
                    value: stringifyRedisElementValue(value),
                    previousField: field,
                  })}
                >
                  {tCurrent('redis.element.edit')}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => requestDeleteRedisElement({
                    mode: 'edit',
                    type: 'hash',
                    field,
                    value: stringifyRedisElementValue(value),
                    previousField: field,
                  })}
                >
                  {tCurrent('auto.remoteRedis.1t2vi4h2')}
                </button>
              </span>
            </div>
          )) : null}

          {elementEditorType === 'list' ? listItems.map((value, index) => (
            <div className="redis-element-row" role="row" key={`${index}:${stringifyRedisElementValue(value)}`}>
              <span className="redis-element-index" role="cell">#{index}</span>
              <pre role="cell">{stringifyRedisElementValue(value)}</pre>
              <span className="redis-element-row-actions" role="cell">
                <button
                  type="button"
                  onClick={() => setElementDraft({
                    mode: 'edit',
                    type: 'list',
                    field: '',
                    value: stringifyRedisElementValue(value),
                    index,
                  })}
                >
                  {tCurrent('redis.element.edit')}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => requestDeleteRedisElement({
                    mode: 'edit',
                    type: 'list',
                    field: '',
                    value: stringifyRedisElementValue(value),
                    index,
                  })}
                >
                  {tCurrent('auto.remoteRedis.1t2vi4h2')}
                </button>
              </span>
            </div>
          )) : null}

          {elementEditorType === 'set' ? setMembers.map((value, index) => {
            const member = stringifyRedisElementValue(value);

            return (
              <div className="redis-element-row" role="row" key={`${index}:${member}`}>
                <span className="redis-element-index" role="cell">{index + 1}</span>
                <pre role="cell">{member}</pre>
                <span className="redis-element-row-actions" role="cell">
                  <button
                    type="button"
                    onClick={() => setElementDraft({
                      mode: 'edit',
                      type: 'set',
                      field: '',
                      value: member,
                      previousValue: member,
                    })}
                  >
                    {tCurrent('redis.element.edit')}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => requestDeleteRedisElement({
                      mode: 'edit',
                      type: 'set',
                      field: '',
                      value: member,
                      previousValue: member,
                    })}
                  >
                    {tCurrent('auto.remoteRedis.1t2vi4h2')}
                  </button>
                </span>
              </div>
            );
          }) : null}

          {elementCount === 0 ? <div className="redis-element-empty">{tCurrent('redis.element.empty')}</div> : null}
        </div>

        <details className="redis-raw-json-panel">
          <summary>{tCurrent('redis.element.rawJson')}</summary>
          <RedisValueEditor
            ariaLabel="Redis raw JSON"
            value={keyEditorValue}
            language="json"
            readOnly={!valueEditable}
            theme={editorTheme}
            onChange={setKeyEditorValue}
          />
        </details>
      </div>
    );
  };

  useEffect(() => {
    return () => {
      const activeRedisId = redisIdRef.current;

      if (activeRedisId && api?.connections) {
        api.connections.redisDisconnect(connectionId, activeRedisId).catch(() => {});
      }
    };
  }, [api, connectionId]);

  useEffect(() => {
    return api?.events?.onDatabaseTunnelIdleTimeout((payload) => {
      if (
        payload.kind !== 'redis' ||
        payload.connectionId !== connectionId ||
        payload.sessionId !== redisIdRef.current
      ) {
        return;
      }

      redisIdRef.current = '';
      setRedisId('');
      setStatus('disconnected');
      resetWorkspace();
      setErrorMessage(`数据库连接已因空闲超过 ${payload.idleMinutes} 分钟自动断开。`);
    });
  }, [api, connectionId, resetWorkspace]);

  useEffect(() => {
    const observer = new MutationObserver(() => setEditorTheme(getShellDeskEditorTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

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
              <h3>{tCurrent('auto.remoteRedis.13ynazk')}</h3>
              <p className="redis-connect-hint">{tCurrent('auto.remoteRedis.j7eddf')}</p>
            </div>
          </div>
          {errorMessage ? (
            <DismissibleAlert className="redis-error-banner" onDismiss={() => setErrorMessage('')} role="alert">
              {errorMessage}
            </DismissibleAlert>
          ) : null}
          <div className="redis-connect-grid">
            <label className="redis-field">
              <span>{tCurrent('auto.remoteRedis.5kj63k')}</span>
              <input type="text" value={host} onChange={(event) => setHost(event.target.value)} placeholder="127.0.0.1" disabled={status === 'connecting'} />
            </label>
            <label className="redis-field">
              <span>{tCurrent('auto.remoteRedis.19ijc5j')}</span>
              <input type="text" value={port} onChange={(event) => setPort(event.target.value)} placeholder="6379" disabled={status === 'connecting'} />
            </label>
          </div>
          <div className="redis-connect-grid">
            <label className="redis-field">
              <span>{tCurrent('auto.remoteRedis.1aph6eg')}</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={tCurrent('auto.remoteRedis.1g8lhz1')} disabled={status === 'connecting'} />
            </label>
            <label className="redis-field">
              <span>{tCurrent('auto.remoteRedis.tnjvy8')}</span>
              <input type="text" value={dbNum} onChange={(event) => setDbNum(event.target.value)} placeholder="0" disabled={status === 'connecting'} />
            </label>
          </div>
          <div className="redis-tunnel-note">
            <span>{tCurrent('auto.remoteRedis.xlvjn7')}</span>
            <strong>{host || '127.0.0.1'}:{parseInt(port, 10) || defaultPort} · {tCurrent('redis.connection.databaseLabel')} {parseInt(dbNum, 10) || 0}</strong>
            <em>{tCurrent('auto.remoteRedis.1urpodq')}</em>
          </div>
          <button type="submit" className="redis-connect-btn" disabled={status === 'connecting'}>
            {status === 'connecting' ? tCurrent('auto.remoteRedis.1i0m8cf') : tCurrent('auto.remoteRedis.fuxatj')}
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
              <strong>{tCurrent('auto.remoteRedis.x2g1y3')}</strong>
              <span>{keys.length} {tCurrent('auto.remoteRedis.1xs95r3')}</span>
            </div>
            <button type="button" onClick={() => void scanKeys({ reset: true })} disabled={keysLoading} title={tCurrent('auto.remoteRedis.x723pu')}>
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
              placeholder={tCurrent('auto.remoteRedis.8n6wdy')}
              spellCheck={false}
            />
            <button type="button" onClick={handleSaveFavoritePattern} title={tCurrent('auto.remoteRedis.7jnqkk')}>+</button>
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
            {keysLoading && keys.length === 0 ? <div className="redis-key-loading">{tCurrent('auto.remoteRedis.xabatw')}</div> : null}
            {!keysLoading && keys.length === 0 ? <div className="redis-key-empty">{tCurrent('auto.remoteRedis.1srmayg')}</div> : null}
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
              <button type="button" disabled={keysPage === 0} onClick={() => setKeysPage(0)}>{tCurrent('auto.remoteRedis.1ow5v10')}</button>
              <button type="button" disabled={keysPage === 0} onClick={() => setKeysPage(keysPage - 1)}>{tCurrent('auto.remoteRedis.mtyn6e')}</button>
              <span>{keysPage + 1} / {totalKeyPages}</span>
              <button type="button" disabled={keysPage >= totalKeyPages - 1} onClick={() => setKeysPage(keysPage + 1)}>{tCurrent('auto.remoteRedis.1yw313l')}</button>
              <button type="button" disabled={keysPage >= totalKeyPages - 1} onClick={() => setKeysPage(totalKeyPages - 1)}>{tCurrent('auto.remoteRedis.ixvu31')}</button>
            </div>
          ) : null}
          <div className="redis-scan-footer">
            <span title={`Pattern: ${lastScanPattern}`}>{scanComplete ? tCurrent('auto.remoteRedis.8d8zvf') : `Cursor ${scanCursor}`}</span>
            <button type="button" onClick={() => void scanKeys()} disabled={keysLoading || scanComplete}>
              {keysLoading && keys.length > 0 ? tCurrent('auto.remoteRedis.xabatw2') : tCurrent('auto.remoteRedis.sictmb')}
            </button>
          </div>
        </aside>

        <main className="redis-main">
          <div className="redis-topbar">
            <div className="redis-connection-summary">
              <span className="redis-status-dot" />
              <strong>{host || '127.0.0.1'}:{parseInt(port, 10) || defaultPort}</strong>
              <span>{tCurrent('redis.scan.summary', { database: parseInt(dbNum, 10) || 0, pattern: lastScanPattern })}</span>
            </div>
            <button type="button" className="redis-disconnect-btn" onClick={() => void handleDisconnect()} title={tCurrent('auto.remoteRedis.43dbsz')}>{tCurrent('auto.remoteRedis.a4u4dk')}</button>
          </div>

          <section className="redis-value-area">
            {!selectedKey ? (
              <div className="redis-value-placeholder">
                <strong>{tCurrent('auto.remoteRedis.8fbqzy')}</strong>
                <span>{tCurrent('auto.remoteRedis.t43bn2')}</span>
              </div>
            ) : keyLoading ? (
              <div className="redis-value-placeholder">{tCurrent('auto.remoteRedis.euvdym')}</div>
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
                    {selectedKeyEntry?.scannedAt ? <span>{tCurrent('auto.remoteRedis.1myljr3')}{formatTimestamp(selectedKeyEntry.scannedAt)}</span> : null}
                  </div>
                  <div className="redis-ttl-editor">
                    <label>
                      <span>{tCurrent('redis.ttl.label')}</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={ttlDraft}
                        onChange={(event) => setTtlDraft(event.target.value)}
                        placeholder={tCurrent('redis.ttl.forever')}
                        disabled={ttlSaving}
                      />
                    </label>
                    <button type="button" onClick={() => void handleSaveTtl(false)} disabled={ttlSaving || !ttlDraft.trim()}>
                      {ttlSaving ? tCurrent('auto.remoteRedis.1j4vco4') : tCurrent('redis.ttl.save')}
                    </button>
                    <button type="button" onClick={() => void handleSaveTtl(true)} disabled={ttlSaving}>
                      {tCurrent('redis.ttl.persist')}
                    </button>
                  </div>
                  <div className="redis-value-actions">
                    {keyValue.type === 'string' ? (
                      <button type="button" onClick={handleFormatJson}>{tCurrent('auto.remoteRedis.1i126as')}</button>
                    ) : null}
                    <button type="button" className="redis-save-btn" onClick={requestSaveKeyValue} disabled={!valueEditable}>{tCurrent('auto.remoteRedis.1c3mapc2')}</button>
                    <button type="button" className="redis-delete-key-btn" onClick={requestDeleteKey}>{tCurrent('auto.remoteRedis.1t2vi4h2')}</button>
                  </div>
                </div>
                {keyValue.truncated ? (
                  <div className="redis-warning-banner">
                    {tCurrent('auto.remoteRedis.fqkypg')}{keyValue.previewLimit ?? 200} {tCurrent('auto.remoteRedis.1m53fin')}</div>
                ) : null}
                {elementEditorType ? renderRedisElementEditor() : (
                  <RedisValueEditor
                    ariaLabel="Redis value"
                    value={keyEditorValue}
                    language={keyValue.type === 'string' ? '' : 'json'}
                    readOnly={!valueEditable}
                    theme={editorTheme}
                    onChange={setKeyEditorValue}
                  />
                )}
              </>
            ) : (
              <div className="redis-value-placeholder">{tCurrent('auto.remoteRedis.nnyi58')}</div>
            )}
          </section>

          <section className="redis-cmd-area">
            <div className="redis-cmd-toolbar">
              <input
                className="redis-cmd-input"
                value={cmdLine}
                onChange={(event) => setCmdLine(event.target.value)}
                onKeyDown={handleCommandKeyDown}
                placeholder={tCurrent('auto.remoteRedis.18gvc8n')}
                spellCheck={false}
              />
              <button type="button" className="redis-cmd-run-btn" onClick={handleRunCommand} disabled={cmdRunning || !cmdLine.trim()}>
                {cmdRunning ? tCurrent('auto.remoteRedis.e2byz1') : tCurrent('auto.remoteRedis.6azgji2')}
              </button>
            </div>
            {message ? (
              <DismissibleAlert
                className={`redis-message-banner ${message.type}`}
                onDismiss={() => setMessage(null)}
                role={message.type === 'error' ? 'alert' : 'status'}
              >
                {message.text}
              </DismissibleAlert>
            ) : null}
            {cmdResult !== null ? (
              <pre className="redis-cmd-result">{cmdResult}</pre>
            ) : (
              <div className="redis-cmd-placeholder">
                <strong>{tCurrent('auto.remoteRedis.6uxg17')}</strong>
                <span>{tCurrent('auto.remoteRedis.19g1i6h')}</span>
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
              <span>{pendingAction.danger ? tCurrent('auto.remoteRedis.5n03rt') : tCurrent('auto.remoteRedis.1gm39ou')}</span>
            </div>
            <p>{pendingAction.message}</p>
            {pendingAction.error ? (
              <DismissibleAlert
                className="redis-message-banner error"
                onDismiss={() => setPendingAction((current) => (current ? { ...current, error: '' } : current))}
                role="alert"
              >
                {pendingAction.error}
              </DismissibleAlert>
            ) : null}
            <div className="redis-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)} disabled={pendingRunning}>{tCurrent('auto.remoteRedis.1589w37')}</button>
              <button type="button" className={pendingAction.danger ? 'danger' : 'primary'} onClick={() => void handleConfirmPendingAction()} disabled={pendingRunning}>
                {pendingRunning ? tCurrent('auto.remoteRedis.1j4vco4') : pendingAction.confirmText}
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
