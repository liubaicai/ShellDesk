import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';
import {
  createCertbotListCommand,
  createCertbotRenewCommand,
  createCertDetailCommand,
  createCertScanCommand,
  parseCertbotList,
  parseCertDetail,
  parseCertScanOutput,
  type CertbotCertificate,
  type CertExpiryStatus,
  type RemoteCertificateDetail,
  type RemoteCertificateSummary,
} from './certManagerProviders';
import { tCurrent } from '../../i18n';

interface RemoteCertManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type PendingAction = 'renew' | 'dry-run';

function getStatusLabel(status: CertExpiryStatus, daysRemaining: number | null) {
  if (status === 'expired') return tCurrent('auto.remoteCertManager.status.expired');
  if (daysRemaining === null) return tCurrent('auto.remoteCertManager.status.unknown');
  if (status === 'danger') return tCurrent('auto.remoteCertManager.status.danger', { value0: daysRemaining });
  if (status === 'warning') return tCurrent('auto.remoteCertManager.status.warning', { value0: daysRemaining });
  return tCurrent('auto.remoteCertManager.status.valid', { value0: daysRemaining });
}

function formatDetailValue(value: string | string[] | number | null | undefined) {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '-';
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getCertificateTitle(cert: RemoteCertificateSummary | RemoteCertificateDetail | null) {
  if (!cert) return tCurrent('auto.remoteCertManager.noSelection');
  return cert.subjectCommonName || cert.sans[0] || cert.filePath.split('/').pop() || cert.filePath;
}

function RemoteCertManager({ connectionId, systemType }: RemoteCertManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const [certificates, setCertificates] = useState<RemoteCertificateSummary[]>([]);
  const [certbotCertificates, setCertbotCertificates] = useState<CertbotCertificate[]>([]);
  const [certbotInstalled, setCertbotInstalled] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<RemoteCertificateDetail | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [rawOutput, setRawOutput] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');

  const filteredCertificates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return certificates;
    return certificates.filter((cert) => [
      cert.subjectCommonName,
      cert.filePath,
      cert.issuer,
      cert.serialNumber,
      cert.sha256Fingerprint,
      ...cert.sans,
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [certificates, query]);

  const selectedCertificate = useMemo(() => {
    return certificates.find((cert) => cert.id === selectedId) ?? filteredCertificates[0] ?? null;
  }, [certificates, filteredCertificates, selectedId]);

  const refreshCertbotList = useCallback(async (installed: boolean) => {
    if (!installed || isWindowsHost) {
      setCertbotCertificates([]);
      return;
    }

    const result = await runCommand(createCertbotListCommand());
    setCertbotCertificates(parseCertbotList([result.stdout, result.stderr].filter(Boolean).join('\n')));
  }, [isWindowsHost, runCommand]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createCertScanCommand(isWindowsHost));
      const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const parsed = parseCertScanOutput(combinedOutput);
      setCertificates(parsed.certificates);
      setCertbotInstalled(parsed.certbotInstalled);
      setRawOutput(parsed.rawOutput);
      setSelectedId((current) => (
        current && parsed.certificates.some((cert) => cert.id === current)
          ? current
          : parsed.certificates[0]?.id ?? ''
      ));
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      await refreshCertbotList(parsed.certbotInstalled);
      setNotice(tCurrent('auto.remoteCertManager.scanComplete', { value0: parsed.certificates.length }));
      if (parsed.errors.length) {
        setError(parsed.errors.slice(0, 4).join('\n'));
      }
    } catch (error) {
      setCertificates([]);
      setCertbotCertificates([]);
      setSelectedDetail(null);
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [isWindowsHost, refreshCertbotList, runCommand]);

  useEffect(() => {
    void refresh();
  }, [connectionId, isWindowsHost]);

  useEffect(() => {
    if (!selectedCertificate) {
      setSelectedDetail(null);
      return;
    }

    let cancelled = false;

    const loadDetail = async () => {
      setDetailLoading(true);
      setError('');

      try {
        const result = await runCommand(createCertDetailCommand(selectedCertificate.filePath, isWindowsHost));
        const detail = parseCertDetail([result.stdout, result.stderr].filter(Boolean).join('\n'));
        if (!cancelled) setSelectedDetail(detail);
      } catch (error) {
        if (!cancelled) {
          setSelectedDetail({ ...selectedCertificate, rawText: '', pem: undefined });
          setError(getErrorMessage(error));
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };

    void loadDetail();

    return () => {
      cancelled = true;
    };
  }, [isWindowsHost, runCommand, selectedCertificate?.id]);

  const executeCertbotAction = async () => {
    if (!pendingAction) return;
    const dryRun = pendingAction === 'dry-run';
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createCertbotRenewCommand(dryRun));
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      setRawOutput(output);
      if (result.code !== 0) throw new Error(output || tCurrent('auto.remoteCertManager.actionFailed'));
      setNotice(dryRun ? tCurrent('auto.remoteCertManager.dryRunComplete') : tCurrent('auto.remoteCertManager.renewComplete'));
      setPendingAction(null);
      await refresh();
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const copyFingerprint = async () => {
    const fingerprint = selectedDetail?.sha256Fingerprint || selectedCertificate?.sha256Fingerprint;
    if (!fingerprint) return;

    try {
      await navigator.clipboard.writeText(fingerprint);
      setNotice(tCurrent('auto.remoteCertManager.fingerprintCopied'));
    } catch (error) {
      setError(tCurrent('auto.remoteCertManager.copyFailed', { value0: getErrorMessage(error) }));
    }
  };

  const viewPem = () => {
    if (!selectedDetail?.pem) return;
    setRawOutput(selectedDetail.pem);
    setNotice(tCurrent('auto.remoteCertManager.pemShown'));
  };

  const detailRows = [
    [tCurrent('auto.remoteCertManager.field.subject'), selectedDetail?.subjectCommonName],
    [tCurrent('auto.remoteCertManager.field.issuer'), selectedDetail?.issuer],
    [tCurrent('auto.remoteCertManager.field.notBefore'), selectedDetail?.notBefore],
    [tCurrent('auto.remoteCertManager.field.notAfter'), selectedDetail?.notAfter],
    [tCurrent('auto.remoteCertManager.field.daysRemaining'), selectedDetail?.daysRemaining],
    [tCurrent('auto.remoteCertManager.field.serialNumber'), selectedDetail?.serialNumber],
    [tCurrent('auto.remoteCertManager.field.fingerprint'), selectedDetail?.sha256Fingerprint],
    [tCurrent('auto.remoteCertManager.field.sans'), selectedDetail?.sans],
    [tCurrent('auto.remoteCertManager.field.key'), [selectedDetail?.keyType, selectedDetail?.keySize ? `${selectedDetail.keySize} bit` : ''].filter(Boolean).join(' ')],
    [tCurrent('auto.remoteCertManager.field.signature'), selectedDetail?.signatureAlgorithm],
    [tCurrent('auto.remoteCertManager.field.path'), selectedDetail?.filePath],
  ] as const;

  return (
    <section className="cert-manager">
      <header className="cert-toolbar">
        <div className={`cert-status-card ${certbotInstalled ? 'success' : 'warning'}`}>
          <span>{tCurrent('auto.remoteCertManager.certbot')}</span>
          <strong>{certbotInstalled ? tCurrent('auto.remoteCertManager.certbotInstalled') : tCurrent('auto.remoteCertManager.certbotMissing')}</strong>
          <em>{lastRefreshedAt || tCurrent('auto.remoteCertManager.notScanned')}</em>
        </div>
        <div className="cert-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tCurrent('auto.remoteCertManager.searchPlaceholder')}
          />
        </div>
        <div className="cert-toolbar-actions">
          <button type="button" onClick={refresh} disabled={loading}>{loading ? tCurrent('auto.remoteCertManager.refreshing') : tCurrent('auto.remoteCertManager.refresh')}</button>
          <button type="button" className="primary" onClick={() => setPendingAction('dry-run')} disabled={!certbotInstalled || actionRunning}>{tCurrent('auto.remoteCertManager.dryRun')}</button>
          <button type="button" className="danger" onClick={() => setPendingAction('renew')} disabled={!certbotInstalled || actionRunning}>{tCurrent('auto.remoteCertManager.renew')}</button>
        </div>
      </header>

      {error ? <DismissibleAlert className="cert-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="cert-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="cert-layout">
        <aside className="cert-list">
          <div className="cert-list-head">
            <strong>{tCurrent('auto.remoteCertManager.certificates')}</strong>
            <span>{filteredCertificates.length}</span>
          </div>
          <div className="cert-list-scroll">
            {filteredCertificates.map((cert) => (
              <button
                key={cert.id}
                type="button"
                className={selectedCertificate?.id === cert.id ? 'active' : ''}
                onClick={() => setSelectedId(cert.id)}
              >
                <span className={`cert-expiry-dot ${cert.status}`} />
                <strong title={getCertificateTitle(cert)}>{getCertificateTitle(cert)}</strong>
                <em>{getStatusLabel(cert.status, cert.daysRemaining)}</em>
                <small title={cert.filePath}>{cert.filePath}</small>
              </button>
            ))}
            {!filteredCertificates.length ? <div className="cert-empty-state">{loading ? tCurrent('auto.remoteCertManager.loading') : tCurrent('auto.remoteCertManager.empty')}</div> : null}
          </div>
        </aside>

        <main className="cert-main">
          <section className="cert-detail-panel">
            <div className="cert-detail-hero">
              <span>{selectedCertificate ? getStatusLabel(selectedCertificate.status, selectedCertificate.daysRemaining) : tCurrent('auto.remoteCertManager.status.unknown')}</span>
              <strong>{detailLoading ? tCurrent('auto.remoteCertManager.loadingDetail') : getCertificateTitle(selectedDetail ?? selectedCertificate)}</strong>
              <em>{selectedCertificate?.filePath ?? tCurrent('auto.remoteCertManager.noCertificatePath')}</em>
            </div>
            <dl className="cert-detail-list">
              {detailRows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{formatDetailValue(value)}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="cert-actions-panel">
            <div className="cert-actions-head">
              <strong>{tCurrent('auto.remoteCertManager.actions')}</strong>
              <span>{certbotCertificates.length ? tCurrent('auto.remoteCertManager.certbotCount', { value0: certbotCertificates.length }) : tCurrent('auto.remoteCertManager.certbotInstallHint')}</span>
            </div>
            <div className="cert-actions">
              <button type="button" onClick={refresh} disabled={loading}>{tCurrent('auto.remoteCertManager.refresh')}</button>
              <button type="button" className="primary" onClick={() => setPendingAction('dry-run')} disabled={!certbotInstalled || actionRunning}>{tCurrent('auto.remoteCertManager.dryRun')}</button>
              <button type="button" className="danger" onClick={() => setPendingAction('renew')} disabled={!certbotInstalled || actionRunning}>{tCurrent('auto.remoteCertManager.renew')}</button>
              <button type="button" onClick={viewPem} disabled={!selectedDetail?.pem}>{tCurrent('auto.remoteCertManager.viewPem')}</button>
              <button type="button" onClick={copyFingerprint} disabled={!selectedCertificate?.sha256Fingerprint}>{tCurrent('auto.remoteCertManager.copyFingerprint')}</button>
            </div>
            <div className="certbot-list">
              {certbotCertificates.slice(0, 4).map((cert) => (
                <div key={cert.id} className={`certbot-item ${cert.status}`}>
                  <strong>{cert.name}</strong>
                  <span>{cert.domains.join(', ') || '-'}</span>
                  <em>{getStatusLabel(cert.status, cert.daysRemaining)}</em>
                </div>
              ))}
              {!certbotInstalled ? <p>{tCurrent('auto.remoteCertManager.certbotMissingHint')}</p> : null}
            </div>
            <pre className="cert-raw-output">{rawOutput || tCurrent('auto.remoteCertManager.noRawOutput')}</pre>
          </section>
        </main>
      </div>

      {pendingAction ? createPortal(
        <div className="cert-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div className={`cert-confirm-dialog ${pendingAction === 'renew' ? 'danger' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="cert-confirm-header">
              <span>{pendingAction === 'renew' ? tCurrent('auto.remoteCertManager.renewConfirmTitle') : tCurrent('auto.remoteCertManager.dryRunConfirmTitle')}</span>
              <strong>{pendingAction === 'renew' ? tCurrent('auto.remoteCertManager.renew') : tCurrent('auto.remoteCertManager.dryRun')}</strong>
            </div>
            <p>{pendingAction === 'renew' ? tCurrent('auto.remoteCertManager.renewConfirmBody') : tCurrent('auto.remoteCertManager.dryRunConfirmBody')}</p>
            <pre>{createCertbotRenewCommand(pendingAction === 'dry-run').command}</pre>
            <div className="cert-confirm-actions">
              <button type="button" onClick={() => setPendingAction(null)}>{tCurrent('auto.remoteCertManager.cancel')}</button>
              <button type="button" className={pendingAction === 'renew' ? 'danger' : 'primary'} onClick={executeCertbotAction} disabled={actionRunning}>
                {actionRunning ? tCurrent('auto.remoteCertManager.running') : tCurrent('auto.remoteCertManager.confirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {sudoPrompt}
    </section>
  );
}

export default RemoteCertManager;
