# 证书管理器功能设计与开发计划

## 定位

证书管理器用于查看远程主机上的 TLS 证书文件、域名证书链和过期时间。它帮助用户在 Web 服务维护中提前发现证书过期、链不完整或配置路径错误。

## 目标用户场景

- 查看某个域名当前证书有效期。
- 检查 Nginx/Apache 配置中的证书路径。
- 查看 certbot 管理的证书列表。
- 复制证书摘要。
- 跳转 Web 服务管理器查看引用配置。

## 首版功能范围

- 域名检查：
  - 输入 host:port。
  - 查看证书 subject、issuer、SAN、有效期。
- 文件检查：
  - 输入远程证书路径。
  - 解析 PEM 证书。
- Certbot：
  - `certbot certificates` 摘要。
- 过期提醒：
  - 30 天内过期标记为 warning。
  - 已过期标记为 danger。

## 交互设计

界面分为三个 tab：

- 域名证书
- 证书文件
- Certbot

结果区域使用证书摘要卡和原始输出。SAN 列表较长时可折叠。过期时间使用明确的天数提示。

## 数据模型

```ts
interface CertificateSummary {
  source: 'remote-host' | 'file' | 'certbot';
  subject: string;
  issuer: string;
  serialNumber?: string;
  validFrom?: string;
  validTo?: string;
  daysRemaining?: number;
  san: string[];
  raw: string;
}
```

## 远程命令设计

域名：

- `openssl s_client -connect <host>:<port> -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -text -dates -issuer -subject -serial`

文件：

- `openssl x509 -in <path> -noout -text -dates -issuer -subject -serial`

Certbot：

- `sudo certbot certificates`。

Windows：

- 远程域名检查仍可使用 `openssl`，若不存在则提示。
- Windows 证书存储可作为后续。

## IPC 与代码落点

首版复用 `runCommand`。解析 openssl 输出放到独立工具函数。

文件建议：

- `src/components/remote-desktop/RemoteCertificateManager.tsx`
- `src/components/remote-desktop/certificateParsers.ts`
- `src/styles/remote-desktop/_certificate-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现域名证书检查。
2. 实现 openssl 输出解析。
3. 实现证书文件检查。
4. 实现 certbot 摘要展示。
5. 增加过期等级和复制摘要。
6. 增加 openssl 不存在时提示。
7. 和 Web 服务管理器预留跳转 payload。

## 验收标准

- 能检查 `host:443` 证书信息。
- 能解析有效期和 SAN。
- 已过期或 30 天内过期能明确提示。
- 证书路径不存在时显示错误。
- 原始 openssl 输出可查看。

## 后续增强

- 证书续期命令入口。
- 证书链完整性检查。
- 从 Nginx/Apache 配置自动发现证书。
- 多域名批量检查。
