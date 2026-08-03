import type { TerminalCompletionCandidate } from './terminalCompletionEngine';

export interface TerminalUiSnapshot {
  commandSuggestion: string;
  completionCandidates: readonly TerminalCompletionCandidate[];
}

export interface TerminalUiStore {
  getSnapshot: () => TerminalUiSnapshot;
  subscribe: (listener: () => void) => () => void;
  setCompletion: (commandSuggestion: string, completionCandidates: readonly TerminalCompletionCandidate[]) => void;
  clearCompletion: () => void;
}

const emptySnapshot: TerminalUiSnapshot = {
  commandSuggestion: '',
  completionCandidates: [],
};

export function createTerminalUiStore(): TerminalUiStore {
  let snapshot = emptySnapshot;
  const listeners = new Set<() => void>();
  const publish = (nextSnapshot: TerminalUiSnapshot) => {
    if (
      snapshot.commandSuggestion === nextSnapshot.commandSuggestion
      && snapshot.completionCandidates.length === nextSnapshot.completionCandidates.length
      && snapshot.completionCandidates.every((candidate, index) => candidate === nextSnapshot.completionCandidates[index])
    ) return;
    snapshot = nextSnapshot;
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setCompletion: (commandSuggestion, completionCandidates) => publish({
      commandSuggestion,
      completionCandidates: [...completionCandidates],
    }),
    clearCompletion: () => publish(emptySnapshot),
  };
}
