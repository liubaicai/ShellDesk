const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const defaultLimits = new Map([
  ['.ts', 2_000],
  ['.tsx', 2_000],
  ['.scss', 1_700],
  ['.rs', 1_500],
  ['.py', 800],
]);
const fileLimits = new Map([
  ['src/i18nCatalog.zh-CN.ts', 6_100],
  ['src/i18nCatalog.en-US.ts', 6_100],
  ['src/vite-env.d.ts', 1_800],
  ['src/App.tsx', 4_350],
  ['src/RemoteDesktopShell.tsx', 2_850],
  ['src/pages/SettingsPage.tsx', 2_550],
  ['src/components/remote-desktop/RemoteMySQL.tsx', 2_900],
  ['src/components/remote-desktop/RemoteClickHouse.tsx', 2_800],
  ['src/components/remote-desktop/RemotePostgres.tsx', 2_200],
]);

function collectFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(filePath) : [filePath];
  });
}

const sourceFiles = [
  ...collectFiles(path.join(root, 'src')),
  ...collectFiles(path.join(root, 'src-tauri', 'src')),
];
const checkedSourceFiles = sourceFiles.filter((filePath) => defaultLimits.has(path.extname(filePath)));
const checkedFilesByExtension = new Map(
  [...defaultLimits.keys()].map((extension) => [extension, 0]),
);
const violations = [];

for (const filePath of checkedSourceFiles) {
  const extension = path.extname(filePath);
  const defaultLimit = defaultLimits.get(extension);
  checkedFilesByExtension.set(extension, checkedFilesByExtension.get(extension) + 1);

  const relativePath = path.relative(root, filePath).replaceAll(path.sep, '/');
  const limit = fileLimits.get(relativePath) ?? defaultLimit;
  const contents = fs.readFileSync(filePath, 'utf8');
  const lineCount = contents.length === 0 ? 0 : contents.split(/\r?\n/).length;
  if (lineCount > limit) {
    violations.push(`${relativePath}: ${lineCount} lines (limit ${limit})`);
  }
}

if (violations.length > 0) {
  console.error('Source-size guard failed. Split the listed file or lower its existing size before adding more code:');
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exit(1);
}

const checkedFileSummary = [...checkedFilesByExtension]
  .filter(([, count]) => count > 0)
  .map(([extension, count]) => `${extension}=${count}`)
  .join(', ');
console.log(`Source-size guard ok: checked ${checkedSourceFiles.length} source files (${checkedFileSummary}).`);
