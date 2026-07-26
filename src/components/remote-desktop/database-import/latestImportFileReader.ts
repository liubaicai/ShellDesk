export type DatabaseImportFile = Pick<File, 'name' | 'text'>;

export interface DatabaseImportFileContent {
  fileName: string;
  text: string;
}

export interface LatestImportFileReader {
  invalidate: () => void;
  read: (
    file: DatabaseImportFile,
    apply: (content: DatabaseImportFileContent) => void,
  ) => Promise<boolean>;
}

export function createLatestImportFileReader(): LatestImportFileReader {
  let latestRequest = 0;

  return {
    invalidate() {
      latestRequest += 1;
    },
    async read(file, apply) {
      const request = ++latestRequest;
      const text = await file.text();

      if (request !== latestRequest) {
        return false;
      }

      apply({ fileName: file.name, text });
      return true;
    },
  };
}
