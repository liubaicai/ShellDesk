import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import {
  getTerminalSnippetGroups,
  getTerminalSnippetPreview,
} from '../../remoteDesktopWindowModel';
import { handleModalKeyboardNavigation } from '../../features/remote-desktop/desktopKeyboardNavigation';
import { t, type AppLanguage } from '../../i18n';

interface TerminalSnippetPickerPortalProps {
  language: AppLanguage;
  snippets: ShellDeskTerminalSnippet[];
  onCancel: () => void;
  onPick: (command: string) => void;
}

export function TerminalSnippetPickerPortal({
  language,
  snippets,
  onCancel,
  onPick,
}: TerminalSnippetPickerPortalProps) {
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const normalisedFilter = filter.trim().toLowerCase();

  const filteredSnippets = useMemo(() => {
    if (!normalisedFilter) return snippets;
    return snippets.filter((snippet) => {
      const haystack = `${snippet.label} ${snippet.group} ${snippet.command}`.toLowerCase();
      return haystack.includes(normalisedFilter);
    });
  }, [snippets, normalisedFilter]);

  const groups = useMemo(
    () => getTerminalSnippetGroups(filteredSnippets, language),
    [filteredSnippets, language],
  );

  const groupedItems = useMemo(() => {
    let index = 0;
    return groups.map((group) => ({
      label: group.label,
      items: group.snippets.map((snippet) => ({ snippet, index: index++ })),
    }));
  }, [groups]);

  const totalCount = filteredSnippets.length;

  useEffect(() => {
    setActiveIndex(0);
  }, [normalisedFilter]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!filteredSnippets.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((previous) =>
        (previous + step + filteredSnippets.length) % filteredSnippets.length,
      );
      return;
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      const active = filteredSnippets[Math.min(activeIndex, filteredSnippets.length - 1)];
      if (active) onPick(active.command);
      return;
    }
    handleModalKeyboardNavigation(event, event.currentTarget, onCancel);
  };

  return createPortal(
    <div className="notepad-modal-overlay" role="presentation" onClick={onCancel}>
      <section
        className="notepad-modal terminal-snippet-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-snippet-picker-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="terminal-snippet-picker-header">
          <span id="terminal-snippet-picker-title" className="terminal-snippet-picker-title">
            {t('terminal.snippets.dialogTitle', language)}
          </span>
          <span className="terminal-snippet-picker-count">
            {t('terminal.snippets.count', language, { count: String(totalCount) })}
          </span>
          <button
            type="button"
            className="terminal-snippet-picker-close"
            aria-label={t('common.close', language)}
            onClick={onCancel}
          >
            ×
          </button>
        </header>

        <label className="terminal-snippet-picker-search">
          <svg className="terminal-snippet-picker-search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M7 2a5 5 0 1 0 3.1 8.94l3.03 3.03a.75.75 0 1 0 1.06-1.06l-3.03-3.03A5 5 0 0 0 7 2Zm-3.5 5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0Z"
              fill="currentColor"
            />
          </svg>
          <span className="sr-only">{t('terminal.snippets.listLabel', language)}</span>
          <input
            className="terminal-snippet-picker-search-input"
            type="search"
            autoFocus
            value={filter}
            placeholder={t('terminal.snippets.searchPlaceholder', language)}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>

        <div className="terminal-snippet-picker-list" role="list" aria-label={t('terminal.snippets.listLabel', language)}>
          {groupedItems.length ? (
            groupedItems.map((group) => (
              <div key={group.label} className="terminal-snippet-picker-group" role="presentation">
                <div className="terminal-snippet-picker-group-label">{group.label}</div>
                {group.items.map(({ snippet, index }) => (
                  <button
                    key={snippet.id}
                    type="button"
                    role="listitem"
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    className={`terminal-snippet-picker-item${index === activeIndex ? ' is-active' : ''}`}
                    title={snippet.command}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => onPick(snippet.command)}
                  >
                    <span className="terminal-snippet-picker-item-text">
                      <strong>{snippet.label}</strong>
                      <small>{getTerminalSnippetPreview(snippet)}</small>
                    </span>
                    {snippet.shortcut ? <kbd>{snippet.shortcut}</kbd> : null}
                  </button>
                ))}
              </div>
            ))
          ) : (
            <div className="terminal-snippet-picker-empty">
              {t('terminal.snippets.empty', language)}
            </div>
          )}
        </div>

        <footer className="terminal-snippet-picker-footer">
          <span className="terminal-snippet-picker-hint">
            <kbd>↑↓</kbd> {t('terminal.snippets.hintNavigate', language)}
          </span>
          <span className="terminal-snippet-picker-hint">
            <kbd>Enter</kbd> {t('terminal.snippets.insert', language)}
          </span>
          <span className="terminal-snippet-picker-hint">
            <kbd>Esc</kbd> {t('common.close', language)}
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
