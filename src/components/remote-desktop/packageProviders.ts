import { powershellCommand, powershellSingleQuote } from './remoteSystem';

export type PackageManagerKind = 'apt' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'apk' | 'winget' | 'choco' | 'unknown';
export type PackageView = 'upgradable' | 'installed' | 'search';
export type PackageAction = 'install' | 'remove' | 'upgrade' | 'upgrade-all' | 'refresh';

export interface RemotePackageInfo {
  name: string;
  version?: string;
  latestVersion?: string;
  description?: string;
  installed: boolean;
  upgradable?: boolean;
  source?: string;
}

export interface PackageActionDefinition {
  action: PackageAction;
  label: string;
  command: string;
  danger?: boolean;
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function getPackageManagerLabel(kind: PackageManagerKind) {
  const labels: Record<PackageManagerKind, string> = {
    apt: 'APT',
    dnf: 'DNF',
    yum: 'YUM',
    pacman: 'Pacman',
    zypper: 'Zypper',
    apk: 'APK',
    winget: 'winget',
    choco: 'Chocolatey',
    unknown: '未知',
  };

  return labels[kind];
}

export function isValidPackageName(name: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9+._:@/-]{0,160}$/.test(name.trim());
}

export function normalizePackageManager(rawValue: string): PackageManagerKind {
  const value = rawValue.trim().toLowerCase();

  if (value === 'apt-get' || value === 'apt') return 'apt';
  if (value === 'dnf') return 'dnf';
  if (value === 'yum') return 'yum';
  if (value === 'pacman') return 'pacman';
  if (value === 'zypper') return 'zypper';
  if (value === 'apk') return 'apk';
  if (value === 'winget') return 'winget';
  if (value === 'choco' || value === 'chocolatey') return 'choco';
  return 'unknown';
}

export function createDetectPackageManagerCommand(isWindowsHost: boolean) {
  if (isWindowsHost) {
    return powershellCommand(`
if (Get-Command winget -ErrorAction SilentlyContinue) { 'winget'; exit 0 }
if (Get-Command choco -ErrorAction SilentlyContinue) { 'choco'; exit 0 }
'unknown'
`);
  }

  return 'for pm in apt-get dnf yum pacman zypper apk; do if command -v "$pm" >/dev/null 2>&1; then echo "$pm"; exit 0; fi; done; echo unknown';
}

export function createPackageListCommand(kind: PackageManagerKind, view: Exclude<PackageView, 'search'>) {
  if (view === 'installed') {
    switch (kind) {
      case 'apt':
        return "dpkg-query -W -f='${Package}\\t${Version}\\t${binary:Summary}\\n' 2>/dev/null | head -n 600";
      case 'dnf':
      case 'yum':
        return `${kind} repoquery --installed --qf '%{name}\\t%{evr}\\t%{summary}' 2>/dev/null | head -n 600 || ${kind} list installed | tail -n +2 | head -n 600`;
      case 'pacman':
        return 'pacman -Q | head -n 600';
      case 'zypper':
        return "zypper --no-color --non-interactive packages --installed-only | awk -F'|' 'NR>2 {gsub(/^ +| +$/, \"\", $3); gsub(/^ +| +$/, \"\", $4); print $3 \"\\t\" $4}' | head -n 600";
      case 'apk':
        return 'apk info -vv | head -n 600';
      case 'winget':
        return powershellCommand('winget list --accept-source-agreements');
      case 'choco':
        return powershellCommand('choco list --local-only');
      default:
        return "echo '未识别包管理器。' >&2; exit 1";
    }
  }

  switch (kind) {
    case 'apt':
      return "apt list --upgradable 2>/dev/null | tail -n +2 | head -n 600";
    case 'dnf':
    case 'yum':
      return `${kind} check-update 2>/dev/null | tail -n +2 | head -n 600; test $? -eq 100 -o $? -eq 0`;
    case 'pacman':
      return 'pacman -Qu 2>/dev/null | head -n 600';
    case 'zypper':
      return 'zypper --no-color list-updates | tail -n +5 | head -n 600';
    case 'apk':
      return "apk version -l '<' 2>/dev/null | head -n 600";
    case 'winget':
      return powershellCommand('winget upgrade --accept-source-agreements');
    case 'choco':
      return powershellCommand('choco outdated');
    default:
      return "echo '未识别包管理器。' >&2; exit 1";
  }
}

export function createPackageSearchCommand(kind: PackageManagerKind, keyword: string) {
  const query = keyword.trim();

  if (!query) {
    throw new Error('请输入搜索关键词。');
  }

  if (query.length > 120 || /[\r\n;&|`$<>]/.test(query)) {
    throw new Error('搜索关键词包含不安全字符。');
  }

  switch (kind) {
    case 'apt':
      return `apt-cache search -- ${shellSingleQuote(query)} | head -n 300`;
    case 'dnf':
    case 'yum':
      return `${kind} -q search ${shellSingleQuote(query)} | head -n 300`;
    case 'pacman':
      return `pacman -Ss ${shellSingleQuote(query)} | head -n 400`;
    case 'zypper':
      return `zypper --no-color search ${shellSingleQuote(query)} | tail -n +5 | head -n 300`;
    case 'apk':
      return `apk search -v ${shellSingleQuote(query)} | head -n 300`;
    case 'winget':
      return powershellCommand(`winget search ${powershellSingleQuote(query)} --accept-source-agreements`);
    case 'choco':
      return powershellCommand(`choco search ${powershellSingleQuote(query)}`);
    default:
      return "echo '未识别包管理器。' >&2; exit 1";
  }
}

export function createPackageActionCommand(kind: PackageManagerKind, action: PackageAction, packageName?: string) {
  const name = packageName?.trim() ?? '';

  if (action !== 'upgrade-all' && action !== 'refresh' && !isValidPackageName(name)) {
    throw new Error('包名无效。');
  }

  switch (kind) {
    case 'apt':
      if (action === 'install') return `sudo apt-get install -y ${shellSingleQuote(name)}`;
      if (action === 'remove') return `sudo apt-get remove -y ${shellSingleQuote(name)}`;
      if (action === 'upgrade') return `sudo apt-get install --only-upgrade -y ${shellSingleQuote(name)}`;
      if (action === 'upgrade-all') return 'sudo apt-get upgrade -y';
      return 'sudo apt-get update';
    case 'dnf':
    case 'yum':
      if (action === 'install') return `sudo ${kind} install -y ${shellSingleQuote(name)}`;
      if (action === 'remove') return `sudo ${kind} remove -y ${shellSingleQuote(name)}`;
      if (action === 'upgrade') return `sudo ${kind} upgrade -y ${shellSingleQuote(name)}`;
      if (action === 'upgrade-all') return `sudo ${kind} upgrade -y`;
      return `sudo ${kind} makecache`;
    case 'pacman':
      if (action === 'install') return `sudo pacman -S --noconfirm ${shellSingleQuote(name)}`;
      if (action === 'remove') return `sudo pacman -R --noconfirm ${shellSingleQuote(name)}`;
      if (action === 'upgrade') return `sudo pacman -S --noconfirm ${shellSingleQuote(name)}`;
      if (action === 'upgrade-all') return 'sudo pacman -Syu --noconfirm';
      return 'sudo pacman -Sy';
    case 'zypper':
      if (action === 'install') return `sudo zypper --non-interactive install ${shellSingleQuote(name)}`;
      if (action === 'remove') return `sudo zypper --non-interactive remove ${shellSingleQuote(name)}`;
      if (action === 'upgrade') return `sudo zypper --non-interactive update ${shellSingleQuote(name)}`;
      if (action === 'upgrade-all') return 'sudo zypper --non-interactive update';
      return 'sudo zypper --non-interactive refresh';
    case 'apk':
      if (action === 'install') return `sudo apk add ${shellSingleQuote(name)}`;
      if (action === 'remove') return `sudo apk del ${shellSingleQuote(name)}`;
      if (action === 'upgrade') return `sudo apk upgrade ${shellSingleQuote(name)}`;
      if (action === 'upgrade-all') return 'sudo apk upgrade';
      return 'sudo apk update';
    case 'winget':
      if (action === 'install') return `winget install --id ${name} --accept-source-agreements --accept-package-agreements`;
      if (action === 'remove') return `winget uninstall --id ${name}`;
      if (action === 'upgrade') return `winget upgrade --id ${name} --accept-source-agreements --accept-package-agreements`;
      if (action === 'upgrade-all') return 'winget upgrade --all --accept-source-agreements --accept-package-agreements';
      return 'winget source update';
    case 'choco':
      if (action === 'install') return `choco install ${name} -y`;
      if (action === 'remove') return `choco uninstall ${name} -y`;
      if (action === 'upgrade') return `choco upgrade ${name} -y`;
      if (action === 'upgrade-all') return 'choco upgrade all -y';
      return 'choco outdated';
    default:
      throw new Error('未识别包管理器。');
  }
}

function parseAptUpgradable(line: string): RemotePackageInfo | null {
  const match = line.match(/^([^/]+)\/\S+\s+(\S+)\s+.*\[upgradable from:\s*([^\]]+)]/);
  if (!match) return null;
  return { name: match[1], latestVersion: match[2], version: match[3], installed: true, upgradable: true };
}

function splitPackageLine(line: string): string[] {
  return line.split(/\t+/).map((part) => part.trim()).filter(Boolean);
}

export function parsePackageOutput(kind: PackageManagerKind, view: PackageView, stdout: string): RemotePackageInfo[] {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (kind === 'apt' && view === 'upgradable') {
    return lines.map(parseAptUpgradable).filter((pkg): pkg is RemotePackageInfo => Boolean(pkg));
  }

  if (kind === 'apt' && view === 'installed') {
    return lines.map((line) => {
      const [name, version, description] = splitPackageLine(line);
      return { name, version, description, installed: true };
    }).filter((pkg) => Boolean(pkg.name));
  }

  if (kind === 'apt' && view === 'search') {
    return lines.map((line) => {
      const [name, description = ''] = line.split(' - ');
      return { name: name.trim(), description: description.trim(), installed: false };
    }).filter((pkg) => Boolean(pkg.name));
  }

  if (kind === 'pacman') {
    if (view === 'search') {
      const packages: RemotePackageInfo[] = [];
      lines.forEach((line) => {
        const match = line.match(/^[^/]+\/(\S+)\s+(\S+)\s*(.*)$/);
        if (match) packages.push({ name: match[1], version: match[2], description: match[3], installed: false });
      });
      return packages;
    }

    return lines.map((line) => {
      const [name, version, latestVersion] = line.split(/\s+/);
      return { name, version, latestVersion: view === 'upgradable' ? latestVersion : undefined, installed: true, upgradable: view === 'upgradable' };
    }).filter((pkg) => Boolean(pkg.name));
  }

  if (kind === 'apk') {
    return lines.map((line) => {
      const [left, description = ''] = line.split(' - ');
      const match = left.match(/^(.+)-([0-9][^\s]*)/);
      return {
        name: match?.[1] ?? left,
        version: view === 'upgradable' ? undefined : match?.[2],
        latestVersion: view === 'upgradable' ? match?.[2] : undefined,
        description,
        installed: view !== 'search',
        upgradable: view === 'upgradable',
      };
    }).filter((pkg) => Boolean(pkg.name));
  }

  return lines.map((line) => {
    const tabParts = splitPackageLine(line);
    if (tabParts.length >= 2) {
      return {
        name: tabParts[0],
        version: view === 'upgradable' ? undefined : tabParts[1],
        latestVersion: view === 'upgradable' ? tabParts[1] : undefined,
        description: tabParts.slice(2).join(' '),
        installed: view !== 'search',
        upgradable: view === 'upgradable',
      };
    }

    const parts = line.split(/\s+/);
    return {
      name: parts[0],
      version: view === 'upgradable' ? undefined : parts[1],
      latestVersion: view === 'upgradable' ? parts[1] : undefined,
      description: parts.slice(2).join(' '),
      installed: view !== 'search',
      upgradable: view === 'upgradable',
      source: line,
    };
  }).filter((pkg) => Boolean(pkg.name) && !/^(\||Name|Listing|Loading|Available)/i.test(pkg.name));
}
