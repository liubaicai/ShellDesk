import type { Terminal as XTerminal } from '@xterm/xterm';

export function getTerminalSelectionForClipboard(terminal: XTerminal, normalize: boolean) {
  if (!normalize) return terminal.getSelection();
  const selectionMode = (terminal as unknown as { _core?: { _selectionService?: { _activeSelectionMode?: number } } })
    ._core?._selectionService?._activeSelectionMode;
  if (selectionMode === 3) return terminal.getSelection().replaceAll('\u00a0', ' ');
  const range = terminal.getSelectionPosition();
  if (!range) return terminal.getSelection().replaceAll('\u00a0', ' ');
  const rows: Array<{ text: string; wrapped: boolean }> = [];
  for (let y = range.start.y; y <= range.end.y; y += 1) {
    const line = terminal.buffer.active.getLine(y);
    if (!line) continue;
    const start = y === range.start.y ? range.start.x : 0;
    const end = y === range.end.y ? range.end.x : undefined;
    rows.push({
      text: line.translateToString(true, start, end).replaceAll('\u00a0', ' '),
      wrapped: Boolean(line.isWrapped),
    });
  }
  let result = rows[0]?.text ?? '';
  rows.slice(1).forEach((row) => {
    if (!row.wrapped) result = `${result.replace(/[ \t]+$/u, '')}\n`;
    else if (/[ \t]+$/u.test(result)) result = `${result.replace(/[ \t]+$/u, '')} `;
    result += row.text;
  });
  if (range.end.x >= (terminal.buffer.active.getLine(range.end.y)?.length ?? 0)) {
    result = result.replace(/[ \t]+$/u, '');
  }
  return result;
}
