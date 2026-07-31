const maximumTerminalLinkLength = 2048;

export function normalizeSafeTerminalLink(value: string) {
  const candidate = value.trim();
  if (!candidate || candidate.length > maximumTerminalLinkLength) {
    return null;
  }

  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
