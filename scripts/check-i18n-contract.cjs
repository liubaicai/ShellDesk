const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function readWorkspaceFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function unique(values) {
  return [...new Set(values)];
}

function diff(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current
    && (
      ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isParenthesizedExpression(current)
    )
  ) {
    current = current.expression;
  }
  return current;
}

function createSourceFile(relativePath) {
  return ts.createSourceFile(
    relativePath,
    readWorkspaceFile(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function propertyNameText(name) {
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isIdentifier(name)) {
    return name.text;
  }
  return null;
}

function findVariableObject(sourceFile, variableName) {
  let found = null;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === variableName
      && node.initializer
    ) {
      const expression = unwrapExpression(node.initializer);
      if (expression && ts.isObjectLiteralExpression(expression)) {
        found = expression;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!found) {
    throw new Error(`Could not find object variable: ${variableName}`);
  }
  return found;
}

function findObjectProperty(objectExpression, propertyName) {
  for (const property of objectExpression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (propertyNameText(property.name) === propertyName) {
      const expression = unwrapExpression(property.initializer);
      if (!expression || !ts.isObjectLiteralExpression(expression)) {
        throw new Error(`Property ${propertyName} is not an object literal.`);
      }
      return expression;
    }
  }
  throw new Error(`Could not find object property: ${propertyName}`);
}

function readMessageDictionary(objectExpression) {
  const entries = new Map();
  for (const property of objectExpression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const key = propertyNameText(property.name);
    if (!key) {
      continue;
    }
    if (entries.has(key)) {
      throw new Error(`Duplicate i18n key: ${key}`);
    }
    entries.set(key, property.initializer.getText());
  }
  return entries;
}

function placeholders(templateSource) {
  return unique([...templateSource.matchAll(/\{(\w+)\}/g)].map((match) => match[1])).sort();
}

function compareDictionaries(label, zhMessages, enMessages, errors) {
  const zhKeys = [...zhMessages.keys()].sort();
  const enKeys = [...enMessages.keys()].sort();
  const missingEn = diff(zhKeys, enKeys);
  const missingZh = diff(enKeys, zhKeys);
  if (missingEn.length || missingZh.length) {
    errors.push(`${label} i18n keys differ.\n  missing en-US: ${missingEn.join(', ') || '(none)'}\n  missing zh-CN: ${missingZh.join(', ') || '(none)'}`);
  }

  for (const key of zhKeys.filter((candidate) => enMessages.has(candidate))) {
    const zhPlaceholders = placeholders(zhMessages.get(key));
    const enPlaceholders = placeholders(enMessages.get(key));
    if (
      zhPlaceholders.length !== enPlaceholders.length
      || zhPlaceholders.some((placeholder, index) => enPlaceholders[index] !== placeholder)
    ) {
      errors.push(`${label} placeholder mismatch for ${key}: zh-CN={${zhPlaceholders.join(', ')}} en-US={${enPlaceholders.join(', ')}}`);
    }
  }
}

const zhCatalogSource = createSourceFile('src/i18nCatalog.zh-CN.ts');
const enCatalogSource = createSourceFile('src/i18nCatalog.en-US.ts');
const coreSource = createSourceFile('src/i18nCoreCatalog.ts');
const errors = [];

compareDictionaries(
  'Full catalog',
  readMessageDictionary(findVariableObject(zhCatalogSource, 'zhCN')),
  readMessageDictionary(findVariableObject(enCatalogSource, 'enUS')),
  errors,
);

const coreCatalog = findVariableObject(coreSource, 'coreMessageCatalog');
compareDictionaries(
  'Core catalog',
  readMessageDictionary(findObjectProperty(coreCatalog, 'zh-CN')),
  readMessageDictionary(findObjectProperty(coreCatalog, 'en-US')),
  errors,
);

if (errors.length) {
  console.error(errors.join('\n\n'));
  process.exit(1);
}

console.log('i18n contract ok: zh-CN and en-US keys and placeholders match in full and core catalogs.');
