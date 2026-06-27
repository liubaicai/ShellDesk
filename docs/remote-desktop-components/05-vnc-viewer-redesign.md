# VNC Viewer 组件重设计文档

> 当前状态：已接入远程桌面（appKey: `vnc`），实现入口为 `src/components/remote-desktop/RemoteVncViewer.tsx`。本文保留重设计背景，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

VNC Viewer 用于通过 SSH 可达网络连接远程图形桌面。它应提供稳定的屏幕查看和输入控制，同时把连接诊断、性能模式和安全边界讲清楚。

## 重新设计目标

- 让 VNC 目标、SSH 转发状态、认证失败原因可见。
- 让高延迟和弱带宽环境有可调性能模式。
- 让缩放、全屏、键盘组合键、剪贴板体验顺手。
- 避免把 VNC 当成普通静态画布处理。

## 功能架构

### 连接

- host、port、认证信息、连接模式。
- 探测目标可达性和 VNC 安全类型。
- 显示握手、SSH 流、WebSocket 代理、RFB 连接诊断阶段。

### 查看与输入

- 适配窗口缩放、实际像素、fit 模式。
- 全屏/沉浸模式。
- 发送 Ctrl+Alt+Del 等组合键。
- 鼠标、键盘、剪贴板能力按 noVNC 和安全策略提供。

### 性能

- 质量、压缩、缩放、只读模式。
- 延迟状态和重连按钮。
- 连接中断后保留诊断输出。

## 交互设计

- 顶部工具栏是连接与控制区，连接成功后收紧。
- 主区域为屏幕舞台，不被装饰卡片包裹。
- 右侧或折叠面板显示诊断和性能设置。
- 错误态覆盖层要区分认证失败、目标不可达、代理失败。

## 数据与状态

```ts
interface VncViewerSessionState {
  id: string;
  targetHost: string;
  targetPort: number;
  status: 'idle' | 'probing' | 'connecting' | 'connected' | 'disconnected' | 'error';
  diagnostics: VncDiagnosticEntry[];
  viewMode: 'fit' | 'native' | 'scale';
}
```

## 能力与集成设计

- VNC 代理和 SSH forward 必须留在 Rust 后端。
- 渲染层负责 noVNC 客户端和 UI。
- 与端口诊断可共享目标探测思路。
- 凭证不应在日志和录制里明文出现。

## 开发计划

1. 统一连接状态和诊断时间线。
2. 重整工具栏，区分连接前后。
3. 完成缩放、全屏、只读、性能模式。
4. 增强错误态和重连。
5. 增加组合键和剪贴板策略验证。
6. 检查代理生命周期清理。
7. 用桌面/mobile 窗口尺寸验证屏幕舞台布局。

## 验收标准

- 能通过 SSH 可达目标建立 VNC 会话。
- 连接失败能看到明确阶段和原因。
- 屏幕在不同窗口尺寸下不空白、不失焦。
- 停止连接后代理资源释放。
- 凭证不会进入可见诊断文本。

## 设计取舍

- 不把 VNC Viewer 做成远程桌面协议聚合器。
- 首版优先 VNC 稳定性，RDP 等协议另行设计。
- 高级文件传输不在 VNC 组件内处理。
