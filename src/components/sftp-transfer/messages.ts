import type { AppLanguage } from '../../i18n';

const zh = {
  title: '文件传输', connected: '已连接', local: '本地', remote: '远程', search: '搜索文件',
  newFolder: '新建文件夹', newFile: '新建文件', upload: '上传', download: '下载', refresh: '刷新',
  rename: '重命名', delete: '删除', properties: '属性', compare: '比较', sync: '同步目录',
  showHidden: '显示隐藏文件', back: '后退', forward: '前进', up: '上一级', home: '主目录',
  expand: '展开', collapse: '收起', path: '路径', directoryTree: '目录树',
  name: '名称', size: '大小', type: '类型', permission: '权限', modified: '修改时间', owner: '所有者',
  transferQueue: '传输队列', queue: '队列', transferring: '传输中', completed: '已完成', failed: '失败',
  all: '全部', clearFinished: '清除已完成', concurrency: '并行任务', afterComplete: '传输完成后', doNothing: '不做任何操作',
  cancel: '取消', confirm: '确认', retry: '重试', pause: '暂停', resume: '继续', remove: '移除',
  statusQueued: '排队中', statusRunning: '传输中', statusPaused: '已暂停', statusCompleted: '已完成', statusFailed: '失败', statusCanceled: '已取消',
  scanning: '正在扫描', scanningPath: '当前：{path}', discoveredEntries: '已发现 {files} 个文件、{directories} 个文件夹',
  preparing: '正在准备', establishingSession: '正在建立 SFTP 会话', preparedDirectories: '已准备 {completed}/{total} 个文件夹',
  empty: '此目录为空', noMatches: '没有匹配的文件', selected: '已选择', items: '项', files: '个文件', folderType: '文件夹', fileType: '文件', symlinkType: '符号链接',
  compareSame: '当前目录内容一致', compareDifferent: '已标记 {count} 个差异项',
  syncTitle: '同步当前目录', syncLocalRemote: '将本地差异同步到远程', syncRemoteLocal: '将远程差异同步到本地',
  deleteTitle: '确认删除', deleteMessage: '将永久删除所选的 {count} 个项目，此操作无法撤销。',
  deleting: '正在删除…',
  newFolderTitle: '新建文件夹', newFileTitle: '新建文件', renameTitle: '重命名', propertiesTitle: '文件属性',
  inputName: '名称', mode: '权限模式', recursive: '递归应用到子项目', save: '保存',
  sftpUnavailable: 'SFTP 子系统不可用', loading: '正在读取目录…',
  localSummary: '本地：{count} 项', remoteSummary: '远程：{count} 项', protected: '由 russh SFTP 加密传输', verified: '主机密钥已验证',
  speed: '速度', remaining: '剩余时间', direction: '方向', target: '目标路径', progress: '进度', status: '状态', action: '操作',
  uploadArrow: '上传选中项；未选择时上传当前目录内容', downloadArrow: '下载选中项；未选择时下载当前目录内容', pauseRestart: '暂停后继续会从当前文件开头重新传输',
  conflictTitle: '目标中已存在同名项目', conflictMessage: '目标位置已存在 {count} 个同名文件或文件夹，请选择处理方式。',
  conflictMergeHint: '覆盖将替换同名文件；同名文件夹会合并，并覆盖其中的同名文件。',
  conflictSkipHint: '跳过会继续遍历同名文件夹，仅跳过目标中已存在的子文件或类型冲突子目录，其余内容仍会传输。',
  conflictTypeMismatch: '其中 {count} 项的文件/文件夹类型不一致，覆盖时会先删除目标中的旧项目。',
  conflictMore: '另有 {count} 个冲突项目', conflictOverwrite: '覆盖 / 合并', conflictSkip: '跳过已存在项',
  conflictSkipped: '已跳过 {count} 个已存在项目', conflictSkipApplied: '已启用递归跳过，目标中已存在的项目不会被覆盖', conflictResolving: '正在处理冲突…',
};

const en: typeof zh = {
  title: 'File Transfer', connected: 'Connected', local: 'Local', remote: 'Remote', search: 'Search files',
  newFolder: 'New folder', newFile: 'New file', upload: 'Upload', download: 'Download', refresh: 'Refresh',
  rename: 'Rename', delete: 'Delete', properties: 'Properties', compare: 'Compare', sync: 'Synchronize',
  showHidden: 'Show hidden files', back: 'Back', forward: 'Forward', up: 'Up', home: 'Home',
  expand: 'Expand', collapse: 'Collapse', path: 'path', directoryTree: 'directory tree',
  name: 'Name', size: 'Size', type: 'Type', permission: 'Permissions', modified: 'Modified', owner: 'Owner',
  transferQueue: 'Transfer Queue', queue: 'Queued', transferring: 'Active', completed: 'Completed', failed: 'Failed',
  all: 'All', clearFinished: 'Clear finished', concurrency: 'Concurrent tasks', afterComplete: 'After transfer', doNothing: 'Do nothing',
  cancel: 'Cancel', confirm: 'Confirm', retry: 'Retry', pause: 'Pause', resume: 'Resume', remove: 'Remove',
  statusQueued: 'Queued', statusRunning: 'Transferring', statusPaused: 'Paused', statusCompleted: 'Completed', statusFailed: 'Failed', statusCanceled: 'Canceled',
  scanning: 'Scanning', scanningPath: 'Current: {path}', discoveredEntries: '{files} file(s), {directories} folder(s) found',
  preparing: 'Preparing', establishingSession: 'Establishing SFTP session', preparedDirectories: '{completed}/{total} folder(s) prepared',
  empty: 'This folder is empty', noMatches: 'No matching files', selected: 'Selected', items: 'items', files: 'files', folderType: 'Folder', fileType: 'File', symlinkType: 'Symlink',
  compareSame: 'The current directories match', compareDifferent: '{count} difference(s) highlighted',
  syncTitle: 'Synchronize Current Directories', syncLocalRemote: 'Sync local differences to remote', syncRemoteLocal: 'Sync remote differences to local',
  deleteTitle: 'Confirm deletion', deleteMessage: 'Permanently delete {count} selected item(s)? This cannot be undone.',
  deleting: 'Deleting…',
  newFolderTitle: 'New Folder', newFileTitle: 'New File', renameTitle: 'Rename', propertiesTitle: 'Properties',
  inputName: 'Name', mode: 'Permission mode', recursive: 'Apply recursively to child items', save: 'Save',
  sftpUnavailable: 'SFTP subsystem unavailable', loading: 'Reading directory…',
  localSummary: 'Local: {count} items', remoteSummary: 'Remote: {count} items', protected: 'Encrypted transfer via russh SFTP', verified: 'Host key verified',
  speed: 'Speed', remaining: 'ETA', direction: 'Direction', target: 'Target path', progress: 'Progress', status: 'Status', action: 'Actions',
  uploadArrow: 'Upload selected items; uploads the current folder contents when nothing is selected', downloadArrow: 'Download selected items; downloads the current folder contents when nothing is selected', pauseRestart: 'Resuming a paused task restarts the current file',
  conflictTitle: 'Items already exist at the destination', conflictMessage: '{count} file(s) or folder(s) with the same name already exist. Choose how to continue.',
  conflictMergeHint: 'Overwrite replaces files. Existing folders are merged and same-name files inside them are replaced.',
  conflictSkipHint: 'Skip still traverses existing folders. Only existing child files or type-conflicting folders are skipped; other content is transferred.',
  conflictTypeMismatch: '{count} item(s) have different file/folder types. Overwrite removes the old destination item first.',
  conflictMore: '{count} more conflicting item(s)', conflictOverwrite: 'Overwrite / Merge', conflictSkip: 'Skip existing',
  conflictSkipped: 'Skipped {count} existing item(s)', conflictSkipApplied: 'Recursive skip enabled. Existing destination items will not be overwritten.', conflictResolving: 'Resolving conflicts…',
};

export type SftpMessageKey = keyof typeof zh;

export function getSftpMessages(language: AppLanguage) {
  const messages = language === 'zh-CN' ? zh : en;
  return (key: SftpMessageKey, params?: Record<string, string | number>) => {
    let text = messages[key];
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
}
