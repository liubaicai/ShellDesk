import { type ChangeEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import type { DatabaseImportState } from './databaseImportUtils';

export interface DatabaseImportTargetOption {
  label: string;
  value: string;
}

interface DatabaseImportDialogLabels {
  cancel: string;
  closeAlert: string;
  csvTab: string;
  execute: string;
  executing: string;
  fromSqlEditor: string;
  jsonTab: string;
  noData: string;
  noTable: string;
  pasteCsv: string;
  pasteJson: string;
  preview: string;
  progress: string;
  selectFile: string;
  targetTable: string;
  title: string;
}

interface DatabaseImportDialogProps {
  dialogId: string;
  editorTargetValue: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  labels: DatabaseImportDialogLabels;
  onClearError: () => void;
  onClose: () => void;
  onExecute: () => void;
  onFileSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  onModeChange: (mode: DatabaseImportState['mode']) => void;
  onTargetChange: (value: string) => void;
  onTextChange: (mode: DatabaseImportState['mode'], value: string) => void;
  state: DatabaseImportState;
  targetOptions: DatabaseImportTargetOption[];
}

export default function DatabaseImportDialog({
  dialogId,
  editorTargetValue,
  fileInputRef,
  labels,
  onClearError,
  onClose,
  onExecute,
  onFileSelected,
  onModeChange,
  onTargetChange,
  onTextChange,
  state,
  targetOptions,
}: DatabaseImportDialogProps) {
  if (!state.open) return null;

  const text = state.mode === 'csv' ? state.csvText : state.jsonText;

  return createPortal(
    <div className="schema-dialog-overlay" role="presentation">
      <div className="schema-dialog mysql-import-dialog" role="dialog" aria-modal="true" aria-labelledby={dialogId}>
        <div className="schema-dialog-header">
          <h3 id={dialogId}>{labels.title}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={state.executing}
            aria-label={labels.cancel}
          >
            ×
          </button>
        </div>

        <div className="schema-form-grid">
          <label className="schema-field schema-field-wide">
            <span>{labels.targetTable}</span>
            <select
              value={state.targetTable}
              onChange={(event) => onTargetChange(event.target.value)}
              disabled={state.executing}
            >
              <option value="">{labels.noTable}</option>
              <option value={editorTargetValue}>{labels.fromSqlEditor}</option>
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mysql-import-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={state.mode === 'csv'}
            className={state.mode === 'csv' ? 'active' : ''}
            onClick={() => onModeChange('csv')}
            disabled={state.executing}
          >
            {labels.csvTab}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={state.mode === 'json'}
            className={state.mode === 'json' ? 'active' : ''}
            onClick={() => onModeChange('json')}
            disabled={state.executing}
          >
            {labels.jsonTab}
          </button>
        </div>

        <div className="schema-import-file-row">
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            accept=".csv,.json"
            onChange={onFileSelected}
          />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={state.executing}>
            {labels.selectFile}
          </button>
        </div>

        <label className="schema-field schema-preview-field">
          <span>{state.mode === 'csv' ? labels.pasteCsv : labels.pasteJson}</span>
          <textarea
            value={text}
            onChange={(event) => onTextChange(state.mode, event.target.value)}
            disabled={state.executing}
            rows={8}
            autoFocus
          />
        </label>

        <div className="schema-section">
          <div className="schema-section-header">
            <strong>{labels.preview}</strong>
            {state.progress ? <span className="mysql-import-progress">{labels.progress}</span> : null}
          </div>
          <div className="mysql-import-preview">
            {state.columns.length > 0 && state.preview.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    {state.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.preview.map((row, rowIndex) => (
                    <tr key={`${rowIndex}-${state.columns.join('|')}`}>
                      {state.columns.map((column) => (
                        <td key={column}>{row[column] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="mysql-import-empty">{labels.noData}</div>
            )}
          </div>
        </div>

        {state.error ? (
          <div
            className="dismissible-alert mysql-message-banner error schema-dialog-alert schema-local-alert"
            role="alert"
          >
            <span className="dismissible-alert-content">{state.error}</span>
            <button
              type="button"
              className="dismissible-alert-close"
              onClick={onClearError}
              aria-label={labels.closeAlert}
              title={labels.closeAlert}
            >
              ×
            </button>
          </div>
        ) : null}

        <div className="schema-actions">
          <button type="button" onClick={onClose} disabled={state.executing}>
            {labels.cancel}
          </button>
          <button
            type="button"
            className="primary"
            onClick={onExecute}
            disabled={state.executing}
          >
            {state.executing ? labels.executing : labels.execute}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
