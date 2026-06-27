# Nginx 管理器组件说明

> 当前状态：已接入远程桌面（appKey: `nginx-manager`），实现入口为 `src/components/remote-desktop/RemoteNginxManager.tsx`。文件名保留历史上的 `nginx-apache-caddy` 命名，但实际应用已经拆分为 Nginx、Caddy、Apache 三个独立管理器；Caddy 与 Apache 见 `36-caddy-manager.md`、`37-apache-manager.md`。

## 定位

Nginx 管理器用于维护远程主机上的 Nginx 安装、站点配置、启用状态、模板生成、配置测试和 reload 流程。它面向常见 Web 服务排障和站点变更，避免用户在终端里反复查找 `sites-enabled`、`conf.d`、`nginx -t` 和 reload 命令。

## 当前实现范围

- 自动检测 Nginx 安装、版本、主配置路径和站点目录。
- 扫描站点配置文件，解析 `server` 块、`server_name`、`listen`、`root`、SSL、日志路径和 location 摘要。
- 支持按全部、启用、禁用、SSL、非 SSL 过滤站点，并支持关键字搜索。
- 提供概览、可视化编辑和源码编辑三种视图。
- 内置站点模板，支持静态站点、反向代理、应用服务、SSL、负载均衡和 WebSocket 等常见配置。
- 支持启用、禁用、删除、从模板创建配置，写入前走备份与确认流程。
- 支持 `nginx -t` 配置测试、reload，以及原始输出展示。
- 写操作通过 `useSudoCommand` 处理 sudo 场景，确认弹窗使用自定义模态。

## 代码落点

- `src/components/remote-desktop/RemoteNginxManager.tsx`
- `src/components/remote-desktop/nginxManagerProviders.ts`
- `src/components/remote-desktop/nginxManagerTemplates.ts`
- `src/components/remote-desktop/nginxManagerTypes.ts`
- `src/components/remote-desktop/nginxParser.ts`
- `src/components/remote-desktop/nginxEditorDiagnostics.ts`
- `src/components/remote-desktop/nginxVisualEditor.ts`
- `src/styles/remote-desktop/_nginx-manager.scss`
- `src/assets/desktop-icons/nginx-manager.png`
- `src/RemoteDesktopShell.tsx`

## 远程命令边界

- 读取和检测仍复用 `window.guiSSH.connections.runCommand`。
- 配置路径必须通过 provider 校验，避免把任意路径拼进写入命令。
- 启用、禁用、删除和模板写入属于有副作用操作，必须保留确认弹窗、备份路径和失败回滚提示。
- Windows 主机不作为 Nginx 管理器主要目标，只展示不支持或检测失败状态。

## 与 Caddy / Apache 的拆分

旧设计将 Nginx、Apache/httpd、Caddy 放在一个 Web 服务管理器中。当前实现改为三个独立应用：

- `nginx-manager`：Nginx 站点、模板、可视化编辑、测试和 reload。
- `caddy-manager`：Caddyfile 站点块、模板、测试和 reload。
- `apache-manager`：Apache/httpd 虚拟主机、模板、启用/禁用、测试和 reload。

这种拆分让每个 Web 服务器的配置语法、目录布局、测试命令和安全确认逻辑保持独立，避免一个组件内部充满分支判断。

## 后续增强

- 完善 include 链路和跨文件 server block 定位。
- 提供更细的 diff 预览和撤销入口。
- 和证书管理器联动展示证书有效期与续期状态。
- 和防火墙、端口监听、日志查看器建立一键跳转。
