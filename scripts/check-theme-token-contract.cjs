const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const preloadTokenNames = [
  '--bg',
  '--chrome',
  '--surface',
  '--surface-elevated',
  '--text',
];
const requiredLightTokenNames = [
  '--surface-success-soft',
  '--surface-success-border',
  '--text-success',
  '--toast-bg',
  '--toast-text',
  '--danger-soft',
  '--danger-border',
  '--danger-text-soft',
  '--danger',
  '--chrome-hover',
  '--danger-hover-bg',
  '--danger-hover-text',
  '--toggle-off',
  '--shadow',
];

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function listFiles(relativeDirectory, extension) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile() && relativePath.endsWith(extension)) {
        files.push(relativePath);
      }
    }
  };
  visit(relativeDirectory);
  return files;
}

function parseTypeScript(source, fileName) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function importSpecifiers(sourceFile) {
  return sourceFile.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => statement.moduleSpecifier)
    .filter(ts.isStringLiteral)
    .map((moduleSpecifier) => moduleSpecifier.text);
}

function callExpressions(sourceFile) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function identifierCallPositions(sourceFile, identifier) {
  return callExpressions(sourceFile)
    .filter((call) => ts.isIdentifier(call.expression) && call.expression.text === identifier)
    .map((call) => call.getStart(sourceFile));
}

function nearestFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
      || ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function functionIdentifier(node) {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (
    (ts.isFunctionExpression(node) || ts.isArrowFunction(node))
    && ts.isVariableDeclaration(node.parent)
    && ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text;
  }
  return null;
}

function extractCssBlock(source, selector) {
  const selectorIndex = source.indexOf(selector);
  assert.notEqual(selectorIndex, -1, `${selector} must exist`);

  const openingBraceIndex = source.indexOf('{', selectorIndex + selector.length);
  assert.notEqual(openingBraceIndex, -1, `${selector} must open a block`);

  let depth = 0;

  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;

      if (depth === 0) {
        return source.slice(openingBraceIndex + 1, index);
      }
    }
  }

  assert.fail(`${selector} must close its block`);
}

function parseCustomProperties(block) {
  const properties = new Map();

  for (const match of block.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)) {
    properties.set(match[1], match[2].trim());
  }

  return properties;
}

const preloadSource = readText('public/theme-preload.js');
const tokenSource = readText('src/styles/_tokens.scss');
const indexSource = readText('index.html');
const appSource = readText('src/App.tsx');
const mainSource = readText('src/main.tsx');
const appearanceSource = readText('src/theme/appearance.ts');
const appTypeScript = parseTypeScript(appSource, 'src/App.tsx');
const mainTypeScript = parseTypeScript(mainSource, 'src/main.tsx');

const darkTokens = parseCustomProperties(extractCssBlock(tokenSource, ':root'));
const lightTokens = parseCustomProperties(extractCssBlock(tokenSource, '[data-theme="light"]'));

for (const tokenName of requiredLightTokenNames) {
  assert.ok(
    lightTokens.has(tokenName),
    `${tokenName} must be declared explicitly in the light-theme token block`,
  );
}

function expectedPreloadTokens(theme) {
  const source = theme === 'light' ? lightTokens : darkTokens;

  return Object.fromEntries(
    preloadTokenNames.map((tokenName) => {
      assert.ok(source.has(tokenName), `${tokenName} must exist for ${theme}`);
      return [tokenName, source.get(tokenName)];
    }),
  );
}

function runPreload({
  query = '',
  storedTheme = null,
  systemDark = false,
  matchMediaThrows = false,
}) {
  const styleProperties = new Map();
  const rootAttributes = new Map();
  const metaAttributes = new Map([['content', 'dark']]);
  const domReadyListeners = [];
  const style = {
    backgroundColor: '',
    colorScheme: '',
    setProperty(name, value) {
      styleProperties.set(name, value);
    },
  };
  const documentElement = {
    style,
    setAttribute(name, value) {
      rootAttributes.set(name, value);
    },
  };
  const colorSchemeMeta = {
    setAttribute(name, value) {
      metaAttributes.set(name, value);
    },
  };
  const document = {
    body: null,
    documentElement,
    querySelector(selector) {
      return selector === 'meta[name="color-scheme"]' ? colorSchemeMeta : null;
    },
    addEventListener(eventName, listener, options) {
      assert.equal(eventName, 'DOMContentLoaded');
      assert.equal(options?.once, true);
      domReadyListeners.push(listener);
    },
  };
  const window = {
    location: { search: query },
    localStorage: {
      getItem(key) {
        assert.equal(key, 'shelldesk:theme-preload');
        return storedTheme;
      },
    },
    matchMedia(queryText) {
      if (matchMediaThrows) {
        throw new Error('matchMedia unavailable');
      }

      if (queryText === '(prefers-color-scheme: dark)') {
        return { matches: systemDark };
      }

      if (queryText === '(prefers-color-scheme: light)') {
        return { matches: !systemDark };
      }

      assert.fail(`unexpected color-scheme media query: ${queryText}`);
    },
  };

  vm.runInNewContext(
    preloadSource,
    {
      document,
      URLSearchParams,
      window,
    },
    { filename: 'public/theme-preload.js' },
  );
  document.body = {};

  for (const listener of domReadyListeners) {
    listener();
  }

  return {
    backgroundColor: style.backgroundColor,
    colorScheme: style.colorScheme,
    metaColorScheme: metaAttributes.get('content'),
    theme: rootAttributes.get('data-theme'),
    tokens: Object.fromEntries(styleProperties),
  };
}

function assertPreloadCase(name, options, expectedTheme) {
  const result = runPreload(options);

  assert.equal(result.theme, expectedTheme, `${name}: data-theme`);
  assert.equal(result.colorScheme, expectedTheme, `${name}: style.colorScheme`);
  assert.equal(result.metaColorScheme, expectedTheme, `${name}: color-scheme meta`);
  assert.equal(
    result.backgroundColor,
    '',
    `${name}: preload must own startup colors only through the five temporary tokens`,
  );
  assert.deepEqual(
    result.tokens,
    expectedPreloadTokens(expectedTheme),
    `${name}: preload tokens must exactly match the effective SCSS tokens`,
  );
}

assertPreloadCase('explicit light query', { query: '?shelldeskTheme=light' }, 'light');
assertPreloadCase(
  'explicit dark query',
  { query: '?shelldeskTheme=dark', storedTheme: 'light', systemDark: false },
  'dark',
);
assertPreloadCase(
  'system light',
  { query: '?shelldeskTheme=system', systemDark: false },
  'light',
);
assertPreloadCase(
  'system dark',
  { query: '?shelldeskTheme=system', systemDark: true },
  'dark',
);
assertPreloadCase(
  'legacy JSON storage',
  { storedTheme: JSON.stringify({ theme: 'light' }), systemDark: true },
  'light',
);
assertPreloadCase(
  'legacy JSON storage with surrounding whitespace',
  { storedTheme: ' \r\n {"theme":"light"} \t', systemDark: true },
  'light',
);
assertPreloadCase(
  'plain storage with surrounding whitespace',
  { storedTheme: ' \t light \r\n', systemDark: true },
  'light',
);
assertPreloadCase(
  'invalid query falls through to storage',
  { query: '?shelldeskTheme=sepia', storedTheme: 'light', systemDark: true },
  'light',
);
assertPreloadCase(
  'matchMedia exception falls back to dark',
  { query: '?shelldeskTheme=system', matchMediaThrows: true },
  'dark',
);

const inlineStyleBlocks = [...indexSource.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)];
assert.equal(inlineStyleBlocks.length, 1, 'index.html must keep a single startup style block');
const startupStyle = inlineStyleBlocks[0][1];
const startupVariableNames = new Set(
  [...startupStyle.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]),
);

assert.deepEqual(
  [...startupVariableNames].sort(),
  ['--bg', '--text'],
  'index startup style may only reference --bg and --text',
);
assert.match(startupStyle, /^\s*background\s*:\s*var\(--bg\)\s*;/m);
assert.match(startupStyle, /^\s*color\s*:\s*var\(--text\)\s*;/m);
assert.doesNotMatch(
  startupStyle,
  /#(?:[\da-f]{3,8})\b|\brgba?\s*\(|\bhsla?\s*\(|\bokl(?:ab|ch)\s*\(|\bcolor\s*\(/i,
  'index startup style must not introduce a fourth literal color palette',
);
assert.doesNotMatch(
  startupStyle,
  /\[data-theme\s*=/,
  'index startup style must not duplicate theme-specific token ownership',
);
assert.match(indexSource, /<script\s+src\s*=\s*["']\/theme-preload\.js["']\s*><\/script>/);

assert.ok(
  identifierCallPositions(appTypeScript, 'useRuntimeAppearance').length > 0,
  'App.tsx must delegate runtime theme updates to useRuntimeAppearance',
);

const runtimeDynamicTokenNames = new Set([
  '--accent',
  '--accent-strong',
  '--accent-contrast',
  '--focus-border',
  '--focus-ring',
  '--accent-soft',
  '--accent-border',
  '--accent-strong-border',
  '--interface-font-family',
]);
const staticThemeTokenNames = new Set(
  [...darkTokens.keys()].filter((tokenName) => !runtimeDynamicTokenNames.has(tokenName)),
);
const appStaticThemeWrites = callExpressions(appTypeScript)
  .filter(
    (call) => ts.isPropertyAccessExpression(call.expression)
      && call.expression.name.text === 'setProperty'
      && call.arguments.length > 0
      && ts.isStringLiteral(call.arguments[0])
      && staticThemeTokenNames.has(call.arguments[0].text),
  )
  .map((call) => call.arguments[0].text);
assert.deepEqual(
  appStaticThemeWrites,
  [],
  'App.tsx must not reintroduce static theme token ownership',
);

const createRootPositions = identifierCallPositions(mainTypeScript, 'createRoot');
assert.ok(createRootPositions.length > 0, 'main.tsx must create the React root');
assert.ok(
  importSpecifiers(mainTypeScript).includes('./styles/critical.scss'),
  'main.tsx must load critical SCSS',
);
const topLevelClearPreloadCalls = mainTypeScript.statements
  .filter(ts.isExpressionStatement)
  .map((statement) => statement.expression)
  .filter(
    (expression) => ts.isCallExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.expression.text === 'clearThemePreloadTokens',
  );
const preloadTokenDeclaration = appearanceSource.match(
  /THEME_PRELOAD_TOKENS\s*=\s*\[([\s\S]*?)\]\s*as const/,
);
assert.ok(preloadTokenDeclaration, 'theme appearance module must declare preload token ownership');
const declaredPreloadTokens = [
  ...preloadTokenDeclaration[1].matchAll(/['"](--[\w-]+)['"]/g),
].map((match) => match[1]);
assert.deepEqual(
  declaredPreloadTokens,
  preloadTokenNames,
  'runtime cleanup must own exactly the five preload tokens',
);
assert.match(
  appearanceSource,
  /function clearThemePreloadTokens[\s\S]*?removeProperty\(token\)/,
  'clearThemePreloadTokens must remove every owned preload token',
);
assert.ok(
  topLevelClearPreloadCalls.length === 1,
  'main.tsx must have exactly one top-level preload-token cleanup call',
);
assert.ok(
  topLevelClearPreloadCalls[0].getStart(mainTypeScript) < Math.min(...createRootPositions),
  'main.tsx must clear preload tokens at module execution before createRoot',
);

for (const relativePath of listFiles('src', '.tsx')) {
  const source = readText(relativePath);
  assert.doesNotMatch(
    source,
    /document\.documentElement|documentElement\.dataset\.theme|prefers-color-scheme:\s*light/,
    `${relativePath} must consume runtime appearance through the shared theme store`,
  );
  if (
    path.basename(relativePath) !== 'NotepadEditor.tsx'
    && source.includes('<NotepadEditor')
  ) {
    assert.match(
      source,
      /useShellDeskEditorTheme\(\)/,
      `${relativePath} must use the shared editor theme store`,
    );
  }
}
const mainCalls = callExpressions(mainTypeScript);
const awaitedDeferredImports = mainCalls.filter(
  (call) => call.expression.kind === ts.SyntaxKind.ImportKeyword
    && call.arguments.length === 1
    && ts.isStringLiteral(call.arguments[0])
    && call.arguments[0].text === './styles/deferred.scss'
    && ts.isAwaitExpression(call.parent),
);
const awaitedWindowShows = mainCalls.filter(
  (call) => ts.isAwaitExpression(call.parent)
    && /\bwindow\s*\.\s*guiSSH[\s\S]*?\.show\b/.test(call.getText(mainTypeScript)),
);
const deferredRevealPair = awaitedDeferredImports
  .flatMap((deferredImport) => awaitedWindowShows.map((showCall) => ({
    deferredImport,
    functionNode: nearestFunction(deferredImport),
    showCall,
  })))
  .find(({ deferredImport, functionNode, showCall }) => (
    functionNode !== null
    && functionNode === nearestFunction(showCall)
    && deferredImport.getStart(mainTypeScript) < showCall.getStart(mainTypeScript)
  ));
assert.ok(
  deferredRevealPair,
  'main.tsx must await deferred styles before revealing the Tauri window in one function',
);
const deferredRevealFunctionName = functionIdentifier(deferredRevealPair.functionNode);
assert.ok(
  deferredRevealFunctionName
    && identifierCallPositions(mainTypeScript, deferredRevealFunctionName).length > 0,
  'the deferred-style reveal function must be invoked',
);

console.log(
  'Theme token contract ok: preload/runtime palettes, light token ownership, startup CSS, and App/main boundaries stay aligned.',
);
