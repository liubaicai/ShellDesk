# 备份/同步面板功能设计与开发计划

## 定位

备份/同步面板用于把常见 rsync、scp、tar 备份任务图形化。它强调可重复执行、结果可追踪和低误操作风险。

## 目标用户场景

- 把远程目录打包备份到另一个目录。
- 使用 rsync 同步项目目录到备份目录。
- 备份数据库导出文件或配置目录。
- 查看每次备份耗时、体积和结果。
- 复制备份命令用于手动执行。

## 首版功能范围

- 任务类型：
  - tar 打包。
  - rsync 本机路径同步。
  - scp 跨主机同步作为后续。
- 配置：
  - 源路径、目标路径、排除规则、压缩格式。
  - 是否保留时间戳。
- 执行：
  - 运行备份。
  - 展示命令输出。
  - 当前会话历史。
- 安全：
  - 目标路径覆盖提示。
  - 删除同步选项默认关闭。

## 交互设计

左侧为备份任务列表，右侧为任务详情和执行记录：

- 任务配置区：源、目标、排除、模式。
- 预览区：将执行的命令。
- 执行结果区：状态、耗时、输出。

执行前必须确认，尤其是 rsync 带 `--delete` 时要强提示。

## 数据模型

```ts
type BackupTaskKind = 'tar' | 'rsync';

interface BackupTask {
  id: string;
  name: string;
  kind: BackupTaskKind;
  sourcePath: string;
  targetPath: string;
  excludes: string[];
  compression?: 'gz' | 'xz' | 'none';
  deleteExtra?: boolean;
}

interface BackupRunResult {
  taskId: string;
  status: 'success' | 'failed';
  startedAt: string;
  finishedAt: string;
  stdout: string;
  stderr: string;
  code: number;
}
```

## 远程命令设计

tar：

- `tar -czf <target> -C <parent> <name>`。
- 排除：`--exclude=<pattern>`。

rsync：

- `rsync -a --info=progress2 <source> <target>`。
- 排除：`--exclude <pattern>`。
- 删除：`--delete` 仅用户显式开启。

空间检查：

- 备份前可用 `df -P <target-parent>`。
- 源目录大小可用 `du -sh <source>`。

## IPC 与代码落点

首版复用 `runCommand`，但备份任务可能长时间运行。第一版可先等待命令完成，后续用流式命令 IPC 提供实时进度。

建议文件：

- `src/components/remote-desktop/RemoteBackupSync.tsx`
- `src/components/remote-desktop/backupCommandBuilders.ts`
- `src/styles/remote-desktop/_backup-sync.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现任务配置表单和命令预览。
2. 实现 tar 备份。
3. 实现 rsync 同步。
4. 实现排除规则和危险选项确认。
5. 实现执行记录和输出展示。
6. 增加文件管理器路径选择。
7. 评估配置持久化位置。

## 验收标准

- 能创建 tar 备份并在目标路径生成文件。
- 能执行 rsync 同步。
- `--delete` 默认关闭且开启前强确认。
- 命令失败时展示 stderr。
- 路径参数安全转义。

## 后续增强

- 实时进度。
- 定时备份。
- 远程到本地下载备份。
- 备份清理策略。
- 备份完整性校验。
