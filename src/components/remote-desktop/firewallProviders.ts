import { powershellCommand, powershellSingleQuote } from './remoteSystem';

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

  if (normalized === 'allow' || normalized === 'allowed') return 'allow';
  if (normalized === 'deny' || normalized === 'block' || normalized === 'blocked') return 'deny';
  if (normalized === 'reject') return 'reject';
  if (normalized === 'limit' || normalized === 'limited') return 'limit';
  return 'unknown';
}

function normalizeProtocol(value?: string): FirewallProtocol | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (normalized === 'tcp' || normalized === 'udp') return normalized;
  if (normalized === 'any' || normalized === '*' || normalized === '') return 'any';
  return undefined;
}

function parsePortAndProtocol(value: string) {
  const trimmed = value.trim();
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
    || /^Status:|^Default:|^Logging:|^New profiles:|^To\s+Action\s+From|^-+\s+-+\s+-+/i.test(line)
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
    const enabled = /true/i.test(readString(profile, 'Enabled')) ? '启用' : '关闭';
    const inbound = readString(profile, 'DefaultInboundAction') || '-';
    const outbound = readString(profile, 'DefaultOutboundAction') || '-';
    return `${name}: ${enabled}, 入站 ${inbound}, 出站 ${outbound}`;
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
    status: enabledProfiles.length ? `已启用 ${enabledProfiles.length}/${profiles.length} 个配置文件` : '未启用',
    defaultPolicy: profileLabel || '未读取到配置文件策略',
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

  return `
if command -v ufw >/dev/null 2>&1; then
  printf '${backendMarker}\\tufw\\n'
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n ufw status numbered verbose 2>/dev/null || sudo -n ufw status numbered 2>/dev/null || sudo -n ufw status verbose 2>/dev/null || sudo -n ufw status 2>/dev/null
  else
    ufw status numbered verbose 2>/dev/null || ufw status numbered 2>/dev/null || ufw status verbose 2>/dev/null || ufw status 2>/dev/null
  fi
  printf '${ufwAddedMarker}\\n'
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n ufw show added 2>/dev/null || true
  else
    ufw show added 2>/dev/null || true
  fi
  exit 0
fi
if command -v firewall-cmd >/dev/null 2>&1; then
  printf '${backendMarker}\\tfirewalld\\n'
  printf '${stateMarker}\\n'
  sudo -n firewall-cmd --state 2>&1 || firewall-cmd --state 2>&1
  zone=$(sudo -n firewall-cmd --get-default-zone 2>/dev/null || firewall-cmd --get-default-zone 2>/dev/null || printf public)
  printf '${zoneMarker}\\t%s\\n' "$zone"
  printf '${listMarker}\\n'
  sudo -n firewall-cmd --list-all --zone="$zone" 2>&1 || firewall-cmd --list-all --zone="$zone" 2>&1
  exit 0
fi
printf '${backendMarker}\\tunknown\\n'
printf '未检测到 ufw 或 firewalld。\\n'
`;
}

export function parseFirewallSnapshot(stdout: string, stderr: string, isWindowsHost: boolean): FirewallSnapshot {
  if (isWindowsHost) {
    return parseWindowsSnapshot(stdout, stderr);
  }

  const backendLine = stdout.split(/\r?\n/).find((line) => line.startsWith(backendMarker));
  const backend = (backendLine?.split('\t')[1] as FirewallBackend | undefined) ?? 'unknown';
  const rawOutput = [stdout, stderr].filter(Boolean).join('\n');

  if (backend === 'ufw') {
    const status = stdout.match(/^Status:\s*(.+)$/im)?.[1]?.trim() ?? '未知';
    const defaultPolicy = stdout.match(/^Default:\s*(.+)$/im)?.[1]?.trim() ?? '未读取到默认策略';

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
    const status = stateMatch?.[1]?.trim() || '未知';

    return {
      backend,
      status,
      defaultPolicy: `zone ${zone}`,
      zone,
      rules: parseFirewalldRules(stdout),
      rawOutput,
    };
  }

  return {
    backend: 'unknown',
    status: '未检测到支持的防火墙工具',
    defaultPolicy: '可安装 ufw 或 firewalld 后刷新',
    rules: [],
    rawOutput,
  };
}

export function validateFirewallDraft(draft: FirewallRuleDraft, backend: FirewallBackend) {
  const port = draft.port.trim();
  const source = draft.source.trim();
  const portMatch = port.match(/^(\d{1,5})(?:[:-](\d{1,5}))?$/);

  if (!portMatch) {
    throw new Error('端口必须是 1-65535，或端口范围，例如 8000-8010。');
  }

  const startPort = Number.parseInt(portMatch[1], 10);
  const endPort = portMatch[2] ? Number.parseInt(portMatch[2], 10) : startPort;

  if (startPort < 1 || endPort > 65535 || startPort > endPort) {
    throw new Error('端口范围必须位于 1-65535 内。');
  }

  if (source && source.length > 120) {
    throw new Error('来源地址过长。');
  }

  if (source && /[\r\n;&|`$<>]/.test(source)) {
    throw new Error('来源地址包含不安全字符。');
  }

  if (backend === 'firewalld' && draft.action !== 'allow') {
    throw new Error('firewalld 首版仅支持新增允许端口。');
  }
}

export function isRiskyFirewallDraft(draft: FirewallRuleDraft) {
  const port = draft.port.trim();
  const source = draft.source.trim();
  const riskyPorts = new Set(['22', '3389', '3306', '5432', '6379', '9200', '9300', '11211', '27017']);
  const openSource = !source || source === '0.0.0.0/0' || /^any(where)?$/i.test(source);

  return openSource || riskyPorts.has(port);
}

export function createFirewallAddRuleCommand(backend: FirewallBackend, draft: FirewallRuleDraft, zone?: string) {
  validateFirewallDraft(draft, backend);
  const port = draft.port.trim().replace(':', '-');
  const source = draft.source.trim();
  const protocol = draft.protocol === 'any' ? 'tcp' : draft.protocol;

  if (backend === 'ufw') {
    const protoSuffix = draft.protocol === 'any' ? '' : ` proto ${draft.protocol}`;
    const sourcePart = source && !/^any(where)?$/i.test(source) ? `from ${shellSingleQuote(source)} to any port ${shellSingleQuote(port)}${protoSuffix}` : `${shellSingleQuote(`${port}/${protocol}`)}`;
    return `sudo -n ufw ${draft.action} ${sourcePart}`;
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

  throw new Error('未检测到可操作的防火墙后端。');
}

export function createFirewallDeleteRuleCommand(backend: FirewallBackend, rule: FirewallRule, zone?: string) {
  if (backend === 'ufw') {
    const number = rule.id.match(/^ufw:(\d+)$/)?.[1];

    if (!number) {
      throw new Error('该 ufw 规则没有编号，请先刷新规则列表后再删除。');
    }

    return `sudo -n ufw delete ${number}`;
  }

  if (backend === 'firewalld') {
    if (!rule.port || !rule.protocol || rule.protocol === 'any') {
      throw new Error('首版仅支持删除 firewalld 端口规则。');
    }

    const targetZone = zone || 'public';
    return `sudo -n firewall-cmd --zone=${shellSingleQuote(targetZone)} --remove-port=${shellSingleQuote(`${rule.port}/${rule.protocol}`)} --permanent && sudo -n firewall-cmd --reload`;
  }

  if (backend === 'windows') {
    const name = rule.id.replace(/^windows:/, '');
    return powershellCommand(`Remove-NetFirewallRule -Name ${powershellSingleQuote(name)}`);
  }

  throw new Error('未检测到可操作的防火墙后端。');
}

export function createFirewallReloadCommand(backend: FirewallBackend) {
  if (backend === 'ufw') return 'sudo -n ufw reload';
  if (backend === 'firewalld') return 'sudo -n firewall-cmd --reload';
  if (backend === 'windows') return powershellCommand('Get-NetFirewallProfile | Format-Table -AutoSize | Out-String');
  throw new Error('未检测到可重载的防火墙后端。');
}

export function getFirewallBackendLabel(backend: FirewallBackend) {
  if (backend === 'ufw') return 'ufw';
  if (backend === 'firewalld') return 'firewalld';
  if (backend === 'windows') return 'Windows Firewall';
  return '未识别';
}
