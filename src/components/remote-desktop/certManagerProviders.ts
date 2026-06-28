import { powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';
import { tCurrent } from '../../i18n';

export type CertExpiryStatus = 'valid' | 'warning' | 'danger' | 'expired' | 'unknown';

export interface RemoteCertificateSummary {
  id: string;
  filePath: string;
  subjectCommonName: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  daysRemaining: number | null;
  status: CertExpiryStatus;
  serialNumber: string;
  sha256Fingerprint: string;
  sans: string[];
  keyType: string;
  keySize: string;
  signatureAlgorithm: string;
  source: 'filesystem' | 'certbot';
}

export interface RemoteCertificateDetail extends RemoteCertificateSummary {
  rawText: string;
  pem?: string;
}

export interface TrustedRootCertificate {
  id: string;
  filePath: string;
  subjectCommonName: string;
  subject: string;
  issuer: string;
  notAfter: string;
  daysRemaining: number | null;
  status: CertExpiryStatus;
  serialNumber: string;
  sha256Fingerprint: string;
}

export interface TrustedRootCertificateDetail extends TrustedRootCertificate {
  rawText: string;
  pem?: string;
}

export interface TrustedRootScanResult {
  certificates: TrustedRootCertificate[];
  errors: string[];
  rawOutput: string;
}

export interface CertbotCertificate {
  id: string;
  name: string;
  domains: string[];
  expiryDate: string;
  daysRemaining: number | null;
  status: CertExpiryStatus;
  certificatePath: string;
  privateKeyPath: string;
}

export interface CertScanResult {
  certbotInstalled: boolean;
  certificates: RemoteCertificateSummary[];
  errors: string[];
  rawOutput: string;
}

export type CertbotRenewalScheduleState = 'enabled' | 'disabled' | 'not-configured' | 'unknown';
export type CertbotRenewalScheduleBackend = 'systemd' | 'cron' | 'none' | 'unknown';

export interface CertbotRenewalScheduleStatus {
  state: CertbotRenewalScheduleState;
  backend: CertbotRenewalScheduleBackend;
  timerName: string;
  serviceName: string;
  cronPath: string;
  nextRun: string;
  lastResult: string;
  rawOutput: string;
}

function stableId(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeValue(value?: string) {
  return value?.trim() ?? '';
}

function stripCn(subject: string) {
  const slashCn = subject.match(/(?:^|\/)CN\s*=\s*([^/]+)/i)?.[1];
  if (slashCn) return slashCn.trim();

  const commaCn = subject.match(/(?:^|,\s*)CN\s*=\s*([^,]+)/i)?.[1];
  return commaCn?.trim() || subject.trim();
}

function parseOpenSslDate(value: string) {
  const time = Date.parse(value.replace(/\s+GMT$/i, ' UTC'));
  return Number.isFinite(time) ? time : null;
}

function getDaysRemaining(notAfter: string) {
  const expiry = parseOpenSslDate(notAfter);
  if (expiry === null) return null;
  return Math.ceil((expiry - Date.now()) / 86_400_000);
}

export function getCertExpiryStatus(daysRemaining: number | null): CertExpiryStatus {
  if (daysRemaining === null) return 'unknown';
  if (daysRemaining < 0) return 'expired';
  if (daysRemaining < 7) return 'danger';
  if (daysRemaining <= 30) return 'warning';
  return 'valid';
}

function parseNameValueLines(stdout: string) {
  const values = new Map<string, string[]>();

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^__SHELLDESK_CERT_FIELD__\|([^|]+)\|(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    values.set(key, [...(values.get(key) ?? []), value]);
  }

  return values;
}

function firstValue(values: Map<string, string[]>, key: string) {
  return values.get(key)?.[0]?.trim() ?? '';
}

function parseSans(raw: string) {
  return raw
    .split(/,\s*/)
    .map((value) => value.replace(/^DNS:/i, '').trim())
    .filter(Boolean);
}

function parseCertFields(stdout: string, fallbackFilePath = ''): RemoteCertificateDetail {
  const values = parseNameValueLines(stdout);
  const rawText = stdout
    .replace(/^__SHELLDESK_CERT_FIELD__\|.*$/gm, '')
    .replace(/^__SHELLDESK_CERT_PEM_BEGIN__[\s\S]*?__SHELLDESK_CERT_PEM_END__$/m, '')
    .trim();
  const pemMatch = stdout.match(/__SHELLDESK_CERT_PEM_BEGIN__\n([\s\S]*?)\n__SHELLDESK_CERT_PEM_END__/);
  const filePath = firstValue(values, 'path') || fallbackFilePath;
  const subject = firstValue(values, 'subject');
  const notAfter = firstValue(values, 'notAfter');
  const daysRemaining = getDaysRemaining(notAfter);
  const subjectCommonName = stripCn(subject);

  return {
    id: `cert:${stableId(filePath || subject || notAfter)}`,
    filePath,
    subjectCommonName: subjectCommonName || filePath.split('/').pop() || tCurrent('auto.certManagerProviders.unknownCertificate'),
    issuer: firstValue(values, 'issuer'),
    notBefore: firstValue(values, 'notBefore'),
    notAfter,
    daysRemaining,
    status: getCertExpiryStatus(daysRemaining),
    serialNumber: firstValue(values, 'serialNumber'),
    sha256Fingerprint: firstValue(values, 'sha256Fingerprint'),
    sans: parseSans(firstValue(values, 'sans')),
    keyType: firstValue(values, 'keyType'),
    keySize: firstValue(values, 'keySize'),
    signatureAlgorithm: firstValue(values, 'signatureAlgorithm'),
    source: 'filesystem',
    rawText,
    pem: pemMatch?.[1]?.trim(),
  };
}

function parseTrustedRootFields(stdout: string, fallbackFilePath = ''): TrustedRootCertificateDetail {
  const values = parseNameValueLines(stdout);
  const rawText = stdout
    .replace(/^__SHELLDESK_CERT_FIELD__\|.*$/gm, '')
    .replace(/^__SHELLDESK_CERT_PEM_BEGIN__[\s\S]*?__SHELLDESK_CERT_PEM_END__$/m, '')
    .trim();
  const pemMatch = stdout.match(/__SHELLDESK_CERT_PEM_BEGIN__\n([\s\S]*?)\n__SHELLDESK_CERT_PEM_END__/);
  const filePath = firstValue(values, 'path') || fallbackFilePath;
  const subject = firstValue(values, 'subject');
  const notAfter = firstValue(values, 'notAfter');
  const daysRemaining = getDaysRemaining(notAfter);
  const subjectCommonName = stripCn(subject);

  return {
    id: `trust-root:${stableId(filePath || subject || notAfter)}`,
    filePath,
    subjectCommonName: subjectCommonName || filePath.split('/').pop() || tCurrent('auto.certManagerProviders.unknownCertificate'),
    subject,
    issuer: firstValue(values, 'issuer'),
    notAfter,
    daysRemaining,
    status: getCertExpiryStatus(daysRemaining),
    serialNumber: firstValue(values, 'serialNumber'),
    sha256Fingerprint: firstValue(values, 'sha256Fingerprint'),
    rawText,
    pem: pemMatch?.[1]?.trim(),
  };
}

function createTrustedRootEmitFunction(includeText: boolean, includePem: boolean) {
  return `
emit_root_detail() {
  file="$1"
  tmp=""
  # mktemp is preferred; the fallback keeps a random suffix for older minimal systems.
  err_file="$(mktemp 2>/dev/null || printf "/tmp/shelldesk-root-cert-error-$$-$(date +%s%N 2>/dev/null || echo $RANDOM)")"
  if ${includeText ? 'true' : 'false'}; then
    tmp="$(mktemp 2>/dev/null || printf "/tmp/shelldesk-root-cert-$$-$(date +%s%N 2>/dev/null || echo $RANDOM)")"
    if ! openssl x509 -in "$file" -text -noout >"$tmp" 2>"$err_file"; then
      err="$(cat "$err_file" 2>/dev/null)"
      rm -f -- "$tmp" "$err_file"
      printf '__SHELLDESK_ROOT_CERT_ERROR__|%s: %s\\n' "$file" "\${err:-openssl failed}"
      return 0
    fi
  fi
  if ! fields="$(openssl x509 -in "$file" -noout -subject -issuer -enddate -serial -fingerprint -sha256 2>"$err_file")"; then
    err="$(cat "$err_file" 2>/dev/null)"
    rm -f -- "$tmp" "$err_file"
    printf '__SHELLDESK_ROOT_CERT_ERROR__|%s: %s\\n' "$file" "\${err:-openssl failed}"
    return 0
  fi
  rm -f -- "$err_file"
  printf '__SHELLDESK_ROOT_CERT_BEGIN__|%s\\n' "$file"
  printf '__SHELLDESK_CERT_FIELD__|path|%s\\n' "$file"
  printf '%s\\n' "$fields" | sed \\
    -e 's/^subject= */__SHELLDESK_CERT_FIELD__|subject|/' \\
    -e 's/^issuer= */__SHELLDESK_CERT_FIELD__|issuer|/' \\
    -e 's/^notAfter= */__SHELLDESK_CERT_FIELD__|notAfter|/' \\
    -e 's/^serial= */__SHELLDESK_CERT_FIELD__|serialNumber|/' \\
    -e 's/^sha256 Fingerprint= */__SHELLDESK_CERT_FIELD__|sha256Fingerprint|/' \\
    -e 's/^SHA256 Fingerprint= */__SHELLDESK_CERT_FIELD__|sha256Fingerprint|/'
  ${includeText ? 'cat "$tmp"' : ''}
  ${includePem ? 'printf \'\\n__SHELLDESK_CERT_PEM_BEGIN__\\n\'; openssl x509 -in "$file" -outform PEM 2>/dev/null; printf \'__SHELLDESK_CERT_PEM_END__\\n\'' : ''}
  printf '\\n__SHELLDESK_ROOT_CERT_END__\\n'
  rm -f -- "$tmp" "$err_file"
}
`.trim();
}

const canonicalizePathFunction = `
canonicalize_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  else
    readlink -f "$1"
  fi
}
canonicalize_target_path() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    canonicalize_path "$1"
  else
    printf '%s/%s\\n' "$(canonicalize_path "$(dirname "$1")")" "$(basename "$1")"
  fi
}
`.trim();

export function createCertScanCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`
[Console]::Out.WriteLine("__SHELLDESK_CERTBOT__|missing")
[Console]::Out.WriteLine("__SHELLDESK_CERT_ERROR__|${tCurrent('auto.certManagerProviders.windowsUnsupported')}")
`);
  }

  return {
    command: `
set -u
emit_error() {
  printf '__SHELLDESK_CERT_ERROR__|%s\\n' "$1"
}
emit_detail() {
  file="$1"
  tmp="$(mktemp 2>/dev/null || printf "/tmp/shelldesk-cert-$$")"
  if ! openssl x509 -in "$file" -text -noout >"$tmp" 2>/tmp/shelldesk-cert-error-$$; then
    err="$(cat /tmp/shelldesk-cert-error-$$ 2>/dev/null)"
    rm -f -- "$tmp" /tmp/shelldesk-cert-error-$$
    emit_error "$file: \${err:-openssl failed}"
    return 0
  fi
  rm -f -- /tmp/shelldesk-cert-error-$$
  printf '__SHELLDESK_CERT_BEGIN__|%s\\n' "$file"
  printf '__SHELLDESK_CERT_FIELD__|path|%s\\n' "$file"
  openssl x509 -in "$file" -noout -subject -issuer -dates -serial -fingerprint -sha256 2>/dev/null | sed \\
    -e 's/^subject= */__SHELLDESK_CERT_FIELD__|subject|/' \\
    -e 's/^issuer= */__SHELLDESK_CERT_FIELD__|issuer|/' \\
    -e 's/^notBefore= */__SHELLDESK_CERT_FIELD__|notBefore|/' \\
    -e 's/^notAfter= */__SHELLDESK_CERT_FIELD__|notAfter|/' \\
    -e 's/^serial= */__SHELLDESK_CERT_FIELD__|serialNumber|/' \\
    -e 's/^sha256 Fingerprint= */__SHELLDESK_CERT_FIELD__|sha256Fingerprint|/' \\
    -e 's/^SHA256 Fingerprint= */__SHELLDESK_CERT_FIELD__|sha256Fingerprint|/'
  sig="$(sed -n 's/^[[:space:]]*Signature Algorithm: //p' "$tmp" | head -n 1)"
  san="$(awk '/X509v3 Subject Alternative Name/{getline; gsub(/^[[:space:]]+/, ""); print; exit}' "$tmp")"
  key_line="$(sed -n 's/^[[:space:]]*Public Key Algorithm: //p' "$tmp" | head -n 1)"
  key_size="$(sed -n 's/^[[:space:]]*Public-Key: (\\([0-9][0-9]*\\) bit).*/\\1/p' "$tmp" | head -n 1)"
  printf '__SHELLDESK_CERT_FIELD__|signatureAlgorithm|%s\\n' "$sig"
  printf '__SHELLDESK_CERT_FIELD__|sans|%s\\n' "$san"
  printf '__SHELLDESK_CERT_FIELD__|keyType|%s\\n' "$key_line"
  printf '__SHELLDESK_CERT_FIELD__|keySize|%s\\n' "$key_size"
  cat "$tmp"
  printf '\\n__SHELLDESK_CERT_END__\\n'
  rm -f -- "$tmp"
}
if command -v certbot >/dev/null 2>&1; then
  printf '__SHELLDESK_CERTBOT__|installed\\n'
else
  printf '__SHELLDESK_CERTBOT__|missing\\n'
fi
for dir in /etc/letsencrypt/live /etc/ssl/certs /etc/ssl/private /etc/nginx/ssl /etc/pki/tls/certs; do
  [ -d "$dir" ] || continue
  find "$dir" -maxdepth 3 -type f \\( -name '*.pem' -o -name '*.crt' \\) 2>/dev/null | sort | head -n 180
done | awk '!seen[$0]++' | while IFS= read -r file; do
  [ -n "$file" ] && emit_detail "$file"
done
`.trim(),
  };
}

export function createCertDetailCommand(filePath: string, isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("__SHELLDESK_CERT_ERROR__|${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  const quotedPath = shellSingleQuote(filePath);

  return {
    command: `
file=${quotedPath}
tmp="$(mktemp 2>/dev/null || printf "/tmp/shelldesk-cert-detail-$$")"
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
openssl x509 -in "$file" -text -noout >"$tmp" || exit $?
printf '__SHELLDESK_CERT_FIELD__|path|%s\\n' "$file"
openssl x509 -in "$file" -noout -subject -issuer -dates -serial -fingerprint -sha256 | sed \\
  -e 's/^subject= */__SHELLDESK_CERT_FIELD__|subject|/' \\
  -e 's/^issuer= */__SHELLDESK_CERT_FIELD__|issuer|/' \\
  -e 's/^notBefore= */__SHELLDESK_CERT_FIELD__|notBefore|/' \\
  -e 's/^notAfter= */__SHELLDESK_CERT_FIELD__|notAfter|/' \\
  -e 's/^serial= */__SHELLDESK_CERT_FIELD__|serialNumber|/' \\
  -e 's/^sha256 Fingerprint= */__SHELLDESK_CERT_FIELD__|sha256Fingerprint|/' \\
  -e 's/^SHA256 Fingerprint= */__SHELLDESK_CERT_FIELD__|sha256Fingerprint|/'
sig="$(sed -n 's/^[[:space:]]*Signature Algorithm: //p' "$tmp" | head -n 1)"
san="$(awk '/X509v3 Subject Alternative Name/{getline; gsub(/^[[:space:]]+/, ""); print; exit}' "$tmp")"
key_line="$(sed -n 's/^[[:space:]]*Public Key Algorithm: //p' "$tmp" | head -n 1)"
key_size="$(sed -n 's/^[[:space:]]*Public-Key: (\\([0-9][0-9]*\\) bit).*/\\1/p' "$tmp" | head -n 1)"
printf '__SHELLDESK_CERT_FIELD__|signatureAlgorithm|%s\\n' "$sig"
printf '__SHELLDESK_CERT_FIELD__|sans|%s\\n' "$san"
printf '__SHELLDESK_CERT_FIELD__|keyType|%s\\n' "$key_line"
printf '__SHELLDESK_CERT_FIELD__|keySize|%s\\n' "$key_size"
cat "$tmp"
printf '\\n__SHELLDESK_CERT_PEM_BEGIN__\\n'
openssl x509 -in "$file" -outform PEM 2>/dev/null
printf '__SHELLDESK_CERT_PEM_END__\\n'
`.trim(),
  };
}

export function createCertbotListCommand(): RemoteCommandInput {
  return { command: 'certbot certificates 2>&1' };
}

export function createCertbotRenewCommand(dryRun: boolean): RemoteCommandInput {
  return {
    command: dryRun
      ? 'sudo -n certbot renew --dry-run 2>&1'
      : 'sudo -n certbot renew --non-interactive 2>&1',
  };
}

export function createCertbotRenewalStatusCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("__SHELLDESK_CERT_RENEWAL_ERROR__|${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  return {
    command: `
set -u
emit() {
  printf '__SHELLDESK_CERT_RENEWAL__|%s|%s\\n' "$1" "$2"
}
emit configured false
emit state not-configured
emit backend none
emit timerName ''
emit serviceName ''
emit cronPath ''
emit nextRun ''

timer_name=""
service_name=""
if command -v systemctl >/dev/null 2>&1; then
  for candidate in shelldesk-certbot-renew.timer certbot.timer snap.certbot.renew.timer; do
    if systemctl list-unit-files "$candidate" --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$candidate" || [ -f "/etc/systemd/system/$candidate" ] || [ -f "/lib/systemd/system/$candidate" ] || [ -f "/usr/lib/systemd/system/$candidate" ]; then
      timer_name="$candidate"
      break
    fi
  done

  if [ -n "$timer_name" ]; then
    service_name="$(systemctl show "$timer_name" -p Unit --value 2>/dev/null || true)"
    [ -n "$service_name" ] || service_name="\${timer_name%.timer}.service"
    enabled_text="$(systemctl is-enabled "$timer_name" 2>/dev/null || true)"
    active_text="$(systemctl is-active "$timer_name" 2>/dev/null || true)"
    next_run="$(systemctl show "$timer_name" -p NextElapseUSecRealtime --value 2>/dev/null | sed -n '1p')"
    [ -n "$next_run" ] || next_run="$(systemctl list-timers --all "$timer_name" --no-legend 2>/dev/null | awk '{$1=$1; print}' | sed -n '1p')"
    emit configured true
    emit backend systemd
    case "$enabled_text:$active_text" in
      enabled:active|enabled:activating|static:active) emit state enabled ;;
      *:active) emit state enabled ;;
      disabled:*|*:inactive|*:failed) emit state disabled ;;
      *) emit state unknown ;;
    esac
    emit timerName "$timer_name"
    emit serviceName "$service_name"
    emit nextRun "$next_run"
    if command -v journalctl >/dev/null 2>&1; then
      log_text="$(journalctl -u "$service_name" -u certbot.service -n 8 --no-pager 2>/dev/null || true)"
      [ -n "$log_text" ] || log_text="-- No entries --"
      printf '__SHELLDESK_CERT_RENEWAL_LOG_BEGIN__\\n%s\\n__SHELLDESK_CERT_RENEWAL_LOG_END__\\n' "$log_text"
    else
      printf '__SHELLDESK_CERT_RENEWAL_LOG_BEGIN__\\n-- No entries --\\n__SHELLDESK_CERT_RENEWAL_LOG_END__\\n'
    fi
    exit 0
  fi
fi

cron_path=""
for candidate in /etc/cron.d/shelldesk-certbot-renew /etc/cron.d/shelldesk-certbot-renew.disabled /etc/cron.d/certbot /etc/cron.daily/certbot /etc/cron.weekly/certbot; do
  if [ -e "$candidate" ]; then
    if grep -aEq 'certbot[[:space:]]+renew|certbot.*renew' "$candidate" 2>/dev/null; then
      cron_path="$candidate"
      break
    fi
  fi
done
if [ -z "$cron_path" ] && [ -f /etc/crontab ] && grep -aEq 'certbot[[:space:]]+renew|certbot.*renew' /etc/crontab 2>/dev/null; then
  cron_path="/etc/crontab"
fi

if [ -n "$cron_path" ]; then
  emit configured true
  emit backend cron
  emit cronPath "$cron_path"
  case "$cron_path" in
    *.disabled) emit state disabled ;;
    *) emit state enabled ;;
  esac
  emit nextRun "cron"
  printf '__SHELLDESK_CERT_RENEWAL_LOG_BEGIN__\\n-- No entries --\\n__SHELLDESK_CERT_RENEWAL_LOG_END__\\n'
fi
`.trim(),
  };
}

export function createEnableCertbotRenewalCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  return {
    command: `
if ! command -v certbot >/dev/null 2>&1; then
  printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.certbotMissing'))}
  exit 1
fi
set -eu
timer_path=/etc/systemd/system/shelldesk-certbot-renew.timer
service_path=/etc/systemd/system/shelldesk-certbot-renew.service
cron_path=/etc/cron.d/shelldesk-certbot-renew
cron_disabled_path=/etc/cron.d/shelldesk-certbot-renew.disabled

if command -v systemctl >/dev/null 2>&1 && systemctl list-timers --all >/dev/null 2>&1; then
  cat <<'EOF' | sudo -n tee "$service_path" >/dev/null
[Unit]
Description=ShellDesk Certbot renewal
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env certbot renew --quiet --non-interactive
EOF
  cat <<'EOF' | sudo -n tee "$timer_path" >/dev/null
[Unit]
Description=ShellDesk Certbot renewal timer

[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=1h
Persistent=true
Unit=shelldesk-certbot-renew.service

[Install]
WantedBy=timers.target
EOF
  sudo -n chmod 0644 "$service_path" "$timer_path"
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable --now shelldesk-certbot-renew.timer
  printf 'SHELLDESK_CERTBOT_RENEWAL|systemd|enabled\\n'
else
  if [ -f "$cron_disabled_path" ]; then
    sudo -n mv "$cron_disabled_path" "$cron_path"
  else
    cat <<'EOF' | sudo -n tee "$cron_path" >/dev/null
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * root certbot renew --quiet --non-interactive
EOF
  fi
  sudo -n chmod 0644 "$cron_path"
  printf 'SHELLDESK_CERTBOT_RENEWAL|cron|enabled\\n'
fi
`.trim(),
  };
}

export function createSetCertbotRenewalEnabledCommand(enabled: boolean, isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  const systemdAction = enabled ? 'enable --now' : 'disable --now';
  const cronAction = enabled
    ? 'if [ -f /etc/cron.d/shelldesk-certbot-renew.disabled ]; then sudo -n mv /etc/cron.d/shelldesk-certbot-renew.disabled /etc/cron.d/shelldesk-certbot-renew; fi'
    : 'if [ -f /etc/cron.d/shelldesk-certbot-renew ]; then sudo -n mv /etc/cron.d/shelldesk-certbot-renew /etc/cron.d/shelldesk-certbot-renew.disabled; fi';

  return {
    command: `
set -eu
if command -v systemctl >/dev/null 2>&1; then
  for candidate in shelldesk-certbot-renew.timer certbot.timer snap.certbot.renew.timer; do
    if systemctl list-unit-files "$candidate" --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$candidate" || [ -f "/etc/systemd/system/$candidate" ] || [ -f "/lib/systemd/system/$candidate" ] || [ -f "/usr/lib/systemd/system/$candidate" ]; then
      sudo -n systemctl ${systemdAction} "$candidate"
      printf 'SHELLDESK_CERTBOT_RENEWAL|systemd|%s|%s\\n' ${shellSingleQuote(enabled ? 'enabled' : 'disabled')} "$candidate"
      exit 0
    fi
  done
fi
${cronAction}
printf 'SHELLDESK_CERTBOT_RENEWAL|cron|%s\\n' ${shellSingleQuote(enabled ? 'enabled' : 'disabled')}
`.trim(),
  };
}

export function createDeleteCertbotRenewalCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  return {
    command: `
set -eu
if command -v systemctl >/dev/null 2>&1 && { [ -f /etc/systemd/system/shelldesk-certbot-renew.timer ] || [ -f /etc/systemd/system/shelldesk-certbot-renew.service ]; }; then
  sudo -n systemctl disable --now shelldesk-certbot-renew.timer 2>/dev/null || true
  sudo -n rm -f /etc/systemd/system/shelldesk-certbot-renew.timer /etc/systemd/system/shelldesk-certbot-renew.service
  sudo -n systemctl daemon-reload
fi
sudo -n rm -f /etc/cron.d/shelldesk-certbot-renew /etc/cron.d/shelldesk-certbot-renew.disabled
printf 'SHELLDESK_CERTBOT_RENEWAL|deleted\\n'
`.trim(),
  };
}

export function createCertbotRenewalLogCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  return {
    command: `
if command -v journalctl >/dev/null 2>&1; then
  service_name=shelldesk-certbot-renew.service
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files certbot.timer --no-legend 2>/dev/null | awk '{print $1}' | grep -qx certbot.timer; then
    service_name=certbot.service
  fi
  journalctl -u "$service_name" -u certbot.service -n 120 --no-pager 2>/dev/null || printf '%s\\n' '-- No entries --'
else
  printf '%s\\n' '-- No entries --'
fi
`.trim(),
  };
}

export function createTrustedRootScanCommand(isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("__SHELLDESK_ROOT_CERT_ERROR__|${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  return {
    command: `
set -u
if ! command -v openssl >/dev/null 2>&1; then
  printf '__SHELLDESK_ROOT_CERT_ERROR__|%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.opensslMissing'))}
  exit 0
fi
${createTrustedRootEmitFunction(false, false)}
for dir in /etc/ssl/certs /usr/local/share/ca-certificates /etc/pki/ca-trust/extracted/pem /etc/pki/ca-trust/source/anchors /etc/pki/tls/certs; do
  [ -d "$dir" ] || continue
  find "$dir" -xdev -maxdepth 2 \\( -type f -o -type l \\) \\( -name '*.pem' -o -name '*.crt' -o -name '*.cer' -o -name '*.[0-9]' \\) 2>/dev/null | sort
done | awk '!seen[$0]++' | head -n 300 | while IFS= read -r file; do
  [ -n "$file" ] && emit_root_detail "$file"
done
`.trim(),
  };
}

export function createTrustedRootDetailCommand(filePath: string, isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("__SHELLDESK_ROOT_CERT_ERROR__|${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  return {
    command: `
file=${shellSingleQuote(filePath)}
if ! command -v openssl >/dev/null 2>&1; then
  printf '__SHELLDESK_ROOT_CERT_ERROR__|%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.opensslMissing'))}
  exit 0
fi
${createTrustedRootEmitFunction(true, true)}
emit_root_detail "$file"
`.trim(),
  };
}

export function createAddTrustedRootCommand(filePath: string, isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  return {
    command: `
set -eu
${canonicalizePathFunction}
source_file=${shellSingleQuote(filePath)}
[ -f "$source_file" ] || { printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.caFileMissing'))}; exit 2; }
source_file="$(canonicalize_path "$source_file")"
if ! openssl x509 -in "$source_file" -noout -checkend 0 >/dev/null 2>&1; then
  printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.caInvalidOrExpired'))}
  exit 5
fi
if ! openssl x509 -in "$source_file" -noout -text 2>/dev/null | grep -q 'CA:TRUE'; then
  printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.caNotAuthority'))}
  exit 6
fi
base="$(basename "$source_file")"
case "$base" in
  .|..) printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.removeManagedOnly'))}; exit 4 ;;
  *.crt|*.cer|*.pem) ;;
  *) base="$base.crt" ;;
esac
if command -v update-ca-certificates >/dev/null 2>&1; then
  target_dir="/usr/local/share/ca-certificates"
  sudo -n mkdir -p "$target_dir"
  canonical_target_dir="$(canonicalize_path "$target_dir")"
  target="$(canonicalize_target_path "$canonical_target_dir/$base")"
  case "$canonical_target_dir/" in
    /usr/local/share/ca-certificates/) ;;
    *) printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.removeManagedOnly'))}; exit 4 ;;
  esac
  case "$target" in
    /usr/local/share/ca-certificates/*) ;;
    *) printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.removeManagedOnly'))}; exit 4 ;;
  esac
  sudo -n cp -- "$source_file" "$target"
  sudo -n chmod 0644 -- "$target"
  sudo -n update-ca-certificates
  printf 'SHELLDESK_TRUST_ROOT_ADDED|%s\\n' "$target"
elif command -v update-ca-trust >/dev/null 2>&1; then
  target_dir="/etc/pki/ca-trust/source/anchors"
  sudo -n mkdir -p "$target_dir"
  canonical_target_dir="$(canonicalize_path "$target_dir")"
  target="$(canonicalize_target_path "$canonical_target_dir/$base")"
  case "$canonical_target_dir/" in
    /etc/pki/ca-trust/source/anchors/) ;;
    *) printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.removeManagedOnly'))}; exit 4 ;;
  esac
  case "$target" in
    /etc/pki/ca-trust/source/anchors/*) ;;
    *) printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.removeManagedOnly'))}; exit 4 ;;
  esac
  sudo -n cp -- "$source_file" "$target"
  sudo -n chmod 0644 -- "$target"
  sudo -n update-ca-trust extract
  printf 'SHELLDESK_TRUST_ROOT_ADDED|%s\\n' "$target"
else
  printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.caTrustUnsupported'))}
  exit 3
fi
`.trim(),
  };
}

export function createRemoveTrustedRootCommand(filePath: string, isWindowsHost: boolean): RemoteCommandInput {
  if (isWindowsHost) {
    return powershellStdinCommand(`[Console]::Out.WriteLine("${tCurrent('auto.certManagerProviders.windowsUnsupported')}")`);
  }

  return {
    command: `
set -eu
${canonicalizePathFunction}
target=${shellSingleQuote(filePath)}
[ -f "$target" ] || { printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.caFileMissing'))}; exit 2; }
target="$(canonicalize_path "$target")"
case "$target" in
  /usr/local/share/ca-certificates/*|/etc/pki/ca-trust/source/anchors/*) ;;
  *)
    printf '%s\\n' ${shellSingleQuote(tCurrent('auto.certManagerProviders.removeManagedOnly'))}
    exit 4
    ;;
esac
sudo -n rm -f -- "$target"
if command -v update-ca-certificates >/dev/null 2>&1; then
  sudo -n update-ca-certificates
elif command -v update-ca-trust >/dev/null 2>&1; then
  sudo -n update-ca-trust extract
fi
printf 'SHELLDESK_TRUST_ROOT_REMOVED|%s\\n' "$target"
`.trim(),
  };
}

export function parseCertScanOutput(stdout: string): CertScanResult {
  const certificates: RemoteCertificateSummary[] = [];
  const errors: string[] = [];
  let certbotInstalled = false;
  const lines = stdout.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line === '__SHELLDESK_CERTBOT__|installed') certbotInstalled = true;
    if (line.startsWith('__SHELLDESK_CERT_ERROR__|')) errors.push(line.slice('__SHELLDESK_CERT_ERROR__|'.length));

    if (line.startsWith('__SHELLDESK_CERT_BEGIN__|')) {
      const chunk: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== '__SHELLDESK_CERT_END__') {
        chunk.push(lines[index]);
        index += 1;
      }
      const detail = parseCertFields(chunk.join('\n'), line.slice('__SHELLDESK_CERT_BEGIN__|'.length));
      certificates.push({
        id: detail.id,
        filePath: detail.filePath,
        subjectCommonName: detail.subjectCommonName,
        issuer: detail.issuer,
        notBefore: detail.notBefore,
        notAfter: detail.notAfter,
        daysRemaining: detail.daysRemaining,
        status: detail.status,
        serialNumber: detail.serialNumber,
        sha256Fingerprint: detail.sha256Fingerprint,
        sans: detail.sans,
        keyType: detail.keyType,
        keySize: detail.keySize,
        signatureAlgorithm: detail.signatureAlgorithm,
        source: detail.source,
      });
    }
  }

  certificates.sort((left, right) => {
    const leftDays = left.daysRemaining ?? Number.POSITIVE_INFINITY;
    const rightDays = right.daysRemaining ?? Number.POSITIVE_INFINITY;
    return leftDays - rightDays || left.subjectCommonName.localeCompare(right.subjectCommonName);
  });

  return { certbotInstalled, certificates, errors, rawOutput: stdout };
}

export function parseTrustedRootScanOutput(stdout: string): TrustedRootScanResult {
  const certificates: TrustedRootCertificate[] = [];
  const errors: string[] = [];
  const lines = stdout.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith('__SHELLDESK_ROOT_CERT_ERROR__|')) errors.push(line.slice('__SHELLDESK_ROOT_CERT_ERROR__|'.length));

    if (line.startsWith('__SHELLDESK_ROOT_CERT_BEGIN__|')) {
      const chunk: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== '__SHELLDESK_ROOT_CERT_END__') {
        chunk.push(lines[index]);
        index += 1;
      }
      const detail = parseTrustedRootFields(chunk.join('\n'), line.slice('__SHELLDESK_ROOT_CERT_BEGIN__|'.length));
      certificates.push({
        id: detail.id,
        filePath: detail.filePath,
        subjectCommonName: detail.subjectCommonName,
        subject: detail.subject,
        issuer: detail.issuer,
        notAfter: detail.notAfter,
        daysRemaining: detail.daysRemaining,
        status: detail.status,
        serialNumber: detail.serialNumber,
        sha256Fingerprint: detail.sha256Fingerprint,
      });
    }
  }

  certificates.sort((left, right) => {
    const leftDays = left.daysRemaining ?? Number.POSITIVE_INFINITY;
    const rightDays = right.daysRemaining ?? Number.POSITIVE_INFINITY;
    return left.subjectCommonName.localeCompare(right.subjectCommonName) || leftDays - rightDays;
  });

  return { certificates, errors, rawOutput: stdout };
}

export function parseCertDetail(stdout: string): RemoteCertificateDetail {
  const errorLine = stdout.split(/\r?\n/).find((line) => line.startsWith('__SHELLDESK_CERT_ERROR__|'));
  if (errorLine) {
    throw new Error(errorLine.slice('__SHELLDESK_CERT_ERROR__|'.length));
  }
  return parseCertFields(stdout);
}

export function parseCertbotRenewalStatus(stdout: string): CertbotRenewalScheduleStatus {
  const errorLine = stdout.split(/\r?\n/).find((line) => line.startsWith('__SHELLDESK_CERT_RENEWAL_ERROR__|'));
  if (errorLine) {
    throw new Error(errorLine.slice('__SHELLDESK_CERT_RENEWAL_ERROR__|'.length));
  }

  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^__SHELLDESK_CERT_RENEWAL__\|([^|]+)\|(.*)$/);
    if (match) fields.set(match[1], match[2]);
  }

  const logMatch = stdout.match(/__SHELLDESK_CERT_RENEWAL_LOG_BEGIN__\n([\s\S]*?)\n__SHELLDESK_CERT_RENEWAL_LOG_END__/);
  const configured = fields.get('configured') === 'true';
  const parsedState = fields.get('state');
  const state: CertbotRenewalScheduleState = parsedState === 'enabled' || parsedState === 'disabled' || parsedState === 'unknown'
    ? parsedState
    : configured ? 'unknown' : 'not-configured';
  const parsedBackend = fields.get('backend');
  const backend: CertbotRenewalScheduleBackend = parsedBackend === 'systemd' || parsedBackend === 'cron' || parsedBackend === 'unknown'
    ? parsedBackend
    : 'none';

  return {
    state,
    backend,
    timerName: fields.get('timerName') ?? '',
    serviceName: fields.get('serviceName') ?? '',
    cronPath: fields.get('cronPath') ?? '',
    nextRun: fields.get('nextRun') ?? '',
    lastResult: logMatch?.[1]?.trim() || '-- No entries --',
    rawOutput: stdout,
  };
}

export function parseTrustedRootDetail(stdout: string): TrustedRootCertificateDetail {
  const errorLine = stdout.split(/\r?\n/).find((line) => line.startsWith('__SHELLDESK_ROOT_CERT_ERROR__|'));
  if (errorLine) {
    throw new Error(errorLine.slice('__SHELLDESK_ROOT_CERT_ERROR__|'.length));
  }
  return parseTrustedRootFields(stdout);
}

export function parseCertbotList(stdout: string): CertbotCertificate[] {
  const certs: CertbotCertificate[] = [];
  const chunks = stdout.split(/\n\s*Certificate Name:\s*/).slice(1);

  for (const chunk of chunks) {
    const nameLineEnd = chunk.indexOf('\n');
    const name = (nameLineEnd === -1 ? chunk : chunk.slice(0, nameLineEnd)).trim();
    const body = nameLineEnd === -1 ? '' : chunk.slice(nameLineEnd + 1);
    const domains = normalizeValue(body.match(/Domains:\s*(.+)/)?.[1]).split(/\s+/).filter(Boolean);
    const expiryRaw = normalizeValue(body.match(/Expiry Date:\s*(.+?)(?:\s+\(|$)/)?.[1]);
    const daysMatch = body.match(/\(VALID:\s*(-?\d+)\s+days?\)/i);
    const daysRemaining = daysMatch ? Number.parseInt(daysMatch[1], 10) : getDaysRemaining(expiryRaw);
    const certificatePath = normalizeValue(body.match(/Certificate Path:\s*(.+)/)?.[1]);
    const privateKeyPath = normalizeValue(body.match(/Private Key Path:\s*(.+)/)?.[1]);

    certs.push({
      id: `certbot:${stableId(name || certificatePath)}`,
      name,
      domains,
      expiryDate: expiryRaw,
      daysRemaining: Number.isFinite(daysRemaining) ? daysRemaining : null,
      status: getCertExpiryStatus(Number.isFinite(daysRemaining) ? daysRemaining : null),
      certificatePath,
      privateKeyPath,
    });
  }

  return certs;
}
