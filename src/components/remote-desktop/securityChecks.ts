import { powershellCommand } from './remoteSystem';

export type SecuritySeverity = 'high' | 'medium' | 'low' | 'info';
export type SecurityStatus = 'passed' | 'warning' | 'failed' | 'unknown';

export interface SecurityCheckResult {
  id: string;
  title: string;
  severity: SecuritySeverity;
  status: SecurityStatus;
  summary: string;
  details: string[];
  rawOutput?: string;
  suggestions: string[];
}

export interface SecurityCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SecurityCheckDefinition {
  id: string;
  title: string;
  description: string;
  createCommand: () => string;
  evaluate: (result: SecurityCommandResult) => SecurityCheckResult;
}

const highRiskPorts = new Set(['22', '3389', '3306', '5432', '6379', '9200', '9300', '11211', '27017']);

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function raw(result: SecurityCommandResult) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function lines(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function createResult(
  id: string,
  title: string,
  severity: SecuritySeverity,
  status: SecurityStatus,
  summary: string,
  details: string[],
  suggestions: string[],
  result: SecurityCommandResult,
): SecurityCheckResult {
  return {
    id,
    title,
    severity,
    status,
    summary,
    details,
    suggestions,
    rawOutput: raw(result),
  };
}

function getSshConfigValue(output: string, key: string) {
  const match = output.match(new RegExp(`^${key}\\s+(.+)$`, 'im'));
  return match?.[1]?.trim().toLowerCase();
}

function evaluateSshConfig(result: SecurityCommandResult): SecurityCheckResult {
  const output = raw(result);

  if (!output) {
    return createResult(
      'ssh-config',
      'SSH 配置',
      'info',
      'unknown',
      '未读取到 SSH 配置。',
      ['目标主机可能未安装 OpenSSH Server，或当前用户没有读取权限。'],
      ['在远程终端执行 sshd -T 或检查 /etc/ssh/sshd_config。'],
      result,
    );
  }

  const permitRootLogin = getSshConfigValue(output, 'permitrootlogin') ?? '未知';
  const passwordAuthentication = getSshConfigValue(output, 'passwordauthentication') ?? '未知';
  const pubkeyAuthentication = getSshConfigValue(output, 'pubkeyauthentication') ?? '未知';
  const port = getSshConfigValue(output, 'port') ?? '未知';
  const risks: string[] = [];

  if (permitRootLogin === 'yes') risks.push('允许 root 直接登录');
  if (passwordAuthentication === 'yes') risks.push('允许密码登录');
  if (pubkeyAuthentication === 'no') risks.push('未启用公钥登录');

  const severity: SecuritySeverity = risks.some((risk) => risk.includes('root')) ? 'high' : risks.length ? 'medium' : 'info';
  const status: SecurityStatus = risks.length ? 'warning' : 'passed';

  return createResult(
    'ssh-config',
    'SSH 配置',
    severity,
    status,
    risks.length ? risks.join('，') : '未发现常见 SSH 登录配置风险。',
    [
      `PermitRootLogin: ${permitRootLogin}`,
      `PasswordAuthentication: ${passwordAuthentication}`,
      `PubkeyAuthentication: ${pubkeyAuthentication}`,
      `Port: ${port}`,
    ],
    risks.length
      ? ['优先禁用 root 直接登录，逐步关闭密码登录，并确认公钥登录可用。', '修改 sshd_config 后先使用 sshd -t 校验配置，再 reload sshd。']
      : ['保持最小登录面，并定期复查 sshd -T 输出。'],
    result,
  );
}

function evaluatePrivilegedUsers(result: SecurityCommandResult): SecurityCheckResult {
  const output = raw(result);
  const uidZeroUsers = lines(output).filter((line) => line.startsWith('UID0:')).map((line) => line.slice(5));
  const sudoLine = lines(output).find((line) => line.startsWith('SUDO:'))?.slice(5) ?? '';
  const wheelLine = lines(output).find((line) => line.startsWith('WHEEL:'))?.slice(6) ?? '';
  const adminsLine = lines(output).find((line) => line.startsWith('ADMINS:'))?.slice(7) ?? '';
  const adminText = [sudoLine, wheelLine, adminsLine].filter(Boolean).join(' / ');
  const extraRootUsers = uidZeroUsers.filter((line) => !line.startsWith('root:'));
  const hasBroadGroup = /[:,]\s*[^:\s,]+/.test(adminText);
  const status: SecurityStatus = extraRootUsers.length ? 'failed' : hasBroadGroup ? 'warning' : 'passed';
  const severity: SecuritySeverity = extraRootUsers.length ? 'high' : hasBroadGroup ? 'low' : 'info';

  return createResult(
    'privileged-users',
    '高权限账号',
    severity,
    status,
    extraRootUsers.length
      ? `发现 ${extraRootUsers.length} 个非 root UID 0 账号。`
      : hasBroadGroup
        ? '存在 sudo/wheel/admin 成员，请确认名单符合预期。'
        : '未发现额外 UID 0 账号。',
    [
      uidZeroUsers.length ? `UID 0: ${uidZeroUsers.join(' | ')}` : '未读取到 UID 0 异常。',
      adminText ? `高权限组: ${adminText}` : '未读取到 sudo/wheel/admin 成员。',
    ],
    ['核对 sudoers、sudo/wheel/admin 组成员和离职账号。', '避免为普通服务账号授予 UID 0 或长期管理员权限。'],
    result,
  );
}

function evaluateFailedLogins(result: SecurityCommandResult): SecurityCheckResult {
  const outputLines = lines(raw(result)).filter((line) => !/^(btmp|wtmp)\s+begins/i.test(line));
  const failedLines = outputLines.filter((line) => /(failed|invalid|authentication failure|ssh|pts|tty|notty|\d+\.\d+\.\d+\.\d+)/i.test(line));
  const count = failedLines.length;
  const uniqueSources = new Set(failedLines.map((line) => line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0]).filter(Boolean)).size;
  const severity: SecuritySeverity = count >= 20 || uniqueSources >= 6 ? 'high' : count >= 5 ? 'medium' : count > 0 ? 'low' : 'info';
  const status: SecurityStatus = count >= 20 ? 'failed' : count > 0 ? 'warning' : 'passed';

  return createResult(
    'failed-logins',
    '失败登录',
    severity,
    status,
    count ? `最近记录中有 ${count} 条失败登录，来源约 ${uniqueSources || '-'} 个。` : '未发现最近失败登录记录。',
    failedLines.slice(0, 8),
    count ? ['结合登录会话查看器确认来源 IP，必要时收紧 SSH 登录来源或启用 fail2ban。'] : ['继续保留失败登录审计日志。'],
    result,
  );
}

function evaluateOpenPorts(result: SecurityCommandResult): SecurityCheckResult {
  const outputLines = lines(raw(result));
  const riskyLines = outputLines.filter((line) => {
    const publicBind = /\b(0\.0\.0\.0|\[::\]|::):/.test(line) || /\*:\d+/.test(line);
    const portMatch = line.match(/(?::|LocalPort=)(\d{1,5})\b/i);
    return publicBind && portMatch && highRiskPorts.has(portMatch[1]);
  });
  const listenCount = outputLines.filter((line) => /LISTEN|LocalPort=|UDP/i.test(line)).length;
  const severity: SecuritySeverity = riskyLines.length ? 'medium' : 'info';
  const status: SecurityStatus = riskyLines.length ? 'warning' : 'passed';

  return createResult(
    'open-ports',
    '监听端口',
    severity,
    status,
    riskyLines.length ? `发现 ${riskyLines.length} 条公网监听的高敏感端口记录。` : `读取到 ${listenCount} 条监听/端口记录。`,
    riskyLines.length ? riskyLines.slice(0, 8) : outputLines.slice(0, 8),
    riskyLines.length
      ? ['确认数据库、缓存、管理端口是否只绑定内网或 localhost。', '使用防火墙管理器限制来源地址。']
      : ['继续保持最小暴露端口，新增服务后复查监听地址。'],
    result,
  );
}

function evaluateSensitivePermissions(result: SecurityCommandResult): SecurityCheckResult {
  const outputLines = lines(raw(result));
  const riskyLines = outputLines.filter((line) => {
    const modeMatch = line.match(/^(\d{3,4})\s+/);
    const path = line.split(/\s+/).slice(3).join(' ');
    const mode = modeMatch ? Number.parseInt(modeMatch[1].slice(-3), 8) : 0;
    const worldWritable = (mode & 0o002) !== 0;
    const groupWritable = (mode & 0o020) !== 0;
    const shadowReadable = path.includes('/etc/shadow') && (mode & 0o004) !== 0;
    return worldWritable || shadowReadable || (path.includes('authorized_keys') && groupWritable);
  });
  const severity: SecuritySeverity = riskyLines.length ? 'high' : 'info';
  const status: SecurityStatus = riskyLines.length ? 'failed' : 'passed';

  return createResult(
    'file-permissions',
    '敏感文件权限',
    severity,
    status,
    riskyLines.length ? `发现 ${riskyLines.length} 条敏感文件权限风险。` : '常见敏感文件权限未见明显风险。',
    riskyLines.length ? riskyLines : outputLines,
    riskyLines.length
      ? ['修正 /etc/shadow、authorized_keys 等敏感文件权限，避免组/其他用户写入。']
      : ['保持 /etc/shadow 和 SSH 授权文件的严格权限。'],
    result,
  );
}

function evaluateUpdates(result: SecurityCommandResult): SecurityCheckResult {
  const output = raw(result);
  const countMatch = output.match(/UPDATES:\s*(\d+)/i);
  const count = countMatch ? Number.parseInt(countMatch[1], 10) : 0;
  const unknown = !countMatch && result.code !== 0;
  const severity: SecuritySeverity = unknown ? 'info' : count >= 20 ? 'medium' : count > 0 ? 'low' : 'info';
  const status: SecurityStatus = unknown ? 'unknown' : count > 0 ? 'warning' : 'passed';

  return createResult(
    'updates',
    '系统更新',
    severity,
    status,
    unknown ? '未能判断系统更新状态。' : count ? `可能有 ${count} 个可更新包。` : '未检测到明显待更新包。',
    lines(output).slice(0, 12),
    count ? ['安排维护窗口更新安全补丁，并在更新前确认服务回滚方案。'] : ['定期刷新包管理器元数据并复查更新。'],
    result,
  );
}

function linuxSshCommand() {
  return `
if command -v sshd >/dev/null 2>&1; then
  sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|pubkeyauthentication|port)\\s+' || true
elif [ -f /etc/ssh/sshd_config ]; then
  grep -Ei '^\\s*(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|Port)\\s+' /etc/ssh/sshd_config | sed 's/^\\s*//'
else
  printf 'OpenSSH Server 配置未找到。\\n'
fi
`;
}

function linuxPrivilegedUsersCommand() {
  return `
getent passwd | awk -F: '($3 == 0) { print "UID0:" $0 }'
printf 'SUDO:'
getent group sudo 2>/dev/null || true
printf 'WHEEL:'
getent group wheel 2>/dev/null || true
`;
}

function linuxFailedLoginsCommand() {
  return `
if command -v lastb >/dev/null 2>&1; then
  lastb -n 30 2>&1 || true
elif command -v journalctl >/dev/null 2>&1; then
  journalctl -u ssh -u sshd -n 300 --no-pager 2>/dev/null | grep -Ei 'Failed password|Invalid user|authentication failure' | tail -n 30 || true
else
  printf '缺少 lastb 或 journalctl。\\n'
fi
`;
}

function linuxPortsCommand() {
  return `
if command -v ss >/dev/null 2>&1; then
  ss -H -tunlp 2>/dev/null || ss -H -tunl 2>/dev/null || true
elif command -v netstat >/dev/null 2>&1; then
  netstat -tunlp 2>/dev/null || netstat -tunl 2>/dev/null || true
else
  printf '缺少 ss 或 netstat。\\n'
fi
`;
}

function linuxPermissionsCommand() {
  return `
for target in /etc/passwd /etc/shadow "$HOME/.ssh/authorized_keys"; do
  if [ -e "$target" ]; then
    stat -c '%a %U %G %n' "$target" 2>/dev/null || ls -l "$target" 2>/dev/null
  else
    printf 'missing - - %s\\n' "$target"
  fi
done
`;
}

function linuxUpdatesCommand() {
  return `
if command -v apt >/dev/null 2>&1; then
  count=$(apt list --upgradable 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
  printf 'UPDATES:%s\\n' "$count"
elif command -v dnf >/dev/null 2>&1; then
  count=$(dnf check-update --quiet 2>/dev/null | awk 'NF >= 2 { c++ } END { print c+0 }')
  printf 'UPDATES:%s\\n' "$count"
elif command -v yum >/dev/null 2>&1; then
  count=$(yum check-update --quiet 2>/dev/null | awk 'NF >= 2 { c++ } END { print c+0 }')
  printf 'UPDATES:%s\\n' "$count"
elif command -v pacman >/dev/null 2>&1; then
  count=$(pacman -Qu 2>/dev/null | wc -l | tr -d ' ')
  printf 'UPDATES:%s\\n' "$count"
else
  printf '未识别支持的包管理器。\\n'
fi
`;
}

function windowsSshCommand() {
  return powershellCommand(`
$paths = @("$env:ProgramData\\ssh\\sshd_config", "$env:WINDIR\\System32\\OpenSSH\\sshd_config")
$path = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($path) {
  Get-Content $path | Where-Object { $_ -match '^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|Port)\\s+' }
} else {
  "OpenSSH Server 配置未找到。"
}
`);
}

function windowsAdminsCommand() {
  return powershellCommand(`
"ADMINS:"
Get-LocalGroupMember Administrators -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
`);
}

function windowsFailedLoginsCommand() {
  return powershellCommand(`
Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625; StartTime=(Get-Date).AddDays(-7)} -MaxEvents 30 -ErrorAction SilentlyContinue |
  ForEach-Object { "{0:u} {1}" -f $_.TimeCreated, (($_.Message -replace "\\s+", " ").Trim()) }
`);
}

function windowsPortsCommand() {
  return powershellCommand(`
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -First 120 | ForEach-Object {
  "LocalPort=$($_.LocalPort) LocalAddress=$($_.LocalAddress) OwningProcess=$($_.OwningProcess)"
}
`);
}

function windowsPermissionsCommand() {
  return powershellCommand(`
$paths = @("$env:ProgramData\\ssh\\administrators_authorized_keys", "$env:ProgramData\\ssh\\sshd_config")
foreach ($path in $paths) {
  if (Test-Path $path) {
    $acl = Get-Acl $path
    "$path owner=$($acl.Owner)"
    $acl.Access | ForEach-Object { "  $($_.IdentityReference): $($_.FileSystemRights) $($_.AccessControlType)" }
  } else {
    "missing - - $path"
  }
}
`);
}

function windowsUpdatesCommand() {
  return powershellCommand(`
"Windows Update 详细检查首版仅提示人工复查。"
"可在远程主机运行 Get-WindowsUpdateLog 或使用系统更新设置。"
`);
}

export function createSecurityCheckDefinitions(isWindowsHost: boolean): SecurityCheckDefinition[] {
  return [
    {
      id: 'ssh-config',
      title: 'SSH 配置',
      description: 'root 登录、密码登录、公钥登录和端口。',
      createCommand: isWindowsHost ? windowsSshCommand : linuxSshCommand,
      evaluate: evaluateSshConfig,
    },
    {
      id: 'privileged-users',
      title: '高权限账号',
      description: 'sudo、wheel、Administrators 和 UID 0 账号。',
      createCommand: isWindowsHost ? windowsAdminsCommand : linuxPrivilegedUsersCommand,
      evaluate: evaluatePrivilegedUsers,
    },
    {
      id: 'failed-logins',
      title: '失败登录',
      description: '最近失败认证记录和来源数量。',
      createCommand: isWindowsHost ? windowsFailedLoginsCommand : linuxFailedLoginsCommand,
      evaluate: evaluateFailedLogins,
    },
    {
      id: 'open-ports',
      title: '监听端口',
      description: '公网监听与高敏感端口摘要。',
      createCommand: isWindowsHost ? windowsPortsCommand : linuxPortsCommand,
      evaluate: evaluateOpenPorts,
    },
    {
      id: 'file-permissions',
      title: '敏感文件权限',
      description: 'SSH 授权文件、passwd、shadow 等权限。',
      createCommand: isWindowsHost ? windowsPermissionsCommand : linuxPermissionsCommand,
      evaluate: evaluateSensitivePermissions,
    },
    {
      id: 'updates',
      title: '系统更新',
      description: '包管理器或系统更新提示。',
      createCommand: isWindowsHost ? windowsUpdatesCommand : linuxUpdatesCommand,
      evaluate: evaluateUpdates,
    },
  ];
}

export function formatSecurityReport(results: SecurityCheckResult[], hostLabel: string, scannedAt: string) {
  const counts = {
    high: results.filter((result) => result.severity === 'high').length,
    medium: results.filter((result) => result.severity === 'medium').length,
    low: results.filter((result) => result.severity === 'low').length,
    info: results.filter((result) => result.severity === 'info').length,
  };

  return [
    `# ShellDesk 安全巡检报告`,
    '',
    `- 主机：${hostLabel || '当前连接'}`,
    `- 时间：${scannedAt || new Date().toLocaleString('zh-CN')}`,
    `- 风险：高 ${counts.high} / 中 ${counts.medium} / 低 ${counts.low} / 信息 ${counts.info}`,
    '',
    ...results.flatMap((result) => [
      `## ${result.title}`,
      '',
      `- 等级：${result.severity}`,
      `- 状态：${result.status}`,
      `- 摘要：${result.summary}`,
      '',
      ...result.details.map((detail) => `- ${detail}`),
      '',
      ...result.suggestions.map((suggestion) => `> ${suggestion}`),
      '',
    ]),
  ].join('\n');
}

export function getSeverityLabel(severity: SecuritySeverity) {
  if (severity === 'high') return '高';
  if (severity === 'medium') return '中';
  if (severity === 'low') return '低';
  return '信息';
}

export function getStatusLabel(status: SecurityStatus) {
  if (status === 'passed') return '通过';
  if (status === 'warning') return '注意';
  if (status === 'failed') return '风险';
  return '未知';
}

export function safeGrepPattern(value: string) {
  return shellSingleQuote(value.replace(/[^\w .:@/-]/g, ''));
}
