# Nginx / Apache / Caddy 管理器功能设计与开发计划

## 定位

Nginx / Apache / Caddy 管理器用于维护远程 Web 服务器配置、站点、证书路径和日志入口。它面向常见站点排障、配置测试和 reload 流程。

## 目标用户场景

- 查看 Nginx、Apache/httpd 或 Caddy 是否安装和运行。
- 查看站点配置文件和启用状态。
- 用记事本打开站点配置并修改。
- 执行配置测试。
- reload 或 restart Web 服务。
- 快速打开 access/error 日志。
- 查看证书文件路径和过期信息入口。

## 首版功能范围

- 自动检测：
  - nginx。
  - apache2/httpd。
  - caddy。
- 站点列表：
  - 配置路径、server_name、listen、root、ssl 证书路径。
  - 启用/可用区分，优先支持 Debian 风格 sites-enabled。
  - Caddy 支持 Caddyfile 与 `conf.d` 风格配置摘要。
- 配置查看：
  - 只读查看配置。
  - 跳转记事本编辑配置文件。
- 操作：
  - config test。
  - reload。
  - restart。
  - 打开日志查看器。

## 交互设计

界面采用服务类型切换 + 站点列表 + 详情：

- 顶部：Web 服务类型、运行状态、配置测试、reload、restart。
- 左侧：站点列表，按 enabled/available 分类。
- 右侧：server block 摘要、证书路径、日志路径、配置原文和记事本打开入口。

reload/restart 需要确认。配置测试失败时展示原始错误并禁止提示用户继续 reload。

## 数据模型

```ts
type WebServerKind = 'nginx' | 'apache' | 'caddy' | 'unknown';

interface WebSiteConfigSummary {
  id: string;
  kind: WebServerKind;
  enabled: boolean;
  filePath: string;
  serverNames: string[];
  listens: string[];
  root?: string;
  accessLog?: string;
  errorLog?: string;
  certificateFiles: string[];
}
```

## 远程命令设计

检测：

- `command -v nginx`
- `command -v apache2 || command -v httpd`

Nginx：

- 版本：`nginx -v`。
- 配置测试：`sudo nginx -t`。
- 完整配置：`sudo nginx -T`，注意输出可能大。
- reload：`sudo systemctl reload nginx`，回退 `sudo nginx -s reload`。
- 站点文件：`find /etc/nginx/sites-enabled /etc/nginx/conf.d -type f`。

Apache：

- 版本：`apache2 -v` 或 `httpd -v`。
- 配置测试：`sudo apachectl configtest`。
- vhost：`sudo apachectl -S`。
- reload：`sudo systemctl reload apache2` 或 `httpd`。

Caddy：

- 版本：`caddy version`。
- 配置测试：`sudo caddy validate --config /etc/caddy/Caddyfile`。
- reload：`sudo systemctl reload caddy`，回退 `sudo caddy reload --config /etc/caddy/Caddyfile`。
- 站点文件：`/etc/caddy/Caddyfile`、`/etc/caddy/conf.d`、`/usr/local/etc/caddy/Caddyfile`。

配置解析首版以启发式为主，不追求完整语法 AST。Caddy 首版按站点块、`root`、`tls`、`log output file` 等常见指令提取摘要。

## IPC 与代码落点

首版复用 `runCommand`，配置内容由检测命令一次性读取有限行数，避免新增主进程 IPC。配置修改通过 `RemoteDesktopShell` 打开记事本窗口，保存后可回到 Web 服务管理器执行配置测试。

已实现文件：

- `src/components/remote-desktop/RemoteWebServerManager.tsx`
- `src/components/remote-desktop/webServerParsers.ts`
- `src/styles/remote-desktop/_web-server-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`
- `src/assets/desktop-icons/web-server-manager.png`

## 开发计划

1. 已实现 Nginx / Apache / Caddy 检测。
2. 已实现 Nginx 站点文件发现和摘要解析。
3. 已实现配置查看和配置测试。
4. 已实现 reload/restart 确认流程。
5. 已实现 Apache 基础 vhost 展示。
6. 已实现 Caddy Caddyfile 摘要展示。
7. 已实现站点配置跳转记事本编辑。
8. 已补错误处理、权限提示和浅色主题。

## 验收标准

- Nginx 主机能列出常见站点配置。
- 配置测试成功/失败都能显示结果。
- reload 前必须确认。
- Apache 主机能显示基础 vhost 信息。
- Caddy 主机能显示 Caddyfile 站点、root、tls 和日志摘要。
- 站点配置能从列表或配置页打开记事本修改。
- 无权限读取配置时给出明确提示。

## 后续增强

- 配置编辑和变更 diff。
- server block 可视化。
- Let's Encrypt 证书续期入口。
- 与防火墙、证书管理器联动。
