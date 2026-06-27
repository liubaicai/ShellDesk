# API 调试器功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `api-debugger`），实现入口为 `src/components/remote-desktop/RemoteApiDebugger.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

API 调试器用于从远程主机网络环境发起 HTTP 请求。它适合测试内网接口、本机服务、容器端口和仅服务器可访问的地址。

## 目标用户场景

- 从服务器访问 `http://127.0.0.1:8080/health`。
- 测试内网 API 是否可达。
- 查看响应状态码、耗时、响应头和响应体。
- 保存常用请求。
- 复制 curl 命令。

## 首版功能范围

- 请求配置：
  - 方法、URL、headers、body。
  - 超时时间。
- 响应展示：
  - 状态码、耗时、响应头。
  - body 文本。
  - JSON 格式化。
- 历史：
  - 当前会话最近请求。
- 复制：
  - 复制响应。
  - 复制 curl 命令。

## 交互设计

布局类似轻量 API 客户端：

- 顶部：方法选择、URL 输入、发送按钮。
- 中部：请求 tabs，Headers、Body。
- 下部：响应 tabs，Body、Headers、Raw。
- 左侧可选历史列表。

不做营销式界面，保持工具密度。Body 编辑区使用 textarea，后续可升级代码编辑器。

## 数据模型

```ts
interface ApiDebugRequest {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  url: string;
  headers: { key: string; value: string; enabled: boolean }[];
  body?: string;
  timeoutSeconds: number;
}

interface ApiDebugResponse {
  status?: number;
  durationMs: number;
  headersText: string;
  body: string;
  stderr?: string;
}
```

## 远程命令设计

使用远程 `curl`：

- 基础：`curl -i -sS -L --max-time <seconds> -X <method> <url>`。
- Header：`-H 'Key: Value'`。
- Body：`--data-binary @-` 或安全写入临时文件后 `--data-binary @file`。

为了避免复杂 body 转义，首版推荐：

- 对 GET/HEAD 直接命令执行。
- 对带 body 请求，使用 here-doc 或临时文件，必须严格处理分隔符。

Windows：

- 若有 curl，优先 curl。
- PowerShell `Invoke-WebRequest` 作为后续。

## IPC 与代码落点

首版复用 `runCommand`。如果 body 支持复杂内容，建议新增 Rust 后端 `connection:http-request-via-ssh`，由后端通过 SSH 执行更可控的命令或使用远程临时文件。

文件建议：

- `src/components/remote-desktop/RemoteApiDebugger.tsx`
- `src/components/remote-desktop/apiDebuggerUtils.ts`
- `src/styles/remote-desktop/_api-debugger.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现 GET 请求和响应解析。
2. 实现 headers 配置。
3. 实现 POST/PUT/PATCH body。
4. 实现 JSON 格式化和 raw 视图。
5. 实现历史记录和复制 curl。
6. 增加 curl 不存在提示。
7. 补 URL 校验和超时设置。

## 验收标准

- 能从远程主机请求 HTTP/HTTPS URL。
- 能显示状态码、耗时、headers、body。
- JSON 响应能格式化。
- 请求失败时显示 curl 错误。
- URL 和 header 参数安全处理。

## 后续增强

- 请求集合持久化。
- 环境变量。
- Cookie 管理。
- WebSocket 测试。
- 与浏览器组件互相打开 URL。
