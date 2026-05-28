import { getShellDeskLocale } from './desktopUtils';
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

export interface SecurityScoreSummary {
  score: number | null;
  label: string;
  tone: 'idle' | 'good' | 'watch' | 'risk' | 'critical';
  deductions: string[];
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

function withoutPrefix(line: string, prefix: string) {
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

function hasPublicBind(line: string) {
  return /(^|\s)(0\.0\.0\.0|\[::\]|::|\*)[:\s]/.test(line)
    || /\bLocalAddress=(0\.0\.0\.0|::|\*)\b/i.test(line);
}

function getPortFromLine(line: string) {
  return line.match(/(?::|LocalPort=)(\d{1,5})\b/i)?.[1] ?? null;
}

function getPublicHighRiskPortLines(outputLines: string[]) {
  return outputLines.filter((line) => {
    const port = getPortFromLine(line);
    return hasPublicBind(line) && port && highRiskPorts.has(port);
  });
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
  const permitEmptyPasswords = getSshConfigValue(output, 'permitemptypasswords') ?? '未知';
  const maxAuthTries = getSshConfigValue(output, 'maxauthtries') ?? '未知';
  const allowTcpForwarding = getSshConfigValue(output, 'allowtcpforwarding') ?? '未知';
  const x11Forwarding = getSshConfigValue(output, 'x11forwarding') ?? '未知';
  const allowUsers = getSshConfigValue(output, 'allowusers') ?? '未限制';
  const allowGroups = getSshConfigValue(output, 'allowgroups') ?? '未限制';
  const port = getSshConfigValue(output, 'port') ?? '未知';
  const risks: string[] = [];
  const maxAuthTriesValue = Number.parseInt(maxAuthTries, 10);

  if (permitRootLogin === 'yes') risks.push('允许 root 直接登录');
  if (passwordAuthentication === 'yes') risks.push('允许密码登录');
  if (pubkeyAuthentication === 'no') risks.push('未启用公钥登录');
  if (permitEmptyPasswords === 'yes') risks.push('允许空密码登录');
  if (Number.isFinite(maxAuthTriesValue) && maxAuthTriesValue > 6) risks.push(`认证重试次数偏高：${maxAuthTriesValue}`);
  if (allowTcpForwarding === 'yes') risks.push('允许 TCP 转发');
  if (x11Forwarding === 'yes') risks.push('允许 X11 转发');

  const severity: SecuritySeverity = risks.some((risk) => risk.includes('root') || risk.includes('空密码')) ? 'high' : risks.length ? 'medium' : 'info';
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
      `PermitEmptyPasswords: ${permitEmptyPasswords}`,
      `MaxAuthTries: ${maxAuthTries}`,
      `AllowTcpForwarding: ${allowTcpForwarding}`,
      `X11Forwarding: ${x11Forwarding}`,
      `AllowUsers: ${allowUsers}`,
      `AllowGroups: ${allowGroups}`,
      `Port: ${port}`,
    ],
    risks.length
      ? ['优先禁用 root 直接登录和空密码，逐步关闭密码登录，并确认公钥登录可用。', '按需关闭 TCP/X11 转发，限制 AllowUsers/AllowGroups。', '修改 sshd_config 后先使用 sshd -t 校验配置，再 reload sshd。']
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

function evaluateAccountPosture(result: SecurityCommandResult): SecurityCheckResult {
  const outputLines = lines(raw(result));
  const loginUsers = outputLines.filter((line) => line.startsWith('LOGIN_USER:')).map((line) => line.slice('LOGIN_USER:'.length));
  const localUsers = outputLines.filter((line) => line.startsWith('LOCAL_USER:')).map((line) => line.slice('LOCAL_USER:'.length));
  const emptyPasswordUsers = outputLines.filter((line) => line.startsWith('EMPTY_PASSWORD:')).map((line) => line.slice('EMPTY_PASSWORD:'.length));
  const passwordOptionalUsers = localUsers.filter((line) => /PasswordRequired=False/i.test(line));
  const nopasswdLines = outputLines.filter((line) => line.startsWith('NOPASSWD:')).map((line) => line.slice('NOPASSWD:'.length));
  const authorizedKeyLines = outputLines.filter((line) => line.startsWith('AUTHORIZED_KEYS:')).map((line) => line.slice('AUTHORIZED_KEYS:'.length));
  const shadowReadable = !outputLines.some((line) => line === 'SHADOW:unreadable');
  const broadKeyFiles = authorizedKeyLines.filter((line) => {
    const mode = line.match(/^\S+:\d+:(\d{3,4})\s/)?.[1];
    if (!mode) return false;
    const parsedMode = Number.parseInt(mode.slice(-3), 8);
    return (parsedMode & 0o022) !== 0;
  });
  const largeKeyFiles = authorizedKeyLines.filter((line) => {
    const count = Number.parseInt(line.match(/^\S+:(\d+):/)?.[1] ?? '0', 10);
    return count >= 10;
  });
  const interactiveSystemUsers = loginUsers.filter((line) => {
    const uid = Number.parseInt(line.split(':')[1] ?? '', 10);
    return Number.isFinite(uid) && uid > 0 && uid < 1000;
  });
  const highRisk = emptyPasswordUsers.length + passwordOptionalUsers.length + broadKeyFiles.length;
  const mediumRisk = nopasswdLines.length;
  const lowRisk = largeKeyFiles.length + interactiveSystemUsers.length;
  const severity: SecuritySeverity = highRisk ? 'high' : mediumRisk ? 'medium' : lowRisk ? 'low' : 'info';
  const status: SecurityStatus = highRisk ? 'failed' : mediumRisk || lowRisk ? 'warning' : 'passed';

  return createResult(
    'account-keys',
    '账号与密钥',
    severity,
    status,
    highRisk
      ? `发现 ${highRisk} 个账号或授权密钥高风险。`
      : mediumRisk || lowRisk
        ? `发现 ${mediumRisk + lowRisk} 个账号/密钥加固项。`
        : '未发现明显账号与授权密钥风险。',
    [
      emptyPasswordUsers.length ? `空密码账号: ${emptyPasswordUsers.join('、')}` : shadowReadable ? '未发现空密码账号。' : '当前用户无法读取 shadow，空密码检查受限。',
      passwordOptionalUsers.length ? `Windows 账号未强制密码: ${passwordOptionalUsers.slice(0, 8).join(' | ')}` : localUsers.length ? 'Windows 本地账号均要求密码。' : `可登录 Shell 账号: ${loginUsers.length || 0} 个。`,
      authorizedKeyLines.length ? `authorized_keys: ${authorizedKeyLines.slice(0, 8).join(' | ')}` : '未发现当前可读取的 authorized_keys 文件。',
      nopasswdLines.length ? `NOPASSWD sudo: ${nopasswdLines.slice(0, 6).join(' | ')}` : '未发现 NOPASSWD sudo 规则。',
      interactiveSystemUsers.length ? `可登录系统账号: ${interactiveSystemUsers.slice(0, 6).join(' | ')}` : '未发现可登录的低 UID 服务账号。',
    ],
    highRisk
      ? ['立即处理空密码账号和过宽的 authorized_keys 权限。', '授权密钥文件建议使用 600，.ssh 目录建议使用 700。']
      : ['定期清理离职人员密钥、过期账号和不再使用的 sudo 免密规则。'],
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
  const riskyLines = getPublicHighRiskPortLines(outputLines);
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

function getProcessCpuValue(line: string) {
  const linuxMatch = line.match(/^\s*\d+\s+\d+\s+\S+\s+([\d.]+)\s+[\d.]+\s+\S+\s+/);
  const windowsMatch = line.match(/\bCPU=([\d.]+)/i);
  const value = linuxMatch?.[1] ?? windowsMatch?.[1];
  const parsedValue = value ? Number.parseFloat(value) : Number.NaN;

  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

function getProcessMemoryValue(line: string) {
  const linuxMatch = line.match(/^\s*\d+\s+\d+\s+\S+\s+[\d.]+\s+([\d.]+)\s+\S+\s+/);
  const windowsMatch = line.match(/\bWS_MB=([\d.]+)/i);
  const value = linuxMatch?.[1] ?? windowsMatch?.[1];
  const parsedValue = value ? Number.parseFloat(value) : Number.NaN;

  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

function isSuspiciousProcessLine(line: string) {
  return /(xmrig|kinsing|kdevtmpfsi|cryptonight|masscan|\/tmp\/|\/var\/tmp\/|\/dev\/shm\/|\/run\/user\/\d+\/|\\appdata\\local\\temp\\|\\windows\\temp\\|\\users\\public\\|encodedcommand|\s-enc\s|downloadstring|invoke-webrequest|certutil\s+.*-decode|bitsadmin|mshta|regsvr32|rundll32|nc\s+-e|socat\s+.*exec|bash\s+-i|\/dev\/tcp|python\s+-c|perl\s+-e|php\s+-r)/i.test(line);
}

function evaluateProcessAnalysis(result: SecurityCommandResult): SecurityCheckResult {
  const outputLines = lines(raw(result));
  const processLines = outputLines
    .filter((line) => line.startsWith('PROC:'))
    .map((line) => line.slice('PROC:'.length).trim())
    .filter(Boolean);
  const portLines = outputLines
    .filter((line) => line.startsWith('PORT_PROC:'))
    .map((line) => line.slice('PORT_PROC:'.length).trim())
    .filter(Boolean);
  const suspiciousLines = processLines.filter(isSuspiciousProcessLine);
  const highCpuLines = processLines.filter((line) => getProcessCpuValue(line) >= 80);
  const highMemoryLines = processLines.filter((line) => {
    const memoryValue = getProcessMemoryValue(line);
    return /\bWS_MB=/i.test(line) ? memoryValue >= 4096 : memoryValue >= 50;
  });
  const riskyPortLines = getPublicHighRiskPortLines(portLines);
  const severity: SecuritySeverity = suspiciousLines.length
    ? 'high'
    : highCpuLines.length || highMemoryLines.length || riskyPortLines.length
      ? 'medium'
      : 'info';
  const status: SecurityStatus = suspiciousLines.length ? 'failed' : severity === 'medium' ? 'warning' : 'passed';

  return createResult(
    'process-analysis',
    '进程分析',
    severity,
    status,
    suspiciousLines.length
      ? `发现 ${suspiciousLines.length} 条可疑进程特征。`
      : highCpuLines.length || highMemoryLines.length || riskyPortLines.length
        ? `发现 ${highCpuLines.length + highMemoryLines.length + riskyPortLines.length} 条需要复核的进程/端口线索。`
        : `采样 ${processLines.length} 个进程，未发现明显异常进程特征。`,
    [
      processLines.length ? `进程采样: ${processLines.length} 条。` : '未读取到进程采样。',
      suspiciousLines.length ? `可疑进程: ${suspiciousLines.slice(0, 8).join(' | ')}` : '未命中常见挖矿、临时目录执行、反弹 Shell 或高风险脚本特征。',
      highCpuLines.length ? `高 CPU: ${highCpuLines.slice(0, 6).join(' | ')}` : '未发现单进程 CPU 采样超过 80%。',
      highMemoryLines.length ? `高内存: ${highMemoryLines.slice(0, 6).join(' | ')}` : '未发现明显高内存进程采样。',
      riskyPortLines.length ? `公网高敏感端口进程: ${riskyPortLines.slice(0, 6).join(' | ')}` : '未发现公网高敏感端口与进程采样联动异常。',
    ],
    status === 'passed'
      ? ['保持基线进程清单，服务变更后复查进程路径、启动参数和监听端口。']
      : ['优先核验可疑进程的可执行路径、父进程、启动时间和文件签名/包来源。', '不要直接结束业务进程；先确认服务归属、保留现场输出，并结合进程管理器查看端口和命令行。'],
    result,
  );
}

function evaluateFirewallExposure(result: SecurityCommandResult): SecurityCheckResult {
  const outputLines = lines(raw(result));
  const provider = outputLines.find((line) => line.startsWith('FIREWALL_PROVIDER:'))?.slice('FIREWALL_PROVIDER:'.length) ?? 'unknown';
  const firewallLines = outputLines
    .filter((line) => line.startsWith('FIREWALL_LINE:') || line.startsWith('FIREWALL_PROFILE:'))
    .map((line) => withoutPrefix(withoutPrefix(line, 'FIREWALL_LINE:'), 'FIREWALL_PROFILE:'));
  const portLines = outputLines
    .filter((line) => line.startsWith('PORT_LINE:'))
    .map((line) => line.slice('PORT_LINE:'.length));
  const riskyPortLines = getPublicHighRiskPortLines(portLines);
  const disabledFirewallLines = firewallLines.filter((line) => /inactive|not running|disabled|Enabled=False|DefaultInbound=Allow|-P INPUT ACCEPT/i.test(line));
  const noFirewall = provider === 'none' || firewallLines.some((line) => /provider=none/i.test(line));
  const riskyFirewall = noFirewall || disabledFirewallLines.length > 0;
  const severity: SecuritySeverity = riskyFirewall && riskyPortLines.length ? 'high' : riskyFirewall || riskyPortLines.length ? 'medium' : 'info';
  const status: SecurityStatus = riskyFirewall && riskyPortLines.length ? 'failed' : riskyFirewall || riskyPortLines.length ? 'warning' : 'passed';

  return createResult(
    'firewall-exposure',
    '防火墙暴露',
    severity,
    status,
    riskyFirewall && riskyPortLines.length
      ? `防火墙未完全收敛，且发现 ${riskyPortLines.length} 条公网高敏感端口。`
      : riskyFirewall
        ? '防火墙状态可能未启用或入站策略过宽。'
        : riskyPortLines.length
          ? `发现 ${riskyPortLines.length} 条公网高敏感端口，请确认防火墙来源限制。`
          : '防火墙状态和公网高敏感端口未见明显异常。',
    [
      `防火墙: ${provider}`,
      disabledFirewallLines.length ? `异常策略: ${disabledFirewallLines.slice(0, 6).join(' | ')}` : '未发现明显禁用或放行所有入站的防火墙策略。',
      riskyPortLines.length ? `公网高敏感端口: ${riskyPortLines.slice(0, 8).join(' | ')}` : '未发现公网监听的高敏感端口。',
      portLines.length ? `监听采样: ${portLines.slice(0, 5).join(' | ')}` : '未读取到监听端口采样。',
    ],
    status === 'passed'
      ? ['继续保持默认拒绝入站，新增服务后复查来源限制。']
      : ['优先确认数据库、缓存、管理端口是否仅允许内网或堡垒机来源。', '在 ShellDesk 防火墙组件中收敛入站规则，并保留当前 SSH 管理来源。'],
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

function evaluatePrivilegeSurface(result: SecurityCommandResult): SecurityCheckResult {
  const outputLines = lines(raw(result));
  const suidLines = outputLines.filter((line) => line.startsWith('SUID:')).map((line) => line.slice('SUID:'.length));
  const worldWritableLines = outputLines.filter((line) => line.startsWith('WORLD_WRITABLE:')).map((line) => line.slice('WORLD_WRITABLE:'.length));
  const unquotedServices = outputLines.filter((line) => line.startsWith('UNQUOTED_SERVICE:')).map((line) => line.slice('UNQUOTED_SERVICE:'.length));
  const severity: SecuritySeverity = worldWritableLines.length ? 'high' : unquotedServices.length ? 'medium' : suidLines.length > 40 ? 'low' : 'info';
  const status: SecurityStatus = worldWritableLines.length ? 'failed' : unquotedServices.length || suidLines.length > 40 ? 'warning' : 'passed';

  return createResult(
    'privilege-surface',
    '提权面',
    severity,
    status,
    worldWritableLines.length
      ? `发现 ${worldWritableLines.length} 条全局可写敏感路径。`
      : unquotedServices.length
        ? `发现 ${unquotedServices.length} 个未引号包裹的 Windows 服务路径。`
        : suidLines.length > 40
          ? `SUID/SGID 文件数量偏多：${suidLines.length} 个。`
          : '未发现明显本地提权面异常。',
    [
      worldWritableLines.length ? `全局可写: ${worldWritableLines.slice(0, 8).join(' | ')}` : '未发现全局可写敏感路径。',
      unquotedServices.length ? `未引号服务路径: ${unquotedServices.slice(0, 8).join(' | ')}` : '未发现未引号包裹的服务路径。',
      suidLines.length ? `SUID/SGID 采样: ${suidLines.slice(0, 10).join(' | ')}` : '未读取到 SUID/SGID 采样。',
    ],
    status === 'passed'
      ? ['保留最小 SUID 集合，并定期复查服务安装变更。']
      : ['修正全局可写敏感文件，删除不必要的 SUID/SGID 位。', 'Windows 服务路径包含空格时应使用引号包裹可执行文件路径。'],
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
  sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|pubkeyauthentication|permitemptypasswords|maxauthtries|allowtcpforwarding|x11forwarding|allowusers|allowgroups|port)\\s+' || true
elif [ -f /etc/ssh/sshd_config ]; then
  grep -Ei '^\\s*(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|PermitEmptyPasswords|MaxAuthTries|AllowTcpForwarding|X11Forwarding|AllowUsers|AllowGroups|Port)\\s+' /etc/ssh/sshd_config | sed 's/^\\s*//'
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

function linuxAccountPostureCommand() {
  return `
getent passwd | awk -F: '($7 !~ /(nologin|false|sync|shutdown|halt)$/) { print "LOGIN_USER:" $1 ":" $3 ":" $6 ":" $7 }'
if [ -r /etc/shadow ]; then
  awk -F: '($2 == "") { print "EMPTY_PASSWORD:" $1 }' /etc/shadow
else
  printf 'SHADOW:unreadable\\n'
fi
for home in /root /home/*; do
  [ -d "$home" ] || continue
  user="$(basename "$home")"
  [ "$home" = "/root" ] && user=root
  file="$home/.ssh/authorized_keys"
  if [ -f "$file" ]; then
    count="$(grep -cv '^[[:space:]]*\\(#\\|$\\)' "$file" 2>/dev/null || printf 0)"
    meta="$(stat -c '%a %U %G %n' "$file" 2>/dev/null || printf 'unknown - - %s' "$file")"
    printf 'AUTHORIZED_KEYS:%s:%s:%s\\n' "$user" "$count" "$meta"
  fi
done
grep -Rhs 'NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null | head -20 | sed 's/^/NOPASSWD:/' || true
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

function linuxProcessAnalysisCommand() {
  return `
if command -v ps >/dev/null 2>&1; then
  ps -eo pid=,ppid=,user=,pcpu=,pmem=,stat=,args= --sort=-pcpu 2>/dev/null | head -120 | sed 's/^/PROC:/'
else
  printf 'PROCESS:ps unavailable\\n'
fi
if command -v ss >/dev/null 2>&1; then
  ss -H -tunlp 2>/dev/null | head -100 | sed 's/^/PORT_PROC:/'
elif command -v netstat >/dev/null 2>&1; then
  netstat -tunlp 2>/dev/null | head -100 | sed 's/^/PORT_PROC:/'
fi
`;
}

function linuxFirewallExposureCommand() {
  return `
if command -v ufw >/dev/null 2>&1; then
  printf 'FIREWALL_PROVIDER:ufw\\n'
  ufw status verbose 2>&1 | sed 's/^/FIREWALL_LINE:/'
elif command -v firewall-cmd >/dev/null 2>&1; then
  printf 'FIREWALL_PROVIDER:firewalld\\n'
  firewall-cmd --state 2>&1 | sed 's/^/FIREWALL_LINE:/'
  firewall-cmd --list-all 2>&1 | head -80 | sed 's/^/FIREWALL_LINE:/'
elif command -v iptables >/dev/null 2>&1; then
  printf 'FIREWALL_PROVIDER:iptables\\n'
  iptables -S 2>/dev/null | head -80 | sed 's/^/FIREWALL_LINE:/'
else
  printf 'FIREWALL_PROVIDER:none\\n'
fi
if command -v ss >/dev/null 2>&1; then
  ss -H -tunlp 2>/dev/null || ss -H -tunl 2>/dev/null || true
elif command -v netstat >/dev/null 2>&1; then
  netstat -tunlp 2>/dev/null || netstat -tunl 2>/dev/null || true
fi | sed 's/^/PORT_LINE:/'
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

function linuxPrivilegeSurfaceCommand() {
  return `
if command -v find >/dev/null 2>&1; then
  find /usr/bin /usr/sbin /bin /sbin -xdev \\( -perm -4000 -o -perm -2000 \\) -type f -printf 'SUID:%m %u %g %p\\n' 2>/dev/null | head -80
  find /etc /etc/cron.d /var/spool/cron -xdev -type f -perm -0002 -printf 'WORLD_WRITABLE:%m %u %g %p\\n' 2>/dev/null | head -40
else
  printf 'PRIV_ESC:find unavailable\\n'
fi
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
  Get-Content $path | Where-Object { $_ -match '^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|PermitEmptyPasswords|MaxAuthTries|AllowTcpForwarding|X11Forwarding|AllowUsers|AllowGroups|Port)\\s+' }
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

function windowsAccountPostureCommand() {
  return powershellCommand(`
Get-LocalUser -ErrorAction SilentlyContinue | ForEach-Object {
  "LOCAL_USER:$($_.Name):Enabled=$($_.Enabled):PasswordRequired=$($_.PasswordRequired):LastLogon=$($_.LastLogon)"
}
$adminKey = "$env:ProgramData\\ssh\\administrators_authorized_keys"
if (Test-Path $adminKey) {
  $count = (Get-Content $adminKey -ErrorAction SilentlyContinue | Where-Object { $_ -and ($_ -notmatch '^\\s*#') }).Count
  "AUTHORIZED_KEYS:Administrators:$($count):$adminKey"
}
Get-LocalGroupMember Administrators -ErrorAction SilentlyContinue | ForEach-Object {
  "LOCAL_ADMIN:$($_.Name)"
}
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

function windowsProcessAnalysisCommand() {
  return powershellCommand(`
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Sort-Object -Property WorkingSetSize -Descending |
  Select-Object -First 120 |
  ForEach-Object {
    $path = if ($_.ExecutablePath) { $_.ExecutablePath } else { "-" }
    $command = if ($_.CommandLine) { ($_.CommandLine -replace "\\s+", " ").Trim() } else { $_.Name }
    $workingSetMb = if ($_.WorkingSetSize) { [math]::Round($_.WorkingSetSize / 1MB, 1) } else { 0 }
    "PROC:PID=$($_.ProcessId) PPID=$($_.ParentProcessId) Name=$($_.Name) WS_MB=$workingSetMb Path=$path Command=$command"
  }
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 100 |
  ForEach-Object {
    "PORT_PROC:LocalPort=$($_.LocalPort) LocalAddress=$($_.LocalAddress) OwningProcess=$($_.OwningProcess)"
  }
`);
}

function windowsFirewallExposureCommand() {
  return powershellCommand(`
"FIREWALL_PROVIDER:windows"
Get-NetFirewallProfile -ErrorAction SilentlyContinue | ForEach-Object {
  "FIREWALL_PROFILE:$($_.Name):Enabled=$($_.Enabled):DefaultInbound=$($_.DefaultInboundAction)"
}
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object -First 120 | ForEach-Object {
  "PORT_LINE:LocalPort=$($_.LocalPort) LocalAddress=$($_.LocalAddress) OwningProcess=$($_.OwningProcess)"
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

function windowsPrivilegeSurfaceCommand() {
  return powershellCommand(`
Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
  Where-Object { $_.PathName -match '\\s' -and $_.PathName -notmatch '^"' } |
  Select-Object -First 40 |
  ForEach-Object { "UNQUOTED_SERVICE:$($_.Name):$($_.PathName)" }
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
      description: '登录方式、空密码、转发、重试和端口。',
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
      id: 'account-keys',
      title: '账号与密钥',
      description: '空密码、authorized_keys、sudo 免密和可登录账号。',
      createCommand: isWindowsHost ? windowsAccountPostureCommand : linuxAccountPostureCommand,
      evaluate: evaluateAccountPosture,
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
      id: 'process-analysis',
      title: '进程分析',
      description: '进程路径、命令行、资源占用和监听归属。',
      createCommand: isWindowsHost ? windowsProcessAnalysisCommand : linuxProcessAnalysisCommand,
      evaluate: evaluateProcessAnalysis,
    },
    {
      id: 'firewall-exposure',
      title: '防火墙暴露',
      description: '防火墙状态与公网高敏感端口联动。',
      createCommand: isWindowsHost ? windowsFirewallExposureCommand : linuxFirewallExposureCommand,
      evaluate: evaluateFirewallExposure,
    },
    {
      id: 'file-permissions',
      title: '敏感文件权限',
      description: 'SSH 授权文件、passwd、shadow 等权限。',
      createCommand: isWindowsHost ? windowsPermissionsCommand : linuxPermissionsCommand,
      evaluate: evaluateSensitivePermissions,
    },
    {
      id: 'privilege-surface',
      title: '提权面',
      description: 'SUID/SGID、全局可写路径和服务路径风险。',
      createCommand: isWindowsHost ? windowsPrivilegeSurfaceCommand : linuxPrivilegeSurfaceCommand,
      evaluate: evaluatePrivilegeSurface,
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

function getScorePenalty(result: SecurityCheckResult) {
  if (result.status === 'passed') return 0;

  if (result.status === 'unknown') {
    return 2;
  }

  if (result.status === 'failed') {
    if (result.severity === 'high') return 25;
    if (result.severity === 'medium') return 18;
    if (result.severity === 'low') return 10;
    return 6;
  }

  if (result.severity === 'high') return 20;
  if (result.severity === 'medium') return 12;
  if (result.severity === 'low') return 6;
  return 3;
}

export function calculateSecurityScore(results: SecurityCheckResult[]): SecurityScoreSummary {
  if (!results.length) {
    return {
      score: null,
      label: '未评分',
      tone: 'idle',
      deductions: [],
    };
  }

  const deductions = results
    .map((result) => ({ result, penalty: getScorePenalty(result) }))
    .filter((item) => item.penalty > 0);
  const score = Math.max(0, 100 - deductions.reduce((total, item) => total + item.penalty, 0));
  const tone: SecurityScoreSummary['tone'] = score >= 90 ? 'good' : score >= 75 ? 'watch' : score >= 60 ? 'risk' : 'critical';
  const label = score >= 90 ? '良好' : score >= 75 ? '需关注' : score >= 60 ? '需加固' : '高风险';

  return {
    score,
    label,
    tone,
    deductions: deductions.map((item) => `${item.result.title} -${item.penalty}: ${item.result.summary}`),
  };
}

export function formatSecurityReport(results: SecurityCheckResult[], hostLabel: string, scannedAt: string) {
  const counts = {
    high: results.filter((result) => result.severity === 'high').length,
    medium: results.filter((result) => result.severity === 'medium').length,
    low: results.filter((result) => result.severity === 'low').length,
    info: results.filter((result) => result.severity === 'info').length,
  };
  const score = calculateSecurityScore(results);

  return [
    `# ShellDesk 安全巡检报告`,
    '',
    `- 主机：${hostLabel || '当前连接'}`,
    `- 时间：${scannedAt || new Date().toLocaleString(getShellDeskLocale())}`,
    `- 安全评分：${score.score ?? '--'}（${score.label}）`,
    `- 风险：高 ${counts.high} / 中 ${counts.medium} / 低 ${counts.low} / 信息 ${counts.info}`,
    score.deductions.length ? `- 扣分项：${score.deductions.slice(0, 6).join('；')}` : '- 扣分项：无明显扣分项',
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
