export function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return '操作失败。';
}

export function formatDateTime(value: string) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
