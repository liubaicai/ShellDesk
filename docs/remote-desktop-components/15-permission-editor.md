# 权限编辑器功能设计与开发计划

## 定位

权限编辑器用于图形化查看和修改远程文件/目录权限，包括 chmod、chown 和基础 ACL。它更适合作为文件管理器的增强入口。

## 目标用户场景

- 查看某个文件的 owner、group、mode。
- 修改可读、可写、可执行权限。
- 递归修改目录权限。
- 修改文件所有者或组。
- 保存前预览将执行的命令。

## 首版功能范围

- 权限查看：
  - 类型、mode、owner、group、mtime。
- chmod：
  - 符号权限复选框。
  - 八进制权限输入。
- chown/chgrp：
  - owner、group 输入。
- 递归：
  - 仅目录可选。
  - 默认关闭，强确认。
- Windows ACL 后续增强。

## 交互设计

从文件管理器右键进入，也可独立输入路径。

界面：

- 顶部路径和刷新。
- 中间权限矩阵：owner/group/others x read/write/execute。
- 下方 owner/group 和递归选项。
- 右侧命令预览。

应用修改前必须确认，递归修改显示高风险提示。

## 数据模型

```ts
interface RemotePermissionInfo {
  path: string;
  type: string;
  mode: number;
  owner: string | number;
  group: string | number;
  modifiedAt?: string;
}

interface PermissionChangeRequest {
  path: string;
  mode?: number;
  owner?: string;
  group?: string;
  recursive: boolean;
}
```

## 远程命令设计

读取：

- Linux：`stat -c '%F\t%a\t%U\t%G\t%Y\t%n' <path>`。
- macOS/BSD 后续适配。
- Windows：PowerShell `Get-Acl` 后续。

修改：

- `chmod <mode> <path>`。
- 递归：`chmod -R <mode> <path>`。
- `chown <owner>:<group> <path>`。
- 递归：`chown -R ...`。

路径必须转义。owner/group 只允许安全字符，或使用严格校验。

## IPC 与代码落点

可复用 `statPath` 和 `runCommand`，但当前 `statPath` 返回 owner/group 可能是数字，Linux 名称需要命令补充。

文件建议：

- `src/components/remote-desktop/RemotePermissionEditor.tsx`
- `src/components/remote-desktop/permissionUtils.ts`
- `src/styles/remote-desktop/_permission-editor.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现路径载入和 stat 展示。
2. 实现权限矩阵与八进制同步。
3. 实现 chmod 命令预览和执行。
4. 实现 owner/group 修改。
5. 实现递归选项和强确认。
6. 从文件管理器接入右键菜单。
7. 补 Windows 只读 ACL 展示。

## 验收标准

- 能查看 Linux 文件权限。
- 修改 mode 后远程 stat 结果变化正确。
- 递归修改必须强确认。
- owner/group 输入非法时阻止执行。
- 文件管理器能传入路径打开。

## 后续增强

- ACL 编辑。
- 批量权限修改。
- 权限模板。
- 修改前后 diff。
