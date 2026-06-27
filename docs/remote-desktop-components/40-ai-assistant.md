# AI 助手组件说明

> 当前状态：已接入远程桌面（appKey: `ai-chat`），实现入口为 `src/components/remote-desktop/RemoteAiChat.tsx`。

## 定位

AI 助手用于在当前远程连接上下文中进行服务器管理、代码分析和排障对话。它复用应用设置里的 AI provider、模型和 API key，并通过共享工具访问远程命令、文件、组件打开等能力。

## 当前实现范围

- 使用 `ShellDeskAppSettings` 中的 AI 配置，未配置时提示进入设置。
- 基于 `usePiAgent` 维护消息、取消请求、清空历史和工具调用状态。
- 使用 `createSharedTools(connectionId, { systemType, onOpenApp })` 提供当前连接工具。
- 支持 Markdown、代码块、表格、列表和 inline code 渲染。
- 可从 AI 助手打开设置和远程桌面应用。
- Code Editor 内也复用同一套 Markdown 渲染与共享工具，并注入项目根目录上下文。

## 代码落点

- `src/components/remote-desktop/RemoteAiChat.tsx`
- `src/ai/`
- `src/styles/remote-desktop/_ai-chat.scss`
- `src/assets/desktop-icons/ai-chat.png`
- `src/RemoteDesktopShell.tsx`

## 安全边界

- AI API key 只来自本地设置，不应出现在日志、提交信息或文档示例中。
- 工具调用必须保留用户意图和连接上下文边界，不在无关主机上执行操作。
- 高风险操作应通过具体组件或终端确认路径落地，避免在对话里静默执行。

## 后续增强

- 会话持久化和按主机分组的历史。
- 更明确的工具调用确认 UI。
- 与安全巡检、日志查看器、代码编辑器的结构化结果互通。
