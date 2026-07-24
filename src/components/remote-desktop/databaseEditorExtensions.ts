import { indentWithTab } from '@codemirror/commands';
import type { Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

interface DatabaseEditorTheme {
  background: string;
  text: string;
  fontSize: string;
  fontFamily: string;
  linePadding: string;
  gutterBorder: string;
  gutterBackground: string;
  gutterText: string;
  accent: string;
  activeLine: string;
  selection: string;
}

interface CreateDatabaseEditorExtensionsOptions {
  language: Extension;
  dark: boolean;
  onExecute: () => void;
  theme?: Partial<DatabaseEditorTheme>;
}

const defaultTheme: DatabaseEditorTheme = {
  background: 'var(--surface-elevated)',
  text: 'var(--text)',
  fontSize: '13px',
  fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
  linePadding: '0 12px',
  gutterBorder: '1px solid var(--border)',
  gutterBackground: 'var(--surface)',
  gutterText: 'var(--text-muted)',
  accent: 'var(--accent)',
  activeLine: 'color-mix(in srgb, var(--accent) 8%, transparent)',
  selection: 'rgba(67, 199, 255, 0.25)',
};

export function createDatabaseEditorExtensions({
  language,
  dark,
  onExecute,
  theme: themeOverrides,
}: CreateDatabaseEditorExtensionsOptions): Extension[] {
  const theme = { ...defaultTheme, ...themeOverrides };
  return [
    keymap.of([
      indentWithTab,
      {
        key: 'Mod-Enter',
        run: () => {
          onExecute();
          return true;
        },
      },
    ]),
    language,
    EditorView.theme({
      '&': {
        height: '100%',
        minHeight: '0',
        backgroundColor: theme.background,
        color: theme.text,
        fontSize: theme.fontSize,
      },
      '.cm-scroller': {
        backgroundColor: theme.background,
        fontFamily: theme.fontFamily,
        lineHeight: '20px',
      },
      '.cm-content': {
        padding: '10px 0',
        caretColor: theme.text,
      },
      '.cm-line': {
        padding: theme.linePadding,
      },
      '.cm-gutters': {
        borderRight: theme.gutterBorder,
        backgroundColor: theme.gutterBackground,
        color: theme.gutterText,
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: theme.accent,
      },
      '.cm-activeLine': {
        backgroundColor: theme.activeLine,
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: theme.selection,
      },
      '&.cm-focused': {
        outline: 'none',
      },
    }, { dark }),
  ];
}
