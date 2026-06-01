import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';

interface RemoteMongoProps {
  connectionId: string;
}

type MongoStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface SelectedMongoCollection {
  database: string;
  collection: string;
}

const defaultLimit = 100;

function formatBytes(value?: number) {
  if (!value || value < 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function stringifyJson(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? '' : text;
}

function formatCellValue(value: unknown) {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'object') return stringifyJson(value).replace(/\s+/g, ' ').slice(0, 160);
  return String(value);
}

function getDocumentId(document: Record<string, unknown>, index: number) {
  const id = document._id;

  if (id && typeof id === 'object' && '$oid' in id) {
    return String((id as { $oid: unknown }).$oid);
  }

  if (id !== undefined && id !== null) {
    return formatCellValue(id);
  }

  return `文档 ${index + 1}`;
}

function getDocumentColumns(documents: Record<string, unknown>[]) {
  const names = new Set<string>();

  for (const document of documents.slice(0, 30)) {
    Object.keys(document).forEach((key) => names.add(key));
  }

  const ordered = Array.from(names);
  return ordered.includes('_id')
    ? ['_id', ...ordered.filter((name) => name !== '_id').slice(0, 7)]
    : ordered.slice(0, 8);
}

function tryFormatJsonDraft(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '{}';
  return stringifyJson(JSON.parse(trimmed));
}

function RemoteMongo({ connectionId }: RemoteMongoProps) {
  const api = window.guiSSH?.connections;
  const mongoIdRef = useRef('');
  const [status, setStatus] = useState<MongoStatus>('disconnected');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mongoId, setMongoId] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('27017');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authSource, setAuthSource] = useState('admin');
  const [databases, setDatabases] = useState<ShellDeskMongoDatabase[]>([]);
  const [collectionsByDatabase, setCollectionsByDatabase] = useState<Record<string, ShellDeskMongoCollection[]>>({});
  const [expandedDatabases, setExpandedDatabases] = useState<Set<string>>(new Set());
  const [objectSearch, setObjectSearch] = useState('');
  const [selectedCollection, setSelectedCollection] = useState<SelectedMongoCollection | null>(null);
  const [filter, setFilter] = useState('{}');
  const [projection, setProjection] = useState('');
  const [sort, setSort] = useState('');
  const [limit, setLimit] = useState(String(defaultLimit));
  const [queryResult, setQueryResult] = useState<ShellDeskMongoQueryResult | null>(null);
  const [indexes, setIndexes] = useState<ShellDeskMongoIndex[]>([]);
  const [selectedDocumentIndex, setSelectedDocumentIndex] = useState(0);
  const [loadingObjects, setLoadingObjects] = useState(false);
  const [queryRunning, setQueryRunning] = useState(false);
  const [lastQueryAt, setLastQueryAt] = useState('');

  const isConnected = status === 'connected';
  const documents = queryResult?.documents ?? [];
  const documentColumns = useMemo(() => getDocumentColumns(documents), [documents]);
  const selectedDocument = documents[selectedDocumentIndex] ?? documents[0] ?? null;

  const filteredDatabases = useMemo(() => {
    const keyword = objectSearch.trim().toLowerCase();

    return databases
      .map((database) => {
        const collections = collectionsByDatabase[database.name] ?? [];
        if (!keyword) return { database, collections };

        const databaseMatches = database.name.toLowerCase().includes(keyword);
        const filteredCollections = databaseMatches
          ? collections
          : collections.filter((collection) => collection.name.toLowerCase().includes(keyword));

        return { database, collections: filteredCollections };
      })
      .filter((group) => !keyword || group.database.name.toLowerCase().includes(keyword) || group.collections.length > 0);
  }, [collectionsByDatabase, databases, objectSearch]);

  const disconnect = useCallback(async () => {
    if (!api || !mongoIdRef.current) {
      return;
    }

    const currentId = mongoIdRef.current;
    mongoIdRef.current = '';
    await api.mongoDisconnect(connectionId, currentId).catch(() => false);
  }, [api, connectionId]);

  useEffect(() => () => {
    void disconnect();
  }, [disconnect]);

  const loadCollections = useCallback(async (nextMongoId: string, database: string) => {
    if (!api) return [];
    const collections = await api.mongoCollections(connectionId, nextMongoId, database);
    setCollectionsByDatabase((current) => ({ ...current, [database]: collections }));
    return collections;
  }, [api, connectionId]);

  const loadDatabases = useCallback(async (nextMongoId: string) => {
    if (!api) return;

    setLoadingObjects(true);
    try {
      const nextDatabases = await api.mongoDatabases(connectionId, nextMongoId);
      const firstDatabase = nextDatabases[0]?.name ?? '';
      setDatabases(nextDatabases);
      setExpandedDatabases(new Set(firstDatabase ? [firstDatabase] : []));
      setCollectionsByDatabase({});

      if (firstDatabase) {
        const collections = await loadCollections(nextMongoId, firstDatabase);
        const firstCollection = collections[0]?.name;

        if (firstCollection) {
          setSelectedCollection({ database: firstDatabase, collection: firstCollection });
          const nextIndexes = await api.mongoIndexes(connectionId, nextMongoId, firstDatabase, firstCollection);
          setIndexes(nextIndexes);
        }
      }
    } finally {
      setLoadingObjects(false);
    }
  }, [api, connectionId, loadCollections]);

  const connect = async () => {
    if (!api) {
      setError('ShellDesk IPC 未就绪。');
      return;
    }

    setStatus('connecting');
    setError('');
    setNotice('');

    try {
      const result = await api.mongoConnect(connectionId, {
        host,
        port: Number.parseInt(port, 10) || 27017,
        username,
        password,
        authSource,
      });

      mongoIdRef.current = result.mongoId;
      setMongoId(result.mongoId);
      await loadDatabases(result.mongoId);
      setStatus('connected');
      setNotice(result.alreadyConnected ? '已复用 MongoDB 连接。' : 'MongoDB 已连接。');
    } catch (error) {
      setStatus('error');
      setError(getErrorMessage(error));
    }
  };

  const handleDisconnect = async () => {
    await disconnect();
    setStatus('disconnected');
    setMongoId('');
    setDatabases([]);
    setCollectionsByDatabase({});
    setExpandedDatabases(new Set());
    setSelectedCollection(null);
    setQueryResult(null);
    setIndexes([]);
    setNotice('MongoDB 已断开。');
  };

  const toggleDatabase = async (database: string) => {
    if (!mongoId) return;

    setExpandedDatabases((current) => {
      const next = new Set(current);
      if (next.has(database)) next.delete(database);
      else next.add(database);
      return next;
    });

    if (!collectionsByDatabase[database]) {
      try {
        await loadCollections(mongoId, database);
      } catch (error) {
        setError(getErrorMessage(error));
      }
    }
  };

  const selectCollection = async (database: string, collection: string) => {
    setSelectedCollection({ database, collection });
    setSelectedDocumentIndex(0);
    setQueryResult(null);
    setError('');
    setNotice('');

    if (!api || !mongoId) return;

    try {
      const nextIndexes = await api.mongoIndexes(connectionId, mongoId, database, collection);
      setIndexes(nextIndexes);
    } catch (error) {
      setIndexes([]);
      setError(getErrorMessage(error));
    }
  };

  const runQuery = async () => {
    if (!api || !mongoId || !selectedCollection) {
      setError('请先选择集合。');
      return;
    }

    setQueryRunning(true);
    setError('');
    setNotice('');
    const startedAt = performance.now();

    try {
      const result = await api.mongoQuery(connectionId, mongoId, {
        database: selectedCollection.database,
        collection: selectedCollection.collection,
        filter,
        projection,
        sort,
        limit: Number.parseInt(limit, 10) || defaultLimit,
      });
      const durationMs = Math.round(performance.now() - startedAt);
      setQueryResult(result);
      setSelectedDocumentIndex(0);
      setLastQueryAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(`查询完成，返回 ${result.count} 个文档，${durationMs} ms。`);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setQueryRunning(false);
    }
  };

  const formatDraft = (field: 'filter' | 'projection' | 'sort') => {
    try {
      if (field === 'filter') setFilter(tryFormatJsonDraft(filter));
      if (field === 'projection') setProjection(projection.trim() ? tryFormatJsonDraft(projection) : '');
      if (field === 'sort') setSort(sort.trim() ? tryFormatJsonDraft(sort) : '');
      setNotice('JSON 已格式化。');
      setError('');
    } catch (error) {
      setError(`JSON 格式化失败：${getErrorMessage(error)}`);
    }
  };

  const copySelectedDocument = async () => {
    if (!selectedDocument) return;
    await navigator.clipboard.writeText(stringifyJson(selectedDocument));
    setNotice('已复制文档 JSON。');
  };

  if (!isConnected) {
    return (
      <section className="mongo-manager">
        <div className="mongo-connect-panel">
          <div className="mongo-connect-card">
            <div className="mongo-connect-heading">
              <span className="mongo-connect-mark">MDB</span>
              <div>
                <h3>MongoDB 管理器</h3>
                <p>通过当前 SSH 通道浏览数据库、集合、文档和索引。</p>
              </div>
            </div>

            <div className="mongo-connect-grid">
              <label>
                <span>Host</span>
                <input value={host} onChange={(event) => setHost(event.target.value)} />
              </label>
              <label>
                <span>Port</span>
                <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" />
              </label>
              <label>
                <span>Username</span>
                <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="可选" />
              </label>
              <label>
                <span>Password</span>
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="可选" />
              </label>
              <label className="wide">
                <span>Auth Source</span>
                <input value={authSource} onChange={(event) => setAuthSource(event.target.value)} placeholder="admin" />
              </label>
            </div>

            {error ? <DismissibleAlert className="mongo-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
            {notice ? <DismissibleAlert className="mongo-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

            <button type="button" className="mongo-connect-btn" onClick={connect} disabled={status === 'connecting'}>
              {status === 'connecting' ? '连接中' : '连接 MongoDB'}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mongo-manager">
      <aside className="mongo-sidebar">
        <div className="mongo-sidebar-head">
          <div>
            <strong>数据库</strong>
            <span>{databases.length} 个库 · {host}:{port}</span>
          </div>
          <button type="button" onClick={() => loadDatabases(mongoId)} disabled={loadingObjects}>刷新</button>
        </div>
        <input className="mongo-object-search" value={objectSearch} onChange={(event) => setObjectSearch(event.target.value)} placeholder="搜索库或集合" />
        <div className="mongo-object-tree">
          {filteredDatabases.map(({ database, collections }) => {
            const expanded = expandedDatabases.has(database.name);

            return (
              <div key={database.name} className="mongo-database-group">
                <button type="button" className="mongo-database-btn" onClick={() => toggleDatabase(database.name)}>
                  <span>{expanded ? '▾' : '▸'}</span>
                  <strong>{database.name}</strong>
                  <em>{formatBytes(database.sizeOnDisk)}</em>
                </button>
                {expanded ? (
                  <div className="mongo-collection-list">
                    {collections.map((collection) => {
                      const selected = selectedCollection?.database === database.name && selectedCollection.collection === collection.name;

                      return (
                        <button
                          key={`${database.name}.${collection.name}`}
                          type="button"
                          className={selected ? 'active' : ''}
                          onClick={() => selectCollection(database.name, collection.name)}
                        >
                          <strong>{collection.name}</strong>
                          <span>{collection.type}</span>
                        </button>
                      );
                    })}
                    {!collections.length ? <span className="mongo-empty-line">暂无集合</span> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </aside>

      <main className="mongo-main">
        <header className="mongo-topbar">
          <div className="mongo-connection-summary">
            <strong>{selectedCollection ? `${selectedCollection.database}.${selectedCollection.collection}` : '请选择集合'}</strong>
            <span>{lastQueryAt ? `上次查询 ${lastQueryAt}` : 'Filter / projection / sort 支持 Extended JSON'}</span>
          </div>
          <button type="button" onClick={handleDisconnect}>断开</button>
        </header>

        {error ? <DismissibleAlert className="mongo-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
        {notice ? <DismissibleAlert className="mongo-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

        <section className="mongo-query-panel">
          <label className="mongo-editor wide">
            <span>Filter</span>
            <textarea value={filter} onChange={(event) => setFilter(event.target.value)} spellCheck={false} />
            <button type="button" onClick={() => formatDraft('filter')}>格式化</button>
          </label>
          <label className="mongo-editor">
            <span>Projection</span>
            <textarea value={projection} onChange={(event) => setProjection(event.target.value)} placeholder='{"name": 1}' spellCheck={false} />
            <button type="button" onClick={() => formatDraft('projection')}>格式化</button>
          </label>
          <label className="mongo-editor">
            <span>Sort</span>
            <textarea value={sort} onChange={(event) => setSort(event.target.value)} placeholder='{"createdAt": -1}' spellCheck={false} />
            <button type="button" onClick={() => formatDraft('sort')}>格式化</button>
          </label>
          <div className="mongo-query-actions">
            <label>
              <span>Limit</span>
              <input value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" />
            </label>
            <button type="button" className="primary" onClick={runQuery} disabled={queryRunning || !selectedCollection}>
              {queryRunning ? '查询中' : '执行查询'}
            </button>
          </div>
        </section>

        <section className="mongo-result-panel">
          <div className="mongo-result-head">
            <strong>文档</strong>
            <span>{queryResult ? `${queryResult.count} / limit ${queryResult.limit}` : '尚未查询'}</span>
          </div>
          <div className="mongo-table-wrap">
            <table className="mongo-table">
              <thead>
                <tr>
                  {documentColumns.map((column) => <th key={column}>{column}</th>)}
                </tr>
              </thead>
              <tbody>
                {documents.map((document, index) => (
                  <tr key={`${getDocumentId(document, index)}-${index}`} className={index === selectedDocumentIndex ? 'selected' : ''} onClick={() => setSelectedDocumentIndex(index)}>
                    {documentColumns.map((column) => <td key={column}>{formatCellValue(document[column])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {!documents.length ? <div className="mongo-empty-state">暂无文档。选择集合后执行查询。</div> : null}
          </div>
        </section>
      </main>

      <aside className="mongo-detail">
        <section className="mongo-detail-section">
          <div>
            <strong>文档详情</strong>
            <span>{selectedDocument ? getDocumentId(selectedDocument, selectedDocumentIndex) : '未选择'}</span>
          </div>
          <button type="button" onClick={copySelectedDocument} disabled={!selectedDocument}>复制</button>
        </section>
        <pre className="mongo-json-view">{selectedDocument ? stringifyJson(selectedDocument) : '选择一条文档查看 JSON。'}</pre>
        <section className="mongo-detail-section">
          <div>
            <strong>索引</strong>
            <span>{indexes.length} 个</span>
          </div>
        </section>
        <div className="mongo-index-list">
          {indexes.map((index) => (
            <div key={index.name} className="mongo-index-card">
              <strong>{index.name}</strong>
              <code>{stringifyJson(index.key)}</code>
              <span>
                {index.unique ? 'unique' : 'normal'}
                {index.sparse ? ' · sparse' : ''}
                {index.expireAfterSeconds !== undefined ? ` · ttl ${index.expireAfterSeconds}s` : ''}
              </span>
            </div>
          ))}
          {!indexes.length ? <div className="mongo-empty-state compact">暂无索引信息。</div> : null}
        </div>
      </aside>
    </section>
  );
}

export default RemoteMongo;
