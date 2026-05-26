# iptables 管理器功能设计与开发记录

## 定位

iptables 管理器是独立于通用防火墙管理器的 Linux 规则链工具，用于查看和维护远程主机上的 `iptables` / `ip6tables` 运行时规则。它面向已经直接使用 netfilter/iptables 的主机，不和 `ufw`、`firewalld`、Windows Firewall 的抽象规则混在一起。

该组件默认只处理运行时规则。新增和删除规则不会自动写入发行版持久化配置，避免误碰目标系统已有的 `iptables-save`、`netfilter-persistent`、发行版脚本或配置管理流程。

## 目标用户场景

- 查看 IPv4 / IPv6 当前规则链。
- 按地址族、表、链过滤规则。
- 查看 `filter` / `nat` / `mangle` / `raw` / `security` 表中的规则。
- 查看默认策略和原始 `iptables-save` 输出。
- 新增一条常见 ACCEPT / DROP / REJECT 规则。
- 删除当前链内指定序号的规则。
- 复制规则摘要或待执行命令，用于在终端中手动确认执行。

## 首版功能范围

- 自动检测：
  - `iptables` 是否存在。
  - `ip6tables` 是否存在。
  - `iptables -V` / `ip6tables -V` 版本信息。
  - 是否可能运行在 `nf_tables` 兼容层。
- 状态读取：
  - 优先读取 `iptables-save` / `ip6tables-save`。
  - 不可用时回退到 `iptables -S` / `ip6tables -S`。
  - 优先尝试 `sudo -n`，再回退普通读取并展示权限提示。
- 规则展示：
  - 规则列表。
  - 默认策略。
  - 原始输出。
  - 地址族、表、链过滤。
- 规则操作：
  - 新增规则。
  - 删除规则。
  - 复制规则详情。
  - 复制待执行命令。
- 风险提示：
  - 任意来源。
  - 敏感端口。
  - 空端口或影响整条链的规则。
  - nftables 兼容层冲突提示。
  - sudo 权限不足提示。

## 交互设计

组件采用左侧表单、右侧规则视图的工具型布局：

- 顶部：状态摘要、刷新按钮、默认策略摘要、刷新时间。
- 左侧：新增规则表单和选中规则详情。
- 右侧：
  - 规则 tab：表格化展示规则。
  - 默认策略 tab：展示每个表/链的默认策略。
  - 原始输出 tab：保留远程命令原始输出，便于排查解析缺口。

所有修改操作都先生成命令并进入确认弹窗。确认弹窗展示完整命令，提供取消、复制命令和执行操作。高风险命令使用危险态样式。

## 数据模型

```ts
export type IptablesFamily = 'ipv4' | 'ipv6';
export type IptablesTable = 'filter' | 'nat' | 'mangle' | 'raw' | 'security';

export interface IptablesPolicy {
  family: IptablesFamily;
  table: string;
  chain: string;
  policy: string;
  counters?: string;
}

export interface IptablesRule {
  id: string;
  family: IptablesFamily;
  table: string;
  chain: string;
  index: number;
  target: string;
  protocol?: string;
  source?: string;
  destination?: string;
  destinationPort?: string;
  sourcePort?: string;
  inInterface?: string;
  outInterface?: string;
  state?: string;
  comment?: string;
  spec: string;
  raw: string;
}

export interface IptablesSnapshot {
  available: boolean;
  versions: string[];
  status: string;
  notice: string;
  policies: IptablesPolicy[];
  rules: IptablesRule[];
  rawOutput: string;
}
```

## 远程命令设计

读取状态：

- 检测 IPv4：`command -v iptables`。
- 读取版本：`iptables -V`。
- 读取规则：`sudo -n iptables-save 2>&1 || iptables-save 2>&1 || true`。
- 回退读取：`sudo -n iptables -S 2>&1 || iptables -S 2>&1 || true`。
- IPv6 同理使用 `ip6tables` / `ip6tables-save`。

新增规则：

- IPv4 使用 `iptables`，IPv6 使用 `ip6tables`。
- 通过 `-t <table>` 指定表。
- 插入链首使用 `-I <chain> 1`。
- 追加链尾使用 `-A <chain>`。
- TCP / UDP 端口规则添加 `-p <proto> -m <proto> --dport <port>`。
- 来源和目标地址分别映射到 `-s` / `-d`。
- 默认追加 `-m comment --comment <comment>`，便于识别 ShellDesk 生成的规则。

删除规则：

- 使用当前刷新结果里的链内序号：
  - `sudo -n iptables -t <table> -D <chain> <index>`
  - `sudo -n ip6tables -t <table> -D <chain> <index>`
- 如果远程主机规则可能被其他会话修改，应先刷新再删除，避免序号漂移。

## IPC 与代码落点

首版复用 `window.guiSSH.connections.runCommand`，不新增主进程 IPC。

已落地文件：

- `src/components/remote-desktop/RemoteIptablesManager.tsx`
- `src/components/remote-desktop/iptablesProviders.ts`
- `src/styles/remote-desktop/_iptables-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`
- `src/vite-env.d.ts`
- `electron/main/constants.cjs`

## 已实现状态

1. 已作为独立远程桌面应用注册，应用 key 为 `iptables-manager`。
2. 已支持 Linux / Unix 主机，Windows 主机展示不支持提示。
3. 已支持 IPv4 / IPv6 规则读取。
4. 已支持 `iptables-save` 输出解析。
5. 已支持默认策略、规则列表、原始输出三类视图。
6. 已支持按地址族、表、链过滤。
7. 已支持新增 ACCEPT / DROP / REJECT 规则。
8. 已支持按当前链内序号删除规则。
9. 已支持命令确认、复制命令和复制规则。
10. 已支持 sudo 权限不足和 nftables 兼容层提示。

## 验收标准

- Linux 主机能显示 `iptables` / `ip6tables` 版本和规则摘要。
- `iptables-save` 输出能解析出表、链、默认策略和规则。
- 规则表能按地址族、表、链过滤。
- 新增规则前必须展示完整命令并要求确认。
- 删除规则使用刷新结果中的链内序号，并在确认文案中提示序号风险。
- 当前用户缺少 sudo 权限时显示可理解的提示。
- `nf_tables` 兼容层主机显示冲突提醒，提示检查 nft/firewalld/ufw 规则。
- Windows 主机显示 iptables 不适用提示。

## 边界与风险

- 不自动持久化规则，重启后是否保留取决于目标系统配置。
- 不直接管理 `nft` 原生规则。
- 不直接修改 `ufw` / `firewalld` 抽象配置。
- 删除规则依赖链内序号，远程规则并发变化时需要刷新。
- 复杂 match 模块只保留原始规则，首版只解析常用字段。
- 修改防火墙可能导致 SSH 连接中断，因此高风险规则必须确认。

## 后续增强

- 增加“持久化保存”引导，按发行版检测 `netfilter-persistent`、`iptables-save` 路径或系统服务。
- 增加 nftables 原生规则查看器，并明确与 iptables 兼容层的关系。
- 支持更多 match 模块解析，例如 multiport、conntrack、limit、owner。
- 支持策略修改，但必须加入强确认和回滚提示。
- 支持规则导入导出和变更 diff。
- 与端口管理器联动，从监听端口生成候选规则。
- 与终端联动，提供“在终端中执行命令”入口。
