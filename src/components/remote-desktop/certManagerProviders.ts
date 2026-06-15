import { powershellStdinCommand, type RemoteCommandInput } from './remoteSystem';
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

export function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  trap 'rm -f "$tmp"' EXIT HUP INT TERM
  if ! openssl x509 -in "$file" -text -noout >"$tmp" 2>/tmp/shelldesk-cert-error-$$; then
    err="$(cat /tmp/shelldesk-cert-error-$$ 2>/dev/null)"
    rm -f /tmp/shelldesk-cert-error-$$
    emit_error "$file: \${err:-openssl failed}"
    return 0
  fi
  rm -f /tmp/shelldesk-cert-error-$$
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
trap 'rm -f "$tmp"' EXIT HUP INT TERM
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

export function parseCertDetail(stdout: string): RemoteCertificateDetail {
  const errorLine = stdout.split(/\r?\n/).find((line) => line.startsWith('__SHELLDESK_CERT_ERROR__|'));
  if (errorLine) {
    throw new Error(errorLine.slice('__SHELLDESK_CERT_ERROR__|'.length));
  }
  return parseCertFields(stdout);
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
