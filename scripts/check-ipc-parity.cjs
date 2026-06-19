const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readWorkspaceFiles(relativePath, extension) {
  const base = path.join(root, relativePath);
  const entries = fs.readdirSync(base, { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const entryPath = path.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        return readWorkspaceFiles(entryPath, extension);
      }
      return entry.name.endsWith(extension) ? [readWorkspaceFile(entryPath)] : [];
    })
    .join('\n');
}

function listWorkspaceFiles(relativePath, predicate) {
  const base = path.join(root, relativePath);
  const entries = fs.readdirSync(base, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      return listWorkspaceFiles(entryPath, predicate);
    }
    return predicate(entryPath) ? [entryPath] : [];
  });
}

function unique(values) {
  return [...new Set(values)];
}

function extractBridgeChannels(source) {
  return unique(
    [...source.matchAll(/ipc(?:<[^>]+>)?\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
  ).sort();
}

function extractRustDispatcherChannels(source) {
  const channels = [...source.matchAll(/"([a-z][a-z0-9-]*:[^"]+)"\s*=>/g)].map((match) => match[1]);
  const alternateChannels = [...source.matchAll(/"([a-z][a-z0-9-]*:[^"]+)"\s*\|\s*"([a-z][a-z0-9-]*:[^"]+)"\s*=>/g)]
    .flatMap((match) => [match[1], match[2]]);
  return unique([...channels, ...alternateChannels]).sort();
}

function extractBridgeEventChannels(source) {
  return unique(
    [...source.matchAll(/onTauriEvent(?:<[^>]+>)?\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
  ).sort();
}

function extractRustEmittedEventChannels(source) {
  const directChannels = [...source.matchAll(/\.emit\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  const helperChannels = [...source.matchAll(/emit_connection_event\(\s*[^,]+,\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  return unique([...directChannels, ...helperChannels]).sort();
}

function diff(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function readSourceFile(relativePath) {
  const source = readWorkspaceFile(relativePath);
  const scriptKind = relativePath.endsWith('.ts') || relativePath.endsWith('.d.ts')
    ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function collectObjectPaths(objectNode, prefix = []) {
  const paths = [];

  for (const property of objectNode.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      paths.push([...prefix, property.name.text].join('.'));
      continue;
    }

    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const name = propertyNameText(property.name);
    if (!name) {
      continue;
    }

    const nextPrefix = [...prefix, name];
    if (ts.isObjectLiteralExpression(property.initializer)) {
      paths.push(...collectObjectPaths(property.initializer, nextPrefix));
    } else {
      paths.push(nextPrefix.join('.'));
    }
  }

  return paths;
}

function findTauriGuiSshObject(sourceFile) {
  let result;

  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'guiSSH' &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === 'window' &&
      ts.isObjectLiteralExpression(node.right)
    ) {
      result = node.right;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (!result) {
    throw new Error('Could not find window.guiSSH assignment in src/tauriBridge.ts.');
  }
  return result;
}

function interfaceMap(sourceFile) {
  const interfaces = new Map();

  function visit(node) {
    if (ts.isInterfaceDeclaration(node)) {
      interfaces.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return interfaces;
}

function collectInterfacePaths(interfaces, interfaceName, prefix = []) {
  const declaration = interfaces.get(interfaceName);
  if (!declaration) {
    throw new Error(`Could not find ${interfaceName} in src/vite-env.d.ts.`);
  }

  const paths = [];
  for (const member of declaration.members) {
    if (!ts.isPropertySignature(member) || !member.type) {
      continue;
    }

    const name = propertyNameText(member.name);
    if (!name) {
      continue;
    }

    const nextPrefix = [...prefix, name];
    if (
      interfaceName === 'ShellDeskApi' &&
      ts.isTypeReferenceNode(member.type) &&
      ts.isIdentifier(member.type.typeName) &&
      member.type.typeName.text.endsWith('Controls')
    ) {
      paths.push(...collectInterfacePaths(interfaces, member.type.typeName.text, nextPrefix));
    } else {
      paths.push(nextPrefix.join('.'));
    }
  }

  return paths;
}

function assertEmptyDiff(title, values) {
  if (!values.length) {
    return;
  }

  failures.push([
    title,
    ...values.map((value) => `  - ${value}`),
  ].join('\n'));
}

function findDirectTauriApiUseOutsideBridge() {
  return listWorkspaceFiles('src', (filePath) => /\.(ts|tsx)$/.test(filePath))
    .filter((filePath) => filePath !== 'src\\tauriBridge.ts' && filePath !== 'src/tauriBridge.ts')
    .flatMap((filePath) => {
      const source = readWorkspaceFile(filePath);
      const lines = source.split(/\r?\n/);
      return lines
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(({ line }) => (
          line.includes('@tauri-apps/api') ||
          /\binvoke\s*\(/.test(line) ||
          /\blisten\s*\(/.test(line)
        ))
        .map(({ line, lineNumber }) => `${filePath}:${lineNumber}: ${line.trim()}`);
    });
}

const tauriBridgeSource = readWorkspaceFile('src/tauriBridge.ts');
const rustDispatcherSource = [
  readWorkspaceFile('src-tauri/src/ipc/app_channels.rs'),
  readWorkspaceFile('src-tauri/src/ipc/vault_channels.rs'),
  readWorkspaceFile('src-tauri/src/ipc/utility_channels.rs'),
  readWorkspaceFile('src-tauri/src/ipc/connection_channels.rs'),
  readWorkspaceFile('src-tauri/src/ipc/database_channels.rs'),
].join('\n');
const rustSource = readWorkspaceFiles('src-tauri/src', '.rs');

const bridgeChannels = extractBridgeChannels(tauriBridgeSource);
const rustChannels = extractRustDispatcherChannels(rustDispatcherSource);
const bridgeEventChannels = extractBridgeEventChannels(tauriBridgeSource);
const rustEmittedEventChannels = extractRustEmittedEventChannels(rustSource);
const bridgeApiPaths = unique(collectObjectPaths(findTauriGuiSshObject(readSourceFile('src/tauriBridge.ts')))).sort();
const typeApiPaths = unique(
  collectInterfacePaths(interfaceMap(readSourceFile('src/vite-env.d.ts')), 'ShellDeskApi'),
).sort();

const missingRustChannels = diff(bridgeChannels, rustChannels);
const unbridgedRustChannels = diff(rustChannels, bridgeChannels);
const missingRustEventEmitters = diff(bridgeEventChannels, rustEmittedEventChannels);
const missingTypedApiPaths = diff(typeApiPaths, bridgeApiPaths);
const untypedBridgeApiPaths = diff(bridgeApiPaths, typeApiPaths);
const directTauriApiUseOutsideBridge = findDirectTauriApiUseOutsideBridge();

const failures = [];

assertEmptyDiff('Bridge IPC channels missing from the Rust dispatcher:', missingRustChannels);
assertEmptyDiff('Rust dispatcher channels missing from the Tauri bridge:', unbridgedRustChannels);
assertEmptyDiff('Tauri bridge event channels missing Rust emitters:', missingRustEventEmitters);
assertEmptyDiff('vite-env ShellDeskApi paths missing from the Tauri bridge:', missingTypedApiPaths);
assertEmptyDiff('Tauri bridge guiSSH API paths missing from vite-env ShellDeskApi:', untypedBridgeApiPaths);
assertEmptyDiff('Renderer files must use window.guiSSH instead of direct Tauri API calls:', directTauriApiUseOutsideBridge);

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log(`IPC parity ok: ${bridgeChannels.length} bridged channels match the Rust dispatcher.`);
console.log(`Event parity ok: ${bridgeEventChannels.length} bridge event channels have Rust emitters.`);
console.log(`guiSSH API parity ok: ${typeApiPaths.length} typed API paths match the Tauri bridge.`);
console.log('Renderer IPC boundary ok: no React source files bypass src/tauriBridge.ts.');
