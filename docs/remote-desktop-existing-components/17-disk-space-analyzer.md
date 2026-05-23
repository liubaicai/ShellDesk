# 磁盘空间分析器功能设计与开发计划

## 定位

磁盘空间分析器用于快速定位远程主机磁盘占用来源。它优先解决服务器磁盘爆满时“哪个目录最大、哪些文件能清理”的问题。

## 目标用户场景

- 查看各挂载点空间使用率。
- 扫描某个目录下的子目录大小。
- 找出大文件、旧日志、缓存目录。
- 快速打开文件管理器定位目录。
- 复制清理建议或扫描结果。

## 首版功能范围

- 磁盘概览：
  - 挂载点、文件系统、总量、已用、可用、使用率。
- 目录扫描：
  - 输入或选择起始目录。
  - 展示一级子目录/文件大小。
  - 支持向下钻取。
- 大文件搜索：
  - 指定目录、大小阈值。
  - 展示文件路径、大小、修改时间。
- 操作：
  - 刷新。
  - 在文件管理器中打开目录。
  - 复制路径。

首版不做删除，避免误删风险。删除可以跳转文件管理器完成。

## 交互设计

顶部是磁盘概览条，主体分为：

- 左侧路径导航和挂载点列表。
- 中间目录大小列表，按大小降序。
- 右侧详情/建议区域，展示选中目录、路径、大小、修改时间和可用操作。

大小可视化用横向条，不做复杂图形，保持运维工具风格。

## 数据模型

```ts
interface DiskUsageMount {
  filesystem: string;
  mountPoint: string;
  size: string;
  used: string;
  available: string;
  usePercent: number;
}

interface DirectorySizeEntry {
  path: string;
  name: string;
  type: 'directory' | 'file' | 'unknown';
  sizeBytes?: number;
  sizeText: string;
  modifiedAt?: string;
}
```

## 远程命令设计

Linux：

- 概览：`df -P -h` 和 `df -P`，一个用于展示，一个用于解析字节或块。
- 目录扫描：`du -x -d 1 -B1 <path>`，回退 `du -sk <path>/*`。
- 大文件：`find <path> -type f -size +<n>M -printf '%s\t%TY-%Tm-%Td %TH:%TM\t%p\n'`。

Windows：

- 概览：`Get-PSDrive -PSProvider FileSystem`。
- 目录扫描：PowerShell `Get-ChildItem` 统计 `Length`。
- 大文件：`Get-ChildItem -Recurse -File | Where-Object Length -gt ...`。

扫描必须限制范围和输出数量，避免在根目录深度递归时阻塞过久。首版只做一级扫描。

## IPC 与代码落点

首版复用 `runCommand`。若后续要支持长时间扫描进度，需要新增流式任务 IPC。

为了从扫描结果打开文件管理器，需要 `RemoteDesktopShell` 支持向 `files` 应用传入初始路径。当前文件管理器已有打开文件回调，但未必支持外部初始路径，需要开发时补一个轻量 payload。

首版文件建议：

- `src/components/remote-desktop/RemoteDiskAnalyzer.tsx`
- `src/styles/remote-desktop/_disk-analyzer.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 磁盘概览和挂载点展示。
2. 一级目录扫描和大小排序。
3. 路径输入、面包屑和向下钻取。
4. 大文件搜索。
5. 文件管理器跳转。
6. Windows 兼容。
7. 性能保护：输出数量限制、加载状态、错误提示。

## 验收标准

- Linux 能正确展示 `df` 信息。
- 扫描 `/var`、`/home` 等目录能得到子项大小。
- 无权限目录不会导致整个界面崩溃。
- 大文件搜索有数量限制和清晰提示。
- Windows 主机能展示磁盘概览。

## 后续增强

- 树图或环形图可视化。
- 扫描任务取消。
- 清理建议规则。
- 与日志查看器联动定位大日志。
- 目录扫描缓存。
