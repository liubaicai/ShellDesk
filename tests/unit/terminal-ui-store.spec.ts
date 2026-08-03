import { expect, test } from '@playwright/test';

import { createTerminalUiStore } from '../../src/components/remote-desktop/terminalUiStore';

test('terminal completion store updates subscribers without React parent state', () => {
  const store = createTerminalUiStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const candidate = { value: 'git status', label: 'git status', detail: 'history', source: 'history' as const };
  store.setCompletion('git status', [candidate]);
  expect(store.getSnapshot()).toEqual({ commandSuggestion: 'git status', completionCandidates: [candidate] });
  store.clearCompletion();
  expect(store.getSnapshot().commandSuggestion).toBe('');
  expect(notifications).toBe(2);
  unsubscribe();
});
