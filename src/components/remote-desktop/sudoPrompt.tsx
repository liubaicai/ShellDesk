import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { tCurrent } from '../../i18n';
import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem, type RemoteCommandInput } from './remoteSystem';
import type { RemoteSystemType } from './types';

type RemoteCommandResult = { stdout: string; stderr: string; code: number };
type CommandStreamCallbacks = { onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void };

interface SudoPromptState {
  command: string;
  error: string;
  password: string;
}

interface RunCommandOptions {
  onSudoAttempt?: () => void;
}

const sudoPasswordCache = new Map<string, string>();

const elevationPrefixes = [
  'SHELLDESK_ELEVATION_REQUIRED:',
  'SHELLDESK_ELEVATION_AUTH_FAILED:',
  'SHELLDESK_SU_ROOT_AUTH_FAILED:',
  'SHELLDESK_SU_ROOT_UNSUPPORTED:',
];

const fatalElevationPrefixes = [
  'SHELLDESK_SU_ROOT_AUTH_FAILED:',
  'SHELLDESK_SU_ROOT_UNSUPPORTED:',
];

const sudoPasswordRequiredPatterns = [
  /sudo:.*password is required/i,
  /sudo:.*a terminal is required/i,
  /sudo:.*no tty present/i,
  /a password is required/i,
];

const sudoAuthFailurePatterns = [
  /sorry,\s*try again/i,
  /incorrect password/i,
  /authentication failure/i,
  /authentication failed/i,
];

const privilegeFailurePatterns = [
  ...sudoPasswordRequiredPatterns,
  ...sudoAuthFailurePatterns,
  /permission denied/i,
  /operation not permitted/i,
  /you must be root/i,
  /must be run as root/i,
  /requires root/i,
  /requires administrator/i,
  /access denied/i,
];

function stripElevationPrefix(message: string) {
  const trimmedMessage = message.trim();
  const prefix = elevationPrefixes.find((item) => trimmedMessage.startsWith(item));
  return prefix ? trimmedMessage.slice(prefix.length).trim() : trimmedMessage;
}

function getRawErrorMessage(value: unknown) {
  if (value instanceof Error && value.message) {
    return value.message.replace(/^Error invoking remote method '[^']+': Error: /, '').trim();
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return '';
}

function isFatalElevationErrorText(text: string) {
  return fatalElevationPrefixes.some((prefix) => text.trim().startsWith(prefix));
}

function getResultText(result: RemoteCommandResult) {
  return [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
}

function hasPattern(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function getPrivilegeFailureText(value: RemoteCommandResult | unknown, systemType?: RemoteSystemType) {
  if (isWindowsSystem(systemType)) {
    return '';
  }

  if (value && typeof value === 'object' && 'code' in value) {
    const result = value as RemoteCommandResult;
    if (result.code === 0) {
      return '';
    }

    const text = stripElevationPrefix(getResultText(result));
    return hasPattern(text, privilegeFailurePatterns) ? text : '';
  }

  const rawText = getRawErrorMessage(value);

  if (isFatalElevationErrorText(rawText)) {
    return '';
  }

  const text = stripElevationPrefix(rawText || getErrorMessage(value));
  return hasPattern(text, privilegeFailurePatterns) ? text : '';
}

function isAuthFailureText(text: string) {
  return hasPattern(text, sudoAuthFailurePatterns);
}

function getCachedSudoPassword(connectionId: string): string | null {
  return sudoPasswordCache.has(connectionId) ? sudoPasswordCache.get(connectionId) ?? '' : null;
}

export function setCachedSudoPassword(connectionId: string, password: string) {
  sudoPasswordCache.set(connectionId, password);
}

export function clearCachedSudoPassword(connectionId: string) {
  sudoPasswordCache.delete(connectionId);
}

export function getCachedSudoOptions(connectionId: string): ShellDeskSudoPasswordOptions | undefined {
  const password = getCachedSudoPassword(connectionId);
  return password === null ? undefined : { sudoPassword: password };
}

function getRemoteCommand(input: string | RemoteCommandInput, stdin?: string) {
  return typeof input === 'string'
    ? { command: input, stdin }
    : { command: input.command, stdin: input.stdin };
}

export function useSudoCommand(connectionId: string, systemType?: RemoteSystemType) {
  const [sudoPrompt, setSudoPrompt] = useState<SudoPromptState | null>(null);
  const promptResolverRef = useRef<((password: string | null) => void) | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (sudoPrompt) {
      passwordInputRef.current?.focus();
    }
  }, [sudoPrompt?.command]);

  useEffect(() => {
    return () => {
      promptResolverRef.current?.(null);
      promptResolverRef.current = null;
    };
  }, []);

  const requestSudoPassword = useCallback((command: string, error: string) => {
    promptResolverRef.current?.(null);

    return new Promise<string | null>((resolve) => {
      promptResolverRef.current = resolve;
      setSudoPrompt({ command, error, password: '' });
    });
  }, []);

  const resolveSudoPrompt = useCallback((password: string | null) => {
    promptResolverRef.current?.(password);
    promptResolverRef.current = null;
    setSudoPrompt(null);
  }, []);

  const runCommand = useCallback(async (
    input: string | RemoteCommandInput,
    stdin?: string,
    options: RunCommandOptions = {},
  ) => {
    const api = window.guiSSH?.connections;

    if (!api) {
      throw new Error(tCurrent('sudoPrompt.noApi'));
    }

    const commandInput = getRemoteCommand(input, stdin);
    let failureText = '';

    try {
      const result = await api.runCommand(connectionId, commandInput.command, commandInput.stdin);
      failureText = getPrivilegeFailureText(result, systemType);

      if (!failureText) {
        return result;
      }
    } catch (error) {
      failureText = getPrivilegeFailureText(error, systemType);

      if (!failureText) {
        throw error;
      }
    }

    const cachedPassword = getCachedSudoPassword(connectionId);

    if (cachedPassword !== null) {
      options.onSudoAttempt?.();

      try {
        const result = await api.runCommand(connectionId, commandInput.command, commandInput.stdin, { sudoPassword: cachedPassword });
        const retryFailureText = getPrivilegeFailureText(result, systemType);

        if (!retryFailureText) {
          return result;
        }

        if (!isAuthFailureText(retryFailureText)) {
          return result;
        }

        clearCachedSudoPassword(connectionId);
        failureText = retryFailureText;
      } catch (error) {
        const retryFailureText = getPrivilegeFailureText(error, systemType);

        if (!retryFailureText) {
          throw error;
        }

        clearCachedSudoPassword(connectionId);
        failureText = retryFailureText;
      }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const password = await requestSudoPassword(commandInput.command, failureText);

      if (password === null) {
        throw new Error(tCurrent('sudoPrompt.cancelled'));
      }

      options.onSudoAttempt?.();

      try {
        const result = await api.runCommand(connectionId, commandInput.command, commandInput.stdin, { sudoPassword: password });
        const retryFailureText = getPrivilegeFailureText(result, systemType);

        if (!retryFailureText) {
          setCachedSudoPassword(connectionId, password);
          return result;
        }

        if (!isAuthFailureText(retryFailureText)) {
          return result;
        }

        failureText = retryFailureText;
      } catch (error) {
        const retryFailureText = getPrivilegeFailureText(error, systemType);

        if (!retryFailureText) {
          throw error;
        }

        failureText = retryFailureText;
      }
    }

    throw new Error(tCurrent('sudoPrompt.failed', { error: failureText }));
  }, [connectionId, requestSudoPassword, systemType]);

  const runCommandStream = useCallback(async (
    input: string | RemoteCommandInput,
    stdin?: string,
    callbacks: CommandStreamCallbacks = {},
    options: RunCommandOptions = {},
  ) => {
    const api = window.guiSSH?.connections;

    if (!api?.runCommandStream) {
      throw new Error(tCurrent('sudoPrompt.noStreamApi'));
    }

    const commandInput = getRemoteCommand(input, stdin);
    let failureText = '';

    try {
      const result = await api.runCommandStream(connectionId, commandInput.command, commandInput.stdin, callbacks);
      failureText = getPrivilegeFailureText(result, systemType);

      if (!failureText) {
        return result;
      }
    } catch (error) {
      failureText = getPrivilegeFailureText(error, systemType);

      if (!failureText) {
        throw error;
      }
    }

    const cachedPassword = getCachedSudoPassword(connectionId);

    if (cachedPassword !== null) {
      options.onSudoAttempt?.();

      try {
        const result = await api.runCommandStream(connectionId, commandInput.command, commandInput.stdin, callbacks, { sudoPassword: cachedPassword });
        const retryFailureText = getPrivilegeFailureText(result, systemType);

        if (!retryFailureText) {
          return result;
        }

        if (!isAuthFailureText(retryFailureText)) {
          return result;
        }

        clearCachedSudoPassword(connectionId);
        failureText = retryFailureText;
      } catch (error) {
        const retryFailureText = getPrivilegeFailureText(error, systemType);

        if (!retryFailureText) {
          throw error;
        }

        clearCachedSudoPassword(connectionId);
        failureText = retryFailureText;
      }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const password = await requestSudoPassword(commandInput.command, failureText);

      if (password === null) {
        throw new Error(tCurrent('sudoPrompt.cancelled'));
      }

      options.onSudoAttempt?.();

      try {
        const result = await api.runCommandStream(connectionId, commandInput.command, commandInput.stdin, callbacks, { sudoPassword: password });
        const retryFailureText = getPrivilegeFailureText(result, systemType);

        if (!retryFailureText) {
          setCachedSudoPassword(connectionId, password);
          return result;
        }

        if (!isAuthFailureText(retryFailureText)) {
          return result;
        }

        failureText = retryFailureText;
      } catch (error) {
        const retryFailureText = getPrivilegeFailureText(error, systemType);

        if (!retryFailureText) {
          throw error;
        }

        failureText = retryFailureText;
      }
    }

    throw new Error(tCurrent('sudoPrompt.failed', { error: failureText }));
  }, [connectionId, requestSudoPassword, systemType]);

  const sudoPromptPortal: ReactNode = sudoPrompt ? createPortal(
    <div className="sudo-prompt-overlay" role="presentation" onMouseDown={() => resolveSudoPrompt(null)}>
      <form
        className="sudo-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sudo-prompt-title"
        data-testid="sudo-prompt-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          resolveSudoPrompt(sudoPrompt.password);
        }}
      >
        <div id="sudo-prompt-title" className="sudo-prompt-title">{tCurrent('sudoPrompt.title')}</div>
        <div className="sudo-prompt-message">{tCurrent('sudoPrompt.message')}</div>
        <div className="sudo-prompt-command" title={sudoPrompt.command}>{sudoPrompt.command}</div>
        {sudoPrompt.error ? <div className="sudo-prompt-error">{tCurrent('sudoPrompt.lastError', { error: sudoPrompt.error })}</div> : null}
        <label className="sudo-prompt-field">
          <span>{tCurrent('sudoPrompt.password')}</span>
          <input
            ref={passwordInputRef}
            className="sudo-prompt-input"
            data-testid="sudo-prompt-password"
            type="password"
            autoComplete="current-password"
            value={sudoPrompt.password}
            placeholder={tCurrent('sudoPrompt.passwordPlaceholder')}
            onChange={(event) => setSudoPrompt({ ...sudoPrompt, password: event.target.value })}
          />
        </label>
        <div className="sudo-prompt-actions">
          <button type="button" className="sudo-prompt-btn" onClick={() => resolveSudoPrompt(null)}>
            {tCurrent('common.cancel')}
          </button>
          <button type="submit" className="sudo-prompt-btn primary" disabled={!sudoPrompt.password}>
            {tCurrent('sudoPrompt.submit')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  ) : null;

  return { runCommand, runCommandStream, sudoPrompt: sudoPromptPortal };
}
