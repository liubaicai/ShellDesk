const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const stylesRoot = path.join(root, 'src', 'styles');
const fix = process.argv.includes('--fix');

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

function readDeclarations(source, start, end) {
  const declarations = [];
  let statementStart = start;
  let cursor = start;
  let nestedDepth = 0;

  function recordDeclaration(statementEnd) {
    const propertyStart = skipTrivia(source, statementStart, statementEnd);
    const statement = source.slice(propertyStart, statementEnd);
    const match = statement.match(/^([\w-]+)\s*:\s*([\s\S]*?);?\s*$/);
    if (!match || match[2].includes('{') || match[2].includes('}')) {
      return;
    }
    declarations.push({
      property: match[1].toLowerCase(),
      important: /!important\s*;?\s*$/i.test(statement),
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
    const key = `${rule.context}\u0000${rule.selector}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(rule);
  }

  const shadowed = [];
  for (const occurrences of groups.values()) {
    if (occurrences.length < 2) {
      continue;
    }
    const declarationsByProperty = new Map();
    for (const rule of occurrences) {
      for (const declaration of rule.declarations) {
        if (!declarationsByProperty.has(declaration.property)) {
          declarationsByProperty.set(declaration.property, []);
        }
        declarationsByProperty.get(declaration.property).push(declaration);
      }
    }
    for (const declarations of declarationsByProperty.values()) {
      if (declarations.length < 2) {
        continue;
      }
      for (let index = 0; index < declarations.length - 1; index += 1) {
        const declaration = declarations[index];
        const later = declarations.slice(index + 1);
        if (!declaration.important || later.some((candidate) => candidate.important)) {
          shadowed.push(declaration);
        }
      }
    }
  }
  return shadowed;
}

const reports = [];
const scssFiles = listScssFiles(stylesRoot);
for (const filePath of scssFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  const shadowed = findShadowedDeclarations(source);
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
      const key = `${rule.context}\u0000${rule.selector}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push({ filePath, source, rule });
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
        redeclarations.push(declarations);
      }
    }
  }
  return redeclarations;
}

const crossFileRedeclarations = findCrossFileRedeclarations();

if (fix) {
  for (const report of reports) {
    const ranges = mergeRanges(
      report.shadowed.map((declaration) => (
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
  console.log(`Removed ${reports.reduce((sum, report) => sum + report.shadowed.length, 0)} shadowed SCSS declarations from ${reports.length} files.`);
  process.exit(0);
}

if (reports.length || crossFileRedeclarations.length) {
  console.error([
    'SCSS cascade check failed: identical selectors redeclare properties later in the same context.',
    ...reports.flatMap((report) => {
      const relativePath = path.relative(root, report.filePath).replace(/\\/g, '/');
      return report.shadowed.map((declaration) => (
        `  - ${relativePath}:${lineNumberAt(report.source, declaration.start)}: ${declaration.property}`
      ));
    }),
    ...crossFileRedeclarations.map((declarations) => {
      const property = declarations[0].declaration.property;
      const locations = declarations.map((entry) => {
        const relativePath = path.relative(root, entry.filePath).replace(/\\/g, '/');
        return `${relativePath}:${lineNumberAt(entry.source, entry.declaration.start)}`;
      });
      return `  - cross-file ${property}: ${locations.join(', ')}`;
    }),
    'Run `node scripts/check-scss-cascade.cjs --fix` to remove declarations that are shadowed by later identical rules.',
  ].join('\n'));
  process.exit(1);
}

console.log('SCSS cascade ok: no identical selector redeclares the same property later in one context.');
