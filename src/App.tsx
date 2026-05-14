import { type FormEvent, useEffect, useMemo, useState } from 'react';

import RemoteDesktop, { type RemoteConnectionInfo } from './RemoteDesktop';

const hostsStorageKey = 'gui-ssh:hosts';
const keysStorageKey = 'gui-ssh:keys';
const ungroupedKey = '__ungrouped__';

const navigationItems = [
  { page: 'hosts', key: 'H', label: '主机' },
  { page: 'keys', key: 'K', label: '密钥' },
  { page: 'logs', key: 'L', label: '日志' },
] as const;

type AppPage = (typeof navigationItems)[number]['page'];

interface SshKey {
  id: string;
  name: string;
  keyPath: string;
  passphrase: string;
  createdAt: string;
  updatedAt: string;
}

interface KeyFormState {
  name: string;
  keyPath: string;
  passphrase: string;
}

const emptyKeyForm: KeyFormState = {
  name: '',
  keyPath: '',
  passphrase: '',
};

const keyPathSeparators = /[\\/]+/;

function getKeyNameFromPath(keyPath: string) {
  const fileName = keyPath.split(keyPathSeparators).filter(Boolean).pop() ?? 'SSH Key';
  return fileName.replace(/\.(pem|key|ppk|openssh)$/i, '') || fileName;
}

function isStoredSshKey(value: unknown): value is SshKey {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const key = value as Partial<SshKey>;
  return (
    typeof key.id === 'string' &&
    typeof key.name === 'string' &&
    typeof key.keyPath === 'string' &&
    typeof key.passphrase === 'string' &&
    typeof key.createdAt === 'string' &&
    typeof key.updatedAt === 'string'
  );
}

function readStoredSshKeys(): SshKey[] {
  try {
    const rawKeys = window.localStorage.getItem(keysStorageKey);

    if (!rawKeys) {
      return [];
    }

    const parsedKeys: unknown = JSON.parse(rawKeys);

    if (!Array.isArray(parsedKeys)) {
      return [];
    }

    return parsedKeys.filter(isStoredSshKey);
  } catch {
    return [];
  }
}

function validateKeyForm(form: KeyFormState, keys: SshKey[], editingKeyId: string | null) {
  const name = form.name.trim();
  const keyPath = form.keyPath.trim();

  if (!name) {
    return '请输入密钥名称。';
  }

  if (!keyPath) {
    return '请选择私钥文件。';
  }

  if (name.length > 80 || keyPath.length > 1024 || form.passphrase.length > 4096) {
    return '密钥信息长度超出限制。';
  }

  if (keys.some((key) => key.id !== editingKeyId && key.keyPath === keyPath)) {
    return '该私钥文件已在密钥列表中。';
  }

  return '';
}

function createSshKeyFromForm(form: KeyFormState): SshKey {
  const now = new Date().toISOString();

  return {
    id: createId(),
    name: form.name.trim(),
    keyPath: form.keyPath.trim(),
    passphrase: form.passphrase,
    createdAt: now,
    updatedAt: now,
  };
}

function updateSshKeyFromForm(key: SshKey, form: KeyFormState): SshKey {
  return {
    ...key,
    name: form.name.trim(),
    keyPath: form.keyPath.trim(),
    passphrase: form.passphrase,
    updatedAt: new Date().toISOString(),
  };
}

function toKeyFormState(key: SshKey): KeyFormState {
  return {
    name: key.name,
    keyPath: key.keyPath,
    passphrase: key.passphrase,
  };
}

interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password: string;
  keyId: string;
  keyPath: string;
  passphrase: string;
  group: string;
  tags: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

type StoredHost = Omit<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase'> &
  Partial<Pick<Host, 'authMethod' | 'password' | 'keyId' | 'keyPath' | 'passphrase'>>;

interface HostFormState {
  name: string;
  address: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  password: string;
  keyId: string;
  keyPath: string;
  passphrase: string;
  group: string;
  tags: string;
  note: string;
}

interface HostGroup {
  key: string;
  name: string;
  count: number;
}

type ViewMode = 'grid' | 'list';
type AuthMethod = 'password' | 'key';

interface ConnectionClosedPayload {
  connectionId: string;
  reason?: string;
}

interface CredentialFormState {
  password: string;
  passphrase: string;
  saveCredential: boolean;
}

const emptyHostForm: HostFormState = {
  name: '',
  address: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  keyId: '',
  keyPath: '',
  passphrase: '',
  group: '',
  tags: '',
  note: '',
};

const emptyCredentialForm: CredentialFormState = {
  password: '',
  passphrase: '',
  saveCredential: true,
};

function createId() {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return '操作失败。';
}

function isAuthFailureMessage(message: string) {
  return /认证失败|authentication methods failed|password|private key|passphrase|密钥|口令/i.test(message);
}

function parseTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function formatTags(tags: string[]) {
  return tags.join(', ');
}

function getAuthMethod(value: unknown): AuthMethod {
  return value === 'key' ? 'key' : 'password';
}

function getAuthLabel(host: Pick<Host, 'authMethod' | 'password' | 'keyPath' | 'passphrase'>) {
  if (host.authMethod === 'key') {
    if (!host.keyPath) {
      return '密钥登录';
    }

    return host.passphrase ? `密钥 · ${host.keyPath} · 口令已保存` : `密钥 · ${host.keyPath}`;
  }

  return host.password ? '密码登录 · 已保存' : '密码登录';
}

function isStoredHost(value: unknown): value is StoredHost {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const host = value as Partial<StoredHost>;
  return (
    typeof host.id === 'string' &&
    typeof host.name === 'string' &&
    typeof host.address === 'string' &&
    typeof host.port === 'number' &&
    Number.isInteger(host.port) &&
    typeof host.username === 'string' &&
    typeof host.group === 'string' &&
    Array.isArray(host.tags) &&
    host.tags.every((tag) => typeof tag === 'string') &&
    typeof host.note === 'string' &&
    typeof host.createdAt === 'string' &&
    typeof host.updatedAt === 'string'
  );
}

function normalizeStoredHost(host: StoredHost): Host {
  return {
    ...host,
    authMethod: getAuthMethod(host.authMethod),
    password: typeof host.password === 'string' ? host.password : '',
    keyId: typeof host.keyId === 'string' ? host.keyId : '',
    keyPath: typeof host.keyPath === 'string' ? host.keyPath : '',
    passphrase: typeof host.passphrase === 'string' ? host.passphrase : '',
  };
}

function readStoredHosts(): Host[] {
  try {
    const rawHosts = window.localStorage.getItem(hostsStorageKey);

    if (!rawHosts) {
      return [];
    }

    const parsedHosts: unknown = JSON.parse(rawHosts);

    if (!Array.isArray(parsedHosts)) {
      return [];
    }

    return parsedHosts.filter(isStoredHost).map(normalizeStoredHost);
  } catch {
    return [];
  }
}

function validateHostForm(form: HostFormState, keys: SshKey[]) {
  const port = Number(form.port);
  const selectedKey = keys.find((key) => key.id === form.keyId);

  if (!form.name.trim()) {
    return '请输入主机名称。';
  }

  if (!form.address.trim()) {
    return '请输入主机地址。';
  }

  if (!form.username.trim()) {
    return '请输入用户名。';
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '端口必须是 1 到 65535 之间的整数。';
  }

  if (form.name.trim().length > 80) {
    return '主机名称不能超过 80 个字符。';
  }

  if (form.address.trim().length > 255) {
    return '主机地址不能超过 255 个字符。';
  }

  if (form.username.trim().length > 128) {
    return '用户名不能超过 128 个字符。';
  }

  if (form.authMethod === 'key' && !selectedKey) {
    return '选择密钥登录时需要选择已有密钥。';
  }

  if (form.password.length > 4096) {
    return '密码长度不能超过 4096 个字符。';
  }

  if (form.keyPath.length > 1024) {
    return '密钥路径不能超过 1024 个字符。';
  }

  if (form.passphrase.length > 4096) {
    return '密钥口令长度不能超过 4096 个字符。';
  }

  return '';
}

function createHostFromForm(form: HostFormState, selectedKey: SshKey | null): Host {
  const now = new Date().toISOString();

  return {
    id: createId(),
    name: form.name.trim(),
    address: form.address.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.authMethod === 'password' ? form.password : '',
    keyId: form.authMethod === 'key' ? selectedKey?.id ?? '' : '',
    keyPath: form.authMethod === 'key' ? selectedKey?.keyPath ?? '' : '',
    passphrase: form.authMethod === 'key' ? selectedKey?.passphrase ?? '' : '',
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    createdAt: now,
    updatedAt: now,
  };
}

function updateHostFromForm(host: Host, form: HostFormState, selectedKey: SshKey | null): Host {
  return {
    ...host,
    name: form.name.trim(),
    address: form.address.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authMethod: form.authMethod,
    password: form.authMethod === 'password' ? form.password : '',
    keyId: form.authMethod === 'key' ? selectedKey?.id ?? '' : '',
    keyPath: form.authMethod === 'key' ? selectedKey?.keyPath ?? '' : '',
    passphrase: form.authMethod === 'key' ? selectedKey?.passphrase ?? '' : '',
    group: form.group.trim(),
    tags: parseTags(form.tags),
    note: form.note.trim(),
    updatedAt: new Date().toISOString(),
  };
}

function toFormState(host: Host): HostFormState {
  return {
    name: host.name,
    address: host.address,
    port: String(host.port),
    username: host.username,
    authMethod: host.authMethod,
    password: host.password,
    keyId: host.keyId,
    keyPath: host.keyPath,
    passphrase: host.passphrase,
    group: host.group,
    tags: formatTags(host.tags),
    note: host.note,
  };
}

function getHostGroupKey(host: Host) {
  return host.group || ungroupedKey;
}

function App() {
  const [hosts, setHosts] = useState<Host[]>(readStoredHosts);
  const [sshKeys, setSshKeys] = useState<SshKey[]>(readStoredSshKeys);
  const [form, setForm] = useState<HostFormState>(emptyHostForm);
  const [keyForm, setKeyForm] = useState<KeyFormState>(emptyKeyForm);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<AppPage>('hosts');
  const [searchQuery, setSearchQuery] = useState('');
  const [keySearchQuery, setKeySearchQuery] = useState('');
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [keyFormError, setKeyFormError] = useState('');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isKeyEditorOpen, setIsKeyEditorOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [statusMessage, setStatusMessage] = useState('');
  const [connection, setConnection] = useState<RemoteConnectionInfo | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [credentialHostId, setCredentialHostId] = useState<string | null>(null);
  const [credentialForm, setCredentialForm] = useState<CredentialFormState>(emptyCredentialForm);
  const [credentialError, setCredentialError] = useState('');
  const platform = window.guiSSH?.platform;
  const windowControls = window.guiSSH?.window;
  const showWindowControls = Boolean(windowControls) && platform !== 'darwin';
  const editingHost = hosts.find((host) => host.id === editingHostId) ?? null;
  const editingKey = sshKeys.find((key) => key.id === editingKeyId) ?? null;
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0] ?? null;
  const credentialHost = hosts.find((host) => host.id === credentialHostId) ?? null;

  const hostGroups = useMemo<HostGroup[]>(() => {
    const groups = new Map<string, HostGroup>();

    for (const host of hosts) {
      const key = getHostGroupKey(host);
      const name = host.group || '未分组';
      const currentGroup = groups.get(key);

      groups.set(key, {
        key,
        name,
        count: (currentGroup?.count ?? 0) + 1,
      });
    }

    return Array.from(groups.values()).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [hosts]);

  const filteredHosts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return hosts.filter((host) => {
      const hostKey = sshKeys.find((key) => key.id === host.keyId);
      const matchesGroup = !activeGroupKey || getHostGroupKey(host) === activeGroupKey;
      const matchesQuery =
        !query ||
        [host.name, host.address, host.username, host.group, host.note, hostKey?.name, hostKey?.keyPath, host.keyPath, getAuthLabel(host), ...host.tags]
          .join(' ')
          .toLowerCase()
          .includes(query);

      return matchesGroup && matchesQuery;
    });
  }, [activeGroupKey, hosts, searchQuery, sshKeys]);

  const filteredKeys = useMemo(() => {
    const query = keySearchQuery.trim().toLowerCase();

    return sshKeys.filter((key) => {
      if (!query) {
        return true;
      }

      return [key.name, key.keyPath].join(' ').toLowerCase().includes(query);
    });
  }, [keySearchQuery, sshKeys]);

  const activeGroupName = hostGroups.find((group) => group.key === activeGroupKey)?.name;

  const getSelectedSshKey = (host: Host) => sshKeys.find((key) => key.id === host.keyId) ?? null;

  useEffect(() => {
    window.localStorage.setItem(hostsStorageKey, JSON.stringify(hosts));
  }, [hosts]);

  useEffect(() => {
    window.localStorage.setItem(keysStorageKey, JSON.stringify(sshKeys));
  }, [sshKeys]);

  useEffect(() => {
    if (selectedHostId && hosts.some((host) => host.id === selectedHostId)) {
      return;
    }

    setSelectedHostId(hosts[0]?.id ?? null);
  }, [hosts, selectedHostId]);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }

    const timer = window.setTimeout(() => setStatusMessage(''), 1000);
    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    if (!connection || !window.guiSSH?.events) {
      return;
    }

    return window.guiSSH.events.onConnectionClosed((payload: ConnectionClosedPayload) => {
      if (payload.connectionId === connection.id) {
        setConnection(null);
        setStatusMessage(payload.reason || 'SSH 连接已断开。');
      }
    });
  }, [connection]);

  const minimizeWindow = () => {
    void windowControls?.minimize();
  };

  const toggleMaximizeWindow = () => {
    void windowControls?.toggleMaximize();
  };

  const closeWindow = () => {
    void windowControls?.close();
  };

  const resetForm = () => {
    setForm(emptyHostForm);
    setEditingHostId(null);
    setFormError('');
  };

  const resetKeyForm = () => {
    setKeyForm(emptyKeyForm);
    setEditingKeyId(null);
    setKeyFormError('');
  };

  const openCreateHost = () => {
    resetForm();
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    resetForm();
    setIsEditorOpen(false);
  };

  const openCreateKey = () => {
    resetKeyForm();
    setIsKeyEditorOpen(true);
    setActivePage('keys');
  };

  const closeKeyEditor = () => {
    resetKeyForm();
    setIsKeyEditorOpen(false);
  };

  const updateFormField = <Field extends keyof HostFormState>(field: Field, value: HostFormState[Field]) => {
    setForm((currentForm) => ({ ...currentForm, [field]: value }));
    setFormError('');
  };

  const updateKeyFormField = <Field extends keyof KeyFormState>(field: Field, value: KeyFormState[Field]) => {
    setKeyForm((currentForm) => ({ ...currentForm, [field]: value }));
    setKeyFormError('');
  };

  const selectKeyFileForKeyForm = async () => {
    const filePath = await window.guiSSH?.files.selectPrivateKeyFile();

    if (!filePath) {
      return;
    }

    setKeyForm((currentForm) => ({
      ...currentForm,
      keyPath: filePath,
      name: currentForm.name.trim() ? currentForm.name : getKeyNameFromPath(filePath),
    }));
    setKeyFormError('');
  };

  const importPrivateKey = async () => {
    const filePath = await window.guiSSH?.files.selectPrivateKeyFile();

    if (!filePath) {
      return;
    }

    if (sshKeys.some((key) => key.keyPath === filePath)) {
      setStatusMessage('该私钥文件已在密钥列表中。');
      return;
    }

    const nextKey = createSshKeyFromForm({
      name: getKeyNameFromPath(filePath),
      keyPath: filePath,
      passphrase: '',
    });

    setSshKeys((currentKeys) => [nextKey, ...currentKeys]);
    setStatusMessage(`已导入密钥：${nextKey.name}`);
  };

  const submitKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const validationError = validateKeyForm(keyForm, sshKeys, editingKeyId);

    if (validationError) {
      setKeyFormError(validationError);
      return;
    }

    if (editingKey) {
      const updatedKey = updateSshKeyFromForm(editingKey, keyForm);
      setSshKeys((currentKeys) => currentKeys.map((key) => (key.id === editingKey.id ? updatedKey : key)));
      setHosts((currentHosts) => currentHosts.map((host) => (
        host.keyId === editingKey.id
          ? { ...host, keyPath: updatedKey.keyPath, passphrase: updatedKey.passphrase, updatedAt: new Date().toISOString() }
          : host
      )));
      setStatusMessage(`已更新密钥：${updatedKey.name}`);
    } else {
      const nextKey = createSshKeyFromForm(keyForm);
      setSshKeys((currentKeys) => [nextKey, ...currentKeys]);
      setStatusMessage(`已新增密钥：${nextKey.name}`);
    }

    closeKeyEditor();
  };

  const startEditingKey = (key: SshKey) => {
    setEditingKeyId(key.id);
    setKeyForm(toKeyFormState(key));
    setKeyFormError('');
    setIsKeyEditorOpen(true);
  };

  const deleteSshKey = (key: SshKey) => {
    const relatedHosts = hosts.filter((host) => host.keyId === key.id);
    const message = relatedHosts.length
      ? `确认删除密钥「${key.name}」？${relatedHosts.length} 台主机正在使用该密钥，删除后会切换为密码登录。`
      : `确认删除密钥「${key.name}」？`;

    if (!window.confirm(message)) {
      return;
    }

    setSshKeys((currentKeys) => currentKeys.filter((currentKey) => currentKey.id !== key.id));

    if (relatedHosts.length) {
      setHosts((currentHosts) => currentHosts.map((host) => (
        host.keyId === key.id
          ? {
              ...host,
              authMethod: 'password',
              keyId: '',
              keyPath: '',
              passphrase: '',
              updatedAt: new Date().toISOString(),
            }
          : host
      )));
    }

    if (editingKeyId === key.id) {
      closeKeyEditor();
    }

    setStatusMessage(`已删除密钥：${key.name}`);
  };

  const updateCredentialField = <Field extends keyof CredentialFormState>(
    field: Field,
    value: CredentialFormState[Field],
  ) => {
    setCredentialForm((currentForm) => ({ ...currentForm, [field]: value }));
    setCredentialError('');
  };

  const openCredentialDialog = (host: Host, message = '') => {
    const selectedKey = host.authMethod === 'key' ? getSelectedSshKey(host) : null;

    setCredentialHostId(host.id);
    setCredentialForm({
      password: host.password,
      passphrase: selectedKey?.passphrase ?? host.passphrase,
      saveCredential: true,
    });
    setCredentialError(message);
  };

  const closeCredentialDialog = () => {
    setCredentialHostId(null);
    setCredentialForm(emptyCredentialForm);
    setCredentialError('');
  };

  const submitHost = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const selectedKey = sshKeys.find((key) => key.id === form.keyId) ?? null;
    const validationError = validateHostForm(form, sshKeys);

    if (validationError) {
      setFormError(validationError);
      return;
    }

    if (editingHost) {
      const updatedHost = updateHostFromForm(editingHost, form, selectedKey);
      setHosts((currentHosts) => currentHosts.map((host) => (host.id === editingHost.id ? updatedHost : host)));
      setSelectedHostId(updatedHost.id);
      setStatusMessage(`已更新主机：${updatedHost.name}`);
    } else {
      const nextHost = createHostFromForm(form, selectedKey);
      setHosts((currentHosts) => [nextHost, ...currentHosts]);
      setSelectedHostId(nextHost.id);
      setStatusMessage(`已添加主机：${nextHost.name}`);
    }

    closeEditor();
  };

  const startEditingHost = (host: Host) => {
    const matchedKey = host.keyId ? null : sshKeys.find((key) => key.keyPath === host.keyPath);

    setEditingHostId(host.id);
    setSelectedHostId(host.id);
    setForm({ ...toFormState(host), keyId: host.keyId || matchedKey?.id || '' });
    setFormError('');
    setIsEditorOpen(true);
  };

  const deleteHost = (host: Host) => {
    if (!window.confirm(`确认删除主机「${host.name}」？`)) {
      return;
    }

    const nextHosts = hosts.filter((currentHost) => currentHost.id !== host.id);
    setHosts(nextHosts);
    setStatusMessage(`已删除主机：${host.name}`);

    if (selectedHostId === host.id) {
      setSelectedHostId(nextHosts[0]?.id ?? null);
    }

    if (editingHostId === host.id) {
      closeEditor();
    }
  };

  const connectHost = async (host: Host, credentials?: CredentialFormState) => {
    if (!window.guiSSH?.connections) {
      setStatusMessage('当前运行环境不支持 SSH 连接。');
      return false;
    }

    const selectedKey = host.authMethod === 'key' ? getSelectedSshKey(host) : null;

    if (host.authMethod === 'key' && !selectedKey && !host.keyPath) {
      setStatusMessage('该主机未选择有效密钥。');
      return false;
    }

    const hostForConnection: Host = credentials
      ? {
          ...host,
          password: host.authMethod === 'password' ? credentials.password : host.password,
          keyPath: host.authMethod === 'key' ? selectedKey?.keyPath ?? host.keyPath : '',
          passphrase: host.authMethod === 'key' ? credentials.passphrase : host.passphrase,
        }
      : {
          ...host,
          keyPath: host.authMethod === 'key' ? selectedKey?.keyPath ?? host.keyPath : '',
          passphrase: host.authMethod === 'key' ? selectedKey?.passphrase ?? host.passphrase : '',
        };

    setIsConnecting(true);
    setStatusMessage(`正在连接 ${host.name}...`);

    try {
      const nextConnection = await window.guiSSH.connections.connect(hostForConnection);

      if (credentials?.saveCredential) {
        setHosts((currentHosts) =>
          currentHosts.map((currentHost) =>
            currentHost.id === host.id
              ? {
                  ...currentHost,
                  password: host.authMethod === 'password' ? credentials.password : currentHost.password,
                  updatedAt: new Date().toISOString(),
                }
              : currentHost,
          ),
        );

        if (host.authMethod === 'key' && selectedKey) {
          setSshKeys((currentKeys) => currentKeys.map((key) => (
            key.id === selectedKey.id
              ? { ...key, passphrase: credentials.passphrase, updatedAt: new Date().toISOString() }
              : key
          )));
        }
      }

      setConnection({ ...nextConnection, host: nextConnection.host ?? hostForConnection });
      setStatusMessage(`已连接：${host.name}`);
      closeCredentialDialog();
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      setStatusMessage(`连接失败：${message}`);

      if (isAuthFailureMessage(message)) {
        openCredentialDialog(hostForConnection, message);
      }

      return false;
    } finally {
      setIsConnecting(false);
    }
  };

  const connectSelectedHost = async () => {
    if (!selectedHost) {
      setStatusMessage('请先选择一台主机。');
      return;
    }

    if (selectedHost.authMethod === 'password' && !selectedHost.password) {
      openCredentialDialog(selectedHost, '请输入该主机的 SSH 密码后连接。');
      return;
    }

    if (selectedHost.authMethod === 'key' && !getSelectedSshKey(selectedHost) && !selectedHost.keyPath) {
      setStatusMessage('该主机未选择有效密钥，请先编辑主机。');
      return;
    }

    await connectHost(selectedHost);
  };

  const submitCredentialConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!credentialHost) {
      return;
    }

    if (credentialHost.authMethod === 'password' && !credentialForm.password) {
      setCredentialError('请输入 SSH 密码。');
      return;
    }

    await connectHost(credentialHost, credentialForm);
  };

  const disconnectCurrentHost = async () => {
    if (!connection) {
      return;
    }

    const closedConnection = connection;
    setConnection(null);
    setStatusMessage(`正在断开 ${closedConnection.host.name}...`);

    try {
      await window.guiSSH?.connections.disconnect(closedConnection.id);
      setStatusMessage(`已断开：${closedConnection.host.name}`);
    } catch (error) {
      setStatusMessage(`断开连接失败：${getErrorMessage(error)}`);
    }
  };

  const clearFilters = () => {
    setActiveGroupKey(null);
    setSearchQuery('');
  };

  return (
    <div className="app-shell">
      <header className="top-chrome drag-region">
        <div className="workspace-title">GUI-SSH</div>

        {showWindowControls ? (
          <div className="titlebar-controls no-drag">
            <button type="button" aria-label="最小化" onClick={minimizeWindow}>−</button>
            <button type="button" aria-label="最大化" onClick={toggleMaximizeWindow}>□</button>
            <button type="button" aria-label="关闭" className="danger" onClick={closeWindow}>×</button>
          </div>
        ) : null}
      </header>

      {statusMessage ? <div className="status-toast no-drag" role="status">{statusMessage}</div> : null}

      {connection ? (
        <RemoteDesktop connection={connection} onDisconnect={disconnectCurrentHost} />
      ) : (
      <div className="app-layout">
        <aside className="side-nav">
          <div className="brand-panel">
            <span className="brand-logo">GS</span>
            <strong>GUI-SSH</strong>
          </div>

          <nav className="feature-nav" aria-label="功能导航">
            {navigationItems.map((item) => (
              <button
                key={item.label}
                type="button"
                className={`feature-nav-item ${activePage === item.page ? 'active' : ''}`}
                onClick={() => setActivePage(item.page)}
              >
                <span>{item.key}</span>
                {item.label}
              </button>
            ))}
          </nav>

          <button type="button" className="settings-entry">设置</button>
        </aside>

        <main className="vault-page">
          {activePage === 'hosts' ? (
            <>
          <div className="command-bar no-drag">
            <label className="global-search">
              <span>查找</span>
              <input
                type="search"
                placeholder="查找主机或 ssh user@hostname / ssh -p 2222 user@host"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>

            <button type="button" className="command-button" onClick={connectSelectedHost} disabled={isConnecting}>
              {isConnecting ? '连接中...' : '连接'}
            </button>

            <div className="view-switch" aria-label="视图切换">
              <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>网格</button>
              <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>列表</button>
            </div>

            <button type="button" className="primary-action" onClick={openCreateHost}>+ 新建主机</button>
          </div>

          <section className="vault-content">
            <div className="content-filter-row">
              <button type="button" className={`filter-tab ${!activeGroupKey && !searchQuery ? 'active' : ''}`} onClick={clearFilters}>
                全部主机
              </button>
              <span>{activeGroupName ? `当前分组：${activeGroupName}` : `${hosts.length} 台主机`}</span>
            </div>
            <section className="vault-section">
              <div className="section-heading">
                <h2>分组</h2>
                <span>共 {hostGroups.length} 个</span>
              </div>

              {hostGroups.length ? (
                <div className="group-grid">
                  {hostGroups.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      className={`group-card ${activeGroupKey === group.key ? 'active' : ''}`}
                      onClick={() => setActiveGroupKey(group.key)}
                    >
                      <span className="group-icon">G</span>
                      <span>
                        <strong>{group.name}</strong>
                        <small>{group.count} 台主机</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-inline">添加主机后会自动生成分组。</div>
              )}
            </section>

            <section className="vault-section host-section">
              <div className="section-heading">
                <h2>主机</h2>
                <span>{filteredHosts.length} 条 <b>0 个在线</b></span>
              </div>

              {filteredHosts.length ? (
                <div className={`host-grid ${viewMode}`}>
                  {filteredHosts.map((host) => (
                    <article
                      key={host.id}
                      className={`host-card ${selectedHost?.id === host.id ? 'selected' : ''}`}
                      onDoubleClick={() => {
                        setSelectedHostId(host.id);

                        if (host.authMethod === 'password' && !host.password) {
                          openCredentialDialog(host, '请输入该主机的 SSH 密码后连接。');
                          return;
                        }

                        void connectHost(host);
                      }}
                    >
                      <button type="button" className="host-card-main" onClick={() => setSelectedHostId(host.id)}>
                        <span className="host-avatar">S</span>
                        <span className="host-summary">
                          <strong>{host.name}</strong>
                          <small>{host.username ? `${host.username}@` : ''}{host.address}:{host.port}</small>
                          <span>{host.group || '未分组'} · {host.tags.length ? host.tags.join(' / ') : '无标签'}</span>
                        </span>
                        {(host.authMethod === 'password' && host.password) || host.authMethod === 'key' ? (
                          <span className="credential-icon" title={host.authMethod === 'key' ? '密钥登录' : '密码已保存'}>🔑</span>
                        ) : null}
                      </button>
                      <details className="host-card-menu" onClick={(event) => event.stopPropagation()}>
                        <summary aria-label="主机操作">⋯</summary>
                        <div className="host-card-menu-panel">
                          <button type="button" onClick={() => startEditingHost(host)}>编辑</button>
                          <button type="button" className="danger-text" onClick={() => deleteHost(host)}>删除</button>
                        </div>
                      </details>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <span>EMPTY</span>
                  <h3>{hosts.length ? '没有匹配的主机' : '主机列表为空'}</h3>
                  <p>{hosts.length ? '清空搜索或切换分组后再试。' : '点击“新建主机”添加第一台 SSH 主机。'}</p>
                </div>
              )}
            </section>

          </section>
            </>
          ) : activePage === 'keys' ? (
            <>
              <div className="command-bar no-drag key-command-bar">
                <label className="global-search">
                  <span>查找</span>
                  <input
                    type="search"
                    placeholder="查找密钥名称或私钥路径"
                    value={keySearchQuery}
                    onChange={(event) => setKeySearchQuery(event.target.value)}
                  />
                </label>

                <button type="button" className="command-button" onClick={importPrivateKey}>导入密钥</button>
                <button type="button" className="primary-action" onClick={openCreateKey}>+ 新建密钥</button>
              </div>

              <section className="vault-content">
                <div className="content-filter-row">
                  <button type="button" className={`filter-tab ${!keySearchQuery ? 'active' : ''}`} onClick={() => setKeySearchQuery('')}>
                    密钥列表
                  </button>
                  <span>{filteredKeys.length} 个密钥</span>
                </div>
                {filteredKeys.length ? (
                  <div className="key-grid">
                    {filteredKeys.map((key) => (
                      <article key={key.id} className="key-card">
                        <span className="key-card-icon">🔑</span>
                        <span className="key-card-summary">
                          <strong>{key.name}</strong>
                          <small>{key.keyPath}</small>
                          <em>{key.passphrase ? '口令已保存' : '无口令'}</em>
                        </span>
                        <div className="key-card-actions">
                          <button type="button" onClick={() => startEditingKey(key)}>编辑</button>
                          <button type="button" className="danger-text" onClick={() => deleteSshKey(key)}>删除</button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <span>KEYS</span>
                    <h3>{sshKeys.length ? '没有匹配的密钥' : '密钥列表为空'}</h3>
                    <p>{sshKeys.length ? '清空搜索后再试。' : '点击“新建密钥”或“导入密钥”添加第一把 SSH 私钥。'}</p>
                  </div>
                )}
              </section>
            </>
          ) : (
            <>
              <div className="command-bar no-drag simple-command-bar">
                <strong>日志</strong>
              </div>
              <section className="vault-content">
                <div className="empty-state">
                  <span>LOGS</span>
                  <h3>暂无日志</h3>
                  <p>连接、密钥和操作日志后续会显示在这里。</p>
                </div>
              </section>
            </>
          )}

          {isEditorOpen && activePage === 'hosts' ? (
            <aside className="editor-panel no-drag" aria-label={editingHost ? '编辑主机' : '新建主机'}>
              <div className="editor-header">
                <span>
                  <strong>{editingHost ? '编辑主机' : '新建主机'}</strong>
                  <small>{editingHost ? editingHost.name : '保存到本地 Vault'}</small>
                </span>
                <button type="button" onClick={closeEditor} aria-label="关闭表单">×</button>
              </div>

              <form className="host-form" onSubmit={submitHost}>
                <label className="field">
                  <span>主机名称</span>
                  <input
                    value={form.name}
                    maxLength={80}
                    onChange={(event) => updateFormField('name', event.target.value)}
                    placeholder="例如：Production Web"
                  />
                </label>

                <label className="field">
                  <span>地址</span>
                  <input
                    value={form.address}
                    maxLength={255}
                    onChange={(event) => updateFormField('address', event.target.value)}
                    placeholder="192.168.100.21 或 github.com"
                  />
                </label>

                <div className="editor-grid">
                  <label className="field">
                    <span>用户名</span>
                    <input
                      value={form.username}
                      onChange={(event) => updateFormField('username', event.target.value)}
                      placeholder="root"
                    />
                  </label>

                  <label className="field">
                    <span>端口</span>
                    <input
                      value={form.port}
                      inputMode="numeric"
                      onChange={(event) => updateFormField('port', event.target.value)}
                      placeholder="22"
                    />
                  </label>
                </div>

                <div className="auth-method-section">
                  <span className="field-label">登录方式</span>
                  <div className="auth-switch" role="group" aria-label="登录方式">
                    <button
                      type="button"
                      className={form.authMethod === 'password' ? 'active' : ''}
                      onClick={() => {
                        updateFormField('authMethod', 'password');
                        updateFormField('keyId', '');
                        updateFormField('keyPath', '');
                        updateFormField('passphrase', '');
                      }}
                    >
                      <strong>密码登录</strong>
                      <small>保存密码到主机信息</small>
                    </button>
                    <button
                      type="button"
                      className={form.authMethod === 'key' ? 'active' : ''}
                      onClick={() => {
                        updateFormField('authMethod', 'key');
                        updateFormField('password', '');
                      }}
                    >
                      <strong>密钥登录</strong>
                      <small>选择密钥库中的已有密钥</small>
                    </button>
                  </div>
                </div>

                {form.authMethod === 'key' ? (
                  <label className="field">
                    <span>选择密钥</span>
                    <select
                      value={form.keyId}
                      onChange={(event) => updateFormField('keyId', event.target.value)}
                    >
                      <option value="">请选择已有密钥</option>
                      {sshKeys.map((key) => (
                        <option key={key.id} value={key.id}>{key.name} · {key.keyPath}</option>
                      ))}
                    </select>
                    {!sshKeys.length ? <small className="field-note">请先到“密钥”页面新建或导入密钥。</small> : null}
                  </label>
                ) : (
                  <label className="field">
                    <span>密码</span>
                    <input
                      type="password"
                      value={form.password}
                      onChange={(event) => updateFormField('password', event.target.value)}
                      placeholder="输入并保存该主机密码"
                    />
                  </label>
                )}

                <label className="field">
                  <span>分组</span>
                  <input
                    value={form.group}
                    onChange={(event) => updateFormField('group', event.target.value)}
                    placeholder="AWS / Production / Lab"
                  />
                </label>

                <label className="field">
                  <span>标签</span>
                  <input
                    value={form.tags}
                    onChange={(event) => updateFormField('tags', event.target.value)}
                    placeholder="linux, prod, db"
                  />
                </label>

                <label className="field">
                  <span>备注</span>
                  <textarea
                    value={form.note}
                    onChange={(event) => updateFormField('note', event.target.value)}
                    placeholder="用途、跳板机、维护窗口等"
                    rows={4}
                  />
                </label>

                {formError ? <div className="error-banner">{formError}</div> : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action">{editingHost ? '保存修改' : '添加主机'}</button>
                  <button type="button" className="command-button" onClick={resetForm}>清空</button>
                </div>
              </form>
            </aside>
          ) : null}

          {isKeyEditorOpen && activePage === 'keys' ? (
            <aside className="editor-panel no-drag" aria-label={editingKey ? '编辑密钥' : '新建密钥'}>
              <div className="editor-header">
                <span>
                  <strong>{editingKey ? '编辑密钥' : '新建密钥'}</strong>
                  <small>{editingKey ? editingKey.name : '保存 SSH 私钥引用'}</small>
                </span>
                <button type="button" onClick={closeKeyEditor} aria-label="关闭密钥表单">×</button>
              </div>

              <form className="host-form" onSubmit={submitKey}>
                <label className="field">
                  <span>密钥名称</span>
                  <input
                    value={keyForm.name}
                    maxLength={80}
                    onChange={(event) => updateKeyFormField('name', event.target.value)}
                    placeholder="例如：Production Key"
                  />
                </label>

                <label className="field">
                  <span>私钥文件</span>
                  <div className="file-picker-row">
                    <input value={keyForm.keyPath} readOnly placeholder="请选择 SSH 私钥文件" />
                    <button type="button" className="command-button" onClick={selectKeyFileForKeyForm}>
                      选择文件
                    </button>
                  </div>
                </label>

                <label className="field">
                  <span>密钥口令（可选）</span>
                  <input
                    type="password"
                    value={keyForm.passphrase}
                    onChange={(event) => updateKeyFormField('passphrase', event.target.value)}
                    placeholder="私钥加密时填写"
                  />
                </label>

                {keyFormError ? <div className="error-banner">{keyFormError}</div> : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action">{editingKey ? '保存修改' : '保存密钥'}</button>
                  <button type="button" className="command-button" onClick={resetKeyForm}>清空</button>
                </div>
              </form>
            </aside>
          ) : null}

          {credentialHost ? (
            <aside className="credential-panel no-drag" aria-label="连接凭据">
              <div className="editor-header">
                <span>
                  <strong>连接凭据</strong>
                  <small>{credentialHost.username}@{credentialHost.address}:{credentialHost.port}</small>
                </span>
                <button type="button" onClick={closeCredentialDialog} aria-label="关闭连接凭据">×</button>
              </div>

              <form className="host-form" onSubmit={submitCredentialConnection}>
                {credentialHost.authMethod === 'password' ? (
                  <label className="field">
                    <span>SSH 密码</span>
                    <input
                      type="password"
                      value={credentialForm.password}
                      onChange={(event) => updateCredentialField('password', event.target.value)}
                      placeholder="输入该主机的 SSH 密码"
                      autoFocus
                    />
                  </label>
                ) : (
                  <>
                    <div className="credential-note">
                      当前使用密钥登录：{getSelectedSshKey(credentialHost)?.name ?? credentialHost.keyPath}
                    </div>
                    <label className="field">
                      <span>密钥口令（私钥加密时填写）</span>
                      <input
                        type="password"
                        value={credentialForm.passphrase}
                        onChange={(event) => updateCredentialField('passphrase', event.target.value)}
                        placeholder="没有口令可留空"
                        autoFocus
                      />
                    </label>
                  </>
                )}

                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={credentialForm.saveCredential}
                    onChange={(event) => updateCredentialField('saveCredential', event.target.checked)}
                  />
                  <span>连接成功后保存到此主机配置</span>
                </label>

                {credentialError ? <div className="error-banner">{credentialError}</div> : null}

                <div className="form-actions">
                  <button type="submit" className="primary-action" disabled={isConnecting}>
                    {isConnecting ? '连接中...' : '连接'}
                  </button>
                  <button type="button" className="command-button" onClick={closeCredentialDialog}>取消</button>
                </div>
              </form>
            </aside>
          ) : null}
        </main>
      </div>
      )}
    </div>
  );
}

export default App;
