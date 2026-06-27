# Apache 管理器组件说明

> 当前状态：已接入远程桌面（appKey: `apache-manager`），实现入口为 `src/components/remote-desktop/RemoteApacheManager.tsx`。

## 定位

Apache 管理器用于维护远程主机上的 Apache/httpd 虚拟主机、站点启用状态、模板配置、配置测试和 reload。它和 Nginx、Caddy 拆成独立组件，以适配 Apache 在 Debian、RHEL 等发行版上的目录布局差异。

## 当前实现范围

- 检测 `apache2` / `httpd` 安装、版本、主配置目录和服务名。
- 扫描常见 `sites-available`、`sites-enabled`、`conf.d` 等目录。
- 解析 VirtualHost、ServerName、ServerAlias、DocumentRoot、ProxyPass、SSLCertificateFile、日志路径和 listen 端口。
- 支持站点搜索、启用/禁用、SSL/非 SSL 过滤。
- 提供站点概览、源码编辑、全局配置和模板创建。
- 内置 HTTP、反向代理、SSL、PHP 等常见虚拟主机模板，并校验模板变量。
- 支持启用、禁用、删除虚拟主机、写入配置、配置测试和 reload。
- 删除和模板写入包含备份、确认和失败回滚提示。

## 代码落点

- `src/components/remote-desktop/RemoteApacheManager.tsx`
- `src/components/remote-desktop/apacheManagerProviders.ts`
- `src/components/remote-desktop/apacheManagerTemplates.ts`
- `src/components/remote-desktop/apacheManagerTypes.ts`
- `src/components/remote-desktop/apacheParser.ts`
- `src/styles/remote-desktop/_apache-manager.scss`
- `src/assets/desktop-icons/apache-manager.png`
- `src/RemoteDesktopShell.tsx`

## 设计边界

- Apache 模块生态很大，当前只解析常见虚拟主机字段，不做完整 AST。
- 启用/禁用操作按发行版布局分支处理，未知布局会保守降级。
- 修改服务配置前必须保留确认弹窗和备份输出。

## 后续增强

- 更完整的 include 关系展示。
- 模块启用/禁用入口。
- 与证书管理器、日志查看器和防火墙管理器联动。
