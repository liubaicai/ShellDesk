import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';
import { t, useCurrentAppLanguage, type MessageId } from '../../i18n';
import { buildContainerRunArgs, createContainerNameSuggestion, formatRuntimeCommand, getRuntimeLabel } from './containerCommands';
import type { ContainerRunForm as ContainerRunFormState, ContainerRuntime, ContainerTroubleshooting, RestartPolicy, RunNetworkMode } from './containerTypes';
import type { RemoteSystemType } from './types';

const restartPolicyOptions: Array<{ value: RestartPolicy; labelId: MessageId }> = [
  { value: 'no', labelId: 'container.restartPolicy.no' },
  { value: 'on-failure', labelId: 'container.restartPolicy.onFailure' },
  { value: 'unless-stopped', labelId: 'container.restartPolicy.unlessStopped' },
  { value: 'always', labelId: 'container.restartPolicy.always' },
];

const runNetworkModeOptions: Array<{ value: RunNetworkMode; labelId: MessageId }> = [
  { value: 'default', labelId: 'container.network.default' },
  { value: 'bridge', labelId: 'container.network.bridge' },
  { value: 'host', labelId: 'container.network.host' },
  { value: 'none', labelId: 'container.network.none' },
  { value: 'custom', labelId: 'container.network.custom' },
];

function createDefaultRunForm(image = ''): ContainerRunFormState {
  return {
    image,
    name: image ? createContainerNameSuggestion(image) : '',
    ports: '',
    volumes: '',
    environment: '',
    restartPolicy: 'unless-stopped',
    networkMode: 'default',
    network: '',
    hostname: '',
    workdir: '',
    user: '',
    privileged: false,
    command: '',
    extraArgs: '',
    createOnly: false,
    removeWhenStopped: false,
  };
}

interface ContainerRunFormProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  runtime: ContainerRuntime | null;
  initialImage?: string;
  running: boolean;
  error: string;
  troubleshooting: ContainerTroubleshooting | null;
  onSubmit: (form: ContainerRunFormState) => void | Promise<void>;
  onCancel: () => void;
  onResetError: () => void;
  onCopy: (value: string, label: string) => void | Promise<void>;
}

function ContainerRunForm({ runtime, initialImage = '', running, error, troubleshooting, onSubmit, onCancel, onResetError, onCopy }: ContainerRunFormProps) {
  const language = useCurrentAppLanguage();
  const [form, setForm] = useState<ContainerRunFormState>(() => createDefaultRunForm(initialImage));

  useEffect(() => {
    setForm(createDefaultRunForm(initialImage));
  }, [initialImage]);

  const updateForm = <Key extends keyof ContainerRunFormState>(key: Key, value: ContainerRunFormState[Key]) => {
    setForm((currentForm) => ({ ...currentForm, [key]: value }));
  };

  const resetForm = () => setForm(createDefaultRunForm());

  const runCommandPreview = useMemo(() => {
    try {
      if (!form.image.trim()) return '';
      return formatRuntimeCommand(runtime ?? 'docker', buildContainerRunArgs(form, language));
    } catch {
      return '';
    }
  }, [form, language, runtime]);

  return createPortal(
    <div
      className="container-run-modal-overlay"
      role="presentation"
      onClick={() => {
        if (!running) onCancel();
      }}
    >
      <section
        className="container-run-dialog container-run-workbench"
        role="dialog"
        aria-modal="true"
        aria-label={t('container.ui.runWorkbenchAria', language)}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="container-workbench-header">
          <div>
            <strong>{t('container.ui.runWorkbench', language)}</strong>
            <span>{runtime ? getRuntimeLabel(runtime, language) : t('container.runtime.notDetected', language)}</span>
          </div>
          <div>
            <button type="button" className="container-tool-button" onClick={resetForm}>{t('container.ui.reset', language)}</button>
            <button type="button" className="container-tool-button" onClick={onCancel} disabled={running}>{t('common.close', language)}</button>
          </div>
        </header>
        {error ? <DismissibleAlert className="container-alert danger container-run-alert" onDismiss={onResetError} role="alert">{error}</DismissibleAlert> : null}
        {troubleshooting ? (
          <section className="container-troubleshooting container-run-troubleshooting" aria-label={t('container.ui.troubleshootingAria', language)}>
            <div>
              <strong>{troubleshooting.title}</strong>
              <p>{troubleshooting.message}</p>
            </div>
            <div className="container-troubleshooting-actions">
              <button type="button" className="container-tool-button" onClick={() => void onCopy(troubleshooting.commands, t('container.ui.copyFixCommandLabel', language))}>{t('container.ui.copyFixCommand', language)}</button>
              <button type="button" className="container-tool-button" onClick={() => void onCopy(troubleshooting.rawOutput, t('container.ui.copyRawErrorLabel', language))}>{t('container.ui.copyRawError', language)}</button>
            </div>
            <pre>{troubleshooting.commands}</pre>
          </section>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(form);
          }}
        >
          <div className="container-run-grid">
            <label className="wide"><span>{t('container.ui.image', language)}</span><input type="text" value={form.image} onChange={(event) => updateForm('image', event.target.value)} placeholder="nginx:latest" /></label>
            <label><span>{t('container.ui.name', language)}</span><input type="text" value={form.name} onChange={(event) => updateForm('name', event.target.value)} placeholder="web-1" /></label>
            <label><span>{t('container.ui.restartPolicy', language)}</span><select value={form.restartPolicy} onChange={(event) => updateForm('restartPolicy', event.target.value as RestartPolicy)}>{restartPolicyOptions.map((option) => <option key={option.value} value={option.value}>{t(option.labelId, language)}</option>)}</select></label>
            <label><span>{t('container.ui.network', language)}</span><select value={form.networkMode} onChange={(event) => {
              const nextMode = event.target.value as RunNetworkMode;
              setForm((currentForm) => ({ ...currentForm, networkMode: nextMode, network: nextMode === 'custom' ? currentForm.network : '' }));
            }}>{runNetworkModeOptions.map((option) => <option key={option.value} value={option.value}>{t(option.labelId, language)}</option>)}</select></label>
            {form.networkMode === 'custom' ? <label><span>{t('container.ui.customNetwork', language)}</span><input type="text" value={form.network} onChange={(event) => updateForm('network', event.target.value)} placeholder="app-net" /></label> : null}
            <label><span>{t('container.ui.hostname', language)}</span><input type="text" value={form.hostname} onChange={(event) => updateForm('hostname', event.target.value)} placeholder="app" /></label>
            <label><span>{t('container.ui.workdir', language)}</span><input type="text" value={form.workdir} onChange={(event) => updateForm('workdir', event.target.value)} placeholder="/app" /></label>
            <label><span>{t('container.ui.user', language)}</span><input type="text" value={form.user} onChange={(event) => updateForm('user', event.target.value)} placeholder="1000:1000" /></label>
            <label className="stack"><span>{t('container.ui.portMappings', language)}</span><textarea value={form.ports} onChange={(event) => updateForm('ports', event.target.value)} placeholder="8080:80" rows={3} /></label>
            <label className="stack"><span>{t('container.ui.volumeMappings', language)}</span><textarea value={form.volumes} onChange={(event) => updateForm('volumes', event.target.value)} placeholder="/host/data:/data" rows={3} /></label>
            <label className="stack"><span>{t('container.ui.environment', language)}</span><textarea value={form.environment} onChange={(event) => updateForm('environment', event.target.value)} placeholder="NODE_ENV=production" rows={3} /></label>
            <label className="wide"><span>{t('container.ui.command', language)}</span><input type="text" value={form.command} onChange={(event) => updateForm('command', event.target.value)} placeholder={'sh -c "npm start"'} /></label>
            <label className="wide"><span>{t('container.ui.extraArgs', language)}</span><input type="text" value={form.extraArgs} onChange={(event) => updateForm('extraArgs', event.target.value)} placeholder="--add-host app.local:127.0.0.1" /></label>
          </div>
          <div className="container-run-options">
            <label><input type="checkbox" checked={form.privileged} onChange={(event) => updateForm('privileged', event.target.checked)} /><span>{t('container.ui.privilegedMode', language)}</span></label>
            <label><input type="checkbox" checked={form.createOnly} onChange={(event) => updateForm('createOnly', event.target.checked)} /><span>{t('container.ui.createOnly', language)}</span></label>
            <label><input type="checkbox" checked={!form.createOnly && form.removeWhenStopped} disabled={form.createOnly} onChange={(event) => updateForm('removeWhenStopped', event.target.checked)} /><span>{t('container.ui.removeWhenStopped', language)}</span></label>
          </div>
          {runCommandPreview ? (
            <div className="container-command-preview">
              <header><span>{t('container.ui.commandPreview', language)}</span><button type="button" className="container-copy-btn" onClick={() => void onCopy(runCommandPreview, t('container.ui.commandPreview', language))}>{t('container.ui.copy', language)}</button></header>
              <pre>{runCommandPreview}</pre>
            </div>
          ) : null}
          <div className="container-workbench-actions">
            <button type="submit" className="container-action-btn primary" disabled={running}>{running ? t('container.ui.processing', language) : t(form.createOnly ? 'container.ui.createContainer' : 'container.ui.runContainer', language)}</button>
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}

export default ContainerRunForm;
