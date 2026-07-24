import type { RefObject } from 'react';
import { createPortal } from 'react-dom';

import { t, type AppLanguage } from '../../i18n';
import { getDeleteEntriesLabel } from './fileExplorerUtils';
import type {
  ExplorerSudoPrompt,
  ExplorerUploadConflictDialog,
  RemoteFileEntry,
} from './fileExplorerTypes';

interface FileExplorerDialogsProps {
  deleteConfirmationEntries: RemoteFileEntry[] | null;
  language: AppLanguage;
  sudoPasswordInputRef: RefObject<HTMLInputElement | null>;
  sudoPrompt: ExplorerSudoPrompt | null;
  uploadConflictDialog: ExplorerUploadConflictDialog | null;
  onCloseDeleteConfirmation: () => void;
  onCloseUploadConflict: () => void;
  onConfirmDelete: () => void;
  onResolveSudoPrompt: (password: string | null) => void;
  onResolveUploadConflicts: (strategy: 'skip' | 'replace' | 'duplicate') => void;
  onUpdateSudoPassword: (password: string) => void;
}

function FileExplorerDialogs({
  deleteConfirmationEntries,
  language,
  sudoPasswordInputRef,
  sudoPrompt,
  uploadConflictDialog,
  onCloseDeleteConfirmation,
  onCloseUploadConflict,
  onConfirmDelete,
  onResolveSudoPrompt,
  onResolveUploadConflicts,
  onUpdateSudoPassword,
}: FileExplorerDialogsProps) {
  return (
    <>
      {uploadConflictDialog ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={onCloseUploadConflict}>
          <div
            className="notepad-modal explorer-conflict-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="explorer-upload-conflict-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="explorer-upload-conflict-title" className="notepad-modal-title">
              {language === 'zh-CN' ? '上传冲突' : 'Upload conflicts'}
            </div>
            <div className="notepad-modal-message">
              {language === 'zh-CN'
                ? `有 ${uploadConflictDialog.conflicts.length} 个目标已存在，请选择处理方式。`
                : `${uploadConflictDialog.conflicts.length} target item(s) already exist. Choose how to continue.`}
            </div>
            <div className="explorer-conflict-list">
              {uploadConflictDialog.conflicts.slice(0, 8).map((conflict) => (
                <div key={conflict.item.path} className="explorer-conflict-row">
                  <strong>{conflict.item.name}</strong>
                  <span title={conflict.remotePath}>{conflict.remotePath}</span>
                </div>
              ))}
              {uploadConflictDialog.conflicts.length > 8 ? (
                <div className="explorer-conflict-more">
                  {language === 'zh-CN'
                    ? `另有 ${uploadConflictDialog.conflicts.length - 8} 项未显示`
                    : `${uploadConflictDialog.conflicts.length - 8} more item(s) hidden`}
                </div>
              ) : null}
            </div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={onCloseUploadConflict}>
                {t('common.cancel', language)}
              </button>
              <button type="button" className="notepad-modal-btn" onClick={() => onResolveUploadConflicts('skip')}>
                {language === 'zh-CN' ? '跳过冲突' : 'Skip'}
              </button>
              <button type="button" className="notepad-modal-btn" onClick={() => onResolveUploadConflicts('duplicate')}>
                {language === 'zh-CN' ? '重命名上传' : 'Rename'}
              </button>
              <button type="button" className="notepad-modal-btn primary" onClick={() => onResolveUploadConflicts('replace')}>
                {language === 'zh-CN' ? '覆盖' : 'Replace'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {deleteConfirmationEntries ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={onCloseDeleteConfirmation}>
          <div
            className="notepad-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="explorer-delete-confirm-title"
            data-testid="explorer-delete-confirm-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div id="explorer-delete-confirm-title" className="notepad-modal-title">
              {t('fileExplorer.delete.title', language)}
            </div>
            <div className="notepad-modal-message">
              {t('fileExplorer.delete.message', language, {
                target: getDeleteEntriesLabel(deleteConfirmationEntries, language),
              })}
            </div>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={onCloseDeleteConfirmation}>
                {t('common.cancel', language)}
              </button>
              <button type="button" className="notepad-modal-btn danger" onClick={onConfirmDelete}>
                {t('fileExplorer.context.delete', language)}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {sudoPrompt ? createPortal(
        <div className="notepad-modal-overlay" role="presentation" onClick={() => onResolveSudoPrompt(null)}>
          <form
            className="notepad-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="explorer-sudo-title"
            data-testid="explorer-sudo-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              onResolveSudoPrompt(sudoPrompt.password);
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div id="explorer-sudo-title" className="notepad-modal-title">
              {t('fileExplorer.sudo.title', language)}
            </div>
            <div className="notepad-modal-message">
              {t('fileExplorer.sudo.message', language, {
                operation: sudoPrompt.operation,
                target: sudoPrompt.target,
              })}
            </div>
            {sudoPrompt.error ? <div className="notepad-modal-message">{sudoPrompt.error}</div> : null}
            <label className="notepad-modal-field">
              <span>{t('fileExplorer.sudo.password', language)}</span>
              <input
                ref={sudoPasswordInputRef}
                className="notepad-modal-input"
                data-testid="explorer-sudo-password"
                type="password"
                value={sudoPrompt.password}
                autoComplete="current-password"
                onChange={(event) => onUpdateSudoPassword(event.target.value)}
              />
            </label>
            <div className="notepad-modal-actions">
              <button type="button" className="notepad-modal-btn" onClick={() => onResolveSudoPrompt(null)}>
                {t('common.cancel', language)}
              </button>
              <button type="submit" className="notepad-modal-btn primary">
                {t('fileExplorer.sudo.continue', language)}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export default FileExplorerDialogs;
