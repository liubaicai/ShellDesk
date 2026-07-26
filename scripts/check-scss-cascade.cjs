const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const stylesRoot = path.join(root, 'src', 'styles');
const fix = process.argv.includes('--fix');
const auditPartial = process.argv.includes('--audit-partial');
const selfTestOnly = process.argv.includes('--self-test');
const fallbackMarker = '/* shelldesk-scss-fallback */';

function listScssFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listScssFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.scss') ? [fullPath] : [];
  });
}

function skipQuoted(source, index, end) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < end) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === quote) {
      return cursor + 1;
    }
    cursor += 1;
  }
  return end;
}

function skipComment(source, index, end) {
  if (source[index] !== '/') {
    return index;
  }
  if (source[index + 1] === '/') {
    const newline = source.indexOf('\n', index + 2);
    return newline === -1 || newline >= end ? end : newline + 1;
  }
  if (source[index + 1] === '*') {
    const close = source.indexOf('*/', index + 2);
    return close === -1 || close + 2 >= end ? end : close + 2;
  }
  return index;
}

function skipInterpolation(source, index, end) {
  if (source[index] !== '#' || source[index + 1] !== '{') {
    return index;
  }
  let depth = 1;
  let cursor = index + 2;
  while (cursor < end) {
    const char = source[cursor];
    if (char === '"' || char === "'") {
      cursor = skipQuoted(source, cursor, end);
      continue;
    }
    const interpolationEnd = skipInterpolation(source, cursor, end);
    if (interpolationEnd !== cursor) {
      cursor = interpolationEnd;
      continue;
    }
    const commentEnd = skipComment(source, cursor, end);
    if (commentEnd !== cursor) {
      cursor = commentEnd;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return end;
}

function skipTrivia(source, index, end) {
  let cursor = index;
  while (cursor < end) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
      continue;
    }
    const commentEnd = skipComment(source, cursor, end);
    if (commentEnd !== cursor) {
      cursor = commentEnd;
      continue;
    }
    break;
  }
  return cursor;
}

function findBlockEnd(source, openIndex, end) {
  let depth = 1;
  let cursor = openIndex + 1;
  while (cursor < end) {
    const char = source[cursor];
    if (char === '"' || char === "'") {
      cursor = skipQuoted(source, cursor, end);
      continue;
    }
    const interpolationEnd = skipInterpolation(source, cursor, end);
    if (interpolationEnd !== cursor) {
      cursor = interpolationEnd;
      continue;
    }
    const commentEnd = skipComment(source, cursor, end);
    if (commentEnd !== cursor) {
      cursor = commentEnd;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }
  return end;
}

function normalizePrelude(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function splitSelectorList(selector) {
  const selectors = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let interpolation = 0;
  let cursor = 0;

  while (cursor < selector.length) {
    const char = selector[cursor];
    if (char === '"' || char === "'") {
      cursor = skipQuoted(selector, cursor, selector.length);
      continue;
    }
    if (char === '#' && selector[cursor + 1] === '{') {
      interpolation += 1;
      cursor += 2;
      continue;
    }
    if (char === '{' && interpolation > 0) interpolation += 1;
    if (char === '}' && interpolation > 0) interpolation -= 1;
    if (char === '(') parentheses += 1;
    if (char === ')') parentheses -= 1;
    if (char === '[') brackets += 1;
    if (char === ']') brackets -= 1;
    if (char === ',' && parentheses === 0 && brackets === 0 && interpolation === 0) {
      const item = selector.slice(start, cursor).trim();
      if (item) {
        selectors.push(item);
      }
      start = cursor + 1;
    }
    cursor += 1;
  }

  const tail = selector.slice(start).trim();
  if (tail) {
    selectors.push(tail);
  }
  return [...new Set(selectors)];
}

function selectorKeysForRule(rule) {
  return splitSelectorList(rule.selector).map((selector) => ({
    key: `${rule.context}\u0000${selector}`,
    selector,
  }));
}

function readDeclarations(source, start, end) {
  const declarations = [];
  let statementStart = start;
  let cursor = start;
  let nestedDepth = 0;

  function recordDeclaration(statementEnd) {
    const propertyStart = skipTrivia(source, statementStart, statementEnd);
    const leadingTrivia = source.slice(statementStart, propertyStart);
    const statement = source.slice(propertyStart, statementEnd);
    const match = statement.match(/^([\w-]+)\s*:\s*([\s\S]*?);?\s*$/);
    if (!match || match[2].includes('{') || match[2].includes('}')) {
      return;
    }
    declarations.push({
      property: match[1].toLowerCase(),
      important: /!important\s*;?\s*$/i.test(statement),
      fallback: leadingTrivia.includes(fallbackMarker),
      start: propertyStart,
      end: statementEnd,
    });
  }

  while (cursor < end) {
    const char = source[cursor];
    if (char === '"' || char === "'") {
      cursor = skipQuoted(source, cursor, end);
      continue;
    }
    const interpolationEnd = skipInterpolation(source, cursor, end);
    if (interpolationEnd !== cursor) {
      cursor = interpolationEnd;
      continue;
    }
    const commentEnd = skipComment(source, cursor, end);
    if (commentEnd !== cursor) {
      cursor = commentEnd;
      continue;
    }
    if (char === '{') {
      nestedDepth += 1;
    } else if (char === '}') {
      nestedDepth -= 1;
      if (nestedDepth === 0) {
        statementStart = cursor + 1;
      }
    } else if (char === ';' && nestedDepth === 0) {
      recordDeclaration(cursor + 1);
      statementStart = cursor + 1;
    }
    cursor += 1;
  }

  const tailStart = skipTrivia(source, statementStart, end);
  if (tailStart < end) {
    recordDeclaration(end);
  }
  return declarations;
}

function parseRules(source) {
  const rules = [];

  function parseRange(start, end, atRules, parents) {
    let cursor = start;
    while (cursor < end) {
      cursor = skipTrivia(source, cursor, end);
      if (cursor >= end) {
        break;
      }

      const preludeStart = cursor;
      let parentheses = 0;
      let brackets = 0;
      let openIndex = -1;
      while (cursor < end) {
        const char = source[cursor];
        if (char === '"' || char === "'") {
          cursor = skipQuoted(source, cursor, end);
          continue;
        }
        const interpolationEnd = skipInterpolation(source, cursor, end);
        if (interpolationEnd !== cursor) {
          cursor = interpolationEnd;
          continue;
        }
        const commentEnd = skipComment(source, cursor, end);
        if (commentEnd !== cursor) {
          cursor = commentEnd;
          continue;
        }
        if (char === '(') parentheses += 1;
        if (char === ')') parentheses -= 1;
        if (char === '[') brackets += 1;
        if (char === ']') brackets -= 1;
        if (char === ';' && parentheses === 0 && brackets === 0) {
          cursor += 1;
          break;
        }
        if (char === '{' && parentheses === 0 && brackets === 0) {
          openIndex = cursor;
          break;
        }
        cursor += 1;
      }

      if (openIndex === -1) {
        continue;
      }

      const closeIndex = findBlockEnd(source, openIndex, end);
      const prelude = normalizePrelude(source.slice(preludeStart, openIndex));
      const bodyStart = openIndex + 1;
      if (prelude.startsWith('@')) {
        if (!/^@(font-face|keyframes|property)\b/.test(prelude)) {
          parseRange(bodyStart, closeIndex, [...atRules, prelude], parents);
        }
      } else if (prelude) {
        rules.push({
          selector: prelude,
          context: [...atRules, ...parents].join('\u0000'),
          declarations: readDeclarations(source, bodyStart, closeIndex),
          start: preludeStart,
          bodyStart,
          bodyEnd: closeIndex,
          end: closeIndex + 1,
        });
        parseRange(bodyStart, closeIndex, atRules, [...parents, prelude]);
      }
      cursor = closeIndex + 1;
    }
  }

  parseRange(0, source.length, [], []);
  return rules;
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') {
      line += 1;
    }
  }
  return line;
}

function expandRemovalRange(source, start, end) {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const newline = source.indexOf('\n', end);
  const lineEnd = newline === -1 ? source.length : newline + 1;
  if (
    source.slice(lineStart, start).trim() === ''
    && source.slice(end, newline === -1 ? source.length : newline).trim() === ''
  ) {
    return { start: lineStart, end: lineEnd };
  }
  return { start, end };
}

function mergeRanges(ranges) {
  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  const merged = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function removeEmptyStyleRules(source) {
  let nextSource = source;
  while (true) {
    const emptyRules = parseRules(nextSource).filter((rule) => (
      nextSource.slice(rule.bodyStart, rule.bodyEnd).trim() === ''
    ));
    if (!emptyRules.length) {
      return nextSource;
    }
    const ranges = mergeRanges(emptyRules.map((rule) => {
      const lineStart = nextSource.lastIndexOf('\n', rule.start - 1) + 1;
      const newline = nextSource.indexOf('\n', rule.end);
      return {
        start: nextSource.slice(lineStart, rule.start).trim() === '' ? lineStart : rule.start,
        end: newline === -1 ? nextSource.length : newline + 1,
      };
    }));
    for (const range of ranges.toReversed()) {
      nextSource = `${nextSource.slice(0, range.start)}${nextSource.slice(range.end)}`;
    }
  }
}

function findShadowedDeclarations(source) {
  const groups = new Map();
  for (const rule of parseRules(source)) {
    for (const selectorKey of selectorKeysForRule(rule)) {
      if (!groups.has(selectorKey.key)) {
        groups.set(selectorKey.key, []);
      }
      groups.get(selectorKey.key).push({
        rule,
        selector: selectorKey.selector,
      });
    }
  }

  const shadowedByDeclaration = new Map();
  for (const occurrences of groups.values()) {
    const declarationsByProperty = new Map();
    for (const occurrence of occurrences) {
      for (const declaration of occurrence.rule.declarations) {
        if (!declarationsByProperty.has(declaration.property)) {
          declarationsByProperty.set(declaration.property, []);
        }
        declarationsByProperty.get(declaration.property).push({
          ...occurrence,
          declaration,
        });
      }
    }
    for (const entries of declarationsByProperty.values()) {
      if (entries.length < 2) {
        continue;
      }
      for (let index = 0; index < entries.length - 1; index += 1) {
        const entry = entries[index];
        if (entry.declaration.fallback) {
          continue;
        }
        const later = entries.slice(index + 1);
        if (!entry.declaration.important || later.some((candidate) => candidate.declaration.important)) {
          const declarationKey = `${entry.declaration.start}\u0000${entry.declaration.end}`;
          if (!shadowedByDeclaration.has(declarationKey)) {
            shadowedByDeclaration.set(declarationKey, {
              declaration: entry.declaration,
              rule: entry.rule,
              shadowedSelectors: new Set(),
            });
          }
          shadowedByDeclaration.get(declarationKey).shadowedSelectors.add(entry.selector);
        }
      }
    }
  }
  return [...shadowedByDeclaration.values()].map((entry) => {
    const selectorCount = selectorKeysForRule(entry.rule).length;
    return {
      ...entry.declaration,
      selectors: [...entry.shadowedSelectors],
      partialSelector: entry.shadowedSelectors.size < selectorCount,
    };
  });
}

function runSelfTests() {
  const sameBlock = findShadowedDeclarations(`
    .item {
      color: red;
      color: blue;
    }
  `);
  assert.equal(sameBlock.length, 1, 'detects duplicate properties in one rule block');
  assert.equal(sameBlock[0].property, 'color');
  assert.equal(sameBlock[0].partialSelector, false);
  assert.deepEqual(sameBlock[0].selectors, ['.item']);

  const intentionalFallback = findShadowedDeclarations(`
    .item {
      ${fallbackMarker}
      display: -webkit-box;
      display: flex;
    }
  `);
  assert.equal(intentionalFallback.length, 0, 'allows an explicitly marked progressive fallback');

  const markerOnFinalDeclaration = findShadowedDeclarations(`
    .item {
      display: -webkit-box;
      ${fallbackMarker}
      display: flex;
    }
  `);
  assert.equal(
    markerOnFinalDeclaration.length,
    1,
    'the fallback marker applies only to the declaration immediately after it',
  );

  const interpolatedSelectors = findShadowedDeclarations(`
    @mixin component($namespace) {
      .#{$namespace}-panel {
        --#{$namespace}-background: red;
        color: var(--#{$namespace}-text);
      }
      [data-theme="light"] .#{$namespace}-panel {
        --#{$namespace}-background: white;
      }
    }
  `);
  assert.equal(interpolatedSelectors.length, 0, 'parses Sass interpolation without inventing rules');

  const laterRule = findShadowedDeclarations(`
    .item {
      color: red;
    }
    .item {
      color: blue;
    }
  `);
  assert.equal(laterRule.length, 1, 'detects a later matching selector');
  assert.equal(laterRule[0].property, 'color');
  assert.equal(laterRule[0].partialSelector, false);
  assert.deepEqual(laterRule[0].selectors, ['.item']);

  const separateMediaContexts = findShadowedDeclarations(`
    @media (max-width: 720px) {
      .item {
        color: red;
      }
    }
    @media (min-width: 721px) {
      .item {
        color: blue;
      }
    }
  `);
  assert.equal(separateMediaContexts.length, 0, 'keeps distinct media contexts separate');

  const partialSelector = findShadowedDeclarations(`
    .item,
    .item-label {
      color: red;
    }
    .item {
      color: blue;
    }
  `);
  assert.equal(partialSelector.length, 1, 'detects overlap in a selector list');
  assert.equal(partialSelector[0].property, 'color');
  assert.equal(partialSelector[0].partialSelector, true);
  assert.deepEqual(partialSelector[0].selectors, ['.item']);
}

runSelfTests();
if (selfTestOnly) {
  console.log('SCSS cascade self-test ok.');
  process.exit(0);
}

const reports = [];
const scssFiles = listScssFiles(stylesRoot);
for (const filePath of scssFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  const detectedShadowed = findShadowedDeclarations(source);
  const shadowed = auditPartial
    ? detectedShadowed
    : detectedShadowed.filter((declaration) => !declaration.partialSelector);
  if (!shadowed.length) {
    continue;
  }
  reports.push({
    filePath,
    source,
    shadowed,
  });
}

function findCrossFileRedeclarations() {
  const groups = new Map();
  for (const filePath of scssFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const rule of parseRules(source)) {
      const selectorKeys = auditPartial
        ? selectorKeysForRule(rule)
        : [{ key: `${rule.context}\u0000${rule.selector}`, selector: rule.selector }];
      for (const selectorKey of selectorKeys) {
        if (!groups.has(selectorKey.key)) {
          groups.set(selectorKey.key, []);
        }
        groups.get(selectorKey.key).push({
          filePath,
          source,
          rule,
          selector: selectorKey.selector,
        });
      }
    }
  }

  const redeclarations = [];
  for (const occurrences of groups.values()) {
    if (new Set(occurrences.map((occurrence) => occurrence.filePath)).size < 2) {
      continue;
    }
    const declarationsByProperty = new Map();
    for (const occurrence of occurrences) {
      for (const declaration of occurrence.rule.declarations) {
        if (!declarationsByProperty.has(declaration.property)) {
          declarationsByProperty.set(declaration.property, []);
        }
        declarationsByProperty.get(declaration.property).push({
          ...occurrence,
          declaration,
        });
      }
    }
    for (const declarations of declarationsByProperty.values()) {
      if (new Set(declarations.map((entry) => entry.filePath)).size > 1) {
        redeclarations.push({
          declarations,
          selector: declarations[0].selector,
        });
      }
    }
  }
  return redeclarations;
}

const crossFileRedeclarations = findCrossFileRedeclarations();

if (fix) {
  let skippedPartialDeclarations = 0;
  let removedDeclarations = 0;
  for (const report of reports) {
    const safeDeclarations = report.shadowed.filter((declaration) => !declaration.partialSelector);
    skippedPartialDeclarations += report.shadowed.length - safeDeclarations.length;
    removedDeclarations += safeDeclarations.length;
    const ranges = mergeRanges(
      safeDeclarations.map((declaration) => (
        expandRemovalRange(report.source, declaration.start, declaration.end)
      )),
    );
    let nextSource = report.source;
    for (const range of ranges.toReversed()) {
      nextSource = `${nextSource.slice(0, range.start)}${nextSource.slice(range.end)}`;
    }
    nextSource = removeEmptyStyleRules(nextSource);
    fs.writeFileSync(report.filePath, nextSource);
  }
  for (const filePath of listScssFiles(stylesRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const nextSource = removeEmptyStyleRules(source);
    if (nextSource !== source) {
      fs.writeFileSync(filePath, nextSource);
    }
  }
  console.log(`Removed ${removedDeclarations} fully shadowed SCSS declarations from ${reports.length} files.`);
  if (skippedPartialDeclarations > 0) {
    console.error(`Skipped ${skippedPartialDeclarations} partial-selector declarations because removing them would affect selectors that are not shadowed.`);
    process.exit(1);
  }
  process.exit(0);
}

if (reports.length || crossFileRedeclarations.length) {
  console.error([
    'SCSS cascade check failed: identical selectors redeclare properties later in the same context.',
    ...reports.flatMap((report) => {
      const relativePath = path.relative(root, report.filePath).replace(/\\/g, '/');
      return report.shadowed.map((declaration) => (
        `  - ${relativePath}:${lineNumberAt(report.source, declaration.start)}: ${declaration.property}`
        + ` (${declaration.partialSelector ? 'partial ' : ''}${declaration.selectors.join(', ')})`
      ));
    }),
    ...crossFileRedeclarations.map(({ declarations, selector }) => {
      const property = declarations[0].declaration.property;
      const locations = declarations.map((entry) => {
        const relativePath = path.relative(root, entry.filePath).replace(/\\/g, '/');
        return `${relativePath}:${lineNumberAt(entry.source, entry.declaration.start)}`;
      });
      return `  - cross-file ${property} (${selector}): ${locations.join(', ')}`;
    }),
    `Place ${fallbackMarker} immediately before an intentional progressive fallback declaration.`,
    'Run `node scripts/check-scss-cascade.cjs --fix` to remove fully shadowed declarations; partial selector overlaps require a manual split.',
  ].join('\n'));
  process.exit(1);
}

console.log('SCSS cascade ok: no logical selector redeclares the same property later in one context.');
