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
  return `
if command -v iptables >/dev/null 2>&1; then
  printf '${availabilityMarker}\\tavailable\\n'
  printf '${versionMarker}\\t%s\\n' "$(iptables -V 2>&1)"
  printf '${familyMarker}\\tipv4\\n'
  if command -v iptables-save >/dev/null 2>&1; then
    sudo -n iptables-save 2>&1 || iptables-save 2>&1 || true
  else
    sudo -n iptables -S 2>&1 || iptables -S 2>&1 || true
  fi
else
  printf '${availabilityMarker}\\tmissing\\n'
  printf '未检测到 iptables。\\n'
fi
if command -v ip6tables >/dev/null 2>&1; then
  printf '${versionMarker}\\t%s\\n' "$(ip6tables -V 2>&1)"
  printf '${familyMarker}\\tipv6\\n'
  if command -v ip6tables-save >/dev/null 2>&1; then
    sudo -n ip6tables-save 2>&1 || ip6tables-save 2>&1 || true
  else
    sudo -n ip6tables -S 2>&1 || ip6tables -S 2>&1 || true
  fi
fi
`;
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

  const permissionDenied = /permission denied|you must be root|operation not permitted|sudo: a password is required|需要密码/i.test(rawOutput);
  const nftCompatibility = versions.some((version) => /nf_tables/i.test(version));
  const notice = !available
    ? '未检测到 iptables。'
    : permissionDenied
      ? 'iptables 已安装，但当前用户可能缺少读取或 sudo 免密权限。'
      : nftCompatibility
        ? '当前 iptables 可能运行在 nftables 兼容层，修改前请确认没有与 nft/firewalld/ufw 规则冲突。'
        : '';
  return {
    available,
    versions,
    status: available ? `${rules.length} 条规则，${policies.length} 个默认策略` : '未安装',
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
    throw new Error('暂不支持该 iptables 表。');
  }

  if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(chain)) {
    throw new Error('链名称只能包含字母、数字、点、下划线、冒号和短横线。');
  }

  if (port) {
    const portMatch = port.match(/^(\d{1,5})(?:[:-](\d{1,5}))?$/);

    if (!portMatch) {
      throw new Error('端口必须是 1-65535，或端口范围，例如 8000-8010。');
    }

    const startPort = Number.parseInt(portMatch[1], 10);
    const endPort = portMatch[2] ? Number.parseInt(portMatch[2], 10) : startPort;

    if (startPort < 1 || endPort > 65535 || startPort > endPort) {
      throw new Error('端口范围必须位于 1-65535 内。');
    }

    if (draft.protocol === 'any') {
      throw new Error('填写端口时必须选择 TCP 或 UDP。');
    }
  }

  for (const [label, value] of [['来源地址', source], ['目标地址', destination], ['备注', comment]] as const) {
    if (value.length > 160) {
      throw new Error(`${label}过长。`);
    }

    if (unsafeShellPattern.test(value)) {
      throw new Error(`${label}包含不安全字符。`);
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
    throw new Error('该规则没有可用序号，请刷新后重试。');
  }

  const binary = rule.family === 'ipv6' ? 'ip6tables' : 'iptables';
  return `sudo -n ${binary} -t ${shellSingleQuote(rule.table)} -D ${shellSingleQuote(rule.chain)} ${rule.index}`;
}

export function getIptablesTargetLabel(target: string) {
  const normalized = target.toUpperCase();

  if (normalized === 'ACCEPT') return '允许';
  if (normalized === 'DROP') return '丢弃';
  if (normalized === 'REJECT') return '拒收';
  if (normalized === 'RETURN') return '返回';
  return target || '未知';
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

  return filterPolicies.length ? filterPolicies.join(' · ') : '默认策略未知';
}
