# 安全巡检面板功能设计与开发计划

## 定位

安全巡检面板用于对远程主机做轻量安全检查，聚合 SSH 配置、用户权限、开放端口、登录失败、文件权限等常见风险。它不是合规扫描器，而是 ShellDesk 内置的日常安全体检工具。

## 目标用户场景

- 快速检查 SSH 是否允许 root 登录或密码登录。
- 查看 sudo 用户和可疑高权限账号。
- 查看最近登录失败记录。
- 检查异常开放端口。
- 发现高风险文件权限，例如 world-writable 目录。
- 生成一份可复制的巡检摘要。

## 首版功能范围

- 检查项：
  - SSH 配置风险。
  - sudo/admin 用户。
  - 最近登录失败。
  - 开放监听端口摘要。
  - 常见敏感文件权限。
  - 系统更新可用性提示。
- 结果等级：
  - 高、中、低、信息。
- 操作：
  - 运行全部检查。
  - 单项重跑。
  - 复制报告。

首版只做检测，不直接修改安全配置。

## 交互设计

界面采用巡检报告布局：

- 顶部：主机、系统、巡检时间、运行按钮。
- 左侧：检查项列表和风险数量。
- 右侧：选中检查项详情、原始输出、修复建议。

风险项要有明确说明，但避免夸大。修复建议以命令或路径提示为主，不自动执行。

## 数据模型

```ts
type SecuritySeverity = 'high' | 'medium' | 'low' | 'info';

interface SecurityCheckResult {
  id: string;
  title: string;
  severity: SecuritySeverity;
  status: 'passed' | 'warning' | 'failed' | 'unknown';
  summary: string;
  details: string[];
  rawOutput?: string;
  suggestions: string[];
}
```

## 远程命令设计

SSH 配置：

- `sshd -T`，回退读取 `/etc/ssh/sshd_config`。
- 关注 `permitrootlogin`、`passwordauthentication`、`pubkeyauthentication`、`port`。

用户权限：

- Linux：`getent passwd`、`getent group sudo`、`getent group wheel`。
- Windows：`Get-LocalGroupMember Administrators`。

登录失败：

- Linux：`lastb -n 20`，回退 `journalctl _SYSTEMD_UNIT=ssh.service`。
- Windows：Event Log 安全日志可作为后续。

端口：

- 复用端口管理器 `ss -tunlp` 解析。

文件权限：

- `/etc/passwd`、`/etc/shadow`、`~/.ssh/authorized_keys` 的 `stat`。

## IPC 与代码落点

首版复用 `runCommand`。建议把检查项实现成独立 registry，便于后续扩展。

文件建议：

- `src/components/remote-desktop/RemoteSecurityAudit.tsx`
- `src/components/remote-desktop/securityChecks.ts`
- `src/styles/remote-desktop/_security-audit.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现检查项 registry 和报告 UI。
2. 实现 SSH 配置检查。
3. 实现 sudo/admin 用户检查。
4. 实现登录失败和端口摘要。
5. 实现敏感文件权限检查。
6. 实现复制报告。
7. 增加 Windows 基础检查。

## 验收标准

- Linux 主机能运行全部巡检并生成结果。
- 每个风险项都有等级、说明和建议。
- 命令失败不会中断全部巡检。
- 报告可复制为 Markdown 文本。
- 不会自动修改远程安全配置。

## 后续增强

- CIS 风格规则集。
- 自定义巡检项。
- 巡检历史对比。
- 一键跳转端口、服务、日志组件。
