# 登录会话查看器功能设计与开发计划

## 定位

登录会话查看器用于查看远程主机当前登录用户、历史登录记录和失败登录记录。它帮助用户判断是否有异常会话、谁在使用服务器、最近登录来源是否正常。

## 目标用户场景

- 查看当前在线用户和来源 IP。
- 查看最近登录历史。
- 查看失败登录尝试。
- 复制某个 IP 或登录记录。
- 从异常登录跳转到安全巡检。

## 首版功能范围

- 当前会话：
  - 用户、TTY、来源、登录时间、空闲时间、当前命令。
- 历史登录：
  - 最近 100 条成功登录。
  - 用户、来源、时间、持续时间。
- 失败登录：
  - 最近 100 条失败记录。
- Windows：
  - 当前用户和基础登录事件作为第二阶段。

## 交互设计

顶部 tabs：

- 当前在线
- 登录历史
- 失败登录

每个 tab 使用高密度表格。右侧详情抽屉显示原始记录、来源 IP、可复制字段和相关诊断建议。

失败登录来源 IP 可显示次数聚合，帮助快速识别暴力尝试。

## 数据模型

```ts
interface LoginSessionEntry {
  user: string;
  tty?: string;
  source?: string;
  loginAt?: string;
  idle?: string;
  command?: string;
  raw: string;
}

interface LoginHistoryEntry {
  user: string;
  source?: string;
  startedAt?: string;
  endedAt?: string;
  duration?: string;
  success: boolean;
  raw: string;
}
```

## 远程命令设计

Linux：

- 当前在线：`w -h`，回退 `who`。
- 成功历史：`last -n 100 -F`。
- 失败历史：`lastb -n 100 -F`，可能需要权限。
- SSH 日志回退：`journalctl -u ssh -n 200 --no-pager` 或 `journalctl -u sshd`。

Windows：

- 当前用户：`query user`。
- 登录事件：`Get-WinEvent` 查询安全日志，可能需要权限，后续实现。

## IPC 与代码落点

首版复用 `runCommand`。解析逻辑应独立成工具函数，保留原始行以防不同发行版格式差异。

文件建议：

- `src/components/remote-desktop/RemoteLoginSessions.tsx`
- `src/components/remote-desktop/loginSessionParsers.ts`
- `src/styles/remote-desktop/_login-sessions.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现当前在线用户展示。
2. 实现成功登录历史解析。
3. 实现失败登录历史解析和来源聚合。
4. 增加详情抽屉和复制字段。
5. 增加 SSH 日志回退。
6. 增加 Windows 当前用户基础支持。
7. 补空状态、权限错误提示和主题。

## 验收标准

- Linux 主机能展示当前在线用户。
- 能展示最近成功登录记录。
- 无权限读取失败登录时有明确提示。
- 原始记录可查看。
- 来源 IP 可复制。

## 后续增强

- 登录地理位置标注。
- 异常来源规则。
- 与防火墙管理器联动封禁提示。
- 多主机登录汇总。
