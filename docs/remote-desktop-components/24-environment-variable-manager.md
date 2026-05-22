# 环境变量管理器功能设计与开发计划

## 定位

环境变量管理器用于查看和编辑远程项目或服务相关的环境配置，包括 `.env` 文件、shell profile、systemd service environment 和 Windows 用户/系统环境变量。

## 目标用户场景

- 编辑项目 `.env` 文件。
- 查看 systemd 服务使用的环境文件。
- 对比修改前后环境变量差异。
- 遮蔽敏感值，避免屏幕泄露。
- 保存前检查格式错误。

## 首版功能范围

- `.env` 文件编辑：
  - key/value 表格。
  - 原文视图。
  - 注释保留。
- 敏感字段识别：
  - 包含 `PASSWORD`、`SECRET`、`TOKEN`、`KEY` 的字段默认遮蔽。
- 差异预览：
  - 保存前展示新增、修改、删除。
- 文件来源：
  - 手动输入路径。
  - 从文件管理器传入。
- Windows 环境变量作为第二阶段。

## 交互设计

顶部为文件路径和加载/保存按钮。主体双视图：

- 表格视图：变量名、值、是否敏感、备注。
- 原文视图：保留原始格式编辑。

保存必须弹出差异确认。敏感值默认以密码框显示，提供单项显示按钮。

## 数据模型

```ts
interface EnvVariableEntry {
  key: string;
  value: string;
  comment?: string;
  sensitive: boolean;
  enabled: boolean;
  raw?: string;
}

interface EnvFileSnapshot {
  path: string;
  entries: EnvVariableEntry[];
  rawContent: string;
}
```

## 文件解析设计

首版支持常见 `.env`：

- `KEY=value`
- `KEY="value"`
- `KEY='value'`
- 注释行和空行保留。
- 不支持复杂 shell 表达式，遇到复杂行保留在原文视图。

systemd environment file 类似 `.env`，但 service 文件中的 `Environment=` 后续再解析。

## IPC 与代码落点

复用 `readFile`、`writeFile`、`statPath`。保存前可先读取远端最新内容，若和加载时不一致，提示远程文件已变化。

文件建议：

- `src/components/remote-desktop/RemoteEnvManager.tsx`
- `src/components/remote-desktop/envFileUtils.ts`
- `src/styles/remote-desktop/_env-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现路径加载和 `.env` 解析。
2. 实现表格编辑和原文视图切换。
3. 实现敏感字段遮蔽。
4. 实现保存前 diff。
5. 实现远程文件变化检测。
6. 增加文件管理器打开入口。
7. 补主题和错误状态。

## 验收标准

- 能加载并编辑普通 `.env` 文件。
- 注释和空行保存后尽量保留。
- 敏感字段默认遮蔽。
- 保存前能看到差异。
- 远程文件被外部修改时有冲突提示。

## 后续增强

- systemd service 环境解析。
- Windows 环境变量。
- `.env.example` 对比。
- 敏感字段本地加密保存策略。
