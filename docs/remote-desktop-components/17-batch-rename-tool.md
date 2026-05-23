# 批量重命名工具功能设计与开发计划

## 定位

批量重命名工具用于对远程目录中的文件批量生成新名称并执行重命名。它强调预览优先，避免不可逆误操作。

## 目标用户场景

- 批量替换文件名中的字符串。
- 为文件添加前缀/后缀。
- 按序号重命名。
- 修改大小写。
- 对日志、图片、备份文件做整理。

## 首版功能范围

- 输入：
  - 目标目录。
  - 文件筛选：扩展名、包含文本。
- 规则：
  - 查找替换。
  - 添加前缀/后缀。
  - 序号。
  - 大小写转换。
- 预览：
  - 原文件名、新文件名。
  - 冲突检测。
  - 非法名称提示。
- 执行：
  - 按预览执行 rename。
  - 当前会话撤销计划，首版可提供反向命令预览。

## 交互设计

左侧规则配置，右侧预览表：

- 顶部：目录选择、刷新文件。
- 左侧：规则编辑器。
- 右侧：重命名预览，冲突行高亮。
- 底部：执行按钮、复制重命名脚本。

没有预览或存在冲突时禁止执行。

## 数据模型

```ts
interface RenameRule {
  replaceFrom?: string;
  replaceTo?: string;
  prefix?: string;
  suffix?: string;
  numbering?: { enabled: boolean; start: number; padding: number };
  caseMode?: 'none' | 'lower' | 'upper';
}

interface RenamePreviewEntry {
  oldPath: string;
  newPath: string;
  oldName: string;
  newName: string;
  conflict: boolean;
}
```

## 远程命令设计

文件列表：

- 复用 `listDirectory`。

执行：

- 对每个条目调用现有 `renamePath` IPC，避免拼接批量 shell。
- 执行顺序需要处理冲突，首版禁止任何冲突或相互覆盖。

撤销：

- 保存 `newPath -> oldPath` 反向列表。
- 首版仅展示，不自动持久化。

## IPC 与代码落点

复用 `listDirectory`、`renamePath`。从文件管理器传入目录路径。

文件建议：

- `src/components/remote-desktop/RemoteBatchRename.tsx`
- `src/components/remote-desktop/batchRenameUtils.ts`
- `src/styles/remote-desktop/_batch-rename.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现目录加载和文件筛选。
2. 实现查找替换、前缀后缀规则。
3. 实现序号和大小写规则。
4. 实现预览和冲突检测。
5. 实现逐项 rename 执行。
6. 实现执行结果和反向撤销计划。
7. 从文件管理器接入入口。

## 验收标准

- 能预览批量重命名结果。
- 冲突时禁止执行。
- 执行后远程文件名变化正确。
- 部分失败时能展示已成功和失败项。
- 不通过 shell 拼接执行批量 rename。

## 后续增强

- 持久化撤销。
- 正则重命名。
- 多规则流水线。
- 文件内容元信息命名。
