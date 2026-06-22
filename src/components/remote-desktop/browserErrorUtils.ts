import { tCurrent } from '../../i18n';

import type { BrowserLoadErrorState } from './browserTypes';

export function getBrowserErrorDiagnosis(error: BrowserLoadErrorState) {
  if (error.kind === 'protocol') {
    return {
      title: tCurrent('auto.remoteBrowser.ofpb6e'),
      summary: tCurrent('auto.remoteBrowser.1uevwwr'),
      checks: [
        tCurrent('auto.remoteBrowser.13gh3cf'),
        tCurrent('auto.remoteBrowser.17oz1qm'),
      ],
    };
  }

  const signature = `${error.code ?? ''} ${error.detail}`.toUpperCase();

  if (error.kind === 'certificate' || /CERT|TLS|SSL|-20\d/.test(signature)) {
    return {
      title: tCurrent('auto.remoteBrowser.jw3yrd'),
      summary: tCurrent('auto.remoteBrowser.1r6zh40'),
      checks: [
        tCurrent('auto.remoteBrowser.qq5fwr'),
        tCurrent('auto.remoteBrowser.kl9k0o'),
      ],
    };
  }

  if (/NAME_NOT_RESOLVED|DNS|-105/.test(signature)) {
    return {
      title: tCurrent('auto.remoteBrowser.nvg62g'),
      summary: tCurrent('auto.remoteBrowser.k7fs4q'),
      checks: [
        tCurrent('auto.remoteBrowser.pzfcp0'),
        tCurrent('auto.remoteBrowser.121kr7a'),
      ],
    };
  }

  if (/CONNECTION_REFUSED|-102/.test(signature)) {
    return {
      title: tCurrent('auto.remoteBrowser.47kn08'),
      summary: tCurrent('auto.remoteBrowser.27vgqw'),
      checks: [
        tCurrent('auto.remoteBrowser.5ds2z1'),
        tCurrent('auto.remoteBrowser.1hpemmt'),
      ],
    };
  }

  if (/PROXY|SOCKS|TUNNEL|SOCKET_NOT_CONNECTED|-130|-111|-15/.test(signature)) {
    return {
      title: tCurrent('auto.remoteBrowser.9i6mad'),
      summary: tCurrent('auto.remoteBrowser.1jz0kpf'),
      checks: [
        tCurrent('auto.remoteBrowser.hsfk2p'),
        tCurrent('auto.remoteBrowser.1xwz4ng'),
      ],
    };
  }

  return {
    title: tCurrent('auto.remoteBrowser.dte5kz'),
    summary: tCurrent('auto.remoteBrowser.13bp659'),
    checks: [
      tCurrent('auto.remoteBrowser.12ri9mw'),
      tCurrent('auto.remoteBrowser.1ittmnw'),
    ],
  };
}
