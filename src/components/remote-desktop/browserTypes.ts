export interface RemoteBrowserContext {
  name: string;
  address: string;
  port: number;
  username: string;
  proxyPort: number;
}

export interface RemoteBrowserProps {
  connectionId: string;
  partition: string;
  bookmarkScope: string;
  context: RemoteBrowserContext;
  initialUrl?: string;
  onChromeChange?: (payload: { title: string; status: string; tone: 'idle' | 'loading' | 'error' }) => void;
}

export interface BrowserBookmark {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuickStartService {
  id: string;
  title: string;
  subtitle: string;
  url: string;
}

export interface BrowserNavigationState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

export interface BrowserBookmarkDraft {
  id: string | null;
  title: string;
  url: string;
}

export interface BrowserBookmarkMenuState {
  bookmarkId: string;
  x: number;
  y: number;
}

export interface BrowserToolbarMenuState {
  x: number;
  y: number;
}

export interface BrowserRecentVisit {
  url: string;
  title: string;
  visitedAt: string;
}

export interface BrowserLoadErrorState {
  kind: 'load' | 'protocol' | 'certificate';
  url: string;
  detail: string;
  code?: number;
}

export interface BrowserQuickTarget {
  id: string;
  label: string;
  hint: string;
  url: string;
}

export type BrowserStartPageCard = QuickStartService;
export type BrowserPortStatus = Record<number, 'unknown' | 'open' | 'closed'>;

export type BrowserIconName =
  | 'arrow-left'
  | 'arrow-right'
  | 'clock'
  | 'go'
  | 'home'
  | 'more'
  | 'panel'
  | 'reload'
  | 'route'
  | 'shield'
  | 'star'
  | 'stop';
