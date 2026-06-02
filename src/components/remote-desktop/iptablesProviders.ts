import { tCurrent } from '../../i18n';
export type IptablesFamily = 'ipv4' | 'ipv6';
export type IptablesTable = 'filter' | 'nat' | 'mangle' | 'raw' | 'security';
export type IptablesProtocol = 'tcp' | 'udp' | 'icmp' | 'any' | string;
export type IptablesTarget = 'ACCEPT' | 'DROP' | 'REJECT' | 'RETURN' | string;

export interface IptablesPolicy {
  family: IptablesFamily;
  table: string;
  chain: string;
  policy: string;
  counters?: string;
}

export interface IptablesRule {
  id: string;
  family: IptablesFamily;
  table: string;
  chain: string;
  index: number;
  target: IptablesTarget;
  protocol?: IptablesProtocol;
  source?: string;
  destination?: string;
  destinationPort?: string;
  sourcePort?: string;
  inInterface?: string;
  outInterface?: string;
  state?: string;
  comment?: string;
  spec: string;
  raw: string;
}

export interface IptablesSnapshot {
  available: boolean;
  versions: string[];
  status: string;
  notice: string;
  policies: IptablesPolicy[];
  rules: IptablesRule[];
  rawOutput: string;
}

export interface IptablesRuleDraft {
  family: IptablesFamily;
  table: IptablesTable;
  chain: string;
  target: 'ACCEPT' | 'DROP' | 'REJECT';
  protocol: 'tcp' | 'udp' | 'any';
  port: string;
  source: string;
  destination: string;
  position: 'top' | 'append';
  comment: string;
}

const availabilityMarker = '__SHELLDESK_IPTABLES_AVAILABLE__';
const familyMarker = '__SHELLDESK_IPTABLES_FAMILY__';
const versionMarker = '__SHELLDESK_IPTABLES_VERSION__';

const supportedTables = new Set<IptablesTable>(['filter', 'nat', 'mangle', 'raw', 'security']);
const unsafeShellPattern = /[\r\n;&|`$<>]/;

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function compactHash(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function tokenizeRule(line: string) {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | '' = '';
  let escaped = false;

  for (const char of line.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function readOption(tokens: string[], ...names: string[]) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (names.includes(tokens[index])) {
      return tokens[index + 1];
    }
  }

  return undefined;
}

function normalizeProtocol(value?: string): IptablesProtocol | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (!normalized || normalized === 'all' || normalized === '0') return 'any';
  return normalized;
}

function normalizeTarget(value?: string): IptablesTarget {
  const normalized = String(value ?? '').trim().toUpperCase();
  return normalized || 'UNKNOWN';
}

function createChainCounterKey(family: IptablesFamily, table: string, chain: string) {
  return `${family}:${table}:${chain}`;
}

function readChainIndex(counters: Map<string, number>, family: IptablesFamily, table: string, chain: string) {
  const key = createChainCounterKey(family, table, chain);
  const nextIndex = (counters.get(key) ?? 0) + 1;
  counters.set(key, nextIndex);
  return nextIndex;
}

function parseIptablesRule(line: string, family: IptablesFamily, table: string, counters: Map<string, number>): IptablesRule | null {
  const tokens = tokenizeRule(line);

  if (tokens.length < 3 || tokens[0] !== '-A') {
    return null;
  }

  const chain = tokens[1];
  const index = readChainIndex(counters, family, table, chain);
  const protocol = normalizeProtocol(readOption(tokens, '-p', '--protocol'));
  const destinationPort = readOption(tokens, '--dport', '--dports', '--destination-port');
  const sourcePort = readOption(tokens, '--sport', '--sports', '--source-port');
  const target = normalizeTarget(readOption(tokens, '-j', '--jump', '-g', '--goto'));
  const spec = tokens.slice(2).join(' ');

  return {
    id: `${family}:${table}:${chain}:${index}:${compactHash(line)}`,
    family,
    table,
    chain,
    index,
    target,
    protocol,
    source: readOption(tokens, '-s', '--source'),
    destination: readOption(tokens, '-d', '--destination'),
    destinationPort,
    sourcePort,
    inInterface: readOption(tokens, '-i', '--in-interface'),
    outInterface: readOption(tokens, '-o', '--out-interface'),
    state: readOption(tokens, '--state', '--ctstate'),
    comment: readOption(tokens, '--comment'),
    spec,
    raw: line,
  };
}

function parsePolicy(line: string, family: IptablesFamily, table: string): IptablesPolicy | null {
  const saveMatch = line.match(/^:([^\s]+)\s+(\S+)\s+(\[[^\]]+\])?/);

  if (saveMatch) {
    const policy = saveMatch[2];

    if (policy === '-') {
      return null;
    }

    return {
      family,
      table,
      chain: saveMatch[1],
      policy,
      counters: saveMatch[3],
    };
  }

  const specMatch = line.match(/^-P\s+(\S+)\s+(\S+)/);

  if (specMatch) {
    return {
      family,
      table,
      chain: specMatch[1],
      policy: specMatch[2],
    };
  }

  return null;
}

export function createIptablesStatusCommand() {
  return tCurrent('auto.iptablesProviders.1s7q4tg', { value0: availabilityMarker, value1: versionMarker, value2: familyMarker, value3: availabilityMarker, value4: versionMarker, value5: familyMarker });
}

export function parseIptablesSnapshot(stdout: string, stderr: string): IptablesSnapshot {
  const rawOutput = [stdout, stderr].filter(Boolean).join('\n');
  const lines = rawOutput.split(/\r?\n/);
  const available = lines.some((line) => line === `${availabilityMarker}\tavailable`);
  const versions = lines
    .filter((line) => line.startsWith(`${versionMarker}\t`))
    .map((line) => line.split('\t').slice(1).join('\t').trim())
    .filter(Boolean);
  const policies: IptablesPolicy[] = [];
  const rules: IptablesRule[] = [];
  const counters = new Map<string, number>();
  let currentFamily: IptablesFamily = 'ipv4';
  let currentTable = 'filter';

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith(availabilityMarker) || line.startsWith(versionMarker)) {
      continue;
    }

    if (line.startsWith(`${familyMarker}\t`)) {
      currentFamily = line.split('\t')[1] === 'ipv6' ? 'ipv6' : 'ipv4';
      currentTable = 'filter';
      continue;
    }

    if (line.startsWith('*')) {
      const tableName = line.slice(1).trim();
      currentTable = tableName || currentTable;
      continue;
    }

    if (line === 'COMMIT' || /^#/.test(line)) {
      continue;
    }

    const policy = parsePolicy(line, currentFamily, currentTable);
    if (policy) {
      policies.push(policy);
      continue;
    }

    const rule = parseIptablesRule(line, currentFamily, currentTable, counters);
    if (rule) {
      rules.push(rule);
    }
  }

  const permissionDenied = /permission denied|you must be root|operation not permitted|sudo: a password is required|\u9700\u8981\u5bc6\u7801/i.test(rawOutput);
  const nftCompatibility = versions.some((version) => /nf_tables/i.test(version));
  const notice = !available
    ? tCurrent('auto.iptablesProviders.sc599e')
    : permissionDenied
      ? tCurrent('auto.iptablesProviders.lce5pb')
      : nftCompatibility
        ? tCurrent('auto.iptablesProviders.43e45i')
        : '';
  return {
    available,
    versions,
    status: available ? tCurrent('auto.iptablesProviders.16n2tfr', { value0: rules.length, value1: policies.length }) : tCurrent('auto.iptablesProviders.buf4kb'),
    notice,
    policies,
    rules,
    rawOutput,
  };
}

export function validateIptablesDraft(draft: IptablesRuleDraft) {
  const chain = draft.chain.trim();
  const port = draft.port.trim();
  const source = draft.source.trim();
  const destination = draft.destination.trim();
  const comment = draft.comment.trim();

  if (!supportedTables.has(draft.table)) {
    throw new Error(tCurrent('auto.iptablesProviders.z5u25p'));
  }

  if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(chain)) {
    throw new Error(tCurrent('auto.iptablesProviders.1ivozri'));
  }

  if (port) {
    const portMatch = port.match(/^(\d{1,5})(?:[:-](\d{1,5}))?$/);

    if (!portMatch) {
      throw new Error(tCurrent('auto.iptablesProviders.f1rgcm'));
    }

    const startPort = Number.parseInt(portMatch[1], 10);
    const endPort = portMatch[2] ? Number.parseInt(portMatch[2], 10) : startPort;

    if (startPort < 1 || endPort > 65535 || startPort > endPort) {
      throw new Error(tCurrent('auto.iptablesProviders.yk8200'));
    }

    if (draft.protocol === 'any') {
      throw new Error(tCurrent('auto.iptablesProviders.1k5kesn'));
    }
  }

  for (const [label, value] of [[tCurrent('auto.iptablesProviders.1kj77kw'), source], [tCurrent('auto.iptablesProviders.w4v742'), destination], [tCurrent('auto.iptablesProviders.b5m1l6'), comment]] as const) {
    if (value.length > 160) {
      throw new Error(tCurrent('auto.iptablesProviders.k6ec14', { value0: label }));
    }

    if (unsafeShellPattern.test(value)) {
      throw new Error(tCurrent('auto.iptablesProviders.1xto81z', { value0: label }));
    }
  }
}

export function isRiskyIptablesDraft(draft: IptablesRuleDraft) {
  const port = draft.port.trim();
  const source = draft.source.trim();
  const sensitivePorts = new Set(['22', '3389', '3306', '5432', '6379', '9200', '9300', '11211', '27017']);
  const broadSource = !source || source === '0.0.0.0/0' || source === '::/0' || /^any(where)?$/i.test(source);

  return broadSource || !port || sensitivePorts.has(port) || (draft.target !== 'ACCEPT' && broadSource);
}

export function createIptablesAddRuleCommand(draft: IptablesRuleDraft) {
  validateIptablesDraft(draft);
  const binary = draft.family === 'ipv6' ? 'ip6tables' : 'iptables';
  const chain = draft.chain.trim();
  const commandParts = ['sudo -n', binary, '-t', shellSingleQuote(draft.table)];
  const positionFlag = draft.position === 'append' ? '-A' : '-I';
  commandParts.push(positionFlag, shellSingleQuote(chain));

  if (draft.position === 'top') {
    commandParts.push('1');
  }

  if (draft.protocol !== 'any') {
    const port = draft.port.trim().replace('-', ':');
    commandParts.push('-p', shellSingleQuote(draft.protocol), '-m', shellSingleQuote(draft.protocol));

    if (port) {
      commandParts.push('--dport', shellSingleQuote(port));
    }
  }

  const source = draft.source.trim();
  if (source && !/^any(where)?$/i.test(source)) {
    commandParts.push('-s', shellSingleQuote(source));
  }

  const destination = draft.destination.trim();
  if (destination && !/^any(where)?$/i.test(destination)) {
    commandParts.push('-d', shellSingleQuote(destination));
  }

  const comment = draft.comment.trim() || `ShellDesk ${draft.target} ${draft.protocol}${draft.port.trim() ? ` ${draft.port.trim()}` : ''}`;
  commandParts.push('-m', 'comment', '--comment', shellSingleQuote(comment), '-j', draft.target);

  return commandParts.join(' ');
}

export function createIptablesDeleteRuleCommand(rule: IptablesRule) {
  if (!Number.isInteger(rule.index) || rule.index < 1) {
    throw new Error(tCurrent('auto.iptablesProviders.qkj1w8'));
  }

  const binary = rule.family === 'ipv6' ? 'ip6tables' : 'iptables';
  return `sudo -n ${binary} -t ${shellSingleQuote(rule.table)} -D ${shellSingleQuote(rule.chain)} ${rule.index}`;
}

export function getIptablesTargetLabel(target: string) {
  const normalized = target.toUpperCase();

  if (normalized === 'ACCEPT') return tCurrent('auto.iptablesProviders.11bz44c');
  if (normalized === 'DROP') return tCurrent('auto.iptablesProviders.19rnkgi');
  if (normalized === 'REJECT') return tCurrent('auto.iptablesProviders.1y9ly2h');
  if (normalized === 'RETURN') return tCurrent('auto.iptablesProviders.omytgn');
  return target || tCurrent('auto.iptablesProviders.1lpnuh4');
}

export function getIptablesTargetTone(target: string) {
  const normalized = target.toUpperCase();

  if (normalized === 'ACCEPT') return 'accept';
  if (normalized === 'DROP' || normalized === 'REJECT') return 'drop';
  if (normalized === 'RETURN') return 'return';
  return 'custom';
}

export function getIptablesDefaultPolicy(policies: IptablesPolicy[]) {
  const filterPolicies = policies
    .filter((policy) => policy.table === 'filter')
    .map((policy) => `${policy.family} ${policy.chain} ${policy.policy}`);

  return filterPolicies.length ? filterPolicies.join(' · ') : tCurrent('auto.iptablesProviders.unhp5');
}
