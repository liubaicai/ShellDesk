import type { IDecoration, IDisposable, IMarker, Terminal as XTerminal } from '@xterm/xterm';
import type { MutableRefObject } from 'react';

interface TerminalLineEntry {
  marker: IMarker;
  timestamp: string;
}

export interface TerminalOutputDecorationController {
  refresh: () => void;
  dispose: () => void;
}

export function parseTerminalHighlightKeywords(value: string) {
  const seen = new Set<string>();
  return value
    .split(',')
    .map((keyword) => keyword.trim().toLocaleLowerCase())
    .filter((keyword) => {
      if (!keyword || keyword.length > 64 || seen.has(keyword) || seen.size >= 24) return false;
      seen.add(keyword);
      return true;
    })
    .sort((left, right) => right.length - left.length);
}

export function findTerminalKeywordRanges(line: string, keywords: string) {
  const normalizedLine = line.toLocaleLowerCase();
  const candidates = parseTerminalHighlightKeywords(keywords).flatMap((keyword) => {
    const ranges: Array<{ start: number; length: number }> = [];
    let start = 0;
    while (ranges.length < 100) {
      const index = normalizedLine.indexOf(keyword, start);
      if (index < 0) break;
      ranges.push({ start: index, length: keyword.length });
      start = index + keyword.length;
    }
    return ranges;
  });

  return candidates
    .sort((left, right) => left.start - right.start || right.length - left.length)
    .reduce<Array<{ start: number; length: number }>>((ranges, range) => {
      const previous = ranges.at(-1);
      if (!previous || range.start >= previous.start + previous.length) ranges.push(range);
      return ranges;
    }, []);
}

export function formatTerminalLineTimestamp(date: Date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function createTerminalOutputDecorationController(
  terminal: XTerminal,
  gutter: HTMLElement,
  settingsRef: MutableRefObject<ShellDeskAppSettings>,
): TerminalOutputDecorationController {
  let entries: TerminalLineEntry[] = [];
  let keywordDecorations: IDecoration[] = [];
  let keywordSignature = '';

  const renderTimestamps = () => {
    gutter.replaceChildren();
    if (
      !settingsRef.current.terminalLineTimestamps
      || !terminal.rows
      || terminal.buffer.active.type !== 'normal'
    ) return;
    entries = entries.filter(({ marker }) => !marker.isDisposed && marker.line >= 0);
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    const rowHeight = (screen?.clientHeight ?? 0) / terminal.rows;
    if (!rowHeight) return;
    const viewportLine = terminal.buffer.active.viewportY;
    const fragment = document.createDocumentFragment();
    entries.forEach(({ marker, timestamp }) => {
      const row = marker.line - viewportLine;
      if (row < 0 || row >= terminal.rows) return;
      const label = document.createElement('span');
      label.textContent = timestamp;
      label.style.top = `${7 + row * rowHeight}px`;
      label.style.height = `${rowHeight}px`;
      fragment.append(label);
    });
    gutter.append(fragment);
  };

  const decorateEntry = (entry: TerminalLineEntry) => {
    const settings = settingsRef.current;
    if (!settings.terminalKeywordHighlightEnabled) return;
    const line = terminal.buffer.active.getLine(entry.marker.line)?.translateToString(true) ?? '';
    findTerminalKeywordRanges(line, settings.terminalHighlightKeywords).forEach(({ start, length }) => {
      const decoration = terminal.registerDecoration({
        marker: entry.marker,
        x: start,
        width: length,
        backgroundColor: '#6a4f12',
        foregroundColor: '#fff2a8',
        layer: 'bottom',
      });
      if (decoration) keywordDecorations.push(decoration);
    });
  };

  const refresh = () => {
    const settings = settingsRef.current;
    const nextKeywordSignature = settings.terminalKeywordHighlightEnabled
      ? settings.terminalHighlightKeywords
      : '';
    if (nextKeywordSignature !== keywordSignature) {
      keywordDecorations.forEach((decoration) => decoration.dispose());
      keywordDecorations = [];
      keywordSignature = nextKeywordSignature;
      if (keywordSignature) entries.forEach(decorateEntry);
    }
    renderTimestamps();
  };

  const disposables: IDisposable[] = [
    terminal.onLineFeed(() => {
      const settings = settingsRef.current;
      const keywords = settings.terminalKeywordHighlightEnabled
        ? parseTerminalHighlightKeywords(settings.terminalHighlightKeywords)
        : [];
      if (
        terminal.buffer.active.type !== 'normal'
        || (!settings.terminalLineTimestamps && !keywords.length)
      ) return;
      const marker = terminal.registerMarker(-1);
      if (!marker) return;
      const entry = { marker, timestamp: formatTerminalLineTimestamp(new Date()) };
      entries.push(entry);
      decorateEntry(entry);
      renderTimestamps();
    }),
    terminal.onRender(renderTimestamps),
    terminal.onScroll(renderTimestamps),
    terminal.onResize(renderTimestamps),
  ];

  refresh();
  return {
    refresh,
    dispose: () => {
      disposables.forEach((disposable) => disposable.dispose());
      keywordDecorations.forEach((decoration) => decoration.dispose());
      entries.forEach(({ marker }) => marker.dispose());
      entries = [];
      keywordDecorations = [];
      gutter.replaceChildren();
    },
  };
}
