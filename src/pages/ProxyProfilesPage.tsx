import { type FormEvent, useMemo, useRef, useState } from 'react';

import { useCurrentAppLanguage } from '../i18n';

interface ProxyProfilesPageProps {
  hosts: ShellDeskStoredHostRecord[];
  proxyProfiles: ShellDeskProxyProfile[];
  onProxyProfilesChange: (
    proxyProfiles: ShellDeskProxyProfile[],
    hosts?: ShellDeskStoredHostRecord[],
  ) => void;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type ProxyTestStatus = 'testing' | 'success' | 'error';

interface ProxyTestState {
  status: ProxyTestStatus;
  message: string;
  detail: string;
}

interface ProxyDraft {
  id: string;
  label: string;
  type: ShellDeskProxyType;
  host: string;
  port: string;
  command: string;
  username: string;
  password: string;
  createdAt: string;
}

const emptyDraft: ProxyDraft = {
  id: '',
  label: '',
  type: 'http',
  host: '',
  port: '8080',
  command: '',
  username: '',
  password: '',
  createdAt: '',
};

const proxyTypes: ShellDeskProxyType[] = ['http', 'socks5', 'command'];

const typeLabels: Record<ShellDeskProxyType, string> = {
  http: 'HTTP',
  socks5: 'SOCKS5',
  command: 'ProxyCommand',
};

function text(language: ShellDeskAppSettings['language']) {
  return language === 'zh-CN'
    ? {
        search: '搜索',
        searchPlaceholder: '查找代理名称、主机或命令',
        newProxy: '新建代理',
        saved: '已保存',
        saving: '正在保存...',
        saveFailed: '保存失败',
        type: '类型',
        proxyList: '代理列表',
        count: '共 {count} 个代理',
        clearSearch: '清除搜索',
        emptyTitle: '暂无代理配置',
        emptyMatches: '没有匹配的代理',
        emptyDesc: '添加 HTTP、SOCKS5 或 ProxyCommand 代理后，可在主机表单中选择使用。',
        emptyMatchesDesc: '清空搜索后再试。',
        editTitle: '编辑代理',
        createTitle: '新建代理',
        editorHint: '保存后写入本地 Vault。',
        save: '保存',
        cancel: '取消',
        name: '名称',
        namePlaceholder: '例如：Office SOCKS',
        host: '代理主机',
        port: '端口',
        command: '代理命令',
        commandHint: '支持 {host}/{port} 或 %h/%p 占位符。',
        username: '用户名',
        password: '密码',
        optional: '可选',
        actions: '代理操作',
        test: '测试',
        testing: '测试中...',
        testSuccess: '{latency} ms',
        testFailed: '不可用：{error}',
        testUnavailable: '当前运行环境不支持代理测试。',
        testTarget: '测试目标 {host}:{port}',
        testRequired: '请填写代理主机/端口或 ProxyCommand 后再测试。',
        edit: '编辑',
        duplicate: '复制',
        delete: '删除',
        deleteTitle: '删除代理',
        deleteMessage: '删除「{name}」后，{count} 台主机的代理引用会被清除。',
        required: '请填写代理名称，以及代理主机/端口或 ProxyCommand。',
        invalidPort: '代理端口必须是 1 到 65535 之间的整数。',
        usage: '{count} 台主机',
        copySuffix: '副本',
      }
    : {
        search: 'Search',
        searchPlaceholder: 'Search proxy name, host, or command',
        newProxy: 'New proxy',
        saved: 'Saved',
        saving: 'Saving...',
        saveFailed: 'Save failed',
        type: 'Type',
        proxyList: 'Proxy list',
        count: '{count} proxies',
        clearSearch: 'Clear search',
        emptyTitle: 'No proxy profiles yet',
        emptyMatches: 'No matching proxies',
        emptyDesc: 'Add an HTTP, SOCKS5, or ProxyCommand proxy and select it from a host form.',
        emptyMatchesDesc: 'Clear search and try again.',
        editTitle: 'Edit proxy',
        createTitle: 'New proxy',
        editorHint: 'Saved changes are written to local Vault.',
        save: 'Save',
        cancel: 'Cancel',
        name: 'Name',
        namePlaceholder: 'Example: Office SOCKS',
        host: 'Proxy host',
        port: 'Port',
        command: 'Proxy command',
        commandHint: 'Supports {host}/{port} or %h/%p placeholders.',
        username: 'Username',
        password: 'Password',
        optional: 'Optional',
        actions: 'Proxy actions',
        test: 'Test',
        testing: 'Testing...',
        testSuccess: '{latency} ms',
        testFailed: 'Unavailable: {error}',
        testUnavailable: 'This runtime cannot test proxies.',
        testTarget: 'Test target {host}:{port}',
        testRequired: 'Enter proxy host/port or ProxyCommand before testing.',
        edit: 'Edit',
        duplicate: 'Duplicate',
        delete: 'Delete',
        deleteTitle: 'Delete proxy',
        deleteMessage: 'Deleting "{name}" clears proxy references on {count} hosts.',
        required: 'Enter a proxy name and proxy host/port or ProxyCommand.',
        invalidPort: 'Proxy port must be an integer from 1 to 65535.',
        usage: '{count} hosts',
        copySuffix: 'copy',
      };
}

function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function closeDetailsMenu(target: HTMLElement) {
  const menu = target.closest('details');

  if (menu instanceof HTMLDetailsElement) {
    menu.open = false;
  }
}

function profileToDraft(profile: ShellDeskProxyProfile): ProxyDraft {
  return {
    id: profile.id,
    label: profile.label,
    type: profile.config.type,
    host: profile.config.host,
    port: profile.config.type === 'command' ? '' : String(profile.config.port),
    command: profile.config.command ?? '',
    username: profile.config.username ?? '',
    password: profile.config.password ?? '',
    createdAt: profile.createdAt,
  };
}

function getEndpoint(config: ShellDeskProxyConfig) {
  return config.type === 'command'
    ? (config.command || 'ProxyCommand')
    : `${config.host}:${config.port}`;
}

function formatCount(template: string, count: number) {
  return template.replace('{count}', String(count));
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /u, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return 'unknown';
}

function formatProxyTestDetail(template: string, result: ShellDeskProxyTestResult) {
  return template
    .replace('{host}', result.targetHost)
    .replace('{port}', String(result.targetPort));
}

function formatProxyTestMessage(
  copy: ReturnType<typeof text>,
  result: ShellDeskProxyTestResult,
) {
  if (result.ok) {
    return copy.testSuccess.replace('{latency}', String(result.latencyMs));
  }

  return copy.testFailed.replace('{error}', result.error || 'unknown');
}

function buildConfigFromDraft(draft: ProxyDraft): ShellDeskProxyConfig {
  const isCommand = draft.type === 'command';

  return isCommand
    ? {
        type: 'command',
        host: '',
        port: 0,
        command: draft.command.trim(),
        username: '',
        password: '',
      }
    : {
        type: draft.type,
        host: draft.host.trim(),
        port: Number(draft.port),
        command: '',
        username: draft.username.trim(),
        password: draft.password,
      };
}

function validateProxyDraft(
  draft: ProxyDraft,
  copy: ReturnType<typeof text>,
  options: { requireLabel: boolean },
) {
  const isCommand = draft.type === 'command';
  const port = Number(draft.port);

  if (options.requireLabel && !draft.label.trim()) {
    return copy.required;
  }

  if (isCommand ? !draft.command.trim() : (!draft.host.trim() || !draft.port.trim())) {
    return options.requireLabel ? copy.required : copy.testRequired;
  }

  if (!isCommand && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return copy.invalidPort;
  }

  return '';
}

function createProxyTestState(
  copy: ReturnType<typeof text>,
  result: ShellDeskProxyTestResult,
): ProxyTestState {
  const message = formatProxyTestMessage(copy, result);

  return {
    status: result.ok ? 'success' : 'error',
    message,
    detail: `${formatProxyTestDetail(copy.testTarget, result)} · ${message}`,
  };
}

function createProxyTestErrorState(copy: ReturnType<typeof text>, error: unknown): ProxyTestState {
  const message = getErrorMessage(error);

  return {
    status: 'error',
    message: copy.testFailed.replace('{error}', message),
    detail: message,
  };
}

function buildProfileFromDraft(draft: ProxyDraft): ShellDeskProxyProfile {
  const now = new Date().toISOString();

  return {
    id: draft.id || createId(),
    label: draft.label.trim(),
    config: buildConfigFromDraft(draft),
    createdAt: draft.createdAt || now,
    updatedAt: now,
  };
}

function ProxyProfilesPage({ hosts, proxyProfiles, onProxyProfilesChange }: ProxyProfilesPageProps) {
  const language = useCurrentAppLanguage();
  const copy = text(language);
  const [searchQuery, setSearchQuery] = useState('');
  const [draft, setDraft] = useState<ProxyDraft | null>(null);
  const [formError, setFormError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ShellDeskProxyProfile | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [proxyTestResults, setProxyTestResults] = useState<Record<string, ProxyTestState>>({});
  const [draftTestState, setDraftTestState] = useState<ProxyTestState | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const draftTestRunIdRef = useRef(0);

  const usageByProfileId = useMemo(() => {
    const usage = new Map<string, number>();

    for (const profile of proxyProfiles) {
      usage.set(profile.id, hosts.filter((host) => host.proxyProfileId === profile.id).length);
    }

    return usage;
  }, [hosts, proxyProfiles]);

  const proxyTestHostByProfileId = useMemo(() => {
    const testHosts = new Map<string, ShellDeskStoredHostRecord>();

    for (const host of hosts) {
      const proxyProfileId = host.proxyProfileId?.trim();

      if (proxyProfileId && !testHosts.has(proxyProfileId)) {
        testHosts.set(proxyProfileId, host);
      }
    }

    return testHosts;
  }, [hosts]);

  const filteredProfiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return proxyProfiles.filter((profile) => {
      const matchesQuery = !query || [
        profile.label,
        profile.config.type,
        profile.config.host,
        profile.config.command,
        profile.config.username,
      ].join(' ').toLowerCase().includes(query);

      return matchesQuery;
    }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [proxyProfiles, searchQuery]);

  const setTemporarySaveStatus = (status: SaveStatus) => {
    setSaveStatus(status);

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    if (status === 'saved') {
      saveTimerRef.current = window.setTimeout(() => {
        setSaveStatus('idle');
        saveTimerRef.current = null;
      }, 1800);
    }
  };

  const getProxyTestTarget = (profileId: string): ShellDeskProxyTestTarget | undefined => {
    const testHost = proxyTestHostByProfileId.get(profileId);

    if (!testHost) {
      return undefined;
    }

    return {
      kind: 'ssh',
      host: testHost.address,
      port: testHost.port,
      timeoutMs: 15000,
    };
  };

  const clearDraftTestState = () => {
    draftTestRunIdRef.current += 1;
    setDraftTestState(null);
  };

  const updateDraft = (nextDraft: ProxyDraft) => {
    setDraft(nextDraft);
    clearDraftTestState();
  };

  const openCreate = () => {
    setDraft({ ...emptyDraft });
    setFormError('');
    clearDraftTestState();
  };

  const openEdit = (profile: ShellDeskProxyProfile) => {
    setDraft(profileToDraft(profile));
    setFormError('');
    clearDraftTestState();
  };

  const duplicateProfile = (profile: ShellDeskProxyProfile) => {
    const now = new Date().toISOString();
    onProxyProfilesChange([
      {
        ...profile,
        id: createId(),
        label: `${profile.label} ${copy.copySuffix}`,
        config: { ...profile.config },
        createdAt: now,
        updatedAt: now,
      },
      ...proxyProfiles,
    ]);
    setTemporarySaveStatus('saved');
  };

  const testProxy = async (profile: ShellDeskProxyProfile) => {
    const runTest = window.guiSSH?.system?.testProxy;

    setProxyTestResults((current) => ({
      ...current,
      [profile.id]: {
        status: 'testing',
        message: copy.testing,
        detail: '',
      },
    }));

    if (!runTest) {
      setProxyTestResults((current) => ({
        ...current,
        [profile.id]: {
          status: 'error',
          message: copy.testUnavailable,
          detail: copy.testUnavailable,
        },
      }));
      return;
    }

    try {
      const result = await runTest({ config: profile.config, target: getProxyTestTarget(profile.id) });
      setProxyTestResults((current) => ({
        ...current,
        [profile.id]: createProxyTestState(copy, result),
      }));
    } catch (error) {
      setProxyTestResults((current) => ({
        ...current,
        [profile.id]: createProxyTestErrorState(copy, error),
      }));
    }
  };

  const testDraftProxy = async () => {
    if (!draft) {
      return;
    }

    const validationError = validateProxyDraft(draft, copy, { requireLabel: false });

    if (validationError) {
      setFormError(validationError);
      clearDraftTestState();
      return;
    }

    const runTest = window.guiSSH?.system?.testProxy;
    const runId = draftTestRunIdRef.current + 1;
    draftTestRunIdRef.current = runId;
    setFormError('');
    setDraftTestState({
      status: 'testing',
      message: copy.testing,
      detail: '',
    });

    if (!runTest) {
      if (draftTestRunIdRef.current === runId) {
        setDraftTestState({
          status: 'error',
          message: copy.testUnavailable,
          detail: copy.testUnavailable,
        });
      }
      return;
    }

    try {
      const config = buildConfigFromDraft(draft);
      const result = await runTest({ config, target: draft.id ? getProxyTestTarget(draft.id) : undefined });
      const nextTestState = createProxyTestState(copy, result);

      if (draftTestRunIdRef.current !== runId) {
        return;
      }

      setDraftTestState(nextTestState);

      if (draft.id) {
        setProxyTestResults((current) => ({
          ...current,
          [draft.id]: nextTestState,
        }));
      }
    } catch (error) {
      if (draftTestRunIdRef.current !== runId) {
        return;
      }

      setDraftTestState(createProxyTestErrorState(copy, error));
    }
  };

  const saveDraft = (event: FormEvent) => {
    event.preventDefault();

    if (!draft) {
      return;
    }

    const validationError = validateProxyDraft(draft, copy, { requireLabel: true });

    if (validationError) {
      setFormError(validationError);
      return;
    }

    setTemporarySaveStatus('saving');

    try {
      const profile = buildProfileFromDraft(draft);
      const exists = proxyProfiles.some((item) => item.id === profile.id);
      onProxyProfilesChange(exists
        ? proxyProfiles.map((item) => (item.id === profile.id ? profile : item))
        : [profile, ...proxyProfiles]);
      setDraft(null);
      setFormError('');
      clearDraftTestState();
      setTemporarySaveStatus('saved');
    } catch {
      setTemporarySaveStatus('error');
    }
  };

  const confirmDelete = () => {
    if (!deleteTarget) {
      return;
    }

    const now = new Date().toISOString();
    const nextHosts = hosts.map((host) => (
      host.proxyProfileId === deleteTarget.id
        ? { ...host, proxyProfileId: '', updatedAt: now }
        : host
    ));

    onProxyProfilesChange(
      proxyProfiles.filter((profile) => profile.id !== deleteTarget.id),
      nextHosts,
    );
    setDeleteTarget(null);
    if (draft?.id === deleteTarget.id) {
      setDraft(null);
      clearDraftTestState();
    }
    setTemporarySaveStatus('saved');
  };

  const saveStatusText = saveStatus === 'saving'
    ? copy.saving
    : saveStatus === 'saved'
      ? copy.saved
      : saveStatus === 'error'
        ? copy.saveFailed
        : '';
  const emptyTitle = proxyProfiles.length ? copy.emptyMatches : copy.emptyTitle;
  const emptyDesc = proxyProfiles.length ? copy.emptyMatchesDesc : copy.emptyDesc;
  const editorTitle = draft?.id ? copy.editTitle : copy.createTitle;

  return (
    <>
      <div className="command-bar no-drag network-assets-command-bar">
        <label className="global-search network-assets-search">
          <span>{copy.search}</span>
          <input
            type="search"
            placeholder={copy.searchPlaceholder}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </label>

        {saveStatusText ? (
          <span className={`network-save-state ${saveStatus}`} role={saveStatus === 'error' ? 'alert' : 'status'}>
            {saveStatusText}
          </span>
        ) : null}

        <button type="button" className="primary-action" onClick={openCreate}>
          {copy.newProxy}
        </button>
      </div>

      <section className="vault-content hosts-content network-assets-content">
        <section className="vault-section host-section hosts-list-panel network-list-panel">
          <div className="section-heading host-list-heading">
            <div className="host-list-title">
              <h2>{copy.proxyList} <b>{filteredProfiles.length}</b></h2>
            </div>
            <span className="host-list-controls">
              {formatCount(copy.count, filteredProfiles.length)}
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
            {filteredProfiles.length ? (
              <div className="host-grid grid network-card-grid">
                {filteredProfiles.map((profile) => {
                  const usageCount = usageByProfileId.get(profile.id) ?? 0;
                  const testState = proxyTestResults[profile.id];

                  return (
                    <article key={profile.id} className={`host-card network-card ${draft?.id === profile.id ? 'active' : ''}`}>
                      <button type="button" className="host-card-main network-card-main" onClick={() => openEdit(profile)}>
                        <span className={`host-avatar network-avatar ${profile.config.type}`} aria-hidden="true">
                          {profile.config.type === 'command' ? '$' : '↔'}
                        </span>
                        <span className="host-summary network-summary">
                          <strong>{profile.label}</strong>
                          <small>{getEndpoint(profile.config)}</small>
                          <span className="host-card-tags network-card-tags">
                            <em>{typeLabels[profile.config.type]}</em>
                            <em>{formatCount(copy.usage, usageCount)}</em>
                            {profile.config.username ? <em>{copy.username}</em> : null}
                            {testState ? (
                              <em className={`network-test-badge ${testState.status}`} title={testState.detail || testState.message}>
                                {testState.message}
                              </em>
                            ) : null}
                          </span>
                        </span>
                      </button>
                      <span className="host-card-actions network-card-actions">
                        <details className="host-card-menu" onClick={(event) => event.stopPropagation()}>
                          <summary aria-label={copy.actions}>⋯</summary>
                          <div className="host-card-menu-panel">
                            <button
                              type="button"
                              disabled={testState?.status === 'testing'}
                              onClick={(event) => {
                                closeDetailsMenu(event.currentTarget);
                                void testProxy(profile);
                              }}
                            >
                              {testState?.status === 'testing' ? copy.testing : copy.test}
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                closeDetailsMenu(event.currentTarget);
                                openEdit(profile);
                              }}
                            >
                              {copy.edit}
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                closeDetailsMenu(event.currentTarget);
                                duplicateProfile(profile);
                              }}
                            >
                              {copy.duplicate}
                            </button>
                            <button
                              type="button"
                              className="danger-text"
                              onClick={(event) => {
                                closeDetailsMenu(event.currentTarget);
                                setDeleteTarget(profile);
                              }}
                            >
                              {copy.delete}
                            </button>
                          </div>
                        </details>
                      </span>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state network-empty">
                <span>PROXY</span>
                <h3>{emptyTitle}</h3>
                <p>{emptyDesc}</p>
              </div>
            )}
          </div>
        </section>
      </section>

      {draft ? (
        <aside className="editor-panel network-editor-popover no-drag" aria-label={editorTitle}>
          <div className="editor-header">
            <span>
              <strong>{editorTitle}</strong>
              <small>{draft.label || copy.editorHint}</small>
            </span>
            <div className="editor-header-actions">
              <button
                type="button"
                className="editor-header-test"
                disabled={draftTestState?.status === 'testing'}
                onClick={() => {
                  void testDraftProxy();
                }}
              >
                {draftTestState?.status === 'testing' ? copy.testing : copy.test}
              </button>
              <button type="submit" className="editor-header-submit" form="proxy-editor-form">
                {copy.save}
              </button>
              <button
                type="button"
                className="editor-header-clear"
                onClick={() => {
                  setDraft(null);
                  setFormError('');
                  clearDraftTestState();
                }}
              >
                {copy.cancel}
              </button>
            </div>
          </div>

          <form id="proxy-editor-form" className="host-form network-editor-form" onSubmit={saveDraft}>
            <label className="field">
              <span>{copy.name}</span>
              <input
                value={draft.label}
                maxLength={80}
                onChange={(event) => updateDraft({ ...draft, label: event.target.value })}
                placeholder={copy.namePlaceholder}
              />
            </label>

            <label className="field">
              <span>{copy.type}</span>
              <select
                value={draft.type}
                onChange={(event) => {
                  const type = event.target.value as ShellDeskProxyType;
                  updateDraft({
                    ...draft,
                    type,
                    port: type === 'http' ? '8080' : type === 'socks5' ? '1080' : '',
                  });
                }}
              >
                {proxyTypes.map((type) => (
                  <option key={type} value={type}>{typeLabels[type]}</option>
                ))}
              </select>
            </label>

            {draft.type === 'command' ? (
              <label className="field">
                <span>{copy.command}</span>
                <input
                  value={draft.command}
                  onChange={(event) => updateDraft({ ...draft, command: event.target.value })}
                  placeholder="nc -X connect -x proxy.example.com:8080 {host} {port}"
                />
                <small className="field-note">{copy.commandHint}</small>
              </label>
            ) : (
              <>
                <div className="editor-grid">
                  <label className="field">
                    <span>{copy.host}</span>
                    <input
                      value={draft.host}
                      maxLength={255}
                      onChange={(event) => updateDraft({ ...draft, host: event.target.value })}
                      placeholder="proxy.example.com"
                    />
                  </label>

                  <label className="field">
                    <span>{copy.port}</span>
                    <input
                      value={draft.port}
                      inputMode="numeric"
                      onChange={(event) => updateDraft({ ...draft, port: event.target.value })}
                      placeholder={draft.type === 'socks5' ? '1080' : '8080'}
                    />
                  </label>
                </div>

                <label className="field">
                  <span>{copy.username} · {copy.optional}</span>
                  <input
                    value={draft.username}
                    maxLength={128}
                    onChange={(event) => updateDraft({ ...draft, username: event.target.value })}
                    placeholder="proxy-user"
                  />
                </label>

                <label className="field">
                  <span>{copy.password} · {copy.optional}</span>
                  <input
                    type="password"
                    value={draft.password}
                    onChange={(event) => updateDraft({ ...draft, password: event.target.value })}
                    placeholder="••••••••"
                  />
                </label>
              </>
            )}

            {draftTestState ? (
              <div className={`network-test-message ${draftTestState.status}`} role="status" title={draftTestState.detail || draftTestState.message}>
                {draftTestState.message}
              </div>
            ) : null}
            {formError ? <div className="snippet-form-error">{formError}</div> : null}
          </form>
        </aside>
      ) : null}

      {deleteTarget ? (
        <div className="notepad-modal-overlay no-drag" role="presentation" onClick={() => setDeleteTarget(null)}>
          <div className="notepad-modal" role="alertdialog" aria-modal="true" aria-labelledby="proxy-delete-title" onClick={(event) => event.stopPropagation()}>
            <div id="proxy-delete-title" className="notepad-modal-title">{copy.deleteTitle}</div>
            <div className="notepad-modal-message">
              {copy.deleteMessage
                .replace('{name}', deleteTarget.label)
                .replace('{count}', String(usageByProfileId.get(deleteTarget.id) ?? 0))}
            </div>
            <div className="notepad-modal-actions">
              <button type="button" onClick={() => setDeleteTarget(null)}>{copy.cancel}</button>
              <button type="button" className="danger" onClick={confirmDelete}>{copy.delete}</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default ProxyProfilesPage;
