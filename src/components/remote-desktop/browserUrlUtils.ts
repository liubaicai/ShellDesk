import { tCurrent } from '../../i18n';

export const defaultBrowserUrl = 'http://127.0.0.1/';
export const browserBlankUrl = 'about:blank';
export const browserStartAddress = '';
export const browserStartPageTitle = tCurrent('auto.remoteBrowser.z0eh12');
export const recentVisitLimit = 8;
export const browserStartPageCardLimit = 6;

export function canonicalizeBrowserUrl(value: string) {
  const url = value.trim();

  if (!url || /^about:blank$/i.test(url)) {
    return url ? 'about:blank' : defaultBrowserUrl;
  }

  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

export function normalizeLoopbackUrlHost(url: URL) {
  const host = url.hostname.toLowerCase();

  if (
    host === 'localhost' ||
    host === 'localhost.' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0:0:0:0:0:0:0:1' ||
    host === '[0:0:0:0:0:0:0:1]'
  ) {
    url.hostname = '127.0.0.1';
  }

  return url;
}

export function resolveBrowserUrl(value: string) {
  const url = value.trim();

  if (!url) {
    return defaultBrowserUrl;
  }

  if (/^about:blank$/i.test(url)) {
    return 'about:blank';
  }

  const schemeMatch = url.match(/^([a-z][a-z\d+.-]*):/i);
  const hasWebScheme = /^https?:/i.test(url);
  const isBareHostWithPort = /^[^/?#\s]+:\d+(?:[/?#]|$)/.test(url);

  if (schemeMatch && !hasWebScheme && !isBareHostWithPort) {
    return null;
  }

  try {
    const normalizedUrl = new URL(hasWebScheme ? url : `http://${url}`);

    if (normalizedUrl.protocol !== 'http:' && normalizedUrl.protocol !== 'https:') {
      return null;
    }

    return normalizeLoopbackUrlHost(normalizedUrl).toString();
  } catch {
    return null;
  }
}

export function normalizeBrowserUrl(value: string) {
  return resolveBrowserUrl(value) ?? defaultBrowserUrl;
}

export function isValidBrowserUrl(value: string) {
  return Boolean(resolveBrowserUrl(value));
}

export function extractOrigin(value: string) {
  const resolvedUrl = resolveBrowserUrl(value);

  if (!resolvedUrl || resolvedUrl === browserBlankUrl) {
    return null;
  }

  try {
    return new URL(resolvedUrl).origin;
  } catch {
    return null;
  }
}

export function isHttpsBrowserUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return /^https:\/\//i.test(value);
  }
}

export function isCertificateLoadError(detail: string, code?: number) {
  const signature = `${code ?? ''} ${detail}`.toUpperCase();
  return (typeof code === 'number' && code <= -200 && code > -300) || /CERT|TLS|SSL/.test(signature);
}

export function getUrlFromBrowserLoadErrorDetail(detail: string) {
  const match = detail.match(/\bhttps?:\/\/[^\s'"<>)]*/i);
  return match?.[0] ? canonicalizeBrowserUrl(match[0]) : null;
}

export function getBrowserTitle(url: string, title = '') {
  const nextTitle = title.trim();

  if (nextTitle) {
    return nextTitle;
  }

  if (url === 'about:blank') {
    return tCurrent('auto.remoteBrowser.1qhgtsv');
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname || parsedUrl.href;
  } catch {
    return url || tCurrent('auto.remoteBrowser.claw1h');
  }
}

export function areBrowserUrlsEquivalent(left: string, right: string) {
  return canonicalizeBrowserUrl(left) === canonicalizeBrowserUrl(right);
}
