# 远程搜索器功能设计与开发计划

## 定位

远程搜索器用于在远程主机上按文件名、内容、类型、大小和时间搜索文件。它补充文件管理器，解决“我知道一点线索但不知道文件在哪”的场景。

## 目标用户场景

- 在项目目录里搜索包含某个关键字的文件。
- 查找最近修改的配置文件。
- 找出某个扩展名的文件。
- 按大小范围查找文件。
- 从搜索结果直接打开文件或定位目录。

## 首版功能范围

- 搜索模式：
  - 文件名搜索。
  - 内容搜索。
  - 扩展名筛选。
  - 大小和修改时间筛选。
- 搜索范围：
  - 起始目录。
  - 是否递归。
  - 排除目录，例如 `node_modules`、`.git`。
- 结果操作：
  - 打开记事本。
  - 定位文件管理器。
  - 复制路径。

## 交互设计

顶部是搜索表单，主区域是结果表格：

- 搜索表单：路径、关键字、模式、文件类型、排除目录。
- 结果表格：文件名、路径、大小、修改时间、匹配摘要。
- 右侧预览：内容搜索时展示匹配行上下文。

搜索可能耗时，必须显示运行状态和结果数量限制提示。

## 数据模型

```ts
interface RemoteSearchQuery {
  rootPath: string;
  keyword: string;
  mode: 'name' | 'content';
  extensions: string[];
  excludes: string[];
  maxResults: number;
}

interface RemoteSearchResult {
  path: string;
  name: string;
  size?: number;
  modifiedAt?: string;
  matches?: { line: number; text: string }[];
}
```

## 远程命令设计

文件名搜索：

- 优先 `find <root> -iname '*keyword*' -type f`。
- 如果安装 `fd`，后续可用 `fd` 加速。

内容搜索：

- 优先 `rg --line-number --no-heading --color never <keyword> <root>`。
- 回退 `grep -RIn -- <keyword> <root>`。

排除：

- `rg --glob '!node_modules/**'`。
- find 使用 `-path` prune。

结果限制：

- Linux 使用 `head -n <max>`。
- Windows 使用 PowerShell `Get-ChildItem` 和 `Select-String`。

## IPC 与代码落点

首版复用 `runCommand`。长时间搜索需要取消能力，后续可做流式任务 IPC。与文件管理器和记事本联动需要 `RemoteDesktopShell` payload 支持。

建议文件：

- `src/components/remote-desktop/RemoteSearcher.tsx`
- `src/components/remote-desktop/searchCommandBuilders.ts`
- `src/styles/remote-desktop/_remote-searcher.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现文件名搜索。
2. 实现内容搜索，优先 rg 回退 grep。
3. 实现结果表格和匹配预览。
4. 实现扩展名和排除目录。
5. 实现打开文件、定位目录、复制路径。
6. 实现 Windows 基础搜索。
7. 增加结果限制和耗时提示。

## 验收标准

- 能在指定目录搜索文件名。
- 能搜索文本内容并显示行号。
- 大目录搜索有结果上限，不会无限刷屏。
- 搜索结果能打开记事本或文件管理器。
- 特殊字符关键字不会造成命令注入。

## 后续增强

- 搜索任务取消。
- 保存常用搜索。
- 文件内容预览。
- 二次筛选。
- 与日志查看器共享搜索体验。
