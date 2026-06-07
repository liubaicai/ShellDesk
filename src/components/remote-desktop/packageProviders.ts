import { powershellCommand, powershellSingleQuote } from './remoteSystem';
import { tCurrent } from '../../i18n';

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

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function privilegedPackageCommand(command: string) {
  return `if [ "$(id -u 2>/dev/null)" = "0" ]; then ${command}; else sudo -n ${command}; fi`;
}

function createRpmPackageNameSearchCommand(kind: 'dnf' | 'yum', query: string) {
  const quotedQuery = shellSingleQuote(query);
  const queryFormat = shellSingleQuote('%{name}\\t%{evr}\\t%{summary}');

  return `
query=${quotedQuery}
query_lower="$(printf '%s' "$query" | tr '[:upper:]' '[:lower:]')"
results="$(
  {
    for spec in "$query" "$query-*" "$query.*" "*$query*"; do
      ${kind} -q repoquery --installed --qf ${queryFormat} "$spec" 2>/dev/null | awk -F '\\t' -v query="$query_lower" 'NF && index(tolower($1), query) { print $0 "\\tinstalled" }'
    done
    for spec in "$query" "$query-*" "$query.*" "*$query*"; do
      ${kind} -q repoquery --available --latest-limit=1 --qf ${queryFormat} "$spec" 2>/dev/null | awk -F '\\t' -v query="$query_lower" 'NF && index(tolower($1), query) { print $0 "\\tavailable" }'
    done
  } | awk -F '\\t' 'NF && !seen[$1]++'
)"
if [ -n "$results" ]; then
  printf '%s\\n' "$results" | head -n 300
else
  {
    ${kind} -q list installed "$query" "$query-*" "$query.*" "*$query*" 2>/dev/null | awk '
      /^[[:space:]]*$/ || /^Installed Packages/ || /^Last metadata expiration check/ { next }
      {
        name=$1
        sub(/\\.(noarch|x86_64|aarch64|i[3-6]86|ppc64le|s390x)$/, "", name)
        print name "\\t" $2 "\\t" $3 "\\tinstalled"
      }
    '
    ${kind} -q list available "$query" "$query-*" "$query.*" "*$query*" 2>/dev/null | awk '
      /^[[:space:]]*$/ || /^Available Packages/ || /^Last metadata expiration check/ { next }
      {
        name=$1
        sub(/\\.(noarch|x86_64|aarch64|i[3-6]86|ppc64le|s390x)$/, "", name)
        print name "\\t" $2 "\\t" $3 "\\tavailable"
      }
    '
  } | awk -F '\\t' -v query="$query_lower" 'NF && index(tolower($1), query) && !seen[$1]++' | head -n 300
fi
`.trim();
}

function createRpmUpgradableListCommand(kind: 'dnf' | 'yum') {
  return tCurrent('auto.packageProviders.1fgd0mm', { value0: kind }).trim();
}

function createApkUpgradableListCommand() {
  return `
apk version -v -l '<' 2>/dev/null | awk '
  /^[[:space:]]*$/ || /^Installed:[[:space:]]*Available:/ || /^Installed:/ || /^Available:/ { next }
  {
    installed=$1
    relation=$2
    available=$3
    if (relation != "<" || installed == "" || available == "") next

    name=installed
    sub(/-[0-9][^[:space:]]*$/, "", name)
    if (name == installed || name == "") next

    installed_version=substr(installed, length(name) + 2)
    available_version=available
    prefix=name "-"
    if (index(available_version, prefix) == 1) {
      available_version=substr(available_version, length(prefix) + 1)
    }
    if (installed_version == "" || available_version == "") next

    printf "%s\\t%s\\t%s\\n", name, installed_version, available_version
  }
' | head -n 600
`.trim();
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
    unknown: tCurrent('auto.packageProviders.1lpnuh4'),
  };

  return labels[kind];
}

function isValidPackageName(name: string) {
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
        return tCurrent('auto.packageProviders.g23jon');
    }
  }

  switch (kind) {
    case 'apt':
      return "apt list --upgradable 2>/dev/null | tail -n +2 | head -n 600";
    case 'dnf':
    case 'yum':
      return createRpmUpgradableListCommand(kind);
    case 'pacman':
      return 'pacman -Qu 2>/dev/null | head -n 600';
    case 'zypper':
      return 'zypper --no-color list-updates | tail -n +5 | head -n 600';
    case 'apk':
      return createApkUpgradableListCommand();
    case 'winget':
      return powershellCommand('winget upgrade --accept-source-agreements');
    case 'choco':
      return powershellCommand('choco outdated');
    default:
      return tCurrent('auto.packageProviders.g23jon2');
  }
}

export function createPackageSearchCommand(kind: PackageManagerKind, keyword: string) {
  const query = keyword.trim();

  if (!query) {
    throw new Error(tCurrent('auto.packageProviders.dgjaa2'));
  }

  if (query.length > 120 || /[\r\n;&|`$<>*?[\]]/.test(query)) {
    throw new Error(tCurrent('auto.packageProviders.1vl8rti'));
  }

  switch (kind) {
    case 'apt':
      return `apt-cache search -- ${shellSingleQuote(query)} | head -n 300`;
    case 'dnf':
    case 'yum':
      return createRpmPackageNameSearchCommand(kind, query);
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
      return tCurrent('auto.packageProviders.g23jon3');
  }
}

export function createPackageActionCommand(kind: PackageManagerKind, action: PackageAction, packageName?: string) {
  const name = packageName?.trim() ?? '';

  if (action !== 'upgrade-all' && action !== 'refresh' && !isValidPackageName(name)) {
    throw new Error(tCurrent('auto.packageProviders.1e7xvxb'));
  }

  switch (kind) {
    case 'apt':
      if (action === 'install') return privilegedPackageCommand(`apt-get install -y ${shellSingleQuote(name)}`);
      if (action === 'remove') return privilegedPackageCommand(`apt-get remove -y ${shellSingleQuote(name)}`);
      if (action === 'upgrade') return privilegedPackageCommand(`apt-get install --only-upgrade -y ${shellSingleQuote(name)}`);
      if (action === 'upgrade-all') return privilegedPackageCommand('apt-get upgrade -y');
      return privilegedPackageCommand('apt-get update');
    case 'dnf':
    case 'yum':
      if (action === 'install') return privilegedPackageCommand(`${kind} install -y ${shellSingleQuote(name)}`);
      if (action === 'remove') return privilegedPackageCommand(`${kind} remove -y ${shellSingleQuote(name)}`);
      if (action === 'upgrade') return privilegedPackageCommand(`${kind} upgrade -y ${shellSingleQuote(name)}`);
      if (action === 'upgrade-all') return privilegedPackageCommand(`${kind} upgrade -y`);
      return privilegedPackageCommand(`${kind} makecache`);
    case 'pacman':
      if (action === 'install') return privilegedPackageCommand(`pacman -S --noconfirm ${shellSingleQuote(name)}`);
      if (action === 'remove') return privilegedPackageCommand(`pacman -R --noconfirm ${shellSingleQuote(name)}`);
      if (action === 'upgrade') return privilegedPackageCommand(`pacman -S --noconfirm ${shellSingleQuote(name)}`);
      if (action === 'upgrade-all') return privilegedPackageCommand('pacman -Syu --noconfirm');
      return privilegedPackageCommand('pacman -Sy');
    case 'zypper':
      if (action === 'install') return privilegedPackageCommand(`zypper --non-interactive install ${shellSingleQuote(name)}`);
      if (action === 'remove') return privilegedPackageCommand(`zypper --non-interactive remove ${shellSingleQuote(name)}`);
      if (action === 'upgrade') return privilegedPackageCommand(`zypper --non-interactive update ${shellSingleQuote(name)}`);
      if (action === 'upgrade-all') return privilegedPackageCommand('zypper --non-interactive update');
      return privilegedPackageCommand('zypper --non-interactive refresh');
    case 'apk':
      if (action === 'install') return privilegedPackageCommand(`apk add ${shellSingleQuote(name)}`);
      if (action === 'remove') return privilegedPackageCommand(`apk del ${shellSingleQuote(name)}`);
      if (action === 'upgrade') return privilegedPackageCommand(`apk upgrade ${shellSingleQuote(name)}`);
      if (action === 'upgrade-all') return privilegedPackageCommand('apk upgrade');
      return privilegedPackageCommand('apk update');
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
      throw new Error(tCurrent('auto.packageProviders.15gqg90'));
  }
}

function parseAptUpgradable(line: string): RemotePackageInfo | null {
  const match = line.match(/^([^/]+)\/\S+\s+(\S+)\s+.*\[upgradable from:\s*([^\]]+)]/);
  if (!match) return null;
  return { name: match[1], latestVersion: match[2], version: match[3], installed: true, upgradable: true };
}

function parseApkPackageVersion(value: string) {
  const match = value.trim().match(/^(.+)-([0-9][^\s]*)$/);

  if (!match) {
    return null;
  }

  return {
    name: match[1],
    version: match[2],
  };
}

function normalizeApkAvailableVersion(name: string, value: string) {
  const availableVersion = value.trim();
  const packagePrefix = `${name}-`;

  return availableVersion.startsWith(packagePrefix)
    ? availableVersion.slice(packagePrefix.length)
    : availableVersion;
}

function splitPackageLine(line: string): string[] {
  return line.split(/\t+/).map((part) => part.trim()).filter(Boolean);
}

function tokenizePackageVersion(version: string) {
  return version
    .toLowerCase()
    .replace(/^[0-9]+:/, (epoch) => `${epoch.slice(0, -1)}.`)
    .match(/[0-9]+|[a-z]+/g) ?? [];
}

function comparePackageVersions(left: string | undefined, right: string | undefined) {
  const leftTokens = tokenizePackageVersion(left ?? '');
  const rightTokens = tokenizePackageVersion(right ?? '');
  const length = Math.max(leftTokens.length, rightTokens.length);

  for (let index = 0; index < length; index += 1) {
    const leftToken = leftTokens[index] ?? '';
    const rightToken = rightTokens[index] ?? '';

    if (leftToken === rightToken) {
      continue;
    }

    if (!leftToken) return -1;
    if (!rightToken) return 1;

    const leftIsNumber = /^\d+$/.test(leftToken);
    const rightIsNumber = /^\d+$/.test(rightToken);

    if (leftIsNumber && rightIsNumber) {
      const leftNumber = Number.parseInt(leftToken, 10);
      const rightNumber = Number.parseInt(rightToken, 10);

      if (leftNumber !== rightNumber) {
        return leftNumber > rightNumber ? 1 : -1;
      }

      if (leftToken.length !== rightToken.length) {
        return leftToken.length > rightToken.length ? 1 : -1;
      }

      continue;
    }

    if (leftIsNumber !== rightIsNumber) {
      return leftIsNumber ? 1 : -1;
    }

    return leftToken.localeCompare(rightToken);
  }

  return 0;
}

function getPackageCandidateVersion(pkg: RemotePackageInfo) {
  return pkg.latestVersion || pkg.version || '';
}

function shouldReplaceDuplicatePackage(current: RemotePackageInfo, candidate: RemotePackageInfo) {
  if (candidate.installed && !current.installed) {
    return true;
  }

  if (current.installed && !candidate.installed) {
    return false;
  }

  if (candidate.upgradable && !current.upgradable) {
    return true;
  }

  if (current.upgradable && !candidate.upgradable) {
    return false;
  }

  return comparePackageVersions(getPackageCandidateVersion(candidate), getPackageCandidateVersion(current)) > 0;
}

function dedupePackageList(packages: RemotePackageInfo[]) {
  const byName = new Map<string, RemotePackageInfo>();

  for (const pkg of packages) {
    const key = pkg.name.toLowerCase();
    const current = byName.get(key);

    if (!current || shouldReplaceDuplicatePackage(current, pkg)) {
      byName.set(key, pkg);
    }
  }

  return Array.from(byName.values());
}

function isPackageTableNoise(name: string) {
  return /^(\||Name|Listing|Loading|Available|Installed|Upgrades|Obsoleting|Obsoleted|Last|Security|Bugfix|Enhancement|\u53d6\u4ee3\u7684\u8f6f\u4ef6\u5305|\u53ef\u5347\u7ea7\u7684\u8f6f\u4ef6\u5305|\u5df2\u5b89\u88c5\u7684\u8f6f\u4ef6\u5305|\u53ef\u7528\u7684\u8f6f\u4ef6\u5305)/i.test(name);
}

function looksLikePackageName(name: string) {
  return /^[A-Za-z0-9][A-Za-z0-9+._:@/-]*$/.test(name);
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

  if ((kind === 'dnf' || kind === 'yum') && view === 'upgradable') {
    return dedupePackageList(lines.map((line) => {
      const parts = line.split('\t').map((part) => part.trim());
      const [name, version, latestVersion = '', description = ''] = parts;
      return {
        name,
        version: version === '-' ? '' : version,
        latestVersion,
        description,
        installed: true,
        upgradable: true,
      };
    }).filter((pkg) => Boolean(pkg.name) && !isPackageTableNoise(pkg.name) && looksLikePackageName(pkg.name)));
  }

  if ((kind === 'dnf' || kind === 'yum') && view === 'search') {
    return dedupePackageList(lines.map((line) => {
      const parts = line.split('\t').map((part) => part.trim());
      const [name, version, description = '', state = ''] = parts;
      return {
        name,
        version,
        description,
        installed: state === 'installed',
      };
    }).filter((pkg) => Boolean(pkg.name) && !isPackageTableNoise(pkg.name) && looksLikePackageName(pkg.name)));
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
      const tabParts = splitPackageLine(line);

      if (view === 'upgradable' && tabParts.length >= 3) {
        return {
          name: tabParts[0],
          version: tabParts[1],
          latestVersion: tabParts[2],
          description: tabParts.slice(3).join(' '),
          installed: true,
          upgradable: true,
        };
      }

      if (view === 'upgradable') {
        const parts = line.split(/\s+/);
        const relationIndex = parts.indexOf('<');
        const installedPackage = relationIndex > 0 ? parseApkPackageVersion(parts[relationIndex - 1]) : null;
        const availableVersion = installedPackage && parts[relationIndex + 1]
          ? normalizeApkAvailableVersion(installedPackage.name, parts[relationIndex + 1])
          : '';

        return {
          name: installedPackage?.name ?? '',
          version: installedPackage?.version,
          latestVersion: availableVersion,
          source: line,
          installed: true,
          upgradable: true,
        };
      }

      const [left, description = ''] = line.split(' - ');
      const match = parseApkPackageVersion(left);

      return {
        name: match?.name ?? left,
        version: match?.version,
        description,
        installed: view !== 'search',
      };
    }).filter((pkg) => Boolean(pkg.name) && !isPackageTableNoise(pkg.name) && looksLikePackageName(pkg.name));
  }

  return dedupePackageList(lines.map((line) => {
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
  }).filter((pkg) => Boolean(pkg.name) && !isPackageTableNoise(pkg.name) && looksLikePackageName(pkg.name)));
}
