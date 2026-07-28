# Supervisor 管理器

<!-- current-implementation:start -->
## 当前实现状态

- 接入状态：已接入远程桌面目录，appKey 为 `supervisor-manager`；注册、窗口、图标、翻译和渲染分支由合同检查覆盖。
- 能力声明：平台 `linux / macos`；模式 `management`；权限 `sudo-optional`。
- 依赖探测：Linux `supervisorctl`；Windows `supervisorctl`；macOS `supervisorctl`。存在依赖时由 Launchpad 连接级探测并显示缺失原因。
- 验证边界：启动合同为 `automated-contract`；完整业务流程仍为 `environment-required`，没有真实主机证据时不得写成已验证通过。
- 最后同步：2026-07-28；详见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
<!-- current-implementation:end -->

> 当前状态：已接入远程桌面（appKey: `supervisor-manager`），实现入口为 `src/components/remote-desktop/RemoteSupervisorManager.tsx`。

## 定位

Supervisor 管理器用于查看和控制远程 Unix 主机上由 `supervisord` 托管的应用进程，覆盖 Gunicorn、Celery、后台脚本和容器内多进程等常见场景。它面向 Supervisor 自身的进程组、状态和 stdout / stderr，不替代 systemd / Windows Services 服务管理器，也不替代操作系统级进程管理器。

## 当前实现范围

- 自动检测 `supervisorctl`、Supervisor 版本、运行状态和可执行文件路径。
- 解析 `supervisorctl status`，展示进程组、状态、PID、运行时间和原始状态说明。
- 支持名称搜索、运行状态筛选、单项及多项选择。
- 支持 start、stop、restart 和 supervisord 配置 reload。
- stop、restart、reload 统一使用渲染到 `document.body` 的确认弹窗。
- 查看选中进程的 stdout / stderr tail 输出。
- 扫描 Debian / Ubuntu、RHEL 系、Homebrew 等常见配置路径，提供只读配置预览。
- 远程命令权限不足时复用 ShellDesk 的 sudo 凭据提示与连接级缓存。
- Windows 主机只显示明确的降级说明，不执行 Unix 命令。
- 响应式布局以 Supervisor 组件窗口自身宽度为准，缩放浮动窗口时会重排标题、操作区和运行概览。

## 代码落点

- `src/components/remote-desktop/RemoteSupervisorManager.tsx`
- `src/components/remote-desktop/supervisorCommands.ts`
- `src/components/remote-desktop/supervisorParsers.ts`
- `src/components/remote-desktop/supervisorTypes.ts`
- `src/styles/remote-desktop/_supervisor-manager.scss`
- `src/assets/desktop-icons/supervisor-manager.png`
- `src/RemoteDesktopShell.tsx`

## 命令与安全

- 所有远程能力通过现有 `window.guiSSH.connections.runCommand` / `useSudoCommand` 路径执行，不新增系统 SSH fallback。
- 进程名和配置路径在进入 shell 命令前统一使用 POSIX 单引号转义。
- 配置文件仅允许从远端检测结果中选择并预览，最多读取前 600 行，不提供在线写入。
- 批量命令最多接收 100 个当前状态列表中的进程名。
- 页面不使用浏览器原生 `confirm()` / `prompt()` / `alert()`。

## 设计边界

- 不安装或升级 Supervisor。
- 不编辑 Supervisor 配置，也不替代配置发布流程。
- 不管理 supervisord 自身的 systemd 生命周期。
- 日志采用 `supervisorctl tail` 快照，不保持长连接 follow。
- Windows 不支持 supervisord；macOS 使用与 Linux 相同的 Unix CLI 路径并包含 Homebrew 配置目录。

## 后续增强

- 在后端具备可靠的可取消流式命令后，增加实时日志 follow。
- 增加配置 include 关系图和配置语法校验。
- 为异构 Supervisor 版本补充基于真实输出样本的解析回归集合。
