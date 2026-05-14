import { type FormEvent, useRef, useState } from 'react';

interface RemoteBrowserProps {
  partition: string;
}

function normalizeBrowserUrl(value: string) {
  const url = value.trim();

  if (!url) {
    return 'http://127.0.0.1';
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `http://${url}`;
}

function RemoteBrowser({ partition }: RemoteBrowserProps) {
  const [browserAddress, setBrowserAddress] = useState('http://127.0.0.1');
  const [browserSrc, setBrowserSrc] = useState('http://127.0.0.1');
  const browserViewRef = useRef<HTMLElement | null>(null);

  const submitBrowserAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextUrl = normalizeBrowserUrl(browserAddress);
    setBrowserAddress(nextUrl);
    setBrowserSrc(nextUrl);
  };

  const navigateWebview = (action: 'back' | 'forward' | 'reload') => {
    const webview = browserViewRef.current as (HTMLElement & {
      goBack?: () => void;
      goForward?: () => void;
      reload?: () => void;
    }) | null;

    if (action === 'back') {
      webview?.goBack?.();
    } else if (action === 'forward') {
      webview?.goForward?.();
    } else {
      webview?.reload?.();
    }
  };

  return (
    <div className="remote-browser-pane">
      <form className="browser-toolbar" onSubmit={submitBrowserAddress}>
        <button type="button" onClick={() => navigateWebview('back')}>‹</button>
        <button type="button" onClick={() => navigateWebview('forward')}>›</button>
        <button type="button" onClick={() => navigateWebview('reload')}>刷新</button>
        <input
          value={browserAddress}
          onChange={(event) => setBrowserAddress(event.target.value)}
          placeholder="127.0.0.1 / 10.0.0.12:8080 / https://example.com"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button type="submit">打开</button>
      </form>
      <div className="proxy-note">此浏览器使用 SSH SOCKS5 隧道；127.0.0.1、localhost 和局域网 IP 都从目标服务器侧访问。</div>
      <webview
        ref={browserViewRef}
        className="remote-webview"
        partition={partition}
        src={browserSrc}
      />
    </div>
  );
}

export default RemoteBrowser;
