# 会话录制/回放功能设计与开发计划

## 定位

会话录制/回放用于记录当前远程桌面中的关键操作，尤其是终端命令、输出摘要、文件操作和部署步骤。它服务于审计、复盘、交接和故障记录。

## 目标用户场景

- 记录一次排障过程。
- 保存终端命令和关键输出。
- 记录文件修改、上传、下载、删除。
- 导出操作摘要。
- 以后回放或查看当时做了什么。

## 首版功能范围

- 记录范围：
  - 终端输入命令。
  - 终端输出片段，限制长度。
  - 文件管理器操作事件。
  - 部署面板执行记录。
- 控制：
  - 开始、暂停、停止。
  - 添加手动备注。
- 导出：
  - Markdown 摘要。
  - JSON 原始事件。

首版不录制屏幕视频，只记录结构化事件。

## 交互设计

作为远程桌面组件或顶部全局录制控件：

- 小型控制条显示录制状态和事件数量。
- 主窗口展示时间线。
- 时间线事件可展开查看详情。
- 支持手动插入备注。

需要明确提示用户正在记录哪些内容，避免误解为完整屏幕录制。

## 数据模型

```ts
type SessionEventType = 'terminal-command' | 'terminal-output' | 'file-operation' | 'app-action' | 'note';

interface SessionRecordEvent {
  id: string;
  type: SessionEventType;
  timestamp: string;
  appKey?: string;
  title: string;
  payload: Record<string, unknown>;
}

interface SessionRecording {
  id: string;
  connectionId: string;
  startedAt: string;
  endedAt?: string;
  events: SessionRecordEvent[];
}
```

## IPC 与架构设计

首版可在渲染进程内记录事件，但要在各组件暴露事件：

- 终端组件上报输入命令和输出摘要。
- 文件管理器上报操作成功事件。
- 部署面板上报步骤结果。

如果要长期保存，需要新增 vault collection 或本地日志文件。考虑敏感性，默认只保存在当前会话，导出需用户主动触发。

## 代码落点

- `src/components/remote-desktop/RemoteSessionRecorder.tsx`
- `src/components/remote-desktop/sessionRecordingTypes.ts`
- `src/components/remote-desktop/sessionRecordingContext.tsx`
- `src/styles/remote-desktop/_session-recorder.scss`
- `src/RemoteDesktopShell.tsx`
- 需要对终端、文件管理器等组件增加可选事件回调。

## 开发计划

1. 设计 recording context 和事件类型。
2. 实现录制控制 UI 和时间线。
3. 接入终端命令事件。
4. 接入文件操作事件。
5. 实现备注和导出 Markdown。
6. 实现 JSON 导出。
7. 增加敏感内容提示和截断策略。

## 验收标准

- 能开始和停止录制。
- 终端命令能出现在时间线。
- 文件操作能出现在时间线。
- 能导出 Markdown 摘要。
- 输出内容有长度限制，避免内存无限增长。

## 后续增强

- 可选持久化。
- 回放模式。
- 敏感命令自动遮蔽。
- 与日志系统合并审计。
