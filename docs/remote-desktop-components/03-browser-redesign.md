# 浏览器组件重设计文档

> 当前状态：已接入远程桌面（appKey: `browser`），实现入口为 `src/components/remote-desktop/RemoteBrowser.tsx`。本文保留重设计背景，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

浏览器用于从远程连接对应的网络视角访问 Web 页面，尤其是远程 localhost、内网管理后台和服务验证页面。它不是通用 Chrome 替代品，而是 ShellDesk 的远程 Web 检查窗口。

## 重新设计目标

- 清楚表达“从哪种网络路径访问”的上下文。
- 让 localhost、内网地址、常用管理后台访问顺手。
- 保留书签、历史、错误诊断和页面状态。
- 在安全边界内处理 webview 导航、权限和外链。

## 功能架构

### 导航

- 地址栏、后退、前进、刷新、停止。
- 新标签或多窗口策略，首版可保留多窗口单页模式。
- 常用地址、连接级书签、最近访问。
- 自动规范化裸域名和 localhost 地址。

### 远程上下文

- 显示当前代理/连接上下文。
- 快捷入口：`127.0.0.1`、远程主机地址、常见服务端口。
- 页面加载失败时提示 DNS、连接拒绝、TLS、代理等可能方向。

### 安全与可用性

- 限制导航协议。
- 默认拒绝 webview 权限请求。
- 外链打开策略清晰。
- 对下载、弹窗、证书错误有明确状态。

## 交互设计

- 浏览器窗口标题区突出页面标题和连接上下文。
- 工具栏保持浏览器熟悉结构：导航按钮、地址栏、书签按钮。
- 收藏栏可折叠，不占过多工作区。
- 错误页由 ShellDesk 呈现诊断摘要，而不只显示空白 webview。

## 数据与状态

```ts
interface RemoteBrowserTabState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

interface RemoteBrowserBookmark {
  id: string;
  label: string;
  url: string;
  scope: string;
}
```

## 能力与集成设计

- 远程网络访问由连接对应的 Tauri/Rust browser proxy 承载。
- 书签持久化按连接 scope 保存。
- 网络诊断和 API 调试器可从当前 URL 建立跳转。
- 浏览器不直接暴露任意本地 Tauri 后端能力给页面。

## 开发计划

1. 明确网络上下文和标题状态模型。
2. 完成导航错误态和 ShellDesk 错误页。
3. 完成书签、最近访问和快捷地址入口。
4. 增加多标签是否需要的交互验证。
5. 接入网络诊断/API 调试器 URL 跳转。
6. 完整复核 webview 安全策略和权限拒绝。
7. 补 localhost、内网、TLS 错误场景测试。

## 验收标准

- 能访问远程 localhost 和经代理可达的内网页面。
- 页面加载状态、标题和错误状态准确。
- 书签按连接 scope 生效。
- 非 http/https 导航被安全处理。
- webview 页面不能越权获得主应用能力。

## 设计取舍

- 不以取代系统浏览器为目标。
- 首版不做开发者工具工作台。
- 更重视远程网络上下文和诊断联动。
