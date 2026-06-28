import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage } from '../components/remote-desktop/desktopUtils';
import { useCurrentAppLanguage } from '../i18n';

interface KnownHostsPageProps {
  hosts: ShellDeskStoredHostRecord[];
  knownHosts: ShellDeskKnownHost[];
  onKnownHostsChange: (
    knownHosts: ShellDeskKnownHost[],
    hosts?: ShellDeskStoredHostRecord[],
  ) => void;
}

type LoadStatus = 'idle' | 'loading' | 'saved' | 'error';

let hasAutoScannedSystemKnownHosts = false;

function text(language: ShellDeskAppSettings['language']) {
  return language === 'zh-CN'
    ? {
        search: '搜索',
        searchPlaceholder: '查找主机、端口、密钥类型或指纹',
        scan: '扫描系统',
        importFile: '导入文件',
        list: '已知主机',
        count: '共 {count} 个记录',
        saved: '已更新',
        loading: '读取中...',
        failed: '读取失败：{error}',
        clearSearch: '清除搜索',
        emptyTitle: '暂无已知主机',
        emptyMatches: '没有匹配的已知主机',
        emptyDesc: '扫描系统 known_hosts 或导入文件后，会在这里看到可信主机指纹。',
        emptyMatchesDesc: '清空搜索后再试。',
        add: '添加',
        addTitle: '添加到主机列表',
        addMessage: '是否将「{name}」添加到主机列表？',
        converted: '已转为主机',
        hashed: '哈希主机名无法转换',
        cancel: '取消',
        noApi: '当前运行环境不支持读取系统 known_hosts。',
        noFile: '没有读取到系统 known_hosts 文件。',
        noEntries: '没有发现可导入的 known_hosts 记录。',
        imported: '已导入 {count} 条记录。',
        noNew: '没有新的 known_hosts 记录。',
        fileFailed: '读取文件失败：{error}',
        systemPaths: '来源：{paths}',
        groupName: 'Known Hosts',
        notePrefix: '由 known_hosts 转换',
      }
    : {
        search: 'Search',
        searchPlaceholder: 'Search host, port, key type, or fingerprint',
        scan: 'Scan system',
        importFile: 'Import file',
        list: 'Known hosts',
        count: '{count} records',
        saved: 'Updated',
        loading: 'Reading...',
        failed: 'Read failed: {error}',
        clearSearch: 'Clear search',
        emptyTitle: 'No known hosts yet',
        emptyMatches: 'No matching known hosts',
        emptyDesc: 'Scan system known_hosts or import a file to view trusted host fingerprints.',
        emptyMatchesDesc: 'Clear search and try again.',
        add: 'Add',
        addTitle: 'Add to host list',
        addMessage: 'Add "{name}" to the host list?',
        converted: 'Converted',
        hashed: 'Hashed host names cannot be converted',
        cancel: 'Cancel',
        noApi: 'This runtime cannot read system known_hosts.',
        noFile: 'No system known_hosts file was read.',
        noEntries: 'No importable known_hosts records were found.',
        imported: 'Imported {count} records.',
        noNew: 'No new known_hosts records.',
        fileFailed: 'Failed to read file: {error}',
        systemPaths: 'Source: {paths}',
        groupName: 'Known Hosts',
        notePrefix: 'Converted from known_hosts',
      };
}

function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatCount(template: string, count: number) {
  return template.replace('{count}', String(count));
}

function isHashedHostname(hostname: string) {
  return hostname === '(hashed)' || hostname.startsWith('|1|');
}

function parseHostPattern(hostPattern: string) {
  let hostname = hostPattern;
  let port = 22;
  const bracketMatch = hostPattern.match(/^\[([^\]]+)\]:(\d+)$/u);

  if (bracketMatch) {
    hostname = bracketMatch[1];
    port = Number(bracketMatch[2]);
  } else if (hostPattern.includes(',')) {
    hostname = hostPattern.split(',')[0] ?? hostPattern;
  }

  if (hostname.startsWith('|1|')) {
    hostname = '(hashed)';
  }

  return {
    hostname,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
  };
}

function base64ToBytes(value: string) {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/=+$/u, '');
}

async function fingerprintFromPublicKey(publicKey: string) {
  const trimmed = publicKey.trim();

  if (/^SHA256:/iu.test(trimmed)) {
    return trimmed.replace(/^SHA256:/iu, '').replace(/=+$/u, '');
  }

  const parts = trimmed.split(/\s+/u);
  const keyBytes = parts.length >= 2 ? base64ToBytes(parts[1]) : null;

  if (!keyBytes || !crypto.subtle) {
    return '';
  }

  const digest = await crypto.subtle.digest('SHA-256', keyBytes);
  return bytesToBase64(new Uint8Array(digest));
}

async function parseKnownHostsContent(content: string) {
  const parsed: ShellDeskKnownHost[] = [];
  const now = new Date().toISOString();

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const parts = line.split(/\s+/u);

    if (parts[0]?.startsWith('@')) {
      parts.shift();
    }

    if (parts.length < 3) {
      continue;
    }

    const [hostPattern, keyType, keyBlob] = parts;
    const { hostname, port } = parseHostPattern(hostPattern);
    const publicKey = `${keyType} ${keyBlob}`;
    const fingerprint = await fingerprintFromPublicKey(publicKey);

    parsed.push({
      id: createId(),
      hostname,
      port,
      keyType,
      publicKey,
      fingerprint,
      discoveredAt: now,
      lastSeen: now,
      convertedToHostId: '',
    });
  }

  return parsed;
}

function getEndpointKey(hostname: string, port: number) {
  return `${hostname.trim().toLowerCase()}:${port}`;
}

function getKnownHostEndpointKey(knownHost: Pick<ShellDeskKnownHost, 'hostname' | 'port'>) {
  return getEndpointKey(knownHost.hostname, knownHost.port);
}

function getKnownHostSortTime(knownHost: ShellDeskKnownHost) {
  return Date.parse(knownHost.lastSeen || knownHost.discoveredAt);
}

function sortKnownHostsByLastSeen(knownHosts: ShellDeskKnownHost[]) {
  return [...knownHosts].sort((left, right) => getKnownHostSortTime(right) - getKnownHostSortTime(left));
}

function dedupeKnownHostsByEndpoint(knownHosts: ShellDeskKnownHost[]) {
  const byEndpoint = new Map<string, ShellDeskKnownHost>();

  for (const knownHost of sortKnownHostsByLastSeen(knownHosts)) {
    const key = getKnownHostEndpointKey(knownHost);

    if (!byEndpoint.has(key)) {
      byEndpoint.set(key, knownHost);
    }
  }

  return Array.from(byEndpoint.values());
}

function mergeKnownHosts(currentHosts: ShellDeskKnownHost[], incomingHosts: ShellDeskKnownHost[]) {
  const byKey = new Map(dedupeKnownHostsByEndpoint(currentHosts).map((knownHost) => [getKnownHostEndpointKey(knownHost), knownHost]));
  let importedCount = 0;

  for (const incoming of incomingHosts) {
    const key = getKnownHostEndpointKey(incoming);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, incoming);
      importedCount += 1;
      continue;
    }

    byKey.set(key, {
      ...existing,
      keyType: incoming.keyType || existing.keyType,
      publicKey: incoming.publicKey || existing.publicKey,
      fingerprint: incoming.fingerprint || existing.fingerprint,
      lastSeen: incoming.lastSeen || incoming.discoveredAt,
    });
  }

  return {
    knownHosts: sortKnownHostsByLastSeen(Array.from(byKey.values())),
    importedCount,
  };
}

function createHostFromKnownHost(knownHost: ShellDeskKnownHost, groupName: string, notePrefix: string): ShellDeskStoredHostRecord {
  const now = new Date().toISOString();
  const noteParts = [
    notePrefix,
    `${knownHost.keyType} ${knownHost.fingerprint ? `SHA256:${knownHost.fingerprint}` : ''}`.trim(),
  ].filter(Boolean);

  return {
    id: createId(),
    name: knownHost.hostname,
    address: knownHost.hostname,
    port: knownHost.port,
    username: 'root',
    authMethod: 'password',
    password: '',
    keyId: '',
    keyPath: '',
    passphrase: '',
    privilegeMode: 'sudo',
    rootPassword: '',
    jumpHostId: '',
    canBeJumpHost: false,
    proxyProfileId: '',
    systemType: 'unknown',
    systemName: '',
    lastConnectionStatus: 'unknown',
    lastConnectionAt: '',
    lastConnectionError: '',
    group: groupName,
    tags: knownHost.keyType ? [knownHost.keyType] : [],
    note: noteParts.join('\n'),
    createdAt: now,
    updatedAt: now,
  };
}

function KnownHostsPage({ hosts, knownHosts, onKnownHostsChange }: KnownHostsPageProps) {
  const language = useCurrentAppLanguage();
  const copy = text(language);
  const [searchQuery, setSearchQuery] = useState('');
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [addTarget, setAddTarget] = useState<ShellDeskKnownHost | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hostEndpointSet = useMemo(() => (
    new Set(hosts.map((host) => getEndpointKey(host.address, host.port)))
  ), [hosts]);
  const filteredKnownHosts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return dedupeKnownHostsByEndpoint(knownHosts.filter((knownHost) => {
      const matchesQuery = !query || [
        knownHost.hostname,
        String(knownHost.port),
        knownHost.keyType,
        knownHost.fingerprint,
        knownHost.publicKey,
      ].join(' ').toLowerCase().includes(query);

      return matchesQuery;
    }));
  }, [knownHosts, searchQuery]);

  const importKnownHosts = (incomingHosts: ShellDeskKnownHost[], detail = '') => {
    if (!incomingHosts.length) {
      setStatus('idle');
      setStatusDetail(copy.noEntries);
      return;
    }

    const merged = mergeKnownHosts(knownHosts, incomingHosts);
    onKnownHostsChange(merged.knownHosts);
    setStatus('saved');
    setStatusDetail(
      merged.importedCount
        ? `${copy.imported.replace('{count}', String(merged.importedCount))}${detail ? ` ${detail}` : ''}`
        : copy.noNew,
    );
  };

  const scanSystemKnownHosts = async (options: { silentNoApi?: boolean } = {}) => {
    const readKnownHosts = window.guiSSH?.system?.readKnownHosts;

    if (!readKnownHosts) {
      if (!options.silentNoApi) {
        setStatus('error');
        setStatusDetail(copy.noApi);
      }
      return;
    }

    setStatus('loading');
    setStatusDetail(copy.loading);

    try {
      const result = await readKnownHosts();

      if (!result.content.trim()) {
        setStatus('idle');
        setStatusDetail(copy.noFile);
        return;
      }

      const parsed = await parseKnownHostsContent(result.content);
      importKnownHosts(parsed, result.paths.length ? copy.systemPaths.replace('{paths}', result.paths.join(', ')) : '');
    } catch (error) {
      setStatus('error');
      setStatusDetail(copy.failed.replace('{error}', getErrorMessage(error)));
    }
  };

  useEffect(() => {
    if (hasAutoScannedSystemKnownHosts) {
      return;
    }

    hasAutoScannedSystemKnownHosts = true;
    void scanSystemKnownHosts({ silentNoApi: true });
  }, []);

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setStatus('loading');
    setStatusDetail(copy.loading);

    try {
      const content = await file.text();
      const parsed = await parseKnownHostsContent(content);
      importKnownHosts(parsed);
    } catch (error) {
      setStatus('error');
      setStatusDetail(copy.fileFailed.replace('{error}', getErrorMessage(error)));
    } finally {
      event.target.value = '';
    }
  };

  const convertKnownHost = (knownHost: ShellDeskKnownHost) => {
    if (isHashedHostname(knownHost.hostname)) {
      setStatus('error');
      setStatusDetail(copy.hashed);
      return;
    }

    const host = createHostFromKnownHost(knownHost, copy.groupName, copy.notePrefix);
    const nextKnownHosts = knownHosts.map((item) => (
      item.id === knownHost.id
        ? { ...item, convertedToHostId: host.id, lastSeen: new Date().toISOString() }
        : item
    ));

    onKnownHostsChange(nextKnownHosts, [host, ...hosts]);
    setStatus('saved');
    setStatusDetail(copy.converted);
  };

  const statusText = status === 'loading'
    ? copy.loading
    : statusDetail || (status === 'saved' ? copy.saved : '');
  const emptyTitle = knownHosts.length ? copy.emptyMatches : copy.emptyTitle;
  const emptyDesc = knownHosts.length ? copy.emptyMatchesDesc : copy.emptyDesc;

  return (
    <>
      <div className="command-bar no-drag network-assets-command-bar known-hosts-command-bar">
        <label className="global-search network-assets-search">
          <span>{copy.search}</span>
          <input
            type="search"
            placeholder={copy.searchPlaceholder}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>

        {statusText ? (
          <span className={`network-save-state ${status}`} role={status === 'error' ? 'alert' : 'status'}>
            {statusText}
          </span>
        ) : null}

        <button type="button" className="command-button" onClick={() => void scanSystemKnownHosts()} disabled={status === 'loading'}>
          {copy.scan}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,known_hosts"
          className="network-hidden-input"
          onChange={(event) => void handleFileSelected(event)}
        />
        <button type="button" className="primary-action" onClick={() => fileInputRef.current?.click()}>
          {copy.importFile}
        </button>
      </div>

      <section className="vault-content hosts-content network-assets-content">
        <section className="vault-section host-section hosts-list-panel network-list-panel">
          <div className="section-heading host-list-heading">
            <div className="host-list-title">
              <h2>{copy.list} <b>{filteredKnownHosts.length}</b></h2>
            </div>
            <span className="host-list-controls">
              {formatCount(copy.count, filteredKnownHosts.length)}
              {searchQuery.trim() ? (
                <button
                  type="button"
                  className="host-refresh-button network-clear-filter"
                  onClick={() => setSearchQuery('')}
                  aria-label={copy.clearSearch}
                  title={copy.clearSearch}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </span>
          </div>

          <div className="host-list-scroll">
            {filteredKnownHosts.length ? (
              <div className="host-grid grid network-card-grid">
                {filteredKnownHosts.map((knownHost) => {
                  const existsInHostList = hostEndpointSet.has(getEndpointKey(knownHost.hostname, knownHost.port));

                  return (
                    <article key={knownHost.id} className={`host-card network-card known-host-card ${existsInHostList ? 'converted' : 'clickable'}`}>
                      <button
                        type="button"
                        className="host-card-main network-card-main"
                        disabled={existsInHostList}
                        onClick={() => {
                          if (isHashedHostname(knownHost.hostname)) {
                            setStatus('error');
                            setStatusDetail(copy.hashed);
                            return;
                          }

                          setAddTarget(knownHost);
                        }}
                      >
                        <span className="host-avatar network-avatar known" aria-hidden="true">
                          {existsInHostList ? '√' : '+'}
                        </span>
                        <span className="host-summary network-summary">
                          <strong>{knownHost.hostname}</strong>
                          <small>{knownHost.hostname}:{knownHost.port}</small>
                        </span>
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state network-empty">
                <span>KNOWN HOSTS</span>
                <h3>{emptyTitle}</h3>
                <p>{emptyDesc}</p>
              </div>
            )}
          </div>
        </section>
      </section>

      {addTarget ? (
        <div className="notepad-modal-overlay no-drag" role="presentation" onClick={() => setAddTarget(null)}>
          <div className="notepad-modal" role="alertdialog" aria-modal="true" aria-labelledby="known-host-add-title" onClick={(event) => event.stopPropagation()}>
            <div id="known-host-add-title" className="notepad-modal-title">{copy.addTitle}</div>
            <div className="notepad-modal-message">
              {copy.addMessage.replace('{name}', `${addTarget.hostname}:${addTarget.port}`)}
            </div>
            <div className="notepad-modal-actions">
              <button type="button" onClick={() => setAddTarget(null)}>{copy.cancel}</button>
              <button
                type="button"
                onClick={() => {
                  convertKnownHost(addTarget);
                  setAddTarget(null);
                }}
              >
                {copy.add}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default KnownHostsPage;
