import { useCallback, useState } from 'react';
import type { AppLanguage } from '../../i18n';
import type { Host, LogCategory, LogHostMeta, LogLevel } from '../../appHostModel';
import {
  type HostImportCandidate,
  type HostImportDuplicateStrategy,
  planHostImport,
} from '../../hostImport';

interface HostImportWorkflowOptions {
  language: AppLanguage;
  readHosts: () => Host[];
  commitHosts: (hosts: Host[]) => void;
  createId: () => string;
  setStatusMessage: (message: string) => void;
  addLog: (
    category: LogCategory,
    level: LogLevel,
    message: string,
    detail?: string,
    hostMeta?: LogHostMeta,
  ) => void;
}

interface HostImportRollback {
  hosts: Host[];
  appliedSignature: string;
  added: number;
  replaced: number;
}

function cloneHosts(hosts: Host[]) {
  return hosts.map((host) => ({
    ...host,
    tags: [...host.tags],
    hostInfo: host.hostInfo
      ? { ...host.hostInfo, items: host.hostInfo.items.map((item) => ({ ...item })) }
      : null,
  }));
}

export function useHostImportWorkflow({
  language,
  readHosts,
  commitHosts,
  createId,
  setStatusMessage,
  addLog,
}: HostImportWorkflowOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [rollback, setRollback] = useState<HostImportRollback | null>(null);

  const apply = useCallback((
    candidates: HostImportCandidate[],
    selectedIds: ReadonlySet<string>,
    strategy: HostImportDuplicateStrategy,
    includePlaintextPasswords: boolean,
  ) => {
    const beforeHosts = cloneHosts(readHosts());
    const plan = planHostImport(
      beforeHosts,
      candidates,
      selectedIds,
      strategy,
      includePlaintextPasswords,
      new Date().toISOString(),
      createId,
    );
    setRollback({
      hosts: beforeHosts,
      appliedSignature: JSON.stringify(plan.hosts),
      added: plan.added,
      replaced: plan.replaced,
    });
    commitHosts(plan.hosts);
    setStatusMessage(language === 'zh-CN'
      ? `主机迁移完成：新增 ${plan.added} 台，替换 ${plan.replaced} 台，跳过 ${plan.skipped} 台。`
      : `Host migration complete: ${plan.added} added, ${plan.replaced} replaced, ${plan.skipped} skipped.`);
    addLog(
      'config',
      'success',
      language === 'zh-CN' ? '主机迁移完成' : 'Host migration completed',
      language === 'zh-CN'
        ? `新增 ${plan.added} 台，替换 ${plan.replaced} 台，跳过 ${plan.skipped} 台`
        : `${plan.added} added, ${plan.replaced} replaced, ${plan.skipped} skipped`,
    );
    return { added: plan.added, replaced: plan.replaced, skipped: plan.skipped };
  }, [addLog, commitHosts, createId, language, readHosts, setStatusMessage]);

  const undo = useCallback(() => {
    if (!rollback) return;
    if (JSON.stringify(readHosts()) !== rollback.appliedSignature) {
      setRollback(null);
      setStatusMessage(language === 'zh-CN'
        ? '主机列表已在迁移后发生变化，无法安全撤销。'
        : 'The host list changed after migration, so the import cannot be safely undone.');
      addLog(
        'config',
        'warning',
        language === 'zh-CN' ? '主机迁移撤销已拒绝' : 'Host migration undo rejected',
        language === 'zh-CN' ? '迁移后的主机列表已发生变化' : 'The host list changed after migration',
      );
      return;
    }
    commitHosts(rollback.hosts);
    setRollback(null);
    setStatusMessage(language === 'zh-CN'
      ? '已撤销上次主机迁移。'
      : 'The last host migration was undone.');
    addLog(
      'config',
      'success',
      language === 'zh-CN' ? '已撤销主机迁移' : 'Host migration undone',
      language === 'zh-CN'
        ? `恢复导入前快照：移除 ${rollback.added} 台，恢复 ${rollback.replaced} 台`
        : `Restored the pre-import snapshot: removed ${rollback.added}, restored ${rollback.replaced}`,
    );
  }, [addLog, commitHosts, language, readHosts, rollback, setStatusMessage]);

  return {
    isOpen,
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
    rollback,
    apply,
    undo,
    invalidateUndo: () => setRollback(null),
  };
}
