import { type RefObject } from 'react';

import { tCurrent } from '../../i18n';

import BrowserQuickStart from './BrowserQuickStart';
import type { BrowserLoadErrorState, BrowserPortStatus, BrowserStartPageCard } from './browserTypes';
import { getBrowserErrorDiagnosis } from './browserErrorUtils';
import { isHttpsBrowserUrl } from './browserUrlUtils';

interface BrowserViewportProps {
  isLoading: boolean;
  showStartPage: boolean;
  startPageCards: BrowserStartPageCard[];
  startPagePortStatus: BrowserPortStatus;
  browserFrameKey: number;
  browserSrc: string;
  pageTitle: string;
  browserAddress: string;
  loadError: BrowserLoadErrorState | null;
  isTrustingCertificate: boolean;
  browserViewRef: RefObject<HTMLIFrameElement | null>;
  onNavigate: (url: string) => void;
  onTrustCertificate: (url: string) => void;
  onClearErrorAndOpenQuickPanel: () => void;
}

function BrowserViewport({
  isLoading,
  showStartPage,
  startPageCards,
  startPagePortStatus,
  browserFrameKey,
  browserSrc,
  pageTitle,
  browserAddress,
  loadError,
  isTrustingCertificate,
  browserViewRef,
  onNavigate,
  onTrustCertificate,
  onClearErrorAndOpenQuickPanel,
}: BrowserViewportProps) {
  const errorDiagnosis = loadError ? getBrowserErrorDiagnosis(loadError) : null;

  return (
    <div className={`browser-viewport ${isLoading ? 'loading' : ''} ${showStartPage ? 'start' : ''}`}>
      <div className={`browser-progress ${isLoading ? 'visible' : ''}`} aria-hidden="true" />
      {showStartPage ? (
        <BrowserQuickStart services={startPageCards} portStatus={startPagePortStatus} onNavigate={onNavigate} />
      ) : null}
      <iframe
        key={browserFrameKey}
        ref={(element) => {
          browserViewRef.current = element;
        }}
        className={`remote-webview ${showStartPage ? 'hidden' : ''}`}
        src={browserSrc}
        title={pageTitle || browserAddress || tCurrent('auto.remoteBrowser.1vu0k2a')}
      />
      {loadError && errorDiagnosis ? (
        <section className="browser-error-page" role="alert" aria-live="polite">
          <div>
            <span>{errorDiagnosis.title}</span>
            <strong>{errorDiagnosis.summary}</strong>
            <code>{loadError.url || browserAddress}</code>
            <p>{loadError.detail}{typeof loadError.code === 'number' ? ` (${loadError.code})` : ''}</p>
            <ul>
              {errorDiagnosis.checks.map((check) => <li key={check}>{check}</li>)}
            </ul>
            <footer>
              {loadError.kind === 'certificate' && isHttpsBrowserUrl(loadError.url) ? (
                <button
                  type="button"
                  className="browser-warning-action"
                  disabled={isTrustingCertificate}
                  onClick={() => onTrustCertificate(loadError.url)}
                >
                  {isTrustingCertificate ? tCurrent('auto.remoteBrowser.avwp1u') : tCurrent('auto.remoteBrowser.qmibsc')}
                </button>
              ) : null}
              {loadError.kind === 'load' ? (
                <button type="button" onClick={() => onNavigate(loadError.url)}>
                  {tCurrent('auto.remoteBrowser.1ghz5wv')}</button>
              ) : null}
              <button
                type="button"
                onClick={onClearErrorAndOpenQuickPanel}
              >
                {tCurrent('auto.remoteBrowser.1pb3g2r')}</button>
            </footer>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export default BrowserViewport;
