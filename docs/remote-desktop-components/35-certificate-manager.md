# 证书管理器组件说明

> 当前状态：已接入远程桌面（appKey: `cert-manager`），实现入口为 `src/components/remote-desktop/RemoteCertManager.tsx`。

## 定位

证书管理器用于发现远程主机上的 TLS 证书、查看证书详情、检查过期风险，并管理常见 Certbot 续期流程。它也提供受信任根证书查看和维护入口，帮助用户在 Web 服务、内网 CA 和证书续期问题之间快速定位。

## 当前实现范围

- 站点证书扫描：
  - Linux 主机通过 `openssl` 读取证书文件。
  - 展示 Common Name、SAN、issuer、serial、SHA256 fingerprint、到期时间和风险状态。
  - 支持证书详情和 PEM 内容查看。
- Certbot：
  - 解析 `certbot certificates` 输出。
  - 支持 `certbot renew --dry-run` 和非交互续期。
  - 检测 systemd timer、cron、snap certbot timer 等续期状态。
  - 可创建、启用、禁用、删除 ShellDesk 管理的 Certbot 续期任务，并查看最近日志。
- 受信任根证书：
  - 扫描系统 CA 路径。
  - 查看根证书详情。
  - 支持添加和移除受信任根证书，操作前必须确认。
- 安全交互：
  - 写操作通过 `useSudoCommand` 处理。
  - 删除、续期、添加根证书等操作使用自定义确认弹窗。

## 代码落点

- `src/components/remote-desktop/RemoteCertManager.tsx`
- `src/components/remote-desktop/certManagerProviders.ts`
- `src/styles/remote-desktop/_cert-manager.scss`
- `src/assets/desktop-icons/cert-manager.png`
- `src/RemoteDesktopShell.tsx`

## 设计边界

- Windows 主机当前以不支持提示为主，核心扫描和维护路径优先服务 Linux。
- 不保存证书私钥，不在文档、日志或确认弹窗中展示敏感密钥内容。
- Certbot 续期任务只管理 ShellDesk 创建的 `shelldesk-certbot-renew` timer/cron；系统已有续期任务只做识别和展示。

## 后续增强

- 与 Nginx/Caddy/Apache 管理器联动展示站点证书。
- 支持 ACME 账户信息和失败原因汇总。
- 支持导入证书链完整性检查。
