const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const catalogPath = path.join(root, 'src', 'remoteDesktopCatalog.ts');
const reportPath = path.join(root, 'docs', 'remote-desktop-capability-matrix.md');
const sourceText = fs.readFileSync(catalogPath, 'utf8').replace(/\r\n/g, '\n');
const sourceFile = ts.createSourceFile(catalogPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  throw new Error(`Unsupported property name: ${node.getText(sourceFile)}`);
}

const declarations = new Map();

function visitDeclarations(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    declarations.set(node.name.text, node.initializer);
  }
  ts.forEachChild(node, visitDeclarations);
}

visitDeclarations(sourceFile);

function unwrap(node) {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}

function evaluate(node) {
  const valueNode = unwrap(node);
  if (ts.isStringLiteral(valueNode) || ts.isNumericLiteral(valueNode)) {
    return valueNode.text;
  }
  if (valueNode.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (valueNode.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(valueNode)) {
    const declaration = declarations.get(valueNode.text);
    if (!declaration) throw new Error(`Unknown catalog identifier: ${valueNode.text}`);
    return evaluate(declaration);
  }
  if (ts.isArrayLiteralExpression(valueNode)) {
    return valueNode.elements.map(evaluate);
  }
  if (ts.isObjectLiteralExpression(valueNode)) {
    return Object.fromEntries(valueNode.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error(`Unsupported catalog property: ${property.getText(sourceFile)}`);
      }
      return [propertyName(property.name), evaluate(property.initializer)];
    }));
  }
  throw new Error(`Unsupported catalog expression: ${valueNode.getText(sourceFile)}`);
}

function readVariable(name) {
  const declaration = declarations.get(name);
  if (!declaration) throw new Error(`Missing catalog declaration: ${name}`);
  return evaluate(declaration);
}

const apps = readVariable('desktopApps');
const capabilities = readVariable('desktopAppCapabilities');
const appKeys = apps.map((app) => app.key);
const capabilityKeys = Object.keys(capabilities);

if (JSON.stringify([...capabilityKeys].sort()) !== JSON.stringify([...appKeys].sort())) {
  throw new Error('desktopAppCapabilities must contain exactly one entry for every desktop app.');
}

function toolLabel(requirement) {
  return Array.isArray(requirement) ? requirement.join(' / ') : requirement;
}

function toolsByPlatform(capability, platform) {
  const requirements = capability.requiredToolsBySystem?.[platform] ?? capability.requiredTools;
  return requirements.length > 0 ? requirements.map(toolLabel).join(', ') : '—';
}

function validationStatus(capability, platform) {
  if (!capability.supportedSystems.includes(platform)) return 'expected-unsupported';
  const requirements = capability.requiredToolsBySystem?.[platform] ?? capability.requiredTools;
  return requirements.length > 0 ? 'automated-probe' : 'not-applicable';
}

const lines = [
  '# 远程桌面应用能力与验证矩阵',
  '',
  '> 本文档由 `src/remoteDesktopCatalog.ts` 生成。运行 `node scripts/check-desktop-capability-matrix.cjs --write` 更新；CI 使用无参数模式检查漂移。',
  '',
  '状态说明：',
  '',
  '- `automated-contract`：注册、窗口、图标、i18n 和渲染分支由合同检查覆盖。',
  '- `automated-probe`：Launchpad 会在连接级缓存中自动探测依赖，并覆盖缺失依赖状态。',
  '- `expected-unsupported`：平台不在应用声明范围内，打开入口会被能力门禁阻止。',
  '- `not-applicable`：该平台无需外部命令探测。',
  '- `environment-required`：仍需在对应真实主机上验证完整业务读写流程，不能把缺少环境误报为通过。',
  '',
  `当前目录共 ${apps.length} 个应用。`,
  '',
  '| appKey | 平台 | Linux 依赖 | Windows 依赖 | macOS 依赖 | 模式 | 权限 | 启动合同 | Linux 依赖/不支持 | Windows 依赖/不支持 | macOS 依赖/不支持 | 真实主机 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...apps.map((app) => {
    const capability = capabilities[app.key];
    return [
      `\`${app.key}\``,
      capability.supportedSystems.join(' / '),
      toolsByPlatform(capability, 'linux'),
      toolsByPlatform(capability, 'windows'),
      toolsByPlatform(capability, 'macos'),
      capability.mode,
      capability.permission,
      'automated-contract',
      validationStatus(capability, 'linux'),
      validationStatus(capability, 'windows'),
      validationStatus(capability, 'macos'),
      'environment-required',
    ].join(' | ').replace(/^/u, '| ').replace(/$/u, ' |');
  }),
  '',
  '## 验证边界',
  '',
  '- 本矩阵证明应用目录、静态平台门禁和依赖探测契约完整，不把它等同于真实系统上的功能成功。',
  '- 具有写操作的管理组件仍须在兼容性报告中记录成功读流程、权限不足流程、危险操作确认和失败恢复。',
  '- 新增 appKey 时，桌面应用合同会要求同步能力元数据；本脚本随后自动生成对应矩阵行。',
  '',
].join('\n');

if (process.argv.includes('--write')) {
  fs.writeFileSync(reportPath, lines, 'utf8');
  console.log(`Wrote ${path.relative(root, reportPath)} with ${apps.length} app rows.`);
  process.exit(0);
}

const current = fs.existsSync(reportPath)
  ? fs.readFileSync(reportPath, 'utf8').replace(/\r\n/g, '\n')
  : '';
if (current !== lines) {
  console.error('Remote desktop capability matrix is stale. Run: node scripts/check-desktop-capability-matrix.cjs --write');
  process.exit(1);
}

console.log(`Desktop capability matrix ok: ${apps.length} app rows match the runtime catalog.`);
