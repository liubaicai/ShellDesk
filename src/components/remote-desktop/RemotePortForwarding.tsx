import { useCallback, useEffect, useMemo, useState } from 'react';
import { tCurrent } from '../../i18n';
import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage } from './desktopUtils';

interface RemotePortForwardingProps {
  connectionId: string;
}

type EditablePortForward = ShellDeskPortForwardProfile & { id?: string };

function emptyProfile(hostId: string): EditablePortForward {
  return {
    hostId,
    name: '',
    kind: 'local',
    bindHost: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: 0,
    autostart: false,
    reconnect: true,
    allowNonLoopback: false,
  };
}

function statusLabel(status: ShellDeskPortForwardStatus) {
  return tCurrent(`portForward.status.${status}`);
}

function kindLabel(kind: ShellDeskPortForwardKind) {
  return tCurrent(`portForward.kind.${kind}`);
}

function endpointLabel(host: string, port: number) {
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${normalizedHost || '127.0.0.1'}:${port || tCurrent('portForward.portAutomatic')}`;
}

function RemotePortForwarding({ connectionId }: RemotePortForwardingProps) {
  const [hostId, setHostId] = useState('');
  const [records, setRecords] = useState<ShellDeskPortForwardRecord[]>([]);
  const [editor, setEditor] = useState<EditablePortForward | null>(null);
  const [busyId, setBusyId] = useState('');
  const [deletePendingId, setDeletePendingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (silent = false) => {
    const api = window.guiSSH?.connections;
    if (!api) {
      setError(tCurrent('portForward.ipcUnavailable'));
      setLoading(false);
      return;
    }
    if (!silent) {
      setLoading(true);
    }
    try {
      const [connection, nextRecords] = await Promise.all([
        api.getInfo(connectionId),
        api.listPortForwards(connectionId),
      ]);
      const nextHostId = connection.host.id ?? '';
      setHostId(nextHostId);
      setRecords(nextRecords);
      setError('');
    } catch (loadError) {
      if (!silent) {
        setError(getErrorMessage(loadError));
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 2_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const activeCount = useMemo(
    () => records.filter(({ runtime }) => runtime.status !== 'stopped' && runtime.status !== 'error').length,
    [records],
  );

  const openCreate = () => {
    if (!hostId) {
      setError(tCurrent('portForward.hostIdMissing'));
      return;
    }
    setEditor(emptyProfile(hostId));
    setDeletePendingId('');
  };

  const save = async () => {
    const api = window.guiSSH?.connections;
    if (!api || !editor) {
      return;
    }
    const busyKey = editor.id ?? 'new';
    setBusyId(busyKey);
    setError('');
    try {
      await api.savePortForward({
        ...editor,
        hostId,
        name: editor.name.trim(),
        bindHost: editor.bindHost.trim(),
        targetHost: editor.kind === 'dynamic' ? '' : editor.targetHost.trim(),
        targetPort: editor.kind === 'dynamic' ? 0 : editor.targetPort,
      });
      setEditor(null);
      setNotice(tCurrent('portForward.saved'));
      await load(true);
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setBusyId('');
    }
  };

  const toggleRuntime = async (record: ShellDeskPortForwardRecord) => {
    const api = window.guiSSH?.connections;
    if (!api) {
      return;
    }
    setBusyId(record.profile.id);
    setError('');
    try {
      if (record.runtime.status === 'stopped' || record.runtime.status === 'error') {
        await api.startPortForward(connectionId, record.profile.id);
        setNotice(tCurrent('portForward.startRequested'));
      } else {
        await api.stopPortForward(record.profile.id);
        setNotice(tCurrent('portForward.stopped'));
      }
      await load(true);
    } catch (runtimeError) {
      setError(getErrorMessage(runtimeError));
    } finally {
      setBusyId('');
    }
  };

  const remove = async (profileId: string) => {
    const api = window.guiSSH?.connections;
    if (!api) {
      return;
    }
    if (deletePendingId !== profileId) {
      setDeletePendingId(profileId);
      return;
    }
    setBusyId(profileId);
    try {
      await api.deletePortForward(profileId);
      setDeletePendingId('');
      setNotice(tCurrent('portForward.deleted'));
      await load(true);
    } catch (deleteError) {
      setError(getErrorMessage(deleteError));
    } finally {
      setBusyId('');
    }
  };

  return (
    <section className="port-forwarding" aria-label={tCurrent('portForward.title')}>
      <header className="port-forwarding-toolbar">
        <div>
          <strong>{tCurrent('portForward.title')}</strong>
          <span>{tCurrent('portForward.summary', { value0: records.length, value1: activeCount })}</span>
        </div>
        <button type="button" className="port-tool-button primary" onClick={openCreate} disabled={!hostId}>
          {tCurrent('portForward.create')}
        </button>
      </header>

      {error ? (
        <DismissibleAlert className="port-alert danger" onDismiss={() => setError('')} role="alert">
          {error}
        </DismissibleAlert>
      ) : null}
      {notice ? (
        <DismissibleAlert className="port-alert info" onDismiss={() => setNotice('')}>
          {notice}
        </DismissibleAlert>
      ) : null}

      {editor ? (
        <form className="port-forward-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="port-forward-editor-heading">
            <strong>{editor.id ? tCurrent('portForward.edit') : tCurrent('portForward.create')}</strong>
            <span>{tCurrent('portForward.securityHint')}</span>
          </div>
          <label>
            <span>{tCurrent('portForward.name')}</span>
            <input
              required
              maxLength={80}
              value={editor.name}
              onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              placeholder={tCurrent('portForward.namePlaceholder')}
            />
          </label>
          <label>
            <span>{tCurrent('portForward.kindLabel')}</span>
            <select
              value={editor.kind}
              onChange={(event) => setEditor({ ...editor, kind: event.target.value as ShellDeskPortForwardKind })}
            >
              <option value="local">{kindLabel('local')}</option>
              <option value="remote">{kindLabel('remote')}</option>
              <option value="dynamic">{kindLabel('dynamic')}</option>
            </select>
          </label>
          <label>
            <span>{tCurrent('portForward.bindHost')}</span>
            <input required value={editor.bindHost} onChange={(event) => setEditor({ ...editor, bindHost: event.target.value })} />
          </label>
          <label>
            <span>{tCurrent('portForward.bindPort')}</span>
            <input
              type="number"
              min={0}
              max={65535}
              value={editor.bindPort}
              onChange={(event) => setEditor({ ...editor, bindPort: Number(event.target.value) })}
            />
          </label>
          {editor.kind !== 'dynamic' ? (
            <>
              <label>
                <span>{tCurrent('portForward.targetHost')}</span>
                <input required value={editor.targetHost} onChange={(event) => setEditor({ ...editor, targetHost: event.target.value })} />
              </label>
              <label>
                <span>{tCurrent('portForward.targetPort')}</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  value={editor.targetPort || ''}
                  onChange={(event) => setEditor({ ...editor, targetPort: Number(event.target.value) })}
                />
              </label>
            </>
          ) : null}
          <label className="port-forward-check">
            <input type="checkbox" checked={editor.autostart} onChange={(event) => setEditor({ ...editor, autostart: event.target.checked })} />
            <span>{tCurrent('portForward.autostart')}</span>
          </label>
          <label className="port-forward-check">
            <input type="checkbox" checked={editor.reconnect} onChange={(event) => setEditor({ ...editor, reconnect: event.target.checked })} />
            <span>{tCurrent('portForward.reconnect')}</span>
          </label>
          <label className="port-forward-check warning">
            <input
              type="checkbox"
              checked={editor.allowNonLoopback}
              onChange={(event) => setEditor({ ...editor, allowNonLoopback: event.target.checked })}
            />
            <span>{tCurrent('portForward.allowNonLoopback')}</span>
          </label>
          <div className="port-forward-editor-actions">
            <button type="button" onClick={() => setEditor(null)}>{tCurrent('portForward.cancel')}</button>
            <button type="submit" className="primary" disabled={busyId === (editor.id ?? 'new')}>
              {busyId === (editor.id ?? 'new') ? tCurrent('portForward.saving') : tCurrent('portForward.save')}
            </button>
          </div>
        </form>
      ) : null}

      <div className="port-forward-list">
        {records.map((record) => {
          const isActive = record.runtime.status !== 'stopped' && record.runtime.status !== 'error';
          const effectiveEndpoint = record.runtime.bindPort
            ? endpointLabel(record.runtime.bindHost || record.profile.bindHost, record.runtime.bindPort)
            : endpointLabel(record.profile.bindHost, record.profile.bindPort);
          return (
            <article key={record.profile.id} className={`port-forward-card status-${record.runtime.status}`}>
              <div className="port-forward-card-main">
                <span className={`port-forward-status status-${record.runtime.status}`}>{statusLabel(record.runtime.status)}</span>
                <div>
                  <strong>{record.profile.name}</strong>
                  <span>
                    {kindLabel(record.profile.kind)} · {effectiveEndpoint}
                    {record.profile.kind !== 'dynamic'
                      ? ` → ${endpointLabel(record.profile.targetHost, record.profile.targetPort)}`
                      : ''}
                  </span>
                </div>
              </div>
              <div className="port-forward-card-flags">
                {record.profile.autostart ? <span>{tCurrent('portForward.autostartShort')}</span> : null}
                {record.profile.reconnect ? <span>{tCurrent('portForward.reconnectShort')}</span> : null}
                {record.runtime.retryAttempt ? <span>{tCurrent('portForward.retry', { value0: record.runtime.retryAttempt })}</span> : null}
              </div>
              {record.runtime.error ? <p className="port-forward-error">{record.runtime.error}</p> : null}
              <div className="port-forward-card-actions">
                <button type="button" disabled={busyId === record.profile.id} onClick={() => void toggleRuntime(record)}>
                  {isActive ? tCurrent('portForward.stop') : tCurrent('portForward.start')}
                </button>
                <button type="button" onClick={() => { setEditor({ ...record.profile }); setDeletePendingId(''); }}>
                  {tCurrent('portForward.edit')}
                </button>
                <button
                  type="button"
                  className={deletePendingId === record.profile.id ? 'danger' : ''}
                  disabled={busyId === record.profile.id}
                  onClick={() => void remove(record.profile.id)}
                >
                  {deletePendingId === record.profile.id ? tCurrent('portForward.confirmDelete') : tCurrent('portForward.delete')}
                </button>
                {deletePendingId === record.profile.id ? (
                  <button type="button" onClick={() => setDeletePendingId('')}>{tCurrent('portForward.cancel')}</button>
                ) : null}
              </div>
            </article>
          );
        })}
        {!loading && records.length === 0 ? (
          <div className="port-forward-empty">
            <strong>{tCurrent('portForward.empty')}</strong>
            <span>{tCurrent('portForward.emptyHint')}</span>
          </div>
        ) : null}
        {loading ? <div className="port-forward-empty">{tCurrent('portForward.loading')}</div> : null}
      </div>
    </section>
  );
}

export default RemotePortForwarding;
