const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sass = require('sass');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function unique(values) {
  return [...new Set(values)];
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function listSourceFiles(relativeDirectory) {
  const files = [];
  const pending = [relativeDirectory];

  while (pending.length > 0) {
    const currentDirectory = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, currentDirectory), { withFileTypes: true })) {
      const relativePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pending.push(relativePath);
      } else if (/\.(?:scss|ts|tsx)$/.test(entry.name)) {
        files.push(relativePath.replaceAll('\\', '/'));
      }
    }
  }

  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function importSpecifiers(source, fileName) {
  return parseTypeScript(source, fileName).statements
    .filter(ts.isImportDeclaration)
    .map((statement) => statement.moduleSpecifier)
    .filter(ts.isStringLiteral)
    .map((moduleSpecifier) => moduleSpecifier.text);
}

function hasLazyDynamicImport(source, fileName, componentName, modulePath) {
  const sourceFile = parseTypeScript(source, fileName);
  let found = false;

  function containsDynamicImport(node) {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === modulePath
    ) {
      return true;
    }

    return node.getChildren(sourceFile).some(containsDynamicImport);
  }

  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === componentName
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'lazy'
      && node.initializer.arguments.some(containsDynamicImport)
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function ruleBody(css, selector) {
  const match = css.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `compiled CSS must include ${selector}`);
  return match[1];
}

const deferredStyles = readText('src/styles/deferred.scss');
const remoteDesktopShell = readText('src/RemoteDesktopShell.tsx');
const desktopAppLoaders = readText('src/features/remote-desktop/desktopAppLoaders.tsx');
const sharedFrpStyles = readText('src/styles/remote-desktop/_frp-manager-shared.scss');
const productionSourceFiles = listSourceFiles('src');
const deferredRemoteDesktopUses = [
  ...deferredStyles.matchAll(/@use\s+["']\.\/remote-desktop\/([^"']+)["']/g),
].map((match) => match[1]);
const allowedSharedDeferredStyles = new Set([
  'shell',
  'dismissible-alert',
  'sudo-prompt',
  'context-menu',
  'dock-responsive',
  'database-tunnel',
  'modal',
  'file-picker',
]);
const unexpectedDeferredAppStyles = deferredRemoteDesktopUses
  .filter((styleName) => !allowedSharedDeferredStyles.has(styleName));
assert.deepEqual(
  unexpectedDeferredAppStyles,
  [],
  'application-specific remote desktop styles must load with their lazy application chunk',
);

const lazyStyleImports = unique(
  [...desktopAppLoaders.matchAll(/import\(['"]\.\.\/\.\.\/styles\/remote-desktop\/_([^"']+)\.scss["']\)/g)]
    .map((match) => match[1]),
);
assert.ok(
  lazyStyleImports.length >= 40,
  `expected at least 40 lazy remote desktop style chunks, found ${lazyStyleImports.length}`,
);

const deferredCss = sass.compile(path.join(root, 'src/styles/deferred.scss'), { style: 'expanded' }).css;
assert.ok(
  Buffer.byteLength(deferredCss) <= 260_000,
  `deferred.scss expanded CSS exceeds the 260 KB budget: ${Buffer.byteLength(deferredCss)} bytes`,
);

assert.doesNotMatch(
  deferredStyles,
  /remote-desktop\/_?frps?-manager/,
  'FRP manager styles must stay owned by their lazy component chunks, not deferred.scss',
);
assert.match(
  sharedFrpStyles,
  /@mixin\s+frp-manager\s*\(/,
);

const frpOwners = [
  {
    component: 'src/components/remote-desktop/RemoteFrpManager.tsx',
    componentName: 'RemoteFrpManager',
    stylesheet: 'src/styles/remote-desktop/_frp-manager.scss',
    importPath: '../../styles/remote-desktop/_frp-manager.scss',
    namespace: 'frp',
    configOverflow: 'hidden',
    configSelect: false,
    actionSelector: '.frp-proxies-table td:last-child',
  },
  {
    component: 'src/components/remote-desktop/RemoteFrpsManager.tsx',
    componentName: 'RemoteFrpsManager',
    stylesheet: 'src/styles/remote-desktop/_frps-manager.scss',
    importPath: '../../styles/remote-desktop/_frps-manager.scss',
    namespace: 'frps',
    configOverflow: 'auto',
    configSelect: true,
    actionSelector: '.frps-proxies-table td:last-child:has(button)',
  },
];

for (const owner of frpOwners) {
  const componentSource = readText(owner.component);
  const stylesheetSource = readText(owner.stylesheet);
  const stylesheetName = path.basename(owner.stylesheet, '.scss').replace(/^_/, '');
  const stylesheetReference = new RegExp(
    `(?:import\\s+|@(?:use|forward|import)\\s+)["'][^"']*(?:_|/)${escapeRegExp(stylesheetName)}(?:\\.scss)?["']`,
  );
  const productionOwners = productionSourceFiles.filter((relativePath) => (
    stylesheetReference.test(readText(relativePath))
  ));
  assert.deepEqual(
    productionOwners,
    [owner.component],
    `${owner.stylesheet} must have exactly one production import owner`,
  );
  assert.ok(
    importSpecifiers(componentSource, owner.component).includes(owner.importPath),
    `${owner.componentName} must import its lazy stylesheet`,
  );
  assert.ok(
    hasLazyDynamicImport(
      desktopAppLoaders,
      'src/features/remote-desktop/desktopAppLoaders.tsx',
      owner.componentName,
      `../../components/remote-desktop/${owner.componentName}`,
    ),
    `${owner.componentName} must remain lazy-loaded`,
  );
  const sharedUse = stylesheetSource.match(
    /@use\s+["']frp-manager-shared["']\s+as\s+([a-zA-Z_][\w-]*|\*)\s*;/,
  );
  assert.ok(sharedUse, `${owner.stylesheet} must import the shared FRP mixin`);
  const mixinReference = sharedUse[1] === '*'
    ? 'frp-manager'
    : `${sharedUse[1]}.frp-manager`;
  assert.match(
    stylesheetSource,
    new RegExp(`@include\\s+${escapeRegExp(mixinReference)}\\s*\\(`),
    `${owner.stylesheet} must include the imported shared FRP mixin`,
  );

  const compiledCss = sass.compile(path.join(root, owner.stylesheet), { style: 'expanded' }).css;
  const configBody = ruleBody(compiledCss, `.${owner.namespace}-config`);
  assert.match(configBody, new RegExp(`overflow:\\s*${owner.configOverflow};`));
  assert.match(compiledCss, /@media \(max-width: 860px\)/);
  assert.match(compiledCss, new RegExp(`\\[data-theme=light\\] \\.${owner.namespace}-manager`));
  ruleBody(compiledCss, owner.actionSelector);

  if (owner.configSelect) {
    assert.match(
      compiledCss,
      new RegExp(`\\.${owner.namespace}-config input,\\s*\\.${owner.namespace}-config select,`),
    );
  } else {
    assert.doesNotMatch(compiledCss, new RegExp(`\\.${owner.namespace}-config select`));
  }
}

const fileExplorerBase = readText('src/styles/remote-desktop/file-explorer/_base.scss');
const fileExplorerWindows = readText('src/styles/remote-desktop/file-explorer/_windows.scss');
const sharedContextMenuStyles = readText('src/styles/remote-desktop/_context-menu.scss');
const monitorStyles = readText('src/styles/remote-desktop/_monitor.scss');
const remoteDesktopShellBase = readText('src/styles/remote-desktop/shell/_base.scss');
assert.doesNotMatch(
  fileExplorerBase,
  /\.monitor-pane/,
  'file explorer styles must not own monitor layout declarations',
);
assert.doesNotMatch(
  `${fileExplorerBase}\n${fileExplorerWindows}`,
  /\.context-menu(?:-overlay|\s|\{)/,
  'file explorer styles must not own shared context menu declarations',
);
assert.match(sharedContextMenuStyles, /\.context-menu-overlay\s*\{/);
assert.match(sharedContextMenuStyles, /\.context-menu\s*\{/);
assert.doesNotMatch(
  remoteDesktopShellBase,
  /\.monitor-pane/,
  'remote desktop shell styles must not duplicate monitor-owned layout declarations',
);
assert.doesNotMatch(
  fileExplorerBase,
  /\.file-pane\s*\{[^{}]*\}\s*\.file-pane\s*\{/s,
  'adjacent file-pane declarations must stay consolidated',
);
const monitorPaneSource = ruleBody(monitorStyles, '.monitor-pane');
assert.match(monitorPaneSource, /height:\s*100%;/);
assert.match(monitorPaneSource, /min-height:\s*0;/);
assert.match(monitorPaneSource, /gap:\s*10px;/);

console.log(`Style ownership contract ok: ${lazyStyleImports.length} lazy app styles have single owners; deferred CSS is ${Buffer.byteLength(deferredCss)} bytes.`);
