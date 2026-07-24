# Docker / Podman 管理器功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `container-manager`），实现入口为 `src/components/remote-desktop/RemoteContainerManager.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

Docker / Podman 管理器用于管理远程主机上的容器运行时。它应覆盖容器、镜像、卷、网络、日志和 compose 项目的常用操作，让用户不离开 ShellDesk 就能完成容器排障与维护。

## 目标用户场景

- 查看当前运行和停止的容器。
- 启动、停止、重启、删除容器。
- 查看容器日志和资源占用。
- 进入容器执行命令。
- 查看镜像、删除旧镜像、拉取新镜像。
- 查看 compose 项目状态。

## 首版功能范围

- 自动检测 Docker 或 Podman。
- 容器列表：
  - 名称、镜像、状态、端口、创建时间、运行时长。
  - 搜索和按状态筛选。
- 容器详情：
  - inspect 摘要。
  - 端口映射、挂载、环境变量摘要。
  - 最近日志。
- 容器操作：
  - start、stop、restart、remove。
  - 查看日志。
  - exec 打开一个命令输入面板。
- 镜像列表：
  - 仓库、标签、ID、大小、创建时间。
  - pull、remove。

## 交互设计

窗口采用顶部 tabs：

- 容器
- 镜像
- 卷
- 网络
- Compose

首版重点实现“容器”和“镜像”两个 tab。容器 tab 左侧为列表，右侧为详情。详情里放操作按钮、日志区和 inspect 摘要。危险操作删除容器和删除镜像必须使用自定义确认弹窗。

## 数据模型

```ts
type ContainerRuntime = 'docker' | 'podman';

interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  command?: string;
  status: string;
  state: 'running' | 'exited' | 'paused' | 'created' | 'unknown';
  ports: string;
  createdAt?: string;
}

interface ImageSummary {
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdAt?: string;
}
```

## 远程命令设计

运行时检测：

- `command -v docker`
- `command -v podman`
- 优先 Docker，找不到则使用 Podman。
- Unix 命令统一扩展 `/usr/local/bin`、群晖 DSM 7 `ContainerManager` 和 DSM 6 `Docker` 套件目录，确保非交互 SSH 的精简 `PATH` 也能检测并执行运行时。
- Compose 自动区分 Docker Compose v2 插件和群晖常见的独立 `docker-compose` v1；v1 无全局 `ls` 时使用容器 Compose 标签发现项目，创建和项目操作自动切换到独立命令。

容器列表：

- `${runtime} ps -a --format '{{json .}}'`
- 每行 JSON，前端按行解析。

容器详情：

- `${runtime} inspect <container>`
- `${runtime} logs --tail 200 <container>`
- `${runtime} stats --no-stream --format '{{json .}}' <container>`

镜像列表：

- `${runtime} images --format '{{json .}}'`

操作：

- `${runtime} start|stop|restart <container>`
- `${runtime} rm <container>`
- `${runtime} rmi <image>`
- `${runtime} pull <image>`

所有 ID、镜像名和容器名都必须经过安全校验或 shell 转义。

## IPC 与代码落点

首版可通过 `runCommand` 完成。进入容器的完整交互式 exec 需要终端会话能力支持指定命令，目前 `startTerminal` 默认打开登录 shell。第一版可以提供非交互命令执行面板，后续再做“打开容器终端”。

建议后续 IPC：

- `connection:start-terminal-command`，支持启动指定远程命令并绑定 xterm。

首版文件建议：

- `src/components/remote-desktop/RemoteContainerManager.tsx`
- `src/styles/remote-desktop/_container-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 桌面入口和运行时检测。
2. 容器列表、搜索、状态筛选。
3. 容器详情、日志、stats 摘要。
4. 容器 start、stop、restart、rm。
5. 镜像列表、pull、remove。
6. Podman 兼容验证。
7. 加入错误状态，例如未安装 Docker、权限不足、daemon 未运行。

## 验收标准

- Docker 主机能列出容器和镜像。
- Podman 主机能正常展示基础信息。
- 群晖 DSM 非交互 SSH 环境能检测套件安装的 Docker，并执行容器、镜像、网络、卷和 Compose 命令。
- 群晖 Docker 20.10 + `docker-compose` 1.x 环境打开 Compose 页不报 `unknown flag: --format`，并能使用已有 Compose 文件执行项目操作。
- 启停容器后列表状态刷新。
- 权限不足时给出清晰错误，不吞掉 stderr。
- 删除操作有二次确认。
- `pnpm build` 通过。

## 后续增强

- 容器终端。
- Compose 项目管理。
- 容器文件浏览。
- 容器资源曲线。
- 镜像构建和 Dockerfile 查看。
