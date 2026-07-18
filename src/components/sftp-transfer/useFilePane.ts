import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';

import { getErrorMessage } from '../remote-desktop/desktopUtils';
import type { TransferFileEntry, TransferPaneKind, TransferPaneState } from './types';

interface UseFilePaneOptions {
  kind: TransferPaneKind;
  initialPath: string;
  loadDirectory: (path: string) => Promise<ShellDeskRemoteDirectoryResult>;
}

function compareEntries(a: TransferFileEntry, b: TransferFileEntry, field: TransferPaneState['sortField']) {
  if (a.type === 'directory' && b.type !== 'directory') return -1;
  if (a.type !== 'directory' && b.type === 'directory') return 1;
  if (field === 'size') return a.size - b.size;
  if (field === 'modifiedAt') return (a.modifiedAt || '').localeCompare(b.modifiedAt || '');
  if (field === 'type') return a.type.localeCompare(b.type);
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export function useFilePane({ kind, initialPath, loadDirectory }: UseFilePaneOptions) {
  const [state, setState] = useState<TransferPaneState>({
    path: initialPath,
    draftPath: initialPath,
    entries: [],
    selectedNames: new Set(),
    history: [initialPath],
    historyIndex: 0,
    search: '',
    sortField: 'name',
    sortDirection: 'asc',
    loading: true,
    error: '',
  });
  const deferredSearch = useDeferredValue(state.search.trim().toLocaleLowerCase());

  const listPath = useCallback(async (path: string) => {
    const requestedPath = path.trim() || initialPath;
    const result = await loadDirectory(requestedPath);
    return { ...result, entries: result.entries as TransferFileEntry[] };
  }, [initialPath, loadDirectory]);

  const loadPath = useCallback(async (path: string, historyMode: 'push' | 'replace' | 'none' = 'push') => {
    const requestedPath = path.trim() || initialPath;
    setState((current) => ({ ...current, loading: true, error: '', draftPath: requestedPath }));
    try {
      const result = await listPath(requestedPath);
      setState((current) => {
        let history = current.history;
        let historyIndex = current.historyIndex;
        if (historyMode === 'push' && result.path !== current.path) {
          history = [...current.history.slice(0, current.historyIndex + 1), result.path];
          historyIndex = history.length - 1;
        } else if (historyMode === 'replace') {
          history = [result.path];
          historyIndex = 0;
        }
        return {
          ...current,
          path: result.path,
          draftPath: result.path,
          entries: result.entries,
          selectedNames: new Set(),
          history,
          historyIndex,
          loading: false,
          error: '',
        };
      });
      return result;
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: getErrorMessage(error), draftPath: current.path }));
      throw error;
    }
  }, [initialPath, listPath]);

  useEffect(() => {
    void loadPath(initialPath, 'replace').catch(() => undefined);
  }, [initialPath, loadPath]);

  const refresh = useCallback(() => loadPath(state.path, 'none'), [loadPath, state.path]);
  const goBack = useCallback(async () => {
    if (state.historyIndex <= 0) return;
    const index = state.historyIndex - 1;
    const result = await loadPath(state.history[index], 'none');
    setState((current) => ({ ...current, historyIndex: index, path: result.path, draftPath: result.path }));
  }, [loadPath, state.history, state.historyIndex]);
  const goForward = useCallback(async () => {
    if (state.historyIndex >= state.history.length - 1) return;
    const index = state.historyIndex + 1;
    const result = await loadPath(state.history[index], 'none');
    setState((current) => ({ ...current, historyIndex: index, path: result.path, draftPath: result.path }));
  }, [loadPath, state.history, state.historyIndex]);

  const visibleEntries = useMemo(() => {
    const entries = deferredSearch
      ? state.entries.filter((entry) => entry.name.toLocaleLowerCase().includes(deferredSearch))
      : state.entries;
    return [...entries].sort((a, b) => {
      const result = compareEntries(a, b, state.sortField);
      return state.sortDirection === 'asc' ? result : -result;
    });
  }, [deferredSearch, state.entries, state.sortDirection, state.sortField]);

  const selectedEntries = useMemo(
    () => state.entries.filter((entry) => state.selectedNames.has(entry.name)),
    [state.entries, state.selectedNames],
  );

  const selectEntry = useCallback((entry: TransferFileEntry, additive: boolean, range: boolean) => {
    setState((current) => {
      if (range && current.selectedNames.size) {
        const anchorName = [...current.selectedNames].at(-1);
        const start = visibleEntries.findIndex((item) => item.name === anchorName);
        const end = visibleEntries.findIndex((item) => item.name === entry.name);
        if (start >= 0 && end >= 0) {
          const selected = new Set(additive ? current.selectedNames : []);
          visibleEntries.slice(Math.min(start, end), Math.max(start, end) + 1).forEach((item) => selected.add(item.name));
          return { ...current, selectedNames: selected };
        }
      }
      if (additive) {
        const selected = new Set(current.selectedNames);
        if (selected.has(entry.name)) selected.delete(entry.name); else selected.add(entry.name);
        return { ...current, selectedNames: selected };
      }
      return { ...current, selectedNames: new Set([entry.name]) };
    });
  }, [visibleEntries]);

  const setSearch = useCallback((search: string) => setState((current) => ({ ...current, search })), []);
  const setDraftPath = useCallback((draftPath: string) => setState((current) => ({ ...current, draftPath })), []);
  const setSort = useCallback((field: TransferPaneState['sortField']) => {
    setState((current) => ({
      ...current,
      sortField: field,
      sortDirection: current.sortField === field && current.sortDirection === 'asc' ? 'desc' : 'asc',
    }));
  }, []);
  const setError = useCallback((error: string) => setState((current) => ({ ...current, error })), []);

  return useMemo(() => ({
    kind,
    state,
    visibleEntries,
    selectedEntries,
    listPath,
    loadPath,
    refresh,
    goBack,
    goForward,
    selectEntry,
    setSearch,
    setDraftPath,
    setSort,
    setError,
  }), [
    goBack,
    goForward,
    kind,
    listPath,
    loadPath,
    refresh,
    selectEntry,
    selectedEntries,
    setDraftPath,
    setError,
    setSearch,
    setSort,
    state,
    visibleEntries,
  ]);
}

export type FilePaneController = ReturnType<typeof useFilePane>;
