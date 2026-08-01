import type { IDecoration, IDisposable, IMarker, Terminal as XTerminal } from '@xterm/xterm';

export class TerminalCursorLineHighlighter implements IDisposable {
  private enabled = false;
  private color = '#263449';
  private activeLine: number | null = null;
  private activeColumns = 0;
  private marker: IMarker | null = null;
  private decoration: IDecoration | null = null;
  private pendingRefresh = false;
  private disposed = false;
  private readonly disposables: IDisposable[];

  constructor(private readonly terminal: XTerminal) {
    this.disposables = [
      terminal.onCursorMove(() => { if (this.enabled) this.pendingRefresh = true; }),
      terminal.onWriteParsed(() => { if (this.enabled) this.pendingRefresh = true; }),
      terminal.onRender(() => {
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          this.refresh();
        }
      }),
      terminal.onSelectionChange(() => this.refresh(true)),
      terminal.onResize(() => this.refresh(true)),
      terminal.buffer.onBufferChange(() => this.refresh(true)),
    ];
  }

  update(enabled: boolean, color?: string) {
    this.enabled = enabled;
    if (color?.trim()) this.color = color.trim();
    if (enabled) this.refresh(true);
    else this.clear();
  }

  refresh(force = false) {
    if (this.disposed || !this.enabled || this.terminal.hasSelection() || this.terminal.buffer.active.type === 'alternate') {
      this.clear();
      return;
    }
    const buffer = this.terminal.buffer.active;
    const line = buffer.baseY + buffer.cursorY;
    const columns = Math.max(1, this.terminal.cols);
    if (!force && line === this.activeLine && columns === this.activeColumns && this.marker && !this.marker.isDisposed) return;
    this.clear();
    const marker = this.terminal.registerMarker(0);
    if (!marker) return;
    const decoration = this.terminal.registerDecoration({
      marker,
      x: 0,
      width: columns,
      backgroundColor: this.color,
      layer: 'bottom',
    });
    if (!decoration) {
      marker.dispose();
      return;
    }
    this.marker = marker;
    this.decoration = decoration;
    this.activeLine = line;
    this.activeColumns = columns;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private clear() {
    this.decoration?.dispose();
    this.marker?.dispose();
    this.decoration = null;
    this.marker = null;
    this.activeLine = null;
    this.activeColumns = 0;
  }
}
