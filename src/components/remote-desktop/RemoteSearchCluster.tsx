import { useCallback, useMemo, useState } from 'react';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import {
  createSearchClusterCommand,
  normalizeIndices,
  normalizeShards,
  parseJsonResponse,
  type SearchClusterHealth,
  type SearchClusterIndex,
  type SearchClusterShard,
} from './searchClusterUtils';
import type { RemoteSystemType } from './types';

interface RemoteSearchClusterProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type SearchTab = 'overview' | 'shards' | 'query' | 'raw';

function stringifyJson(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? '' : text;
}

function getHealthTone(status?: string) {
  if (status === 'green') return 'green';
  if (status === 'yellow') return 'yellow';
  if (status === 'red') return 'red';
  return 'unknown';
}

function runCmd(connectionId: string, command: string, stdin?: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, command, stdin);
}

function RemoteSearchCluster({ connectionId, systemType }: RemoteSearchClusterProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [url, setUrl] = useState('http://127.0.0.1:9200');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState('10');
  const [ignoreSslCertificate, setIgnoreSslCertificate] = useState(false);
  const [health, setHealth] = useState<SearchClusterHealth | null>(null);
  const [indices, setIndices] = useState<SearchClusterIndex[]>([]);
  const [shards, setShards] = useState<SearchClusterShard[]>([]);
  const [selectedIndexName, setSelectedIndexName] = useState('');
  const [indexSearch, setIndexSearch] = useState('');
  const [activeTab, setActiveTab] = useState<SearchTab>('overview');
  const [queryIndex, setQueryIndex] = useState('');
  const [queryBody, setQueryBody] = useState('{\n  "query": {\n    "match_all": {}\n  },\n  "size": 10\n}');
  const [queryResponse, setQueryResponse] = useState('');
  const [rawResponse, setRawResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [queryRunning, setQueryRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');

  const config = useMemo(() => ({
    url,
    username,
    password,
    timeoutSeconds: Number.parseInt(timeoutSeconds, 10) || 10,
    ignoreSslCertificate,
  }), [ignoreSslCertificate, password, timeoutSeconds, url, username]);

  const filteredIndices = useMemo(() => {
    const keyword = indexSearch.trim().toLowerCase();
    return keyword ? indices.filter((index) => index.index.toLowerCase().includes(keyword)) : indices;
  }, [indexSearch, indices]);

  const selectedIndex = useMemo(() => {
    return indices.find((index) => index.index === selectedIndexName) ?? indices[0] ?? null;
  }, [indices, selectedIndexName]);

  const selectedIndexShards = useMemo(() => {
    if (!selectedIndex) return shards;
    return shards.filter((shard) => shard.index === selectedIndex.index);
  }, [selectedIndex, shards]);

  const executeJsonRequest = useCallback(async <T,>(path: string, label: string): Promise<T> => {
    const request = createSearchClusterCommand(config, path, { isWindowsHost });
    const result = await runCmd(connectionId, request.command, request.stdin);
    setRawResponse(result.stdout || result.stderr);
    return parseJsonResponse<T>(result.stdout, result.stderr, result.code, label);
  }, [config, connectionId, isWindowsHost]);

  const refreshCluster = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const [nextHealth, indexRows, shardRows] = await Promise.all([
        executeJsonRequest<SearchClusterHealth>('/_cluster/health', 'Cluster health'),
        executeJsonRequest<Array<Record<string, unknown>>>('/_cat/indices?format=json&bytes=b', 'Indices'),
        executeJsonRequest<Array<Record<string, unknown>>>('/_cat/shards?format=json&bytes=b', 'Shards'),
      ]);
      const nextIndices = normalizeIndices(indexRows);
      const nextShards = normalizeShards(shardRows);

      setHealth(nextHealth);
      setIndices(nextIndices);
      setShards(nextShards);
      setSelectedIndexName((current) => current && nextIndices.some((index) => index.index === current) ? current : nextIndices[0]?.index ?? '');
      setQueryIndex((current) => current || nextIndices[0]?.index || '');
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(`集群已刷新：${nextIndices.length} 个索引，${nextShards.length} 个分片。`);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [executeJsonRequest]);

  const runSearch = async () => {
    const indexName = queryIndex.trim() || selectedIndex?.index || '';

    if (!indexName) {
      setError('请输入或选择索引。');
      return;
    }

    try {
      JSON.parse(queryBody);
    } catch (error) {
      setError(`查询 Body 不是有效 JSON：${getErrorMessage(error)}`);
      return;
    }

    setQueryRunning(true);
    setError('');
    setNotice('');

    try {
      const request = createSearchClusterCommand(config, `/${encodeURIComponent(indexName)}/_search`, {
        body: queryBody,
        isWindowsHost,
        method: 'POST',
      });
      const startedAt = performance.now();
      const result = await runCmd(connectionId, request.command, request.stdin);
      const response = parseJsonResponse<unknown>(result.stdout, result.stderr, result.code, '_search');
      const durationMs = Math.round(performance.now() - startedAt);

      setQueryResponse(stringifyJson(response));
      setRawResponse(result.stdout || result.stderr);
      setActiveTab('query');
      setNotice(`查询完成，${durationMs} ms。`);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setQueryRunning(false);
    }
  };

  const formatQueryBody = () => {
    try {
      setQueryBody(stringifyJson(JSON.parse(queryBody)));
      setNotice('JSON 已格式化。');
      setError('');
    } catch (error) {
      setError(`JSON 格式化失败：${getErrorMessage(error)}`);
    }
  };

  const copyDiagnostics = async () => {
    await navigator.clipboard.writeText(stringifyJson({
      health,
      selectedIndex,
      shards: selectedIndexShards,
      queryResponse: queryResponse ? JSON.parse(queryResponse) : undefined,
    }));
    setNotice('已复制诊断信息。');
  };

  return (
    <section className="search-cluster">
      <header className="search-cluster-toolbar">
        <div className={`search-health ${getHealthTone(health?.status)}`}>
          <span>Cluster</span>
          <strong>{health?.cluster_name ?? 'Elasticsearch / OpenSearch'}</strong>
          <em>{health?.status ?? 'not connected'}</em>
        </div>
        <label>
          <span>URL</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} />
        </label>
        <label>
          <span>User</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="可选" />
        </label>
        <label>
          <span>Password</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="可选" />
        </label>
        <label className="timeout">
          <span>Timeout</span>
          <input value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} inputMode="numeric" />
        </label>
        <label className="search-tls-option" title="连接 HTTPS 集群时跳过证书校验">
          <input type="checkbox" checked={ignoreSslCertificate} onChange={(event) => setIgnoreSslCertificate(event.target.checked)} />
          <span>忽略证书</span>
        </label>
        <button type="button" className="primary" onClick={refreshCluster} disabled={loading}>
          {loading ? '刷新中' : '连接 / 刷新'}
        </button>
      </header>

      {error ? <div className="search-alert danger">{error}</div> : null}
      {notice ? <div className="search-alert info">{notice}</div> : null}

      <div className="search-cluster-layout">
        <aside className="search-index-panel">
          <div className="search-panel-head">
            <div>
              <strong>索引</strong>
              <span>{indices.length} 个 · {lastRefreshedAt || '未刷新'}</span>
            </div>
            <button type="button" onClick={copyDiagnostics} disabled={!health}>复制诊断</button>
          </div>
          <input value={indexSearch} onChange={(event) => setIndexSearch(event.target.value)} placeholder="搜索索引" />
          <div className="search-index-list">
            {filteredIndices.map((index) => (
              <button
                key={index.index}
                type="button"
                className={`${selectedIndex?.index === index.index ? 'active' : ''} ${index.health || 'unknown'}`}
                onClick={() => {
                  setSelectedIndexName(index.index);
                  setQueryIndex(index.index);
                }}
              >
                <strong>{index.index}</strong>
                <span>{index.docsCount.toLocaleString(getShellDeskLocale())} docs · {index.storeSize || '-'}</span>
                <em>{index.health || 'unknown'} · {index.status || '-'}</em>
              </button>
            ))}
            {!filteredIndices.length ? <div className="search-empty-state">暂无索引。</div> : null}
          </div>
        </aside>

        <main className="search-main">
          <nav className="search-tabs">
            {[
              ['overview', '概览'],
              ['shards', '分片'],
              ['query', '查询'],
              ['raw', '原始响应'],
            ].map(([key, label]) => (
              <button key={key} type="button" className={activeTab === key ? 'active' : ''} onClick={() => setActiveTab(key as SearchTab)}>{label}</button>
            ))}
          </nav>

          {activeTab === 'overview' ? (
            <section className="search-overview">
              {[
                ['节点', health?.number_of_nodes ?? '-'],
                ['数据节点', health?.number_of_data_nodes ?? '-'],
                ['索引', indices.length],
                ['主分片', health?.active_primary_shards ?? '-'],
                ['活跃分片', health?.active_shards ?? '-'],
                ['迁移中', health?.relocating_shards ?? '-'],
                ['初始化', health?.initializing_shards ?? '-'],
                ['未分配', health?.unassigned_shards ?? '-'],
              ].map(([label, value]) => (
                <div key={label} className="search-metric">
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
              <div className="search-selected-index">
                <strong>{selectedIndex?.index ?? '未选择索引'}</strong>
                <span>{selectedIndex ? `${selectedIndex.docsCount.toLocaleString(getShellDeskLocale())} docs · ${selectedIndex.storeSize || '-'}` : '刷新后选择索引查看详情'}</span>
              </div>
            </section>
          ) : null}

          {activeTab === 'shards' ? (
            <section className="search-table-wrap">
              <table className="search-table">
                <thead>
                  <tr>
                    <th>Index</th>
                    <th>Shard</th>
                    <th>Role</th>
                    <th>State</th>
                    <th>Docs</th>
                    <th>Store</th>
                    <th>Node</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedIndexShards.map((shard, index) => (
                    <tr key={`${shard.index}-${shard.shard}-${shard.prirep}-${index}`}>
                      <td>{shard.index}</td>
                      <td>{shard.shard}</td>
                      <td>{shard.prirep}</td>
                      <td>{shard.state}</td>
                      <td>{shard.docs}</td>
                      <td>{shard.store}</td>
                      <td>{shard.node || shard.ip}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!selectedIndexShards.length ? <div className="search-empty-state">暂无分片数据。</div> : null}
            </section>
          ) : null}

          {activeTab === 'query' ? (
            <section className="search-query">
              <div className="search-query-form">
                <label>
                  <span>Index</span>
                  <input value={queryIndex} onChange={(event) => setQueryIndex(event.target.value)} placeholder="logs-*" />
                </label>
                <div className="search-query-actions">
                  <button type="button" onClick={formatQueryBody}>格式化 JSON</button>
                  <button type="button" className="primary" onClick={runSearch} disabled={queryRunning}>{queryRunning ? '查询中' : '执行 _search'}</button>
                </div>
              </div>
              <div className="search-query-grid">
                <textarea value={queryBody} onChange={(event) => setQueryBody(event.target.value)} spellCheck={false} />
                <pre>{queryResponse || '查询响应会显示在这里。'}</pre>
              </div>
            </section>
          ) : null}

          {activeTab === 'raw' ? (
            <pre className="search-raw">{rawResponse || '刷新或查询后显示最后一次原始响应。'}</pre>
          ) : null}
        </main>
      </div>
    </section>
  );
}

export default RemoteSearchCluster;
