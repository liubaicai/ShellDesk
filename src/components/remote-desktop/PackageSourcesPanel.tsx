import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import DismissibleAlert from './DismissibleAlert';
import { getErrorMessage } from './desktopUtils';
import {
  createDetectPackageManagerCommand,
  createPackageSourceInspectCommand,
  createPackageSourceSaveCommand,
  getPackageManagerLabel,
  normalizePackageManager,
  parsePackageSourceFiles,
  type PackageManagerKind,
  type PackageSourceFile,
} from './packageProviders';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteTerminalLaunchOptions } from './RemoteTerminal';
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface PackageSourcesPanelProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  onOpenTerminal?: (launchOptions?: RemoteTerminalLaunchOptions) => void;
}

interface PendingSourceAction {
  label: string;
  command: string;
  sourcePath: string;
  preview: string;
}

type SourceActionOutputState = 'idle' | 'running' | 'success' | 'error';

const maxSourceActionOutputLength = 30000;

function appendBoundedOutput(current: string, chunk: string) {
  if (!chunk) {
    return current;
  }

  const next = `${current}${chunk}`;

  if (next.length <= maxSourceActionOutputLength) {
    return next;
  }

  return tCurrent('auto.remotePackageManager.1lc7uz5', { value0: next.slice(-maxSourceActionOutputLength) });
}

function createSourceChangePreview(current: string, draft: string) {
  if (current === draft) {
    return tCurrent('auto.remotePackageManager.16jd8ra');
  }

  const currentLines = current.split(/\r?\n/);
  const draftLines = draft.split(/\r?\n/);
  const currentLineSet = new Set(currentLines);
  const draftLineSet = new Set(draftLines);
  const added = draftLines.filter((line) => line.trim() && !currentLineSet.has(line)).slice(0, 12);
  const removed = currentLines.filter((line) => line.trim() && !draftLineSet.has(line)).slice(0, 12);

  return [
    tCurrent('auto.remotePackageManager.1y0gzhx', { value0: currentLines.length, value1: draftLines.length }),
    '',
    tCurrent('auto.remotePackageManager.7mg4pa'),
    ...(added.length ? added.map((line) => `+ ${line}`) : [tCurrent('auto.remotePackageManager.11dg74m')]),
    '',
    tCurrent('auto.remotePackageManager.2rsx5w'),
    ...(removed.length ? removed.map((line) => `- ${line}`) : [tCurrent('auto.remotePackageManager.11dg74m')]),
  ].join('\n');
}

function PackageSourcesPanel({ connectionId, systemType, onOpenTerminal }: PackageSourcesPanelProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, runCommandStream, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const [managerKind, setManagerKind] = useState<PackageManagerKind>('unknown');
  const [sourceFiles, setSourceFiles] = useState<PackageSourceFile[]>([]);
  const [selectedSourcePath, setSelectedSourcePath] = useState('');
  const [sourceDraft, setSourceDraft] = useState('');
  const [sourceLoading, setSourceLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingSourceAction | null>(null);
  const [actionOutput, setActionOutput] = useState('');
  const [actionOutputState, setActionOutputState] = useState<SourceActionOutputState>('idle');
  const bootKeyRef = useRef('');
  const actionOutputRef = useRef<HTMLPreElement | null>(null);

  const selectedSourceFile = useMemo(() => {
    return sourceFiles.find((file) => file.path === selectedSourcePath) ?? sourceFiles[0] ?? null;
  }, [selectedSourcePath, sourceFiles]);
  const sourceDraftDirty = Boolean(selectedSourceFile && selectedSourceFile.content !== sourceDraft);
  const selectedSourceEditable = Boolean(selectedSourceFile && (selectedSourceFile.readable || !selectedSourceFile.exists));

  const detectManager = useCallback(async () => {
    setError('');

    try {
      const result = await runCommand(createDetectPackageManagerCommand(isWindowsHost));
      const kind = normalizePackageManager(result.stdout.split(/\r?\n/).find(Boolean) ?? 'unknown');
      setManagerKind(kind);
      return kind;
    } catch (error) {
      setError(getErrorMessage(error));
      return 'unknown' as PackageManagerKind;
    }
  }, [isWindowsHost, runCommand]);

  const loadPackageSources = useCallback(async (kind = managerKind, preferredPath = selectedSourcePath) => {
    if (kind === 'unknown' || kind === 'winget' || kind === 'choco') {
      setError(tCurrent('auto.remotePackageManager.pfwf28'));
      setSourceFiles([]);
      setSelectedSourcePath('');
      setSourceDraft('');
      return;
    }

    setSourceLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createPackageSourceInspectCommand(kind));
      const nextFiles = parsePackageSourceFiles(result.stdout);
      const nextSelected = nextFiles.find((file) => file.path === preferredPath) ?? nextFiles[0] ?? null;
      setSourceFiles(nextFiles);
      setSelectedSourcePath(nextSelected?.path ?? '');
      setSourceDraft(nextSelected?.content ?? '');
      if (result.stderr.trim()) {
        setNotice(result.stderr.trim());
      }
      if (!nextFiles.length) {
        setNotice(tCurrent('auto.remotePackageManager.1srs40g'));
      }
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setSourceLoading(false);
    }
  }, [managerKind, runCommand, selectedSourcePath]);

  useEffect(() => {
    const bootKey = `${connectionId}:${isWindowsHost ? 'windows' : 'unix'}`;
    if (bootKeyRef.current === bootKey) {
      return;
    }
    bootKeyRef.current = bootKey;

    const boot = async () => {
      const kind = await detectManager();
      if (kind !== 'unknown') {
        await loadPackageSources(kind);
      }
    };

    void boot();
  }, [connectionId, detectManager, isWindowsHost, loadPackageSources]);

  useEffect(() => {
    const outputElement = actionOutputRef.current;
    if (!outputElement) return;
    outputElement.scrollTop = outputElement.scrollHeight;
  }, [actionOutput]);

  const resetActionOutput = () => {
    setActionOutput('');
    setActionOutputState('idle');
  };

  const closePendingAction = () => {
    if (actionRunning) return;
    setPendingAction(null);
    resetActionOutput();
  };

  const selectSourceFile = (file: PackageSourceFile) => {
    setSelectedSourcePath(file.path);
    setSourceDraft(file.content);
    setError('');
    setNotice('');
  };

  const requestSaveSource = () => {
    if (!selectedSourceFile) return;

    if (!sourceDraftDirty) {
      setNotice(tCurrent('auto.remotePackageManager.16jd8ra'));
      return;
    }

    try {
      setPendingAction({
        label: tCurrent('auto.remotePackageManager.1hfqjob'),
        command: createPackageSourceSaveCommand(selectedSourceFile.path, sourceDraft),
        sourcePath: selectedSourceFile.path,
        preview: createSourceChangePreview(selectedSourceFile.content, sourceDraft),
      });
      resetActionOutput();
    } catch (error) {
      setError(getErrorMessage(error));
    }
  };

  const copyPendingCommand = async () => {
    if (!pendingAction) return;
    await navigator.clipboard.writeText(pendingAction.command);
    setNotice(tCurrent('auto.remotePackageManager.1ys75c3'));
  };

  const runPendingInTerminal = () => {
    if (!pendingAction) return;
    onOpenTerminal?.({
      title: pendingAction.label,
      initialCommand: pendingAction.command,
    });
    closePendingAction();
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;

    const outputCommandLabel = `${pendingAction.label} ${pendingAction.sourcePath}`.trim();

    setActionRunning(true);
    setActionOutput(`$ ${outputCommandLabel}\n`);
    setActionOutputState('running');
    setError('');
    setNotice('');

    try {
      let receivedChunk = false;
      const result = await runCommandStream(pendingAction.command, undefined, {
        onChunk: (chunk) => {
          receivedChunk = true;
          setActionOutput((current) => appendBoundedOutput(current, chunk));
        },
      }, {
        onSudoAttempt: () => setActionOutput(`$ ${outputCommandLabel}\n`),
      });

      if (!receivedChunk) {
        const finalOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
        if (finalOutput) {
          setActionOutput((current) => appendBoundedOutput(current, `${finalOutput}\n`));
        }
      }

      setActionOutput((current) => appendBoundedOutput(current, tCurrent('auto.remotePackageManager.1tbpxd4', { value0: result.code, value1: pendingAction.label })));
      setActionOutputState(result.code === 0 ? 'success' : 'error');

      if (result.code === 0) {
        await loadPackageSources(managerKind, pendingAction.sourcePath);
        setNotice(tCurrent('auto.remotePackageManager.nkcjw9', { value0: pendingAction.label }));
      } else {
        setError(tCurrent('auto.remotePackageManager.1fdgco1', { value0: pendingAction.label, value1: result.code }));
      }
    } catch (error) {
      setActionOutput((current) => appendBoundedOutput(current, tCurrent('auto.remotePackageManager.127m15g', { value0: getErrorMessage(error) })));
      setActionOutputState('error');
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  return (
    <section className="package-manager package-source-settings">
      <header className="package-toolbar">
        <div className="package-status">
          <span>{tCurrent('auto.remotePackageManager.1sgu85')}</span>
          <strong>{getPackageManagerLabel(managerKind)}</strong>
        </div>
        <div className="package-toolbar-actions">
          <button type="button" onClick={() => void detectManager()} disabled={sourceLoading}>{tCurrent('auto.remotePackageManager.1ot472x')}</button>
          <button type="button" className="primary" onClick={() => void loadPackageSources()} disabled={sourceLoading || managerKind === 'unknown'}>
            {sourceLoading ? tCurrent('auto.remotePackageManager.6svkbt') : tCurrent('auto.remotePackageManager.h4t3jz')}
          </button>
        </div>
      </header>

      {error ? <DismissibleAlert className="package-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="package-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="package-layout source-mode">
        <aside className="package-sidebar">
          <div className="package-nav-group">
            <span className="package-sidebar-label">{tCurrent('auto.remotePackageManager.18gkps8')}</span>
            <div className="package-source-list">
              {sourceFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={selectedSourceFile?.path === file.path ? 'active' : ''}
                  onClick={() => selectSourceFile(file)}
                >
                  <strong>{file.path.split('/').pop() || file.path}</strong>
                  <span>{file.path}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="package-list-panel package-source-editor-panel">
          {selectedSourceFile ? (
            <>
              <div className="package-source-editor-header">
                <div>
                  <span>{tCurrent('auto.remotePackageManager.10y3552')}</span>
                  <strong>{selectedSourceFile.path}</strong>
                </div>
                <span className={`package-pill ${sourceDraftDirty ? 'warning' : 'success'}`}>
                  {sourceDraftDirty ? tCurrent('auto.remotePackageManager.1bduy4n') : tCurrent('auto.remotePackageManager.16jd8ra')}
                </span>
              </div>
              <textarea
                className="package-source-editor"
                value={sourceDraft}
                onChange={(event) => setSourceDraft(event.target.value)}
                spellCheck={false}
                disabled={!selectedSourceEditable}
              />
            </>
          ) : (
            <div className="package-empty detail">{sourceLoading ? tCurrent('auto.remotePackageManager.6svkbt') : tCurrent('auto.remotePackageManager.1srs40g')}</div>
          )}
        </main>

        <aside className="package-detail-panel">
          {selectedSourceFile ? (
            <>
              <div className="package-detail-title">
                <span>{tCurrent('auto.remotePackageManager.qvxb20')}</span>
                <strong>{selectedSourceFile.path.split('/').pop() || selectedSourceFile.path}</strong>
              </div>
              <dl>
                <div><dt>{tCurrent('auto.remotePackageManager.10y3552')}</dt><dd>{selectedSourceFile.path}</dd></div>
                <div><dt>{tCurrent('auto.remotePackageManager.r4v5rk')}</dt><dd>{selectedSourceFile.exists ? tCurrent('auto.remotePackageManager.n6qkzx') : tCurrent('auto.remotePackageManager.w4vz40')}</dd></div>
                <div><dt>{tCurrent('auto.remotePackageManager.1r8s3zl')}</dt><dd>{selectedSourceFile.readable ? tCurrent('auto.remotePackageManager.n6qkzx') : tCurrent('auto.remotePackageManager.w4vz40')}</dd></div>
              </dl>
              <div className="package-detail-actions">
                <button type="button" className="primary" onClick={requestSaveSource} disabled={!selectedSourceEditable || !sourceDraftDirty || actionRunning}>
                  {tCurrent('auto.remotePackageManager.1hfqjob')}
                </button>
                <button type="button" onClick={() => setSourceDraft(selectedSourceFile.content)} disabled={!sourceDraftDirty}>
                  {tCurrent('auto.remotePackageManager.1ij3f4x')}
                </button>
              </div>
              <div className="package-note">{tCurrent('auto.remotePackageManager.6ek2rh')}</div>
            </>
          ) : (
            <div className="package-empty detail">{tCurrent('auto.remotePackageManager.1srs40g')}</div>
          )}
        </aside>
      </div>

      {pendingAction ? createPortal(
        <div className="package-modal-backdrop" role="presentation" onClick={closePendingAction}>
          <div className="package-confirm-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="package-confirm-header">
              <span>{tCurrent('auto.remotePackageManager.ahn1l4')}</span>
              <strong>{pendingAction.label} {pendingAction.sourcePath}</strong>
            </div>
            <pre>{pendingAction.preview}</pre>
            {actionOutputState !== 'idle' || actionOutput ? (
              <div className="package-command-output">
                <div className="package-command-output-header">
                  <strong>{tCurrent('auto.remotePackageManager.1mh8d93')}</strong>
                  <span className={`package-output-state ${actionOutputState}`}>
                    {actionOutputState === 'running' ? tCurrent('auto.remotePackageManager.6svkbt') : actionOutputState === 'success' ? tCurrent('auto.remotePackageManager.19j4h') : actionOutputState === 'error' ? tCurrent('auto.remotePackageManager.omysx0') : tCurrent('auto.remotePackageManager.1oherf4')}
                  </span>
                </div>
                <pre ref={actionOutputRef} aria-live="polite">{actionOutput || tCurrent('auto.remotePackageManager.k2xa6s')}</pre>
              </div>
            ) : null}
            <div className="package-confirm-actions">
              <button type="button" onClick={closePendingAction} disabled={actionRunning}>{actionOutputState === 'idle' ? tCurrent('auto.remotePackageManager.1589w37') : tCurrent('auto.remotePackageManager.g0fanx')}</button>
              <button type="button" onClick={copyPendingCommand}>{tCurrent('auto.remotePackageManager.qxd4qr')}</button>
              <button type="button" onClick={runPendingInTerminal} disabled={!onOpenTerminal || actionRunning}>{tCurrent('auto.remotePackageManager.la3v4c')}</button>
              <button type="button" className="danger" onClick={executePendingAction} disabled={actionRunning}>
                {actionRunning ? tCurrent('auto.remotePackageManager.6svkbt2') : tCurrent('auto.remotePackageManager.th962h')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {sudoPrompt}
    </section>
  );
}

export default PackageSourcesPanel;
