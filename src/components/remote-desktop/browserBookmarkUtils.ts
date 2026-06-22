import { tCurrent } from '../../i18n';

import type { BrowserBookmark, BrowserRecentVisit } from './browserTypes';
import { getBrowserTitle, resolveBrowserUrl } from './browserUrlUtils';

const browserRecentPreferencePrefix = 'browser.recent.';
const browserBookmarkBarPreferencePrefix = 'browser.bookmark-bar.';

export function createBookmarkId() {
  if ('randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getBookmarkHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url.replace(/^https?:\/\//i, '').split('/')[0] || 'site';
  }
}

export function getBookmarkMonogram(title: string, url: string) {
  const source = title.trim() || getBookmarkHost(url);
  const match = source.match(/[A-Za-z0-9\u4e00-\u9fff]/u);
  return (match?.[0] || '•').toUpperCase();
}

export function getBookmarkAccent(url: string) {
  const host = getBookmarkHost(url);
  let hash = 0;

  for (const char of host) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 78% 62%)`;
}

export function isBrowserBookmark(value: unknown): value is BrowserBookmark {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const bookmark = value as Partial<BrowserBookmark>;
  return (
    typeof bookmark.id === 'string' &&
    typeof bookmark.title === 'string' &&
    typeof bookmark.url === 'string' &&
    typeof bookmark.createdAt === 'string' &&
    typeof bookmark.updatedAt === 'string'
  );
}

export function normalizeBookmarks(bookmarks: BrowserBookmark[]) {
  return bookmarks.flatMap((bookmark) => {
    const url = resolveBrowserUrl(bookmark.url);

    return url
      ? [{
          ...bookmark,
          title: bookmark.title.trim() || getBrowserTitle(url),
          url,
        }]
      : [];
  });
}

function isBrowserRecentVisit(value: unknown): value is BrowserRecentVisit {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const visit = value as Partial<BrowserRecentVisit>;
  return (
    typeof visit.url === 'string' &&
    typeof visit.title === 'string' &&
    typeof visit.visitedAt === 'string'
  );
}

function encodePreferenceScope(scope: string) {
  return encodeURIComponent(scope).replace(/[!'()*~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function getBrowserRecentPreferenceKey(scope: string) {
  return `${browserRecentPreferencePrefix}${encodePreferenceScope(scope)}`;
}

export async function readBrowserRecentVisits(scope: string, limit: number) {
  try {
    const storedVisits = await window.guiSSH?.preferences?.get(getBrowserRecentPreferenceKey(scope));

    if (!Array.isArray(storedVisits)) {
      return [];
    }

    return storedVisits.filter(isBrowserRecentVisit).flatMap((visit) => {
      const url = resolveBrowserUrl(visit.url);

      return url
        ? [{
            ...visit,
            url,
            title: visit.title.trim() || getBrowserTitle(url),
          }]
        : [];
    }).slice(0, limit);
  } catch {
    return [];
  }
}

export async function writeBrowserRecentVisits(scope: string, visits: BrowserRecentVisit[]) {
  await window.guiSSH?.preferences?.set(getBrowserRecentPreferenceKey(scope), visits).catch(() => undefined);
}

function getBrowserBookmarkBarPreferenceKey(scope: string) {
  return `${browserBookmarkBarPreferencePrefix}${encodePreferenceScope(scope)}`;
}

export async function readBrowserBookmarkBarOpen(scope: string) {
  try {
    return await window.guiSSH?.preferences?.get(getBrowserBookmarkBarPreferenceKey(scope)) === 'visible';
  } catch {
    return false;
  }
}

export async function writeBrowserBookmarkBarOpen(scope: string, isOpen: boolean) {
  await window.guiSSH?.preferences?.set(getBrowserBookmarkBarPreferenceKey(scope), isOpen ? 'visible' : 'hidden').catch(() => undefined);
}

export function getBrowserProtocolLabel(url: string) {
  if (/^https:\/\//i.test(url)) {
    return 'HTTPS';
  }

  if (/^http:\/\//i.test(url)) {
    return 'HTTP';
  }

  return tCurrent('auto.remoteBrowser.1qhgtsv2');
}
