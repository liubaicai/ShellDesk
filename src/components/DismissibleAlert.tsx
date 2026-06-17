import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t, useCurrentAppLanguage } from '../i18n';

const alertAutoDismissMs = 5000;
const alertLayerId = 'shelldesk-alert-layer';
const alertLogEventName = 'shelldesk:log-entry';
const recentAlertLogKeys = new Map<string, number>();

interface DismissibleAlertProps {
  className: string;
  children: ReactNode;
  onDismiss: () => void;
  role?: 'alert' | 'status';
  source?: string;
}

function createLogId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `alert:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function extractTextContent(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') {
    return '';
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => extractTextContent(child)).filter(Boolean).join(' ');
  }

  if (typeof node === 'object' && 'props' in node) {
    return extractTextContent((node as { props?: { children?: ReactNode } }).props?.children);
  }

  return '';
}

function getAlertLayer() {
  let layer = document.getElementById(alertLayerId);

  if (!layer) {
    layer = document.createElement('div');
    layer.id = alertLayerId;
    layer.className = 'shelldesk-alert-layer';
    document.body.appendChild(layer);
  }

  return layer;
}

function isErrorAlert(className: string, role: DismissibleAlertProps['role']) {
  return role === 'alert' || /\b(error|danger)\b/iu.test(className);
}

function getAlertSource(className: string, source?: string) {
  if (source?.trim()) {
    return source.trim();
  }

  const sourceMatchers: Array<[RegExp, string]> = [
    [/\bapi-alert\b/u, 'RemoteApiDebugger'],
    [/\bcontainer-alert\b/u, 'RemoteContainerManager'],
    [/\bdisk-manager-alert\b/u, 'RemoteDiskManager'],
    [/\bdisk-alert\b/u, 'RemoteDiskAnalyzer'],
    [/\bfile-picker-error\b/u, 'RemoteFilePicker'],
    [/\bfirewall-alert\b/u, 'RemoteFirewallManager'],
    [/\bgit-alert\b/u, 'RemoteGitManager'],
    [/\biptables-alert\b/u, 'RemoteIptablesManager'],
    [/\blog-alert\b/u, 'RemoteLogViewer'],
    [/\blogin-alert\b/u, 'RemoteLoginSessions'],
    [/\bmongo-alert\b/u, 'RemoteMongo'],
    [/\bmq-alert\b/u, 'RemoteMessageQueuePanel'],
    [/\bmysql-/u, 'RemoteMySQL'],
    [/\bnetwork-alert\b/u, 'RemoteNetworkDiagnostics'],
    [/\bpackage-alert\b/u, 'RemotePackageManager'],
    [/\bport-alert\b/u, 'RemotePortManager'],
    [/\bpostgres-message\b/u, 'RemotePostgres'],
    [/\bproc-alert\b/u, 'RemoteProcessManager'],
    [/\bredis-/u, 'RemoteRedis'],
    [/\bs3-alert\b/u, 'RemoteS3Browser'],
    [/\bscheduled-alert\b/u, 'RemoteScheduledTasks'],
    [/\bsearch-alert\b/u, 'RemoteSearchCluster'],
    [/\bsecurity-alert\b/u, 'RemoteSecurityAudit'],
    [/\bservice-alert\b/u, 'RemoteServiceManager'],
    [/\bsettings-success-banner\b/u, 'RemoteSettings'],
    [/\bsqlite-/u, 'RemoteSqlite'],
    [/\bvnc-error-banner\b/u, 'RemoteVncViewer'],
    [/\berror-banner\b/u, 'ShellDesk'],
  ];

  return sourceMatchers.find(([pattern]) => pattern.test(className))?.[1] ?? 'ShellDesk';
}

function shouldLogAlert(alertKey: string) {
  const now = Date.now();

  for (const [key, timestamp] of recentAlertLogKeys) {
    if (now - timestamp > alertAutoDismissMs) {
      recentAlertLogKeys.delete(key);
    }
  }

  const lastLoggedAt = recentAlertLogKeys.get(alertKey);
  if (lastLoggedAt && now - lastLoggedAt < alertAutoDismissMs) {
    return false;
  }

  recentAlertLogKeys.set(alertKey, now);
  return true;
}

function DismissibleAlert({ className, children, onDismiss, role = 'status', source }: DismissibleAlertProps) {
  const language = useCurrentAppLanguage();
  const closeLabel = t('common.closeAlert', language);
  const [portalElement, setPortalElement] = useState<HTMLDivElement | null>(null);
  const alertText = useMemo(() => extractTextContent(children).replace(/\s+/gu, ' ').trim(), [children]);
  const alertSource = useMemo(() => getAlertSource(className, source), [className, source]);
  const loggedAlertKeyRef = useRef('');

  useEffect(() => {
    const layer = getAlertLayer();
    const element = document.createElement('div');
    element.className = 'shelldesk-alert-slot';
    layer.appendChild(element);
    setPortalElement(element);

    return () => {
      element.remove();
      if (!layer.childElementCount) {
        layer.remove();
      }
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(onDismiss, alertAutoDismissMs);
    return () => window.clearTimeout(timer);
  }, [alertText, onDismiss]);

  useEffect(() => {
    if (!alertText || !isErrorAlert(className, role)) {
      return;
    }

    const hostContext = window.__shellDeskLogContext;
    const alertKey = `${className}:${alertSource}:${hostContext?.hostId ?? ''}:${hostContext?.hostAddress ?? ''}:${alertText}`;
    if (loggedAlertKeyRef.current === alertKey) {
      return;
    }

    loggedAlertKeyRef.current = alertKey;

    if (!shouldLogAlert(alertKey)) {
      return;
    }

    const entry: ShellDeskLogEntry = {
      id: createLogId(),
      timestamp: new Date().toISOString(),
      category: 'system',
      level: 'error',
      message: language === 'zh-CN' ? `组件提示错误：${alertSource}` : `Component alert error: ${alertSource}`,
      detail: language === 'zh-CN' ? `组件：${alertSource}\n${alertText}` : `Component: ${alertSource}\n${alertText}`,
      component: alertSource,
      hostId: hostContext?.hostId,
      hostName: hostContext?.hostName,
      hostAddress: hostContext?.hostAddress,
    };

    void window.guiSSH?.logs?.appendEntry(entry).catch(() => undefined);
    window.dispatchEvent(new CustomEvent<ShellDeskLogEntry>(alertLogEventName, { detail: entry }));
  }, [alertSource, alertText, className, language, role]);

  const alert = (
    <div className={`dismissible-alert ${className}`} role={role}>
      <span className="dismissible-alert-content">{children}</span>
      <button type="button" className="dismissible-alert-close" onClick={onDismiss} aria-label={closeLabel} title={closeLabel}>
        ×
      </button>
    </div>
  );

  if (!portalElement) {
    return null;
  }

  return createPortal(alert, portalElement);
}

export default DismissibleAlert;
