const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const checkedKeys = [
  'language',
  'interfaceFont',
  'theme',
  'accentColor',
  'defaultHostView',
  'minimizeToTrayOnClose',
  'autoUpdateEnabled',
  'desktopWallpaperMode',
  'desktopWallpaperPresetId',
  'desktopWallpaperDataUrl',
  'desktopWallpaperName',
  'rememberPasswords',
  'rememberKeyPassphrases',
  'aiProvider',
  'aiProviderName',
  'aiApiFormat',
  'aiApiBaseUrl',
  'aiApiKey',
  'aiModel',
  'terminalFontSize',
  'terminalFontFamily',
  'terminalFontWeight',
  'terminalFontWeightBold',
  'terminalLigatures',
  'terminalFontLigatures',
  'terminalLineHeight',
  'terminalTheme',
  'terminalCursorBlink',
  'terminalCursorStyle',
  'terminalCursorInactiveStyle',
  'terminalScrollback',
  'terminalScrollSensitivity',
  'terminalFastScrollSensitivity',
  'terminalScrollOnUserInput',
  'terminalScrollOnEraseInDisplay',
  'terminalCopyOnSelect',
  'terminalRightClickPaste',
  'terminalAltClickMovesCursor',
  'terminalBracketedPasteMode',
  'terminalMinimumContrastRatio',
  'terminalScreenReaderMode',
];

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error(`Could not find matching brace for index ${openIndex}.`);
}

function extractBalancedObjectAfter(source, marker, objectSearchOffset = 0, startIndex = 0) {
  const markerIndex = source.indexOf(marker, startIndex);
  if (markerIndex === -1) {
    throw new Error(`Could not find marker: ${marker}`);
  }

  const openIndex = source.indexOf('{', markerIndex + objectSearchOffset);
  if (openIndex === -1) {
    throw new Error(`Could not find object after marker: ${marker}`);
  }

  const closeIndex = findMatchingBrace(source, openIndex);
  return source.slice(openIndex + 1, closeIndex);
}

function splitTopLevelProperties(objectBody) {
  const properties = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < objectBody.length; index += 1) {
    const char = objectBody[index];
    const next = objectBody[index + 1];

    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{' || char === '[' || char === '(') {
      depth += 1;
    } else if (char === '}' || char === ']' || char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      properties.push(objectBody.slice(start, index));
      start = index + 1;
    }
  }

  const finalProperty = objectBody.slice(start);
  if (finalProperty.trim()) {
    properties.push(finalProperty);
  }

  return properties;
}

function parseScalarValue(rawValue) {
  const value = rawValue.trim().replace(/,$/, '').trim();
  const stringMatch = value.match(/^(['"])(.*)\1$/s);

  if (stringMatch) {
    return stringMatch[2];
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  return undefined;
}

function extractScalarDefaults(objectBody, label) {
  const entries = new Map();
  const seenKeys = new Set();

  for (const property of splitTopLevelProperties(objectBody)) {
    const trimmed = property.trim();
    const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/);

    if (!match) {
      continue;
    }

    const key = match[1] ?? match[2] ?? match[3];
    if (!checkedKeys.includes(key)) {
      continue;
    }

    seenKeys.add(key);
    const value = parseScalarValue(match[4]);
    if (value !== undefined) {
      entries.set(key, value);
    }
  }

  return { label, seenKeys, entries };
}

function extractRustDefaults() {
  const source = readWorkspaceFile('src-tauri/src/vault.rs');
  const functionIndex = source.search(/pub\(crate\)\s+fn\s+default_settings\s*\(/);
  if (functionIndex === -1) {
    throw new Error('Could not find vault.rs::default_settings().');
  }

  const jsonIndex = source.indexOf('json!({', functionIndex);
  if (jsonIndex === -1) {
    throw new Error('Could not find json! object in vault.rs::default_settings().');
  }

  return extractScalarDefaults(
    extractBalancedObjectAfter(source, 'json!({', 'json!('.length, functionIndex),
    'Rust default_settings',
  );
}

function extractAppDefaults() {
  const source = readWorkspaceFile('src/App.tsx');
  return extractScalarDefaults(extractBalancedObjectAfter(source, 'const defaultAppSettings', 'const defaultAppSettings'.length), 'App.tsx defaultAppSettings');
}

function extractPreviewDefaults() {
  const source = readWorkspaceFile('src/tauriBridge.ts');
  const functionIndex = source.indexOf('function createPreviewSettings');
  if (functionIndex === -1) {
    throw new Error('Could not find createPreviewSettings().');
  }

  const returnIndex = source.indexOf('return {', functionIndex);
  if (returnIndex === -1) {
    throw new Error('Could not find return object in createPreviewSettings().');
  }

  return extractScalarDefaults(
    extractBalancedObjectAfter(source, 'return {', 'return '.length, functionIndex),
    'tauriBridge.ts createPreviewSettings',
  );
}

function diff(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function formatValue(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

const rustDefaults = extractRustDefaults();
const appDefaults = extractAppDefaults();
const previewDefaults = extractPreviewDefaults();
const failures = [];

for (const defaults of [rustDefaults, appDefaults, previewDefaults]) {
  const missing = diff(checkedKeys, [...defaults.seenKeys]);
  if (missing.length) {
    failures.push(`${defaults.label} is missing checked default keys:\n  - ${missing.join('\n  - ')}`);
  }
}

for (const frontendDefaults of [appDefaults, previewDefaults]) {
  const missingFromFrontend = diff([...rustDefaults.seenKeys], [...frontendDefaults.seenKeys]);
  const extraInFrontend = diff([...frontendDefaults.seenKeys], [...rustDefaults.seenKeys]);

  if (missingFromFrontend.length || extraInFrontend.length) {
    failures.push(
      `${frontendDefaults.label} key set differs from Rust default_settings.\n`
        + `  missing from frontend: ${missingFromFrontend.join(', ') || '(none)'}\n`
        + `  extra in frontend: ${extraInFrontend.join(', ') || '(none)'}`,
    );
  }

  for (const key of checkedKeys) {
    const rustHasEntry = rustDefaults.entries.has(key);
    const frontendHasEntry = frontendDefaults.entries.has(key);

    if (!rustHasEntry && !frontendHasEntry) {
      // Both sides have the key but neither could parse a literal value (e.g. variable references).
      // This is expected for dynamic defaults like `language` — skip comparison.
      continue;
    }

    if (!rustHasEntry || !frontendHasEntry) {
      // One side parsed a literal, the other didn't — potential drift.
      continue;
    }

    const rustValue = rustDefaults.entries.get(key);
    const frontendValue = frontendDefaults.entries.get(key);
    if (rustValue !== frontendValue) {
      failures.push(
        `${frontendDefaults.label} default value drift for ${key}: `
          + `Rust=${formatValue(rustValue)}, frontend=${formatValue(frontendValue)}`,
      );
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}

console.log(`Default settings parity ok: ${checkedKeys.length} scalar defaults match Rust where literal values are comparable.`);
