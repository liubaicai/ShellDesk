import { useMemo } from 'react';

import { tCurrent } from '../../i18n';

export interface DatabaseTunnelFormValue {
  enabled: boolean;
  remoteHost: string;
  remotePort: string;
  connectTimeoutMs: string;
}

interface DatabaseTunnelFieldsProps {
  value: DatabaseTunnelFormValue;
  defaultPort: number;
  onChange: (next: DatabaseTunnelFormValue) => void;
}

export function createDefaultTunnelValue(defaultPort: number): DatabaseTunnelFormValue {
  return {
    enabled: false,
    remoteHost: '127.0.0.1',
    remotePort: String(defaultPort),
    connectTimeoutMs: '15000',
  };
}

export function parseTunnelValue(
  value: DatabaseTunnelFormValue,
  fallbackPort: number,
): ShellDeskDatabaseTunnelConfig | undefined {
  if (!value.enabled) {
    return undefined;
  }

  const remotePort = Number.parseInt(value.remotePort, 10) || fallbackPort;
  const connectTimeoutMs = Number.parseInt(value.connectTimeoutMs, 10) || 15000;

  return {
    remoteHost: value.remoteHost.trim() || '127.0.0.1',
    remotePort,
    connectTimeoutMs,
  };
}

export function DatabaseTunnelFields({ value, defaultPort, onChange }: DatabaseTunnelFieldsProps) {
  const portInvalid = useMemo(() => {
    const port = Number.parseInt(value.remotePort, 10);
    return value.enabled && (!Number.isInteger(port) || port < 1 || port > 65535);
  }, [value.enabled, value.remotePort]);

  return (
    <section className="database-tunnel-fields">
      <label className="database-tunnel-toggle">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.currentTarget.checked })}
        />
        <span>{tCurrent('db.tunnel.enable')}</span>
      </label>

      {value.enabled ? (
        <div className="database-tunnel-grid">
          <label className="database-tunnel-field">
            <span>{tCurrent('db.tunnel.remoteHost')}</span>
            <input
              value={value.remoteHost}
              placeholder="127.0.0.1"
              onChange={(event) => onChange({ ...value, remoteHost: event.currentTarget.value })}
            />
          </label>
          <label className="database-tunnel-field">
            <span>{tCurrent('db.tunnel.remotePort')}</span>
            <input
              value={value.remotePort}
              inputMode="numeric"
              placeholder={String(defaultPort)}
              aria-invalid={portInvalid}
              onChange={(event) => onChange({ ...value, remotePort: event.currentTarget.value })}
            />
          </label>
          <label className="database-tunnel-field">
            <span>{tCurrent('db.tunnel.connectTimeout')}</span>
            <input
              value={value.connectTimeoutMs}
              inputMode="numeric"
              placeholder="15000"
              onChange={(event) => onChange({ ...value, connectTimeoutMs: event.currentTarget.value })}
            />
          </label>
        </div>
      ) : null}
    </section>
  );
}
