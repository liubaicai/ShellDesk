# 命令收藏夹 / Snippet 面板功能设计与开发计划

## 定位

命令收藏夹用于保存和复用常用远程命令。它将零散命令模板结构化，支持变量填充、分类和一键执行，适合高频运维操作。

## 目标用户场景

- 保存常用排障命令。
- 为服务名、路径、端口等变量填值后执行。
- 按连接或全局共享命令模板。
- 将执行结果复制或保存到当前会话。
- 避免每次手写复杂命令。

## 首版功能范围

- Snippet 管理：
  - 新增、编辑、删除。
  - 分类、标签。
  - 全局和当前连接两种作用域。
- 变量：
  - 使用 `{service}`、`{path}`、`{port}` 格式。
  - 执行前生成表单。
- 执行：
  - 预览最终命令。
  - 确认后执行。
  - 展示 stdout/stderr。
- 模板库：
  - 系统状态、日志、网络、Docker、Git 常用命令。

## 交互设计

界面分为：

- 左侧分类和 snippet 列表。
- 右侧详情：说明、命令模板、变量表单、执行结果。
- 顶部：搜索、作用域切换、新建按钮。

危险命令可以由用户标记为“执行前强确认”。模板中若包含 `rm`、`reboot`、`shutdown` 等关键词，默认提示风险。

## 数据模型

```ts
interface CommandSnippet {
  id: string;
  scope: 'global' | 'connection';
  name: string;
  description?: string;
  category: string;
  commandTemplate: string;
  variables: CommandSnippetVariable[];
  requireConfirmation: boolean;
}

interface CommandSnippetVariable {
  name: string;
  label: string;
  defaultValue?: string;
  required: boolean;
}
```

## 命令与安全设计

Snippet 本质是用户自定义命令。执行前必须展示替换后的最终命令。变量值进行 shell 参数转义有两种模式：

- 文本替换模式：高级用户使用，风险提示更强。
- 参数模式：变量作为单独参数转义，推荐默认。

首版可以采用文本替换，但执行前明确展示最终命令并要求确认。

## IPC 与代码落点

复用 `runCommand`。持久化可以扩展 vault settings，或新增独立 vault collection。考虑当前 vault 已集中管理 hosts、keys、settings、bookmarks，建议新增：

- `commandSnippets: ShellDeskCommandSnippetCollection[]`

同步修改：

- `electron/main.cjs`
- `electron/preload.cjs`
- `src/vite-env.d.ts`
- 前端 vault 读写处

若先做非持久化 MVP，可只保存在组件状态。

## 代码落点

- `src/components/remote-desktop/RemoteCommandSnippets.tsx`
- `src/components/remote-desktop/commandSnippetPresets.ts`
- `src/styles/remote-desktop/_command-snippets.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现内置模板和列表展示。
2. 实现变量识别和执行前表单。
3. 实现命令预览、确认和执行。
4. 实现新增/编辑/删除。
5. 增加当前会话内保存。
6. 设计并接入持久化。
7. 增加危险命令提示。

## 验收标准

- 能从模板执行一条带变量命令。
- 执行前能看到最终命令。
- stdout/stderr 展示完整。
- 新建 snippet 后能在当前窗口复用。
- 危险命令有确认提示。

## 后续增强

- 团队模板导入导出。
- 命令执行历史。
- 与任务仪表盘共享 snippet。
- 变量类型：路径、端口、服务名。
