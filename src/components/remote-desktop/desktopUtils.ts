import { tCurrent, getCurrentAppLocale } from '../../i18n';

export function getErrorMessage(error: unknown) {
  const stripShellDeskPrefix = (message: string) => message.replace(
    /^SHELLDESK_(?:SU_ROOT_AUTH_FAILED|SU_ROOT_UNSUPPORTED):/,
    '',
  ).trim();

  if (error instanceof Error && error.message) {
    return stripShellDeskPrefix(error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
  }

  if (typeof error === 'string' && error.trim()) {
    return stripShellDeskPrefix(error.trim());
  }

  return tCurrent('auto.desktopUtils.5borik');
}

export function getShellDeskLocale() {
  return getCurrentAppLocale();
}

export function formatDateTime(value: string) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat(getShellDeskLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
