import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';

import { t, type AppLanguage, type MessageId } from '../../i18n';
import { formatDateTime } from './desktopUtils';
import { formatBytes } from './fileExplorerUtils';
import { getFileTypeLabel, isDirectoryEntry } from './fileExplorerIcons';
import type { RemoteFileEntry, RemotePathStat } from './fileExplorerTypes';

type PermissionGroupKey = 'owner' | 'group' | 'others';
type PermissionActionKey = 'read' | 'write' | 'execute';

const PERMISSION_GROUPS: Array<{
  key: PermissionGroupKey;
  labelId: MessageId;
  bits: Record<PermissionActionKey, number>;
}> = [
  { key: 'owner', labelId: 'fileExplorer.permission.owner', bits: { read: 0o400, write: 0o200, execute: 0o100 } },
  { key: 'group', labelId: 'fileExplorer.permission.group', bits: { read: 0o040, write: 0o020, execute: 0o010 } },
  { key: 'others', labelId: 'fileExplorer.permission.others', bits: { read: 0o004, write: 0o002, execute: 0o001 } },
];

const PERMISSION_ACTIONS: Array<{ key: PermissionActionKey; labelId: MessageId }> = [
  { key: 'read', labelId: 'fileExplorer.permission.read' },
  { key: 'write', labelId: 'fileExplorer.permission.write' },
  { key: 'execute', labelId: 'fileExplorer.permission.execute' },
];

export function formatMode(mode: number) {
  const permissionMode = mode & 0o777;
  const perms = [
    (permissionMode & 0o400) ? 'r' : '-',
    (permissionMode & 0o200) ? 'w' : '-',
    (permissionMode & 0o100) ? 'x' : '-',
    (permissionMode & 0o040) ? 'r' : '-',
    (permissionMode & 0o020) ? 'w' : '-',
    (permissionMode & 0o010) ? 'x' : '-',
    (permissionMode & 0o004) ? 'r' : '-',
    (permissionMode & 0o002) ? 'w' : '-',
    (permissionMode & 0o001) ? 'x' : '-',
  ];
  return perms.join('');
}

export function formatOctalMode(mode: number) {
  return (mode & 0o777).toString(8).padStart(3, '0');
}

export function parseOctalModeDraft(draft: string) {
  return /^[0-7]{3}$/.test(draft) ? Number.parseInt(draft, 8) : null;
}

interface FilePermissionDialogProps {
  entry: RemoteFileEntry;
  data: RemotePathStat | null;
  draft: string;
  recursive: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
  language: AppLanguage;
  canSave: boolean;
  onClose: () => void;
  onDraftChange: (draft: string) => void;
  onRecursiveChange: (recursive: boolean) => void;
  onPermissionBitChange: (bit: number, enabled: boolean) => void;
  onExecutableChange: (enabled: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function FilePermissionDialog({
  entry,
  data,
  draft,
  recursive,
  loading,
  saving,
  error,
  language,
  canSave,
  onClose,
  onDraftChange,
  onRecursiveChange,
  onPermissionBitChange,
  onExecutableChange,
  onSubmit,
}: FilePermissionDialogProps) {
  const draftMode = parseOctalModeDraft(draft);
  const executableChecked = draftMode !== null
    ? (draftMode & 0o111) !== 0
    : Boolean(data && (data.mode & 0o111));

  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onClose}>
      <form
        className="properties-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="explorer-properties-title"
        data-testid="explorer-properties-dialog"
        onSubmit={onSubmit}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="properties-header">
          <strong id="explorer-properties-title">{entry.name}</strong>
          <button type="button" onClick={onClose} disabled={saving}>&times;</button>
        </div>
        <div className="properties-body">
          {loading ? (
            <div className="properties-loading">{t('fileExplorer.properties.loading', language)}</div>
          ) : (
            <>
              <table className="properties-table">
                <tbody>
                  <tr><td>{t('fileExplorer.properties.name', language)}</td><td>{entry.name}</td></tr>
                  <tr><td>{t('fileExplorer.table.type', language)}</td><td>{getFileTypeLabel(entry, language)}</td></tr>
                  <tr><td>{t('fileExplorer.table.size', language)}</td><td>{isDirectoryEntry(entry) ? '-' : formatBytes(entry.size)}</td></tr>
                  <tr><td>{t('fileExplorer.details.modifiedAt', language)}</td><td>{formatDateTime(entry.modifiedAt)}</td></tr>
                  {data ? (
                    <>
                      <tr><td>{t('fileExplorer.details.permissions', language)}</td><td><code>{formatMode(data.mode)} ({formatOctalMode(data.mode)})</code></td></tr>
                      <tr><td>{t('fileExplorer.details.owner', language)}</td><td>UID {data.owner} / GID {data.group}</td></tr>
                      <tr><td>{t('fileExplorer.details.accessedAt', language)}</td><td>{formatDateTime(data.accessedAt)}</td></tr>
                    </>
                  ) : null}
                </tbody>
              </table>

              {data ? (
                <div className="properties-permission-editor">
                  <div className="properties-section-title">{t('fileExplorer.details.permissions', language)}</div>
                  <label className="permission-mode-field">
                    <span>{t('fileExplorer.properties.octal', language)}</span>
                    <input
                      data-testid="explorer-permission-mode"
                      value={draft}
                      maxLength={3}
                      inputMode="numeric"
                      pattern="[0-7]{3}"
                      onChange={(event) => onDraftChange(event.target.value.replace(/[^0-7]/g, '').slice(0, 3))}
                      disabled={saving}
                      spellCheck={false}
                    />
                    <code>{draftMode !== null ? formatMode(draftMode) : '---------'}</code>
                  </label>
                  <div className="permission-grid" role="group" aria-label={t('fileExplorer.properties.bitsAria', language)}>
                    <span />
                    {PERMISSION_ACTIONS.map((action) => (
                      <span key={action.key}>{t(action.labelId, language)}</span>
                    ))}
                    {PERMISSION_GROUPS.map((group) => (
                      <div className="permission-grid-row" key={group.key}>
                        <strong>{t(group.labelId, language)}</strong>
                        {PERMISSION_ACTIONS.map((action) => {
                          const bit = group.bits[action.key];
                          const checked = draftMode !== null ? Boolean(draftMode & bit) : Boolean(data.mode & bit);

                          return (
                            <label key={action.key} className="permission-checkbox" aria-label={`${t(group.labelId, language)} ${t(action.labelId, language)}`} title={`${t(group.labelId, language)} ${t(action.labelId, language)}`}>
                              <input type="checkbox" checked={checked} onChange={(event) => onPermissionBitChange(bit, event.target.checked)} disabled={saving} />
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <label className="properties-toggle-row">
                    <input type="checkbox" checked={executableChecked} onChange={(event) => onExecutableChange(event.target.checked)} disabled={saving} />
                    <span>{t('fileExplorer.properties.executable', language)}</span>
                  </label>
                  {entry.type === 'directory' ? (
                    <label className="properties-toggle-row">
                      <input type="checkbox" checked={recursive} onChange={(event) => onRecursiveChange(event.target.checked)} disabled={saving} />
                      <span>{t('fileExplorer.properties.recursive', language)}</span>
                    </label>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
        {error ? <div className="properties-error" role="alert" data-testid="explorer-properties-error">{error}</div> : null}
        <div className="properties-footer">
          <button type="button" className="properties-close-btn" onClick={onClose} disabled={saving}>{t('common.cancel', language)}</button>
          <button type="submit" className="properties-save-btn" data-testid="explorer-permission-save" disabled={!canSave}>
            {saving ? t('fileExplorer.properties.saving', language) : t('fileExplorer.properties.savePermissions', language)}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export default FilePermissionDialog;
