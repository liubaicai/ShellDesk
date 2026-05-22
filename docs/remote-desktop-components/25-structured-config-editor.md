# JSON / YAML / TOML 编辑器功能设计与开发计划

## 定位

JSON / YAML / TOML 编辑器用于安全编辑远程结构化配置文件。它强调格式校验、格式化、树形查看和保存前差异，补充通用记事本的配置文件体验。

## 目标用户场景

- 编辑 JSON 配置并格式化。
- 修改 YAML/TOML 配置前做语法校验。
- 折叠查看大型配置。
- 保存前查看 diff。
- 从文件管理器直接用结构化编辑器打开配置文件。

## 首版功能范围

- 支持格式：
  - JSON 完整解析和格式化。
  - YAML/TOML 首版可做文本编辑和外部命令校验。
- 视图：
  - 文本编辑。
  - 树形只读预览，首版优先 JSON。
- 功能：
  - 格式化。
  - 校验。
  - 保存前 diff。
  - 错误定位。

## 交互设计

顶部为文件路径、格式类型、格式化、校验、保存。主体左右分栏：

- 左侧代码编辑区。
- 右侧结构预览和错误列表。

错误列表点击后定位到行。没有解析器支持时显示“仅文本校验”状态。

## 数据模型

```ts
type StructuredConfigFormat = 'json' | 'yaml' | 'toml';

interface ConfigValidationResult {
  ok: boolean;
  message?: string;
  line?: number;
  column?: number;
}
```

## 解析与校验设计

JSON：

- 使用浏览器内置 `JSON.parse`。
- `JSON.stringify(value, null, 2)` 格式化。

YAML：

- 若不新增依赖，首版调用远程 `python -c` 尝试导入 yaml 不可靠。
- 推荐后续引入轻量依赖，或首版仅提供文本编辑和保存前提示。

TOML：

- 可通过远程 `python -c "import tomllib"` 校验 Python 3.11+。
- 低版本不保证。

## IPC 与代码落点

复用 `readFile`、`writeFile`、`statPath`。如果引入 YAML/TOML 前端解析依赖，需要更新 `package.json`，但首版可先不加依赖，保持项目依赖最小化。

文件建议：

- `src/components/remote-desktop/RemoteStructuredConfigEditor.tsx`
- `src/components/remote-desktop/structuredConfigUtils.ts`
- `src/styles/remote-desktop/_structured-config-editor.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现路径加载和格式识别。
2. 实现 JSON 校验、格式化和树形预览。
3. 实现保存前 diff。
4. 实现 YAML/TOML 文本模式和基础提示。
5. 增加文件管理器打开入口。
6. 增加远程变更冲突提示。
7. 评估是否引入 YAML/TOML 解析依赖。

## 验收标准

- JSON 文件能校验、格式化、保存。
- JSON 语法错误能显示位置。
- YAML/TOML 文件至少能以文本模式打开和保存。
- 保存前能看到 diff。
- 二进制或超大文件有保护提示。

## 后续增强

- YAML/TOML 完整前端解析。
- JSON Schema 校验。
- 树形编辑。
- 配置模板。
