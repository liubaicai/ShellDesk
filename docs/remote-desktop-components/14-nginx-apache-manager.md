# Nginx / Apache 管理器功能设计与开发计划

## 定位

Nginx / Apache 管理器用于维护远程 Web 服务器配置、站点、证书路径和日志入口。它面向常见站点排障、配置测试和 reload 流程。

## 目标用户场景

- 查看 Nginx 或 Apache 是否安装和运行。
- 查看站点配置文件和启用状态。
- 执行配置测试。
- reload 或 restart Web 服务。
- 快速打开 access/error 日志。
- 查看证书文件路径和过期信息入口。

## 首版功能范围

- 自动检测：
  - nginx。
  - apache2/httpd。
- 站点列表：
  - 配置路径、server_name、listen、root、ssl 证书路径。
  - 启用/可用区分，优先支持 Debian 风格 sites-enabled。
- 配置查看：
  - 只读查看配置。
  - 跳转记事本编辑作为后续或联动。
- 操作：
  - config test。
  - reload。
  - restart。
  - 打开日志查看器。

## 交互设计

界面采用站点列表 + 详情：

- 顶部：Web 服务类型、运行状态、配置测试、reload。
- 左侧：站点列表，按 enabled/available 分类。
- 右侧：server block 摘要、证书路径、日志路径、配置原文。

reload/restart 需要确认。配置测试失败时展示原始错误并禁止提示用户继续 reload。

## 数据模型

```ts
type WebServerKind = 'nginx' | 'apache' | 'unknown';

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

配置解析首版以启发式为主，不追求完整语法 AST。

## IPC 与代码落点

首版复用 `runCommand` 和 `readFile`。打开日志查看器、记事本需要 `RemoteDesktopShell` 支持带 payload 打开其他应用。

建议文件：

- `src/components/remote-desktop/RemoteWebServerManager.tsx`
- `src/components/remote-desktop/webServerParsers.ts`
- `src/styles/remote-desktop/_web-server-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现 Nginx/Apache 检测。
2. 实现 Nginx 站点文件发现和摘要解析。
3. 实现配置查看和测试。
4. 实现 reload/restart。
5. 实现 Apache 基础 vhost 展示。
6. 增加日志和证书跳转入口。
7. 补错误处理、权限提示和主题。

## 验收标准

- Nginx 主机能列出常见站点配置。
- 配置测试成功/失败都能显示结果。
- reload 前必须确认。
- Apache 主机能显示基础 vhost 信息。
- 无权限读取配置时给出明确提示。

## 后续增强

- 配置编辑和变更 diff。
- server block 可视化。
- Let's Encrypt 证书续期入口。
- 与防火墙、证书管理器联动。
