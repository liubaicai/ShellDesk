# Hosts / DNS 工具功能设计与开发计划

## 定位

Hosts / DNS 工具专注远程主机的 hosts 文件管理和 DNS 解析诊断。它比系统设置中的 hosts 功能更专门，覆盖解析链路检查、DNS 服务器测试和解析结果对比。

## 目标用户场景

- 查看和编辑 `/etc/hosts` 或 Windows hosts 文件。
- 查询域名解析结果。
- 对比不同 DNS 服务器返回。
- 检查某个域名最终访问 IP。
- 诊断服务解析异常。

## 首版功能范围

- Hosts：
  - 读取、编辑、保存。
  - 表格视图和原文视图。
  - 保存前 diff。
- DNS 查询：
  - 当前系统解析。
  - 指定 DNS 服务器解析。
  - A、AAAA、CNAME、MX、TXT。
- 诊断：
  - 显示 `/etc/resolv.conf`。
  - Windows 显示 DNS Client 配置。

## 交互设计

顶部 tabs：

- Hosts 编辑
- DNS 查询
- 解析配置

Hosts 编辑支持表格添加 IP/主机名，也保留原文视图。DNS 查询结果按记录类型分组。

## 数据模型

```ts
interface HostsEntry {
  enabled: boolean;
  address: string;
  names: string[];
  comment?: string;
  raw: string;
}

interface DnsQueryResult {
  server?: string;
  recordType: string;
  records: string[];
  raw: string;
}
```

## 远程命令设计

Hosts 路径：

- Linux：`/etc/hosts`。
- Windows：`C:\Windows\System32\drivers\etc\hosts`。

DNS：

- 优先 `dig <domain> <type>`。
- 指定服务器：`dig @<server> <domain> <type>`。
- 回退 `nslookup`。
- Windows：`Resolve-DnsName`。

配置：

- Linux：读取 `/etc/resolv.conf`，可选 `resolvectl status`。
- Windows：`Get-DnsClientServerAddress`。

## IPC 与代码落点

复用 `readFile`、`writeFile`、`runCommand`。Windows hosts 当前设置组件已有类似逻辑，可复用或抽取。

文件建议：

- `src/components/remote-desktop/RemoteHostsDnsTool.tsx`
- `src/components/remote-desktop/hostsDnsUtils.ts`
- `src/styles/remote-desktop/_hosts-dns.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现 hosts 读取和解析。
2. 实现表格编辑和原文视图。
3. 实现保存前 diff。
4. 实现 DNS 查询。
5. 实现指定 DNS 服务器对比。
6. 实现解析配置查看。
7. 兼容 Windows hosts 路径。

## 验收标准

- Linux 能读取和保存 `/etc/hosts`。
- Windows 能读取 hosts 文件。
- DNS 查询能显示 A/CNAME 等结果。
- 指定 DNS 服务器查询有效。
- 保存 hosts 前显示 diff。

## 后续增强

- DNS 缓存刷新命令。
- hosts 规则分组。
- 域名批量检测。
- 与网络诊断工具联动。
