import type { IDecoration, IDisposable, IMarker, Terminal as XTerminal } from '@xterm/xterm';
import type { MutableRefObject } from 'react';

interface TerminalLineEntry {
  marker: IMarker;
  timestamp: string;
  decorations: IDecoration[];
  markerDisposeListener?: IDisposable;
  cachedLine: string;
  cachedKeywordSignature: string;
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
  let keywordSignature = '';
  let compiledKeywords: string[] = [];
  let visualFrame: number | null = null;
  let decorationFrame: number | null = null;
  let decorationQueue: TerminalLineEntry[] = [];
  let activeDecorationCount = 0;
  let disposed = false;
  const maximumTrackedLines = 5000;
  const viewportOverscanLines = 12;
  const decorationFrameBudgetMs = 4;
  const maximumActiveDecorations = 1200;

  const disposeEntryDecorations = (entry: TerminalLineEntry, invalidate = true) => {
    activeDecorationCount = Math.max(0, activeDecorationCount - entry.decorations.length);
    entry.decorations.forEach((decoration) => decoration.dispose());
    entry.decorations = [];
    if (invalidate) {
      entry.cachedLine = '';
      entry.cachedKeywordSignature = '';
    }
  };

  const removeEntry = (entry: TerminalLineEntry, disposeMarker: boolean) => {
    entry.markerDisposeListener?.dispose();
    entry.markerDisposeListener = undefined;
    disposeEntryDecorations(entry);
    if (disposeMarker && !entry.marker.isDisposed) {
      entry.marker.dispose();
    }
  };

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

  const findCompiledKeywordRanges = (line: string) => {
    const normalizedLine = line.toLocaleLowerCase();
    const candidates: Array<{ start: number; length: number }> = [];
    for (const keyword of compiledKeywords) {
      let start = 0;
      while (candidates.length < 200) {
        const index = normalizedLine.indexOf(keyword, start);
        if (index < 0) break;
        candidates.push({ start: index, length: keyword.length });
        start = index + keyword.length;
      }
      if (candidates.length >= 200) break;
    }
    return candidates
      .sort((left, right) => left.start - right.start || right.length - left.length)
      .reduce<Array<{ start: number; length: number }>>((ranges, range) => {
        const previous = ranges.at(-1);
        if (!previous || range.start >= previous.start + previous.length) ranges.push(range);
        return ranges;
      }, []);
  };

  const decorateEntry = (entry: TerminalLineEntry) => {
    const line = terminal.buffer.active.getLine(entry.marker.line)?.translateToString(true) ?? '';
    if (
      entry.cachedLine === line
      && entry.cachedKeywordSignature === keywordSignature
    ) {
      return;
    }
    disposeEntryDecorations(entry, false);
    entry.cachedLine = line;
    entry.cachedKeywordSignature = keywordSignature;
    findCompiledKeywordRanges(line).forEach(({ start, length }) => {
      if (activeDecorationCount >= maximumActiveDecorations) {
        return;
      }
      const decoration = terminal.registerDecoration({
        marker: entry.marker,
        x: start,
        width: length,
        backgroundColor: '#6a4f12',
        foregroundColor: '#fff2a8',
        layer: 'bottom',
      });
      if (decoration) {
        entry.decorations.push(decoration);
        activeDecorationCount += 1;
      }
    });
  };

  const drainDecorationQueue = () => {
    decorationFrame = null;
    if (disposed) {
      return;
    }
    const startedAt = performance.now();
    while (decorationQueue.length) {
      const entry = decorationQueue.shift();
      if (entry && !entry.marker.isDisposed) {
        decorateEntry(entry);
      }
      if (performance.now() - startedAt >= decorationFrameBudgetMs) {
        decorationFrame = window.requestAnimationFrame(drainDecorationQueue);
        return;
      }
    }
  };

  const refreshVisibleDecorations = () => {
    const settings = settingsRef.current;
    if (
      terminal.buffer.active.type !== 'normal'
      || !settings.terminalKeywordHighlightEnabled
      || !compiledKeywords.length
    ) {
      entries.forEach((entry) => disposeEntryDecorations(entry));
      decorationQueue = [];
      return;
    }

    const viewportStart = Math.max(0, terminal.buffer.active.viewportY - viewportOverscanLines);
    const viewportEnd = terminal.buffer.active.viewportY + terminal.rows + viewportOverscanLines;
    const visibleEntries = entries.filter(({ marker }) => (
      !marker.isDisposed
      && marker.line >= viewportStart
      && marker.line <= viewportEnd
    ));
    const visibleSet = new Set(visibleEntries);
    entries.forEach((entry) => {
      if (!visibleSet.has(entry) && entry.decorations.length) {
        disposeEntryDecorations(entry);
      }
    });
    decorationQueue = visibleEntries;
    if (decorationFrame === null) {
      decorationFrame = window.requestAnimationFrame(drainDecorationQueue);
    }
  };

  const scheduleVisualRefresh = () => {
    if (disposed || visualFrame !== null) {
      return;
    }
    visualFrame = window.requestAnimationFrame(() => {
      visualFrame = null;
      renderTimestamps();
      refreshVisibleDecorations();
    });
  };

  const refresh = () => {
    const settings = settingsRef.current;
    const nextKeywordSignature = settings.terminalKeywordHighlightEnabled
      ? settings.terminalHighlightKeywords
      : '';
    if (nextKeywordSignature !== keywordSignature) {
      keywordSignature = nextKeywordSignature;
      compiledKeywords = parseTerminalHighlightKeywords(nextKeywordSignature);
      entries.forEach((entry) => disposeEntryDecorations(entry));
    }
    scheduleVisualRefresh();
  };

  const disposables: IDisposable[] = [
    terminal.onLineFeed(() => {
      const settings = settingsRef.current;
      if (
        terminal.buffer.active.type !== 'normal'
        || (!settings.terminalLineTimestamps && !compiledKeywords.length)
      ) return;
      const marker = terminal.registerMarker(-1);
      if (!marker) return;
      const entry: TerminalLineEntry = {
        marker,
        timestamp: formatTerminalLineTimestamp(new Date()),
        decorations: [],
        cachedLine: '',
        cachedKeywordSignature: '',
      };
      entry.markerDisposeListener = marker.onDispose(() => {
        removeEntry(entry, false);
      });
      entries.push(entry);
      if (entries.length > maximumTrackedLines + 250) {
        entries = entries.filter(({ marker: candidate }) => !candidate.isDisposed);
        const staleEntries = entries.splice(0, Math.max(0, entries.length - maximumTrackedLines));
        staleEntries.forEach((staleEntry) => removeEntry(staleEntry, true));
      }
      scheduleVisualRefresh();
    }),
    terminal.onRender(scheduleVisualRefresh),
    terminal.onScroll(scheduleVisualRefresh),
    terminal.onResize(scheduleVisualRefresh),
  ];

  refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      if (visualFrame !== null) {
        window.cancelAnimationFrame(visualFrame);
      }
      if (decorationFrame !== null) {
        window.cancelAnimationFrame(decorationFrame);
      }
      disposables.forEach((disposable) => disposable.dispose());
      entries.forEach(({ decorations, marker, markerDisposeListener }) => {
        markerDisposeListener?.dispose();
        decorations.forEach((decoration) => decoration.dispose());
        marker.dispose();
      });
      entries = [];
      decorationQueue = [];
      gutter.replaceChildren();
    },
  };
}
