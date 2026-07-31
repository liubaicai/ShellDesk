import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, FileUp, X } from 'lucide-react';
import type { AppLanguage } from '../i18n';
import {
  type HostImportCandidate,
  type HostImportDuplicateStrategy,
  parseHostImportFiles,
} from '../hostImport';
import type { Host } from '../appHostModel';
import {
  focusFirstElement,
  handleModalKeyboardNavigation,
} from '../features/remote-desktop/desktopKeyboardNavigation';
import DismissibleAlert from './DismissibleAlert';

interface HostImportWizardProps {
  language: AppLanguage;
  existingHosts: Host[];
  onApply: (
    candidates: HostImportCandidate[],
    selectedIds: ReadonlySet<string>,
    strategy: HostImportDuplicateStrategy,
    includePlaintextPasswords: boolean,
  ) => Promise<{ added: number; replaced: number; skipped: number }> | { added: number; replaced: number; skipped: number };
  onClose: () => void;
}

const previewRowHeight = 82;
const previewHeight = 360;
const previewOverscan = 4;

const zhImportMessages: Record<string, string> = {
  'Host address is missing.': '缺少主机地址。',
  'SSH port must be between 1 and 65535.': 'SSH 端口必须在 1 到 65535 之间。',
  'Username was empty and defaulted to root.': '用户名为空，已默认使用 root。',
  'The source password is encrypted by another client and cannot be migrated.': '源密码由其他客户端加密，无法迁移。',
  'A plaintext password was found; importing it is opt-in.': '发现明文密码，需明确启用后才会导入。',
  'Unsupported host migration format.': '不支持的主机迁移格式。',
  'CSV contains an unclosed quote.': 'CSV 中存在未闭合的引号。',
};

function localizeImportMessage(message: string, zh: boolean) {
  if (!zh) return message;
  const limitMatch = /^Import is limited to (\d+) hosts\.$/.exec(message);
  if (limitMatch) return `一次最多迁移 ${limitMatch[1]} 台主机。`;
  const xshellProtocolMatch = /^Unsupported Xshell protocol: (.+)$/.exec(message);
  if (xshellProtocolMatch) return `不支持的 Xshell 协议：${xshellProtocolMatch[1]}`;
  const secureCrtProtocolMatch = /^Unsupported SecureCRT protocol: (.+)$/.exec(message);
  if (secureCrtProtocolMatch) return `不支持的 SecureCRT 协议：${secureCrtProtocolMatch[1]}`;
  return zhImportMessages[message] ?? message;
}

function HostImportWizard({ language, existingHosts, onApply, onClose }: HostImportWizardProps) {
  const zh = language === 'zh-CN';
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [files, setFiles] = useState<Array<{ name: string; parentName: string; content: string }>>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<HostImportDuplicateStrategy>('skip');
  const [includePasswords, setIncludePasswords] = useState(false);
  const [search, setSearch] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ added: number; replaced: number; skipped: number } | null>(null);

  const preview = useMemo(() => parseHostImportFiles(files, existingHosts), [existingHosts, files]);
  const validCandidates = useMemo(
    () => preview.candidates.filter((candidate) => candidate.errors.length === 0),
    [preview.candidates],
  );
  const filteredCandidates = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    if (!keyword) return preview.candidates;
    return preview.candidates.filter((candidate) => [
      candidate.name,
      candidate.address,
      candidate.username,
      candidate.group,
      candidate.sourceFile,
    ].some((value) => value.toLocaleLowerCase().includes(keyword)));
  }, [preview.candidates, search]);
  const startIndex = Math.max(0, Math.floor(scrollTop / previewRowHeight) - previewOverscan);
  const endIndex = Math.min(
    filteredCandidates.length,
    Math.ceil((scrollTop + previewHeight) / previewRowHeight) + previewOverscan,
  );
  const visibleCandidates = filteredCandidates.slice(startIndex, endIndex);
  const duplicateCount = preview.candidates.filter((candidate) => candidate.conflict !== 'none').length;
  const plaintextPasswordCount = preview.candidates.filter((candidate) => candidate.secretKind === 'plaintext').length;
  const encryptedPasswordCount = preview.candidates.filter((candidate) => candidate.secretKind === 'encrypted').length;

  useEffect(() => {
    focusFirstElement(dialogRef.current, '.host-import-source .primary');
    return () => {
      const previousFocus = previousFocusRef.current;
      const restoreTarget = previousFocus?.closest('details')?.querySelector<HTMLElement>('summary')
        ?? previousFocus;
      if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
    };
  }, []);

  const chooseFiles = async () => {
    const selectFiles = window.guiSSH?.files.selectHostImportFiles;
    if (!selectFiles) {
      setError(zh ? '当前运行环境不支持选择主机迁移文件。' : 'This runtime cannot select host migration files.');
      return;
    }
    setPending(true);
    setError('');
    setResult(null);
    try {
      const nextFiles = await selectFiles();
      if (!nextFiles.length) return;
      const nextPreview = parseHostImportFiles(nextFiles, existingHosts);
      setFiles(nextFiles);
      setSelectedIds(new Set(
        nextPreview.candidates
          .filter((candidate) => candidate.errors.length === 0)
          .map((candidate) => candidate.id),
      ));
      setScrollTop(0);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : String(selectionError));
    } finally {
      setPending(false);
    }
  };

  const toggleCandidate = (candidate: HostImportCandidate) => {
    if (candidate.errors.length) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(candidate.id)) next.delete(candidate.id);
      else next.add(candidate.id);
      return next;
    });
  };

  const apply = async () => {
    if (!selectedIds.size) {
      setError(zh ? '至少选择一台有效主机。' : 'Select at least one valid host.');
      return;
    }
    setPending(true);
    setError('');
    try {
      const nextResult = await onApply(
        preview.candidates,
        selectedIds,
        strategy,
        includePasswords,
      );
      setResult(nextResult);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    } finally {
      setPending(false);
    }
  };

  const handlePreviewScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  return createPortal(
    <div className="host-import-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="host-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-import-title"
        tabIndex={-1}
        onKeyDown={(event) => handleModalKeyboardNavigation(event, event.currentTarget, onClose)}
      >
        <header className="host-import-header">
          <div>
            <strong id="host-import-title">{zh ? '迁移外部 SSH 主机' : 'Migrate SSH hosts'}</strong>
            <span>{zh ? '支持 MobaXterm、Xshell、SecureCRT 与 CSV；应用前先预览和去重。' : 'Supports MobaXterm, Xshell, SecureCRT, and CSV with preview and deduplication before applying.'}</span>
          </div>
          <button type="button" onClick={onClose} aria-label={zh ? '关闭主机迁移' : 'Close host migration'}>
            <X aria-hidden="true" />
          </button>
        </header>

        {error ? <DismissibleAlert className="host-import-alert danger" role="alert" onDismiss={() => setError('')}>{error}</DismissibleAlert> : null}

        {result ? (
          <div className="host-import-result">
            <CheckCircle2 aria-hidden="true" />
            <strong>{zh ? '主机迁移已应用' : 'Host migration applied'}</strong>
            <span>
              {zh
                ? `新增 ${result.added} 台，替换 ${result.replaced} 台，跳过 ${result.skipped} 台。`
                : `Added ${result.added}, replaced ${result.replaced}, skipped ${result.skipped}.`}
            </span>
            <p>{zh ? '可在主机工具栏中撤销本次导入；后续主机修改会使撤销失效。' : 'You can undo this import from the host toolbar. Later host edits invalidate the undo snapshot.'}</p>
          </div>
        ) : (
          <>
            <div className="host-import-source">
              <button type="button" className="primary" onClick={() => void chooseFiles()} disabled={pending}>
                <FileUp aria-hidden="true" />
                {pending ? (zh ? '读取中…' : 'Reading…') : (zh ? '选择迁移文件' : 'Select migration files')}
              </button>
              <div>
                <strong>{files.length ? (zh ? `已选择 ${files.length} 个文件` : `${files.length} files selected`) : (zh ? '尚未选择文件' : 'No files selected')}</strong>
                <span>{zh ? '最多 500 个文件、5000 台主机；支持 UTF-8 与带 BOM 的 UTF-16。' : 'Up to 500 files and 5,000 hosts; UTF-8 and BOM-marked UTF-16 are supported.'}</span>
              </div>
            </div>

            {preview.files.length ? (
              <div className="host-import-file-reports">
                {preview.files.map((file) => (
                  <span key={file.name} className={file.error ? 'error' : ''} title={file.error ? localizeImportMessage(file.error, zh) : undefined}>
                    {file.name} · {file.error ? localizeImportMessage(file.error, zh) : `${file.source} · ${file.candidateCount}`}
                  </span>
                ))}
              </div>
            ) : null}

            {preview.candidates.length ? (
              <>
                <div className="host-import-controls">
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => { setSearch(event.target.value); setScrollTop(0); }}
                    placeholder={zh ? '搜索名称、地址、用户或分组' : 'Search name, address, user, or group'}
                  />
                  <label>
                    <span>{zh ? '重复项处理' : 'Duplicates'}</span>
                    <select value={strategy} onChange={(event) => setStrategy(event.target.value as HostImportDuplicateStrategy)}>
                      <option value="skip">{zh ? '跳过重复项' : 'Skip duplicates'}</option>
                      <option value="replace">{zh ? '用导入配置替换' : 'Replace with imported settings'}</option>
                      <option value="keepBoth">{zh ? '保留两者并重命名' : 'Keep both and rename'}</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set(validCandidates.map((candidate) => candidate.id)))}
                  >
                    {zh ? '全选有效项' : 'Select valid'}
                  </button>
                  <button type="button" onClick={() => setSelectedIds(new Set())}>
                    {zh ? '清空选择' : 'Clear'}
                  </button>
                </div>

                <div className="host-import-summary">
                  <span>{zh ? `识别 ${preview.candidates.length} 台` : `${preview.candidates.length} detected`}</span>
                  <span>{zh ? `已选 ${selectedIds.size} 台` : `${selectedIds.size} selected`}</span>
                  <span className={duplicateCount ? 'warning' : ''}>{zh ? `重复 ${duplicateCount} 台` : `${duplicateCount} duplicates`}</span>
                  <span className={encryptedPasswordCount ? 'warning' : ''}>
                    {zh ? `不可迁移密文 ${encryptedPasswordCount} 条` : `${encryptedPasswordCount} encrypted secrets ignored`}
                  </span>
                </div>

                <div className="host-import-preview" style={{ height: previewHeight }} onScroll={handlePreviewScroll}>
                  <div className="host-import-preview-spacer" style={{ height: filteredCandidates.length * previewRowHeight }}>
                    {visibleCandidates.map((candidate, offset) => (
                      <label
                        key={candidate.id}
                        className={`host-import-row ${candidate.errors.length ? 'invalid' : ''}`}
                        style={{ transform: `translateY(${(startIndex + offset) * previewRowHeight}px)` }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(candidate.id)}
                          disabled={Boolean(candidate.errors.length)}
                          onChange={() => toggleCandidate(candidate)}
                        />
                        <span className="host-import-source-badge">{candidate.source}</span>
                        <span className="host-import-main">
                          <strong>{candidate.name}</strong>
                          <small>{candidate.username ? `${candidate.username}@` : ''}{candidate.address}:{candidate.port}</small>
                          <em>{candidate.group || candidate.sourceFile}</em>
                        </span>
                        <span className="host-import-state">
                          {candidate.errors.length ? (
                            <span className="error"><AlertTriangle aria-hidden="true" />{localizeImportMessage(candidate.errors[0], zh)}</span>
                          ) : candidate.conflict !== 'none' ? (
                            <span className="warning">{zh ? '重复项' : 'Duplicate'}</span>
                          ) : (
                            <span>{zh ? '可导入' : 'Ready'}</span>
                          )}
                          {candidate.warnings[0] ? <small>{localizeImportMessage(candidate.warnings[0], zh)}</small> : null}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {plaintextPasswordCount ? (
                  <label className="host-import-password-option">
                    <input type="checkbox" checked={includePasswords} onChange={(event) => setIncludePasswords(event.target.checked)} />
                    <span>
                      {zh
                        ? `导入 CSV 中发现的 ${plaintextPasswordCount} 个明文密码（默认关闭）`
                        : `Import ${plaintextPasswordCount} plaintext passwords found in CSV (off by default)`}
                    </span>
                  </label>
                ) : null}
              </>
            ) : null}
          </>
        )}

        <footer className="host-import-footer">
          <button type="button" onClick={onClose}>{result ? (zh ? '完成' : 'Done') : (zh ? '取消' : 'Cancel')}</button>
          {!result && preview.candidates.length ? (
            <button type="button" className="primary" disabled={pending || !selectedIds.size} onClick={() => void apply()}>
              {pending ? (zh ? '应用中…' : 'Applying…') : (zh ? `导入 ${selectedIds.size} 台` : `Import ${selectedIds.size} hosts`)}
            </button>
          ) : null}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export default HostImportWizard;
