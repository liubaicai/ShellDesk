# 文件差异比较器功能设计与开发计划

## 定位

文件差异比较器用于比较两个远程文件，或比较远程文件和本地缓存内容。它面向配置文件维护、部署前检查和排障复盘。

## 目标用户场景

- 比较两个 Nginx 配置文件。
- 比较 `.env` 的当前版本和备份版本。
- 查看文件修改前后的差异。
- 从文件管理器选择两个文件并打开 diff。
- 复制差异结果。

## 首版功能范围

- 输入：
  - 左右两个远程文件路径。
  - 支持从文件管理器传入。
- 比较：
  - 行级 diff。
  - 新增、删除、修改高亮。
  - 忽略空白开关。
- 展示：
  - 并排视图。
  - 统一 diff 原文视图。
- 操作：
  - 交换左右。
  - 复制 diff。
  - 在记事本打开任意一侧。

## 交互设计

顶部路径栏包含左右路径输入和选择按钮。主体提供两个标签页：

- 并排差异：适合阅读配置文件。
- Unified Diff：适合复制到 issue 或审查。

文件过大时显示警告，建议用户确认后再加载。

## 数据模型

```ts
interface FileDiffRequest {
  leftPath: string;
  rightPath: string;
  ignoreWhitespace: boolean;
}

interface DiffLine {
  type: 'context' | 'add' | 'delete' | 'change';
  leftLine?: number;
  rightLine?: number;
  text: string;
}
```

## 远程命令设计

首版可以优先使用远程 `diff` 命令：

- `diff -u <left> <right>`。
- 忽略空白：`diff -u -w <left> <right>`。

Windows：

- PowerShell `Compare-Object` 可提供基础能力，但格式不适合完整 diff。
- 更稳妥方式是通过 `readFile` 读取两个文本文件，在前端执行 diff 算法。

推荐首版实现：

- 文件大小小于阈值时使用 `readFile` 拉回前端比较。
- Linux 可额外提供原始 `diff -u` 视图。

## IPC 与代码落点

复用 `readFile` 和 `statPath`。前端需要一个轻量 diff 工具函数，可以自研 LCS 行级 diff，避免新增依赖。

建议文件：

- `src/components/remote-desktop/RemoteFileDiff.tsx`
- `src/components/remote-desktop/diffUtils.ts`
- `src/styles/remote-desktop/_file-diff.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现路径输入和文件加载。
2. 实现文件大小检查。
3. 实现行级 diff 算法。
4. 实现并排视图和 unified 视图。
5. 实现忽略空白、交换左右、复制 diff。
6. 增加文件管理器传入两个文件的入口。
7. 补主题和长文本性能优化。

## 验收标准

- 两个文本文件能显示差异。
- 新增/删除/修改行视觉清晰。
- 大文件有加载保护。
- 二进制文件给出不支持提示。
- 文件路径特殊字符能正常处理。

## 后续增强

- 字符级 diff。
- 三方合并。
- 与记事本保存前 diff 联动。
- 保存 diff 到本地。
