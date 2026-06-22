import { t, type AppLanguage } from '../../i18n';
import { getTransferTaskStatusLabel } from './fileExplorerUtils';
import type { ExplorerTransferTask } from './fileExplorerTypes';

export type ExplorerSidebarIconType = 'home' | 'root' | 'folder' | 'drive' | 'favorite';

export interface ExplorerSidebarPath {
  label: string;
  path: string;
  icon: ExplorerSidebarIconType;
}

interface FileExplorerSidebarProps {
  currentPath: string;
  quickAccessPaths: ExplorerSidebarPath[];
  favorites: string[];
  language: AppLanguage;
  transferProgress: ShellDeskTransferProgress | null;
  transferItemLabel: string;
  transferQueue: ExplorerTransferTask[];
  onNavigate: (path: string) => void;
  onClearFinishedTransferTasks: () => void;
  onRetryTransferTask: (taskId: string) => void;
}

function ExplorerSidebarIcon({ icon }: { icon: ExplorerSidebarIconType }) {
  if (icon === 'drive') {
    return (
      <span className="sidebar-path-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <rect x="4.75" y="5.5" width="14.5" height="13" rx="2.25" />
          <path d="M7.75 15.75h8.5" />
          <path d="M16 9.25h.01" />
        </svg>
      </span>
    );
  }

  if (icon === 'folder') {
    return (
      <span className="sidebar-path-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M4.5 8.25h6.35l1.55 2h7.1" />
          <path d="M4.5 7.5v9.75c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2v-7c0-1.1-.9-2-2-2h-6.4L9.55 6.5H6.5c-1.1 0-2 .9-2 2Z" />
        </svg>
      </span>
    );
  }

  if (icon === 'favorite') {
    return (
      <span className="sidebar-path-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="m12 4.75 2.2 4.45 4.9.7-3.55 3.46.84 4.89L12 15.95l-4.39 2.3.84-4.89L4.9 9.9l4.9-.7L12 4.75Z" />
        </svg>
      </span>
    );
  }

  if (icon === 'root') {
    return (
      <span className="sidebar-path-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M12 4.75v14.5" />
          <path d="M7.5 9.25 12 4.75l4.5 4.5" />
          <path d="M6 19.25h12" />
        </svg>
      </span>
    );
  }

  return (
    <span className="sidebar-path-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M4.5 10.5 12 4.25l7.5 6.25" />
        <path d="M6.75 9.75v9.75h10.5V9.75" />
      </svg>
    </span>
  );
}

function getQueueProgressPercent(task: ExplorerTransferTask) {
  const progress = task.progress;

  if (progress) {
    if (progress.total > 0) {
      return Math.max(1, Math.min(100, Math.round((progress.transferred / progress.total) * 100)));
    }

    if ((progress.totalItems ?? 0) > 0) {
      return Math.max(1, Math.min(100, Math.round(((progress.completedItems ?? 0) / (progress.totalItems ?? 1)) * 100)));
    }

    return 10;
  }

  return task.status === 'success' ? 100 : 0;
}

function FileExplorerSidebar({
  currentPath,
  quickAccessPaths,
  favorites,
  language,
  transferProgress,
  transferItemLabel,
  transferQueue,
  onNavigate,
  onClearFinishedTransferTasks,
  onRetryTransferTask,
}: FileExplorerSidebarProps) {
  return (
    <aside className="explorer-sidebar" aria-label={t('fileExplorer.sidebar.aria', language)}>
      <div className="sidebar-section-title">{t('fileExplorer.sidebar.quickAccess', language)}</div>
      {quickAccessPaths.slice(0, 2).map((item) => (
        <button key={`${item.label}-${item.path}`} type="button" className={currentPath === item.path ? 'active' : ''} onClick={() => onNavigate(item.path)}>
          <ExplorerSidebarIcon icon={item.icon} />
          <span className="sidebar-path-label">{item.label}</span>
        </button>
      ))}
      <div className="sidebar-section-title">{t('fileExplorer.sidebar.commonDirs', language)}</div>
      {quickAccessPaths.slice(2).map((item) => (
        <button key={`${item.label}-${item.path}`} type="button" className={currentPath === item.path ? 'active' : ''} onClick={() => onNavigate(item.path)}>
          <ExplorerSidebarIcon icon={item.icon} />
          <span className="sidebar-path-label">{item.label}</span>
        </button>
      ))}
      <div className="sidebar-section-title">{t('fileExplorer.sidebar.favorites', language)}</div>
      {favorites.length ? favorites.map((path) => (
        <button key={path} type="button" className={currentPath === path ? 'active' : ''} onClick={() => onNavigate(path)} title={path}>
          <ExplorerSidebarIcon icon="favorite" />
          <span className="sidebar-path-label">{path}</span>
        </button>
      )) : (
        <div className="explorer-sidebar-note">{t('fileExplorer.sidebar.noFavorites', language)}</div>
      )}
      <div className="sidebar-section-title transfer-queue-title">
        <span>{t('fileExplorer.sidebar.transfer', language)}</span>
        {transferQueue.some((task) => task.status === 'success' || task.status === 'error' || task.status === 'canceled' || task.status === 'skipped') ? (
          <button type="button" onClick={onClearFinishedTransferTasks}>
            {language === 'zh-CN' ? '清理' : 'Clear'}
          </button>
        ) : null}
      </div>
      <div className={`explorer-transfer-card ${transferProgress ? 'running' : ''}`}>
        <strong>{transferProgress ? t('fileExplorer.transfer.running', language) : t('fileExplorer.transfer.idle', language)}</strong>
        <span>
          {transferProgress
            ? `${transferProgress.type === 'download' ? t('fileExplorer.transfer.download', language) : t('fileExplorer.transfer.upload', language)} ${transferItemLabel} · ${transferProgress.fileName}`
            : t('fileExplorer.transfer.empty', language)}
        </span>
      </div>
      <div className="explorer-transfer-queue" aria-label={language === 'zh-CN' ? '传输队列' : 'Transfer queue'}>
        {transferQueue.length ? transferQueue.slice(0, 8).map((task) => {
          const percent = getQueueProgressPercent(task);

          return (
            <div key={task.id} className={`transfer-queue-item ${task.status}`}>
              <div className="transfer-queue-row">
                <strong>{task.type === 'download' ? t('fileExplorer.transfer.download', language) : t('fileExplorer.transfer.upload', language)}</strong>
                <span>{getTransferTaskStatusLabel(task.status, language)}</span>
              </div>
              <div className="transfer-queue-name" title={task.label}>{task.label}</div>
              <div className="transfer-queue-detail" title={task.error || task.detail}>{task.error || task.detail}</div>
              <div className="transfer-queue-bar">
                <span style={{ width: `${percent}%` }} />
              </div>
              {task.status === 'error' ? (
                <button type="button" className="transfer-queue-retry" onClick={() => onRetryTransferTask(task.id)}>
                  {language === 'zh-CN' ? '重试' : 'Retry'}
                </button>
              ) : null}
            </div>
          );
        }) : (
          <div className="explorer-sidebar-note">{language === 'zh-CN' ? '上传或下载任务会显示在这里。' : 'Upload and download tasks appear here.'}</div>
        )}
      </div>
    </aside>
  );
}

export default FileExplorerSidebar;
