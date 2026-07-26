# RDP 远程桌面查看器

> 当前状态：已接入远程桌面（appKey: `rdp-viewer`），实现入口为 `src/components/remote-desktop/RemoteRdpViewer.tsx`。

## 定位

RDP Viewer 在当前 ShellDesk SSH 会话内打开到 Windows RDP 服务的 `direct-tcpip` 通道，并使用 IronRDP WebAssembly 在应用窗口内渲染远程桌面。它不启动系统 `mstsc`、FreeRDP 或外部网关，也不把目标 RDP 端口暴露到局域网。

## 当前实现范围

- 探测目标 RDP 端口并解析 X.224 安全协议协商结果。
- 对 SSH 主机复用 `ssh_tunnel.rs` 的 russh `direct-tcpip`；本地连接则直接访问目标。
- 后端仅在 `127.0.0.1` 随机端口启动 WebSocket，并以每会话随机令牌验证 RDCleanPath 请求。
- 后端代浏览器完成目标 RDP TLS 握手，把证书链交给 IronRDP 完成 CredSSP 通道绑定。
- IronRDP WebAssembly 在 Canvas 中处理图像、键盘和鼠标输入。
- 支持适应、原始尺寸、铺满、全屏与 Ctrl+Alt+Del。
- 通过 Display Control 动态通道按窗口变化调整会话分辨率。
- 支持自动剪贴板同步，以及显式发送本机内容和保存远端内容。
- 按主机保存目标、用户名、域、分辨率、色深、缩放和剪贴板偏好；RDP 密码只保留在当前 React 状态，连接建立后清空，永不写入 vault。

## 代码落点

- `src/components/remote-desktop/RemoteRdpViewer.tsx`
- `src/styles/remote-desktop/_rdp-viewer.scss`
- `src/assets/desktop-icons/rdp-viewer.png`
- `src-tauri/src/rdp.rs`
- `src-tauri/src/ssh_tunnel.rs`
- `src/RemoteDesktopShell.tsx`
- `src/tauriBridge.ts`
- `src/vite-env.d.ts`

## 协议与安全

- 浏览器无法直接建立任意 TCP/TLS RDP 连接，因此本地后端实现了 IronRDP 所需的最小 RDCleanPath 代理。
- 代理只接受本机回环连接，并同时校验随机授权令牌和预期目标，令牌不会写入配置或日志。
- RDP 服务器常使用自签名证书；代理允许该证书完成 TLS，但仍验证握手签名，并将实际证书链交给 IronRDP 进行 CredSSP 公钥绑定。
- 关闭组件、RDP 会话或底层 SSH 连接时会取消监听与活动转发，并关闭对应 SSH 隧道。
- 不新增系统 OpenSSH、`ssh -L`、Node 服务、Guacamole、Devolutions Gateway 或系统 RDP 客户端 fallback。

## 设计边界

- 当前官方 IronRDP Web 后端固定以 16 位色深协商，因此配置面板显示并保存该实际值；待上游暴露色深构建参数后再扩展选项。
- 仅支持能够协商 TLS/CredSSP 的现代 RDP 服务；只提供传统 RDP Security 的目标会被明确拒绝。
- 剪贴板自动同步仍受桌面 WebView 的剪贴板权限限制，权限受限时可使用显式发送/保存按钮。
- 文件、磁盘、串口、打印机和音频重定向不在首版范围内。

## 验证重点

- 探测成功、错误端口、SSH 中断和错误凭据均需显示清晰状态。
- 连接后验证画面、鼠标、键盘、Ctrl+Alt+Del、三种缩放、窗口自适应和全屏。
- 分别验证自动剪贴板和手动发送/保存路径。
- 关闭窗口后确认回环监听、RDP WebSocket 和 SSH direct-tcpip 均已结束。
