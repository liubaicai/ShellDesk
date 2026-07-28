# Caddy 管理器组件说明

<!-- current-implementation:start -->
## 当前实现状态

- 接入状态：已接入远程桌面目录，appKey 为 `caddy-manager`；注册、窗口、图标、翻译和渲染分支由合同检查覆盖。
- 能力声明：平台 `linux / windows / macos`；模式 `management`；权限 `sudo-required`。
- 依赖探测：Linux `caddy`；Windows `caddy`；macOS `caddy`。存在依赖时由 Launchpad 连接级探测并显示缺失原因。
- 验证边界：启动合同为 `automated-contract`；完整业务流程仍为 `environment-required`，没有真实主机证据时不得写成已验证通过。
- 最后同步：2026-07-28；详见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
<!-- current-implementation:end -->

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
