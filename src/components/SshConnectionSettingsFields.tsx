import {
  maximumSshConnectTimeoutSeconds,
  minimumSshConnectTimeoutSeconds,
  type AuthMethod,
} from '../appHostModel';
import { t } from '../i18n';

interface AuthenticationMethodSwitchProps {
  language: ShellDeskAppSettings['language'];
  value: AuthMethod;
  variant: 'host' | 'credential';
  keyDisabled?: boolean;
  onChange: (authMethod: AuthMethod) => void;
}

export function AuthenticationMethodSwitch({
  language,
  value,
  variant,
  keyDisabled = false,
  onChange,
}: AuthenticationMethodSwitchProps) {
  const credentialVariant = variant === 'credential';
  const label = t(credentialVariant ? 'app.credential.authMethod' : 'app.host.field.authMethod', language);
  const options: Array<{ value: AuthMethod; label: string; summary: string; disabled?: boolean }> = [
    {
      value: 'password',
      label: t(credentialVariant ? 'app.credential.password' : 'app.auth.passwordLogin', language),
      summary: t(credentialVariant ? 'app.credential.passwordSummary' : 'app.host.auth.passwordSummary', language),
    },
    {
      value: 'key',
      label: t(credentialVariant ? 'app.credential.key' : 'app.auth.keyLogin', language),
      summary: t(credentialVariant ? 'app.credential.keySummary' : 'app.host.auth.keySummary', language),
      disabled: keyDisabled,
    },
    {
      value: 'agent',
      label: t('app.auth.agentLogin', language),
      summary: t(credentialVariant ? 'app.credential.agentSummary' : 'app.host.auth.agentSummary', language),
    },
  ];

  return (
    <div className="auth-method-section">
      <span className="field-label">{label}</span>
      <div className="auth-switch" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? 'active' : ''}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
          >
            <strong>{option.label}</strong>
            <small>{option.summary}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

interface SshConnectTimeoutFieldProps {
  language: ShellDeskAppSettings['language'];
  value: string;
  inheritedSeconds: number;
  onChange: (value: string) => void;
}

export function SshConnectTimeoutField({
  language,
  value,
  inheritedSeconds,
  onChange,
}: SshConnectTimeoutFieldProps) {
  return (
    <label className="field">
      <span>{t('app.host.field.connectTimeout', language)}</span>
      <input
        type="number"
        min={minimumSshConnectTimeoutSeconds}
        max={maximumSshConnectTimeoutSeconds}
        step={1}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={String(inheritedSeconds)}
      />
      <small className="field-note">
        {t('app.host.field.connectTimeoutHint', language, { seconds: String(inheritedSeconds) })}
      </small>
    </label>
  );
}
