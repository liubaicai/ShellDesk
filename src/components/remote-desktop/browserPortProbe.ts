import { tCurrent } from '../../i18n';

import type { BrowserBookmark, BrowserQuickTarget, BrowserStartPageCard, RemoteBrowserContext } from './browserTypes';
import { browserStartPageCardLimit, defaultBrowserUrl } from './browserUrlUtils';

const loopbackServiceTargets = [
  { label: tCurrent('auto.remoteBrowser.d4d2lo'), port: 3000 },
  { label: 'Vite', port: 5173 },
  { label: tCurrent('auto.remoteBrowser.gkha7'), port: 8000 },
  { label: tCurrent('auto.remoteBrowser.cit5ds'), port: 8080 },
  { label: tCurrent('auto.remoteBrowser.1rq6sfi'), port: 9000 },
] as const;

function getBrowserHostUrl(host: string, port?: number) {
  const value = host.trim() || '127.0.0.1';
  const urlHost = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
  return `http://${urlHost}${port && port !== 80 ? `:${port}` : ''}/`;
}

export function getBrowserQuickTargets(context: RemoteBrowserContext) {
  const targets: BrowserQuickTarget[] = [
    {
      id: 'loopback',
      label: '127.0.0.1',
      hint: tCurrent('auto.remoteBrowser.wsgx3b'),
      url: getBrowserHostUrl('127.0.0.1'),
    },
    {
      id: 'remote-host',
      label: context.address,
      hint: tCurrent('auto.remoteBrowser.10tjf3d'),
      url: getBrowserHostUrl(context.address),
    },
    ...loopbackServiceTargets.map((target) => ({
      id: `loopback-${target.port}`,
      label: `127.0.0.1:${target.port}`,
      hint: target.label,
      url: getBrowserHostUrl('127.0.0.1', target.port),
    })),
  ];
  const visitedTargets = new Set<string>();

  return targets.filter((target) => {
    if (visitedTargets.has(target.url)) {
      return false;
    }

    visitedTargets.add(target.url);
    return true;
  });
}

export function getBrowserStartPageCards(bookmarks: BrowserBookmark[]) {
  if (bookmarks.length) {
    return bookmarks.slice(0, browserStartPageCardLimit).map((bookmark): BrowserStartPageCard => ({
      id: bookmark.id,
      title: bookmark.title,
      subtitle: bookmark.url,
      url: bookmark.url,
    }));
  }

  return [
    {
      id: 'home-loopback',
      title: '127.0.0.1',
      subtitle: defaultBrowserUrl,
      url: defaultBrowserUrl,
    },
    ...loopbackServiceTargets.map((target) => {
      const url = getBrowserHostUrl('127.0.0.1', target.port);

      return {
        id: `home-loopback-${target.port}`,
        title: `127.0.0.1:${target.port}`,
        subtitle: target.label,
        url,
      };
    }),
  ].slice(0, browserStartPageCardLimit);
}

export function getBrowserStartCardProbePort(url: string) {
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname.toLowerCase();

    if (![
      '127.0.0.1',
      'localhost',
      'localhost.',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '[0:0:0:0:0:0:0:1]',
    ].includes(host)) {
      return null;
    }

    if (parsedUrl.port) {
      return Number(parsedUrl.port);
    }

    if (parsedUrl.protocol === 'http:') {
      return 80;
    }

    if (parsedUrl.protocol === 'https:') {
      return 443;
    }
  } catch {
    return null;
  }

  return null;
}

export function getBrowserStartProbePorts(cards: BrowserStartPageCard[]) {
  const ports = new Set<number>();

  for (const card of cards) {
    const port = getBrowserStartCardProbePort(card.url);

    if (port) {
      ports.add(port);
    }
  }

  return [...ports].sort((left, right) => left - right);
}

export function buildBrowserStartPortProbeCommand(ports: number[]) {
  const portArgs = ports
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
    .map((port) => String(port))
    .join(' ');

  if (!portArgs) {
    return 'exit 0';
  }

  return `
shelldesk_has_tcp_listener() {
  probe_port="$1"
  case "$probe_port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$probe_port" -lt 1 ] || [ "$probe_port" -gt 65535 ]; then
    return 1
  fi

  probe_hex=$(printf '%04X' "$probe_port" 2>/dev/null || true)
  if [ -n "$probe_hex" ]; then
    for probe_file in /proc/net/tcp /proc/net/tcp6; do
      if [ -r "$probe_file" ] && awk -v port="$probe_hex" '
        NR > 1 && $4 == "0A" {
          split($2, local, ":")
          if (toupper(local[2]) == port) found = 1
        }
        END { exit found ? 0 : 1 }
      ' "$probe_file" 2>/dev/null; then
        return 0
      fi
    done
  fi

  if command -v ss >/dev/null 2>&1; then
    if (ss -H -ltn 2>/dev/null || ss -ltn 2>/dev/null) | awk -v port="$probe_port" '
      /LISTEN/ {
        local_index = ($1 ~ /^(tcp|tcp6)$/) ? 5 : 4
        value = $local_index
        gsub(/^\\[/, "", value)
        n = split(value, parts, ":")
        endpoint_port = parts[n]
        gsub(/[^0-9].*$/, "", endpoint_port)
        if (endpoint_port == port) found = 1
      }
      END { exit found ? 0 : 1 }
    '; then
      return 0
    fi
  fi

  if command -v netstat >/dev/null 2>&1; then
    if (netstat -ltn 2>/dev/null || netstat -tnl 2>/dev/null) | awk -v port="$probe_port" '
      /^[Tt][Cc][Pp]/ && /LISTEN/ {
        n = split($4, parts, ":")
        endpoint_port = parts[n]
        gsub(/[^0-9].*$/, "", endpoint_port)
        if (endpoint_port == port) found = 1
      }
      END { exit found ? 0 : 1 }
    '; then
      return 0
    fi
  fi

  return 1
}

for port in ${portArgs}; do
  if shelldesk_has_tcp_listener "$port"; then
    printf 'OPEN\\t%s\\n' "$port"
  else
    printf 'CLOSED\\t%s\\n' "$port"
  fi
done
`;
}

export function getOpenPortsFromProbeOutput(output: string) {
  const openPorts = new Set<number>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^OPEN\t(\d{1,5})$/);

    if (!match) {
      continue;
    }

    const port = Number(match[1]);

    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      openPorts.add(port);
    }
  }

  return openPorts;
}

export const probeCommonPorts = buildBrowserStartPortProbeCommand;
export const detectRunningServices = getOpenPortsFromProbeOutput;
