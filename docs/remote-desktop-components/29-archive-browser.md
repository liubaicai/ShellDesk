# 压缩包浏览器功能设计与开发计划

## 定位

压缩包浏览器用于查看远程压缩包内容并执行选择性解压。它避免用户为了看一个文件而完整解压大包。

## 目标用户场景

- 查看 zip、tar、tar.gz 压缩包内容。
- 选择某个文件或目录解压。
- 查看压缩包大小、文件数量、修改时间。
- 从文件管理器双击压缩包打开。
- 解压到当前目录或指定目录。

## 首版功能范围

- 支持格式：
  - zip。
  - tar。
  - tar.gz/tgz。
  - tar.xz 后续。
- 内容列表：
  - 路径、类型、大小、修改时间。
  - 搜索路径。
- 操作：
  - 全部解压。
  - 选择性解压。
  - 复制内部路径。

## 交互设计

顶部为压缩包路径和目标解压目录。主体为树/表混合视图：

- 左侧目录树。
- 右侧文件列表。
- 底部操作栏：解压选中、全部解压、打开目标目录。

解压覆盖已有文件时显示确认提示。

## 数据模型

```ts
interface ArchiveEntry {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'link' | 'unknown';
  size?: number;
  modifiedAt?: string;
}

interface ArchiveInfo {
  path: string;
  format: 'zip' | 'tar' | 'tar.gz' | 'unknown';
  entries: ArchiveEntry[];
}
```

## 远程命令设计

列表：

- zip：`unzip -l <archive>`。
- tar：`tar -tvf <archive>`。
- tar.gz：`tar -tzvf <archive>`。

解压：

- zip 全部：`unzip <archive> -d <dest>`。
- zip 单项：`unzip <archive> <entry> -d <dest>`。
- tar 全部：`tar -xf <archive> -C <dest>`。
- tar 单项：`tar -xf <archive> -C <dest> <entry>`。

格式识别：

- 按扩展名初判。
- 可选 `file <archive>` 辅助识别。

## IPC 与代码落点

首版复用 `runCommand`。与文件管理器联动：压缩包扩展名右键“浏览压缩包”。

文件建议：

- `src/components/remote-desktop/RemoteArchiveBrowser.tsx`
- `src/components/remote-desktop/archiveUtils.ts`
- `src/styles/remote-desktop/_archive-browser.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现压缩包路径载入和格式识别。
2. 实现 zip 列表解析。
3. 实现 tar/tar.gz 列表解析。
4. 实现搜索和目录树。
5. 实现全部解压和选择性解压。
6. 接入文件管理器打开入口。
7. 增加覆盖提示和错误处理。

## 验收标准

- 能查看 zip 内容。
- 能查看 tar.gz 内容。
- 能选择单个条目解压。
- 工具不存在时有明确提示。
- 压缩包路径和内部路径安全处理。

## 后续增强

- 预览文本文件。
- 创建压缩包。
- tar.xz、7z 支持。
- 解压进度。
