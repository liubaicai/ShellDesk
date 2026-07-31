import { FileUp, Undo2 } from 'lucide-react';
import type { AppLanguage } from '../i18n';

interface HostImportMenuActionsProps {
  language: AppLanguage;
  rollbackCount: number;
  onOpen: () => void;
  onUndo: () => void;
  onCloseMenu: (trigger: HTMLElement) => void;
}

function HostImportMenuActions({
  language,
  rollbackCount,
  onOpen,
  onUndo,
  onCloseMenu,
}: HostImportMenuActionsProps) {
  const run = (trigger: HTMLButtonElement, action: () => void) => {
    action();
    onCloseMenu(trigger);
  };

  return (
    <>
      <button type="button" onClick={(event) => run(event.currentTarget, onOpen)}>
        <FileUp aria-hidden="true" />
        {language === 'zh-CN' ? '迁移外部主机' : 'Migrate hosts'}
      </button>
      {rollbackCount ? (
        <button type="button" onClick={(event) => run(event.currentTarget, onUndo)}>
          <Undo2 aria-hidden="true" />
          {language === 'zh-CN'
            ? `撤销上次迁移（${rollbackCount} 台）`
            : `Undo migration (${rollbackCount})`}
        </button>
      ) : null}
    </>
  );
}

export default HostImportMenuActions;
