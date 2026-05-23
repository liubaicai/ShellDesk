# 远程剪贴板 / 临时便签功能设计与开发计划

## 定位

远程剪贴板 / 临时便签用于保存当前连接相关的路径、命令、账号提示、排查记录和待办。它是轻量辅助工具，帮助用户在多窗口之间保持上下文。

## 目标用户场景

- 暂存一个远程路径。
- 保存一段待执行命令。
- 记录当前排查思路。
- 在终端、文件管理器、浏览器之间复制信息。
- 下次连接同一主机时看到常用笔记。

## 首版功能范围

- 便签：
  - 新增、编辑、删除。
  - Markdown 纯文本。
  - 当前连接作用域。
- 剪贴板：
  - 本地剪贴板读取/写入按钮。
  - 复制便签内容。
- 快捷插入：
  - 当前主机信息。
  - 当前时间。
  - 常用路径。

## 交互设计

界面像轻量笔记面板：

- 左侧便签列表。
- 右侧编辑器。
- 顶部搜索、新建、复制。

不要做复杂富文本。敏感信息需要提示用户谨慎保存。

## 数据模型

```ts
interface RemoteNote {
  id: string;
  scope: 'connection' | 'global';
  connectionKey?: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
```

## IPC 与持久化设计

剪贴板：

- Electron renderer 可以使用 `navigator.clipboard`，受权限和上下文影响。
- 更稳妥可在 preload 暴露安全 clipboard API，后续新增。

持久化：

- 建议扩展 vault，新增 notes collection。
- 作用域 key 可使用 `username@address:port`。

首版可先做当前会话内存便签，后续持久化。

## 代码落点

- `src/components/remote-desktop/RemoteNotesClipboard.tsx`
- `src/styles/remote-desktop/_notes-clipboard.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`
- 后续持久化涉及 `electron/main.cjs`、`preload.cjs`、`vite-env.d.ts`。

## 开发计划

1. 实现便签列表和编辑器。
2. 实现当前会话新建/编辑/删除。
3. 实现复制内容和从剪贴板粘贴。
4. 实现搜索。
5. 设计连接作用域持久化。
6. 接入 vault 保存。
7. 增加敏感信息提示。

## 验收标准

- 能创建和编辑便签。
- 能复制便签内容。
- 当前窗口切换便签不丢失内容。
- 搜索能过滤标题和内容。
- 持久化版本能按连接恢复便签。

## 后续增强

- Markdown 预览。
- 从终端选中文本创建便签。
- 便签模板。
- 全局命令草稿区。
