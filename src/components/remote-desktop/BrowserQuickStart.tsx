import { tCurrent } from '../../i18n';

import BrowserIcon from './BrowserIcon';
import type { BrowserPortStatus, BrowserStartPageCard } from './browserTypes';
import { getBrowserStartCardProbePort } from './browserPortProbe';

function getBrowserStartCardMeta(url: string) {
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname.replace(/^www\./i, '');

    if (host === '127.0.0.1') {
      return parsedUrl.port ? `PORT ${parsedUrl.port}` : 'LOOPBACK';
    }

    return parsedUrl.port ? `${host}:${parsedUrl.port}` : host;
  } catch {
    return 'BOOKMARK';
  }
}

interface BrowserQuickStartProps {
  services: BrowserStartPageCard[];
  portStatus: BrowserPortStatus;
  onNavigate: (url: string) => void;
}

function BrowserQuickStart({ services, portStatus, onNavigate }: BrowserQuickStartProps) {
  return (
    <section className="browser-start-page" aria-label={tCurrent('auto.remoteBrowser.sy7nhr')}>
      <div className="browser-start-grid">
        {services.map((card) => {
          const probePort = getBrowserStartCardProbePort(card.url);
          const isOpen = Boolean(probePort && portStatus[probePort] === 'open');

          return (
            <button
              key={card.id}
              type="button"
              className={`browser-start-card ${isOpen ? 'open' : ''}`}
              title={card.url}
              onClick={() => onNavigate(card.url)}
            >
              <span className="browser-start-card-top">
                <span className="browser-start-card-meta">
                  <span className="browser-start-card-dot" aria-hidden="true" />
                  {getBrowserStartCardMeta(card.url)}
                </span>
                <span className="browser-start-card-arrow" aria-hidden="true">
                  <BrowserIcon name="go" />
                </span>
              </span>
              <strong>{card.title}</strong>
              <small>{card.subtitle}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default BrowserQuickStart;
