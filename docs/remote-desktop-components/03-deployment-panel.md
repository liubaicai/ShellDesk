# 代码部署面板功能设计与开发计划

## 定位

代码部署面板用于把服务器上的常见部署流程沉淀为可重复执行的图形化任务。它适合个人项目、小团队服务、测试环境和轻量生产维护。

## 目标用户场景

- 一键执行拉代码、安装依赖、构建、重启服务。
- 查看每次部署的执行输出和成功失败状态。
- 保存多个项目的部署配置。
- 部署前检查 Git 分支和工作区状态。
- 出错后复制日志或回滚到上一个命令。

## 首版功能范围

- 项目配置：
  - 名称、工作目录、部署步骤列表。
  - 每个步骤包含命令、说明、是否失败即停止。
- 执行：
  - 按顺序执行步骤。
  - 实时展示当前步骤、输出和退出码。
  - 支持停止后续步骤。
- 历史：
  - 当前会话内保留执行记录。
  - 后续可持久化。
- 快捷模板：
  - Node/Vite 项目。
  - Docker Compose 项目。
  - systemd 服务重启项目。

## 交互设计

采用项目列表 + 流水线详情：

- 左侧：项目配置列表。
- 右侧顶部：项目路径、当前状态、执行按钮。
- 中部：步骤列表，每步显示命令、状态、耗时。
- 底部：命令输出日志。

执行前显示确认弹窗，列出目标目录和将执行的命令。失败时高亮失败步骤，保留 stdout/stderr。

## 数据模型

```ts
interface DeploymentProject {
  id: string;
  name: string;
  workingDirectory: string;
  steps: DeploymentStep[];
}

interface DeploymentStep {
  id: string;
  label: string;
  command: string;
  stopOnFailure: boolean;
}

interface DeploymentRunStepResult {
  stepId: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  stdout: string;
  stderr: string;
  code?: number;
}
```

## 远程命令设计

每个步骤使用：

```bash
cd <workingDirectory> && <command>
```

首版命令来自用户配置，属于高权限操作，必须明确展示并确认。工作目录要转义。命令本身不做复杂解析，但配置保存时标记为用户自定义命令。

常见模板：

- Git 拉取：`git pull --ff-only`。
- Node 构建：`pnpm install --frozen-lockfile && pnpm build`。
- Docker Compose：`docker compose pull && docker compose up -d`。
- systemd 重启：`sudo systemctl restart <service>`。

## IPC 与代码落点

首版可以用 `runCommand` 顺序执行，但不能实时流式输出。更好的体验需要新增流式命令 IPC。

首版策略：

- 每步执行完再追加输出。
- UI 显示当前步骤 loading。
- 长远新增 `connection:start-command-stream`。

建议文件：

- `src/components/remote-desktop/RemoteDeploymentPanel.tsx`
- `src/styles/remote-desktop/_deployment-panel.scss`
- `src/components/remote-desktop/deploymentTemplates.ts`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现项目配置 UI 和模板创建。
2. 实现步骤顺序执行。
3. 实现执行结果和日志展示。
4. 实现失败即停止。
5. 增加 Git 状态检查入口。
6. 增加配置持久化方案评估，可先用 vault settings 扩展。
7. 补主题和危险操作确认。

## 验收标准

- 能创建一个部署项目并执行多步命令。
- 步骤失败后按配置停止后续步骤。
- 输出日志能查看和复制。
- 工作目录不存在时有明确错误。
- 不会绕过确认直接执行新建部署任务。

## 后续增强

- 实时输出。
- 回滚步骤。
- 部署环境变量。
- 部署历史持久化。
- 与 Git 管理器和服务管理器联动。
