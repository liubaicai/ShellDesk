import { getShellDeskLocale } from './desktopUtils';
import { t, type AppLanguage } from '../../i18n';
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

function evaluateSshConfig(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
  const output = raw(result);

  if (!output) {
    return createResult(
      'ssh-config',
      t('securityCheck.definition.ssh.title', language),
      'info',
      'unknown',
      t('securityCheck.ssh.noConfig.summary', language),
      [t('securityCheck.ssh.noConfig.detail', language)],
      [t('securityCheck.ssh.noConfig.suggestion', language)],
      result,
    );
  }

  const unknown = t('securityCheck.common.unknown', language);
  const unrestricted = t('securityCheck.common.unrestricted', language);
  const permitRootLogin = getSshConfigValue(output, 'permitrootlogin') ?? unknown;
  const passwordAuthentication = getSshConfigValue(output, 'passwordauthentication') ?? unknown;
  const pubkeyAuthentication = getSshConfigValue(output, 'pubkeyauthentication') ?? unknown;
  const permitEmptyPasswords = getSshConfigValue(output, 'permitemptypasswords') ?? unknown;
  const maxAuthTries = getSshConfigValue(output, 'maxauthtries') ?? unknown;
  const allowTcpForwarding = getSshConfigValue(output, 'allowtcpforwarding') ?? unknown;
  const x11Forwarding = getSshConfigValue(output, 'x11forwarding') ?? unknown;
  const allowUsers = getSshConfigValue(output, 'allowusers') ?? unrestricted;
  const allowGroups = getSshConfigValue(output, 'allowgroups') ?? unrestricted;
  const port = getSshConfigValue(output, 'port') ?? unknown;
  const risks: string[] = [];
  const maxAuthTriesValue = Number.parseInt(maxAuthTries, 10);

  if (permitRootLogin === 'yes') risks.push(t('securityCheck.ssh.risk.rootLogin', language));
  if (passwordAuthentication === 'yes') risks.push(t('securityCheck.ssh.risk.passwordLogin', language));
  if (pubkeyAuthentication === 'no') risks.push(t('securityCheck.ssh.risk.noPubkey', language));
  if (permitEmptyPasswords === 'yes') risks.push(t('securityCheck.ssh.risk.emptyPasswords', language));
  if (Number.isFinite(maxAuthTriesValue) && maxAuthTriesValue > 6) risks.push(t('securityCheck.ssh.risk.maxAuthTries', language, { count: maxAuthTriesValue }));
  if (allowTcpForwarding === 'yes') risks.push(t('securityCheck.ssh.risk.tcpForwarding', language));
  if (x11Forwarding === 'yes') risks.push(t('securityCheck.ssh.risk.x11Forwarding', language));

  const severity: SecuritySeverity = permitRootLogin === 'yes' || permitEmptyPasswords === 'yes' ? 'high' : risks.length ? 'medium' : 'info';
  const status: SecurityStatus = risks.length ? 'warning' : 'passed';

  return createResult(
    'ssh-config',
    t('securityCheck.definition.ssh.title', language),
    severity,
    status,
    risks.length ? risks.join(language === 'zh-CN' ? '，' : ', ') : t('securityCheck.ssh.summary.ok', language),
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
      ? [
          t('securityCheck.ssh.suggestion.risky1', language),
          t('securityCheck.ssh.suggestion.risky2', language),
          t('securityCheck.ssh.suggestion.risky3', language),
        ]
      : [t('securityCheck.ssh.suggestion.ok', language)],
    result,
  );
}

function evaluatePrivilegedUsers(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
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
    t('securityCheck.definition.privilegedUsers.title', language),
    severity,
    status,
    extraRootUsers.length
      ? t('securityCheck.privileged.summary.extraRoot', language, { count: extraRootUsers.length })
      : hasBroadGroup
        ? t('securityCheck.privileged.summary.broadGroup', language)
        : t('securityCheck.privileged.summary.ok', language),
    [
      uidZeroUsers.length ? `UID 0: ${uidZeroUsers.join(' | ')}` : t('securityCheck.privileged.detail.uid0None', language),
      adminText ? t('securityCheck.privileged.detail.group', language, { group: adminText }) : t('securityCheck.privileged.detail.groupNone', language),
    ],
    [t('securityCheck.privileged.suggestion.review', language), t('securityCheck.privileged.suggestion.limit', language)],
    result,
  );
}

function evaluateAccountPosture(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
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
    t('securityCheck.definition.accountKeys.title', language),
    severity,
    status,
    highRisk
      ? t('securityCheck.account.summary.high', language, { count: highRisk })
      : mediumRisk || lowRisk
        ? t('securityCheck.account.summary.hardening', language, { count: mediumRisk + lowRisk })
        : t('securityCheck.account.summary.ok', language),
    [
      emptyPasswordUsers.length
        ? t('securityCheck.account.detail.emptyPassword', language, { users: emptyPasswordUsers.join(language === 'zh-CN' ? '、' : ', ') })
        : shadowReadable ? t('securityCheck.account.detail.emptyPasswordNone', language) : t('securityCheck.account.detail.shadowLimited', language),
      passwordOptionalUsers.length
        ? t('securityCheck.account.detail.passwordOptional', language, { users: passwordOptionalUsers.slice(0, 8).join(' | ') })
        : localUsers.length ? t('securityCheck.account.detail.passwordRequired', language) : t('securityCheck.account.detail.loginUsers', language, { count: loginUsers.length || 0 }),
      authorizedKeyLines.length
        ? t('securityCheck.account.detail.authorizedKeys', language, { files: authorizedKeyLines.slice(0, 8).join(' | ') })
        : t('securityCheck.account.detail.authorizedKeysNone', language),
      nopasswdLines.length
        ? t('securityCheck.account.detail.nopasswd', language, { rules: nopasswdLines.slice(0, 6).join(' | ') })
        : t('securityCheck.account.detail.nopasswdNone', language),
      interactiveSystemUsers.length
        ? t('securityCheck.account.detail.interactiveSystemUsers', language, { users: interactiveSystemUsers.slice(0, 6).join(' | ') })
        : t('securityCheck.account.detail.interactiveSystemUsersNone', language),
    ],
    highRisk
      ? [t('securityCheck.account.suggestion.high1', language), t('securityCheck.account.suggestion.high2', language)]
      : [t('securityCheck.account.suggestion.normal', language)],
    result,
  );
}

function evaluateFailedLogins(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
  const outputLines = lines(raw(result)).filter((line) => !/^(btmp|wtmp)\s+begins/i.test(line));
  const failedLines = outputLines.filter((line) => /(failed|invalid|authentication failure|ssh|pts|tty|notty|\d+\.\d+\.\d+\.\d+)/i.test(line));
  const count = failedLines.length;
  const uniqueSources = new Set(failedLines.map((line) => line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0]).filter(Boolean)).size;
  const severity: SecuritySeverity = count >= 20 || uniqueSources >= 6 ? 'high' : count >= 5 ? 'medium' : count > 0 ? 'low' : 'info';
  const status: SecurityStatus = count >= 20 ? 'failed' : count > 0 ? 'warning' : 'passed';

  return createResult(
    'failed-logins',
    t('securityCheck.definition.failedLogins.title', language),
    severity,
    status,
    count
      ? t('securityCheck.failedLogins.summary.count', language, { count, sources: uniqueSources || '-' })
      : t('securityCheck.failedLogins.summary.none', language),
    failedLines.slice(0, 8),
    count ? [t('securityCheck.failedLogins.suggestion.review', language)] : [t('securityCheck.failedLogins.suggestion.keepLogs', language)],
    result,
  );
}

function evaluateOpenPorts(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
  const outputLines = lines(raw(result));
  const riskyLines = getPublicHighRiskPortLines(outputLines);
  const listenCount = outputLines.filter((line) => /LISTEN|LocalPort=|UDP/i.test(line)).length;
  const severity: SecuritySeverity = riskyLines.length ? 'medium' : 'info';
  const status: SecurityStatus = riskyLines.length ? 'warning' : 'passed';

  return createResult(
    'open-ports',
    t('securityCheck.definition.openPorts.title', language),
    severity,
    status,
    riskyLines.length
      ? t('securityCheck.openPorts.summary.risky', language, { count: riskyLines.length })
      : t('securityCheck.openPorts.summary.count', language, { count: listenCount }),
    riskyLines.length ? riskyLines.slice(0, 8) : outputLines.slice(0, 8),
    riskyLines.length
      ? [t('securityCheck.openPorts.suggestion.risky1', language), t('securityCheck.openPorts.suggestion.risky2', language)]
      : [t('securityCheck.openPorts.suggestion.ok', language)],
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

function evaluateProcessAnalysis(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
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
    t('securityCheck.definition.processAnalysis.title', language),
    severity,
    status,
    suspiciousLines.length
      ? t('securityCheck.process.summary.suspicious', language, { count: suspiciousLines.length })
      : highCpuLines.length || highMemoryLines.length || riskyPortLines.length
        ? t('securityCheck.process.summary.clues', language, { count: highCpuLines.length + highMemoryLines.length + riskyPortLines.length })
        : t('securityCheck.process.summary.ok', language, { count: processLines.length }),
    [
      processLines.length ? t('securityCheck.process.detail.sample', language, { count: processLines.length }) : t('securityCheck.process.detail.noSample', language),
      suspiciousLines.length ? t('securityCheck.process.detail.suspicious', language, { lines: suspiciousLines.slice(0, 8).join(' | ') }) : t('securityCheck.process.detail.noSuspicious', language),
      highCpuLines.length ? t('securityCheck.process.detail.highCpu', language, { lines: highCpuLines.slice(0, 6).join(' | ') }) : t('securityCheck.process.detail.noHighCpu', language),
      highMemoryLines.length ? t('securityCheck.process.detail.highMemory', language, { lines: highMemoryLines.slice(0, 6).join(' | ') }) : t('securityCheck.process.detail.noHighMemory', language),
      riskyPortLines.length ? t('securityCheck.process.detail.riskyPortProcess', language, { lines: riskyPortLines.slice(0, 6).join(' | ') }) : t('securityCheck.process.detail.noRiskyPortProcess', language),
    ],
    status === 'passed'
      ? [t('securityCheck.process.suggestion.ok', language)]
      : [t('securityCheck.process.suggestion.risky1', language), t('securityCheck.process.suggestion.risky2', language)],
    result,
  );
}

function evaluateFirewallExposure(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
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
    t('securityCheck.definition.firewallExposure.title', language),
    severity,
    status,
    riskyFirewall && riskyPortLines.length
      ? t('securityCheck.firewall.summary.both', language, { count: riskyPortLines.length })
      : riskyFirewall
        ? t('securityCheck.firewall.summary.riskyFirewall', language)
        : riskyPortLines.length
          ? t('securityCheck.firewall.summary.riskyPorts', language, { count: riskyPortLines.length })
          : t('securityCheck.firewall.summary.ok', language),
    [
      t('securityCheck.firewall.detail.provider', language, { provider }),
      disabledFirewallLines.length ? t('securityCheck.firewall.detail.disabled', language, { lines: disabledFirewallLines.slice(0, 6).join(' | ') }) : t('securityCheck.firewall.detail.disabledNone', language),
      riskyPortLines.length ? t('securityCheck.firewall.detail.riskyPorts', language, { lines: riskyPortLines.slice(0, 8).join(' | ') }) : t('securityCheck.firewall.detail.riskyPortsNone', language),
      portLines.length ? t('securityCheck.firewall.detail.portSample', language, { lines: portLines.slice(0, 5).join(' | ') }) : t('securityCheck.firewall.detail.portSampleNone', language),
    ],
    status === 'passed'
      ? [t('securityCheck.firewall.suggestion.ok', language)]
      : [t('securityCheck.firewall.suggestion.risky1', language), t('securityCheck.firewall.suggestion.risky2', language)],
    result,
  );
}

function evaluateSensitivePermissions(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
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
    t('securityCheck.definition.filePermissions.title', language),
    severity,
    status,
    riskyLines.length ? t('securityCheck.permissions.summary.risky', language, { count: riskyLines.length }) : t('securityCheck.permissions.summary.ok', language),
    riskyLines.length ? riskyLines : outputLines,
    riskyLines.length
      ? [t('securityCheck.permissions.suggestion.risky', language)]
      : [t('securityCheck.permissions.suggestion.ok', language)],
    result,
  );
}

function evaluatePrivilegeSurface(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
  const outputLines = lines(raw(result));
  const suidLines = outputLines.filter((line) => line.startsWith('SUID:')).map((line) => line.slice('SUID:'.length));
  const worldWritableLines = outputLines.filter((line) => line.startsWith('WORLD_WRITABLE:')).map((line) => line.slice('WORLD_WRITABLE:'.length));
  const unquotedServices = outputLines.filter((line) => line.startsWith('UNQUOTED_SERVICE:')).map((line) => line.slice('UNQUOTED_SERVICE:'.length));
  const severity: SecuritySeverity = worldWritableLines.length ? 'high' : unquotedServices.length ? 'medium' : suidLines.length > 40 ? 'low' : 'info';
  const status: SecurityStatus = worldWritableLines.length ? 'failed' : unquotedServices.length || suidLines.length > 40 ? 'warning' : 'passed';

  return createResult(
    'privilege-surface',
    t('securityCheck.definition.privilegeSurface.title', language),
    severity,
    status,
    worldWritableLines.length
      ? t('securityCheck.privilege.summary.worldWritable', language, { count: worldWritableLines.length })
      : unquotedServices.length
        ? t('securityCheck.privilege.summary.unquoted', language, { count: unquotedServices.length })
        : suidLines.length > 40
          ? t('securityCheck.privilege.summary.suid', language, { count: suidLines.length })
          : t('securityCheck.privilege.summary.ok', language),
    [
      worldWritableLines.length ? t('securityCheck.privilege.detail.worldWritable', language, { lines: worldWritableLines.slice(0, 8).join(' | ') }) : t('securityCheck.privilege.detail.worldWritableNone', language),
      unquotedServices.length ? t('securityCheck.privilege.detail.unquoted', language, { lines: unquotedServices.slice(0, 8).join(' | ') }) : t('securityCheck.privilege.detail.unquotedNone', language),
      suidLines.length ? t('securityCheck.privilege.detail.suid', language, { lines: suidLines.slice(0, 10).join(' | ') }) : t('securityCheck.privilege.detail.suidNone', language),
    ],
    status === 'passed'
      ? [t('securityCheck.privilege.suggestion.ok', language)]
      : [t('securityCheck.privilege.suggestion.risky1', language), t('securityCheck.privilege.suggestion.risky2', language)],
    result,
  );
}

function evaluateUpdates(result: SecurityCommandResult, language: AppLanguage): SecurityCheckResult {
  const output = raw(result);
  const countMatch = output.match(/UPDATES:\s*(\d+)/i);
  const count = countMatch ? Number.parseInt(countMatch[1], 10) : 0;
  const unknown = !countMatch && result.code !== 0;
  const severity: SecuritySeverity = unknown ? 'info' : count >= 20 ? 'medium' : count > 0 ? 'low' : 'info';
  const status: SecurityStatus = unknown ? 'unknown' : count > 0 ? 'warning' : 'passed';

  return createResult(
    'updates',
    t('securityCheck.definition.updates.title', language),
    severity,
    status,
    unknown
      ? t('securityCheck.updates.summary.unknown', language)
      : count ? t('securityCheck.updates.summary.count', language, { count }) : t('securityCheck.updates.summary.none', language),
    lines(output).slice(0, 12),
    count ? [t('securityCheck.updates.suggestion.update', language)] : [t('securityCheck.updates.suggestion.review', language)],
    result,
  );
}

function linuxSshCommand(language: AppLanguage) {
  const notFound = t('securityCheck.command.sshConfigNotFound', language);

  return `
if command -v sshd >/dev/null 2>&1; then
  sshd -T 2>/dev/null | grep -Ei '^(permitrootlogin|passwordauthentication|pubkeyauthentication|permitemptypasswords|maxauthtries|allowtcpforwarding|x11forwarding|allowusers|allowgroups|port)\\s+' || true
elif [ -f /etc/ssh/sshd_config ]; then
  grep -Ei '^\\s*(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|PermitEmptyPasswords|MaxAuthTries|AllowTcpForwarding|X11Forwarding|AllowUsers|AllowGroups|Port)\\s+' /etc/ssh/sshd_config | sed 's/^\\s*//'
else
  printf '${notFound}\\n'
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

function linuxFailedLoginsCommand(language: AppLanguage) {
  const missingTools = t('securityCheck.command.missingLoginLogTools', language);

  return `
if command -v lastb >/dev/null 2>&1; then
  lastb -n 30 2>&1 || true
elif command -v journalctl >/dev/null 2>&1; then
  journalctl -u ssh -u sshd -n 300 --no-pager 2>/dev/null | grep -Ei 'Failed password|Invalid user|authentication failure' | tail -n 30 || true
else
  printf '${missingTools}\\n'
fi
`;
}

function linuxPortsCommand(language: AppLanguage) {
  const missingTools = t('securityCheck.command.missingPortTools', language);

  return `
if command -v ss >/dev/null 2>&1; then
  ss -H -tunlp 2>/dev/null || ss -H -tunl 2>/dev/null || true
elif command -v netstat >/dev/null 2>&1; then
  netstat -tunlp 2>/dev/null || netstat -tunl 2>/dev/null || true
else
  printf '${missingTools}\\n'
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

function linuxUpdatesCommand(language: AppLanguage) {
  const unsupported = t('securityCheck.command.unknownPackageManager', language);

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
  printf '${unsupported}\\n'
fi
`;
}

function windowsSshCommand(language: AppLanguage) {
  const notFound = t('securityCheck.command.sshConfigNotFound', language);

  return powershellCommand(`
$paths = @("$env:ProgramData\\ssh\\sshd_config", "$env:WINDIR\\System32\\OpenSSH\\sshd_config")
$path = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($path) {
  Get-Content $path | Where-Object { $_ -match '^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|PermitEmptyPasswords|MaxAuthTries|AllowTcpForwarding|X11Forwarding|AllowUsers|AllowGroups|Port)\\s+' }
} else {
  "${notFound}"
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

function windowsUpdatesCommand(language: AppLanguage) {
  const hint1 = t('securityCheck.command.windowsUpdateHint1', language);
  const hint2 = t('securityCheck.command.windowsUpdateHint2', language);

  return powershellCommand(`
"${hint1}"
"${hint2}"
`);
}

export function createSecurityCheckDefinitions(isWindowsHost: boolean, language: AppLanguage): SecurityCheckDefinition[] {
  return [
    {
      id: 'ssh-config',
      title: t('securityCheck.definition.ssh.title', language),
      description: t('securityCheck.definition.ssh.description', language),
      createCommand: () => (isWindowsHost ? windowsSshCommand(language) : linuxSshCommand(language)),
      evaluate: (result) => evaluateSshConfig(result, language),
    },
    {
      id: 'privileged-users',
      title: t('securityCheck.definition.privilegedUsers.title', language),
      description: t('securityCheck.definition.privilegedUsers.description', language),
      createCommand: isWindowsHost ? windowsAdminsCommand : linuxPrivilegedUsersCommand,
      evaluate: (result) => evaluatePrivilegedUsers(result, language),
    },
    {
      id: 'account-keys',
      title: t('securityCheck.definition.accountKeys.title', language),
      description: t('securityCheck.definition.accountKeys.description', language),
      createCommand: isWindowsHost ? windowsAccountPostureCommand : linuxAccountPostureCommand,
      evaluate: (result) => evaluateAccountPosture(result, language),
    },
    {
      id: 'failed-logins',
      title: t('securityCheck.definition.failedLogins.title', language),
      description: t('securityCheck.definition.failedLogins.description', language),
      createCommand: () => (isWindowsHost ? windowsFailedLoginsCommand() : linuxFailedLoginsCommand(language)),
      evaluate: (result) => evaluateFailedLogins(result, language),
    },
    {
      id: 'open-ports',
      title: t('securityCheck.definition.openPorts.title', language),
      description: t('securityCheck.definition.openPorts.description', language),
      createCommand: () => (isWindowsHost ? windowsPortsCommand() : linuxPortsCommand(language)),
      evaluate: (result) => evaluateOpenPorts(result, language),
    },
    {
      id: 'process-analysis',
      title: t('securityCheck.definition.processAnalysis.title', language),
      description: t('securityCheck.definition.processAnalysis.description', language),
      createCommand: isWindowsHost ? windowsProcessAnalysisCommand : linuxProcessAnalysisCommand,
      evaluate: (result) => evaluateProcessAnalysis(result, language),
    },
    {
      id: 'firewall-exposure',
      title: t('securityCheck.definition.firewallExposure.title', language),
      description: t('securityCheck.definition.firewallExposure.description', language),
      createCommand: isWindowsHost ? windowsFirewallExposureCommand : linuxFirewallExposureCommand,
      evaluate: (result) => evaluateFirewallExposure(result, language),
    },
    {
      id: 'file-permissions',
      title: t('securityCheck.definition.filePermissions.title', language),
      description: t('securityCheck.definition.filePermissions.description', language),
      createCommand: isWindowsHost ? windowsPermissionsCommand : linuxPermissionsCommand,
      evaluate: (result) => evaluateSensitivePermissions(result, language),
    },
    {
      id: 'privilege-surface',
      title: t('securityCheck.definition.privilegeSurface.title', language),
      description: t('securityCheck.definition.privilegeSurface.description', language),
      createCommand: isWindowsHost ? windowsPrivilegeSurfaceCommand : linuxPrivilegeSurfaceCommand,
      evaluate: (result) => evaluatePrivilegeSurface(result, language),
    },
    {
      id: 'updates',
      title: t('securityCheck.definition.updates.title', language),
      description: t('securityCheck.definition.updates.description', language),
      createCommand: () => (isWindowsHost ? windowsUpdatesCommand(language) : linuxUpdatesCommand(language)),
      evaluate: (result) => evaluateUpdates(result, language),
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

export function calculateSecurityScore(results: SecurityCheckResult[], language: AppLanguage): SecurityScoreSummary {
  if (!results.length) {
    return {
      score: null,
      label: t('securityCheck.score.unscored', language),
      tone: 'idle',
      deductions: [],
    };
  }

  const deductions = results
    .map((result) => ({ result, penalty: getScorePenalty(result) }))
    .filter((item) => item.penalty > 0);
  const score = Math.max(0, 100 - deductions.reduce((total, item) => total + item.penalty, 0));
  const tone: SecurityScoreSummary['tone'] = score >= 90 ? 'good' : score >= 75 ? 'watch' : score >= 60 ? 'risk' : 'critical';
  const label = score >= 90
    ? t('securityCheck.score.good', language)
    : score >= 75
      ? t('securityCheck.score.watch', language)
      : score >= 60
        ? t('securityCheck.score.risk', language)
        : t('securityCheck.score.critical', language);

  return {
    score,
    label,
    tone,
    deductions: deductions.map((item) => `${item.result.title} -${item.penalty}: ${item.result.summary}`),
  };
}

export function formatSecurityReport(results: SecurityCheckResult[], hostLabel: string, scannedAt: string, language: AppLanguage) {
  const counts = {
    high: results.filter((result) => result.severity === 'high').length,
    medium: results.filter((result) => result.severity === 'medium').length,
    low: results.filter((result) => result.severity === 'low').length,
    info: results.filter((result) => result.severity === 'info').length,
  };
  const score = calculateSecurityScore(results, language);

  return [
    t('securityCheck.report.title', language),
    '',
    t('securityCheck.report.host', language, { host: hostLabel || t('securityCheck.report.currentConnection', language) }),
    t('securityCheck.report.time', language, { time: scannedAt || new Date().toLocaleString(getShellDeskLocale()) }),
    t('securityCheck.report.score', language, { score: score.score ?? '--', label: score.label }),
    t('securityCheck.report.risks', language, counts),
    score.deductions.length
      ? t('securityCheck.report.deductions', language, { items: score.deductions.slice(0, 6).join(language === 'zh-CN' ? '；' : '; ') })
      : t('securityCheck.report.noDeductions', language),
    '',
    ...results.flatMap((result) => [
      `## ${result.title}`,
      '',
      t('securityCheck.report.severity', language, { severity: getSeverityLabel(result.severity, language) }),
      t('securityCheck.report.status', language, { status: getStatusLabel(result.status, language) }),
      t('securityCheck.report.summary', language, { summary: result.summary }),
      '',
      ...result.details.map((detail) => `- ${detail}`),
      '',
      ...result.suggestions.map((suggestion) => `> ${suggestion}`),
      '',
    ]),
  ].join('\n');
}

export function getSeverityLabel(severity: SecuritySeverity, language: AppLanguage) {
  if (severity === 'high') return t('securityCheck.severity.high', language);
  if (severity === 'medium') return t('securityCheck.severity.medium', language);
  if (severity === 'low') return t('securityCheck.severity.low', language);
  return t('securityCheck.severity.info', language);
}

export function getStatusLabel(status: SecurityStatus, language: AppLanguage) {
  if (status === 'passed') return t('securityCheck.status.passed', language);
  if (status === 'warning') return t('securityCheck.status.warning', language);
  if (status === 'failed') return t('securityCheck.status.failed', language);
  return t('securityCheck.status.unknown', language);
}

export function safeGrepPattern(value: string) {
  return shellSingleQuote(value.replace(/[^\w .:@/-]/g, ''));
}
