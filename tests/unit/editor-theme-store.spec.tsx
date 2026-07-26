import { expect, test } from '@playwright/test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import { useShellDeskEditorTheme } from '../../src/components/remote-desktop/useShellDeskEditorTheme';

function ServerThemeProbe() {
  const editorTheme = useShellDeskEditorTheme();
  return createElement('span', { 'data-editor-theme': editorTheme }, 'editor');
}

test('editor theme store uses a deterministic dark server snapshot', () => {
  expect(renderToString(createElement(ServerThemeProbe))).toContain('data-editor-theme="dark"');
});
