import {
  Archive,
  ArrowUpFromLine,
  ArrowDownUp,
  Copy,
  Database,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  Info,
  Monitor,
  Pencil,
  RefreshCw,
  Terminal,
  Trash2,
  Upload,
  type LucideIcon,
} from 'lucide-react';

type ContextMenuIconName =
  | 'archive'
  | 'copy'
  | 'database'
  | 'desktop'
  | 'download'
  | 'info'
  | 'move-desktop'
  | 'new-file'
  | 'new-folder'
  | 'notepad'
  | 'open'
  | 'refresh'
  | 'rename'
  | 'sort'
  | 'terminal'
  | 'trash'
  | 'upload';

interface ContextMenuIconProps {
  name: ContextMenuIconName;
}

const CONTEXT_MENU_ICONS: Record<ContextMenuIconName, LucideIcon> = {
  archive: Archive,
  copy: Copy,
  database: Database,
  desktop: Monitor,
  download: Download,
  info: Info,
  'move-desktop': ArrowUpFromLine,
  'new-file': FilePlus2,
  'new-folder': FolderPlus,
  notepad: FileText,
  open: FolderOpen,
  refresh: RefreshCw,
  rename: Pencil,
  sort: ArrowDownUp,
  terminal: Terminal,
  trash: Trash2,
  upload: Upload,
};

function ContextMenuIcon({ name }: ContextMenuIconProps) {
  const Icon = CONTEXT_MENU_ICONS[name];
  return <Icon className="context-menu-icon" size={16} aria-hidden="true" focusable="false" />;
}

export default ContextMenuIcon;
