# 正则 / 文本处理工具箱功能设计与开发计划

## 定位

正则 / 文本处理工具箱用于把 grep、sed、awk、jq 等常用文本处理命令图形化。它帮助用户分析日志、提取字段、格式化 JSON 和批量转换文本。

## 目标用户场景

- 在一段日志中测试正则。
- 对远程文件执行 grep 并查看匹配。
- 使用 jq 格式化 JSON。
- 生成 sed 替换命令。
- 复制处理结果。

## 首版功能范围

- 输入来源：
  - 手动粘贴文本。
  - 远程文件路径。
- 工具：
  - 正则匹配。
  - grep 文件搜索。
  - sed 替换预览。
  - jq 格式化/查询。
- 输出：
  - 匹配行。
  - 替换预览。
  - 格式化结果。

首版 sed 只做预览，不直接写回文件。

## 交互设计

左侧工具列表，右侧分为输入、规则、输出三块：

- 输入区可切换文本/文件。
- 规则区根据工具变化。
- 输出区支持复制。

错误信息显示在输出区上方，例如正则错误、jq 语法错误。

## 数据模型

```ts
type TextToolKey = 'regex' | 'grep' | 'sed' | 'jq';

interface TextToolRun {
  tool: TextToolKey;
  inputMode: 'text' | 'file';
  inputText?: string;
  filePath?: string;
  pattern?: string;
  replacement?: string;
  output: string;
  error?: string;
}
```

## 命令设计

本地前端可完成：

- 正则匹配。
- 简单替换预览。
- JSON parse/format。

远程命令：

- grep：`grep -nE -- <pattern> <file>`。
- sed 预览：`sed 's/pattern/replacement/g' <file>`，复杂转义风险高，首版谨慎。
- jq：`jq <filter> <file>`。

优先前端处理粘贴文本，远程文件处理用 `readFile` 或 `runCommand`。

## IPC 与代码落点

复用 `readFile` 和 `runCommand`。首版不写回文件，避免破坏性批量替换。

文件建议：

- `src/components/remote-desktop/RemoteTextToolbox.tsx`
- `src/components/remote-desktop/textToolUtils.ts`
- `src/styles/remote-desktop/_text-toolbox.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现文本输入和正则匹配。
2. 实现 JSON 格式化。
3. 实现远程文件读取。
4. 实现 grep 文件搜索。
5. 实现 sed 替换预览。
6. 实现 jq 调用。
7. 增加复制和错误提示。

## 验收标准

- 粘贴文本能进行正则匹配。
- JSON 能格式化或显示解析错误。
- 能对远程文件执行 grep。
- sed 预览不写回远程文件。
- jq 不存在时提示安装。

## 后续增强

- 批量文件处理。
- 写回文件和保存前 diff。
- 常用规则模板。
- 结果导出。
