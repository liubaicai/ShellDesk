import type { ReactNode } from 'react';

interface DismissibleAlertProps {
  className: string;
  children: ReactNode;
  onDismiss: () => void;
  role?: 'alert' | 'status';
}

function DismissibleAlert({ className, children, onDismiss, role = 'status' }: DismissibleAlertProps) {
  return (
    <div className={`dismissible-alert ${className}`} role={role}>
      <span className="dismissible-alert-content">{children}</span>
      <button type="button" className="dismissible-alert-close" onClick={onDismiss} aria-label="关闭提示" title="关闭提示">
        ×
      </button>
    </div>
  );
}

export default DismissibleAlert;
