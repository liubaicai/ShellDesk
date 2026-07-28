# FRP 服务端组件说明

<!-- current-implementation:start -->
## 当前实现状态

- 接入状态：已接入远程桌面目录，appKey 为 `frps-manager`；注册、窗口、图标、翻译和渲染分支由合同检查覆盖。
- 能力声明：平台 `linux / windows / macos`；模式 `management`；权限 `sudo-optional`。
- 依赖探测：Linux `frps`；Windows `frps`；macOS `frps`。存在依赖时由 Launchpad 连接级探测并显示缺失原因。
- 验证边界：启动合同为 `automated-contract`；完整业务流程仍为 `environment-required`，没有真实主机证据时不得写成已验证通过。
- 最后同步：2026-07-28；详见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
<!-- current-implementation:end -->

> 当前状态：已接入远程桌面（appKey: `frps-manager`），实现入口为 `src/components/remote-desktop/RemoteFrpsManager.tsx`。

## 定位

FRP 服务端用于在远程主机上管理 `frps` 服务端配置、运行状态、代理列表、Dashboard 信息和日志。它和 FRP 客户端配合，覆盖一端部署服务端、一端配置客户端的完整内网穿透工作流。

## 当前实现范围

- 自动检测 `frps` 是否安装、版本、配置路径和运行模式。
- 可安装 `frps`，读取、生成并写入 `frps.toml`。
- 配置 bind 地址、bind port、token、HTTP/HTTPS vhost 端口、subdomain host、Dashboard、日志和连接池参数。
- 支持启动、停止、重启、保存后重启和启用自启动。
- 支持读取 systemd/process 日志。
- 支持通过 Dashboard API 读取当前代理列表和流量信息。
- 提供 frpc 连接示例，方便复制到客户端配置。
- 使用远程组件连接配置保存配置路径和服务模式。

## 代码落点

- `src/components/remote-desktop/RemoteFrpsManager.tsx`
- `src/components/remote-desktop/frpsCommands.ts`
- `src/components/remote-desktop/frpsParsers.ts`
- `src/components/remote-desktop/frpsTypes.ts`
- `src/styles/remote-desktop/_frps-manager.scss`
- `src/styles/remote-desktop/_frp-manager-shared.scss`
- `src/assets/desktop-icons/frps-manager.png`
- `src/RemoteDesktopShell.tsx`

## 设计边界

- Dashboard 默认账号密码只作为配置默认值，真实环境必须由用户修改。
- 服务端端口开放仍需要防火墙、安全组和云平台策略配合。
- 不把 token 或 Dashboard 密码写入公开日志、提交信息或回复。
- 专属 SCSS 随 `RemoteFrpsManager` lazy chunk 加载，不再由 `deferred.scss` 重复引入；与客户端共用参数化 mixin，同时保留服务端 config 滚动、`select` 控件和 `:has(button)` action cell 差异。

## 后续增强

- 与防火墙管理器联动检查 bind/vhost 端口。
- Dashboard 指标趋势和异常 proxy 标记。
- 多服务端配置切换。
