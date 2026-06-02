import { powershellCommand, powershellSingleQuote } from './remoteSystem';
import { tCurrent } from '../../i18n';

export type FirewallBackend = 'ufw' | 'firewalld' | 'windows' | 'unknown';
export type FirewallAction = 'allow' | 'deny' | 'reject' | 'limit' | 'unknown';
export type FirewallProtocol = 'tcp' | 'udp' | 'any';

export interface FirewallRule {
  id: string;
  action: FirewallAction;
  protocol?: FirewallProtocol;
  port?: string;
  source?: string;
  target?: string;
  direction?: string;
  raw: string;
}

export interface FirewallSnapshot {
  backend: FirewallBackend;
  status: string;
  defaultPolicy: string;
  zone?: string;
  rules: FirewallRule[];
  rawOutput: string;
}

export interface FirewallRuleDraft {
  action: 'allow' | 'deny' | 'reject';
  protocol: FirewallProtocol;
  port: string;
  source: string;
}

const backendMarker = '__SHELLDESK_FIREWALL_BACKEND__';
const stateMarker = '__SHELLDESK_FIREWALL_STATE__';
const zoneMarker = '__SHELLDESK_FIREWALL_ZONE__';
const listMarker = '__SHELLDESK_FIREWALL_LIST__';
const ufwAddedMarker = '__SHELLDESK_UFW_ADDED__';

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }

  return '';
}

function toRecords(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : [value];
  return rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
}

function normalizeAction(value: string): FirewallAction {
  const normalized = value.trim().toLowerCase();

  if (/\b(?:accept|allow|allowed)\b/.test(normalized)) return 'allow';
  if (normalized === tCurrent('auto.firewallProviders.11bz44c')) return 'allow';
  if (normalized === 'deny' || normalized === 'block' || normalized === 'blocked' || normalized.includes(tCurrent('auto.firewallProviders.1qrntx4')) || normalized.includes(tCurrent('auto.firewallProviders.1xtyf8o'))) return 'deny';
  if (normalized === 'reject' || normalized.includes(tCurrent('auto.firewallProviders.1y9ly2h'))) return 'reject';
  if (normalized === 'limit' || normalized === 'limited' || normalized.includes(tCurrent('auto.firewallProviders.1d8panv')) || normalized.includes(tCurrent('auto.firewallProviders.11z7j5c'))) return 'limit';
  return 'unknown';
}

function normalizeProtocol(value?: string): FirewallProtocol | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (normalized === 'tcp' || normalized === 'udp') return normalized;
  if (normalized === 'any' || normalized === '*' || normalized === '') return 'any';
  return undefined;
}

function parsePortAndProtocol(value: string) {
  const trimmed = value.trim().replace(/\s+\(v6\)$/i, '');
  const match = trimmed.match(/^(.+?)\/(tcp|udp|any)$/i);

  if (!match) {
    return { port: trimmed || undefined, protocol: undefined };
  }

  return {
    port: match[1],
    protocol: normalizeProtocol(match[2]),
  };
}

function parseUfwStatusRuleLine(line: string, index: number): FirewallRule | null {
  if (
    !line
    || line.startsWith(backendMarker)
    || line.startsWith(ufwAddedMarker)
    || /^(?:Status|\u72b6\u6001):|^(?:Default|\u9ed8\u8ba4):|^(?:Logging|\u65e5\u5fd7):|^(?:New profiles|\u65b0\u914d\u7f6e\u6587\u4ef6):|^(?:To\s+Action\s+From|\u81f3\s+\u52a8\u4f5c\s+\u6765\u81ea)|^-+\s+-+\s+-+/i.test(line)
    || /^ERROR:|^sudo:|^WARN/i.test(line)
  ) {
    return null;
  }

  const numberedPrefix = line.match(/^\[\s*(\d+)\]\s*(.+)$/);
  const ruleNumber = numberedPrefix?.[1];
  const body = (numberedPrefix?.[2] ?? line).trim();
  const columns = body.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
  let targetText = '';
  let actionText = '';
  let directionText = '';
  let sourceText = '';

  if (columns.length >= 3) {
    targetText = columns[0];
    const actionParts = columns[1].split(/\s+/).filter(Boolean);
    actionText = actionParts[0] ?? '';
    directionText = actionParts.slice(1).join(' ');
    sourceText = columns.slice(2).join(' ');
  } else {
    const fallbackMatch = body.match(/^(.+?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?\s+(.+)$/i);

    if (!fallbackMatch) {
      return null;
    }

    targetText = fallbackMatch[1] ?? '';
    actionText = fallbackMatch[2] ?? '';
    directionText = fallbackMatch[3] ?? '';
    sourceText = fallbackMatch[4] ?? '';
  }

  const action = normalizeAction(actionText);

  if (action === 'unknown') {
    return null;
  }

  const parsed = parsePortAndProtocol(targetText);

  return {
    id: ruleNumber ? `ufw:${ruleNumber}` : `ufw:raw:${index}`,
    action,
    protocol: parsed.protocol,
    port: parsed.port,
    source: sourceText.trim() || undefined,
    target: targetText.trim() || undefined,
    direction: directionText.trim() || undefined,
    raw: line,
  };
}

function parseUfwAddedRuleLine(line: string, index: number): FirewallRule | null {
  const match = line.trim().match(/^ufw\s+(?:(route)\s+)?(allow|deny|reject|limit)\b\s*(.*)$/i);

  if (!match) {
    return null;
  }

  const routeText = match[1];
  const actionText = match[2] ?? '';
  const rest = (match[3] ?? '').replace(/\s+comment\s+(['"]).*?\1\s*$/i, '').trim();
  const sourceMatch = rest.match(/\bfrom\s+(.+?)(?=\s+\bto\b|\s+\bport\b|\s+\bproto\b|$)/i);
  const targetMatch = rest.match(/\bto\s+(.+?)(?=\s+\bport\b|\s+\bproto\b|$)/i);
  const portMatch = rest.match(/\bport\s+([^\s]+)(?:\s*\/\s*(tcp|udp|any))?/i);
  const protoMatch = rest.match(/\bproto\s+(tcp|udp|any)\b/i);
  const directionMatch = rest.match(/\b(in|out)\b/i);
  const directTarget = !/\b(from|to|port|proto|in|out|on)\b/i.test(rest)
    ? rest.trim()
    : rest
      .replace(/\bfrom\s+.+?(?=\s+\bto\b|\s+\bport\b|\s+\bproto\b|$)/i, ' ')
      .replace(/\bto\s+.+?(?=\s+\bport\b|\s+\bproto\b|$)/i, ' ')
      .replace(/\bport\s+[^\s]+(?:\s*\/\s*(?:tcp|udp|any))?/i, ' ')
      .replace(/\bproto\s+(?:tcp|udp|any)\b/i, ' ')
      .replace(/\b(?:in|out)\b(?:\s+on\s+\S+)?/ig, ' ')
      .replace(/\bon\s+\S+/ig, ' ')
      .trim()
      .split(/\s+/)[0] ?? '';
  const parsed = parsePortAndProtocol(portMatch?.[1] ?? directTarget);
  const protocol = normalizeProtocol(protoMatch?.[1] ?? portMatch?.[2]) ?? parsed.protocol;

  return {
    id: `ufw:added:${index}`,
    action: normalizeAction(actionText),
    protocol,
    port: parsed.port,
    source: sourceMatch?.[1]?.trim() || undefined,
    target: targetMatch?.[1]?.trim() || directTarget || undefined,
    direction: routeText ? 'route' : directionMatch?.[1]?.toUpperCase(),
    raw: line,
  };
}

function parseUfwRules(stdout: string): FirewallRule[] {
  const statusLines: string[] = [];
  const addedLines: string[] = [];
  let inAddedSection = false;

  stdout.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      return;
    }

    if (line.startsWith(ufwAddedMarker)) {
      inAddedSection = true;
      return;
    }

    if (inAddedSection) {
      addedLines.push(line);
    } else {
      statusLines.push(line);
    }
  });

  const statusRules = statusLines
    .map(parseUfwStatusRuleLine)
    .filter((rule): rule is FirewallRule => Boolean(rule));

  if (statusRules.length) {
    return statusRules;
  }

  return addedLines
    .map(parseUfwAddedRuleLine)
    .filter((rule): rule is FirewallRule => Boolean(rule));
}

function parseFirewalldRules(stdout: string): FirewallRule[] {
  const rules: FirewallRule[] = [];
  const portsLine = stdout.split(/\r?\n/).find((line) => /^\s*ports:\s*/i.test(line));
  const servicesLine = stdout.split(/\r?\n/).find((line) => /^\s*services:\s*/i.test(line));
  const richRules = stdout.split(/\r?\n/).filter((line) => /^\s*rule\s+/i.test(line.trim()));

  const portsText = portsLine?.replace(/^\s*ports:\s*/i, '').trim() ?? '';
  portsText.split(/\s+/).filter(Boolean).forEach((portText, index) => {
    const parsed = parsePortAndProtocol(portText);
    rules.push({
      id: `firewalld:port:${portText}:${index}`,
      action: 'allow',
      protocol: parsed.protocol,
      port: parsed.port,
      target: portText,
      raw: portText,
    });
  });

  const servicesText = servicesLine?.replace(/^\s*services:\s*/i, '').trim() ?? '';
  servicesText.split(/\s+/).filter(Boolean).forEach((service, index) => {
    rules.push({
      id: `firewalld:service:${service}:${index}`,
      action: 'allow',
      target: service,
      raw: `service ${service}`,
    });
  });

  richRules.forEach((line, index) => {
    rules.push({
      id: `firewalld:rich:${index}`,
      action: normalizeAction(line),
      raw: line.trim(),
    });
  });

  return rules;
}

function parseWindowsSnapshot(stdout: string, stderr: string): FirewallSnapshot {
  const parsed = JSON.parse(stdout.trim() || '{}') as Record<string, unknown>;
  const profiles = toRecords(parsed.profiles);
  const enabledProfiles = profiles.filter((profile) => /true/i.test(readString(profile, 'Enabled')));
  const profileLabel = profiles.map((profile) => {
    const name = readString(profile, 'Name') || 'Profile';
    const enabled = /true/i.test(readString(profile, 'Enabled')) ? tCurrent('auto.firewallProviders.5pm2ma') : tCurrent('auto.firewallProviders.g0fanx');
    const inbound = readString(profile, 'DefaultInboundAction') || '-';
    const outbound = readString(profile, 'DefaultOutboundAction') || '-';
    return tCurrent('auto.firewallProviders.tqupfg', { value0: name, value1: enabled, value2: inbound, value3: outbound });
  }).join('\n');
  const rules = toRecords(parsed.rules).map<FirewallRule>((record, index) => {
    const name = readString(record, 'Name') || `rule-${index}`;
    const displayName = readString(record, 'DisplayName') || name;
    const protocol = normalizeProtocol(readString(record, 'Protocol'));
    const port = readString(record, 'LocalPort') || undefined;
    const source = readString(record, 'RemoteAddress') || undefined;
    const action = normalizeAction(readString(record, 'Action'));
    const direction = readString(record, 'Direction') || undefined;

    return {
      id: `windows:${name}`,
      action,
      protocol,
      port,
      source,
      target: displayName,
      direction,
      raw: [displayName, direction, action, protocol, port, source].filter(Boolean).join(' | '),
    };
  });

  return {
    backend: 'windows',
    status: enabledProfiles.length ? tCurrent('auto.firewallProviders.187exb8', { value0: enabledProfiles.length, value1: profiles.length }) : tCurrent('auto.firewallProviders.1tylsuy'),
    defaultPolicy: profileLabel || tCurrent('auto.firewallProviders.1b8epgj'),
    rules,
    rawOutput: [stdout, stderr].filter(Boolean).join('\n'),
  };
}

export function createFirewallStatusCommand(isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
$profiles = Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction
$rules = Get-NetFirewallRule -PolicyStore ActiveStore -Enabled True -ErrorAction SilentlyContinue | Select-Object -First 800 | ForEach-Object {
  $portFilter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $_ -ErrorAction SilentlyContinue | Select-Object -First 1
  $addressFilter = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $_ -ErrorAction SilentlyContinue | Select-Object -First 1
  [pscustomobject]@{
    Name = [string]$_.Name
    DisplayName = [string]$_.DisplayName
    Direction = [string]$_.Direction
    Action = [string]$_.Action
    Protocol = if ($portFilter) { [string]$portFilter.Protocol } else { "Any" }
    LocalPort = if ($portFilter) { [string]$portFilter.LocalPort } else { "" }
    RemoteAddress = if ($addressFilter) { [string]$addressFilter.RemoteAddress } else { "" }
  }
}
[pscustomobject]@{ profiles = @($profiles); rules = @($rules) } | ConvertTo-Json -Depth 6 -Compress
`);
  }

  return tCurrent('auto.firewallProviders.15x6sol', { value0: backendMarker, value1: ufwAddedMarker, value2: backendMarker, value3: stateMarker, value4: zoneMarker, value5: listMarker, value6: backendMarker });
}

export function parseFirewallSnapshot(stdout: string, stderr: string, isWindowsHost: boolean): FirewallSnapshot {
  if (isWindowsHost) {
    return parseWindowsSnapshot(stdout, stderr);
  }

  const backendLine = stdout.split(/\r?\n/).find((line) => line.startsWith(backendMarker));
  const backend = (backendLine?.split('\t')[1] as FirewallBackend | undefined) ?? 'unknown';
  const rawOutput = [stdout, stderr].filter(Boolean).join('\n');

  if (backend === 'ufw') {
    const status = stdout.match(/^(?:Status|\u72b6\u6001):\s*(.+)$/im)?.[1]?.trim() ?? tCurrent('auto.firewallProviders.1lpnuh4');
    const defaultPolicy = stdout.match(/^(?:Default|\u9ed8\u8ba4):\s*(.+)$/im)?.[1]?.trim() ?? tCurrent('auto.firewallProviders.18nunr9');

    return {
      backend,
      status,
      defaultPolicy,
      rules: parseUfwRules(stdout),
      rawOutput,
    };
  }

  if (backend === 'firewalld') {
    const zone = stdout.match(new RegExp(`^${zoneMarker}\\t(.+)$`, 'm'))?.[1]?.trim() || 'public';
    const stateMatch = stdout.match(new RegExp(`${stateMarker}\\r?\\n([^\\r\\n]+)`, 'm'));
    const status = stateMatch?.[1]?.trim() || tCurrent('auto.firewallProviders.1lpnuh42');
    const target = stdout.match(/^\s*target:\s*(.+)$/im)?.[1]?.trim();

    return {
      backend,
      status,
      defaultPolicy: `zone ${zone}${target ? `, target ${target}` : ''}`,
      zone,
      rules: parseFirewalldRules(stdout),
      rawOutput,
    };
  }

  return {
    backend: 'unknown',
    status: tCurrent('auto.firewallProviders.1lahc0a'),
    defaultPolicy: tCurrent('auto.firewallProviders.1fud4zn'),
    rules: [],
    rawOutput,
  };
}

export function validateFirewallDraft(draft: FirewallRuleDraft, backend: FirewallBackend) {
  const port = draft.port.trim();
  const source = draft.source.trim();
  const portMatch = port.match(/^(\d{1,5})(?:[:-](\d{1,5}))?$/);

  if (!portMatch) {
    throw new Error(tCurrent('auto.firewallProviders.f1rgcm'));
  }

  const startPort = Number.parseInt(portMatch[1], 10);
  const endPort = portMatch[2] ? Number.parseInt(portMatch[2], 10) : startPort;

  if (startPort < 1 || endPort > 65535 || startPort > endPort) {
    throw new Error(tCurrent('auto.firewallProviders.yk8200'));
  }

  if (source && source.length > 120) {
    throw new Error(tCurrent('auto.firewallProviders.1t92on8'));
  }

  if (source && /[\r\n;&|`$<>]/.test(source)) {
    throw new Error(tCurrent('auto.firewallProviders.10qam7f'));
  }

  if (backend === 'firewalld' && draft.action !== 'allow') {
    throw new Error(tCurrent('auto.firewallProviders.1g52l0r'));
  }
}

export function isRiskyFirewallDraft(draft: FirewallRuleDraft) {
  const port = draft.port.trim();
  const source = draft.source.trim();
  const riskyPorts = new Set(['22', '3389', '3306', '5432', '6379', '9200', '9300', '11211', '27017']);
  const openSource = !source || source === '0.0.0.0/0' || /^any(where)?$/i.test(source);

  return openSource || riskyPorts.has(port);
}

function parsePortRange(value?: string) {
  const normalized = String(value ?? '').trim().toLowerCase()
    .replace(/\s+\(v6\)$/i, '')
    .replace(/\/(?:tcp|udp|any)$/i, '')
    .replace(':', '-');
  const match = normalized.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);

  if (!match) {
    return null;
  }

  const start = Number.parseInt(match[1], 10);
  const end = match[2] ? Number.parseInt(match[2], 10) : start;

  if (start < 1 || end > 65535 || start > end) {
    return null;
  }

  return { start, end };
}

function portMatches(value: string | undefined, port: number) {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (!normalized) {
    return false;
  }

  if ((normalized === 'ssh' || normalized === 'openssh') && port === 22) {
    return true;
  }

  const range = parsePortRange(normalized);
  return Boolean(range && port >= range.start && port <= range.end);
}

function rawRuleMatchesSshPort(raw: string, port: number) {
  const normalized = raw.toLowerCase();

  if (port === 22 && /\bservice\s+(?:name=)?["']?(?:ssh|openssh)(?:["']|\b)/.test(normalized)) {
    return true;
  }

  const portMatch = normalized.match(/\bport\s+(?:port=)?["']?(\d{1,5}(?:[-:]\d{1,5})?)["']?/);
  return portMatches(portMatch?.[1], port);
}

function defaultPolicyAllowsInbound(snapshot: FirewallSnapshot) {
  const policy = snapshot.defaultPolicy.toLowerCase();

  if (snapshot.backend === 'ufw') {
    return /allow\s*\([^)]*incoming|incoming[^,;]*allow|\u5141\u8bb8[^,;]*(?:\u5165\u7ad9|\u8fdb\u5165)|(?:\u5165\u7ad9|\u8fdb\u5165)[^,;]*\u5141\u8bb8/i.test(snapshot.defaultPolicy);
  }

  if (snapshot.backend === 'firewalld') {
    return /\btarget\s+accept\b/i.test(policy);
  }

  return false;
}

export function isFirewallEnabled(snapshot: FirewallSnapshot) {
  const status = snapshot.status.trim().toLowerCase();

  if (snapshot.backend === 'ufw') {
    if (/^(?:inactive|disabled|not\s+active|not\s+enabled)\b/.test(status) || /\u4e0d\u6d3b\u52a8|\u672a\u542f\u7528|\u505c\u7528|\u5173\u95ed/.test(status)) {
      return false;
    }

    return /^(?:active|enabled)\b/.test(status) || /\b(?:active|enabled)\b/.test(status) || /\u6d3b\u52a8|\u5df2\u542f\u7528|\u542f\u7528\u4e2d/.test(status);
  }

  if (snapshot.backend === 'firewalld') {
    if (/\bnot\s+running\b|inactive|dead|stopped|\u672a\u8fd0\u884c|\u505c\u6b62|\u505c\u7528|\u5173\u95ed/.test(status)) {
      return false;
    }

    return /^running\b/.test(status) || /\brunning\b/.test(status) || /\u8fd0\u884c\u4e2d|\u5df2\u8fd0\u884c/.test(status);
  }

  return false;
}

export function isFirewallSshPortAllowed(snapshot: FirewallSnapshot, sshPort: number) {
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    return false;
  }

  if (defaultPolicyAllowsInbound(snapshot)) {
    return true;
  }

  return snapshot.rules.some((rule) => {
    if (rule.action !== 'allow' && rule.action !== 'limit') {
      return false;
    }

    if (rule.protocol && rule.protocol !== 'tcp' && rule.protocol !== 'any') {
      return false;
    }

    return portMatches(rule.port, sshPort)
      || portMatches(rule.target, sshPort)
      || rawRuleMatchesSshPort(rule.raw, sshPort);
  });
}

export function createFirewallAddRuleCommand(backend: FirewallBackend, draft: FirewallRuleDraft, zone?: string) {
  validateFirewallDraft(draft, backend);
  const port = draft.port.trim().replace(':', '-');
  const source = draft.source.trim();
  const protocol = draft.protocol === 'any' ? 'tcp' : draft.protocol;

  if (backend === 'ufw') {
    const protoSuffix = draft.protocol === 'any' ? '' : ` proto ${draft.protocol}`;
    const sourcePart = source && !/^any(where)?$/i.test(source) ? `from ${shellSingleQuote(source)} to any port ${shellSingleQuote(port)}${protoSuffix}` : `${shellSingleQuote(`${port}/${protocol}`)}`;
    const actionPart = draft.action === 'deny' || draft.action === 'reject'
      ? `prepend ${draft.action}`
      : draft.action;
    return `sudo -n ufw ${actionPart} ${sourcePart}`;
  }

  if (backend === 'firewalld') {
    const targetZone = zone || 'public';
    return `sudo -n firewall-cmd --zone=${shellSingleQuote(targetZone)} --add-port=${shellSingleQuote(`${port}/${protocol}`)} --permanent && sudo -n firewall-cmd --reload`;
  }

  if (backend === 'windows') {
    const action = draft.action === 'allow' ? 'Allow' : 'Block';
    const remoteAddress = source && !/^any(where)?$/i.test(source) ? source : 'Any';
    return powershellCommand(`
New-NetFirewallRule -DisplayName ${powershellSingleQuote(`ShellDesk ${draft.action} ${protocol} ${port}`)} -Direction Inbound -Action ${action} -Protocol ${protocol.toUpperCase()} -LocalPort ${powershellSingleQuote(port)} -RemoteAddress ${powershellSingleQuote(remoteAddress)}
`);
  }

  throw new Error(tCurrent('auto.firewallProviders.1rn2uot'));
}

function normalizeUfwAddress(value?: string) {
  return String(value ?? '').trim().replace(/\s+\(v6\)$/i, '');
}

function isUfwAnyAddress(value?: string) {
  const normalized = normalizeUfwAddress(value).toLowerCase();
  return !normalized || normalized === 'any' || normalized === 'anywhere' || normalized === '0.0.0.0/0' || normalized === '::/0';
}

function getUfwActionToken(action: FirewallAction) {
  if (action === 'allow' || action === 'deny' || action === 'reject' || action === 'limit') {
    return action;
  }

  throw new Error(tCurrent('auto.firewallProviders.9xeh6g'));
}

function isUfwPortTarget(target: string, port?: string, protocol?: FirewallProtocol) {
  const normalizedTarget = normalizeUfwAddress(target);
  const normalizedPort = String(port ?? '').trim();

  if (!normalizedTarget || !normalizedPort) {
    return false;
  }

  return normalizedTarget === normalizedPort || normalizedTarget === `${normalizedPort}/${protocol ?? ''}`;
}

function createUfwRuleDeleteSpec(rule: FirewallRule) {
  const action = getUfwActionToken(rule.action);
  const parts = [];
  const direction = String(rule.direction ?? '').trim().toLowerCase();
  const source = normalizeUfwAddress(rule.source);
  const target = normalizeUfwAddress(rule.target);
  const port = String(rule.port ?? '').trim();
  const protocol = rule.protocol && rule.protocol !== 'any' ? rule.protocol : '';

  if (direction === 'route') {
    parts.push('route');
  }

  parts.push(action);

  if (!isUfwAnyAddress(source)) {
    const destination = target && !isUfwPortTarget(target, port, rule.protocol) ? target : 'any';
    parts.push('from', shellSingleQuote(source), 'to', shellSingleQuote(destination));

    if (port) {
      parts.push('port', shellSingleQuote(port));
    }

    if (protocol) {
      parts.push('proto', protocol);
    }

    return parts.join(' ');
  }

  if (port) {
    parts.push(shellSingleQuote(`${port}${protocol ? `/${protocol}` : ''}`));
    return parts.join(' ');
  }

  if (target) {
    parts.push(shellSingleQuote(target));
    return parts.join(' ');
  }

  throw new Error(tCurrent('auto.firewallProviders.1mb7mx6'));
}

export function createFirewallDeleteRuleCommand(backend: FirewallBackend, rule: FirewallRule, zone?: string) {
  if (backend === 'ufw') {
    const number = rule.id.match(/^ufw:(\d+)$/)?.[1];

    return number
      ? `sudo -n ufw --force delete ${number}`
      : `sudo -n ufw --force delete ${createUfwRuleDeleteSpec(rule)}`;
  }

  if (backend === 'firewalld') {
    if (!rule.port || !rule.protocol || rule.protocol === 'any') {
      throw new Error(tCurrent('auto.firewallProviders.9rw9yr'));
    }

    const targetZone = zone || 'public';
    return `sudo -n firewall-cmd --zone=${shellSingleQuote(targetZone)} --remove-port=${shellSingleQuote(`${rule.port}/${rule.protocol}`)} --permanent && sudo -n firewall-cmd --reload`;
  }

  if (backend === 'windows') {
    const name = rule.id.replace(/^windows:/, '');
    return powershellCommand(`Remove-NetFirewallRule -Name ${powershellSingleQuote(name)}`);
  }

  throw new Error(tCurrent('auto.firewallProviders.1rn2uot2'));
}

export function createFirewallReloadCommand(backend: FirewallBackend) {
  if (backend === 'ufw') return 'sudo -n ufw reload';
  if (backend === 'firewalld') return 'sudo -n firewall-cmd --reload';
  if (backend === 'windows') return powershellCommand('Get-NetFirewallProfile | Format-Table -AutoSize | Out-String');
  throw new Error(tCurrent('auto.firewallProviders.vl06p0'));
}

export function createFirewallSetEnabledCommand(backend: FirewallBackend, enabled: boolean) {
  if (backend === 'ufw') {
    return enabled ? 'sudo -n ufw --force enable' : 'sudo -n ufw disable';
  }

  if (backend === 'firewalld') {
    return enabled
      ? tCurrent('auto.firewallProviders.rizhvl')
      : tCurrent('auto.firewallProviders.zbzxdl');
  }

  throw new Error(tCurrent('auto.firewallProviders.1w7t573'));
}

export function getFirewallBackendLabel(backend: FirewallBackend) {
  if (backend === 'ufw') return 'ufw';
  if (backend === 'firewalld') return 'firewalld';
  if (backend === 'windows') return 'Windows Firewall';
  return tCurrent('auto.firewallProviders.1oczu7y');
}
