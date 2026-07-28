const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const writeMode = process.argv.includes('--write');
const roadmapPath = path.join(root, 'docs/remote-desktop-component-roadmap.md');
const matrixPath = path.join(root, 'docs/remote-desktop-capability-matrix.md');
const roadmap = fs.readFileSync(roadmapPath, 'utf8');
const matrix = fs.readFileSync(matrixPath, 'utf8');
const errors = [];

const matrixRows = new Map(
  matrix.split(/\r?\n/)
    .filter((line) => /^\| `[^`]+` \|/.test(line))
    .map((line) => {
      const columns = line.split('|').slice(1, -1).map((column) => column.trim());
      return [columns[0].replaceAll('`', ''), columns];
    }),
);

const componentDocs = roadmap.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^\|\s*(\d{2})\s*\|\s*(.*?)\s*\|.*\(\.\/remote-desktop-components\/([^)]+)\)/);
  if (!match) return [];
  const rawAppKey = match[2];
  const appKey = rawAppKey.match(/`([^`]+)`/)?.[1] ?? 'settings/login-sessions';
  return [{ number: match[1], appKey, fileName: match[3] }];
});

function replaceGeneratedBlock(source, startMarker, endMarker, block) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start >= 0 && end >= start) {
    return source.slice(0, start) + block + source.slice(end + endMarker.length);
  }

  const headingEnd = source.indexOf('\n');
  return source.slice(0, headingEnd + 1) + `\n${block}\n` + source.slice(headingEnd + 1);
}

function componentStatusBlock(spec) {
  const startMarker = '<!-- current-implementation:start -->';
  const endMarker = '<!-- current-implementation:end -->';

  if (spec.number === '23') {
    return `${startMarker}
## 当前实现状态

- 接入状态：已实现，并作为 \`settings\` 应用中的登录会话面板提供，不是独立桌面 appKey。
- 代码入口：\`src/components/remote-desktop/SettingsLoginSessionsPanel.tsx\`。
- 平台与依赖：随系统设置能力运行；具体命令按目标系统选择，真实主机结果仍需环境验证。
- 验证边界：组件接入由类型和构建门禁覆盖；未在真实主机执行的行为必须标记为未测试。
- 最后同步：2026-07-28；完整目录见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
${endMarker}`;
  }

  const row = matrixRows.get(spec.appKey);
  if (!row) {
    errors.push(`${spec.fileName}: appKey ${spec.appKey} is missing from the capability matrix.`);
    return '';
  }

  return `${startMarker}
## 当前实现状态

- 接入状态：已接入远程桌面目录，appKey 为 \`${spec.appKey}\`；注册、窗口、图标、翻译和渲染分支由合同检查覆盖。
- 能力声明：平台 \`${row[1]}\`；模式 \`${row[5]}\`；权限 \`${row[6]}\`。
- 依赖探测：Linux \`${row[2]}\`；Windows \`${row[3]}\`；macOS \`${row[4]}\`。存在依赖时由 Launchpad 连接级探测并显示缺失原因。
- 验证边界：启动合同为 \`${row[7]}\`；完整业务流程仍为 \`${row[11]}\`，没有真实主机证据时不得写成已验证通过。
- 最后同步：2026-07-28；详见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
${endMarker}`;
}

for (const spec of componentDocs) {
  const filePath = path.join(root, 'docs/remote-desktop-components', spec.fileName);
  if (!fs.existsSync(filePath)) {
    errors.push(`Roadmap document is missing: ${spec.fileName}`);
    continue;
  }

  const source = fs.readFileSync(filePath, 'utf8');
  const block = componentStatusBlock(spec);
  const expected = replaceGeneratedBlock(
    source,
    '<!-- current-implementation:start -->',
    '<!-- current-implementation:end -->',
    block,
  );
  if (source !== expected) {
    if (writeMode) fs.writeFileSync(filePath, expected);
    else errors.push(`${spec.fileName}: current implementation block is stale; run this script with --write.`);
  }
}

const reportDirectory = path.join(root, 'docs/system-compatibility-reports');
for (const fileName of fs.readdirSync(reportDirectory).filter((name) => name.endsWith('.md') && !name.startsWith('_'))) {
  const filePath = path.join(reportDirectory, fileName);
  const source = fs.readFileSync(filePath, 'utf8');
  const block = `<!-- catalog-coverage:start -->
> 目录覆盖声明：当前注册目录为 44 个 appKey。下方表格只记录该主机已有的实测子集；表中未列出的目录应用一律视为“未测试”，不能从代码接入状态推断为兼容。完整声明与依赖见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
<!-- catalog-coverage:end -->`;
  const expected = replaceGeneratedBlock(source, '<!-- catalog-coverage:start -->', '<!-- catalog-coverage:end -->', block);
  if (source !== expected) {
    if (writeMode) fs.writeFileSync(filePath, expected);
    else errors.push(`${fileName}: catalog coverage declaration is stale; run this script with --write.`);
  }
}

if (componentDocs.length !== 45) {
  errors.push(`Expected 45 routed component documents, found ${componentDocs.length}.`);
}
if (matrixRows.size !== 44) {
  errors.push(`Expected 44 capability matrix rows, found ${matrixRows.size}.`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Remote desktop docs contract ok: ${componentDocs.length} component docs and 44 app capabilities are current.`);
