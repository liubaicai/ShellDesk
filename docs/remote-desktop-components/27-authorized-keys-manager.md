# 密钥与授权管理器功能设计与开发计划

## 定位

密钥与授权管理器用于查看和维护远程用户的 SSH `authorized_keys`。它帮助用户理解谁可以登录、每把 key 的注释是什么、是否存在风险选项。

## 目标用户场景

- 查看当前用户 `authorized_keys`。
- 添加一把公钥。
- 禁用或删除旧公钥。
- 查看 key fingerprint 和 comment。
- 检查 root 用户或其他用户的授权文件。

## 首版功能范围

- 当前用户 authorized_keys：
  - 读取、解析、展示。
  - key 类型、fingerprint、comment、options。
- 操作：
  - 添加公钥。
  - 禁用 key，采用注释方式。
  - 删除 key。
  - 保存前 diff。
- 安全检查：
  - 空 comment 提示。
  - options 中高风险项提示。

## 交互设计

列表 + 详情：

- 左侧 key 列表，展示类型、短 fingerprint、comment、启用状态。
- 右侧详情，展示完整公钥、options、comment。
- 顶部：路径、刷新、添加 key。

删除和保存必须确认。禁用优先使用注释，不直接删除，降低误操作风险。

## 数据模型

```ts
interface AuthorizedKeyEntry {
  id: string;
  enabled: boolean;
  options: string[];
  keyType: string;
  publicKey: string;
  comment?: string;
  fingerprint?: string;
  raw: string;
}
```

## 远程命令设计

读取：

- 默认路径：`~/.ssh/authorized_keys`。
- `readFile` 直接读取。

fingerprint：

- 可把 key 写到临时文件后执行 `ssh-keygen -lf <file>`。
- 首版也可前端展示 key 前缀，不计算 fingerprint，后续补。

权限检查：

- `stat -c '%a %U %G %n' ~/.ssh ~/.ssh/authorized_keys`。

保存：

- 使用 `writeFile` 覆盖前先备份当前内容到内存。
- 后续可远程备份为 `authorized_keys.shelldesk.bak.<timestamp>`。

## IPC 与代码落点

复用 `readFile`、`writeFile`、`statPath`、`runCommand`。若要管理其他用户，需要 sudo 和路径权限，作为后续增强。

文件建议：

- `src/components/remote-desktop/RemoteAuthorizedKeys.tsx`
- `src/components/remote-desktop/authorizedKeysUtils.ts`
- `src/styles/remote-desktop/_authorized-keys.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现 authorized_keys 读取和解析。
2. 实现 key 列表和详情。
3. 实现添加 key 表单。
4. 实现禁用、删除和保存前 diff。
5. 实现权限检查。
6. 增加 fingerprint 计算。
7. 补错误状态和主题。

## 验收标准

- 能读取当前用户 authorized_keys。
- 能添加一条公钥并保存。
- 禁用 key 后原 key 内容可恢复。
- 保存前显示 diff。
- 文件不存在时可以创建，但要提示。

## 后续增强

- 管理指定用户。
- 从 ShellDesk 本地密钥库导入公钥。
- 检查弱 key 类型。
- 授权变更历史。
