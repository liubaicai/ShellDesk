import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  createDatabaseImportState,
  type DatabaseImportMode,
  type DatabaseImportState,
  getDatabaseImportModeForFileName,
  type ParsedDatabaseImport,
  updateDatabaseImportModeState,
  updateDatabaseImportPreviewState,
  updateDatabaseImportTextState,
} from './databaseImportUtils';
import {
  createLatestImportFileReader,
  type LatestImportFileReader,
} from './latestImportFileReader';

type DatabaseImportParser = (text: string) => ParsedDatabaseImport;

interface UseDatabaseImportDraftOptions {
  parseCsv: DatabaseImportParser;
  parseJson: DatabaseImportParser;
}

interface DatabaseImportDraftController {
  isReadingImportFile: boolean;
  importDataState: DatabaseImportState;
  setImportDataState: Dispatch<SetStateAction<DatabaseImportState>>;
  invalidateImportFileRead: () => void;
  resetImportDataState: () => void;
  updateImportText: (mode: DatabaseImportMode, text: string) => void;
  handleImportFileSelected: (event: ChangeEvent<HTMLInputElement>) => void;
  updateImportMode: (mode: DatabaseImportMode) => void;
}

export function useDatabaseImportDraft({
  parseCsv,
  parseJson,
}: UseDatabaseImportDraftOptions): DatabaseImportDraftController {
  const [importDataState, setImportDataState] = useState<DatabaseImportState>(createDatabaseImportState);
  const [isReadingImportFile, setIsReadingImportFile] = useState(false);
  const importFileReadRequestRef = useRef(0);
  const importFileReaderRef = useRef<LatestImportFileReader | null>(null);
  if (!importFileReaderRef.current) {
    importFileReaderRef.current = createLatestImportFileReader();
  }
  const importFileReader = importFileReaderRef.current;

  useEffect(() => () => {
    importFileReader.invalidate();
  }, [importFileReader]);

  const refreshImportPreview = useCallback((mode: DatabaseImportMode, text: string) => {
    if (!text.trim()) {
      setImportDataState((current) => (
        current.executing ? current : updateDatabaseImportPreviewState(current, null)
      ));
      return;
    }

    try {
      const parsed = mode === 'csv' ? parseCsv(text) : parseJson(text);
      setImportDataState((current) => (
        current.executing ? current : updateDatabaseImportPreviewState(current, parsed)
      ));
    } catch {
      setImportDataState((current) => (
        current.executing ? current : updateDatabaseImportPreviewState(current, null)
      ));
    }
  }, [parseCsv, parseJson]);

  const invalidateImportFileRead = useCallback(() => {
    importFileReadRequestRef.current += 1;
    importFileReader.invalidate();
    setIsReadingImportFile(false);
  }, [importFileReader]);

  const resetImportDataState = useCallback(() => {
    invalidateImportFileRead();
    setImportDataState(createDatabaseImportState());
  }, [invalidateImportFileRead]);

  const updateImportText = useCallback((mode: DatabaseImportMode, text: string) => {
    invalidateImportFileRead();
    setImportDataState((current) => updateDatabaseImportTextState(current, mode, text));
    refreshImportPreview(mode, text);
  }, [invalidateImportFileRead, refreshImportPreview]);

  const handleImportFileSelected = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const request = ++importFileReadRequestRef.current;
    setIsReadingImportFile(true);
    void importFileReader.read(file, ({ fileName, text }) => {
      const mode = getDatabaseImportModeForFileName(fileName);
      setImportDataState((current) => (
        current.executing ? current : updateDatabaseImportTextState(current, mode, text)
      ));
      refreshImportPreview(mode, text);
    }).catch(() => false).finally(() => {
      if (request === importFileReadRequestRef.current) {
        setIsReadingImportFile(false);
      }
    });

    event.target.value = '';
  }, [importFileReader, refreshImportPreview]);

  const updateImportMode = useCallback((mode: DatabaseImportMode) => {
    invalidateImportFileRead();
    setImportDataState((current) => updateDatabaseImportModeState(current, mode));
    refreshImportPreview(mode, mode === 'csv' ? importDataState.csvText : importDataState.jsonText);
  }, [
    importDataState.csvText,
    importDataState.jsonText,
    invalidateImportFileRead,
    refreshImportPreview,
  ]);

  return {
    isReadingImportFile,
    importDataState,
    setImportDataState,
    invalidateImportFileRead,
    resetImportDataState,
    updateImportText,
    handleImportFileSelected,
    updateImportMode,
  };
}
