import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';
import {
  createCertbotRenewalLogCommand,
  createCertbotRenewalStatusCommand,
  createDeleteCertbotRenewalCommand,
  createEnableCertbotRenewalCommand,
  createSetCertbotRenewalEnabledCommand,
  createCertbotListCommand,
  createCertbotRenewCommand,
  createAddTrustedRootCommand,
  createCertDetailCommand,
  createCertScanCommand,
  createRemoveTrustedRootCommand,
  createTrustedRootDetailCommand,
  createTrustedRootScanCommand,
  parseCertbotList,
  parseCertbotRenewalStatus,
  parseCertDetail,
  parseCertScanOutput,
  parseTrustedRootDetail,
  parseTrustedRootScanOutput,
  type CertbotCertificate,
  type CertbotRenewalScheduleStatus,
  type CertExpiryStatus,
  type RemoteCertificateDetail,
  type RemoteCertificateSummary,
  type TrustedRootCertificate,
  type TrustedRootCertificateDetail,
} from './certManagerProviders';
import { tCurrent } from '../../i18n';

interface RemoteCertManagerProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type PendingAction = 'renew' | 'dry-run';
type PendingRenewalAction = 'create' | 'enable' | 'disable' | 'delete';
type CertManagerTab = 'site' | 'roots';

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

function getTrustedRootTitle(cert: TrustedRootCertificate | TrustedRootCertificateDetail | null) {
  if (!cert) return tCurrent('auto.remoteCertManager.noSelection');
  return cert.subjectCommonName || cert.filePath.split('/').pop() || cert.filePath;
}

function getRenewalStateLabel(status: CertbotRenewalScheduleStatus | null) {
  if (!status) return tCurrent('auto.remoteCertManager.renewal.status.unknown');
  if (status.state === 'enabled') return tCurrent('auto.remoteCertManager.renewal.status.enabled');
  if (status.state === 'disabled') return tCurrent('auto.remoteCertManager.renewal.status.disabled');
  if (status.state === 'not-configured') return tCurrent('auto.remoteCertManager.renewal.status.notConfigured');
  return tCurrent('auto.remoteCertManager.renewal.status.unknown');
}

function getRenewalBackendLabel(status: CertbotRenewalScheduleStatus | null) {
  if (!status || status.backend === 'none') return '-';
  if (status.backend === 'systemd') return status.timerName || 'systemd';
  if (status.backend === 'cron') return status.cronPath || 'cron';
  return tCurrent('auto.remoteCertManager.renewal.backend.unknown');
}

function getRenewalActionLabel(action: PendingRenewalAction) {
  if (action === 'create') return tCurrent('auto.remoteCertManager.renewal.create');
  if (action === 'enable') return tCurrent('auto.remoteCertManager.renewal.enable');
  if (action === 'disable') return tCurrent('auto.remoteCertManager.renewal.disable');
  return tCurrent('auto.remoteCertManager.renewal.delete');
}

function getRenewalActionBody(action: PendingRenewalAction) {
  if (action === 'create') return tCurrent('auto.remoteCertManager.renewal.confirm.create');
  if (action === 'enable') return tCurrent('auto.remoteCertManager.renewal.confirm.enable');
  if (action === 'disable') return tCurrent('auto.remoteCertManager.renewal.confirm.disable');
  return tCurrent('auto.remoteCertManager.renewal.confirm.delete');
}

function getRenewalNotice(action: PendingRenewalAction) {
  if (action === 'create') return tCurrent('auto.remoteCertManager.renewal.notice.create');
  if (action === 'enable') return tCurrent('auto.remoteCertManager.renewal.notice.enable');
  if (action === 'disable') return tCurrent('auto.remoteCertManager.renewal.notice.disable');
  return tCurrent('auto.remoteCertManager.renewal.notice.delete');
}

function RemoteCertManager({ connectionId, systemType }: RemoteCertManagerProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const [activeTab, setActiveTab] = useState<CertManagerTab>('site');
  const [certificates, setCertificates] = useState<RemoteCertificateSummary[]>([]);
  const [certbotCertificates, setCertbotCertificates] = useState<CertbotCertificate[]>([]);
  const [certbotInstalled, setCertbotInstalled] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<RemoteCertificateDetail | null>(null);
  const [trustedRoots, setTrustedRoots] = useState<TrustedRootCertificate[]>([]);
  const [selectedRootId, setSelectedRootId] = useState('');
  const [selectedRootDetail, setSelectedRootDetail] = useState<TrustedRootCertificateDetail | null>(null);
  const [caPathDraft, setCaPathDraft] = useState('');
  const [pendingRootRemoval, setPendingRootRemoval] = useState<TrustedRootCertificate | null>(null);
  const [query, setQuery] = useState('');
  const [siteLoading, setSiteLoading] = useState(false);
  const [rootLoading, setRootLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rootDetailLoading, setRootDetailLoading] = useState(false);
  const [actionRunning, setActionRunning] = useState(false);
  const [uploadRunning, setUploadRunning] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [renewalStatus, setRenewalStatus] = useState<CertbotRenewalScheduleStatus | null>(null);
  const [renewalLoading, setRenewalLoading] = useState(false);
  const [pendingRenewalAction, setPendingRenewalAction] = useState<PendingRenewalAction | null>(null);
  const [rawOutput, setRawOutput] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');
  const siteRequestIdRef = useRef(0);
  const trustedRootsRequestIdRef = useRef(0);
  const addTrustedRootRequestIdRef = useRef(0);
  const removeTrustedRootRequestIdRef = useRef(0);
  const trustedRootsAutoRefreshKeyRef = useRef('');
  const dialogRef = useRef<HTMLDivElement | null>(null);

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
    return filteredCertificates.find((cert) => cert.id === selectedId) ?? filteredCertificates[0] ?? null;
  }, [filteredCertificates, selectedId]);

  const filteredTrustedRoots = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return trustedRoots;
    return trustedRoots.filter((cert) => [
      cert.subjectCommonName,
      cert.subject,
      cert.issuer,
      cert.filePath,
      cert.serialNumber,
      cert.sha256Fingerprint,
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [query, trustedRoots]);

  const selectedTrustedRoot = useMemo(() => {
    return filteredTrustedRoots.find((cert) => cert.id === selectedRootId) ?? filteredTrustedRoots[0] ?? null;
  }, [filteredTrustedRoots, selectedRootId]);

  const refreshCertbotList = useCallback(async (installed: boolean) => {
    if (!installed || isWindowsHost) {
      setCertbotCertificates([]);
      return;
    }

    const result = await runCommand(createCertbotListCommand());
    setCertbotCertificates(parseCertbotList([result.stdout, result.stderr].filter(Boolean).join('\n')));
  }, [isWindowsHost, runCommand]);

  const refreshRenewalStatus = useCallback(async () => {
    if (isWindowsHost) {
      setRenewalStatus(null);
      return;
    }

    setRenewalLoading(true);
    try {
      const result = await runCommand(createCertbotRenewalStatusCommand(isWindowsHost));
      const parsed = parseCertbotRenewalStatus([result.stdout, result.stderr].filter(Boolean).join('\n'));
      setRenewalStatus(parsed);
    } catch (error) {
      setRenewalStatus({
        state: 'unknown',
        backend: 'unknown',
        timerName: '',
        serviceName: '',
        cronPath: '',
        nextRun: '',
        lastResult: getErrorMessage(error),
        rawOutput: '',
      });
    } finally {
      setRenewalLoading(false);
    }
  }, [isWindowsHost, runCommand]);

  const refresh = useCallback(async () => {
    const requestId = siteRequestIdRef.current + 1;
    siteRequestIdRef.current = requestId;
    setSiteLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createCertScanCommand(isWindowsHost));
      if (siteRequestIdRef.current !== requestId) return;
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
      if (siteRequestIdRef.current !== requestId) return;
      await refreshRenewalStatus();
      if (siteRequestIdRef.current !== requestId) return;
      setNotice(tCurrent('auto.remoteCertManager.scanComplete', { value0: parsed.certificates.length }));
      if (parsed.errors.length) {
        setError(parsed.errors.slice(0, 4).join('\n'));
      }
    } catch (error) {
      if (siteRequestIdRef.current !== requestId) return;
      setCertificates([]);
      setCertbotCertificates([]);
      setSelectedDetail(null);
      setError(getErrorMessage(error));
    } finally {
      if (siteRequestIdRef.current === requestId) setSiteLoading(false);
    }
  }, [isWindowsHost, refreshCertbotList, refreshRenewalStatus, runCommand]);

  const refreshTrustedRoots = useCallback(async () => {
    const requestId = trustedRootsRequestIdRef.current + 1;
    trustedRootsRequestIdRef.current = requestId;
    setRootLoading(true);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createTrustedRootScanCommand(isWindowsHost));
      if (trustedRootsRequestIdRef.current !== requestId) return;
      const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const parsed = parseTrustedRootScanOutput(combinedOutput);
      setTrustedRoots(parsed.certificates);
      setRawOutput(parsed.rawOutput);
      setSelectedRootId((current) => (
        current && parsed.certificates.some((cert) => cert.id === current)
          ? current
          : parsed.certificates[0]?.id ?? ''
      ));
      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      setNotice(tCurrent('auto.remoteCertManager.rootScanComplete', { value0: parsed.certificates.length }));
      if (parsed.errors.length) {
        setError(parsed.errors.slice(0, 4).join('\n'));
      }
    } catch (error) {
      if (trustedRootsRequestIdRef.current !== requestId) return;
      setTrustedRoots([]);
      setSelectedRootDetail(null);
      setError(getErrorMessage(error));
    } finally {
      if (trustedRootsRequestIdRef.current === requestId) setRootLoading(false);
    }
  }, [isWindowsHost, runCommand]);

  const refreshActiveTab = useCallback(() => {
    return activeTab === 'roots' ? refreshTrustedRoots() : refresh();
  }, [activeTab, refresh, refreshTrustedRoots]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const refreshKey = `${connectionId}:${isWindowsHost}`;
    if (activeTab === 'roots' && trustedRoots.length === 0 && trustedRootsAutoRefreshKeyRef.current !== refreshKey) {
      trustedRootsAutoRefreshKeyRef.current = refreshKey;
      void refreshTrustedRoots();
    }
  }, [activeTab, connectionId, isWindowsHost, refreshTrustedRoots, trustedRoots.length]);

  useEffect(() => {
    if (!selectedCertificate) {
      setSelectedDetail(null);
      return;
    }

    let cancelled = false;
    setSelectedDetail(null);

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

    const timeoutId = window.setTimeout(() => {
      void loadDetail();
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [isWindowsHost, runCommand, selectedCertificate?.id]);

  useEffect(() => {
    if (activeTab !== 'roots') return undefined;

    if (!selectedTrustedRoot) {
      setSelectedRootDetail(null);
      return undefined;
    }

    let cancelled = false;
    setSelectedRootDetail(null);

    const loadDetail = async () => {
      setRootDetailLoading(true);
      setError('');

      try {
        const result = await runCommand(createTrustedRootDetailCommand(selectedTrustedRoot.filePath, isWindowsHost));
        const detail = parseTrustedRootDetail([result.stdout, result.stderr].filter(Boolean).join('\n'));
        if (!cancelled) setSelectedRootDetail(detail);
      } catch (error) {
        if (!cancelled) {
          setSelectedRootDetail({ ...selectedTrustedRoot, rawText: '', pem: undefined });
          setError(getErrorMessage(error));
        }
      } finally {
        if (!cancelled) setRootDetailLoading(false);
      }
    };

    const timeoutId = window.setTimeout(() => {
      void loadDetail();
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeTab, isWindowsHost, runCommand, selectedTrustedRoot?.id]);

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

  const executeRenewalAction = async () => {
    if (!pendingRenewalAction) return;

    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const command = pendingRenewalAction === 'create'
        ? createEnableCertbotRenewalCommand(isWindowsHost)
        : pendingRenewalAction === 'delete'
          ? createDeleteCertbotRenewalCommand(isWindowsHost)
          : createSetCertbotRenewalEnabledCommand(pendingRenewalAction === 'enable', isWindowsHost);
      const result = await runCommand(command);
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      setRawOutput(output);
      if (result.code !== 0) throw new Error(output || tCurrent('auto.remoteCertManager.actionFailed'));
      setNotice(getRenewalNotice(pendingRenewalAction));
      setPendingRenewalAction(null);
      await refreshRenewalStatus();
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const viewRenewalLog = async () => {
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createCertbotRenewalLogCommand(isWindowsHost));
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || tCurrent('auto.remoteCertManager.noEntries');
      setRawOutput(output);
      if (result.code !== 0) throw new Error(output);
      setNotice(tCurrent('auto.remoteCertManager.renewal.notice.logLoaded'));
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setActionRunning(false);
    }
  };

  const copyFingerprint = async () => {
    const fingerprint = activeTab === 'roots'
      ? selectedRootDetail?.sha256Fingerprint || selectedTrustedRoot?.sha256Fingerprint
      : selectedDetail?.sha256Fingerprint || selectedCertificate?.sha256Fingerprint;
    if (!fingerprint) return;

    try {
      await navigator.clipboard.writeText(fingerprint);
      setNotice(tCurrent('auto.remoteCertManager.fingerprintCopied'));
    } catch (error) {
      setError(tCurrent('auto.remoteCertManager.copyFailed', { value0: getErrorMessage(error) }));
    }
  };

  const viewPem = () => {
    const pem = activeTab === 'roots' ? selectedRootDetail?.pem : selectedDetail?.pem;
    if (!pem) return;
    setRawOutput(pem);
    setNotice(tCurrent('auto.remoteCertManager.pemShown'));
  };

  const addTrustedRoot = async (overridePath?: string) => {
    const filePath = (overridePath ?? caPathDraft).trim();
    if (!filePath) {
      setError(tCurrent('auto.remoteCertManager.caPathRequired'));
      return;
    }

    const requestId = addTrustedRootRequestIdRef.current + 1;
    addTrustedRootRequestIdRef.current = requestId;
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createAddTrustedRootCommand(filePath, isWindowsHost));
      if (addTrustedRootRequestIdRef.current !== requestId) return;
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      setRawOutput(output);
      if (result.code !== 0) throw new Error(output || tCurrent('auto.remoteCertManager.actionFailed'));
      setNotice(tCurrent('auto.remoteCertManager.rootAdded'));
      setCaPathDraft('');
      await refreshTrustedRoots();
    } catch (error) {
      if (addTrustedRootRequestIdRef.current !== requestId) return;
      setError(getErrorMessage(error));
    } finally {
      if (addTrustedRootRequestIdRef.current === requestId) setActionRunning(false);
    }
  };

  const uploadAndAddTrustedRoot = async () => {
    const api = window.guiSSH?.connections;
    if (!api) {
      setError(tCurrent('auto.remoteCertManager.actionFailed'));
      return;
    }

    setUploadRunning(true);
    setError('');
    setNotice('');

    try {
      const uploadResult = await api.uploadFile(connectionId, '/tmp');
      if (uploadResult.canceled) {
        return;
      }

      const uploadedPath = uploadResult.remotePaths?.[0] ?? uploadResult.remotePath ?? '';
      if (!uploadedPath) {
        setError(tCurrent('auto.remoteCertManager.actionFailed'));
        return;
      }

      await addTrustedRoot(uploadedPath);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setUploadRunning(false);
    }
  };

  const removeTrustedRoot = async () => {
    if (!pendingRootRemoval) return;

    const requestId = removeTrustedRootRequestIdRef.current + 1;
    removeTrustedRootRequestIdRef.current = requestId;
    setActionRunning(true);
    setError('');
    setNotice('');

    try {
      const result = await runCommand(createRemoveTrustedRootCommand(pendingRootRemoval.filePath, isWindowsHost));
      if (removeTrustedRootRequestIdRef.current !== requestId) return;
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      setRawOutput(output);
      if (result.code !== 0) throw new Error(output || tCurrent('auto.remoteCertManager.actionFailed'));
      setNotice(tCurrent('auto.remoteCertManager.rootRemoved'));
      setPendingRootRemoval(null);
      await refreshTrustedRoots();
    } catch (error) {
      if (removeTrustedRootRequestIdRef.current !== requestId) return;
      setError(getErrorMessage(error));
    } finally {
      if (removeTrustedRootRequestIdRef.current === requestId) setActionRunning(false);
    }
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

  const rootDetailRows = [
    [tCurrent('auto.remoteCertManager.field.subject'), selectedRootDetail?.subjectCommonName],
    [tCurrent('auto.remoteCertManager.field.subjectFull'), selectedRootDetail?.subject],
    [tCurrent('auto.remoteCertManager.field.issuer'), selectedRootDetail?.issuer],
    [tCurrent('auto.remoteCertManager.field.notAfter'), selectedRootDetail?.notAfter],
    [tCurrent('auto.remoteCertManager.field.daysRemaining'), selectedRootDetail?.daysRemaining],
    [tCurrent('auto.remoteCertManager.field.serialNumber'), selectedRootDetail?.serialNumber],
    [tCurrent('auto.remoteCertManager.field.fingerprint'), selectedRootDetail?.sha256Fingerprint],
    [tCurrent('auto.remoteCertManager.field.path'), selectedRootDetail?.filePath],
  ] as const;
  const activeLoading = activeTab === 'roots' ? rootLoading : siteLoading;
  const canManageRenewalSchedule = renewalStatus?.backend === 'systemd'
    || (renewalStatus?.backend === 'cron' && renewalStatus.cronPath.includes('shelldesk-certbot-renew'));
  const canDeleteRenewalSchedule = renewalStatus?.timerName === 'shelldesk-certbot-renew.timer'
    || (renewalStatus?.backend === 'cron' && renewalStatus.cronPath.includes('shelldesk-certbot-renew'));
  const modalOpen = Boolean(pendingAction || pendingRenewalAction || pendingRootRemoval);
  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (pendingAction) setPendingAction(null);
      if (pendingRenewalAction) setPendingRenewalAction(null);
      if (pendingRootRemoval) setPendingRootRemoval(null);
      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? []);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!modalOpen) return;
    window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')?.focus();
    }, 0);
  }, [modalOpen]);

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
            placeholder={activeTab === 'roots' ? tCurrent('auto.remoteCertManager.rootSearchPlaceholder') : tCurrent('auto.remoteCertManager.searchPlaceholder')}
          />
        </div>
        <div className="cert-toolbar-actions">
          <button type="button" onClick={refreshActiveTab} disabled={activeLoading}>{activeLoading ? tCurrent('auto.remoteCertManager.refreshing') : tCurrent('auto.remoteCertManager.refresh')}</button>
          {activeTab === 'site' ? (
            <>
              <button type="button" className="primary" onClick={() => setPendingAction('dry-run')} disabled={!certbotInstalled || actionRunning}>{tCurrent('auto.remoteCertManager.dryRun')}</button>
              <button type="button" className="danger" onClick={() => setPendingAction('renew')} disabled={!certbotInstalled || actionRunning}>{tCurrent('auto.remoteCertManager.renew')}</button>
            </>
          ) : null}
        </div>
      </header>

      <div className="cert-actions cert-tabs" role="tablist" aria-label={tCurrent('auto.remoteCertManager.tabsLabel')}>
        <button type="button" role="tab" className={activeTab === 'site' ? 'active' : ''} aria-selected={activeTab === 'site'} onClick={() => setActiveTab('site')}>
          {tCurrent('auto.remoteCertManager.tab.site')}
        </button>
        <button type="button" role="tab" className={activeTab === 'roots' ? 'active' : ''} aria-selected={activeTab === 'roots'} onClick={() => setActiveTab('roots')}>
          {tCurrent('auto.remoteCertManager.tab.roots')}
        </button>
      </div>

      {error ? <DismissibleAlert className="cert-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="cert-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      {activeTab === 'site' ? <div className="cert-layout">
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
            {!filteredCertificates.length ? <div className="cert-empty-state">{siteLoading ? tCurrent('auto.remoteCertManager.loading') : tCurrent('auto.remoteCertManager.empty')}</div> : null}
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
              <button type="button" onClick={refresh} disabled={siteLoading}>{tCurrent('auto.remoteCertManager.refresh')}</button>
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
            <div className="certbot-list">
              <div className={`certbot-item ${renewalStatus?.state === 'enabled' ? 'valid' : renewalStatus?.state === 'disabled' ? 'warning' : 'unknown'}`}>
                <strong>{tCurrent('auto.remoteCertManager.renewal.title')}</strong>
                <span>{getRenewalStateLabel(renewalStatus)}</span>
                <em>{renewalLoading ? tCurrent('auto.remoteCertManager.renewal.loading') : getRenewalBackendLabel(renewalStatus)}</em>
              </div>
              <dl className="cert-detail-list">
                <div>
                  <dt>{tCurrent('auto.remoteCertManager.renewal.nextRun')}</dt>
                  <dd>{renewalStatus?.nextRun || '-'}</dd>
                </div>
                <div>
                  <dt>{tCurrent('auto.remoteCertManager.renewal.lastResult')}</dt>
                  <dd>{renewalStatus?.lastResult || tCurrent('auto.remoteCertManager.noEntries')}</dd>
                </div>
              </dl>
              <div className="cert-actions">
                <button type="button" onClick={refreshRenewalStatus} disabled={renewalLoading || actionRunning}>
                  {renewalLoading ? tCurrent('auto.remoteCertManager.refreshing') : tCurrent('auto.remoteCertManager.refresh')}
                </button>
                {renewalStatus?.state === 'enabled' && canManageRenewalSchedule ? (
                  <button type="button" onClick={() => setPendingRenewalAction('disable')} disabled={actionRunning}>
                    {tCurrent('auto.remoteCertManager.renewal.disable')}
                  </button>
                ) : renewalStatus?.state === 'disabled' && canManageRenewalSchedule ? (
                  <button type="button" className="primary" onClick={() => setPendingRenewalAction('enable')} disabled={actionRunning}>
                    {tCurrent('auto.remoteCertManager.renewal.enable')}
                  </button>
                ) : renewalStatus?.state === 'not-configured' || !renewalStatus ? (
                  <button type="button" className="primary" onClick={() => setPendingRenewalAction('create')} disabled={!certbotInstalled || actionRunning}>
                    {tCurrent('auto.remoteCertManager.renewal.create')}
                  </button>
                ) : null}
                <button type="button" onClick={viewRenewalLog} disabled={actionRunning}>
                  {tCurrent('auto.remoteCertManager.renewal.viewLog')}
                </button>
                {canDeleteRenewalSchedule ? (
                  <button type="button" className="danger" onClick={() => setPendingRenewalAction('delete')} disabled={actionRunning}>
                    {tCurrent('auto.remoteCertManager.renewal.delete')}
                  </button>
                ) : null}
              </div>
            </div>
            <pre className="cert-raw-output">{rawOutput || tCurrent('auto.remoteCertManager.noRawOutput')}</pre>
          </section>
        </main>
      </div> : null}

      {activeTab === 'roots' ? <div className="cert-layout">
        <aside className="cert-list">
          <div className="cert-list-head">
            <strong>{tCurrent('auto.remoteCertManager.trustedRoots')}</strong>
            <span>{filteredTrustedRoots.length}</span>
          </div>
          <div className="cert-list-scroll">
            {filteredTrustedRoots.map((cert) => (
              <button
                key={cert.id}
                type="button"
                className={selectedTrustedRoot?.id === cert.id ? 'active' : ''}
                onClick={() => setSelectedRootId(cert.id)}
              >
                <span className={`cert-expiry-dot ${cert.status}`} />
                <strong title={getTrustedRootTitle(cert)}>{getTrustedRootTitle(cert)}</strong>
                <em>{getStatusLabel(cert.status, cert.daysRemaining)}</em>
                <small title={cert.filePath}>{cert.filePath}</small>
              </button>
            ))}
            {!filteredTrustedRoots.length ? <div className="cert-empty-state">{rootLoading ? tCurrent('auto.remoteCertManager.loadingRoots') : tCurrent('auto.remoteCertManager.emptyRoots')}</div> : null}
          </div>
        </aside>

        <main className="cert-main">
          <section className="cert-detail-panel">
            <div className="cert-detail-hero">
              <span>{selectedTrustedRoot ? getStatusLabel(selectedTrustedRoot.status, selectedTrustedRoot.daysRemaining) : tCurrent('auto.remoteCertManager.status.unknown')}</span>
              <strong>{rootDetailLoading ? tCurrent('auto.remoteCertManager.loadingDetail') : getTrustedRootTitle(selectedRootDetail ?? selectedTrustedRoot)}</strong>
              <em>{selectedTrustedRoot?.filePath ?? tCurrent('auto.remoteCertManager.noCertificatePath')}</em>
            </div>
            <dl className="cert-detail-list">
              {rootDetailRows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{formatDetailValue(value)}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="cert-actions-panel">
            <div className="cert-actions-head">
              <strong>{tCurrent('auto.remoteCertManager.rootActions')}</strong>
              <span>{tCurrent('auto.remoteCertManager.rootCount', { value0: trustedRoots.length })}</span>
            </div>
            <div className="cert-actions">
              <button type="button" onClick={refreshTrustedRoots} disabled={rootLoading}>{tCurrent('auto.remoteCertManager.refresh')}</button>
              <button type="button" onClick={viewPem} disabled={!selectedRootDetail?.pem}>{tCurrent('auto.remoteCertManager.viewPem')}</button>
              <button type="button" onClick={copyFingerprint} disabled={!selectedTrustedRoot?.sha256Fingerprint}>{tCurrent('auto.remoteCertManager.copyFingerprint')}</button>
              <button type="button" className="danger" onClick={() => selectedTrustedRoot && setPendingRootRemoval(selectedTrustedRoot)} disabled={!selectedTrustedRoot || actionRunning}>
                {tCurrent('auto.remoteCertManager.removeTrust')}
              </button>
            </div>
            <div className="cert-search">
              <input
                value={caPathDraft}
                onChange={(event) => setCaPathDraft(event.target.value)}
                placeholder={tCurrent('auto.remoteCertManager.caPathPlaceholder')}
              />
              <button type="button" className="primary" onClick={() => addTrustedRoot()} disabled={actionRunning || !caPathDraft.trim()}>
                {actionRunning ? tCurrent('auto.remoteCertManager.running') : tCurrent('auto.remoteCertManager.addTrust')}
              </button>
              <button type="button" onClick={uploadAndAddTrustedRoot} disabled={actionRunning || uploadRunning}>
                {uploadRunning ? tCurrent('auto.remoteCertManager.running') : tCurrent('auto.remoteCertManager.uploadCa')}
              </button>
            </div>
            <pre className="cert-raw-output">{rawOutput || tCurrent('auto.remoteCertManager.noRawOutput')}</pre>
          </section>
        </main>
      </div> : null}

      {pendingAction ? createPortal(
        <div className="cert-modal-backdrop" role="presentation" onClick={() => setPendingAction(null)}>
          <div ref={dialogRef} className={`cert-confirm-dialog ${pendingAction === 'renew' ? 'danger' : ''}`} role="dialog" aria-modal="true" aria-labelledby="cert-action-dialog-title" onClick={(event) => event.stopPropagation()} onKeyDown={handleDialogKeyDown}>
            <div className="cert-confirm-header">
              <span id="cert-action-dialog-title">{pendingAction === 'renew' ? tCurrent('auto.remoteCertManager.renewConfirmTitle') : tCurrent('auto.remoteCertManager.dryRunConfirmTitle')}</span>
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
      {pendingRenewalAction ? createPortal(
        <div className="cert-modal-backdrop" role="presentation" onClick={() => setPendingRenewalAction(null)}>
          <div ref={dialogRef} className={`cert-confirm-dialog ${pendingRenewalAction === 'delete' ? 'danger' : ''}`} role="dialog" aria-modal="true" aria-labelledby="cert-renewal-dialog-title" onClick={(event) => event.stopPropagation()} onKeyDown={handleDialogKeyDown}>
            <div className="cert-confirm-header">
              <span id="cert-renewal-dialog-title">{tCurrent('auto.remoteCertManager.renewal.confirm.title')}</span>
              <strong>{getRenewalActionLabel(pendingRenewalAction)}</strong>
            </div>
            <p>{getRenewalActionBody(pendingRenewalAction)}</p>
            <pre>{(pendingRenewalAction === 'create'
              ? createEnableCertbotRenewalCommand(isWindowsHost)
              : pendingRenewalAction === 'delete'
                ? createDeleteCertbotRenewalCommand(isWindowsHost)
                : createSetCertbotRenewalEnabledCommand(pendingRenewalAction === 'enable', isWindowsHost)).command}</pre>
            <div className="cert-confirm-actions">
              <button type="button" onClick={() => setPendingRenewalAction(null)}>{tCurrent('auto.remoteCertManager.cancel')}</button>
              <button type="button" className={pendingRenewalAction === 'delete' ? 'danger' : 'primary'} onClick={executeRenewalAction} disabled={actionRunning}>
                {actionRunning ? tCurrent('auto.remoteCertManager.running') : tCurrent('auto.remoteCertManager.confirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {pendingRootRemoval ? createPortal(
        <div className="cert-modal-backdrop" role="presentation" onClick={() => setPendingRootRemoval(null)}>
          <div ref={dialogRef} className="cert-confirm-dialog danger" role="dialog" aria-modal="true" aria-labelledby="cert-root-removal-dialog-title" onClick={(event) => event.stopPropagation()} onKeyDown={handleDialogKeyDown}>
            <div className="cert-confirm-header">
              <span id="cert-root-removal-dialog-title">{tCurrent('auto.remoteCertManager.removeTrustConfirmTitle')}</span>
              <strong>{getTrustedRootTitle(pendingRootRemoval)}</strong>
            </div>
            <p>{tCurrent('auto.remoteCertManager.removeTrustConfirmBody', { value0: pendingRootRemoval.filePath })}</p>
            <pre>{createRemoveTrustedRootCommand(pendingRootRemoval.filePath, isWindowsHost).command}</pre>
            <div className="cert-confirm-actions">
              <button type="button" onClick={() => setPendingRootRemoval(null)}>{tCurrent('auto.remoteCertManager.cancel')}</button>
              <button type="button" className="danger" onClick={removeTrustedRoot} disabled={actionRunning}>
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
