import type { ReactNode } from 'react';

import { t, useCurrentAppLanguage } from '../i18n';

interface DismissibleAlertProps {
  className: string;
  children: ReactNode;
  onDismiss: () => void;
  role?: 'alert' | 'status';
}

function DismissibleAlert({ className, children, onDismiss, role = 'status' }: DismissibleAlertProps) {
  const language = useCurrentAppLanguage();
  const closeLabel = t('common.closeAlert', language);

  return (
    <div className={`dismissible-alert ${className}`} role={role}>
      <span className="dismissible-alert-content">{children}</span>
      <button type="button" className="dismissible-alert-close" onClick={onDismiss} aria-label={closeLabel} title={closeLabel}>
        ×
      </button>
    </div>
  );
}

export default DismissibleAlert;
