# 防火墙管理器功能设计与开发计划

## 定位

防火墙管理器用于查看和维护远程主机防火墙规则。它优先覆盖 Linux `ufw`、`firewalld`，兼容 Windows Firewall，帮助用户安全地开放或关闭端口。

## 目标用户场景

- 查看当前防火墙是否启用。
- 开放一个 TCP/UDP 端口。
- 删除不需要的开放规则。
- 查看 firewalld zone 和服务。
- 检查某个端口是否被规则允许。

## 首版功能范围

- 自动检测：
  - ufw。
  - firewalld。
  - Windows Firewall。
- 状态展示：
  - 防火墙启用状态。
  - 默认策略。
  - 当前规则列表。
- 规则操作：
  - 新增允许端口。
  - 删除规则。
  - reload。
- 安全提示：
  - 开放 `0.0.0.0/0` 或高风险端口时提示。

## 交互设计

顶部展示当前防火墙后端和状态。主体分为：

- 规则列表：方向、协议、端口、来源、动作、备注。
- 新增规则表单：协议、端口、来源、动作。
- 原始输出标签页：保留命令输出用于排查。

删除规则和开放端口必须确认。规则列表中每一行提供复制和删除按钮。

## 数据模型

```ts
type FirewallBackend = 'ufw' | 'firewalld' | 'windows' | 'unknown';

interface FirewallRule {
  id: string;
  action: 'allow' | 'deny' | 'reject' | 'unknown';
  protocol?: 'tcp' | 'udp' | 'any';
  port?: string;
  source?: string;
  target?: string;
  raw: string;
}
```

## 远程命令设计

ufw：

- 状态：`sudo ufw status verbose`。
- 新增：`sudo ufw allow from <source> to any port <port> proto <proto>`。
- 删除：`sudo ufw delete <rule>`，首版可用编号删除但要先刷新编号。

firewalld：

- 状态：`sudo firewall-cmd --state`。
- 规则：`sudo firewall-cmd --list-all --zone=<zone>`。
- 新增端口：`sudo firewall-cmd --add-port=<port>/<proto> --permanent`。
- 删除端口：`sudo firewall-cmd --remove-port=<port>/<proto> --permanent`。
- reload：`sudo firewall-cmd --reload`。

Windows：

- 列表：`Get-NetFirewallRule` 与 `Get-NetFirewallPortFilter`。
- 新增：`New-NetFirewallRule`。
- 删除：`Remove-NetFirewallRule`。

## IPC 与代码落点

首版复用 `runCommand`。防火墙操作常涉及 sudo，建议操作按钮旁提供“复制命令”和“在终端中执行”路径。直接执行适用于免密 sudo。

建议文件：

- `src/components/remote-desktop/RemoteFirewallManager.tsx`
- `src/components/remote-desktop/firewallProviders.ts`
- `src/styles/remote-desktop/_firewall-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现后端检测。
2. 实现 ufw 状态和规则解析。
3. 实现 firewalld 状态和端口规则解析。
4. 实现新增/删除端口规则。
5. 实现 Windows Firewall 基础列表。
6. 增加风险提示和确认弹窗。
7. 增加原始输出和错误提示。

## 验收标准

- Ubuntu ufw 主机能显示状态和规则。
- firewalld 主机能显示 zone 和端口。
- 新增规则前必须确认。
- 命令失败时显示 stderr。
- 无防火墙工具时给出可理解提示。

## 后续增强

- rich rule 编辑。
- zone 管理。
- 规则导入导出。
- 与端口管理器联动。
- 防火墙变更审计记录。
