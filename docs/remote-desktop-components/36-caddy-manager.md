# Caddy 管理器组件说明

> 当前状态：已接入远程桌面（appKey: `caddy-manager`），实现入口为 `src/components/remote-desktop/RemoteCaddyManager.tsx`。

## 定位

Caddy 管理器用于查看和维护远程主机的 Caddyfile 站点配置，覆盖站点块摘要、模板创建、配置测试和 reload。它从旧的混合 Web 服务管理器中拆分出来，专注 Caddy 的配置语法和自动 TLS 工作流。

## 当前实现范围

- 检测 Caddy 安装、版本、主配置路径和服务状态。
- 读取检测到的主 Caddyfile，并解析站点块、matcher、listen、root、reverse proxy、tls 和日志等常见指令。
- 支持站点搜索和 TLS/非 TLS 过滤。
- 提供站点概览、源码编辑和模板创建。
- 内置静态站点、反向代理、API、WordPress、TLS、容器等常见模板。
- 支持删除站点块、从模板创建站点、保存配置、`caddy validate` 和 reload。
- 写入前保留原配置备份，失败时展示原始输出。

## 代码落点

- `src/components/remote-desktop/RemoteCaddyManager.tsx`
- `src/components/remote-desktop/caddyManagerProviders.ts`
- `src/components/remote-desktop/caddyManagerTemplates.ts`
- `src/components/remote-desktop/caddyManagerTypes.ts`
- `src/components/remote-desktop/caddyParser.ts`
- `src/styles/remote-desktop/_caddy-manager.scss`
- `src/assets/desktop-icons/caddy-manager.png`
- `src/RemoteDesktopShell.tsx`

## 已知边界

- 当前只读取检测到的主 Caddyfile，`import` 引入的文件还没有展开成完整配置树。
- Caddyfile 没有 Nginx 那样的 enabled/disabled 目录语义，解析到的站点块默认视为启用。
- 写操作依赖可用的 sudo/root 权限和目标主机上的 Caddy 命令。

## 后续增强

- 展开 `import` 文件并支持跨文件站点块定位。
- 与证书管理器联动展示自动证书状态。
- 提供站点块 diff 和撤销入口。
