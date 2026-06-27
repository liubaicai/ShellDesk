# FRP 客户端组件说明

> 当前状态：已接入远程桌面（appKey: `frp-manager`），实现入口为 `src/components/remote-desktop/RemoteFrpManager.tsx`。

## 定位

FRP 客户端用于在远程主机上管理 `frpc` 隧道配置、运行状态、日志和自启动。它面向内网穿透、远程开发端口暴露和临时服务联调场景。

## 当前实现范围

- 自动检测 `frpc` 是否安装、版本、配置路径和 systemd/process 运行模式。
- 支持 Linux、macOS、Windows 的默认配置路径。
- 可安装 `frpc`，读取、生成并写入 `frpc.toml`。
- 支持 server 地址、端口、token，以及 tcp/udp/http/https/stcp/xtcp proxy 配置。
- 支持新增、编辑、删除 proxy，并生成 TOML 预览。
- 支持启动、停止、重启、保存后重启和启用自启动。
- 支持读取日志和通过 admin API 读取 proxy 运行状态。
- 使用远程组件连接配置保存配置路径、服务模式、admin 地址和端口。

## 代码落点

- `src/components/remote-desktop/RemoteFrpManager.tsx`
- `src/components/remote-desktop/frpCommands.ts`
- `src/components/remote-desktop/frpParsers.ts`
- `src/components/remote-desktop/frpTypes.ts`
- `src/styles/remote-desktop/_frp-manager.scss`
- `src/assets/desktop-icons/frp-manager.png`
- `src/RemoteDesktopShell.tsx`

## 设计边界

- `frpc` 下载和安装依赖目标系统网络与权限。
- 自启动在 Linux 优先 systemd，非 systemd 或 Windows 按平台能力降级。
- token、admin 密码等敏感字段不得写入日志或回复。

## 后续增强

- 与端口监听和浏览器组件联动验证代理可达性。
- 增加配置 diff 和历史版本。
- 支持更多 frp 高级字段和插件配置。
