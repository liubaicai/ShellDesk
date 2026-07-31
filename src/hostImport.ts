import type { Host } from './appHostModel';

export type HostImportSource = 'csv' | 'mobaxterm' | 'xshell' | 'securecrt';
export type HostImportDuplicateStrategy = 'skip' | 'replace' | 'keepBoth';

export interface HostImportFile {
  name: string;
  parentName: string;
  content: string;
}

export interface HostImportCandidate {
  id: string;
  source: HostImportSource;
  sourceFile: string;
  name: string;
  address: string;
  port: number;
  username: string;
  group: string;
  tags: string[];
  note: string;
  keyPath: string;
  password: string;
  secretKind: 'none' | 'plaintext' | 'encrypted';
  errors: string[];
  warnings: string[];
  fingerprint: string;
  conflict: 'none' | 'existing' | 'batch';
  existingHostId?: string;
}

export interface HostImportFileReport {
  name: string;
  source?: HostImportSource;
  candidateCount: number;
  error?: string;
}

export interface HostImportPreview {
  candidates: HostImportCandidate[];
  files: HostImportFileReport[];
}

export interface HostImportPlan {
  hosts: Host[];
  added: number;
  replaced: number;
  skipped: number;
}

interface ParsedCandidate {
  name?: string;
  address?: string;
  port?: string | number;
  username?: string;
  group?: string;
  tags?: string[];
  note?: string;
  keyPath?: string;
  password?: string;
  secretKind?: HostImportCandidate['secretKind'];
}

interface IniDocument {
  sections: Array<{ name: string; values: Map<string, string>; entries: Array<[string, string]> }>;
}

const maxCandidateCount = 5_000;
const maxFieldLength = 2_048;

export function createHostFingerprint(host: Pick<Host, 'address' | 'port' | 'username'>) {
  return [
    host.address.trim().toLocaleLowerCase(),
    normalizePort(host.port),
    host.username.trim().toLocaleLowerCase(),
  ].join('\u0000');
}

export function parseHostImportFiles(
  files: HostImportFile[],
  existingHosts: Host[],
): HostImportPreview {
  const existingByFingerprint = new Map(
    existingHosts.map((host) => [createHostFingerprint(host), host]),
  );
  const batchFingerprints = new Set<string>();
  const candidates: HostImportCandidate[] = [];
  const reports: HostImportFileReport[] = [];

  files.slice(0, 500).forEach((file, fileIndex) => {
    if (candidates.length >= maxCandidateCount) {
      reports.push({
        name: file.name,
        candidateCount: 0,
        error: `Import is limited to ${maxCandidateCount} hosts.`,
      });
      return;
    }
    try {
      const source = detectHostImportSource(file);
      const parsed = parseFile(file, source);
      const available = maxCandidateCount - candidates.length;
      const normalized = parsed.slice(0, available).map((candidate, candidateIndex) => (
        normalizeCandidate(candidate, source, file, fileIndex, candidateIndex)
      ));
      for (const candidate of normalized) {
        const existing = existingByFingerprint.get(candidate.fingerprint);
        if (existing) {
          candidate.conflict = 'existing';
          candidate.existingHostId = existing.id;
        } else if (batchFingerprints.has(candidate.fingerprint)) {
          candidate.conflict = 'batch';
        }
        if (!candidate.errors.length) {
          batchFingerprints.add(candidate.fingerprint);
        }
        candidates.push(candidate);
      }
      reports.push({ name: file.name, source, candidateCount: normalized.length });
    } catch (error) {
      reports.push({
        name: file.name,
        candidateCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return { candidates, files: reports };
}

export function planHostImport(
  existingHosts: Host[],
  candidates: HostImportCandidate[],
  selectedIds: ReadonlySet<string>,
  strategy: HostImportDuplicateStrategy,
  includePlaintextPasswords: boolean,
  now: string,
  createId: () => string,
): HostImportPlan {
  const hosts = existingHosts.map((host) => ({ ...host, tags: [...host.tags] }));
  const indexByFingerprint = new Map(
    hosts.map((host, index) => [createHostFingerprint(host), index]),
  );
  const usedNames = new Set(hosts.map((host) => host.name.trim().toLocaleLowerCase()));
  let added = 0;
  let replaced = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    if (!selectedIds.has(candidate.id) || candidate.errors.length) {
      skipped += 1;
      continue;
    }
    const existingIndex = indexByFingerprint.get(candidate.fingerprint);
    if (existingIndex !== undefined && strategy === 'skip') {
      skipped += 1;
      continue;
    }
    let name = candidate.name;
    if (strategy === 'keepBoth') {
      name = uniqueHostName(name, usedNames);
    }
    const imported = importedHost(
      candidate,
      name,
      includePlaintextPasswords,
      now,
      createId(),
    );
    if (existingIndex !== undefined && strategy === 'replace') {
      const existing = hosts[existingIndex];
      hosts[existingIndex] = {
        ...imported,
        id: existing.id,
        createdAt: existing.createdAt,
        hostInfo: existing.hostInfo,
        systemType: existing.systemType,
        systemName: existing.systemName,
        lastConnectionStatus: existing.lastConnectionStatus,
        lastConnectionAt: existing.lastConnectionAt,
        lastConnectionError: existing.lastConnectionError,
      };
      usedNames.add(imported.name.trim().toLocaleLowerCase());
      replaced += 1;
      continue;
    }
    hosts.push(imported);
    indexByFingerprint.set(candidate.fingerprint, hosts.length - 1);
    usedNames.add(imported.name.trim().toLocaleLowerCase());
    added += 1;
  }
  return { hosts, added, replaced, skipped };
}

function importedHost(
  candidate: HostImportCandidate,
  name: string,
  includePlaintextPasswords: boolean,
  now: string,
  id: string,
): Host {
  const keyPath = candidate.keyPath;
  return {
    id,
    name,
    address: candidate.address,
    port: candidate.port,
    username: candidate.username,
    authMethod: keyPath ? 'key' : 'password',
    password: includePlaintextPasswords && candidate.secretKind === 'plaintext'
      ? candidate.password
      : '',
    keyId: '',
    keyPath,
    passphrase: '',
    privilegeMode: 'sudo',
    rootPassword: '',
    jumpHostId: '',
    canBeJumpHost: false,
    proxyProfileId: '',
    keepaliveEnabled: true,
    keepaliveIntervalMs: 15_000,
    systemType: 'unknown',
    systemName: '',
    hostInfo: null,
    group: candidate.group,
    tags: candidate.tags,
    note: candidate.note,
    lastConnectionStatus: 'unknown',
    lastConnectionAt: '',
    lastConnectionError: '',
    createdAt: now,
    updatedAt: now,
  };
}

function uniqueHostName(name: string, usedNames: Set<string>) {
  if (!usedNames.has(name.trim().toLocaleLowerCase())) {
    return name;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const next = `${name} (${suffix})`;
    if (!usedNames.has(next.toLocaleLowerCase())) {
      return next;
    }
  }
  return `${name} (imported)`;
}

function detectHostImportSource(file: HostImportFile): HostImportSource {
  const extension = file.name.split('.').pop()?.toLocaleLowerCase();
  const content = file.content.slice(0, 16_384);
  if (extension === 'csv') return 'csv';
  if (extension === 'xsh' || /\[\s*CONNECTION(?::[^\]]+)?\s*]/i.test(content)) return 'xshell';
  if (/^[SDB]:"(?:Hostname|\[SSH2] Port|Username)"/im.test(content) || /<session\b/i.test(content)) {
    return 'securecrt';
  }
  if (/\[\s*Bookmarks(?:_\d+)?\s*]/i.test(content) || /#10\d#\d%/.test(content)) {
    return 'mobaxterm';
  }
  if (extension === 'xml') return 'securecrt';
  if (looksLikeCsv(content)) return 'csv';
  throw new Error('Unsupported host migration format.');
}

function parseFile(file: HostImportFile, source: HostImportSource): ParsedCandidate[] {
  switch (source) {
    case 'csv':
      return parseCsvCandidates(file.content);
    case 'mobaxterm':
      return parseMobaXtermCandidates(file.content);
    case 'xshell':
      return [parseXshellCandidate(file)];
    case 'securecrt':
      return parseSecureCrtCandidates(file);
  }
}

function parseCsvCandidates(content: string): ParsedCandidate[] {
  const rows = parseCsv(content);
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  const get = (row: string[], aliases: string[]) => {
    const index = headers.findIndex((header) => aliases.includes(header));
    return index >= 0 ? row[index]?.trim() ?? '' : '';
  };
  return rows.slice(1, 10_001)
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row) => ({
      name: get(row, ['name', 'session', 'sessionname', 'title']),
      address: get(row, ['host', 'hostname', 'address', 'ip', 'hostip']),
      port: get(row, ['port', 'sshport']),
      username: get(row, ['username', 'user', 'login']),
      group: get(row, ['group', 'folder', 'category']),
      tags: splitTags(get(row, ['tags', 'tag'])),
      note: get(row, ['note', 'notes', 'description', 'comment']),
      keyPath: get(row, ['keypath', 'identityfile', 'privatekey', 'keyfile']),
      password: get(row, ['password', 'pass']),
      secretKind: get(row, ['password', 'pass']) ? 'plaintext' : 'none',
    }));
}

function parseMobaXtermCandidates(content: string): ParsedCandidate[] {
  const document = parseIni(content);
  const candidates: ParsedCandidate[] = [];
  for (const section of document.sections) {
    if (!/^bookmarks(?:_\d+)?$/i.test(section.name)) continue;
    const group = section.values.get('subrep') ?? '';
    for (const [name, value] of section.entries) {
      if (/^(subrep|imgnum)$/i.test(name)) continue;
      const fields = value.split('%');
      if (!fields[0]?.startsWith('#')) continue;
      candidates.push({
        name,
        address: fields[1] ?? '',
        port: fields[2] ?? '22',
        username: fields[3] ?? '',
        group,
      });
    }
  }
  return candidates;
}

function parseXshellCandidate(file: HostImportFile): ParsedCandidate {
  const document = parseIni(file.content);
  const values = mergeIniValues(document);
  const protocol = firstValue(values, ['protocol']);
  if (protocol && !/ssh|sftp/i.test(protocol)) {
    throw new Error(`Unsupported Xshell protocol: ${protocol}`);
  }
  const password = firstValue(values, ['password']);
  return {
    name: firstValue(values, ['name', 'sessionname']) || fileBaseName(file.name),
    address: firstValue(values, ['host', 'hostname']),
    port: firstValue(values, ['port']) || '22',
    username: firstValue(values, ['username', 'user']),
    group: file.parentName,
    note: firstValue(values, ['description']),
    keyPath: firstValue(values, ['userkey', 'identityfile', 'keypath']),
    password,
    secretKind: password ? 'encrypted' : 'none',
  };
}

function parseSecureCrtCandidates(file: HostImportFile): ParsedCandidate[] {
  if (/<(?:session|key)\b/i.test(file.content)) {
    return parseSecureCrtXml(file);
  }
  const values = new Map<string, string>();
  for (const line of file.content.split(/\r?\n/)) {
    const match = line.match(/^[SDB]:"([^"]+)"=(.*)$/);
    if (!match) continue;
    values.set(normalizeHeader(match[1]), match[2].trim());
  }
  const protocol = firstValue(values, ['protocolname', 'protocol']);
  if (protocol && !/ssh/i.test(protocol)) {
    throw new Error(`Unsupported SecureCRT protocol: ${protocol}`);
  }
  const rawPort = firstValue(values, ['ssh2port', 'port']);
  const password = firstValue(values, ['password', 'ssh2password']);
  return [{
    name: fileBaseName(file.name),
    address: firstValue(values, ['hostname']),
    port: parseSecureCrtPort(rawPort),
    username: firstValue(values, ['username']),
    group: file.parentName,
    note: firstValue(values, ['description']),
    keyPath: firstValue(values, ['identityfilenamev2', 'identityfilename']),
    password,
    secretKind: password ? 'encrypted' : 'none',
  }];
}

function parseSecureCrtXml(file: HostImportFile): ParsedCandidate[] {
  const blocks = file.content.match(/<session\b[\s\S]*?<\/session>/gi) ?? [file.content];
  return blocks.map((block, index) => {
    const sessionName = block.match(/<session\b[^>]*\bname=["']([^"']+)["']/i)?.[1];
    const read = (keys: string[]) => {
      for (const key of keys) {
        const escaped = escapeRegex(key);
        const keyMatch = block.match(new RegExp(
          `<key\\b[^>]*\\bname=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/key>`,
          'i',
        ));
        if (keyMatch) return decodeXml(keyMatch[1].replace(/<[^>]+>/g, '').trim());
        const elementMatch = block.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
        if (elementMatch) return decodeXml(elementMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      return '';
    };
    const password = read(['Password']);
    return {
      name: decodeXml(sessionName ?? '') || (blocks.length > 1 ? `${fileBaseName(file.name)} ${index + 1}` : fileBaseName(file.name)),
      address: read(['Hostname', 'Host']),
      port: parseSecureCrtPort(read(['[SSH2] Port', 'Port'])),
      username: read(['Username', 'UserName']),
      group: file.parentName,
      note: read(['Description']),
      keyPath: read(['Identity Filename V2', 'Identity Filename']),
      password,
      secretKind: password ? 'encrypted' : 'none',
    };
  });
}

function normalizeCandidate(
  parsed: ParsedCandidate,
  source: HostImportSource,
  file: HostImportFile,
  fileIndex: number,
  candidateIndex: number,
): HostImportCandidate {
  const address = cleanField(parsed.address);
  const port = normalizePort(parsed.port);
  const rawUsername = cleanField(parsed.username);
  const username = rawUsername || 'root';
  const name = cleanField(parsed.name) || address || fileBaseName(file.name);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!address) errors.push('Host address is missing.');
  if (port < 1 || port > 65_535) errors.push('SSH port must be between 1 and 65535.');
  if (!rawUsername) warnings.push('Username was empty and defaulted to root.');
  if (parsed.secretKind === 'encrypted') {
    warnings.push('The source password is encrypted by another client and cannot be migrated.');
  } else if (parsed.secretKind === 'plaintext') {
    warnings.push('A plaintext password was found; importing it is opt-in.');
  }
  const candidate = {
    id: `host-import-${fileIndex}-${candidateIndex}`,
    source,
    sourceFile: file.name,
    name: name.slice(0, 120),
    address: address.slice(0, 255),
    port,
    username: username.slice(0, 255),
    group: cleanField(parsed.group).slice(0, 120),
    tags: (parsed.tags ?? []).map(cleanField).filter(Boolean).slice(0, 20),
    note: cleanField(parsed.note).slice(0, 2_000),
    keyPath: cleanField(parsed.keyPath).slice(0, 1_024),
    password: cleanField(parsed.password).slice(0, 4_096),
    secretKind: parsed.secretKind ?? 'none',
    errors,
    warnings,
    fingerprint: '',
    conflict: 'none' as const,
  };
  candidate.fingerprint = createHostFingerprint(candidate);
  return candidate;
}

function parseIni(content: string): IniDocument {
  const sections: IniDocument['sections'] = [];
  let current = { name: '', values: new Map<string, string>(), entries: [] as Array<[string, string]> };
  sections.push(current);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const section = line.match(/^\[([^\]]+)]$/);
    if (section) {
      current = { name: section[1].trim(), values: new Map(), entries: [] };
      sections.push(current);
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    current.values.set(normalizeHeader(key), value);
    current.entries.push([key, value]);
  }
  return { sections };
}

function mergeIniValues(document: IniDocument) {
  const values = new Map<string, string>();
  for (const section of document.sections) {
    for (const [key, value] of section.values) values.set(key, value);
  }
  return values;
}

function parseCsv(content: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unclosed quote.');
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function looksLikeCsv(content: string) {
  const header = content.split(/\r?\n/, 1)[0] ?? '';
  const normalized = header.split(',').map(normalizeHeader);
  return normalized.some((value) => ['host', 'hostname', 'address', 'ip'].includes(value));
}

function normalizeHeader(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizePort(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  const text = String(value ?? '').trim();
  if (!text) return 22;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSecureCrtPort(value: string) {
  if (!value) return 22;
  if (/^[0-9a-f]{8}$/i.test(value)) return Number.parseInt(value, 16);
  return normalizePort(value);
}

function firstValue(values: Map<string, string>, aliases: string[]) {
  for (const alias of aliases) {
    const value = values.get(normalizeHeader(alias));
    if (value) return value;
  }
  return '';
}

function cleanField(value: unknown) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxFieldLength);
}

function splitTags(value: string) {
  return value.split(/[|;,]/).map((tag) => tag.trim()).filter(Boolean);
}

function fileBaseName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '') || fileName;
}

function decodeXml(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
