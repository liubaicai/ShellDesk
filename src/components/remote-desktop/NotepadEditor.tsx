import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import { indentWithTab } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import type { Extension } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';

type CodeMirrorLanguageLoader = () => Promise<Extension>;

const emptyCodeMirrorExtensions: Extension[] = [];

const CODEMIRROR_LANGUAGE_LOADERS: Partial<Record<string, CodeMirrorLanguageLoader>> = {
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  typescript: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }),
  html: async () => (await import('@codemirror/lang-html')).html(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  apache: async () => (await import('@codemirror/lang-xml')).xml(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  bash: async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  },
  powershell: async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  },
  bat: async () => {
    const [{ StreamLanguage }, { shell }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/shell'),
    ]);
    return StreamLanguage.define(shell);
  },
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  python: async () => (await import('@codemirror/lang-python')).python(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  ruby: async () => {
    const [{ StreamLanguage }, { ruby }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/ruby'),
    ]);
    return StreamLanguage.define(ruby);
  },
  ini: async () => {
    const [{ StreamLanguage }, { properties }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/properties'),
    ]);
    return StreamLanguage.define(properties);
  },
  nginx: async () => {
    const [{ StreamLanguage }, { nginx }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/nginx'),
    ]);
    return StreamLanguage.define(nginx);
  },
  dockerfile: async () => {
    const [{ StreamLanguage }, { dockerFile }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/dockerfile'),
    ]);
    return StreamLanguage.define(dockerFile);
  },
  diff: async () => {
    const [{ StreamLanguage }, { diff }] = await Promise.all([
      import('@codemirror/language'),
      import('@codemirror/legacy-modes/mode/diff'),
    ]);
    return StreamLanguage.define(diff);
  },
};

export interface NotepadEditorSelection {
  start: number;
  end: number;
  text: string;
}

export interface NotepadEditorHandle {
  getSelection: () => NotepadEditorSelection;
  openSearch: () => void;
  selectRange: (start: number, end: number) => void;
}

interface NotepadEditorProps {
  ariaLabel: string;
  className?: string;
  content: string;
  extensions?: Extension[];
  language: string;
  readOnly: boolean;
  theme: 'light' | 'dark';
  wrapEnabled: boolean;
  onChange: (nextContent: string) => void;
  onCursorChange: (position: { line: number; col: number }) => void;
}

function getCursorPosition(view: EditorView) {
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  return {
    line: line.number,
    col: position - line.from + 1,
  };
}

const NotepadEditor = forwardRef<NotepadEditorHandle, NotepadEditorProps>(function NotepadEditor({
  ariaLabel,
  className,
  content,
  extensions: extraExtensions = emptyCodeMirrorExtensions,
  language,
  readOnly,
  theme,
  wrapEnabled,
  onChange,
  onCursorChange,
}, ref) {
  const codeMirrorRef = useRef<ReactCodeMirrorRef>(null);
  const [languageExtensions, setLanguageExtensions] = useState<Extension[]>([]);

  useEffect(() => {
    const languageLoader = CODEMIRROR_LANGUAGE_LOADERS[language];
    let cancelled = false;

    if (!languageLoader) {
      setLanguageExtensions([]);
      return undefined;
    }

    languageLoader()
      .then((extension) => {
        if (!cancelled) {
          setLanguageExtensions([extension]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLanguageExtensions([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [language]);

  const extensions = useMemo<Extension[]>(() => [
    keymap.of([indentWithTab]),
    ...languageExtensions,
    ...extraExtensions,
    ...(wrapEnabled ? [EditorView.lineWrapping] : []),
    EditorView.theme({
      '&': {
        height: '100%',
        minHeight: '0',
        backgroundColor: 'var(--surface)',
        color: 'var(--text)',
        fontSize: '13px',
      },
      '.cm-scroller': {
        backgroundColor: 'var(--surface)',
        fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
        lineHeight: '20px',
      },
      '.cm-content': {
        padding: '8px 0',
        caretColor: 'var(--text)',
      },
      '.cm-line': {
        padding: '0 12px',
      },
      '.cm-gutters': {
        borderRight: '1px solid var(--border)',
        backgroundColor: 'var(--surface-soft)',
        color: 'var(--muted)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--accent)',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(67, 199, 255, 0.25)',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-panels': {
        borderColor: 'var(--border)',
        backgroundColor: 'var(--surface-panel)',
        color: 'var(--text)',
      },
      '.cm-panel input': {
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '4px 7px',
        backgroundColor: 'var(--surface-input)',
        color: 'var(--text)',
      },
      '.cm-panel button': {
        border: '1px solid var(--border)',
        borderRadius: '6px',
        padding: '4px 8px',
        backgroundColor: 'var(--surface-control)',
        color: 'var(--muted-strong)',
      },
      '.cm-panel button:hover': {
        borderColor: 'var(--border-strong)',
        backgroundColor: 'var(--surface-hover)',
        color: 'var(--text)',
      },
    }, {
      dark: theme === 'dark',
    }),
  ], [extraExtensions, languageExtensions, theme, wrapEnabled]);

  useImperativeHandle(ref, () => ({
    getSelection: () => {
      const view = codeMirrorRef.current?.view;

      if (!view) {
        return { start: 0, end: 0, text: '' };
      }

      const selection = view.state.selection.main;
      const start = selection.from;
      const end = selection.to;
      return {
        start,
        end,
        text: view.state.doc.sliceString(start, end),
      };
    },
    openSearch: () => {
      const view = codeMirrorRef.current?.view;
      if (!view) return;

      view.focus();
      openSearchPanel(view);
    },
    selectRange: (start, end) => {
      const view = codeMirrorRef.current?.view;
      if (!view) return;

      const docLength = view.state.doc.length;
      const selectionStart = Math.max(0, Math.min(start, docLength));
      const selectionEnd = Math.max(0, Math.min(end, docLength));
      view.focus();
      view.dispatch({
        selection: EditorSelection.range(selectionStart, selectionEnd),
        scrollIntoView: true,
      });
      onCursorChange(getCursorPosition(view));
    },
  }), [onCursorChange]);

  return (
    <CodeMirror
      ref={codeMirrorRef}
      className={className ? `notepad-codemirror ${className}` : 'notepad-codemirror'}
      value={content}
      height="100%"
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        searchKeymap: true,
        defaultKeymap: true,
        history: true,
      }}
      theme={theme}
      extensions={extensions}
      editable={!readOnly}
      readOnly={readOnly}
      onChange={onChange}
      onUpdate={(viewUpdate) => {
        if (viewUpdate.docChanged || viewUpdate.selectionSet) {
          onCursorChange(getCursorPosition(viewUpdate.view));
        }
      }}
      aria-label={ariaLabel}
    />
  );
});

export default NotepadEditor;
